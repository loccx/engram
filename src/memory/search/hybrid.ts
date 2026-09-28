import type Database from 'better-sqlite3'
import type { Memory, SearchResult, MemoryType } from '../types.js'
import { getEmbedding } from '../../embeddings/pipeline.js'
import { rerank as rerankCrossEncoder } from '../../embeddings/reranker.js'
import {
  notSupersededClause,
  notSupersededAtClause,
  validityAtClause,
} from '../../contradictions/supersession.js'
import { rowToMemory, type MemoryRow } from '../row.js'
import {
  ebbinghaus,
  classifyQuery,
  WEIGHT_PROFILES,
  bm25Relevance,
  distanceRelevance,
  blendRerankScore,
  normalizeRerankScore,
  clamp01,
  rerankBlendAlpha,
  RERANK_NORM_NEUTRAL,
  resolveAccessSignalMode,
  identChannelEnabled,
  entityChannelEnabled,
  type SignalKey,
} from './scoring.js'
import { expandQuery, queryTokens } from './expand.js'
import { identSearchScored } from './lexical.js'
import { entitySearchScored, entityQueryTokens } from './entity.js'

/** branches that failed, so an empty result set is distinguishable from an outage */
export interface SearchDiagnostics {
  /** an optional index that has not been backfilled yet is not a failure */
  degraded: string[]
}

export interface SearchOptions {
  project_path?: string
  /** the node itself or anything under it, never a sibling; not with project_path */
  namespace_subtree?: string
  limit?: number
  type?: MemoryType
  /** legacy bound: only valid_from <= t, no valid_until */
  before?: number
  /** full historical view at t, including time-aware supersession; wins over before */
  as_of?: number
  include_superseded?: boolean
  use_reranker?: boolean
  rerank_top_n?: number
  /** reranker weight; 1 leaves the window and the unwindowed tail on different scales */
  rerank_blend_alpha?: number
  /** absolute floor on score; the priors alone reach w.recency+w.access+w.importance */
  min_score?: number
  /** deterministic offline expansion variants as extra lists; each list is diluted by 1/n */
  expand?: boolean
  /** needs ENGRAM_LLM_*; a failure here only shows up in diagnostics.degraded */
  expand_use_llm?: boolean
  /** memories_ident_fts as one more list; off unless set, or ENGRAM_IDENT_CHANNEL=1 */
  ident_channel?: boolean
  /** memory_entity_fts as one more list; off unless set, or ENGRAM_ENTITY_CHANNEL=1 */
  entity_channel?: boolean
  diagnostics?: SearchDiagnostics
  /**
   * do not stamp last_accessed/access_count on the results; recall_context passes
   * false so repeated calls stay deterministic and side-effect free
   */
  touch?: boolean
  /** fixed clock for deterministic scoring */
  now?: number
}

/** rerank window; narrowing it below the candidate count puts two score scales in one list */
export const DEFAULT_RERANK_TOP_N = 50

