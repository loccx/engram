import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeCoordinator, BridgeStore, StaleLeaseError, sealEnvelope } from '../src/bridge/index.js'
import { retryDelay } from '../src/bridge/policy.js'
import { deferred, fixtureBridge, fixtureRequester, fixtureSnapshot, proposed, queued } from './fixtures/bridge-core-ports.js'

const opened: ReturnType<typeof fixtureBridge>[] = []
const directories: string[] = []
function setup(path?: string) { const f = fixtureBridge(path); opened.push(f); return f }
afterEach(() => {
  for (const f of opened.splice(0)) if (f.db.open) f.db.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

async function drain(f: ReturnType<typeof fixtureBridge>) { return f.coordinator.drain(f.destination, { owner: 'owner', baseDelayMs: 100, maxDelayMs: 1000, jitter: 0.5 }) }

describe('bridge source and authority checks around asynchronous io', () => {
  it.each(['changed', 'retired', 'not_found', 'forbidden'] as const)('blocks %s source after approval', async (status) => {
    const f = setup()
    const { envelope } = await queued(f)
    f.source.status = status
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('rejected')
    expect(f.destination.calls).toHaveLength(0)
  })
  it('rejects exact-revision/content/provenance drift instead of reconstructing approved bytes', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    f.source.snapshot = fixtureSnapshot('opaque-revision-two', 'corrected')
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('rejected')
    expect(f.store.getEnvelope(envelope.envelopeId)).toEqual(envelope)
    expect(f.destination.calls).toHaveLength(0)
  })
  it.each(['expiry', 'authority-revocation', 'local-revocation'] as const)('rechecks %s after async source wait, before any send', async (kind) => {
    const f = setup()
    const { envelope, grant } = await queued(f)
    const entered = deferred(), release = deferred()
    f.source.beforeRead = async () => { entered.resolve(); await release.promise; f.source.beforeRead = undefined }
    const pending = f.coordinator.drain(f.destination, { owner: 'owner', leaseMs: 200_000 })
    await entered.promise
    if (kind === 'expiry') f.clock.time = 100_000
    else if (kind === 'authority-revocation') f.authority.revoke(grant)
    else f.coordinator.revokeApproval(envelope.envelopeId)
    release.resolve()
    expect((await pending).staleLeases).toBe(0)
    expect(f.destination.calls).toHaveLength(0)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('rejected')
  })
  it('uses completion time rather than stale verifier input time for inclusive expiry', async () => {
    const f = setup()
    const e = await proposed(f)
    await f.coordinator.approve(e.envelopeId, f.authority.issue(e, { expiresAt: 1001 }))
    f.coordinator.enqueue(e.envelopeId)
    const entered = deferred(), release = deferred()
    f.authority.beforeRecheck = async () => { entered.resolve(); await release.promise; f.authority.beforeRecheck = undefined }
    const pending = drain(f)
    await entered.promise
    f.clock.time = 1001
    release.resolve()
    await pending
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe('rejected')
    expect(f.destination.calls).toHaveLength(0)
  })
  it.each(['source', 'authority', 'local-revocation', 'expiry'] as const)('records reconciliation for %s change during remote io without pretending rollback', async (kind) => {
    const f = setup()
    const { envelope, grant } = await queued(f)
    const entered = deferred(), release = deferred()
    f.destination.beforeDelivery = async () => { entered.resolve(); await release.promise }
    const pending = f.coordinator.drain(f.destination, { owner: 'owner', leaseMs: 200_000 })
    await entered.promise
    if (kind === 'source') f.source.snapshot = fixtureSnapshot('new-revision', 'changed while sending')
    else if (kind === 'authority') f.authority.revoke(grant)
    else if (kind === 'local-revocation') f.coordinator.revokeApproval(envelope.envelopeId)
    else f.clock.time = 100_000
    release.resolve()
    await pending
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.destination.remote.size).toBe(1)
    expect(f.store.getPublication(envelope.envelopeId)?.payloadSha256).toBe(envelope.payloadSha256)
    expect(f.store.events(envelope.envelopeId).at(-1)?.detail).toContain('source_or_authority_changed_inflight')
    await drain(f)
    expect(f.destination.calls).toHaveLength(1)
  })
  it('blocks malformed exact-source hashes after approval', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    f.source.readExact = async () => ({ status: 'available', snapshot: { ...f.source.snapshot, projectionSha256: 'forged-hash' } })
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('rejected')
    expect(f.destination.calls).toHaveLength(0)
  })
  it('does not accept a different authoritative grant identity on recheck', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    f.authority.recheck = async (input) => ({ status: 'verified', approval: { ...input.approval, approver: 'different-authority' } })
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('rejected')
    expect(f.destination.calls).toHaveLength(0)
  })
  it('default deny still blocks delivery if lower-level persistence contains a forged approval', async () => {
    const f = setup()
    const envelope = await proposed(f)
    f.store.saveApproval(envelope.envelopeId, 'inert-forged-grant', { verifierId: 'default-deny', grantId: 'inert-forged-grant',
      approver: 'name-only-self-approval', requester: fixtureRequester.principalId, bindingSha256: envelope.payloadSha256, expiresAt: 100_000, allowedOperations: ['publish'] })
    f.store.enqueue(envelope.envelopeId)
    const c = new BridgeCoordinator({ store: f.store, requester: fixtureRequester, source: f.source })
    await c.drain(f.destination, { owner: 'default-deny' })
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('rejected')
    expect(f.destination.calls).toHaveLength(0)
  })
  it('bounds unavailable authority preflight without treating it as approval', async () => {
    const f = setup()
    const { envelope } = await queued(f, 2)
    f.authority.recheck = async () => { throw new Error('inert authority unavailable') }
    await drain(f)
    f.clock.time = f.store.getOutbox(envelope.envelopeId)!.nextAttemptAt
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('dead')
    expect(f.destination.calls).toHaveLength(0)
  })
  it('never holds a sqlite transaction while awaiting ports', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    f.source.beforeRead = async () => { expect(f.db.inTransaction).toBe(false) }
    f.authority.beforeRecheck = async () => { expect(f.db.inTransaction).toBe(false) }
    f.destination.beforeDelivery = async () => { expect(f.db.inTransaction).toBe(false) }
    const capabilities = f.destination.capabilities.bind(f.destination)
    f.destination.capabilities = async () => { expect(f.db.inTransaction).toBe(false); return capabilities() }
    await drain(f)
    await f.coordinator.verifyVisibility(envelope.envelopeId, f.destination)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('visible')
  })
})

