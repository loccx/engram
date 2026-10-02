import { afterEach, describe, expect, it } from 'vitest'
import { BridgeCoordinator, canonicalJson, computeIdempotencyKey, defaultDenyVerifier, normalizeSnapshot, sealEnvelope, sha256, verifyEnvelopeIntegrity } from '../src/bridge/index.js'
import { checkedApproval } from '../src/bridge/verifier.js'
import type { BridgePayload, VerifiedApproval } from '../src/bridge/index.js'
import { fixtureBridge, fixtureDestination, fixtureLocator, fixtureRequester, fixtureSnapshot, proposed } from './fixtures/bridge-core-ports.js'

const opened: ReturnType<typeof fixtureBridge>[] = []
function setup() { const f = fixtureBridge(); opened.push(f); return f }
afterEach(() => { for (const f of opened.splice(0)) f.db.close() })

describe('bridge canonical policy and default-deny authority', () => {
  it('seals every outbound byte and rejects mutation of redundant metadata', async () => {
    const f = setup()
    const e = await proposed(f)
    expect(JSON.parse(e.payloadBytes)).toEqual({ schemaVersion: e.schemaVersion, envelopeId: e.envelopeId, operation: 'publish',
      destination: e.destination, purpose: e.purpose, policyId: e.policyId, policyVersion: e.policyVersion, requester: e.requester,
      createdAt: e.createdAt, snapshot: e.snapshot, supersedesEnvelopeId: null })
    expect(sha256(e.payloadBytes)).toBe(e.payloadSha256)
    expect(f.store.getEnvelope(e.envelopeId)).toEqual(e)
    expect(Object.isFrozen(e.snapshot.provenance[0])).toBe(true)
    expect(() => verifyEnvelopeIntegrity({ ...e, purpose: 'other' })).toThrow(/integrity/)
    expect(() => verifyEnvelopeIntegrity({ ...e, payloadBytes: `${e.payloadBytes} ` })).toThrow(/integrity/)
    expect(() => verifyEnvelopeIntegrity({ ...e, idempotencyKey: 'forged' })).toThrow(/integrity/)
  })
  it('canonicalizes keys but never silently drops unsupported json or projection fields', () => {
    expect(canonicalJson({ z: 1, a: { c: 3, b: 2 } })).toBe('{"a":{"b":2,"c":3},"z":1}')
    for (const value of [undefined, NaN, Infinity, new Date(), { a: undefined }, [undefined], Array(2)]) expect(() => canonicalJson(value)).toThrow()
    expect(() => normalizeSnapshot({ ...fixtureSnapshot(), trusted: true })).toThrow(/projection/)
    expect(() => normalizeSnapshot({ ...fixtureSnapshot(), content: 'tampered' })).toThrow(/hash/)
    expect(() => normalizeSnapshot({ ...fixtureSnapshot(), provenance: [] })).toThrow(/hash/)
  })
  it('binds idempotency to operation, envelope and payload hash', () => {
    const key = computeIdempotencyKey('publish', 'e1', 'h1')
    expect(key).toBe(computeIdempotencyKey('publish', 'e1', 'h1'))
    expect(new Set([key, computeIdempotencyKey('retract', 'e1', 'h1'), computeIdempotencyKey('publish', 'e2', 'h1'), computeIdempotencyKey('publish', 'e1', 'h2')]).size).toBe(4)
  })
  it('cannot infer an approving authority from local owner, name, flags or arbitrary grants', async () => {
    const f = setup()
    const e = await proposed(f)
    const c = new BridgeCoordinator({ store: f.store, requester: fixtureRequester, source: f.source })
    for (const grant of ['fixture-requester', 'local-owner', 'shareable', 'pinned', '{"trusted":true}', 'forged']) {
      await expect(c.approve(e.envelopeId, grant)).rejects.toThrow(/denied/)
      await expect(f.coordinator.approve(e.envelopeId, grant)).rejects.toThrow(/denied/)
    }
    expect(await defaultDenyVerifier.verify({ envelope: e, opaqueGrant: 'inert', now: 1000 })).toEqual({ status: 'denied' })
    expect(() => c.enqueue(e.envelopeId)).toThrow(/approval/)
    expect(f.store.getApproval(e.envelopeId)).toBeNull()
    expect(f.destination.calls).toHaveLength(0)
  })
  it('requires a host requester bound to the source and blocks cross-requester envelopes', async () => {
    const f = setup()
    expect(() => new BridgeCoordinator({ store: f.store, requester: { principalId: 'foreign' }, source: f.source })).toThrow(/requester/)
    expect(() => new BridgeCoordinator({ store: f.store, requester: { principalId: '' } })).toThrow(/identity/)
    const e = await proposed(f)
    const foreign = new BridgeCoordinator({ store: f.store, requester: { principalId: 'foreign' }, verifier: f.authority })
    await expect(foreign.approve(e.envelopeId, f.authority.issue(e))).rejects.toThrow(/unavailable/)
    expect(() => foreign.enqueue(e.envelopeId)).toThrow(/unavailable/)
  })
  it.each(['not_found', 'forbidden', 'degraded', 'changed', 'retired'] as const)('does not persist source data on %s', async (status) => {
    const f = setup()
    f.source.status = status
    await expect(proposed(f)).rejects.toThrow(status)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM bridge_envelopes').get()).toEqual({ n: 0 })
  })
  it('refuses foreign namespaces, unknown providers and wrong returned source locators', async () => {
    const f = setup()
    const base = { destination: fixtureDestination, purpose: 'p', policyId: 'pol', policyVersion: 'v1' }
    await expect(f.coordinator.proposePublish({ ...base, source: { ...fixtureLocator, namespace: 'foreign' } })).rejects.toThrow(/forbidden/)
    await expect(f.coordinator.proposePublish({ ...base, source: { ...fixtureLocator, provider: 'foreign' } })).rejects.toThrow(/provider/)
    f.source.resolveCurrent = async () => ({ status: 'available', snapshot: fixtureSnapshot('wrong-revision', 'inert') })
    const snapshot = fixtureSnapshot()
    f.source.resolveCurrent = async () => ({ status: 'available', snapshot: normalizeSnapshot({ ...snapshot,
      ref: { ...snapshot.ref, sourceId: 'wrong' }, projectionSha256: sha256(canonicalJson({ ref: { ...snapshot.ref, sourceId: 'wrong' }, content: snapshot.content,
        contentType: snapshot.contentType, tags: snapshot.tags, provenance: snapshot.provenance })) }) })
    await expect(proposed(f)).rejects.toThrow(/locator/)
  })
  it.each(['revision', 'hash', 'scope', 'reader', 'purpose', 'policyId', 'policyVersion', 'requester'] as const)('never reuses an exact grant for changed %s', async (field) => {
    const f = setup()
    const original = await proposed(f)
    const grant = f.authority.issue(original)
    const { payloadBytes: _bytes, payloadSha256: _hash, idempotencyKey: _key, ...payload } = original
    const updated: BridgePayload = { ...payload, envelopeId: f.clock.newId() }
    const change = field === 'revision' ? { snapshot: fixtureSnapshot('revision-two') }
      : field === 'hash' ? { snapshot: fixtureSnapshot('opaque-revision-one', 'changed bytes') }
      : field === 'scope' || field === 'reader' ? { destination: { ...updated.destination, [field]: 'wrong' } }
      : field === 'requester' ? { requester: { principalId: 'foreign' } } : { [field]: 'wrong' }
    const changed = sealEnvelope({ ...updated, ...change })
    f.store.insertProposal(changed)
    const c = field === 'requester' ? new BridgeCoordinator({ store: f.store, requester: changed.requester, verifier: f.authority }) : f.coordinator
    await expect(c.approve(changed.envelopeId, grant)).rejects.toThrow(/denied/)
    expect(f.store.getApproval(changed.envelopeId)).toBeNull()
  })
  it.each(['binding', 'approver', 'grant', 'requester', 'operation', 'expired', 'verifier'] as const)('rejects a malformed authoritative %s verdict', async (field) => {
    const f = setup()
    const e = await proposed(f)
    const approval: VerifiedApproval = { verifierId: f.authority.verifierId, grantId: 'fixture-grant', approver: 'fixture-human', requester: fixtureRequester.principalId,
      bindingSha256: e.payloadSha256, expiresAt: 2000, allowedOperations: ['publish'] }
    const changes = field === 'binding' ? { bindingSha256: 'wrong' } : field === 'approver' ? { approver: '' } : field === 'grant' ? { grantId: '' }
      : field === 'requester' ? { requester: 'wrong' } : field === 'operation' ? { allowedOperations: ['retract'] as const }
      : field === 'expired' ? { expiresAt: 1000 } : { verifierId: 'wrong' }
    expect(checkedApproval({ status: 'verified', approval: { ...approval, ...changes } }, f.authority, e, 1000)).toBeNull()
  })
  it('refuses a grant that expires while initial verification awaits', async () => {
    const f = setup()
    const e = await proposed(f)
    const grant = f.authority.issue(e, { expiresAt: 1001 })
    const verify = f.authority.verify.bind(f.authority)
    f.authority.verify = async (input) => { const verdict = await verify(input); f.clock.time = 1001; return verdict }
    await expect(f.coordinator.approve(e.envelopeId, grant)).rejects.toThrow(/denied/)
    expect(f.store.getApproval(e.envelopeId)).toBeNull()
  })
  it('expires inclusively and will not replace or resurrect revoked approval history', async () => {
    const f = setup()
    const e = await proposed(f)
    const grant = f.authority.issue(e, { expiresAt: 1001 })
    await f.coordinator.approve(e.envelopeId, grant)
    await f.coordinator.approve(e.envelopeId, grant)
    expect(f.store.events(e.envelopeId).filter((v) => v.type === 'approved')).toHaveLength(1)
    f.clock.time = 1001
    expect(() => f.coordinator.enqueue(e.envelopeId)).toThrow(/approval/)
    f.clock.time = 1000
    f.coordinator.revokeApproval(e.envelopeId)
    f.coordinator.revokeApproval(e.envelopeId)
    await expect(f.coordinator.approve(e.envelopeId, f.authority.issue(e))).rejects.toThrow(/immutable/)
    expect(() => f.coordinator.enqueue(e.envelopeId)).toThrow(/approval/)
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM bridge_approval_events WHERE event_type = 'revoked'").get()).toEqual({ n: 1 })
  })
})