export async function hybridSearch(
  db: Database.Database,
  vectorsAvailable: boolean,
  query: string,
  options: SearchOptions = {},
  signalBreakdown?: Map<string, Record<SignalKey, number>>
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10
  const overFetch = Math.max(limit * 5, 50)
  const now = options.now ?? Date.now()
  const diagnostics: SearchDiagnostics = options.diagnostics ?? { degraded: [] }

  const lexicalLists = await lexicalListsFor(query, options, diagnostics)
  const scoredLists = lexicalLists.map((list) => ({
    list,
    hits: lexicalListRelevance(db, list, options, overFetch, diagnostics),
  }))
  const weightedLists = scoredLists.filter(
    // a channel that matched nothing is left out of n, so it cannot dilute the rest
    ({ list, hits }) => list.kind === 'fts' || hits.size > 0
  )
  const nLex = Math.max(1, weightedLists.length)
  const lexById = new Map<string, { memory: Memory; relevance: number }>()
  for (const { hits } of weightedLists) {
    const weight = 1 / nLex
    for (const [id, { memory, relevance }] of hits) {
      const contribution = weight * relevance
      const existing = lexById.get(id)
      if (existing) existing.relevance += contribution
      else lexById.set(id, { memory, relevance: contribution })
    }
  }

  const vecById = new Map<string, { memory: Memory; relevance: number }>()
  if (vectorsAvailable) {
    let queryEmbed: Awaited<ReturnType<typeof getEmbedding>> = null
    try {
      queryEmbed = await getEmbedding(query, 'query')
    } catch {
      // an embedding outage must not take the lexical branch down with it
      queryEmbed = null
    }
    if (!queryEmbed) {
      diagnostics.degraded.push('embedding')
    } else {
      for (const { memory, distance } of vectorSearchScored(
        db,
        queryEmbed,
        options,
        overFetch,
        diagnostics
      )) {
        vecById.set(memory.id, { memory, relevance: distanceRelevance(distance) })
      }
    }
  }

  const candidates = new Map<string, { lex: number; vec: number; memory: Memory }>()
  for (const [id, { memory, relevance }] of lexById) {
    candidates.set(id, { lex: relevance, vec: 0, memory })
  }
  for (const [id, { memory, relevance }] of vecById) {
    const ex = candidates.get(id)
    if (ex) ex.vec = relevance
    else candidates.set(id, { lex: 0, vec: relevance, memory })
  }

  const archetype = classifyQuery(query)
  const w = { ...WEIGHT_PROFILES[archetype] }

  // vectors are off, so hand their weight to the other signals
  if (vecById.size === 0 && w.vec > 0) {
    const spare = w.vec
    w.vec = 0
    const rest = w.fts + w.recency + w.access + w.importance
    if (rest > 0) {
      const scale = (rest + spare) / rest
      w.fts *= scale
      w.recency *= scale
      w.access *= scale
      w.importance *= scale
    }
  }

  // ties break on candidate order, never memory.id: that uuid is fresh per store
  const candidateOrder = new Map<string, number>()
  for (const id of candidates.keys()) candidateOrder.set(id, candidateOrder.size)
  const byCandidateOrder = (a: { id: string }, b: { id: string }): number =>
    (candidateOrder.get(a.id) ?? 0) - (candidateOrder.get(b.id) ?? 0)

  const results: SearchResult[] = [...candidates.values()].map(({ lex, vec, memory }) => {
    const recency = ebbinghaus(memory, now)
    // 100 accesses saturates to 1.0; log-scale prevents single hot memories from dominating
    const access = Math.min(Math.log(memory.access_count + 1) / Math.log(100), 1.0)
    const contribFts = w.fts * lex
    const contribVec = w.vec * vec
    const contribRecency = w.recency * recency
    const contribAccess = w.access * access
    const contribImportance = w.importance * memory.importance
    if (signalBreakdown) {
      signalBreakdown.set(memory.id, {
        fts: contribFts,
        vec: contribVec,
        recency: contribRecency,
        access: contribAccess,
        importance: contribImportance,
        reranker: 0,
      })
    }
    // evidence share of the score, priors excluded: gate on this, not on score
    const evidenceMass = w.fts + w.vec
    return {
      ...memory,
      score: contribFts + contribVec + contribRecency + contribAccess + contribImportance,
      relevance: evidenceMass > 0 ? (contribFts + contribVec) / evidenceMass : 0,
    }
  })

  let ranked = results.sort((a, b) => b.score - a.score || byCandidateOrder(a, b))

  if (options.use_reranker && ranked.length > 1) {
    const topN = options.rerank_top_n ?? DEFAULT_RERANK_TOP_N
    const window = ranked.slice(0, Math.min(topN, ranked.length))
    const tail = ranked.slice(window.length)
    const rerankScores = await rerankCrossEncoder(
      query,
      window.map((r) => r.content)
    )
    if (rerankScores) {
      const alpha = clamp01(options.rerank_blend_alpha ?? rerankBlendAlpha())
      const normByIndex = new Map<number, number>()
      for (const rs of rerankScores) normByIndex.set(rs.index, normalizeRerankScore(rs.score))
      // blend, never substitute: a reranked window would sort on a second scale
      const blended = (result: SearchResult, norm: number): SearchResult => {
        const existing = signalBreakdown?.get(result.id)
        if (existing) existing.reranker = alpha * norm
        return { ...result, score: blendRerankScore(result.score, norm, alpha) }
      }
      ranked = [
        ...window.map((result, i) =>
          blended(result, normByIndex.get(i) ?? RERANK_NORM_NEUTRAL)
        ),
        ...tail.map((result) => blended(result, RERANK_NORM_NEUTRAL)),
      ].sort((a, b) => b.score - a.score || byCandidateOrder(a, b))
    } else {
      // requested but unavailable: still return fused order, and say so
      diagnostics.degraded.push('reranker')
    }
  }

  if (options.min_score !== undefined) {
    const floor = options.min_score
    ranked = ranked.filter((r) => r.score >= floor)
  }

  const top = ranked.slice(0, limit)

  // which reads count as a use is policy: ENGRAM_ACCESS_SIGNAL picks it, 'off'
  // wins outright, and an explicit touch wins in both directions
  const accessMode = resolveAccessSignalMode()
  const accessAllowed =
    accessMode !== 'off' &&
    (options.touch === true || (options.touch !== false && accessMode === 'retrieval'))
  if (accessAllowed) {
    if (top.length > 0) {
      const ids = top.map((r) => r.id)
      const placeholders = ids.map(() => '?').join(',')
      db.prepare(
        `UPDATE memories SET last_accessed = ?, access_count = access_count + 1
         WHERE id IN (${placeholders})`
      ).run(now, ...ids)
    }
  }

  if (diagnostics.degraded.length === 0) return top
  return top.map((r) => ({ ...r, degraded: true }))
}

