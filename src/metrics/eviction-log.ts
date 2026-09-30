import type Database from 'better-sqlite3'
import { computeTier, type Tier } from '../memory/enrichment.js'
import { logger } from '../utils/logger.js'

// eviction ledger (eviction_events, migration 024). retention and prune each decide
// per row, and this keeps that decision: which reason kept a row, which retired it,
// and which cold row was paged back in afterwards.
//
// faults share the table instead of a sibling column: a fault has the same shape as
// the decision that made the row cold (ts, namespace, memory_id, reason), and one
// table means one row cap and one age bound to enforce rather than two.

export type EvictionAction = 'archived' | 'pruned' | 'kept' | 'fault'
/** read = get_memory, search = search_memories, unarchive = the row came back */
export type FaultReason = 'read' | 'search' | 'unarchive'

export interface EvictionEventInput {
  ts: number
  namespace: string | null
  memoryId: string
  action: EvictionAction
  reason: string
  tier?: Tier | null
  jobId?: number | null
}

/** the columns the tier needs; a Memory and a raw memories row both satisfy it */
export interface FaultSubject {
  id: string
  namespace?: string | null
  project_path?: string | null
  importance: number
  access_count: number
  last_accessed: number | null
  created_at: number
  pinned?: boolean | number | null
}

export const EVICTION_DEFAULT_MAX_AGE_DAYS = 90
export const EVICTION_DEFAULT_MAX_ROWS = 100_000
/** one run cannot write more than this, so a scan limit cannot flood the table */
export const MAX_EVICTION_EVENTS_PER_RUN = 50_000
const DAY_MS = 24 * 60 * 60 * 1000

export function evictionMaxAgeDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.ENGRAM_EVICTION_MAX_AGE_DAYS ?? '', 10)
  if (!Number.isFinite(n) || n < 0) return EVICTION_DEFAULT_MAX_AGE_DAYS
  return n
}

export function evictionMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.ENGRAM_EVICTION_MAX_ROWS ?? '', 10)
  if (!Number.isFinite(n) || n < 1) return EVICTION_DEFAULT_MAX_ROWS
  return n
}

