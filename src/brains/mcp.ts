import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { BRAINS_DIR, sanitizeBrainName } from './paths.js'
import { readManifest, readManifestFromFile, validateForImport, type BrainManifest } from './snapshot.js'
import { notSupersededClause } from '../contradictions/supersession.js'
import { logAudit } from './audit.js'
import * as sqliteVec from 'sqlite-vec'
import { vectorSearch } from '../memory/search/hybrid.js'
import { getEmbedding } from '../embeddings/pipeline.js'

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

/**
 * The lexical pass is authoritative: if it found anything, that is the answer.
 * Only when it finds nothing do we consult the vectors, because a KNN search
 * ALWAYS returns its nearest neighbour - without a similarity floor an
 * unrelated memory becomes an answer, which is a precision bug, not recall.
 *
 * The floor is deliberately conservative. Too low ships wrong answers; too
 * high merely reproduces the lexical behaviour. Calibrate against real
 * embeddings before lowering it.
 */
const MIN_SEMANTIC_COSINE = 0.6

export type EmbedQuery = (text: string) => Promise<Float32Array | null>

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

async function trySemanticSearch(
  db: Database.Database,
  query: string,
  limit: number,
  embedQuery: EmbedQuery
): Promise<BrainSearchResult[] | null> {
  let vectorRows = 0
  try {
    sqliteVec.load(db)
    vectorRows = (db.prepare('SELECT COUNT(*) AS c FROM memory_vectors').get() as { c: number }).c
  } catch {
    return null // sqlite-vec unavailable: lexical path only
  }
  if (vectorRows === 0) return null

  let embedding: Float32Array | null = null
  try {
    embedding = await embedQuery(query)
  } catch {
    return null
  }
  if (!embedding) return null // no local model: lexical path only

  try {
    const candidates = vectorSearch(db, embedding, { include_superseded: false }, Math.max(limit * 4, 20))
    if (candidates.length === 0) return []

    const readVecRowid = db.prepare('SELECT vec_rowid FROM memories WHERE id = ?')
    const readVec = db.prepare('SELECT embedding FROM memory_vectors WHERE rowid = ?')
    const scored: Array<{ hit: BrainSearchResult; cos: number }> = []
    for (const m of candidates) {
      const row = readVecRowid.get(m.id) as { vec_rowid: number | null } | undefined
      if (!row || row.vec_rowid === null || row.vec_rowid === undefined) continue
      const blob = readVec.get(row.vec_rowid) as { embedding: Buffer } | undefined
      if (!blob?.embedding) continue
      const buf = blob.embedding
      const stored = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
      const cos = cosineSimilarity(embedding, stored)
      if (cos < MIN_SEMANTIC_COSINE) continue
      scored.push({
        cos,
        hit: {
          id: m.id,
          content: m.content,
          type: m.type,
          importance: m.importance,
          tags: Array.isArray(m.tags) ? JSON.stringify(m.tags) : String(m.tags ?? '[]'),
          created_at: m.created_at,
        },
      })
    }
    if (scored.length === 0) return []

    scored.sort((a, b) => b.cos - a.cos)
    const top = scored.slice(0, limit).map((s) => s.hit)

    // Defensive supersession filter: a retracted fact must never be served.
    const ids = top.map((r) => r.id)
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
    return top.filter((r) => live.has(r.id))
  } catch {
    return null // any vector failure degrades to lexical
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
  brainsDir: string = BRAINS_DIR,
  embedQuery: EmbedQuery = (text) => getEmbedding(text, 'query')
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
    const lexical =
      rows.length > 0 || tokens.length === 1
        ? rows
        : (db.prepare(select).all(matchExpression(tokens, 'OR'), limit) as BrainSearchResult[])
    // Lexical is authoritative. The vectors are a recall fallback for questions
    // the keywords cannot answer - never a way to answer ones they already can.
    if (lexical.length > 0) return lexical
    return (await trySemanticSearch(db, query, limit, embedQuery)) ?? lexical
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
