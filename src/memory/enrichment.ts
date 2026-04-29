import type Database from 'better-sqlite3'
import type { Memory, SearchResult } from './types.js'
import { SUPERSEDES_FILTER_THRESHOLD } from '../contradictions/supersession.js'

export type Tier = 'pinned' | 'hot' | 'warm' | 'cold'
export type RecallSignal = 'fts' | 'vec' | 'recency' | 'access' | 'importance'

export interface SupersedesCounts {
  supersedes: number
  superseded_by: number
}

export interface EnrichedMemory extends Memory {
  namespace: string
  tier: Tier
  supersedes_counts: SupersedesCounts
  pinned: boolean
}

export interface EnrichedSearchResult extends EnrichedMemory {
  score: number
  recall_reason?: RecallSignal
  signal_breakdown?: Record<RecallSignal, number>
}

export const TIER_HOT_THRESHOLD = 0.7
export const TIER_WARM_THRESHOLD = 0.3

/**
 * Composite trust score in [0,1] used to bucket memories into tiers.
 * Weights mirror the default semantic weight profile: importance dominates,
 * access frequency matters second, recency last. Pinned memories bypass this.
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
  memoryIds: string[]
): Map<string, SupersedesCounts> {
  const result = new Map<string, SupersedesCounts>()
  if (memoryIds.length === 0) return result

  const rows = db
    .prepare(
      `WITH ids(id) AS (VALUES ${memoryIds.map(() => '(?)').join(',')})
       SELECT
         ids.id AS memory_id,
         (SELECT COUNT(*) FROM memory_links sl
          WHERE sl.source_id = ids.id
            AND sl.link_type = 'supersedes'
            AND sl.confidence >= ?) AS supersedes,
         (SELECT COUNT(*) FROM memory_links sl
          WHERE sl.target_id = ids.id
            AND sl.link_type = 'supersedes'
            AND sl.confidence >= ?) AS superseded_by
       FROM ids`
    )
    .all(...memoryIds, SUPERSEDES_FILTER_THRESHOLD, SUPERSEDES_FILTER_THRESHOLD) as SupersedesRow[]

  for (const row of rows) {
    result.set(row.memory_id, {
      supersedes: Number(row.supersedes),
      superseded_by: Number(row.superseded_by),
    })
  }
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
  now: number = Date.now()
): EnrichedMemory[] {
  const ids = memories.map((m) => m.id)
  const counts = fetchSupersedesCounts(db, ids)
  const cols = fetchEnrichmentColumns(db, ids)

  return memories.map((m) => {
    const col = cols.get(m.id)
    const pinned = col?.pinned ?? false
    return {
      ...m,
      namespace: col?.namespace ?? m.project_path,
      pinned,
      tier: computeTier({ ...m, pinned }, now),
      supersedes_counts: counts.get(m.id) ?? { supersedes: 0, superseded_by: 0 },
    }
  })
}

export function enrichSearchResults(
  db: Database.Database,
  results: SearchResult[],
  signalBreakdown: Map<string, Record<RecallSignal, number>>,
  now: number = Date.now()
): EnrichedSearchResult[] {
  const baseMemories: Memory[] = results.map((r) => {
    const { score: _score, ...rest } = r
    void _score
    return rest as Memory
  })
  const enriched = enrichMemories(db, baseMemories, now)

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
