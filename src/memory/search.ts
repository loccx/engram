/**
 * Hybrid retrieval combining FTS5 (lexical) + sqlite-vec (semantic),
 * with query-adaptive signal weighting inspired by Attention Residuals
 * (arxiv 2603.15031).
 *
 * Instead of fixed-weight score multiplication (the "residual connection"
 * pattern), each query is classified into an archetype that determines
 * how much each signal contributes — like learned attention over
 * accumulated layer outputs.
 *
 * Signals: FTS5 rank, vector rank, Ebbinghaus decay, access frequency,
 * importance. All normalized to [0,1] before weighted combination.
 *
 * Research: MemoryBank (2305.10250), FOREVER (2601.03938),
 *   RRF (Cormack et al. 2009), AttnRes (2603.15031)
 */

import type Database from 'better-sqlite3'
import type { Memory, SearchResult, MemoryType } from './types.js'
import { getEmbedding } from '../embeddings/pipeline.js'
import { notSupersededClause } from '../contradictions/supersession.js'

interface MemoryRow {
  id: string
  session_id: string
  project_path: string
  content: string
  type: string
  importance: number
  tags: string
  created_at: number
  last_accessed: number | null
  access_count: number
  vec_rowid: number | null
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    ...row,
    type: row.type as MemoryType,
    tags: JSON.parse(row.tags) as string[],
  }
}

/**
 * Ebbinghaus forgetting curve: R = exp(-t / S)
 * S (stability) scales with importance and access frequency.
 * A memory with importance=0.5 and 0 accesses decays to ~37% in 30 days.
 * Frequent access raises S, slowing decay (spacing effect).
 */
function ebbinghaus(memory: Memory, now: number): number {
  const t = now - (memory.last_accessed ?? memory.created_at)
  const tDays = t / (24 * 60 * 60 * 1000)
  // Memory strength: base importance + access frequency bonus (spacing effect)
  const strength = memory.importance + 0.3 * Math.log(memory.access_count + 1)
  const S = 30 * Math.max(strength, 0.1)
  return Math.exp(-tDays / S)
}

// AttnRes-inspired adaptive scoring (arxiv 2603.15031):
// query archetype determines signal weights instead of fixed multiplication.
export type QueryArchetype = 'temporal' | 'lookup' | 'semantic' | 'frequentist'

interface WeightProfile {
  fts: number
  vec: number
  recency: number
  access: number
  importance: number
}

// Priority order: temporal > lookup > frequentist > semantic (default)
const TEMPORAL_RE =
  /\b(yesterday|today|recent(?:ly)?|last\s+(?:week|session|time|month|day)|ago|earlier|previous(?:ly)?|this\s+(?:morning|week|month))\b/i