export type LexicalListKind = 'fts' | 'ident' | 'entity'

export interface LexicalList {
  kind: LexicalListKind
  query: string
}

// an expansion failure degrades to the primary list; enabled channels just join it
async function lexicalListsFor(
  query: string,
  options: SearchOptions,
  diagnostics: SearchDiagnostics
): Promise<LexicalList[]> {
  const lists: LexicalList[] = [{ kind: 'fts', query }]
  if (options.expand) {
    try {
      const variants = await expandQuery(query, { useLlm: options.expand_use_llm === true })
      for (const variant of variants) lists.push({ kind: 'fts', query: variant })
    } catch {
      diagnostics.degraded.push('expansion')
    }
  }
  if (identChannelEnabled(options)) lists.push({ kind: 'ident', query })
  if (entityChannelEnabled(options)) lists.push({ kind: 'entity', query })
  return lists
}

export function ftsSearch(
  db: Database.Database,
  query: string,
  options: SearchOptions,
  limit: number
): Memory[] {
  return ftsSearchScored(db, query, options, limit).map((r) => r.memory)
}

export interface ScoredLexicalHit {
  memory: Memory
  /** raw FTS5 bm25: negative, lower is better */
  bm25: number
}

export function ftsSearchScored(
  db: Database.Database,
  query: string,
  options: SearchOptions,
  limit: number,
  diagnostics?: SearchDiagnostics
): ScoredLexicalHit[] {
  // a quoted variant is already an FTS5 phrase; per-token quoting would break it
  const trimmed = query.trim()
  if (isPhraseQuery(trimmed)) return ftsExecScored(db, trimmed, options, limit, diagnostics)

  const tokens = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)

  // implicit and first: all-terms semantics is too strict for a 3+ term query, so
  // or is the fallback
  const andQuery = tokens.join(' ')
  const rows = ftsExecScored(db, andQuery, options, limit, diagnostics)
  if (rows.length > 0 || tokens.length <= 2) return rows

  const orQuery = tokens.join(' OR ')
  return ftsExecScored(db, orQuery, options, limit, diagnostics)
}

