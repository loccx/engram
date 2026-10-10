import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migration026 } from '../src/db/migrations/026_bridge.js'
import { readBridgeStatus } from '../src/bridge/status.js'
import { formatAge, renderBridgeStatus } from '../src/cli/bridge.js'

function bridgeDb(): Database.Database {
  const db = new Database(':memory:')
  migration026.up(db)
  return db
}

let serial = 0
function seedEnvelope(db: Database.Database, operation: 'publish' | 'retract', createdAt: number): string {
  const id = `envelope-${++serial}`
  db.prepare(
    `INSERT INTO bridge_envelopes
       (envelope_id, schema_version, operation, payload_bytes, payload_sha256, idempotency_key, created_at)
     VALUES (?, 'bridge.payload/v1', ?, '{}', ?, ?, ?)`
  ).run(id, operation, 'a'.repeat(64), `key-${id}`, createdAt)
  return id
}

function seedOutbox(
  db: Database.Database,
  envelopeId: string,
  state: string,
  options: { attempt?: number; updatedAt?: number; lastError?: string | null } = {}
): void {
  db.prepare(
    `INSERT INTO bridge_outbox
       (envelope_id, state, attempt, max_attempts, next_attempt_at, last_error, updated_at)
     VALUES (?, ?, ?, 5, 0, ?, ?)`
  ).run(envelopeId, state, options.attempt ?? 0, options.lastError ?? null, options.updatedAt ?? 1000)
}

describe('bridge status', () => {
  it('reports an empty bridge without inventing work', () => {
    const status = readBridgeStatus(bridgeDb(), 5000)
    expect(status.envelopes).toEqual({ total: 0, publish: 0, retract: 0 })
    expect(status.outbox.total).toBe(0)
    expect(status.outbox.byState.queued).toBe(0)
    expect(status.outbox.oldestUnfinishedAt).toBeNull()
    expect(status.outbox.oldestUnfinishedAgeMs).toBeNull()
    expect(status.outbox.lastError).toBeNull()
  })

  it('counts envelopes by operation and outbox rows by state', () => {
    const db = bridgeDb()
    const publish = seedEnvelope(db, 'publish', 1000)
    const retract = seedEnvelope(db, 'retract', 1000)
    const terminal = seedEnvelope(db, 'publish', 1000)
    seedOutbox(db, publish, 'queued')
    seedOutbox(db, retract, 'dead', { attempt: 5, lastError: 'destination unavailable', updatedAt: 2000 })
    seedOutbox(db, terminal, 'visible', { updatedAt: 1500 })

    const status = readBridgeStatus(db, 60_000)
    expect(status.envelopes).toEqual({ total: 3, publish: 2, retract: 1 })
    expect(status.outbox.total).toBe(3)
    expect(status.outbox.byState.queued).toBe(1)
    expect(status.outbox.byState.dead).toBe(1)
    expect(status.outbox.byState.visible).toBe(1)
    expect(status.outbox.byState.sending).toBe(0)
  })

  it('ages only the unfinished exports and reports the most recent error', () => {
    const db = bridgeDb()
    const sending = seedEnvelope(db, 'publish', 500)
    const queued = seedEnvelope(db, 'publish', 900)
    const failed = seedEnvelope(db, 'publish', 100)
    seedOutbox(db, sending, 'sending')
    seedOutbox(db, queued, 'queued')
    seedOutbox(db, failed, 'dead', { attempt: 5, lastError: 'older error', updatedAt: 1000 })
    const failedAgain = seedEnvelope(db, 'publish', 200)
    seedOutbox(db, failedAgain, 'rejected', { lastError: 'newer error', updatedAt: 3000 })

    const status = readBridgeStatus(db, 10_500)
    expect(status.outbox.oldestUnfinishedAt).toBe(500)
    expect(status.outbox.oldestUnfinishedAgeMs).toBe(10_000)
    expect(status.outbox.lastError).toEqual({ envelopeId: failedAgain, message: 'newer error' })
  })

  it('renders counts, an empty outbox and a compact age', () => {
    const empty = renderBridgeStatus(readBridgeStatus(bridgeDb(), 1000))
    expect(empty).toContain('envelopes          0 (publish 0, retract 0)')
    expect(empty).toContain('outbox             empty')
    expect(empty).toContain('oldest unfinished  none')
    expect(empty).toContain('last error         none')

    const db = bridgeDb()
    const queued = seedEnvelope(db, 'publish', 0)
    seedOutbox(db, queued, 'queued')
    const rendered = renderBridgeStatus(readBridgeStatus(db, 90_000))
    expect(rendered).toContain('1 queued')
    expect(rendered).toContain('oldest unfinished  1m')

    expect(formatAge(null)).toBe('none')
    expect(formatAge(0)).toBe('0s')
    expect(formatAge(59_999)).toBe('59s')
    expect(formatAge(60_000)).toBe('1m')
    expect(formatAge(3_600_000)).toBe('1h')
    expect(formatAge(2 * 86_400_000)).toBe('2d')
  })
})
