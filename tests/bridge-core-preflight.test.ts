import { afterEach, describe, expect, it } from 'vitest'
import { deferred, fixtureBridge, fixtureRequester, fixtureSnapshot, queued } from './fixtures/bridge-core-ports.js'

const opened: ReturnType<typeof fixtureBridge>[] = []
function setup() { const f = fixtureBridge(); opened.push(f); return f }
afterEach(() => { for (const f of opened.splice(0)) if (f.db.open) f.db.close() })

const options = { owner: 'owner', maxJobs: 1, leaseMs: 200_000, baseDelayMs: 100, maxDelayMs: 1000, jitter: 0.5 }
function deliveryStarts(f: ReturnType<typeof fixtureBridge>, id: string) {
  return f.store.events(id).filter((event) => event.type === 'delivery_started').length
}
function holdFinalSource(f: ReturnType<typeof fixtureBridge>) {
  const entered = deferred(), release = deferred()
  const finalRead = f.source.reads + 2
  f.source.beforeRead = async () => { if (f.source.reads === finalRead) { entered.resolve(); await release.promise } }
  return { entered, release }
}
async function priorPending(f: ReturnType<typeof fixtureBridge>, id: string) {
  f.destination.deliveryStatus = 'pending'
  await f.coordinator.drain(f.destination, options)
  expect(f.store.getOutbox(id)?.state).toBe('queued')
  f.destination.deliveryStatus = undefined
  f.clock.time = f.store.getOutbox(id)!.nextAttemptAt
}

