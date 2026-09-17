import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { BRAINS_DIR, sanitizeBrainName } from './paths.js'
import { readManifest, readManifestFromFile, validateForImport, type BrainManifest } from './snapshot.js'
import { notSupersededClause } from '../contradictions/supersession.js'
import { logAudit } from './audit.js'
import * as sqliteVec from 'sqlite-vec'
import { hybridSearch } from '../memory/search/hybrid.js'

export interface BrainSummary {
  name: string
  memory_count: number
  owner_name: string | null
  owner_pubkey: string | null
  embedding_model: string | null
  description: string | null
  has_decrypted_cache: boolean
  exported_at: number | null
}

export function listLocalBrains(brainsDir: string = BRAINS_DIR): BrainSummary[] {
  if (!existsSync(brainsDir)) return []
  const names = readdirSync(brainsDir).filter((n) => {
    try {
      return statSync(join(brainsDir, n)).isDirectory()
    } catch {
      return false
    }
  })
  const out: BrainSummary[] = []
  for (const name of names) {
    const dir = join(brainsDir, name)
    const cachedDb = join(dir, '.cache', 'brain.db')
    const ownedDb = join(dir, 'brain.db')
    const dbForManifest = existsSync(cachedDb) ? cachedDb : existsSync(ownedDb) ? ownedDb : null
    if (!dbForManifest) {
      // Published brains delete brain.db and ship manifest.json beside the
      // encrypted snapshot; fall back to the JSON sidecar so owned+published
      // brains don't report memory_count: 0 and drop their manifest.
      out.push(summaryFromManifestSidecar(name, dir))
      continue
    }
    try {
      const manifest = readManifestFromFile(dbForManifest)
      out.push({
        name,
        memory_count: manifest.memory_count,
        owner_name: manifest.owner_name,
        owner_pubkey: manifest.owner_pubkey,
        embedding_model: manifest.embedding_model,
        description: manifest.description,
        has_decrypted_cache: existsSync(cachedDb),
        exported_at: manifest.exported_at,
      })
    } catch {
      out.push({
        name,
        memory_count: 0,
        owner_name: null,
        owner_pubkey: null,
        embedding_model: null,
        description: null,
        has_decrypted_cache: existsSync(cachedDb),
        exported_at: null,
      })
    }
  }
  return out
}

function summaryFromManifestSidecar(name: string, dir: string): BrainSummary {
  const manifestPath = join(dir, 'manifest.json')
  const empty: BrainSummary = {
    name,
    memory_count: 0,
    owner_name: null,
    owner_pubkey: null,
    embedding_model: null,
    description: null,
    has_decrypted_cache: false,
    exported_at: null,
  }
  if (!existsSync(manifestPath)) return empty
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<BrainManifest>
    return {
      name,
      memory_count: typeof manifest.memory_count === 'number' ? manifest.memory_count : 0,
      owner_name: manifest.owner_name ?? null,
      owner_pubkey: manifest.owner_pubkey ?? null,
      embedding_model: manifest.embedding_model ?? null,
      description: manifest.description ?? null,
      has_decrypted_cache: false,
      exported_at: typeof manifest.exported_at === 'number' ? manifest.exported_at : null,
    }
  } catch {
    return empty
  }
}

/**
 * Query terms are lowercased word runs. Everything else (quotes, parens, NEAR,
 * '*', column filters) is discarded by construction, so untrusted input can
 * never be interpreted as FTS5 syntax. FTS5's default unicode61 tokenizer
 * splits on the same boundaries.
 */
const QUERY_TOKEN_LIMIT = 12

const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'not', 'of',
  'on', 'or', 'our', 'should', 'so', 'than', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
])

export function tokenizeBrainQuery(query: string): string[] {
  const matches = query.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? []
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const token of matches) {
    if (token.length < 2 || STOPWORDS.has(token) || seen.has(token)) continue
    seen.add(token)
    tokens.push(token)
    if (tokens.length >= QUERY_TOKEN_LIMIT) break
  }
  return tokens
}

// FTS5 treats bare AND/OR/NOT as operators, so the expression is built from
// quoted phrases only; the tokenizer above guarantees no quote can appear.
function matchExpression(tokens: string[], operator: 'AND' | 'OR'): string {
  return tokens.map((token) => `"${token}"`).join(` ${operator} `)
}

