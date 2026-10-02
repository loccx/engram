import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeCoordinator } from '../src/bridge/index.js'
import type { DestinationAdapter, PublicationReceipt } from '../src/bridge/index.js'
import { deferred, fixtureBridge, fixtureDestination, fixtureLocator, fixtureRequester, fixtureSnapshot, proposed, queued } from './fixtures/bridge-core-ports.js'
import { DeterministicDestination, exerciseDestinationConformance } from './fixtures/bridge-destination.js'

const opened: ReturnType<typeof fixtureBridge>[] = []
const directories: string[] = []
function setup(path?: string, clock?: ReturnType<typeof fixtureBridge>['clock']) {
  const f = fixtureBridge(path, clock); opened.push(f)
  return { ...f, sink: new DeterministicDestination(fixtureDestination) }
}
afterEach(() => {
  for (const f of opened.splice(0)) if (f.db.open) f.db.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const proposal = { source: fixtureLocator, destination: fixtureDestination, purpose: 'inert-conformance', policyId: 'fixture-policy', policyVersion: 'v1' }
async function published(f: ReturnType<typeof setup>) {
  const { envelope } = await queued(f)
  await f.coordinator.drain(f.sink, { owner: 'inert-owner' })
  return envelope
}
async function retractQueued(f: ReturnType<typeof setup>, targetEnvelopeId: string) {
  const e = f.coordinator.proposeRetraction({ targetEnvelopeId, reason: 'inert cleanup', purpose: 'inert-cleanup', policyId: 'fixture-policy', policyVersion: 'v1' })
  await f.coordinator.approve(e.envelopeId, f.authority.issue(e))
  f.coordinator.enqueue(e.envelopeId)
  return e
}
function receipt(f: ReturnType<typeof setup>, id: string): PublicationReceipt {
  const p = f.store.getPublication(id)
  if (!p) throw new Error('expected exact publication')
  return p
}
// fault injection decorates actual sink responses; it never writes coordinator success state.
function corrupt(p: PublicationReceipt, field: string): PublicationReceipt {
  return ['adapterId', 'scope', 'reader'].includes(field) ? { ...p, destination: { ...p.destination, [field]: 'wrong' } } : { ...p, [field]: 'wrong' }
}
function decorate(sink: DeterministicDestination, overrides: Partial<DestinationAdapter>): DestinationAdapter {
  return { adapterId: sink.adapterId, capabilities: sink.capabilities.bind(sink), publish: sink.publish.bind(sink), retract: sink.retract.bind(sink),
    verifyVisibility: sink.verifyVisibility.bind(sink), verifyAbsence: sink.verifyAbsence.bind(sink), ...overrides }
}

describe('local inert public-API conformance example (not a real Engram source)', () => {
  it('drives complete real coordinator/store -> deterministic sink -> bound reader -> exact cleanup', async () => {
    const f = setup(), sourceBefore = JSON.stringify(f.source.snapshot), stages: string[] = []
    const result = await exerciseDestinationConformance({ coordinator: f.coordinator, adapter: f.sink, proposal,
      grant: (e) => f.authority.issue(e), script: async (stage, e) => {
        stages.push(stage)
        if (stage === 'publish-acknowledged') {
          expect(f.store.getOutbox(e.envelopeId)?.state).toBe('acknowledged')
          expect(f.sink.reads).toHaveLength(0)
          expect(await f.sink.reader.read(receipt(f, e.envelopeId))).toMatchObject({ status: 'found', record: { envelope: { payloadBytes: e.payloadBytes } } })
          expect(f.store.getOutbox(e.envelopeId)?.state).toBe('acknowledged')
        } else if (stage === 'retract-acknowledged') {
          expect(f.store.getOutbox(e.envelopeId)?.state).toBe('retract_acknowledged')
          expect(await f.sink.reader.read(receipt(f, e.envelopeId))).toEqual({ status: 'empty' })
          expect(f.store.getOutbox(e.envelopeId)?.state).toBe('retract_acknowledged')
        }
      } })
    expect(result.visibility.status).toBe('visible')
    expect(result.absence.status).toBe('absent')
    expect(stages).toEqual(['publish-acknowledged', 'publish-observed', 'retract-acknowledged', 'retract-observed'])
    expect(f.store.getOutbox(result.envelope.envelopeId)?.state).toBe('visible')
    expect(f.store.getOutbox(result.retraction.envelopeId)?.state).toBe('retracted_verified')
    expect(f.sink.reads.map((r) => r.status)).toEqual(['found', 'found', 'empty', 'empty'])
    expect(f.sink.acceptedPublications()).toEqual([])
    expect(f.sink.calls.map((c) => c.operation)).toEqual(['publish', 'retract'])
    expect(result.envelope.idempotencyKey).not.toBe(result.retraction.idempotencyKey)
    expect(JSON.stringify(f.source.snapshot)).toBe(sourceBefore)
    expect(f.store.events(result.envelope.envelopeId).map((e) => e.type)).toEqual(['proposed', 'approved', 'queued', 'sending', 'delivery_started', 'acknowledged', 'visible'])
    expect(f.store.events(result.retraction.envelopeId).at(-1)?.type).toBe('retracted_verified')
  })
  it('lets supplied scripts delay projection without manufacturing visibility or absence', async () => {
    const f = setup()
    f.sink.script('publish', { project: false })
    f.sink.script('retract', { project: false })
    const result = await exerciseDestinationConformance({ coordinator: f.coordinator, adapter: f.sink, proposal,
      grant: (e) => f.authority.issue(e), script: async (stage, e) => {
        const p = receipt(f, e.envelopeId)
        if (stage === 'publish-acknowledged') {
          expect((await f.coordinator.verifyVisibility(e.envelopeId, f.sink)).status).toBe('empty')
          expect(f.store.getOutbox(e.envelopeId)?.state).toBe('acknowledged')
          f.sink.projectPublication(p)
        } else if (stage === 'retract-acknowledged') {
          expect((await f.coordinator.verifyRetraction(e.envelopeId, f.sink)).status).toBe('present')
          expect(f.store.getOutbox(e.envelopeId)?.state).toBe('retract_acknowledged')
          f.sink.projectRetraction(p)
        }
      } })
    expect(result.visibility.status).toBe('visible')
    expect(result.absence.status).toBe('absent')
    expect(f.sink.reads.map((r) => r.status)).toEqual(['empty', 'found', 'found', 'empty'])
  })
})

describe('reader observation and exact-target conformance', () => {
  it.each(['forbidden', 'degraded', 'unsupported'] as const)('does not turn %s actual reads into visibility/absence', async (status) => {
    const f = setup(), e = await published(f), r = await retractQueued(f, e.envelopeId)
    f.sink.script('retract', { project: false })
    await f.coordinator.drain(f.sink, { owner: 'owner' })
    f.sink.readerAccess = status
    expect((await f.coordinator.verifyVisibility(e.envelopeId, f.sink)).status).toBe(status)
    expect((await f.coordinator.verifyRetraction(r.envelopeId, f.sink)).status).toBe(status)
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe(status === 'unsupported' ? 'reconciliation_required' : 'acknowledged')
    expect(f.store.getOutbox(r.envelopeId)?.state).toBe(status === 'unsupported' ? 'reconciliation_required' : 'retract_acknowledged')
    expect(f.sink.reads.slice(-2).map((v) => v.status)).toEqual([status, status])
  })
  it.each(['adapterId', 'scope', 'reader', 'payloadSha256', 'version', 'publicationId'] as const)('refuses mismatched %s visibility and absence proofs obtained after real reads', async (field) => {
    const f = setup(), e = await published(f)
    const adapter = decorate(f.sink, {
      verifyVisibility: async (p) => { const v = await f.sink.verifyVisibility(p); return v.status === 'visible' ? { ...v, publication: corrupt(v.publication, field) } : v },
      verifyAbsence: async (p) => { const v = await f.sink.verifyAbsence(p); return v.status === 'absent' ? { ...v, publication: corrupt(v.publication, field) } : v },
    })
    expect((await f.coordinator.verifyVisibility(e.envelopeId, adapter)).status).toBe('conflict')
    const r = await retractQueued(f, e.envelopeId)
    await f.coordinator.drain(f.sink, { owner: 'owner' })
    expect((await f.coordinator.verifyRetraction(r.envelopeId, adapter)).status).toBe('conflict')
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.store.getOutbox(r.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.sink.reads.map((v) => v.status)).toEqual(['found', 'empty'])
  })
  it.each(['adapterId', 'scope', 'reader', 'payloadSha256'] as const)('does not persist a publication from a mismatched %s acknowledgement', async (field) => {
    const f = setup(), { envelope } = await queued(f)
    const adapter = decorate(f.sink, { publish: async (e, c) => {
      const result = await f.sink.publish(e, c)
      return result.status === 'acknowledged' ? { ...result, publication: corrupt(result.publication, field) } : result
    } })
    await f.coordinator.drain(adapter, { owner: 'owner' })
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.store.getPublication(envelope.envelopeId)).toBeNull()
    expect(f.sink.acceptedPublications()).toHaveLength(1)
    expect(f.sink.reads).toHaveLength(0)
  })
  it('does not preserve stale visible or absent success when later actual reads fail', async () => {
    const f = setup(), e = await published(f)
    await f.coordinator.verifyVisibility(e.envelopeId, f.sink)
    const r = await retractQueued(f, e.envelopeId)
    await f.coordinator.drain(f.sink, { owner: 'owner' })
    expect((await f.coordinator.verifyVisibility(e.envelopeId, f.sink)).status).toBe('empty')
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe('reconciliation_required')
    await f.coordinator.verifyRetraction(r.envelopeId, f.sink)
    f.sink.readerAccess = 'degraded'
    expect((await f.coordinator.verifyRetraction(r.envelopeId, f.sink)).status).toBe('degraded')
    expect(f.store.getOutbox(r.envelopeId)?.state).toBe('reconciliation_required')
  })
  it('cleans up the old publication after source deletion without touching newer revision or source audit', async () => {
    const f = setup(), old = await published(f)
    f.source.snapshot = fixtureSnapshot('newer-source', 'newer curated content')
    const newer = await f.coordinator.proposePublish({ ...proposal, supersedesEnvelopeId: old.envelopeId })
    await f.coordinator.approve(newer.envelopeId, f.authority.issue(newer))
    f.coordinator.enqueue(newer.envelopeId)
    await f.coordinator.drain(f.sink, { owner: 'owner' })
    const oldReceipt = receipt(f, old.envelopeId), newReceipt = receipt(f, newer.envelopeId)
    const oldEvents = f.store.events(old.envelopeId), sourceBefore = JSON.stringify(f.source.snapshot), reads = f.source.reads
    f.source.status = 'not_found'
    const r = await retractQueued(f, old.envelopeId)
    const cleanup = new BridgeCoordinator({ store: f.store, requester: fixtureRequester, verifier: f.authority })
    await cleanup.drain(f.sink, { owner: 'cleanup' })
    expect((await cleanup.verifyRetraction(r.envelopeId, f.sink)).status).toBe('absent')
    expect(await f.sink.reader.read(oldReceipt)).toEqual({ status: 'empty' })
    expect(await f.sink.verifyVisibility(newReceipt)).toEqual({ status: 'visible', publication: newReceipt })
    expect(f.sink.acceptedPublications().map((p) => p.publication)).toEqual([newReceipt])
    expect(f.source.reads).toBe(reads)
    expect(JSON.stringify(f.source.snapshot)).toBe(sourceBefore)
    expect(f.store.getEnvelope(old.envelopeId)).toEqual(old)
    expect(f.store.events(old.envelopeId)).toEqual(oldEvents)
    expect(f.store.events(newer.envelopeId).some((v) => v.type === 'supersedes')).toBe(true)
  })
})

describe('acceptance, local completion loss, fenced replay and uncertain protocols', () => {
  it.each(['publish', 'retract'] as const)('reopens SQLite after accepted %s loses local completion; replays stable key/bytes once explicitly invoked', async (operation) => {
    const dir = mkdtempSync(join(tmpdir(), 'bd-')); directories.push(dir)
    const path = join(dir, 'inert.db'), f = setup(path)
    const e = operation === 'publish' ? (await queued(f)).envelope : await retractQueued(f, (await published(f)).envelopeId)
    const callsBefore = f.sink.calls.length
    f.sink.script(operation, { afterAccept: async () => { f.db.close(); throw new Error('inert crash after remote acceptance') } })
    await expect(f.coordinator.drain(f.sink, { owner: 'lost-completion', leaseMs: 10 })).rejects.toThrow()
    expect(f.sink.calls).toHaveLength(callsBefore + 1)
    expect(f.sink.acceptedPublications()).toHaveLength(operation === 'publish' ? 1 : 0)
    f.clock.time += 10
    const reopened = setup(path, f.clock)
    const c = new BridgeCoordinator({ store: reopened.store, requester: fixtureRequester, source: f.source, verifier: f.authority })
    expect(reopened.store.getOutbox(e.envelopeId)?.state).toBe('sending')
    expect(reopened.store.getEnvelope(e.envelopeId)?.payloadBytes).toBe(e.payloadBytes)
    expect(f.sink.calls).toHaveLength(callsBefore + 1)
    const result = await c.drain(f.sink, { owner: 'reopened', leaseMs: 100 })
    expect(result.completed.at(-1)?.state).toBe(operation === 'publish' ? 'acknowledged' : 'retract_acknowledged')
    const deliveries = f.sink.calls.filter((v) => v.operation === operation)
    expect(deliveries.map((v) => v.key)).toEqual([e.idempotencyKey, e.idempotencyKey])
    expect(deliveries.map((v) => v.bytes)).toEqual([e.payloadBytes, e.payloadBytes])
    expect(f.sink.idempotencyEntries).toBe(operation === 'publish' ? 1 : 2)
    expect(reopened.store.events(e.envelopeId).filter((v) => v.type === (operation === 'publish' ? 'acknowledged' : 'retract_acknowledged'))).toHaveLength(1)
    expect(f.sink.reads).toHaveLength(0)
    if (operation === 'publish') expect((await c.verifyVisibility(e.envelopeId, f.sink)).status).toBe('visible')
    else expect((await c.verifyRetraction(e.envelopeId, f.sink)).status).toBe('absent')
  })
  it.each(['same-owner', 'other-owner'] as const)('fences stale accepted completion after %s takeover and deduplicates remote side effect', async (kind) => {
    const f = setup(), { envelope } = await queued(f), accepted = deferred(), release = deferred()
    f.sink.script('publish', { afterAccept: async () => { accepted.resolve(); await release.promise } })
    const first = f.coordinator.drain(f.sink, { owner: 'first', leaseMs: 10 })
    await accepted.promise
    expect(f.sink.acceptedPublications()).toHaveLength(1)
    f.clock.time += 10
    const second = await f.coordinator.drain(f.sink, { owner: kind === 'same-owner' ? 'first' : 'other', leaseMs: 100 })
    expect(second.completed.at(-1)?.state).toBe('acknowledged')
    const before = f.store.events(envelope.envelopeId)
    release.resolve()
    expect((await first).staleLeases).toBe(1)
    expect(f.store.events(envelope.envelopeId)).toEqual(before)
    expect(f.store.events(envelope.envelopeId).filter((v) => v.type === 'acknowledged')).toHaveLength(1)
    expect(f.sink.calls.map((v) => v.key)).toEqual([envelope.idempotencyKey, envelope.idempotencyKey])
    expect(f.sink.acceptedPublications()).toHaveLength(1)
    expect(f.sink.idempotencyEntries).toBe(1)
    expect(f.sink.reads).toHaveLength(0)
  })
  it('keeps accepted-but-pending separate from acknowledgement, retries with stable key, and requires reader proof', async () => {
    const f = setup(), { envelope } = await queued(f)
    f.sink.script('publish', { reply: 'pending', project: false })
    await f.coordinator.drain(f.sink, { owner: 'owner' })
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('queued')
    expect(f.store.getPublication(envelope.envelopeId)).toBeNull()
    expect(f.sink.acceptedPublications()).toHaveLength(1)
    await expect(f.coordinator.verifyVisibility(envelope.envelopeId, f.sink)).rejects.toThrow(/readable/)
    expect(f.sink.reads).toHaveLength(0)
    f.clock.time = f.store.getOutbox(envelope.envelopeId)!.nextAttemptAt
    await f.coordinator.drain(f.sink, { owner: 'owner' })
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('acknowledged')
    expect((await f.coordinator.verifyVisibility(envelope.envelopeId, f.sink)).status).toBe('empty')
    const p = receipt(f, envelope.envelopeId)
    f.sink.projectPublication(p)
    expect((await f.coordinator.verifyVisibility(envelope.envelopeId, f.sink)).status).toBe('visible')
    expect(f.sink.calls.map((v) => v.key)).toEqual([envelope.idempotencyKey, envelope.idempotencyKey])
    expect(f.sink.idempotencyEntries).toBe(1)
  })
  it.each(['publish', 'retract'] as const)('does not blindly retry ambiguous accepted %s without idempotency capability', async (operation) => {
    const f = setup()
    const e = operation === 'publish' ? (await queued(f)).envelope : await retractQueued(f, (await published(f)).envelopeId)
    f.sink.caps = { ...f.sink.caps, [operation === 'publish' ? 'idempotentPublish' : 'idempotentRetract']: false }
    const before = f.sink.calls.length
    f.sink.script(operation, { accept: true, reply: 'degraded' })
    await f.coordinator.drain(f.sink, { owner: 'owner' })
    expect(f.store.getOutbox(e.envelopeId)?.state).toBe('reconciliation_required')
    f.clock.time += 100_000
    expect((await f.coordinator.drain(f.sink, { owner: 'owner' })).claimed).toBe(0)
    expect(f.sink.calls).toHaveLength(before + 1)
    expect(f.sink.acceptedPublications()).toHaveLength(operation === 'publish' ? 1 : 0)
    expect(f.sink.reads).toHaveLength(0)
  })
  it.each(['source', 'authority', 'local-revocation'] as const)('preserves uncertainty after pending acceptance then %s changes', async (kind) => {
    const f = setup(), { envelope, grant } = await queued(f)
    f.sink.script('publish', { reply: 'pending' })
    await f.coordinator.drain(f.sink, { owner: 'owner' })
    f.clock.time = f.store.getOutbox(envelope.envelopeId)!.nextAttemptAt
    if (kind === 'source') f.source.snapshot = fixtureSnapshot('changed', 'changed inert content')
    else if (kind === 'authority') f.authority.revoke(grant)
    else f.coordinator.revokeApproval(envelope.envelopeId)
    await f.coordinator.drain(f.sink, { owner: 'owner' })
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    expect(f.sink.acceptedPublications()).toHaveLength(1)
    expect(f.sink.calls).toHaveLength(1)
    expect(f.store.events(envelope.envelopeId).some((v) => v.type === 'visible')).toBe(false)
  })
})

describe('authority/source changes at actual async boundaries', () => {
  it.each(['source', 'expiry', 'authority', 'local-revocation'] as const)('blocks %s change during exact-source await before sink acceptance', async (kind) => {
    const f = setup(), { envelope, grant } = await queued(f), entered = deferred(), release = deferred()
    f.source.beforeRead = async () => { entered.resolve(); await release.promise; f.source.beforeRead = undefined }
    const pending = f.coordinator.drain(f.sink, { owner: 'owner', leaseMs: 200_000 })
    await entered.promise
    if (kind === 'source') f.source.snapshot = fixtureSnapshot('changed-before-send', 'new source')
    else if (kind === 'expiry') f.clock.time = 100_000
    else if (kind === 'authority') f.authority.revoke(grant)
    else f.coordinator.revokeApproval(envelope.envelopeId)
    release.resolve()
    await pending
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('rejected')
    expect(f.sink.calls).toHaveLength(0)
    expect(f.sink.acceptedPublications()).toEqual([])
  })
  it('uses inclusive expiry at verifier-await completion instead of stale verifier input', async () => {
    const f = setup(), envelope = await proposed(f), entered = deferred(), release = deferred()
    await f.coordinator.approve(envelope.envelopeId, f.authority.issue(envelope, { expiresAt: 1001 }))
    f.coordinator.enqueue(envelope.envelopeId)
    f.authority.beforeRecheck = async () => { entered.resolve(); await release.promise; f.authority.beforeRecheck = undefined }
    const pending = f.coordinator.drain(f.sink, { owner: 'owner' })
    await entered.promise; f.clock.time = 1001; release.resolve(); await pending
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('rejected')
    expect(f.sink.calls).toHaveLength(0)
  })
  it.each(['source', 'authority', 'local-revocation', 'expiry'] as const)('records accepted publication as uncertain when %s changes before remote await returns', async (kind) => {
    const f = setup(), { envelope, grant } = await queued(f), accepted = deferred(), release = deferred()
    f.sink.script('publish', { afterAccept: async () => { accepted.resolve(); await release.promise } })
    const pending = f.coordinator.drain(f.sink, { owner: 'owner', leaseMs: 200_000 })
    await accepted.promise
    expect(f.sink.acceptedPublications()).toHaveLength(1)
    if (kind === 'source') f.source.snapshot = fixtureSnapshot('changed-inflight', 'changed during IO')
    else if (kind === 'authority') f.authority.revoke(grant)
    else if (kind === 'local-revocation') f.coordinator.revokeApproval(envelope.envelopeId)
    else f.clock.time = 100_000
    release.resolve(); await pending
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('reconciliation_required')
    const p = receipt(f, envelope.envelopeId)
    expect(p.payloadSha256).toBe(envelope.payloadSha256)
    expect(await f.sink.reader.read(p)).toMatchObject({ status: 'found' })
    expect(f.store.events(envelope.envelopeId).at(-1)?.detail).toContain('source_or_authority_changed_inflight')
    expect(f.store.events(envelope.envelopeId).some((v) => v.type === 'visible')).toBe(false)
    expect((await f.coordinator.drain(f.sink, { owner: 'owner' })).claimed).toBe(0)
    expect(f.sink.calls).toHaveLength(1)
  })
})