// fts5 clamps idf to 1e-6 once a term is in half the corpus: fall back to coverage
function lexicalListRelevance(
  db: Database.Database,
  list: LexicalList,
  options: SearchOptions,
  limit: number,
  diagnostics?: SearchDiagnostics
): Map<string, { memory: Memory; relevance: number }> {
  const terms = listTermsFor(list.kind, list.query)
  const hits = scoredListHits(db, list.kind, list.query, options, limit, diagnostics)
  const out = new Map<string, { memory: Memory; relevance: number }>()

  const maxPerTerm = hits.reduce(
    (max, h) => Math.max(max, -h.bm25 / Math.max(1, terms.length)),
    0
  )
  if (maxPerTerm >= BM25_MAGNITUDE_EPS) {
    for (const { memory, bm25 } of hits) {
      out.set(memory.id, { memory, relevance: bm25Relevance(bm25, terms.length) })
    }
    return out
  }

  if (terms.length === 0) return out
  const matchedTerms = new Map<string, number>()
  for (const term of terms) {
    for (const { memory } of scoredListHits(db, list.kind, term, options, limit, diagnostics)) {
      matchedTerms.set(memory.id, (matchedTerms.get(memory.id) ?? 0) + 1)
      if (!out.has(memory.id)) out.set(memory.id, { memory, relevance: 0 })
    }
  }
  for (const [id, entry] of out) {
    entry.relevance = (matchedTerms.get(id) ?? 0) / terms.length
  }
  return out
}

// every channel returns raw bm25, so one relevance map covers all of them
function scoredListHits(
  db: Database.Database,
  kind: LexicalListKind,
  text: string,
  options: SearchOptions,
  limit: number,
  diagnostics?: SearchDiagnostics
): ScoredLexicalHit[] {
  if (kind === 'ident') return identSearchScored(db, text, options, limit, diagnostics)
  if (kind === 'entity') return entitySearchScored(db, text, options, limit, diagnostics)
  return ftsSearchScored(db, text, options, limit, diagnostics)
}

// the entity channel searches its own tokenisation, so it divides by its own count
function listTermsFor(kind: LexicalListKind, text: string): string[] {
  return kind === 'entity' ? entityQueryTokens(text) : listTerms(text)
}

// the clamped regime reports ~1e-6; real per-term bm25 magnitudes sit far above
const BM25_MAGNITUDE_EPS = 1e-3

function listTerms(list: string): string[] {
  const unquoted =
    list.startsWith('"') && list.endsWith('"') && list.length > 1 ? list.slice(1, -1) : list
  return queryTokens(unquoted)
}

function isPhraseQuery(query: string): boolean {
  return query.length > 2 && query.startsWith('"') && query.endsWith('"') && !query.slice(1, -1).includes('"')
}

// shared by the lexical and vector paths, so both scope the same memories
function memoryPredicates(options: SearchOptions): { conditions: string[]; values: unknown[] } {
  const conditions: string[] = []
  const values: unknown[] = []

  if (options.namespace_subtree) {
    const ns = options.namespace_subtree
    // _ and % are LIKE wildcards: escape them or a namespace matches sibling prefixes
    const esc = ns.replace(/[\\%_]/g, '\\$&')
    conditions.push(
      '(COALESCE(m.namespace, m.project_path) = ?' +
        " OR COALESCE(m.namespace, m.project_path) LIKE ? ESCAPE '\\'" +
        " OR COALESCE(m.namespace, m.project_path) LIKE ? ESCAPE '\\')"
    )
    values.push(ns, `${esc}/%`, `${esc}//%`)
  } else if (options.project_path) {
    // namespace + project_path coexist during the backfill window
    conditions.push('COALESCE(m.namespace, m.project_path) = ?')
    values.push(options.project_path)
  }
  if (options.type) {
    conditions.push('m.type = ?')
    values.push(options.type)
  }
  if (options.as_of !== undefined) {
    conditions.push(validityAtClause('m', '?'))
    values.push(options.as_of, options.as_of)
  } else if (options.before !== undefined) {
    conditions.push('m.valid_from <= ?')
    values.push(options.before)
  }
  if (!options.include_superseded) {
    if (options.as_of !== undefined) {
      conditions.push(notSupersededAtClause('m.id', '?'))
      values.push(options.as_of)
    } else {
      conditions.push(notSupersededClause('m.id'))
    }
  }
  return { conditions, values }
}