describe('bridge fenced leases, crash replay and bounded retries', () => {
  it.each(['same-owner', 'different-owner'] as const)('rejects stale completion after %s lease takeover with no stale ledger append', async (kind) => {
    const f = setup()
    const { envelope } = await queued(f)
    const a = f.store.claim('owner', 10, f.destination.adapterId, fixtureRequester.principalId)!
    expect(f.store.claim('other', 10, f.destination.adapterId, fixtureRequester.principalId)).toBeNull()
    f.clock.time += 10
    const b = f.store.claim(kind === 'same-owner' ? 'owner' : 'other', 10, f.destination.adapterId, fixtureRequester.principalId)!
    expect(b.leaseGeneration).toBe(a.leaseGeneration + 1)
    expect(b.leaseToken).not.toBe(a.leaseToken)
    const eventsBefore = f.store.events(envelope.envelopeId).length
    expect(() => f.store.complete(a, 'reconciliation_required')).toThrow(StaleLeaseError)
    expect(f.store.events(envelope.envelopeId)).toHaveLength(eventsBefore)
    f.store.complete(b, 'reconciliation_required')
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    expect(() => f.store.complete(b, 'rejected')).toThrow(StaleLeaseError)
  })
  it('rejects a completion exactly at lease expiry even before takeover', async () => {
    const f = setup()
    await queued(f)
    const claim = f.store.claim('owner', 10, f.destination.adapterId, fixtureRequester.principalId)!
    f.clock.time += 10
    expect(() => f.store.complete(claim, 'rejected')).toThrow(StaleLeaseError)
  })
  it('fences a delayed drainer while takeover replays the same remote key', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    const entered = deferred(), release = deferred()
    let deliveries = 0
    f.destination.beforeDelivery = async () => { if (++deliveries === 1) { entered.resolve(); await release.promise } }
    const first = f.coordinator.drain(f.destination, { owner: 'same-owner', leaseMs: 10 })
    await entered.promise
    f.clock.time += 10
    const second = await f.coordinator.drain(f.destination, { owner: 'same-owner', leaseMs: 100 })
    expect(second.completed[0]?.state).toBe('acknowledged')
    release.resolve()
    expect((await first).staleLeases).toBe(1)
    expect(f.destination.calls.map((c) => c.key)).toEqual([envelope.idempotencyKey, envelope.idempotencyKey])
    expect(f.destination.remote.size).toBe(1)
    expect(f.store.events(envelope.envelopeId).filter((v) => v.type === 'acknowledged')).toHaveLength(1)
  })
  it.each(['before-acceptance', 'after-acceptance'] as const)('reopens after crash %s and explicitly replays stable bytes/key', async (crashPoint) => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-')); directories.push(dir)
    const path = join(dir, 'fixture.db')
    const f = setup(path)
    const { envelope } = await queued(f)
    const claim = f.store.claim('crashed', 10, f.destination.adapterId, fixtureRequester.principalId)!
    if (crashPoint === 'after-acceptance') await f.destination.publish(envelope as typeof envelope & { operation: 'publish' }, { idempotencyKey: envelope.idempotencyKey, attempt: claim.attempt })
    f.db.close()
    f.clock.time += 10
    const reopened = setup(path)
    const store = new BridgeStore(reopened.db, f.clock)
    const c = new BridgeCoordinator({ store, requester: fixtureRequester, source: f.source, verifier: f.authority })
    expect(f.destination.calls).toHaveLength(crashPoint === 'after-acceptance' ? 1 : 0)
    expect(store.getOutbox(envelope.envelopeId)?.state).toBe('sending')
    expect(store.getEnvelope(envelope.envelopeId)?.payloadBytes).toBe(envelope.payloadBytes)
    await c.drain(f.destination, { owner: 'restarted', leaseMs: 100 })
    expect(store.getOutbox(envelope.envelopeId)?.state).toBe('acknowledged')
    expect(f.destination.remote.size).toBe(1)
    expect(f.destination.keys.size).toBe(1)
    expect(new Set(f.destination.calls.map((call) => call.key))).toEqual(new Set([envelope.idempotencyKey]))
    expect(new Set(f.destination.calls.map((call) => call.bytes))).toEqual(new Set([envelope.payloadBytes]))
  })
  it('replays persistent queued work only when explicitly invoked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-')); directories.push(dir)
    const path = join(dir, 'fixture.db')
    const f = setup(path)
    const { envelope } = await queued(f)
    f.db.close()
    const reopened = setup(path)
    const c = new BridgeCoordinator({ store: new BridgeStore(reopened.db, f.clock), requester: fixtureRequester, source: f.source, verifier: f.authority })
    expect(f.destination.calls).toHaveLength(0)
    await c.drain(f.destination, { owner: 'restarted' })
    expect(reopened.store.getOutbox(envelope.envelopeId)?.state).toBe('acknowledged')
  })
  it('conflicts on the same destination idempotency key with different canonical bytes', async () => {
    const f = setup()
    const e = await proposed(f)
    const first = await f.destination.publish(e as typeof e & { operation: 'publish' }, { idempotencyKey: e.idempotencyKey, attempt: 1 })
    expect(first.status).toBe('acknowledged')
    const { payloadBytes: _bytes, payloadSha256: _hash, idempotencyKey: _key, ...payload } = e
    const changed = sealEnvelope({ ...payload, purpose: 'conflicting bytes' })
    expect((await f.destination.publish(changed as typeof changed & { operation: 'publish' }, { idempotencyKey: e.idempotencyKey, attempt: 2 })).status).toBe('conflict')
    expect(f.destination.remote.size).toBe(1)
  })
  it('bounds exponential jitter and attempts with an injectable clock/random source', async () => {
    const f = setup()
    const { envelope } = await queued(f, 3)
    f.source.status = 'degraded'
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.nextAttemptAt).toBe(1075)
    expect((await drain(f)).claimed).toBe(0)
    f.clock.time = 1075
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.nextAttemptAt).toBe(1225)
    f.clock.time = 1225
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('dead')
    expect(f.store.getOutbox(envelope.envelopeId)?.attempt).toBe(3)
    expect(f.destination.calls).toHaveLength(0)
    expect(retryDelay(100, 100, 1000, 0.5, () => 1)).toBe(1000)
    expect(() => retryDelay(1, 0, 100, 0.5, () => 0.5)).toThrow()
    expect(() => retryDelay(1, 100, 1000, 0.5, () => 2)).toThrow()
  })
  it('retries pending remote acceptance with the same key only when idempotent', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    f.destination.deliveryStatus = 'pending'
    await drain(f)
    expect(f.destination.remote.size).toBe(1)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('queued')
    f.destination.deliveryStatus = undefined
    f.clock.time = f.store.getOutbox(envelope.envelopeId)!.nextAttemptAt
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('acknowledged')
    expect(f.destination.calls.map((c) => c.key)).toEqual([envelope.idempotencyKey, envelope.idempotencyKey])
  })
  it.each(['source-stale', 'local-revoked', 'remote-forbidden'] as const)('preserves uncertainty after pending acceptance then %s', async (kind) => {
    const f = setup()
    const { envelope } = await queued(f)
    f.destination.deliveryStatus = 'pending'
    await drain(f)
    f.clock.time = f.store.getOutbox(envelope.envelopeId)!.nextAttemptAt
    if (kind === 'source-stale') f.source.snapshot = fixtureSnapshot('new-revision')
    else if (kind === 'local-revoked') f.coordinator.revokeApproval(envelope.envelopeId)
    else f.destination.deliveryStatus = 'forbidden'
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.destination.remote.size).toBe(1)
    expect(f.destination.calls).toHaveLength(kind === 'remote-forbidden' ? 2 : 1)
  })
  it('ends accepted-but-pending exhaustion in reconciliation, not presumed absence', async () => {
    const f = setup()
    const { envelope } = await queued(f, 1)
    f.destination.deliveryStatus = 'pending'
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.destination.remote.size).toBe(1)
    expect((await drain(f)).claimed).toBe(0)
  })
  it('does not blindly retry uncertain transport on a non-idempotent destination', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    f.destination.caps = { ...f.destination.caps, idempotentPublish: false }
    f.destination.deliveryStatus = 'degraded'
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    await drain(f)
    expect(f.destination.calls).toHaveLength(1)
  })
  it('refuses automatic takeover retry when the destination cannot deduplicate', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    f.destination.caps = { ...f.destination.caps, idempotentPublish: false }
    f.store.claim('crashed', 10, f.destination.adapterId, fixtureRequester.principalId)
    f.clock.time += 10
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.destination.calls).toHaveLength(0)
  })
  it('never exceeds the attempt cap by sending after an expired final claim', async () => {
    const f = setup()
    const { envelope } = await queued(f, 1)
    f.store.claim('crashed', 10, f.destination.adapterId, fixtureRequester.principalId)
    f.clock.time += 10
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.destination.calls).toHaveLength(0)
  })
})

