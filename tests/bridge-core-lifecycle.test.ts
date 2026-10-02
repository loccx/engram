import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { BridgeCoordinator, BridgeStore } from '../src/bridge/index.js'
import { migration026 } from '../src/db/migrations/026_bridge.js'
import { exerciseBridgePath, fixtureBridge, fixtureDestination, fixtureLocator, fixtureRequester, fixtureSnapshot, proposed, queued } from './fixtures/bridge-core-ports.js'

const opened: ReturnType<typeof fixtureBridge>[] = []
function setup() { const f = fixtureBridge(); opened.push(f); return f }
afterEach(() => { for (const f of opened.splice(0)) if (f.db.open) f.db.close() })

async function published(f: ReturnType<typeof fixtureBridge>) {
  const { envelope } = await queued(f)
  await f.coordinator.drain(f.destination, { owner: 'fixture-owner' })
  return envelope
}
async function retractQueued(f: ReturnType<typeof fixtureBridge>, targetEnvelopeId: string) {
  const e = f.coordinator.proposeRetraction({ targetEnvelopeId, reason: 'inert cleanup', purpose: 'cleanup', policyId: 'fixture-policy', policyVersion: 'v1' })
  await f.coordinator.approve(e.envelopeId, f.authority.issue(e))
  f.coordinator.enqueue(e.envelopeId)
  return e
}