function ftsExecScored(
  db: Database.Database,
  ftsQuery: string,
  options: SearchOptions,
  limit: number,
  diagnostics?: SearchDiagnostics
): ScoredLexicalHit[] {
  const { conditions: predicates, values: predicateValues } = memoryPredicates(options)
  const conditions: string[] = ['memories_fts MATCH ?', ...predicates]
  const values: unknown[] = [ftsQuery, ...predicateValues]
  values.push(limit)

  // bm25(table, w_content=10.0, w_tags=5.0): content carries 2x tag weight so
  // short tag matches don't dominate longer, more discriminative content matches.
  try {
    const rows = db
      .prepare(
        `SELECT m.*, bm25(memories_fts, 10.0, 5.0) AS relevance_bm25 FROM memories_fts fts
         JOIN memories m ON fts.rowid = m.rowid
         WHERE ${conditions.join(' AND ')}
         ORDER BY bm25(memories_fts, 10.0, 5.0) ASC, m.rowid ASC
         LIMIT ?`
      )
      .all(...values) as Array<MemoryRow & { relevance_bm25: number }>
    return rows.map((row) => ({ memory: rowToMemory(row), bm25: row.relevance_bm25 }))
  } catch {
    // a failing branch must not look like an empty corpus
    diagnostics?.degraded.push('fts')
    return []
  }
}

export interface ScoredVectorHit {
  memory: Memory
  /** raw vec0 L2 distance; distanceRelevance turns it into cosine */
  distance: number
}

/** rowids per `IN (…)` list, under sqlite's 32766 bound-variable limit */
const KNN_ROWID_CHUNK = 1000

// whether vec0 accepts `rowid IN (…)` as a knn prefilter; probed once per process,
// and the setters below let tests force either path
let knnRowidFilterSupported: boolean | null = null

export function setKnnRowidFilterSupportForTests(supported: boolean | null): void {
  knnRowidFilterSupported = supported
}

export function knnRowidFilterForTests(): boolean | null {
  return knnRowidFilterSupported
}

export function vectorSearch(
  db: Database.Database,
  embedding: Float32Array,
  options: SearchOptions,
  limit: number
): Memory[] {
  return vectorSearchScored(db, embedding, options, limit).map((r) => r.memory)
}

// the knn has to run over the scoped set: filter after a global `LIMIT k` and a
// scope outside that top-k returns nothing, looking like an empty index. so the
// scoped rowid set goes into the vec0 scan, and a correlated EXISTS will not do.
export function vectorSearchScored(
  db: Database.Database,
  embedding: Float32Array,
  options: SearchOptions,
  limit: number,
  diagnostics?: SearchDiagnostics
): ScoredVectorHit[] {
  // a binary blob, as in store.ts and reembed.ts: sqlite-vec accepts
  // both JSON arrays and binary blobs; binary is ~3-4x more compact.
  const queryVec = Buffer.from(embedding.buffer)

  try {
    const { conditions, values } = memoryPredicates(options)
    const rowids =
      conditions.length === 0
        ? null // nothing to filter: the global KNN is already the scoped set
        : scopedVecRowids(db, conditions, values, queryVec, limit)

    if (rowids === null) {
      return fetchScoredMemories(
        db,
        db
          .prepare('SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? LIMIT ?')
          .all(queryVec, limit) as Array<{ rowid: number; distance: number }>
      )
    }
    return fetchScoredMemories(db, rowids)
  } catch {
    diagnostics?.degraded.push('vector')
    return []
  }
}