describe('bridge final source observation before delivery start', () => {
  it.each([
    ['retired', false], ['revision', false], ['retired', true], ['revision', true],
  ] as const)('blocks source %s during authority wait (prior uncertain: %s)', async (change, uncertain) => {
    const f = setup()
    const { envelope } = await queued(f)
    if (uncertain) await priorPending(f, envelope.envelopeId)
    const callsBefore = f.destination.calls.length
    const startsBefore = deliveryStarts(f, envelope.envelopeId)
    const readsBefore = f.source.reads
    const entered = deferred(), release = deferred()
    f.authority.beforeRecheck = async () => { entered.resolve(); await release.promise }
    const pending = f.coordinator.drain(f.destination, options)
    await entered.promise
    expect(f.source.reads).toBe(readsBefore + 1)
    if (change === 'retired') f.source.status = 'retired'
    else f.source.snapshot = fixtureSnapshot('revision-during-authority', 'corrected inert content')
    release.resolve()
    expect((await pending).staleLeases).toBe(0)
    expect(f.destination.calls).toHaveLength(callsBefore)
    expect(deliveryStarts(f, envelope.envelopeId)).toBe(startsBefore)
    expect(f.store.getOutbox(envelope.envelopeId)).toMatchObject({
      state: uncertain ? 'reconciliation_required' : 'rejected', lastError: 'source_stale_or_forbidden',
    })
    expect(f.source.reads).toBe(readsBefore + 2)
  })

  it.each(['degraded', 'throws'] as const)('bounds final source %s with preflight backoff and no delivery', async (kind) => {
    const f = setup()
    const { envelope } = await queued(f, 2)
    const readExact = f.source.readExact.bind(f.source)
    let afterAuthority = false
    f.authority.beforeRecheck = async () => { afterAuthority = true }
    f.source.readExact = async (ref) => {
      if (!afterAuthority) return readExact(ref)
      if (kind === 'throws') throw new Error('inert final source unavailable')
      return { status: 'degraded' }
    }
    for (const expected of ['queued', 'dead'] as const) {
      afterAuthority = false
      await f.coordinator.drain(f.destination, options)
      expect(f.destination.calls).toHaveLength(0)
      expect(deliveryStarts(f, envelope.envelopeId)).toBe(0)
      expect(f.store.getOutbox(envelope.envelopeId)).toMatchObject({ state: expected, lastError: 'source_degraded' })
      if (expected === 'queued') {
        expect(f.store.getOutbox(envelope.envelopeId)?.nextAttemptAt).toBe(1075)
        f.clock.time = 1075
      }
    }
  })

  it('preserves prior delivery uncertainty when final source degradation exhausts the cap', async () => {
    const f = setup()
    const { envelope } = await queued(f, 2)
    await priorPending(f, envelope.envelopeId)
    const startsBefore = deliveryStarts(f, envelope.envelopeId)
    f.authority.beforeRecheck = async () => { f.source.status = 'degraded' }
    await f.coordinator.drain(f.destination, options)
    expect(f.destination.calls).toHaveLength(1)
    expect(deliveryStarts(f, envelope.envelopeId)).toBe(startsBefore)
    expect(f.store.getOutbox(envelope.envelopeId)).toMatchObject({ state: 'reconciliation_required', lastError: 'source_degraded' })
    expect(f.destination.remote.size).toBe(1)
  })

  it.each([
    ['expiry', false], ['local-revocation', false], ['expiry', true], ['local-revocation', true],
  ] as const)('blocks %s during final source wait (prior uncertain: %s)', async (change, uncertain) => {
    const f = setup()
    const { envelope } = await queued(f)
    if (uncertain) await priorPending(f, envelope.envelopeId)
    const callsBefore = f.destination.calls.length
    const startsBefore = deliveryStarts(f, envelope.envelopeId)
    const { entered, release } = holdFinalSource(f)
    const pending = f.coordinator.drain(f.destination, options)
    await entered.promise
    if (change === 'expiry') f.clock.time = 100_000
    else f.coordinator.revokeApproval(envelope.envelopeId)
    release.resolve()
    expect((await pending).staleLeases).toBe(0)
    expect(f.destination.calls).toHaveLength(callsBefore)
    expect(deliveryStarts(f, envelope.envelopeId)).toBe(startsBefore)
    expect(f.store.getOutbox(envelope.envelopeId)).toMatchObject({
      state: uncertain ? 'reconciliation_required' : 'rejected', lastError: 'approval_invalid',
    })
  })

  it('fences lease takeover during the final source wait before any delivery start', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    const { entered, release } = holdFinalSource(f)
    const pending = f.coordinator.drain(f.destination, { ...options, leaseMs: 10 })
    await entered.promise
    f.clock.time += 10
    const takeover = f.store.claim('takeover', 100, f.destination.adapterId, fixtureRequester.principalId)!
    expect(takeover.leaseGeneration).toBe(2)
    const eventsBefore = f.store.events(envelope.envelopeId).length
    release.resolve()
    expect(await pending).toMatchObject({ completed: [], staleLeases: 1 })
    expect(f.destination.calls).toHaveLength(0)
    expect(deliveryStarts(f, envelope.envelopeId)).toBe(0)
    expect(f.store.events(envelope.envelopeId)).toHaveLength(eventsBefore)
    expect(f.store.owns(takeover)).toBe(true)
    f.store.complete(takeover, 'rejected')
  })

  it.each(['destination', 'source-provider'] as const)('blocks %s binding drift during the final source wait', async (port) => {
    const f = setup()
    const { envelope } = await queued(f)
    const { entered, release } = holdFinalSource(f)
    const pending = f.coordinator.drain(f.destination, options)
    await entered.promise
    if (port === 'destination') Object.defineProperty(f.destination, 'adapterId', { value: 'inert-other-sink' })
    else Object.defineProperty(f.source, 'provider', { value: 'inert-other-source' })
    release.resolve()
    await pending
    expect(f.destination.calls).toHaveLength(0)
    expect(deliveryStarts(f, envelope.envelopeId)).toBe(0)
    expect(f.store.getOutbox(envelope.envelopeId)).toMatchObject({ state: 'reconciliation_required', lastError: 'port_binding_changed' })
  })

  it('blocks persisted envelope corruption during the final source wait', async () => {
    const f = setup()
    const { envelope } = await queued(f)
    const { entered, release } = holdFinalSource(f)
    const pending = f.coordinator.drain(f.destination, options)
    await entered.promise
    f.db.exec('DROP TRIGGER bridge_envelopes_immutable_update')
    f.db.prepare('UPDATE bridge_envelopes SET payload_sha256 = ? WHERE envelope_id = ?').run('inert-corrupt-hash', envelope.envelopeId)
    release.resolve()
    await pending
    expect(f.destination.calls).toHaveLength(0)
    expect(deliveryStarts(f, envelope.envelopeId)).toBe(0)
    expect(f.store.getOutbox(envelope.envelopeId)).toMatchObject({ state: 'reconciliation_required', lastError: 'integrity_or_internal_failure' })
  })

  it('reconciles remote authority revocation during the final source wait without claiming atomicity', async () => {
    const f = setup()
    const { envelope, grant } = await queued(f)
    const { entered, release } = holdFinalSource(f)
    const pending = f.coordinator.drain(f.destination, options)
    await entered.promise
    f.authority.revoke(grant)
    release.resolve()
    await pending
    expect(f.destination.calls).toHaveLength(1)
    expect(deliveryStarts(f, envelope.envelopeId)).toBe(1)
    expect(f.store.getOutbox(envelope.envelopeId)).toMatchObject({ state: 'reconciliation_required', lastError: 'source_or_authority_changed_inflight' })
    expect(f.store.getPublication(envelope.envelopeId)?.payloadSha256).toBe(envelope.payloadSha256)
  })
})
