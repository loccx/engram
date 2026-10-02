import type Database from 'better-sqlite3'
import type { Memory, MemoryCluster, SearchResult } from './types.js'
import { SUPERSEDES_FILTER_THRESHOLD } from '../contradictions/supersession.js'
import { namespaceFilter, type NamespaceFilterOptions } from './search/scope.js'

/** edge counts remain present-state metadata, restricted to readable query endpoints */
export type EnrichmentScope = NamespaceFilterOptions

function edgeReadFilter(options: EnrichmentScope): { sql: string; params: unknown[] } {
  const source = namespaceFilter('edge_source', options)
  const target = namespaceFilter('edge_target', options)
  return {
    sql: `${source.sql} AND ${target.sql}`,
    params: [...source.params, ...target.params],
  }
}

export type Tier = 'pinned' | 'hot' | 'warm' | 'cold'
export type RecallSignal = 'fts' | 'vec' | 'recency' | 'access' | 'importance' | 'reranker'

export interface SupersedesCounts {
  supersedes: number
  superseded_by: number
}

export interface EnrichedMemory extends Memory {
  namespace: string
  tier: Tier
  supersedes_counts: SupersedesCounts
  pinned: boolean
  /** a non-hiding `conflicts` link exists; both sides stay readable */
  disputed: boolean
  conflict_count: number
}

export interface EnrichedSearchResult extends EnrichedMemory {
  score: number
  recall_reason?: RecallSignal
  signal_breakdown?: Record<RecallSignal, number>
}

export const TIER_HOT_THRESHOLD = 0.7
export const TIER_WARM_THRESHOLD = 0.3

export const CONTEXT_CONTENT_MAX_CHARS = 400

/** blanket get_context has no query to rank by, so it bounds size structurally */
export function truncateContent<T extends { content: string }>(
  items: T[],
  maxChars: number = CONTEXT_CONTENT_MAX_CHARS
): T[] {
  return items.map((item) =>
    item.content.length > maxChars
      ? { ...item, content: `${item.content.slice(0, maxChars)}…` }
      : item
  )
}

export const TOPIC_MEMBER_SAMPLE_SIZE = 5

/**
 * a cluster's member_ids can hold nearly every memory in a project, and a
 * get_context caller wants a topic label rather than a membership index, so the
 * sample is capped and the true size reported separately.
 */
export function summarizeClusters(
  clusters: MemoryCluster[]
): Array<Omit<MemoryCluster, 'member_ids'> & { member_ids: string[]; member_count: number }> {
  return clusters.map(({ member_ids, ...rest }) => ({
    ...rest,
    member_ids: member_ids.slice(0, TOPIC_MEMBER_SAMPLE_SIZE),
    member_count: member_ids.length,
  }))
}

/**
 * composite trust score in [0,1] for tiering: the default semantic weights, with
 * importance first, access second and recency last. pinned memories bypass it.
 */
export function compositeScore(
  memory: Pick<Memory, 'importance' | 'access_count' | 'last_accessed' | 'created_at'>,
  now: number = Date.now()
): number {
  const importance = memory.importance
  const accessNorm = Math.min(Math.log(memory.access_count + 1) / Math.log(100), 1.0)
  const ageMs = now - (memory.last_accessed ?? memory.created_at)
  const ageDays = ageMs / (24 * 60 * 60 * 1000)
  const stability = 30 * Math.max(importance + 0.3 * Math.log(memory.access_count + 1), 0.1)
  const recency = Math.exp(-ageDays / stability)
  return 0.5 * importance + 0.3 * accessNorm + 0.2 * recency
}

export function computeTier(
  memory: Pick<Memory, 'importance' | 'access_count' | 'last_accessed' | 'created_at'> & {
    pinned?: boolean | number
  },
  now: number = Date.now()
): Tier {
  if (memory.pinned) return 'pinned'
  const score = compositeScore(memory, now)
  if (score >= TIER_HOT_THRESHOLD) return 'hot'
  if (score >= TIER_WARM_THRESHOLD) return 'warm'
  return 'cold'
}

interface SupersedesRow {
  memory_id: string
  supersedes: number
  superseded_by: number
}

