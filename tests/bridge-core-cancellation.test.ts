import { afterEach, describe, expect, it } from 'vitest'
import { BridgeCoordinator } from '../src/bridge/index.js'
import { deferred, fixtureBridge, fixtureSnapshot, proposed, queued } from './fixtures/bridge-core-ports.js'

const opened: ReturnType<typeof fixtureBridge>[] = []
function setup() { const f = fixtureBridge(); opened.push(f); return f }
afterEach(() => { for (const f of opened.splice(0)) if (f.db.open) f.db.close() })
const options = { owner: 'fixture-owner', maxJobs: 1 }
function retract(f: ReturnType<typeof fixtureBridge>, targetEnvelopeId: string) {
  return f.coordinator.proposeRetraction({ targetEnvelopeId, reason: 'inert exact cleanup', purpose: 'cleanup', policyId: 'fixture-policy', policyVersion: 'v1' })
}
async function published(f: ReturnType<typeof fixtureBridge>) {
  const { envelope } = await queued(f)
  await f.coordinator.drain(f.destination, options)
  expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('acknowledged')
  return envelope
}

describe('bridge explicit proposal cancellation', () => {
  it.each(['expiry', 'revocation'] as const)('recovers never-enqueued %s cleanup with a new proposal and exact grant', async (change) => {
    const f = setup()
    const old = await published(f)
    const oldReceipt = f.store.getPublication(old.envelopeId)!
    f.source.snapshot = fixtureSnapshot('newer-inert-revision', 'newer inert content')
    const newer = await published(f)
    const newerReceipt = f.store.getPublication(newer.envelopeId)!
    const stranded = retract(f, old.envelopeId)
    const grant = f.authority.issue(stranded, { expiresAt: 1001 })
    await f.coordinator.approve(stranded.envelopeId, grant)
    if (change === 'expiry') f.clock.time = 1001
    else { f.authority.revoke(grant); f.coordinator.revokeApproval(stranded.envelopeId) }
    const approvalBefore = f.store.getApproval(stranded.envelopeId)
    const eventsBefore = f.store.events(stranded.envelopeId)
    expect(() => f.coordinator.enqueue(stranded.envelopeId)).toThrow(/approval/)
    expect(() => retract(f, old.envelopeId)).toThrow(/already proposed/)
    await expect(f.coordinator.approve(stranded.envelopeId, f.authority.issue(stranded))).rejects.toThrow(/immutable/)
    expect(f.store.getOutbox(stranded.envelopeId)).toBeNull()

    expect(f.coordinator.cancelProposal(stranded.envelopeId)).toBeUndefined()
    f.coordinator.cancelProposal(stranded.envelopeId)
    expect(f.store.events(stranded.envelopeId).slice(0, -1)).toEqual(eventsBefore)
    expect(f.store.events(stranded.envelopeId).filter((e) => e.type === 'proposal_cancelled')).toHaveLength(1)
    expect(f.store.getEnvelope(stranded.envelopeId)).toEqual(stranded)
    expect(f.store.getApproval(stranded.envelopeId)).toEqual(approvalBefore)
    expect(f.store.getOutbox(stranded.envelopeId)).toBeNull()
    await expect(f.coordinator.approve(stranded.envelopeId, f.authority.issue(stranded))).rejects.toThrow(/cancelled/)
    expect(() => f.coordinator.enqueue(stranded.envelopeId)).toThrow(/cancelled/)

    const replacement = retract(f, old.envelopeId)
    expect(replacement.envelopeId).not.toBe(stranded.envelopeId)
    expect(replacement.payloadBytes).not.toBe(stranded.payloadBytes)
    expect(replacement.payloadSha256).not.toBe(stranded.payloadSha256)
    expect(replacement.operation).toBe('retract')
    if (replacement.operation !== 'retract') throw new Error('expected inert retraction')
    expect(replacement.target.publication).toEqual(oldReceipt)
    await expect(f.coordinator.approve(replacement.envelopeId, grant)).rejects.toThrow(/denied/)
    expect(() => f.coordinator.enqueue(replacement.envelopeId)).toThrow(/approval/)
    const freshGrant = f.authority.issue(replacement)
    expect(freshGrant).not.toBe(grant)
    await f.coordinator.approve(replacement.envelopeId, freshGrant)
    expect(f.store.getApproval(replacement.envelopeId)?.approval.bindingSha256).toBe(replacement.payloadSha256)
    f.coordinator.enqueue(replacement.envelopeId)
    const readsBefore = f.source.reads
    f.source.status = 'not_found'
    await f.coordinator.drain(f.destination, options)
    expect((await f.coordinator.verifyRetraction(replacement.envelopeId, f.destination)).status).toBe('absent')
    expect(f.source.reads).toBe(readsBefore)
    expect(f.destination.calls.map((c) => c.operation)).toEqual(['publish', 'publish', 'retract'])
    expect(f.destination.calls.at(-1)?.bytes).toBe(replacement.payloadBytes)
    expect(f.destination.remote.has(f.destination.remoteKey(oldReceipt))).toBe(false)
    expect(f.destination.remote.has(f.destination.remoteKey(newerReceipt))).toBe(true)
    expect(f.store.getEnvelope(stranded.envelopeId)).toEqual(stranded)
    expect(f.store.getApproval(stranded.envelopeId)).toEqual(approvalBefore)
  })

  it('cancels an unapproved publish without minting approval or queue work', async () => {
    const f = setup(), e = await proposed(f)
    f.coordinator.cancelProposal(e.envelopeId)
    f.coordinator.cancelProposal(e.envelopeId)
    expect(f.store.events(e.envelopeId).map((v) => v.type)).toEqual(['proposed', 'proposal_cancelled'])
    expect(f.store.getApproval(e.envelopeId)).toBeNull()
    expect(f.store.getOutbox(e.envelopeId)).toBeNull()
    await expect(f.coordinator.approve(e.envelopeId, f.authority.issue(e))).rejects.toThrow(/cancelled/)
    expect(() => f.coordinator.enqueue(e.envelopeId)).toThrow(/cancelled/)
    expect((await f.coordinator.drain(f.destination, options)).claimed).toBe(0)
    expect(f.destination.calls).toHaveLength(0)
  })

  it('rejects foreign and nonexistent ids without appending audit', async () => {
    const f = setup(), e = await proposed(f)
    const foreign = new BridgeCoordinator({ store: f.store, requester: { principalId: 'inert-foreign-requester' }, verifier: f.authority })
    const before = f.store.events(e.envelopeId)
    expect(() => foreign.cancelProposal(e.envelopeId)).toThrow(/unavailable to requester/)
    expect(() => f.coordinator.cancelProposal('inert-nonexistent')).toThrow(/unavailable to requester/)
    expect(() => f.store.cancelProposal('inert-nonexistent')).toThrow(/unavailable/)
    expect(f.store.events(e.envelopeId)).toEqual(before)
    expect(f.store.events('inert-nonexistent')).toEqual([])
  })

  it('does not let an awaiting approval revive a cancelled proposal', async () => {
    const f = setup(), e = await proposed(f)
    const entered = deferred(), release = deferred()
    const verify = f.authority.verify.bind(f.authority)
    f.authority.verify = async (input) => { entered.resolve(); await release.promise; return verify(input) }
    const approving = f.coordinator.approve(e.envelopeId, f.authority.issue(e))
    await entered.promise
    f.coordinator.cancelProposal(e.envelopeId)
    release.resolve()
    await expect(approving).rejects.toThrow(/cancelled/)
    expect(f.store.getApproval(e.envelopeId)).toBeNull()
    expect(f.store.events(e.envelopeId).map((v) => v.type)).toEqual(['proposed', 'proposal_cancelled'])
  })

  it.each(['cancelled', 'rejected', 'dead'] as const)('requires an explicit marker to replace terminal %s cleanup with no delivery attempt', async (state) => {
    const f = setup(), target = await published(f), e = retract(f, target.envelopeId)
    const grant = f.authority.issue(e)
    await f.coordinator.approve(e.envelopeId, grant)
    f.coordinator.enqueue(e.envelopeId, 1)
    if (state === 'cancelled') f.coordinator.revokeApproval(e.envelopeId)
    else {
      if (state === 'rejected') f.authority.revoke(grant)
      else f.destination.capabilities = async () => { throw new Error('inert capability outage') }
      await f.coordinator.drain(f.destination, options)
    }
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe(state)
    expect(f.store.hasDeliveryAttempt(e.envelopeId)).toBe(false)
    expect(() => retract(f, target.envelopeId)).toThrow(/already proposed/)
    const rowBefore = f.store.getOutbox(e.envelopeId)
    f.coordinator.cancelProposal(e.envelopeId)
    f.coordinator.cancelProposal(e.envelopeId)
    expect(f.store.getOutbox(e.envelopeId)).toEqual(rowBefore)
    expect(f.store.events(e.envelopeId).filter((v) => v.type === 'proposal_cancelled')).toHaveLength(1)
    await expect(f.coordinator.approve(e.envelopeId, f.authority.issue(e))).rejects.toThrow(/cancelled/)
    expect(() => f.coordinator.enqueue(e.envelopeId)).toThrow(/cancelled/)
    const replacement = retract(f, target.envelopeId)
    await f.coordinator.approve(replacement.envelopeId, f.authority.issue(replacement))
    f.coordinator.enqueue(replacement.envelopeId)
    if (state === 'dead') f.destination.capabilities = async () => f.destination.caps
    await f.coordinator.drain(f.destination, options)
    expect((await f.coordinator.verifyRetraction(replacement.envelopeId, f.destination)).status).toBe('absent')
  })

  it('refuses queued proposals and in-flight retractions without releasing duplicate protection', async () => {
    const f = setup(), target = await published(f), e = retract(f, target.envelopeId)
    await f.coordinator.approve(e.envelopeId, f.authority.issue(e))
    f.coordinator.enqueue(e.envelopeId)
    expect(() => f.coordinator.cancelProposal(e.envelopeId)).toThrow(/active or attempted/)
    const entered = deferred(), release = deferred()
    f.destination.beforeDelivery = async () => { entered.resolve(); await release.promise }
    const pending = f.coordinator.drain(f.destination, options)
    await entered.promise
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe('sending')
    const before = f.store.events(e.envelopeId)
    expect(() => f.coordinator.cancelProposal(e.envelopeId)).toThrow(/active or attempted/)
    expect(() => retract(f, target.envelopeId)).toThrow(/already proposed/)
    expect(f.store.events(e.envelopeId)).toEqual(before)
    release.resolve()
    await pending
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe('retract_acknowledged')
  })

  it.each(['queued', 'retract_acknowledged', 'retracted_verified', 'reconciliation_required', 'conflict'] as const)('refuses attempted %s cleanup and retains exact-target duplicate protection', async (state) => {
    const f = setup(), target = await published(f), e = retract(f, target.envelopeId)
    await f.coordinator.approve(e.envelopeId, f.authority.issue(e))
    f.coordinator.enqueue(e.envelopeId)
    if (state === 'queued') f.destination.deliveryStatus = 'pending'
    if (state === 'reconciliation_required') f.destination.deliveryStatus = 'ambiguous'
    if (state === 'conflict') f.destination.deliveryStatus = 'conflict'
    await f.coordinator.drain(f.destination, options)
    if (state === 'retracted_verified') await f.coordinator.verifyRetraction(e.envelopeId, f.destination)
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe(state)
    expect(f.store.hasDeliveryAttempt(e.envelopeId)).toBe(true)
    const before = f.store.events(e.envelopeId)
    expect(() => f.coordinator.cancelProposal(e.envelopeId)).toThrow(/active or attempted/)
    expect(() => retract(f, target.envelopeId)).toThrow(/already proposed/)
    expect(f.store.events(e.envelopeId)).toEqual(before)
  })

  it.each(['acknowledged', 'visible'] as const)('refuses %s publications', async (state) => {
    const f = setup(), e = await published(f)
    if (state === 'visible') await f.coordinator.verifyVisibility(e.envelopeId, f.destination)
    expect(() => f.coordinator.cancelProposal(e.envelopeId)).toThrow(/active or attempted/)
    expect(f.store.events(e.envelopeId).some((v) => v.type === 'proposal_cancelled')).toBe(false)
  })

  it.each(['cancelled', 'rejected', 'dead'] as const)('refuses terminal %s work with an earlier delivery attempt', async (state) => {
    const f = setup(), target = await published(f), e = retract(f, target.envelopeId)
    await f.coordinator.approve(e.envelopeId, f.authority.issue(e))
    f.coordinator.enqueue(e.envelopeId)
    f.destination.deliveryStatus = 'pending'
    await f.coordinator.drain(f.destination, options)
    f.clock.time = f.store.getOutbox(e.envelopeId)!.nextAttemptAt
    const claim = f.store.claim('inert-owner', 1000, f.destination.adapterId, e.requester.principalId)!
    f.store.complete(claim, state)
    expect(f.store.hasDeliveryAttempt(e.envelopeId)).toBe(true)
    expect(() => f.coordinator.cancelProposal(e.envelopeId)).toThrow(/active or attempted/)
    expect(() => retract(f, target.envelopeId)).toThrow(/already proposed/)
  })
})
