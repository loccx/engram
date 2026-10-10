import type Database from 'better-sqlite3'
import type { OutboxState } from './types.js'

/**
 * read-only operator view of the export bridge: counts and ages only. nothing here
 * claims delivery, visibility or absence, and no state is written.
 */
export interface BridgeStatus {
  readonly envelopes: { readonly total: number; readonly publish: number; readonly retract: number }
  readonly outbox: {
    readonly total: number
    readonly byState: Readonly<Record<OutboxState, number>>
    /** oldest export still queued or sending, by envelope creation time */
    readonly oldestUnfinishedAt: number | null
    readonly oldestUnfinishedAgeMs: number | null
    readonly lastError: { readonly envelopeId: string; readonly message: string } | null
  }
}

export const OUTBOX_STATES: readonly OutboxState[] = [
  'queued',
  'sending',
  'acknowledged',
  'visible',
  'retract_acknowledged',
  'retracted_verified',
  'reconciliation_required',
  'conflict',
  'rejected',
  'dead',
  'cancelled',
]

export function readBridgeStatus(db: Database.Database, now: number = Date.now()): BridgeStatus {
  const envelopeRows = db
    .prepare('SELECT operation, COUNT(*) AS count FROM bridge_envelopes GROUP BY operation')
    .all() as Array<{ operation: string; count: number }>
  const outboxRows = db
    .prepare('SELECT state, COUNT(*) AS count FROM bridge_outbox GROUP BY state')
    .all() as Array<{ state: string; count: number }>

  const byState = Object.fromEntries(OUTBOX_STATES.map((state) => [state, 0])) as Record<OutboxState, number>
  for (const row of outboxRows) {
    if (row.state in byState) byState[row.state as OutboxState] = row.count
  }

  const unfinished = db
    .prepare(
      `SELECT MIN(e.created_at) AS oldest FROM bridge_outbox o
       JOIN bridge_envelopes e ON e.envelope_id = o.envelope_id
       WHERE o.state IN ('queued', 'sending')`
    )
    .get() as { oldest: number | null }
  const lastError = db
    .prepare(
      `SELECT envelope_id, last_error FROM bridge_outbox
       WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1`
    )
    .get() as { envelope_id: string; last_error: string } | undefined

  const count = (operation: string) => envelopeRows.find((row) => row.operation === operation)?.count ?? 0
  const total = envelopeRows.reduce((sum, row) => sum + row.count, 0)

  return {
    envelopes: { total, publish: count('publish'), retract: count('retract') },
    outbox: {
      total: outboxRows.reduce((sum, row) => sum + row.count, 0),
      byState,
      oldestUnfinishedAt: unfinished.oldest,
      oldestUnfinishedAgeMs: unfinished.oldest === null ? null : Math.max(0, now - unfinished.oldest),
      lastError: lastError ? { envelopeId: lastError.envelope_id, message: lastError.last_error } : null,
    },
  }
}
