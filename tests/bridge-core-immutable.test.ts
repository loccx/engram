import { afterEach, describe, expect, it } from 'vitest'
import { migration008 } from '../src/db/migrations/008_provenance_revisions.js'
import { migration026 } from '../src/db/migrations/026_bridge.js'
import { sealEnvelope } from '../src/bridge/index.js'
import { fixtureBridge, fixtureRequester, proposed, queued } from './fixtures/bridge-core-ports.js'

type Fixture = ReturnType<typeof fixtureBridge>
type Row = Record<string, string | number | null>
const opened: Fixture[] = []
const immutableTables = ['bridge_envelopes', 'bridge_approvals', 'bridge_approval_events', 'bridge_events'] as const
const sequenceTables = ['bridge_approval_events', 'bridge_events'] as const
const textKeyTables = ['bridge_envelopes', 'bridge_approvals'] as const
const identities = [
  ['bridge_envelopes', 'envelope_id'],
  ['bridge_envelopes', 'idempotency_key'],
  ['bridge_approvals', 'envelope_id'],
  ['bridge_approval_events', 'sequence'],
  ['bridge_events', 'sequence'],
] as const
const conflictForms = ['insert', 'replace', 'replace-alias', 'upsert-update', 'ignore', 'upsert-nothing'] as const
type ConflictForm = typeof conflictForms[number]

function setup(recursive: number): Fixture {
  const f = fixtureBridge(); opened.push(f)
  f.db.pragma(`recursive_triggers = ${recursive}`)
  expect(f.db.pragma('recursive_triggers', { simple: true })).toBe(recursive)
  // a synthetic canonical row and the actual source-audit migration stay separate from bridge history.
  f.db.exec(`
    CREATE TABLE memories (id TEXT PRIMARY KEY, session_id TEXT, content TEXT, valid_from INTEGER, created_at INTEGER);
    CREATE TABLE memory_links (source_id TEXT, target_id TEXT, PRIMARY KEY (source_id, target_id));
    INSERT INTO memories VALUES ('fixture-memory', 'fixture-session', 'curated inert content', 1000, 1000);
  `)
  migration008.up(f.db)
  return f
}
afterEach(() => { for (const f of opened.splice(0)) if (f.db.open) f.db.close() })

