import { afterEach, describe, expect, it } from 'vitest'
import type { BridgeEnvelope, OutboxClaim, PublicationReceipt } from '../src/bridge/index.js'
import { deferred, fixtureBridge, fixtureRequester, fixtureSnapshot, queued } from './fixtures/bridge-core-ports.js'

const opened: ReturnType<typeof fixtureBridge>[] = []
function setup() { const f = fixtureBridge(); opened.push(f); return f }
afterEach(() => { for (const f of opened.splice(0)) if (f.db.open) f.db.close() })
const options = { owner: 'fixture-owner', maxJobs: 1, leaseMs: 200_000 }
function holdAuthorityAfter(f: ReturnType<typeof fixtureBridge>) {
  const entered = deferred(), release = deferred()
  let rechecks = 0
  f.authority.beforeRecheck = async () => { if (++rechecks === 2) { entered.resolve(); await release.promise } }
  return { entered, release, rechecks: () => rechecks }
}
function holdFinalSourceAfter(f: ReturnType<typeof fixtureBridge>) {
  const entered = deferred(), release = deferred(), finalRead = f.source.reads + 4
  f.source.beforeRead = async () => { if (f.source.reads === finalRead) { entered.resolve(); await release.promise } }
  return { entered, release }
}
function corruptPersistedHash(f: ReturnType<typeof fixtureBridge>, id: string) {
  // inert trusted-admin fault injection, not a normal coordinator operation.
  f.db.exec('DROP TRIGGER bridge_envelopes_immutable_update')
  f.db.prepare('UPDATE bridge_envelopes SET payload_sha256 = ? WHERE envelope_id = ?').run('inert-corrupt-hash', id)
}
function receiptFor(f: ReturnType<typeof fixtureBridge>, id: string): PublicationReceipt {
  const found = [...f.destination.keys.values()].find((v) => v.publication.version === id)
  if (!found) throw new Error('missing inert remote acknowledgement')
  return found.publication
}
function expectReconciledReceipt(f: ReturnType<typeof fixtureBridge>, e: BridgeEnvelope, receipt: PublicationReceipt) {
  expect(f.store.getOutbox(e.envelopeId)?.state).toBe('reconciliation_required')
  expect(f.store.getPublication(e.envelopeId)).toEqual(receipt)
  expect(f.store.events(e.envelopeId).some((v) => ['acknowledged', 'visible', 'retract_acknowledged', 'retracted_verified'].includes(v.type))).toBe(false)
  expect(f.destination.calls).toHaveLength(1)
  expect(f.destination.calls[0].bytes).toBe(e.payloadBytes)
}