// Bounded relevance boosts, applied on top of bm25 rank (lower = better).
// Kept small so a weak match can never outrank a strong one on metadata alone.
const IMPORTANCE_BOOST = 0.35
const PROMINENT_TYPE_BOOST = 0.25
const PINNED_BOOST = 0.25
const PROMINENT_TYPES = ['decision', 'pattern', 'gotcha', 'procedure']

/**
 * Both brain read paths go through here: a snapshot whose manifest is missing
 * or incompatible (newer schema, different embedding model) must fail loudly
 * rather than silently return misleading results from a cache the follower
 * cannot actually interpret.
 */
function assertBrainReadable(db: Database.Database, safe: string): void {
  let manifest: BrainManifest
  try {
    manifest = readManifest(db)
  } catch {
    throw new Error(`Brain "${safe}" has no readable manifest. Run \`engram brain refresh ${safe}\`.`)
  }
  const invalid = validateForImport(manifest)
  if (invalid) {
    throw new Error(
      `Brain "${safe}" cannot be read: ${invalid.message} Run \`engram brain refresh ${safe}\`, or update engram if it was published by a newer version.`
    )
  }
}

async function tryHybridSearch(
  db: Database.Database,
  query: string,
  limit: number
): Promise<BrainSearchResult[] | null> {
  let vectorRows = 0
  try {
    sqliteVec.load(db)
    vectorRows = (db.prepare('SELECT COUNT(*) AS c FROM memory_vectors').get() as { c: number }).c
  } catch {
    return null // sqlite-vec unavailable: lexical path
  }
  if (vectorRows === 0) return null

  try {
    const results = await hybridSearch(db, true, query, {
      limit,
      touch: false, // read-only connection: never stamp access metadata
      include_superseded: false,
    })
    if (results.length === 0) return []
    // Defensive supersession filter: a retracted fact must never be served.
    const ids = results.map((r) => r.id)
    const placeholders = ids.map(() => '?').join(',')
    const live = new Set(
      (
        db
          .prepare(
            `SELECT m.id FROM memories m WHERE m.id IN (${placeholders}) AND ${notSupersededClause('m.id')}`
          )
          .all(...ids) as Array<{ id: string }>
      ).map((r) => r.id)
    )
    return results
      .filter((r) => live.has(r.id))
      .map((r) => ({
        id: r.id,
        content: r.content,
        type: r.type,
        importance: r.importance,
        tags: r.tags,
        created_at: r.created_at,
      }))
  } catch {
    return null // embeddings/model unavailable: lexical path
  }
}

export interface BrainSearchResult {
  id: string
  content: string
  type: string
  importance: number
  tags: string
  created_at: number
}

export async function searchBrain(
  brainName: string,
  query: string,
  limit: number = 10,
  brainsDir: string = BRAINS_DIR
): Promise<BrainSearchResult[]> {
  const safe = sanitizeBrainName(brainName)
  const cachedDb = join(brainsDir, safe, '.cache', 'brain.db')
  const ownedDb = join(brainsDir, safe, 'brain.db')
  const dbPath = existsSync(cachedDb) ? cachedDb : existsSync(ownedDb) ? ownedDb : null
  if (!dbPath) {
    throw new Error(`Brain "${safe}" has no decrypted database. Run \`engram brain refresh ${safe}\`.`)
  }
  const tokens = tokenizeBrainQuery(query)
  if (tokens.length === 0) return []

  const db = new Database(dbPath, { readonly: true })
  try {
    assertBrainReadable(db, safe)

    // Semantic pass: a snapshot carries embeddings, so fuse them with the
    // lexical hits. The brain DB is read-only (touch:false) and ANY failure —
    // no sqlite-vec, no vectors, no local embedding model — degrades to the
    // lexical path below rather than making a followed brain unsearchable.
    const hybrid = await tryHybridSearch(db, query, limit)
    if (hybrid) return hybrid

    const select = `SELECT m.id, m.content, m.type, m.importance, m.tags, m.created_at
       FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ?
         AND ${notSupersededClause('m.id')}
       ORDER BY
         bm25(memories_fts, 10.0, 5.0)
           - (${IMPORTANCE_BOOST} * COALESCE(m.importance, 0.5))
           - (CASE WHEN m.type IN (${PROMINENT_TYPES.map((t) => `'${t}'`).join(', ')}) THEN ${PROMINENT_TYPE_BOOST} ELSE 0 END)
           - (CASE WHEN m.pinned = 1 THEN ${PINNED_BOOST} ELSE 0 END) ASC,
         m.created_at DESC
       LIMIT ?`

    // AND first: when every term is present, the precise hits are what the user
    // wants. Only when that yields nothing do we fall back to OR, so multi-term
    // and natural-language questions still retrieve ranked partial matches.
    const rows = db.prepare(select).all(matchExpression(tokens, 'AND'), limit) as BrainSearchResult[]
    if (rows.length > 0 || tokens.length === 1) return rows
    return db.prepare(select).all(matchExpression(tokens, 'OR'), limit) as BrainSearchResult[]
  } finally {
    db.close()
  }
}