async function seeded(recursive: number): Promise<Fixture> {
  const f = setup(recursive)
  const first = await queued(f)
  await queued(f)
  f.coordinator.revokeApproval(first.envelope.envelopeId)
  return f
}
function storedBytes(f: Fixture): Buffer {
  const tables = [...immutableTables, 'bridge_outbox', 'sqlite_sequence', 'memories', 'memory_links', 'memory_events']
  return Buffer.from(JSON.stringify(tables.map((table) => [table, f.db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])), 'utf8')
}
function readHistory(f: Fixture) {
  const ids = f.db.prepare('SELECT envelope_id FROM bridge_envelopes ORDER BY envelope_id').all() as { envelope_id: string }[]
  return ids.map(({ envelope_id: id }) => ({ envelope: f.store.getEnvelope(id), approval: f.store.getApproval(id), events: f.store.events(id) }))
}
function refused(f: Fixture, write: () => unknown): void {
  const before = storedBytes(f), history = readHistory(f), source = JSON.stringify(f.source.snapshot), reads = f.source.reads
  expect(write).toThrow(/immutable bridge history/)
  expect(storedBytes(f).equals(before)).toBe(true)
  expect(readHistory(f)).toEqual(history)
  expect(JSON.stringify(f.source.snapshot)).toBe(source)
  expect(f.source.reads).toBe(reads)
  expect(f.destination.calls).toHaveLength(0)
  expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
}
function firstRow(f: Fixture, table: string): Row {
  return f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 1`).get() as Row
}
function changedRow(row: Row, table: string): Row {
  const changed: Row = { ...row, created_at: 9999 }
  if (table === 'bridge_envelopes') changed.payload_bytes = 'inert conflicting payload bytes'
  else if (table === 'bridge_approvals') changed.opaque_grant = 'inert conflicting fixture grant'
  else if (table === 'bridge_approval_events') changed.event_type = row.event_type === 'granted' ? 'revoked' : 'granted'
  else changed.detail_json = '{"inert":"conflicting audit"}'
  return changed
}
function freshEnvelopeRow(f: Fixture, id: string): Row {
  const row = firstRow(f, 'bridge_envelopes')
  const envelope = sealEnvelope({ ...JSON.parse(row.payload_bytes as string), envelopeId: id })
  return { ...row, envelope_id: id, payload_bytes: envelope.payloadBytes, payload_sha256: envelope.payloadSha256, idempotency_key: envelope.idempotencyKey }
}
function insertion(table: string, row: Row, key: string, form: ConflictForm): string {
  const columns = Object.keys(row)
  const verb = form === 'replace' ? 'INSERT OR REPLACE' : form === 'replace-alias' ? 'REPLACE' : form === 'ignore' ? 'INSERT OR IGNORE' : 'INSERT'
  const suffix = form === 'upsert-update' ? ` ON CONFLICT(${key}) DO UPDATE SET created_at = excluded.created_at`
    : form === 'upsert-nothing' ? ` ON CONFLICT(${key}) DO NOTHING` : ''
  return `${verb} INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})${suffix}`
}
function insertRow(f: Fixture, table: string, row: Row, key: string, form: ConflictForm): void {
  f.db.prepare(insertion(table, row, key, form)).run(...Object.values(row))
}
function eventRow(table: string, id: string, sequence?: number | null): Row {
  const row: Row = { envelope_id: id, event_type: table === 'bridge_approval_events' ? 'revoked' : 'fixture_append', created_at: 1000 }
  if (table === 'bridge_events') row.detail_json = '{"inert":"append"}'
  return sequence === undefined ? row : { sequence, ...row }
}

describe.each([0, 1])('bridge ordinary-DML immutable history (recursive_triggers=%s)', (recursive) => {
  it.each(identities.flatMap(([table, key]) => conflictForms.map((form) => [table, key, form] as const)))('rejects %s %s collision through %s without changing any stored bytes', async (table, key, form) => {
    const f = await seeded(recursive)
    const row = changedRow(firstRow(f, table), table)
    if (table === 'bridge_envelopes') {
      if (key === 'idempotency_key') row.envelope_id = 'fixture-new-envelope-id'
      else row.idempotency_key = 'fixture-new-idempotency-key'
    }
    refused(f, () => insertRow(f, table, row, key, form))
  })

  it('rejects REPLACE when two envelope unique keys would delete two different originals', async () => {
    const f = await seeded(recursive)
    const rows = f.db.prepare('SELECT * FROM bridge_envelopes ORDER BY rowid').all() as Row[]
    const row = { ...changedRow(rows[0], 'bridge_envelopes'), idempotency_key: rows[1].idempotency_key }
    refused(f, () => insertRow(f, 'bridge_envelopes', row, 'envelope_id', 'replace'))
  })

  it.each(textKeyTables.flatMap((table) => ['rowid', 'oid', '_rowid_'].flatMap((alias) => conflictForms.map((form) => [table, alias, form] as const))))('rejects %s hidden %s identity collision through %s with new declared identities', async (table, alias, form) => {
    const f = await seeded(recursive)
    const original = f.db.prepare(`SELECT rowid AS fixture_rowid FROM ${table} ORDER BY rowid LIMIT 1`).get() as { fixture_rowid: number }
    const row = changedRow(firstRow(f, table), table)
    if (table === 'bridge_envelopes') {
      row.envelope_id = 'fixture-new-envelope-id'
      row.idempotency_key = 'fixture-new-idempotency-key'
    } else {
      const e = await proposed(f)
      row.envelope_id = e.envelopeId
    }
    refused(f, () => insertRow(f, table, { [alias]: original.fixture_rowid, ...row }, alias, form))
  })

  it.each(immutableTables.flatMap((table) => ['UPDATE', 'DELETE'].map((operation) => [table, operation] as const)))('still rejects %s %s with unchanged complete rows', async (table, operation) => {
    const f = await seeded(recursive)
    refused(f, () => f.db.exec(operation === 'DELETE' ? `DELETE FROM ${table}` : `UPDATE ${table} SET created_at = created_at + 1`))
  })

  it.each(sequenceTables)('allows %s omitted/NULL allocation and explicit positive/negative/zero sequence appends', async (table) => {
    const f = await seeded(recursive)
    const id = firstRow(f, 'bridge_envelopes').envelope_id as string
    const originals = f.db.prepare(`SELECT * FROM ${table} ORDER BY sequence`).all() as Row[]
    let maximum = Math.max(...originals.map((row) => row.sequence as number))
    for (const sequence of [undefined, null, 100, -2, 0, undefined, null]) {
      const result = f.db.prepare(insertion(table, eventRow(table, id, sequence), 'sequence', 'insert')).run(...Object.values(eventRow(table, id, sequence)))
      const expected = sequence == null ? maximum + 1 : sequence
      expect(result.lastInsertRowid).toBe(expected)
      maximum = Math.max(maximum, expected)
      expect(f.db.prepare(`SELECT * FROM ${table} WHERE sequence = ?`).get(expected)).toEqual({ sequence: expected, ...eventRow(table, id) })
    }
    for (const row of originals) expect(f.db.prepare(`SELECT * FROM ${table} WHERE sequence = ?`).get(row.sequence)).toEqual(row)
    expect(f.db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)).toEqual({ seq: maximum })
    for (const sequence of [-2, 0, 100]) {
      for (const form of conflictForms) refused(f, () => insertRow(f, table, eventRow(table, id, sequence), 'sequence', form))
    }
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it.each(textKeyTables)('allows %s omitted/NULL and explicit positive/negative/zero rowid allocation', async (table) => {
    const f = await seeded(recursive)
    const originals = f.db.prepare(`SELECT rowid AS fixture_rowid, * FROM ${table} ORDER BY rowid`).all() as Row[]
    let maximum = Math.max(...originals.map((row) => row.fixture_rowid as number))
    for (const rowid of [undefined, null, 100, -2, 0, undefined, null]) {
      const row = table === 'bridge_envelopes' ? freshEnvelopeRow(f, `fixture-envelope-rowid-${rowid}-${maximum}`) : firstRow(f, table)
      if (table === 'bridge_approvals') row.envelope_id = (await proposed(f)).envelopeId
      const explicit = rowid === undefined ? row : { rowid, ...row }
      const result = f.db.prepare(insertion(table, explicit, 'rowid', 'insert')).run(...Object.values(explicit))
      const expected = rowid == null ? maximum + 1 : rowid
      expect(result.lastInsertRowid).toBe(expected)
      maximum = Math.max(maximum, expected)
    }
    for (const { fixture_rowid, ...row } of originals) expect(f.db.prepare(`SELECT * FROM ${table} WHERE rowid = ?`).get(fixture_rowid)).toEqual(row)
    for (const rowid of [-2, 0, 100]) {
      const row = firstRow(f, table)
      if (table === 'bridge_envelopes') { row.envelope_id = 'fixture-new-envelope-id'; row.idempotency_key = 'fixture-new-key' }
      else row.envelope_id = (await proposed(f)).envelopeId
      for (const form of conflictForms) refused(f, () => insertRow(f, table, { rowid, ...row }, 'rowid', form))
    }
  })

  it.each(immutableTables)('reserves actual %s rowid=-1 without blocking ordinary allocation', async (table) => {
    const f = await seeded(recursive)
    const row = changedRow(firstRow(f, table), table)
    const key = table === 'bridge_envelopes' || table === 'bridge_approvals' ? 'rowid' : 'sequence'
    if (table === 'bridge_envelopes') { row.envelope_id = 'fixture-negative-id'; row.idempotency_key = 'fixture-negative-key' }
    else if (table === 'bridge_approvals') row.envelope_id = (await proposed(f)).envelopeId
    for (const form of conflictForms) refused(f, () => insertRow(f, table, { ...row, [key]: -1 }, key, form))
    await queued(f)
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it.each(immutableTables)('rolls back %s REPLACE of an artificial preexisting rowid=-1 and still allows implicit append', async (table) => {
    const f = await seeded(recursive)
    const key = table === 'bridge_envelopes' || table === 'bridge_approvals' ? 'rowid' : 'sequence'
    const row = table === 'bridge_envelopes' ? freshEnvelopeRow(f, 'fixture-preexisting-negative-id') : firstRow(f, table)
    if (table === 'bridge_approvals') row.envelope_id = (await proposed(f)).envelopeId
    // trusted ddl only constructs an otherwise unreachable preexisting sentinel row.
    f.db.exec(`DROP TRIGGER IF EXISTS ${table}_immutable_rowid`)
    insertRow(f, table, { ...row, [key]: -1 }, key, 'insert')
    migration026.up(f.db)
    const replacement = changedRow(row, table)
    if (table === 'bridge_envelopes') { replacement.envelope_id = 'fixture-replacement-negative-id'; replacement.idempotency_key = 'fixture-replacement-negative-key' }
    else if (table === 'bridge_approvals') replacement.envelope_id = (await proposed(f)).envelopeId
    const before = storedBytes(f)
    expect(() => insertRow(f, table, { ...replacement, [key]: -1 }, key, 'replace')).toThrow(/immutable bridge history/)
    expect(storedBytes(f).equals(before)).toBe(true)
    const sentinel = f.db.prepare(`SELECT * FROM ${table} WHERE rowid = -1`).get()
    await queued(f)
    expect(f.db.prepare(`SELECT * FROM ${table} WHERE rowid = -1`).get()).toEqual(sentinel)
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it.each(sequenceTables)('ABORT rolls back the entire multi-row %s REPLACE and sqlite_sequence allocation', async (table) => {
    const f = await seeded(recursive)
    const original = firstRow(f, table)
    const columns = Object.keys(original)
    const fresh = { ...original, sequence: 500 }
    const conflict = changedRow(original, table)
    const placeholders = `(${columns.map(() => '?').join(', ')})`
    refused(f, () => f.db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}, ${placeholders}`)
      .run(...Object.values(fresh), ...Object.values(conflict)))
  })

  it('repeated migration up preserves every guard and does not change connection pragmas or existing history', async () => {
    const f = await seeded(recursive)
    const before = storedBytes(f)
    const triggers = () => f.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'bridge_%' ORDER BY name").all()
    const initial = triggers()
    expect(initial).toHaveLength(16)
    migration026.up(f.db); migration026.up(f.db)
    expect(triggers()).toEqual(initial)
    expect(storedBytes(f).equals(before)).toBe(true)
    expect(f.db.pragma('recursive_triggers', { simple: true })).toBe(recursive)
    expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1)
    for (const [table, key] of identities) refused(f, () => insertRow(f, table, changedRow(firstRow(f, table), table), key, 'replace'))
  })

  it('preserves simple-API approval/queue/revocation idempotency and fenced mutable outbox claims', async () => {
    const f = setup(recursive)
    const { envelope, grant } = await queued(f)
    const before = storedBytes(f), approval = f.store.getApproval(envelope.envelopeId)
    refused(f, () => f.store.insertProposal(envelope))
    await f.coordinator.approve(envelope.envelopeId, grant)
    const queue = f.coordinator.enqueue(envelope.envelopeId)
    expect(f.coordinator.enqueue(envelope.envelopeId)).toEqual(queue)
    expect(storedBytes(f).equals(before)).toBe(true)
    const claim = f.store.claim('fixture-owner', 1000, f.destination.adapterId, fixtureRequester.principalId)!
    expect(claim).toMatchObject({ state: 'sending', attempt: 1, leaseGeneration: 1 })
    expect(f.store.owns(claim)).toBe(true)
    f.store.markDeliveryStarted(claim)
    f.store.complete(claim, 'queued', 'inert retry', null, f.clock.time + 10)
    expect(f.store.getOutbox(envelope.envelopeId)).toMatchObject({ state: 'queued', attempt: 1, lastError: 'inert retry' })
    f.clock.time += 10
    const second = f.store.claim('fixture-second-owner', 1000, f.destination.adapterId, fixtureRequester.principalId)!
    expect(second).toMatchObject({ state: 'sending', attempt: 2, leaseGeneration: 2 })
    f.store.complete(second, 'reconciliation_required')
    f.coordinator.revokeApproval(envelope.envelopeId)
    const revoked = storedBytes(f)
    f.coordinator.revokeApproval(envelope.envelopeId)
    expect(storedBytes(f).equals(revoked)).toBe(true)
    expect(f.store.getEnvelope(envelope.envelopeId)).toEqual(envelope)
    expect(f.store.getApproval(envelope.envelopeId)).toEqual({ ...approval, revoked: true })
    expect(f.store.events(envelope.envelopeId).map((event) => event.type)).toEqual([
      'proposed', 'approved', 'queued', 'sending', 'delivery_started', 'queued', 'sending', 'reconciliation_required', 'approval_revoked',
    ])
    expect(f.destination.calls).toHaveLength(0)
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