describe('bridge bounded postflight observations', () => {
  it.each([
    ['forbidden', 'acknowledged'], ['revision', 'acknowledged'], ['forbidden', 'pending'], ['revision', 'pending'],
  ] as const)('detects source %s during post-send authority wait before classifying %s', async (change, outcome) => {
    const f = setup(), { envelope } = await queued(f)
    if (outcome === 'pending') f.destination.deliveryStatus = 'pending'
    const held = holdAuthorityAfter(f)
    const pending = f.coordinator.drain(f.destination, options)
    await held.entered.promise
    expect(f.source.reads).toBe(3)
    expect(f.destination.calls).toHaveLength(1)
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('sending')
    if (change === 'forbidden') f.source.status = 'forbidden'
    else f.source.snapshot = fixtureSnapshot('post-authority-inert-revision', 'corrected inert postflight content')
    held.release.resolve()
    expect(await pending).toMatchObject({ completed: [{ envelopeId: envelope.envelopeId, state: 'reconciliation_required' }], staleLeases: 0 })
    expect(f.store.getOutbox(envelope.envelopeId)?.lastError).toBe('source_or_authority_changed_inflight')
    expect(f.source.reads).toBe(4)
    expect(held.rechecks()).toBe(2)
    if (outcome === 'acknowledged') expectReconciledReceipt(f, envelope, receiptFor(f, envelope.envelopeId))
    else expect(f.store.getPublication(envelope.envelopeId)).toBeNull()
    expect(f.destination.remote.size).toBe(1)
    expect((await f.coordinator.drain(f.destination, options)).claimed).toBe(0)
  })

  it.each(['degraded', 'throws'] as const)('does not acknowledge final source %s and retains the actual matching receipt', async (status) => {
    const f = setup(), { envelope } = await queued(f)
    const readExact = f.source.readExact.bind(f.source)
    let reads = 0
    f.source.readExact = async (ref) => {
      if (++reads === 4) {
        if (status === 'throws') throw new Error('inert postflight source unavailable')
        return { status: 'degraded' }
      }
      return readExact(ref)
    }
    await f.coordinator.drain(f.destination, options)
    expectReconciledReceipt(f, envelope, receiptFor(f, envelope.envelopeId))
    expect(f.store.getOutbox(envelope.envelopeId)?.lastError).toBe('source_or_authority_changed_inflight')
    expect(reads).toBe(4)
    expect(f.destination.remote.size).toBe(1)
  })

  it.each(['expiry', 'local-revocation'] as const)('checks synchronous %s after the final source wait', async (change) => {
    const f = setup(), { envelope } = await queued(f)
    const held = holdFinalSourceAfter(f)
    const pending = f.coordinator.drain(f.destination, options)
    await held.entered.promise
    const receipt = receiptFor(f, envelope.envelopeId)
    if (change === 'expiry') f.clock.time = 100_000
    else f.coordinator.revokeApproval(envelope.envelopeId)
    held.release.resolve()
    expect((await pending).staleLeases).toBe(0)
    expectReconciledReceipt(f, envelope, receipt)
    expect(f.store.getOutbox(envelope.envelopeId)?.lastError).toBe('approval_invalid')
    expect(f.destination.remote.size).toBe(1)
  })

  it.each(['expiry', 'takeover'] as const)('fences lease %s during the final postflight source wait without stale audit', async (change) => {
    const f = setup(), { envelope } = await queued(f)
    const held = holdFinalSourceAfter(f)
    const pending = f.coordinator.drain(f.destination, { ...options, leaseMs: 10 })
    await held.entered.promise
    f.clock.time += 10
    const takeover = change === 'takeover' ? f.store.claim('inert-takeover', 100, f.destination.adapterId, fixtureRequester.principalId)! : null
    const eventsBefore = f.store.events(envelope.envelopeId)
    held.release.resolve()
    expect(await pending).toMatchObject({ completed: [], staleLeases: 1 })
    expect(f.store.events(envelope.envelopeId)).toEqual(eventsBefore)
    expect(f.store.getPublication(envelope.envelopeId)).toBeNull()
    expect(f.destination.remote.size).toBe(1)
    if (takeover) expect(f.store.owns(takeover)).toBe(true)
  })

  it.each(['destination', 'source-provider', 'source-requester'] as const)('reconciles %s binding drift after the final source wait', async (port) => {
    const f = setup(), { envelope } = await queued(f)
    const held = holdFinalSourceAfter(f)
    const pending = f.coordinator.drain(f.destination, options)
    await held.entered.promise
    const receipt = receiptFor(f, envelope.envelopeId)
    if (port === 'destination') Object.defineProperty(f.destination, 'adapterId', { value: 'inert-other-sink' })
    else if (port === 'source-provider') Object.defineProperty(f.source, 'provider', { value: 'inert-other-provider' })
    else Object.defineProperty(f.source, 'requester', { value: { principalId: 'inert-other-requester' } })
    held.release.resolve()
    await pending
    expectReconciledReceipt(f, envelope, receipt)
    expect(f.store.getOutbox(envelope.envelopeId)?.lastError).toBe(port === 'source-requester' ? 'integrity_or_internal_failure' : 'port_binding_changed')
  })

  it('retains an earlier known invalid source observation even if the final observation recovers', async () => {
    const f = setup(), { envelope } = await queued(f)
    const readExact = f.source.readExact.bind(f.source)
    let reads = 0
    f.source.readExact = async (ref) => ++reads === 3 ? { status: 'forbidden' } : readExact(ref)
    await f.coordinator.drain(f.destination, options)
    expectReconciledReceipt(f, envelope, receiptFor(f, envelope.envelopeId))
    expect(f.store.getOutbox(envelope.envelopeId)?.lastError).toBe('source_or_authority_changed_inflight')
    expect(reads).toBe(4)
  })

  it('does not claim distributed atomicity when remote authority changes during the final source wait', async () => {
    const f = setup(), { envelope, grant } = await queued(f)
    const held = holdFinalSourceAfter(f)
    const pending = f.coordinator.drain(f.destination, options)
    await held.entered.promise
    f.authority.revoke(grant)
    held.release.resolve()
    await pending
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('acknowledged')
    expect(f.store.getPublication(envelope.envelopeId)).toEqual(receiptFor(f, envelope.envelopeId))
    expect(f.source.reads).toBe(4)
  })
})