describe('bridge lifecycle and adapter conformance', () => {
  it('exercises proposal -> verified grant -> queue -> ack -> reader -> exact retract -> absence through real core', async () => {
    const f = setup()
    const sourceBefore = JSON.stringify(f.source.snapshot)
    const result = await exerciseBridgePath(f, f.destination)
    expect(result.visibility.status).toBe('visible')
    expect(result.absence.status).toBe('absent')
    expect(f.store.getOutbox(result.envelope.envelopeId)?.state).toBe('visible')
    expect(f.store.getOutbox(result.retraction.envelopeId)?.state).toBe('retracted_verified')
    expect(f.store.events(result.envelope.envelopeId).map((v) => v.type)).toEqual(['proposed', 'approved', 'queued', 'sending', 'delivery_started', 'acknowledged', 'visible'])
    expect(f.store.events(result.retraction.envelopeId).map((v) => v.type)).toEqual(['proposed', 'approved', 'retract_queued', 'sending', 'delivery_started', 'retract_acknowledged', 'retracted_verified'])
    expect(JSON.stringify(f.source.snapshot)).toBe(sourceBefore)
    expect(f.destination.calls.map((c) => c.operation)).toEqual(['publish', 'retract'])
    expect(result.envelope.idempotencyKey).not.toBe(result.retraction.idempotencyKey)
  })
  it('separates proposal, approval, queue, acknowledgment and reader observations', async () => {
    const f = setup()
    const e = await proposed(f)
    expect(f.store.getOutbox(e.envelopeId)).toBeNull()
    expect(f.destination.calls).toHaveLength(0)
    await f.coordinator.approve(e.envelopeId, f.authority.issue(e))
    expect(f.store.getOutbox(e.envelopeId)).toBeNull()
    expect(f.destination.calls).toHaveLength(0)
    const q = f.coordinator.enqueue(e.envelopeId)
    expect(f.coordinator.enqueue(e.envelopeId)).toEqual(q)
    await expect(f.coordinator.verifyVisibility(e.envelopeId, f.destination)).rejects.toThrow(/readable/)
    await f.coordinator.drain(f.destination, { owner: 'owner' })
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe('acknowledged')
    const eventCount = f.store.events(e.envelopeId).length
    f.store.getEnvelope(e.envelopeId); f.store.getApproval(e.envelopeId); f.store.getPublication(e.envelopeId); f.store.getOutbox(e.envelopeId)
    expect(f.store.events(e.envelopeId)).toHaveLength(eventCount)
    expect((await f.coordinator.drain(f.destination, { owner: 'owner' })).claimed).toBe(0)
    expect(f.destination.calls).toHaveLength(1)
  })
  it.each(['empty', 'forbidden', 'degraded', 'pending', 'unsupported'] as const)('does not promote %s visibility to visible', async (status) => {
    const f = setup()
    const e = await published(f)
    f.destination.visibilityStatus = status
    expect((await f.coordinator.verifyVisibility(e.envelopeId, f.destination)).status).toBe(status)
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe(status === 'unsupported' ? 'reconciliation_required' : 'acknowledged')
  })
  it.each(['hash', 'scope', 'reader', 'version', 'publicationId'] as const)('rejects wrong %s reader proof', async (field) => {
    const f = setup()
    const e = await published(f)
    f.destination.observation = (p) => field === 'scope' || field === 'reader' ? { ...p, destination: { ...p.destination, [field]: 'wrong' } }
      : { ...p, [field === 'hash' ? 'payloadSha256' : field]: 'wrong' }
    expect((await f.coordinator.verifyVisibility(e.envelopeId, f.destination)).status).toBe('conflict')
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe('reconciliation_required')
  })
  it('does not keep a success state when a subsequent reader observes empty', async () => {
    const f = setup()
    const e = await published(f)
    await f.coordinator.verifyVisibility(e.envelopeId, f.destination)
    f.destination.visibilityStatus = 'empty'
    await f.coordinator.verifyVisibility(e.envelopeId, f.destination)
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe('reconciliation_required')
  })
  it('never accepts a manual visibility proof or a delivery completion as reader proof', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    const claim = f.store.claim('owner', 1000, f.destination.adapterId, fixtureRequester.principalId)!
    expect(() => f.store.complete(claim, 'visible' as never)).toThrow(/transition/)
    expect(() => f.store.complete(claim, 'retracted_verified' as never)).toThrow(/transition/)
    const fake = { adapterId: f.destination.adapterId, capabilities: async () => ({ readVisibility: false }) }
    await expect(f.coordinator.verifyVisibility(envelope.envelopeId, fake as never)).rejects.toThrow(/readable/)
  })
  it('requires an exact acknowledged publication and a separately verified retraction grant', async () => {
    const f = setup()
    const { envelope, grant } = await queued(f)
    const input = { targetEnvelopeId: envelope.envelopeId, reason: 'cleanup', purpose: 'cleanup', policyId: 'fixture-policy', policyVersion: 'v1' }
    expect(() => f.coordinator.proposeRetraction(input)).toThrow(/acknowledgement/)
    await f.coordinator.drain(f.destination, { owner: 'owner' })
    const r = f.coordinator.proposeRetraction(input)
    expect(r.destination).toEqual(envelope.destination)
    await expect(f.coordinator.approve(r.envelopeId, grant)).rejects.toThrow(/denied/)
    expect(() => f.coordinator.enqueue(r.envelopeId)).toThrow(/approval/)
    expect(() => f.coordinator.proposeRetraction(input)).toThrow(/already/)
    await expect(f.coordinator.verifyRetraction(r.envelopeId, f.destination)).rejects.toThrow(/acknowledged/)
  })
  it.each(['present', 'forbidden', 'degraded', 'pending', 'unsupported'] as const)('does not promote %s cleanup proof to verified retraction', async (status) => {
    const f = setup()
    const e = await published(f)
    const r = await retractQueued(f, e.envelopeId)
    await f.coordinator.drain(f.destination, { owner: 'owner' })
    f.destination.absenceStatus = status
    expect((await f.coordinator.verifyRetraction(r.envelopeId, f.destination)).status).toBe(status)
    expect(f.store.getOutbox(r.envelopeId)?.state).toBe(status === 'unsupported' ? 'reconciliation_required' : 'retract_acknowledged')
  })
  it.each(['hash', 'scope', 'reader', 'version'] as const)('rejects absence proof for a different remote %s', async (field) => {
    const f = setup()
    const e = await published(f)
    const r = await retractQueued(f, e.envelopeId)
    await f.coordinator.drain(f.destination, { owner: 'owner' })
    f.destination.observation = (p) => field === 'hash' ? { ...p, payloadSha256: 'wrong' }
      : field === 'version' ? { ...p, version: 'newest-not-target' } : { ...p, destination: { ...p.destination, [field]: 'wrong' } }
    expect((await f.coordinator.verifyRetraction(r.envelopeId, f.destination)).status).toBe('conflict')
    expect(f.store.getOutbox(r.envelopeId)?.state).toBe('reconciliation_required')
  })
  it('retracts an exact old publication without mutating newer source or remote revision', async () => {
    const f = setup()
    const old = await published(f)
    f.source.snapshot = fixtureSnapshot('opaque-revision-two', 'corrected inert source')
    const newer = await f.coordinator.proposePublish({ source: fixtureLocator, destination: fixtureDestination, purpose: 'fixture-purpose',
      policyId: 'fixture-policy', policyVersion: 'v1', supersedesEnvelopeId: old.envelopeId })
    await f.coordinator.approve(newer.envelopeId, f.authority.issue(newer))
    f.coordinator.enqueue(newer.envelopeId)
    await f.coordinator.drain(f.destination, { owner: 'owner' })
    const r = await retractQueued(f, old.envelopeId)
    const sourceBefore = f.source.snapshot
    await f.coordinator.drain(f.destination, { owner: 'owner' })
    await f.coordinator.verifyRetraction(r.envelopeId, f.destination)
    expect(f.destination.remote.has(f.destination.remoteKey(f.store.getPublication(old.envelopeId)!))).toBe(false)
    expect(f.destination.remote.has(f.destination.remoteKey(f.store.getPublication(newer.envelopeId)!))).toBe(true)
    expect(f.source.snapshot).toBe(sourceBefore)
    expect(f.store.getEnvelope(old.envelopeId)).toEqual(old)
    expect(f.store.events(newer.envelopeId).some((v) => v.type === 'supersedes')).toBe(true)
  })
  it('can clean up an acknowledged publication after source deletion without source reads', async () => {
    const f = setup()
    const e = await published(f)
    const reads = f.source.reads
    f.source.status = 'not_found'
    const r = await retractQueued(f, e.envelopeId)
    const cleanup = new BridgeCoordinator({ store: f.store, requester: fixtureRequester, verifier: f.authority })
    await cleanup.drain(f.destination, { owner: 'cleanup' })
    expect((await cleanup.verifyRetraction(r.envelopeId, f.destination)).status).toBe('absent')
    expect(f.source.reads).toBe(reads)
  })
})