export function fetchSupersedesCounts(
  db: Database.Database,
  memoryIds: string[],
  options: EnrichmentScope = {}
): Map<string, SupersedesCounts> {
  const result = new Map<string, SupersedesCounts>()
  if (memoryIds.length === 0) return result
  const scope = edgeReadFilter(options)

  const rows = db
    .prepare(
      `WITH ids(id) AS (VALUES ${memoryIds.map(() => '(?)').join(',')})
       SELECT
         ids.id AS memory_id,
         (SELECT COUNT(*) FROM memory_links sl
          JOIN memories edge_source ON edge_source.id = sl.source_id
          JOIN memories edge_target ON edge_target.id = sl.target_id
          WHERE sl.source_id = ids.id
            AND sl.link_type = 'supersedes'
            AND sl.confidence >= ? AND ${scope.sql}) AS supersedes,
         (SELECT COUNT(*) FROM memory_links sl
          JOIN memories edge_source ON edge_source.id = sl.source_id
          JOIN memories edge_target ON edge_target.id = sl.target_id
          WHERE sl.target_id = ids.id
            AND sl.link_type = 'supersedes'
            AND sl.confidence >= ? AND ${scope.sql}) AS superseded_by
       FROM ids`
    )
    .all(...memoryIds, SUPERSEDES_FILTER_THRESHOLD, ...scope.params, SUPERSEDES_FILTER_THRESHOLD, ...scope.params) as SupersedesRow[]

  for (const row of rows) {
    result.set(row.memory_id, {
      supersedes: Number(row.supersedes),
      superseded_by: Number(row.superseded_by),
    })
  }
  return result
}

interface ConflictRow {
  memory_id: string
  conflicts: number
}

// kept out of fetchSupersedesCounts so that struct's shape stays unchanged
export function fetchConflictCounts(
  db: Database.Database,
  memoryIds: string[],
  options: EnrichmentScope = {}
): Map<string, number> {
  const result = new Map<string, number>()
  if (memoryIds.length === 0) return result
  const scope = edgeReadFilter(options)
  const rows = db
    .prepare(
      `WITH ids(id) AS (VALUES ${memoryIds.map(() => '(?)').join(',')})
       SELECT ids.id AS memory_id,
         (SELECT COUNT(*) FROM memory_links cl
          JOIN memories edge_source ON edge_source.id = cl.source_id
          JOIN memories edge_target ON edge_target.id = cl.target_id
          WHERE cl.link_type = 'conflicts'
            AND (cl.source_id = ids.id OR cl.target_id = ids.id)
            AND ${scope.sql}) AS conflicts
       FROM ids`
    )
    .all(...memoryIds, ...scope.params) as ConflictRow[]
  for (const row of rows) result.set(row.memory_id, Number(row.conflicts))
  return result
}

interface PinnedRow {
  id: string
  pinned: number
  namespace: string | null
  project_path: string
}

export function fetchEnrichmentColumns(
  db: Database.Database,
  memoryIds: string[]
): Map<string, { pinned: boolean; namespace: string }> {
  const result = new Map<string, { pinned: boolean; namespace: string }>()
  if (memoryIds.length === 0) return result

  const placeholders = memoryIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT id, pinned, namespace, project_path FROM memories WHERE id IN (${placeholders})`
    )
    .all(...memoryIds) as PinnedRow[]

  for (const row of rows) {
    result.set(row.id, {
      pinned: row.pinned === 1,
      namespace: row.namespace ?? row.project_path,
    })
  }
  return result
}

export function enrichMemories(
  db: Database.Database,
  memories: Memory[],
  now: number = Date.now(),
  options: EnrichmentScope = {}
): EnrichedMemory[] {
  const ids = memories.map((m) => m.id)
  const counts = fetchSupersedesCounts(db, ids, options)
  const conflicts = fetchConflictCounts(db, ids, options)
  const cols = fetchEnrichmentColumns(db, ids)

  return memories.map((m) => {
    const col = cols.get(m.id)
    const pinned = col?.pinned ?? false
    const conflictCount = conflicts.get(m.id) ?? 0
    return {
      ...m,
      namespace: col?.namespace ?? m.project_path,
      pinned,
      tier: computeTier({ ...m, pinned }, now),
      supersedes_counts: counts.get(m.id) ?? { supersedes: 0, superseded_by: 0 },
      disputed: conflictCount > 0,
      conflict_count: conflictCount,
    }
  })
}

export function enrichSearchResults(
  db: Database.Database,
  results: SearchResult[],
  signalBreakdown: Map<string, Record<RecallSignal, number>>,
  now: number = Date.now(),
  options: EnrichmentScope = {}
): EnrichedSearchResult[] {
  const baseMemories: Memory[] = results.map((r) => {
    const { score: _score, ...rest } = r
    void _score
    return rest as Memory
  })
  const enriched = enrichMemories(db, baseMemories, now, options)

  return enriched.map((mem, i) => {
    const breakdown = signalBreakdown.get(mem.id)
    const recallReason = breakdown
      ? (Object.entries(breakdown).reduce((a, b) => (b[1] > a[1] ? b : a))[0] as RecallSignal)
      : undefined
    return {
      ...mem,
      score: results[i].score,
      ...(breakdown ? { signal_breakdown: breakdown, recall_reason: recallReason } : {}),
    }
  })
}