describe('bridge uncertain evidence for trusted-admin integrity faults after send', () => {
  it.each(['exact', 'mismatch', 'stale'] as const)('records only fenced %s evidence against the verified attempted envelope', async (kind) => {
    const f = setup(), { envelope } = await queued(f)
    if (kind === 'mismatch') f.destination.acknowledgement = (p) => ({ ...p, payloadSha256: 'inert-wrong-hash' })
    const held = holdFinalSourceAfter(f)
    const pending = f.coordinator.drain(f.destination, { ...options, leaseMs: kind === 'stale' ? 10 : options.leaseMs })
    await held.entered.promise
    const claim = f.store.getOutbox(envelope.envelopeId)! as OutboxClaim
    const actual = receiptFor(f, envelope.envelopeId)
    corruptPersistedHash(f, envelope.envelopeId)
    expect(() => f.store.getEnvelope(envelope.envelopeId)).toThrow(/integrity/)
    expect(() => f.store.complete(claim, 'acknowledged', null, actual)).toThrow(/integrity/)
    if (kind === 'stale') f.clock.time += 10
    const eventsBefore = f.store.events(envelope.envelopeId)
    held.release.resolve()
    const result = await pending
    expect(f.destination.remote.size).toBe(1)
    expect(f.destination.calls[0].bytes).toBe(envelope.payloadBytes)
    expect(() => f.store.getEnvelope(envelope.envelopeId)).toThrow(/integrity/)
    if (kind === 'stale') {
      expect(result).toMatchObject({ completed: [], staleLeases: 1 })
      expect(f.store.events(envelope.envelopeId)).toEqual(eventsBefore)
      expect(f.store.getPublication(envelope.envelopeId)).toBeNull()
      expect(() => f.store.completeUncertainDelivery(claim, envelope, actual)).toThrow(/stale uncertain completion/)
      expect(f.store.events(envelope.envelopeId)).toEqual(eventsBefore)
    } else {
      expect(result).toMatchObject({ completed: [{ envelopeId: envelope.envelopeId, state: 'reconciliation_required' }], staleLeases: 0 })
      expect(f.store.getPublication(envelope.envelopeId)).toEqual(kind === 'exact' ? actual : null)
      expect(f.store.events(envelope.envelopeId).slice(0, -1)).toEqual(eventsBefore)
      const detail = JSON.parse(f.store.events(envelope.envelopeId).at(-1)!.detail)
      expect(detail).toEqual({ reason: 'integrity_or_internal_failure', receipt: kind === 'exact' ? actual : null,
        evidence: 'verified_attempted_envelope', attemptedPayloadBytes: envelope.payloadBytes, attemptedPayloadSha256: envelope.payloadSha256 })
      expect(f.store.events(envelope.envelopeId).some((v) => v.type === 'acknowledged')).toBe(false)
    }
  })

  it('preserves exact-target retraction evidence after persisted retraction corruption', async () => {
    const f = setup(), { envelope } = await queued(f)
    await f.coordinator.drain(f.destination, options)
    const e = f.coordinator.proposeRetraction({ targetEnvelopeId: envelope.envelopeId, reason: 'inert cleanup', purpose: 'cleanup', policyId: 'fixture-policy', policyVersion: 'v1' })
    await f.coordinator.approve(e.envelopeId, f.authority.issue(e))
    f.coordinator.enqueue(e.envelopeId)
    const held = holdAuthorityAfter(f)
    const pending = f.coordinator.drain(f.destination, options)
    await held.entered.promise
    corruptPersistedHash(f, e.envelopeId)
    held.release.resolve()
    expect((await pending).staleLeases).toBe(0)
    if (e.operation !== 'retract') throw new Error('expected inert retraction')
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.store.getPublication(e.envelopeId)).toEqual(e.target.publication)
    expect(f.destination.remote.size).toBe(0)
    expect(f.destination.calls.at(-1)?.bytes).toBe(e.payloadBytes)
    expect(JSON.parse(f.store.events(e.envelopeId).at(-1)!.detail)).toMatchObject({
      evidence: 'verified_attempted_envelope', attemptedPayloadBytes: e.payloadBytes, attemptedPayloadSha256: e.payloadSha256,
    })
    expect(f.store.events(e.envelopeId).some((v) => v.type === 'retract_acknowledged')).toBe(false)
  })

  it('rejects uncertain evidence without matching delivery start or with invalid envelope identity/integrity', async () => {
    const f = setup(), { envelope } = await queued(f)
    const claim = f.store.claim('inert-owner', 1000, f.destination.adapterId, fixtureRequester.principalId)!
    const before = f.store.events(envelope.envelopeId)
    expect(() => f.store.completeUncertainDelivery(claim, envelope)).toThrow(/matching delivery start/)
    f.store.markDeliveryStarted(claim)
    const started = f.store.events(envelope.envelopeId)
    const other = (await queued(f)).envelope
    expect(() => f.store.completeUncertainDelivery(claim, other)).toThrow(/invalid attempted/)
    expect(() => f.store.completeUncertainDelivery(claim, { ...envelope, payloadSha256: 'inert-bad-hash' })).toThrow(/integrity/)
    expect(() => f.store.completeUncertainDelivery(claim, envelope, {
      publicationId: 'inert-publication', version: 'inert-version', payloadSha256: envelope.payloadSha256,
      destination: { ...envelope.destination, reader: 'inert-other-reader' },
    })).toThrow(/invalid attempted/)
    expect(f.store.events(envelope.envelopeId)).toEqual(started)
    expect(started).toHaveLength(before.length + 1)
    expect(f.store.owns(claim)).toBe(true)
  })

  it('requires the exact target version for uncertain retraction evidence', async () => {
    const f = setup(), { envelope } = await queued(f)
    await f.coordinator.drain(f.destination, options)
    const e = f.coordinator.proposeRetraction({ targetEnvelopeId: envelope.envelopeId, reason: 'inert cleanup', purpose: 'cleanup', policyId: 'fixture-policy', policyVersion: 'v1' })
    await f.coordinator.approve(e.envelopeId, f.authority.issue(e))
    f.coordinator.enqueue(e.envelopeId)
    const claim = f.store.claim('inert-owner', 1000, f.destination.adapterId, fixtureRequester.principalId)!
    f.store.markDeliveryStarted(claim)
    if (e.operation !== 'retract') throw new Error('expected inert retraction')
    const before = f.store.events(e.envelopeId)
    expect(() => f.store.completeUncertainDelivery(claim, e, { ...e.target.publication, version: 'inert-wrong-version' })).toThrow(/invalid attempted/)
    expect(f.store.events(e.envelopeId)).toEqual(before)
    f.store.completeUncertainDelivery(claim, e, e.target.publication)
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.store.getPublication(e.envelopeId)).toEqual(e.target.publication)
  })
})