describe('bridge immutable migration and production isolation', () => {
  it('migration is idempotent, append-only and never cascades from canonical sources', async () => {
    const f = setup()
    migration026.up(f.db)
    const e = await published(f)
    f.db.exec("CREATE TABLE memories(id TEXT PRIMARY KEY); INSERT INTO memories VALUES ('fixture-memory'); DELETE FROM memories;")
    expect(f.store.getEnvelope(e.envelopeId)).toEqual(e)
    for (const table of ['bridge_envelopes', 'bridge_approvals', 'bridge_approval_events', 'bridge_events']) {
      expect(() => f.db.exec(`DELETE FROM ${table}`)).toThrow(/immutable/)
      const column = table === 'bridge_envelopes' ? 'payload_bytes' : table === 'bridge_approvals' ? 'approval_json' : 'created_at'
      expect(() => f.db.exec(`UPDATE ${table} SET ${column} = ${column}`)).toThrow(/immutable/)
      const refs = f.db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; on_delete: string }[]
      expect(refs.every((r) => r.table !== 'memories' && r.on_delete !== 'CASCADE')).toBe(true)
    }
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('constructors and reads never send, auto-approve, mutate sources or auto-drain', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    const store = new BridgeStore(f.db, f.clock)
    new BridgeCoordinator({ store, requester: fixtureRequester, source: f.source, verifier: f.authority })
    expect(store.getOutbox(envelope.envelopeId)?.state).toBe('queued')
    expect(f.destination.calls).toHaveLength(0)
    const files = ['types', 'policy', 'verifier', 'store', 'outbox', 'index'].map((name) => readFileSync(new URL(`../src/bridge/${name}.ts`, import.meta.url), 'utf8'))
    const production = files.join('\n')
    expect(production).not.toMatch(/currentCaller|LOCAL_OWNER|process\.env|fetch\(|setInterval|setTimeout|tests\/fixtures|InertAuthority|InertDestination|node:http|node:https/)
    expect(production).not.toMatch(/from ['"]\.\.\//)
    expect(readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8')).not.toMatch(/bridge\/|drainBridge/)
  })
})