// telemetry must never break a maintenance pass: a pre-024 database or a locked
// write is swallowed after a debug log, as in retrieval-log.ts
export function recordEvictionEvents(
  db: Database.Database,
  events: EvictionEventInput[]
): number {
  if (events.length === 0) return 0
  const batch = events.slice(0, MAX_EVICTION_EVENTS_PER_RUN)
  if (batch.length < events.length) {
    logger.warn(
      { offered: events.length, capped: batch.length },
      'eviction log: per-run write cap reached; the tail is dropped'
    )
  }
  try {
    const insert = db.prepare(
      `INSERT INTO eviction_events (ts, namespace, memory_id, action, reason, tier, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const tx = db.transaction((rows: EvictionEventInput[]) => {
      for (const e of rows) {
        insert.run(e.ts, e.namespace, e.memoryId, e.action, e.reason, e.tier ?? null, e.jobId ?? null)
      }
    })
    tx(batch)
    return batch.length
  } catch (err) {
    logger.debug({ err, events: batch.length }, 'eviction log: writing events failed')
    return 0
  }
}

/** one fault per cold row served; rows that are not archived are ignored */
export function recordColdFaults(
  db: Database.Database,
  memories: Array<FaultSubject & { archived_at?: number | null }>,
  reason: FaultReason,
  now: number = Date.now()
): number {
  const cold = memories.filter((m) => m.archived_at != null)
  const written = recordEvictionEvents(
    db,
    cold.map((m) => ({
      ts: now,
      namespace: m.namespace ?? m.project_path ?? null,
      memoryId: m.id,
      action: 'fault' as const,
      reason,
      tier: faultTier(m, now),
      jobId: null,
    }))
  )
  // faults are written by reads, so this path cannot wait for the next maintenance
  // pass to hold the row cap: prune and retention may not run for a long time
  if (written > 0) enforceEvictionRowCap(db)
  return written
}

/** the row cap alone, so a path that writes events can hold it without the age bound */
export function enforceEvictionRowCap(
  db: Database.Database,
  maxRows: number = evictionMaxRows()
): number {
  try {
    // the first id past the newest maxRows; ids are insertion-ordered
    const firstToDrop = db
      .prepare('SELECT id FROM eviction_events ORDER BY id DESC LIMIT 1 OFFSET ?')
      .get(maxRows) as { id: number } | undefined
    if (!firstToDrop) return 0
    return db.prepare('DELETE FROM eviction_events WHERE id <= ?').run(firstToDrop.id).changes
  } catch (err) {
    logger.debug({ err }, 'eviction log: enforcing the row cap failed')
    return 0
  }
}

function faultTier(memory: FaultSubject, now: number): Tier {
  return computeTier(
    {
      importance: memory.importance,
      access_count: memory.access_count,
      last_accessed: memory.last_accessed,
      created_at: memory.created_at,
      pinned: memory.pinned ?? false,
    },
    now
  )
}

export interface PruneEvictionResult {
  deleted: number
  by_age: number
  by_rows: number
}

/** both bounds run in one call, so a maintenance pass cannot leave the table over either */
export function pruneEvictionEvents(
  db: Database.Database,
  opts: { now?: number; maxAgeDays?: number; maxRows?: number } = {},
  env: NodeJS.ProcessEnv = process.env
): PruneEvictionResult {
  const now = opts.now ?? Date.now()
  const maxAgeDays = opts.maxAgeDays ?? evictionMaxAgeDays(env)
  const maxRows = opts.maxRows ?? evictionMaxRows(env)
  const result: PruneEvictionResult = { deleted: 0, by_age: 0, by_rows: 0 }
  try {
    result.by_age = db
      .prepare('DELETE FROM eviction_events WHERE ts < ?')
      .run(now - maxAgeDays * DAY_MS).changes
    // the cap keeps the newest rows whatever their ts; the age bound removes backdated ones
    result.by_rows = enforceEvictionRowCap(db, maxRows)
    result.deleted = result.by_age + result.by_rows
    return result
  } catch (err) {
    logger.debug({ err }, 'eviction log: pruning events failed')
    return result
  }
}

export interface EvictionSummary {
  /** archived + pruned events in the window */
  archived: number
  kept: number
  faults: number
  /** faults / archived, null when nothing was archived in the window */
  fault_rate: number | null
  /** complete per action, so it reconciles with the counts above */
  by_action: Record<EvictionAction, number>
  /** top reasons only, so by_action totals can exceed the sum of this list */
  by_reason: Array<{ action: string; reason: string; count: number }>
}

const REASON_ROWS = 20

/** null on a pre-024 database, so get_stats reports the gap instead of failing */
export function summarizeEvictions(
  db: Database.Database,
  options: { namespace?: string; since?: number; until?: number } = {}
): EvictionSummary | null {
  const conditions: string[] = []
  const values: unknown[] = []
  if (options.namespace) {
    conditions.push('namespace = ?')
    values.push(options.namespace)
  }
  if (options.since !== undefined) {
    conditions.push('ts >= ?')
    values.push(options.since)
  }
  if (options.until !== undefined) {
    conditions.push('ts <= ?')
    values.push(options.until)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const actionRows = db
      .prepare(`SELECT action, COUNT(*) AS n FROM eviction_events ${where} GROUP BY action`)
      .all(...values) as Array<{ action: string; n: number }>
    const reasonRows = db
      .prepare(
        `SELECT action, reason, COUNT(*) AS n FROM eviction_events ${where}
         GROUP BY action, reason
         ORDER BY n DESC, reason ASC
         LIMIT ${REASON_ROWS}`
      )
      .all(...values) as Array<{ action: string; reason: string; n: number }>

    const by_action: Record<EvictionAction, number> = {
      archived: 0,
      pruned: 0,
      kept: 0,
      fault: 0,
    }
    for (const row of actionRows) {
      if (row.action in by_action) by_action[row.action as EvictionAction] = row.n
    }
    const archived = by_action.archived + by_action.pruned
    const faults = by_action.fault
    return {
      archived,
      kept: by_action.kept,
      faults,
      fault_rate: archived > 0 ? Math.round((faults / archived) * 10000) / 10000 : null,
      by_action,
      by_reason: reasonRows.map((row) => ({
        action: row.action,
        reason: row.reason,
        count: row.n,
      })),
    }
  } catch {
    return null
  }
}