export function getBrainMemory(
  brainName: string,
  memoryId: string,
  brainsDir: string = BRAINS_DIR
): BrainSearchResult | null {
  const safe = sanitizeBrainName(brainName)
  const cachedDb = join(brainsDir, safe, '.cache', 'brain.db')
  const ownedDb = join(brainsDir, safe, 'brain.db')
  const dbPath = existsSync(cachedDb) ? cachedDb : existsSync(ownedDb) ? ownedDb : null
  if (!dbPath) {
    throw new Error(`Brain "${safe}" has no decrypted database. Run \`engram brain refresh ${safe}\`.`)
  }
  const db = new Database(dbPath, { readonly: true })
  try {
    assertBrainReadable(db, safe)
    const row = db
      .prepare(
        `SELECT id, content, type, importance, tags, created_at
         FROM memories
         WHERE id = ?
           AND ${notSupersededClause('memories.id')}`
      )
      .get(memoryId) as BrainSearchResult | undefined
    return row ?? null
  } finally {
    db.close()
  }
}

export interface MarkShareableResult {
  id: string
  shareable: boolean
  changed: boolean
}

export interface MarkShareableOptions {
  /**
   * When set, the memory must live in this namespace or a child layer of it
   * (path descendant or synthetic `<ns>//<scope>`). This keeps an agent's
   * shareable-marking authority inside the project it is actually connected
   * to, instead of letting a prompt-injected call flag any memory in the store.
   */
  allowedNamespace?: string
}

function isNamespaceWithin(namespace: string, allowed: string): boolean {
  // `${allowed}/` covers both path descendants (/repo/sub) and synthetic
  // scope layers (/repo//payments), while rejecting sibling prefixes such as
  // /repo2 for an allowed namespace of /repo.
  return namespace === allowed || namespace.startsWith(`${allowed}/`)
}

export function markShareable(
  sourceDb: Database.Database,
  memoryId: string,
  shareable: boolean,
  actor: string = 'mcp',
  options: MarkShareableOptions = {}
): MarkShareableResult {
  const row = sourceDb
    .prepare(
      'SELECT id, COALESCE(namespace, project_path) AS namespace, shareable FROM memories WHERE id = ?'
    )
    .get(memoryId) as { id: string; namespace: string | null; shareable: number } | undefined
  if (!row) {
    throw new Error(`Memory ${memoryId} not found`)
  }
  if (options.allowedNamespace && (!row.namespace || !isNamespaceWithin(row.namespace, options.allowedNamespace))) {
    throw new Error(
      `Refusing to mark memory ${memoryId} shareable: it belongs to "${row.namespace ?? 'unknown'}", outside the caller's namespace "${options.allowedNamespace}". Shareable-marking is scoped to the current project; connect with ?project=<that namespace> to share it deliberately.`
    )
  }
  const newVal = shareable ? 1 : 0
  if (row.shareable === newVal) {
    return { id: memoryId, shareable, changed: false }
  }
  sourceDb.prepare('UPDATE memories SET shareable = ? WHERE id = ?').run(newVal, memoryId)
  logAudit({
    type: shareable ? 'mark_shareable' : 'unmark_shareable',
    namespace: row.namespace ?? '(none)',
    memory_id: memoryId,
    actor,
  })
  return { id: memoryId, shareable, changed: true }
}
