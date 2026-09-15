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
  type SignalKey,
} from './scoring.js'

export interface SearchOptions {
  project_path?: string
  /**
   * Descendant-scoped retrieval: match `COALESCE(namespace, project_path)`
   * equal to this value OR under it (`ns/%`, `ns//%`). Used by hierarchical
   * funnel retrieval when strict_scope=false. Callers set either this or
   * `project_path`, never both.
   */
  namespace_subtree?: string
  limit?: number
  type?: MemoryType
  /**
   * Legacy temporal bound (only valid_from <= before, present-state
   * supersession). Kept for backward compatibility.
   */
  before?: number
  /**
   * Historical view: full bi-temporal predicate (valid_from <= t AND
   * (valid_until IS NULL OR valid_until >= t)) plus time-aware supersession
   * (only supersedes links already judged at t). Takes precedence over
   * `before` when both are set.
   */
  as_of?: number
  include_superseded?: boolean
  use_reranker?: boolean
  rerank_top_n?: number
  /**
   * Read-only mode: do not stamp last_accessed/access_count on results.
   * Default true preserves existing behavior; recall_context passes false
   * so repeated calls are deterministic and side-effect free.
   */
  touch?: boolean
  /** Clock injection seam for deterministic scoring (defaults to Date.now()). */
  now?: number
}

export const DEFAULT_RERANK_TOP_N = 20

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

  const ftsRows = ftsSearch(db, query, options, overFetch)
  const queryEmbed = vectorsAvailable ? await getEmbedding(query, 'query') : null
  const vecRows = queryEmbed ? vectorSearch(db, queryEmbed, options, overFetch) : []

  // RRF per-method, k=60 (Cormack et al. 2009)
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

  let maxFts = 0
  let maxVec = 0
  for (const { fts, vec } of candidates.values()) {
    if (fts > maxFts) maxFts = fts
    if (vec > maxVec) maxVec = vec
  }

  const archetype = classifyQuery(query)
  const w = { ...WEIGHT_PROFILES[archetype] }

  // Redistribute vec weight when vectors are unavailable to keep total ~1.0.
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
    // 100 accesses saturates to 1.0; log-scale prevents single hot memories from dominating
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
        reranker: 0,
      })
    }
    return {
      ...memory,
      score: contribFts + contribVec + contribRecency + contribAccess + contribImportance,
    }
  })

  let ranked = results.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  if (options.use_reranker && ranked.length > 1) {
    const topN = options.rerank_top_n ?? DEFAULT_RERANK_TOP_N
    const window = ranked.slice(0, topN)
    const tail = ranked.slice(topN)
    const rerankScores = await rerankCrossEncoder(
      query,
      window.map((r) => r.content)
    )
    if (rerankScores) {
      const reordered = rerankScores.map((rs) => ({
        result: window[rs.index],
        rerankScore: rs.score,
      }))
      if (signalBreakdown) {
        for (const { result, rerankScore } of reordered) {
          const existing = signalBreakdown.get(result.id)
          if (existing) existing.reranker = rerankScore
        }
      }
      ranked = [
        ...reordered.map(({ result, rerankScore }) => ({ ...result, score: rerankScore })),
        ...tail,
      ]
    }
  }

  const top = ranked.slice(0, limit)

  // Stamp last_accessed on returned results — Ebbinghaus "spacing effect":
  // retrieved memories strengthen instead of decay. Skipped in touch:false
  // read-only mode so callers get repeatable, side-effect-free rankings.
  if (options.touch !== false && top.length > 0) {
    const ids = top.map((r) => r.id)
    const placeholders = ids.map(() => '?').join(',')
    db.prepare(
      `UPDATE memories SET last_accessed = ?, access_count = access_count + 1
       WHERE id IN (${placeholders})`
    ).run(now, ...ids)
  }

  return top
}

export function ftsSearch(
  db: Database.Database,
  query: string,
  options: SearchOptions,
  limit: number
): Memory[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)

  // Implicit AND first, fall back to OR when AND returns nothing.
  // FTS5's default AND-of-tokens semantics is too strict for 3+ term queries.
  const andQuery = tokens.join(' ')
  const rows = ftsExec(db, andQuery, options, limit)
  if (rows.length > 0 || tokens.length <= 2) return rows

  const orQuery = tokens.join(' OR ')
  return ftsExec(db, orQuery, options, limit)
}

function ftsExec(
  db: Database.Database,
  ftsQuery: string,
  options: SearchOptions,
  limit: number
): Memory[] {
  const conditions: string[] = ['memories_fts MATCH ?']
  const values: unknown[] = [ftsQuery]

  if (options.namespace_subtree) {
    // Descendant scoping: the exact node OR any child/synthetic scope under
    // it. Siblings (different parent prefixes) are never matched.
    const ns = options.namespace_subtree
    // _ and % are LIKE wildcards — escape them so a namespace with special
    // chars cannot match sibling prefixes (isolation invariant).
    const esc = ns.replace(/[\\%_]/g, '\\$&')
    conditions.push(
      '(COALESCE(m.namespace, m.project_path) = ?' +
        " OR COALESCE(m.namespace, m.project_path) LIKE ? ESCAPE '\\'" +
        " OR COALESCE(m.namespace, m.project_path) LIKE ? ESCAPE '\\'"
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
  values.push(limit)

  // bm25(table, w_content=10.0, w_tags=5.0): content carries 2x tag weight so
  // short tag matches don't dominate longer, more discriminative content matches.
  try {
    const rows = db
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

export function vectorSearch(
  db: Database.Database,
  embedding: Float32Array,
  options: SearchOptions,
  limit: number
): Memory[] {
  // Binary blob format (matches store.ts and reembed.ts). sqlite-vec accepts
  // both JSON arrays and binary blobs; binary is ~3-4x more compact.
  const queryVec = Buffer.from(embedding.buffer)

  let sql = `
    SELECT m.* FROM
      (SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? LIMIT ?) knn
    JOIN memories m ON m.vec_rowid = knn.rowid
    WHERE 1=1
  `
  const values: unknown[] = [queryVec, limit]

  if (options.namespace_subtree) {
    const ns = options.namespace_subtree
    const esc = ns.replace(/[\\%_]/g, '\\$&')
    sql += ' AND (COALESCE(m.namespace, m.project_path) = ?'
    sql += " OR COALESCE(m.namespace, m.project_path) LIKE ? ESCAPE '\\'"
    sql += " OR COALESCE(m.namespace, m.project_path) LIKE ? ESCAPE '\\')"
    values.push(ns, `${esc}/%`, `${esc}//%`)
  } else if (options.project_path) {
    sql += ' AND COALESCE(m.namespace, m.project_path) = ?'
    values.push(options.project_path)
  }
  if (options.type) {
    sql += ' AND m.type = ?'
    values.push(options.type)
  }
  if (options.as_of !== undefined) {
    sql += ` AND ${validityAtClause('m', '?')}`
    values.push(options.as_of, options.as_of)
  } else if (options.before !== undefined) {
    sql += ' AND m.valid_from <= ?'
    values.push(options.before)
  }
  if (!options.include_superseded) {
    if (options.as_of !== undefined) {
      sql += ` AND ${notSupersededAtClause('m.id', '?')}`
      values.push(options.as_of)
    } else {
      sql += ` AND ${notSupersededClause('m.id')}`
    }
  }
  sql += ' ORDER BY knn.distance'

  try {
    return (db.prepare(sql).all(...values) as MemoryRow[]).map(rowToMemory)
  } catch {
    return []
  }
}
