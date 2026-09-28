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
      // a published brain has no brain.db, only a manifest beside the encrypted
      // snapshot: read the sidecar, or the brain reports memory_count 0
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
 * lowercased word runs only: quotes, parens, NEAR and '*' are discarded by
 * construction, so untrusted input can never become fts5 syntax. the default
 * unicode61 tokenizer splits on the same boundaries.
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

// quoted phrases only: a bare and/or/not would be an fts5 operator, and the
// tokenizer above guarantees no quote can appear
function matchExpression(tokens: string[], operator: 'AND' | 'OR'): string {
  return tokens.map((token) => `"${token}"`).join(` ${operator} `)
}

// small boosts on top of the bm25 rank (lower is better): metadata alone must
// never outrank a strong match
const IMPORTANCE_BOOST = 0.35
const PROMINENT_TYPE_BOOST = 0.25
const PINNED_BOOST = 0.25
const PROMINENT_TYPES = ['decision', 'pattern', 'gotcha', 'procedure']

/**
 * both brain read paths go through here: a manifest that is missing or
 * incompatible (newer schema, another embedding model) has to fail loudly rather
 * than serve results from a cache this build cannot read
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
 * lexical first: if it found anything, that is the answer. vectors only when it found
 * nothing, since a knn always returns a nearest neighbour and without a floor an
 * unrelated memory becomes an answer. the floor stays conservative either way.
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
    return null // no sqlite-vec: lexical only
  }
  if (vectorRows === 0) return null

  let embedding: Float32Array | null = null
  try {
    embedding = await embedQuery(query)
  } catch {
    return null
  }
  if (!embedding) return null // no local model: lexical only

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

    // a retracted fact must never be served
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
    return null // a vector failure degrades to lexical
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

    // and first, or as the fallback: an all-terms match is what a multi-term query
    // wants, and or still gives a natural-language question ranked partials
    const rows = db.prepare(select).all(matchExpression(tokens, 'AND'), limit) as BrainSearchResult[]
    const lexical =
      rows.length > 0 || tokens.length === 1
        ? rows
        : (db.prepare(select).all(matchExpression(tokens, 'OR'), limit) as BrainSearchResult[])
    // lexical is authoritative; vectors are the recall fallback for questions the
    // keywords cannot answer, never a way to answer the ones they already can
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
   * the memory must live in this namespace or a child of it (path descendant or
   * synthetic `<ns>//<scope>`), so a prompt-injected call cannot mark another
   * project's memories shareable
   */
  allowedNamespace?: string
}

function isNamespaceWithin(namespace: string, allowed: string): boolean {
  // `${allowed}/` covers path descendants (/repo/sub) and synthetic layers
  // (/repo//payments) but not a sibling prefix like /repo2
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