const LOOKUP_RE =
  /\b[a-z]+[A-Z][a-zA-Z]*\b|\b[a-z]+_[a-z]+\b|\b[A-Z][A-Z0-9]+_[A-Z][A-Z0-9]+\b|`[^`]+`|0x[0-9a-fA-F]+/
const FREQUENTIST_RE =
  /\b(common(?:ly)?|frequent(?:ly)?|often|always|usually|pattern|convention|standard|best\s+practice|typical(?:ly)?)\b/i

// Weights sum to 1.0; vec weight is redistributed when vectors unavailable.
export const WEIGHT_PROFILES: Record<QueryArchetype, WeightProfile> = {
  temporal:    { fts: 0.10, vec: 0.15, recency: 0.50, access: 0.10, importance: 0.15 },
  lookup:      { fts: 0.45, vec: 0.15, recency: 0.10, access: 0.15, importance: 0.15 },
  semantic:    { fts: 0.20, vec: 0.35, recency: 0.15, access: 0.10, importance: 0.20 },
  frequentist: { fts: 0.10, vec: 0.15, recency: 0.10, access: 0.45, importance: 0.20 },
}

/** Classify query for adaptive signal weighting. Priority: temporal > lookup > frequentist > semantic. */
export function classifyQuery(query: string): QueryArchetype {
  if (TEMPORAL_RE.test(query)) return 'temporal'
  if (LOOKUP_RE.test(query)) return 'lookup'
  if (FREQUENTIST_RE.test(query)) return 'frequentist'
  return 'semantic'
}

export interface SearchOptions {
  project_path?: string
  limit?: number
  type?: MemoryType
  include_superseded?: boolean
}

export class MemorySearch {
  constructor(
    private readonly db: Database.Database,
    private readonly vectorsAvailable: boolean = false
  ) {}

  /**
   * Hybrid search with query-adaptive signal weighting.
   * Retrieves candidates via FTS5 + vector, then scores each using
   * five normalized signals weighted by query archetype.
   * Falls back to FTS5-only if embeddings are unavailable.
   *
   * Side effect: populates `signalBreakdown` (if provided) with each
   * memory id mapped to its weighted contribution per signal. Used by
   * MCP enrichment to attribute `recall_reason`.
   */
  async hybridSearch(
    query: string,
    options: SearchOptions = {},
    signalBreakdown?: Map<string, Record<'fts' | 'vec' | 'recency' | 'access' | 'importance', number>>
  ): Promise<SearchResult[]> {
    const limit = options.limit ?? 10
    const overFetch = Math.max(limit * 5, 50)
    const now = Date.now()

    // 1. FTS5 lexical retrieval
    const ftsRows = this._ftsSearch(query, options, overFetch)

    // 2. Vector semantic retrieval (if available)
    const queryEmbed = this.vectorsAvailable ? await getEmbedding(query, 'query') : null
    const vecRows = queryEmbed ? this._vectorSearch(queryEmbed, options, overFetch) : []

    // 3. Decompose retrieval signals (RRF per-method, k=60)
    const k = 60
    const candidates = new Map<string, { fts: number; vec: number; memory: Memory }>()

    ftsRows.forEach((m, rank) => {
      candidates.set(m.id, { fts: 1 / (k + rank + 1), vec: 0, memory: m })
    })

    vecRows.forEach((m, rank) => {
      const ex = candidates.get(m.id)
      const vecScore = 1 / (k + rank + 1)
      if (ex) {
        ex.vec = vecScore
      } else {
        candidates.set(m.id, { fts: 0, vec: vecScore, memory: m })
      }
    })

    // 4. Normalize retrieval scores to [0,1] for cross-signal comparison
    let maxFts = 0
    let maxVec = 0
    for (const { fts, vec } of candidates.values()) {
      if (fts > maxFts) maxFts = fts
      if (vec > maxVec) maxVec = vec
    }

    // 5. Query-adaptive weighting: classify query, then weight signals
    const archetype = classifyQuery(query)
    const w = { ...WEIGHT_PROFILES[archetype] }

    // Redistribute vec weight when vectors are unavailable
    if (maxVec === 0 && w.vec > 0) {
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

    const results: SearchResult[] = [...candidates.values()].map(({ fts, vec, memory }) => {
      const normFts = maxFts > 0 ? fts / maxFts : 0
      const normVec = maxVec > 0 ? vec / maxVec : 0
      const recency = ebbinghaus(memory, now)
      // Normalize access count to [0,1] — 100 accesses saturates at 1.0
      const access = Math.min(Math.log(memory.access_count + 1) / Math.log(100), 1.0)
      const contribFts = w.fts * normFts
      const contribVec = w.vec * normVec
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
        })
      }
      return {
        ...memory,
        score: contribFts + contribVec + contribRecency + contribAccess + contribImportance,
      }
    })

    const top = results.sort((a, b) => b.score - a.score).slice(0, limit)

    // Record access on returned results so Ebbinghaus spacing effect works:
    // memories that get retrieved strengthen over time instead of decaying.
    if (top.length > 0) {
      const ids = top.map((r) => r.id)
      const placeholders = ids.map(() => '?').join(',')
      this.db
        .prepare(
          `UPDATE memories SET last_accessed = ?, access_count = access_count + 1
           WHERE id IN (${placeholders})`
        )
        .run(now, ...ids)
    }

    return top
  }

  private _ftsSearch(query: string, options: SearchOptions, limit: number): Memory[] {
    const tokens = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)

    // Try implicit AND first, fallback to OR if AND returns nothing (common with 3+ terms)
    const andQuery = tokens.join(' ')
    const rows = this._ftsExec(andQuery, options, limit)
    if (rows.length > 0 || tokens.length <= 2) return rows

    // AND returned nothing — retry with OR for partial matches
    const orQuery = tokens.join(' OR ')
    return this._ftsExec(orQuery, options, limit)
  }

  private _ftsExec(ftsQuery: string, options: SearchOptions, limit: number): Memory[] {
    const conditions: string[] = ['memories_fts MATCH ?']
    const values: unknown[] = [ftsQuery]

    if (options.project_path) {
      // namespace and project_path coexist during the backfill window;
      // match against either so callers see consistent results.
      conditions.push('COALESCE(m.namespace, m.project_path) = ?')
      values.push(options.project_path)
    }
    if (options.type) {
      conditions.push('m.type = ?')
      values.push(options.type)
    }
    if (!options.include_superseded) {
      conditions.push(notSupersededClause('m.id'))
    }
    values.push(limit)

    // bm25(table, w_content=10.0, w_tags=5.0) — explicit column weights.
    // Content carries 2x the influence of tags so short tag matches do not
    // dominate longer, more discriminative content matches.
    try {
      const rows = this.db
        .prepare(
          `SELECT m.* FROM memories_fts fts
           JOIN memories m ON fts.rowid = m.rowid
           WHERE ${conditions.join(' AND ')}
           ORDER BY bm25(memories_fts, 10.0, 5.0)
           LIMIT ?`
        )
        .all(...values) as MemoryRow[]
      return rows.map(rowToMemory)
    } catch {
      return []
    }
  }

  private _vectorSearch(embedding: Float32Array, options: SearchOptions, limit: number): Memory[] {
    const queryVec = JSON.stringify(Array.from(embedding))

    let sql = `
      SELECT m.* FROM
        (SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? LIMIT ?) knn
      JOIN memories m ON m.vec_rowid = knn.rowid
      WHERE 1=1
    `
    const values: unknown[] = [queryVec, limit]

    if (options.project_path) {
      sql += ' AND COALESCE(m.namespace, m.project_path) = ?'
      values.push(options.project_path)
    }
    if (options.type) {
      sql += ' AND m.type = ?'
      values.push(options.type)
    }
    if (!options.include_superseded) {
      sql += ` AND ${notSupersededClause('m.id')}`
    }
    sql += ' ORDER BY knn.distance'

    try {
      return (this.db.prepare(sql).all(...values) as MemoryRow[]).map(rowToMemory)
    } catch {
      return []
    }
  }

  /**
   * Get the most contextually relevant memories for a project.
   * Used at session start to load working context.
   * Ranked by importance × Ebbinghaus retention (no query needed).
   */
  getContext(
    project_path: string,
    limit: number = 20,
    options: { include_superseded?: boolean } = {}
  ): Memory[] {
    const now = Date.now()
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000

    const supersededFilter = options.include_superseded
      ? ''
      : ` AND ${notSupersededClause('memories.id')}`

    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE COALESCE(namespace, project_path) = ?${supersededFilter}
         ORDER BY
           (importance * 0.5 + CASE WHEN created_at > ? THEN 0.5 ELSE 0 END) DESC,
           created_at DESC
         LIMIT ?`
      )
      .all(project_path, thirtyDaysAgo, limit) as MemoryRow[]

    return rows.map(rowToMemory)
  }

  /**
   * Walk the memory graph N hops deep via recursive CTE.
   * Returns memories with hop distance, deduped to shortest path.
   */
  traverseGraph(
    startId: string,
    depth: number = 2,
    limit: number = 20,
    options: { include_superseded?: boolean } = {}
  ): Array<Memory & { similarity: number; link_type: string; hops: number }> {
    const supersededFilter = options.include_superseded
      ? ''
      : ` AND ${notSupersededClause('m.id')}`

    const rows = this.db
      .prepare(
        `WITH RECURSIVE traverse AS (
           SELECT target_id AS id, similarity, link_type, 1 AS hops,
                  ',' || ? || ',' || target_id || ',' AS path
           FROM memory_links WHERE source_id = ?
           UNION ALL
           SELECT ml.target_id, ml.similarity, ml.link_type, t.hops + 1,
                  t.path || ml.target_id || ','
           FROM traverse t
           JOIN memory_links ml ON ml.source_id = t.id
           WHERE t.hops < ? AND instr(t.path, ',' || ml.target_id || ',') = 0
         )
         SELECT m.*, sub.similarity, sub.link_type, sub.hops
         FROM (
           SELECT id, similarity, link_type, hops,
                  ROW_NUMBER() OVER (PARTITION BY id ORDER BY hops ASC, similarity DESC) AS rn
           FROM traverse WHERE id != ?
         ) sub
         JOIN memories m ON m.id = sub.id
         WHERE sub.rn = 1${supersededFilter}
         ORDER BY sub.hops ASC, sub.similarity DESC
         LIMIT ?`
      )
      .all(startId, startId, depth, startId, limit) as Array<
        MemoryRow & { similarity: number; link_type: string; hops: number }
      >

    return rows.map((row) => ({
      ...rowToMemory(row),
      similarity: row.similarity,
      link_type: row.link_type,
      hops: row.hops,
    }))
  }

  /**
   * Find near-duplicate memories using vector similarity.
   * Returns candidate groups for consolidation.
   * Based on memory consolidation literature (Mem0, arxiv 2504.19413).
   */
  findDuplicates(
    options: {
      threshold?: number
      project_path?: string
      limit?: number
      include_superseded?: boolean
    } = {}
  ): Array<{ representative: Memory; duplicates: Array<{ memory: Memory; similarity: number }> }> {
    if (!this.vectorsAvailable) return []

    const threshold = options.threshold ?? 0.95 // cosine_sim > 0.95
    // Convert cosine threshold to L2 distance: d = sqrt(2*(1 - cos_sim))
    const distThreshold = Math.sqrt(2 * (1 - threshold))
    const limit = options.limit ?? 50

    const conditions: string[] = []
    const values: unknown[] = [threshold]
    if (options.project_path) {
      conditions.push('COALESCE(m1.namespace, m1.project_path) = ?')
      values.push(options.project_path)
    }
    if (!options.include_superseded) {
      conditions.push(notSupersededClause('m1.id'))
      conditions.push(notSupersededClause('m2.id'))
    }
    values.push(limit)

    const where = conditions.length ? `AND ${conditions.join(' AND ')}` : ''

    // Find pairs with similarity above threshold (avoid duplicating pairs)
    const pairs = this.db
      .prepare(
        `SELECT ml.source_id, ml.target_id, ml.similarity,
                m1.importance as imp1, m2.importance as imp2,
                m1.access_count as acc1, m2.access_count as acc2
         FROM memory_links ml
         JOIN memories m1 ON ml.source_id = m1.id
         JOIN memories m2 ON ml.target_id = m2.id
         WHERE ml.similarity > ? ${where}
           AND ml.source_id < ml.target_id
         ORDER BY ml.similarity DESC
         LIMIT ?`
      )
      .all(...values) as Array<{
      source_id: string
      target_id: string
      similarity: number
      imp1: number
      imp2: number
      acc1: number
      acc2: number
    }>

    // Cluster into groups using union-find
    const parent = new Map<string, string>()
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x)
      const p = parent.get(x)!
      if (p !== x) parent.set(x, find(p))
      return parent.get(x)!
    }
    const union = (x: string, y: string) => parent.set(find(x), find(y))

    for (const { source_id, target_id } of pairs) {
      union(source_id, target_id)
    }

    // Build groups
    const groups = new Map<string, string[]>()
    for (const { source_id, target_id } of pairs) {
      const root = find(source_id)
      if (!groups.has(root)) groups.set(root, [])
      for (const id of [source_id, target_id]) {
        if (!groups.get(root)!.includes(id)) groups.get(root)!.push(id)
      }
    }

    // Batch-fetch all memories referenced across all groups (avoids N+1)
    const allIds = new Set<string>()
    for (const members of groups.values()) {
      for (const id of members) allIds.add(id)
    }

    const memoryMap = new Map<string, Memory>()
    if (allIds.size > 0) {
      const idList = [...allIds]
      const placeholders = idList.map(() => '?').join(',')
      const rows = this.db
        .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
        .all(...idList) as MemoryRow[]
      for (const row of rows) {
        memoryMap.set(row.id, rowToMemory(row))
      }
    }

    const result: Array<{
      representative: Memory
      duplicates: Array<{ memory: Memory; similarity: number }>
    }> = []

    for (const members of groups.values()) {
      const memories = members.map((id) => memoryMap.get(id)).filter((m): m is Memory => m != null)
      if (memories.length < 2) continue

      const rep = memories.reduce((best, m) =>
        m.importance * (m.access_count + 1) > best.importance * (best.access_count + 1) ? m : best
      )

      const sims = new Map(pairs.filter(p => members.includes(p.source_id) && members.includes(p.target_id)).map(p => [`${p.source_id}:${p.target_id}`, p.similarity]))

      const duplicates = memories
        .filter((m) => m.id !== rep.id)
        .map((m) => ({
          memory: m,
          similarity: sims.get(`${rep.id}:${m.id}`) ?? sims.get(`${m.id}:${rep.id}`) ?? threshold,
        }))

      result.push({ representative: rep, duplicates })
    }

    return result
  }
}