// memories are fetched separately, so the rowid set never joins a filtered table
function scopedVecRowids(
  db: Database.Database,
  conditions: string[],
  values: unknown[],
  queryVec: Buffer,
  limit: number
): Array<{ rowid: number; distance: number }> {
  if (knnRowidFilterIsSupported(db, queryVec)) {
    const rows = db
      .prepare(
        `SELECT rowid, distance FROM memory_vectors
         WHERE embedding MATCH ? AND k = ?
           AND rowid IN (SELECT m.vec_rowid FROM memories m
                         WHERE m.vec_rowid IS NOT NULL AND ${conditions.join(' AND ')})`
      )
      .all(queryVec, limit, ...values) as Array<{ rowid: number; distance: number }>
    return sortByDistance(rows, limit)
  }

  // fallback for a build that rejects the set expression: rank the whole index and
  // keep the scoped rows. exact, but a full scan, so it runs second. a literal
  // `rowid IN (…)` does not work instead: the bundled vec0 returns nothing for a
  // single-rowid list, which is the freshly-stored-memory case.
  const ids = new Set(
    (
      db
        .prepare(
          `SELECT m.vec_rowid AS rowid FROM memories m
           WHERE m.vec_rowid IS NOT NULL AND ${conditions.join(' AND ')}`
        )
        .all(...values) as Array<{ rowid: number }>
    ).map((r) => r.rowid)
  )
  if (ids.size === 0) return []

  const total = (db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get() as { n: number }).n
  if (total === 0) return []
  const all = db
    .prepare('SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? AND k = ?')
    .all(queryVec, total) as Array<{ rowid: number; distance: number }>
  return sortByDistance(
    all.filter((r) => ids.has(r.rowid)),
    limit
  )
}

// the scope is empty on purpose: vec0 still plans the knn, so a build that rejects
// the set expression fails here and a build that supports it returns no rows.
// no LIMIT can be added: vec0 rejects it together with `k`.
function knnRowidFilterIsSupported(db: Database.Database, queryVec: Buffer): boolean {
  if (knnRowidFilterSupported === null) {
    try {
      db.prepare(
        `SELECT rowid FROM memory_vectors
         WHERE embedding MATCH ? AND k = 1
           AND rowid IN (SELECT vec_rowid FROM memories WHERE 1 = 0)`
      ).all(queryVec)
      knnRowidFilterSupported = true
    } catch {
      knnRowidFilterSupported = false
    }
  }
  return knnRowidFilterSupported
}

function sortByDistance(
  rows: Array<{ rowid: number; distance: number }>,
  limit: number
): Array<{ rowid: number; distance: number }> {
  return [...rows].sort((a, b) => a.distance - b.distance || a.rowid - b.rowid).slice(0, limit)
}

function fetchScoredMemories(
  db: Database.Database,
  rows: Array<{ rowid: number; distance: number }>
): ScoredVectorHit[] {
  if (rows.length === 0) return []
  const distanceByRowid = new Map<number, number>()
  for (const r of rows) distanceByRowid.set(r.rowid, r.distance)

  const out: ScoredVectorHit[] = []
  const rowids = [...distanceByRowid.keys()]
  for (let i = 0; i < rowids.length; i += KNN_ROWID_CHUNK) {
    const chunk = rowids.slice(i, i + KNN_ROWID_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const memories = db
      .prepare(`SELECT m.* FROM memories m WHERE m.vec_rowid IN (${placeholders})`)
      .all(...chunk) as MemoryRow[]
    for (const row of memories) {
      const distance = row.vec_rowid === null ? undefined : distanceByRowid.get(row.vec_rowid)
      if (distance === undefined) continue
      out.push({ memory: rowToMemory(row), distance })
    }
  }
  return out.sort(
    (a, b) => a.distance - b.distance || (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0)
  )
}