describe('bridge destination refusal and integrity gates', () => {
  it.each(['ambiguous', 'unsupported', 'conflict', 'rejected', 'forbidden'] as const)('records %s without a blind resend', async (status) => {
    const f = setup()
    const { envelope } = await queued(f)
    f.destination.deliveryStatus = status
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe(status === 'ambiguous' || status === 'unsupported' ? 'reconciliation_required' : status === 'forbidden' ? 'rejected' : status)
    await drain(f)
    expect(f.destination.calls).toHaveLength(1)
  })
  it('maps a thrown delivery to ambiguity, never presumed failure/absence', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    f.destination.beforeDelivery = async () => { throw new Error('inert transport exception') }
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
  })
  it.each(['hash', 'scope', 'reader'] as const)('rejects an ack for a different %s', async (field) => {
    const f = setup()
    const { envelope } = await queued(f)
    f.destination.acknowledgement = (p) => field === 'hash' ? { ...p, payloadSha256: 'wrong' } : { ...p, destination: { ...p.destination, [field]: 'wrong' } }
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.store.getPublication(envelope.envelopeId)).toBeNull()
  })
  it('fails closed on unsupported capability and does not claim another route/requester', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    expect((await f.coordinator.drain({ ...f.destination, adapterId: 'foreign-route' } as never, { owner: 'owner' })).claimed).toBe(0)
    const foreign = new BridgeCoordinator({ store: f.store, requester: { principalId: 'foreign' }, verifier: f.authority })
    expect((await foreign.drain(f.destination, { owner: 'foreign' })).claimed).toBe(0)
    f.destination.caps = { ...f.destination.caps, publish: false }
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.destination.calls).toHaveLength(0)
  })
  it('blocks unsupported exact-publication retraction without invoking the adapter', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    await drain(f)
    const r = f.coordinator.proposeRetraction({ targetEnvelopeId: envelope.envelopeId, reason: 'inert cleanup', purpose: 'cleanup', policyId: 'fixture-policy', policyVersion: 'v1' })
    await f.coordinator.approve(r.envelopeId, f.authority.issue(r))
    f.coordinator.enqueue(r.envelopeId)
    f.destination.caps = { ...f.destination.caps, retract: false }
    await drain(f)
    expect(f.store.getOutbox(r.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.destination.calls).toHaveLength(1)
    expect(f.destination.remote.size).toBe(1)
  })
  it('detects corrupt persisted bytes before any remote operation', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    f.db.exec('DROP TRIGGER bridge_envelopes_immutable_update')
    f.db.prepare('UPDATE bridge_envelopes SET payload_sha256 = ? WHERE envelope_id = ?').run('corrupt-fixture-hash', envelope.envelopeId)
    expect(() => f.store.getEnvelope(envelope.envelopeId)).toThrow(/integrity/)
    await drain(f)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.destination.calls).toHaveLength(0)
  })
})
