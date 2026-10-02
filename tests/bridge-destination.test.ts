import { afterEach, describe, expect, it } from 'vitest'
import { sealEnvelope } from '../src/bridge/index.js'
import type { BridgeEnvelope, BridgePayload, PublicationReceipt } from '../src/bridge/index.js'
import { fixtureBridge, fixtureDestination, fixtureSnapshot, proposed } from './fixtures/bridge-core-ports.js'
import { DeterministicDestination } from './fixtures/bridge-destination.js'

const opened: ReturnType<typeof fixtureBridge>[] = []
function setup() {
  const f = fixtureBridge(); opened.push(f)
  return { ...f, sink: new DeterministicDestination(fixtureDestination) }
}
afterEach(() => { for (const f of opened.splice(0)) if (f.db.open) f.db.close() })
function publishEnvelope(e: BridgeEnvelope) {
  if (e.operation !== 'publish') throw new Error('expected publish')
  return e
}
function alter(e: BridgeEnvelope, change: Record<string, unknown>): BridgeEnvelope {
  const { payloadBytes: _bytes, payloadSha256: _hash, idempotencyKey: _key, ...payload } = e
  return sealEnvelope({ ...payload, ...change } as BridgePayload)
}
async function accepted(f: ReturnType<typeof setup>) {
  const e = publishEnvelope(await proposed(f))
  const result = await f.sink.publish(e, { idempotencyKey: e.idempotencyKey, attempt: 1 })
  if (result.status !== 'acknowledged') throw new Error('expected ack')
  return { e, publication: result.publication }
}
function cleanup(e: BridgeEnvelope & { operation: 'publish' }, publication: PublicationReceipt, id = 'inert-retraction') {
  const result = sealEnvelope({ schemaVersion: 'bridge.payload/v1', envelopeId: id, operation: 'retract', destination: e.destination,
    purpose: 'inert-cleanup', policyId: e.policyId, policyVersion: e.policyVersion, requester: e.requester, createdAt: e.createdAt,
    target: { envelopeId: e.envelopeId, sourceRef: e.snapshot.ref, publication }, reason: 'inert-cleanup' })
  if (result.operation !== 'retract') throw new Error('expected retract')
  return result
}

describe('deterministic inert destination protocol and bound readers', () => {
  it('persists exact immutable bytes/route/hash/version and deduplicates identical publish', async () => {
    const f = setup(), { e, publication } = await accepted(f)
    const replay = await f.sink.publish(e, { idempotencyKey: e.idempotencyKey, attempt: 2 })
    expect(replay).toEqual({ status: 'acknowledged', publication })
    expect(f.sink.idempotencyEntries).toBe(1)
    expect(f.sink.acceptedPublications()).toEqual([{ envelope: e, publication }])
    expect(publication).toMatchObject({ version: e.envelopeId, payloadSha256: e.payloadSha256, destination: fixtureDestination })
    const read = await f.sink.reader.read(publication)
    expect(read).toEqual({ status: 'found', record: { envelope: e, publication } })
    if (read.status !== 'found') throw new Error('expected reader content')
    expect(Object.isFrozen(read.record.envelope.snapshot.tags)).toBe(true)
    expect(() => { (read.record.envelope.snapshot.tags as string[]).push('tamper') }).toThrow()
    expect(f.sink.calls.map((c) => c.bytes)).toEqual([e.payloadBytes, e.payloadBytes])
  })
  it('conflicts on same key with conflicting valid bytes without changing prior content', async () => {
    const f = setup(), { e, publication } = await accepted(f)
    const changed = publishEnvelope(alter(e, { purpose: 'different purpose' }))
    expect(await f.sink.publish(changed, { idempotencyKey: e.idempotencyKey, attempt: 2 })).toEqual({ status: 'conflict' })
    expect((await f.sink.reader.read(publication))).toMatchObject({ status: 'found', record: { envelope: { payloadBytes: e.payloadBytes } } })
    expect(f.sink.idempotencyEntries).toBe(1)
  })
  it('rejects unbound keys and corrupt bytes before acceptance', async () => {
    const f = setup(), e = publishEnvelope(await proposed(f))
    expect(await f.sink.publish(e, { idempotencyKey: 'unbound-inert-key', attempt: 1 })).toEqual({ status: 'rejected' })
    expect(await f.sink.publish({ ...e, payloadBytes: 'corrupt' }, { idempotencyKey: e.idempotencyKey, attempt: 1 })).toEqual({ status: 'rejected' })
    expect(f.sink.acceptedPublications()).toEqual([])
  })
  it.each(['adapterId', 'scope', 'reader'] as const)('does not route a publication to a different %s', async (field) => {
    const f = setup(), e = publishEnvelope(await proposed(f))
    const wrong = publishEnvelope(alter(e, { destination: { ...e.destination, [field]: 'foreign' } }))
    expect(await f.sink.publish(wrong, { idempotencyKey: wrong.idempotencyKey, attempt: 1 })).toEqual({ status: 'forbidden' })
    expect(f.sink.acceptedPublications()).toEqual([])
  })
  it.each(['adapterId', 'scope', 'reader'] as const)('binds the actual reader to exact %s without existence/content leaks', async (field) => {
    const f = setup(), { publication } = await accepted(f)
    const foreign = f.sink.bindReader({ ...fixtureDestination, [field]: 'foreign' })
    expect(await foreign.read(publication)).toEqual({ status: 'forbidden' })
    expect(await foreign.read({ ...publication, destination: foreign.destination })).toEqual({ status: 'forbidden' })
    expect(await f.sink.reader.read({ ...publication, destination: foreign.destination })).toEqual({ status: 'forbidden' })
    expect(f.sink.reads.slice(-3).map((r) => r.status)).toEqual(['forbidden', 'forbidden', 'forbidden'])
  })
  it('separates pending acceptance, acknowledgment, empty projection and actual visibility', async () => {
    const f = setup(), e = publishEnvelope(await proposed(f))
    f.sink.script('publish', { reply: 'pending', project: false })
    expect(await f.sink.publish(e, { idempotencyKey: e.idempotencyKey, attempt: 1 })).toEqual({ status: 'pending' })
    const publication = f.sink.acceptedPublications()[0]!.publication
    expect(await f.sink.verifyVisibility(publication)).toEqual({ status: 'empty' })
    expect(await f.sink.verifyAbsence(publication)).toEqual({ status: 'pending' })
    expect(await f.sink.publish(e, { idempotencyKey: e.idempotencyKey, attempt: 2 })).toEqual({ status: 'acknowledged', publication })
    expect(await f.sink.verifyVisibility(publication)).toEqual({ status: 'empty' })
    f.sink.projectPublication(publication)
    expect(await f.sink.verifyVisibility(publication)).toEqual({ status: 'visible', publication })
    expect(f.sink.reads.map((r) => r.status)).toEqual(['empty', 'empty', 'empty', 'found'])
  })
  it.each(['forbidden', 'degraded', 'unsupported'] as const)('distinguishes %s read failure from empty or proof', async (status) => {
    const f = setup(), { publication } = await accepted(f)
    f.sink.readerAccess = status
    expect(await f.sink.verifyVisibility(publication)).toEqual({ status })
    expect(await f.sink.verifyAbsence(publication)).toEqual({ status })
    expect(f.sink.reads.slice(-2).map((r) => r.status)).toEqual([status, status])
  })
  it('rejects mismatched hashes and never calls unknown or invisible publications absent cleanup', async () => {
    const f = setup(), { publication } = await accepted(f)
    expect(await f.sink.verifyVisibility({ ...publication, payloadSha256: 'wrong' })).toEqual({ status: 'conflict' })
    expect(await f.sink.verifyAbsence({ ...publication, payloadSha256: 'wrong' })).toEqual({ status: 'conflict' })
    expect(await f.sink.verifyAbsence({ ...publication, version: 'unknown-version' })).toEqual({ status: 'pending' })
  })
  it('requires actual read after exact retraction and preserves a newer same-source publication', async () => {
    const f = setup(), { e: old, publication } = await accepted(f)
    f.source.snapshot = fixtureSnapshot('revision-two', 'newer inert revision')
    const newer = publishEnvelope(await proposed(f))
    const newerAck = await f.sink.publish(newer, { idempotencyKey: newer.idempotencyKey, attempt: 1 })
    if (newerAck.status !== 'acknowledged') throw new Error('expected newer ack')
    expect(newerAck.publication.publicationId).toBe(publication.publicationId)
    expect(newerAck.publication.version).not.toBe(publication.version)
    const retract = cleanup(old, publication)
    f.sink.script('retract', { project: false })
    expect(await f.sink.retract(retract, { idempotencyKey: retract.idempotencyKey, attempt: 1 })).toEqual({ status: 'acknowledged', publication })
    expect(f.sink.acceptedPublications().map((r) => r.publication)).toEqual([newerAck.publication])
    expect(await f.sink.verifyAbsence(publication)).toEqual({ status: 'present' })
    f.sink.projectRetraction(publication)
    const reads = f.sink.reads.length
    expect(await f.sink.verifyAbsence(publication)).toEqual({ status: 'absent', publication })
    expect(f.sink.reads).toHaveLength(reads + 1)
    expect(f.sink.reads.at(-1)?.status).toBe('empty')
    expect(await f.sink.retract(retract, { idempotencyKey: retract.idempotencyKey, attempt: 2 })).toEqual({ status: 'acknowledged', publication })
    // a delayed duplicate publish receipt must not resurrect an already retracted version.
    expect(await f.sink.publish(old, { idempotencyKey: old.idempotencyKey, attempt: 3 })).toEqual({ status: 'acknowledged', publication })
    expect(await f.sink.reader.read(publication)).toEqual({ status: 'empty' })
    expect(await f.sink.verifyVisibility(newerAck.publication)).toEqual({ status: 'visible', publication: newerAck.publication })
    expect(f.sink.idempotencyEntries).toBe(3)
  })
  it.each(['payloadSha256', 'version', 'publicationId', 'sourceRef', 'envelopeId'] as const)('rejects retraction with a mismatched target %s', async (field) => {
    const f = setup(), { e, publication } = await accepted(f)
    const valid = cleanup(e, publication)
    const target = field === 'sourceRef' ? { ...valid.target, sourceRef: { ...valid.target.sourceRef, revision: 'wrong' } }
      : field === 'envelopeId' ? { ...valid.target, envelopeId: 'wrong' }
        : { ...valid.target, publication: { ...publication, [field]: 'wrong' } }
    const wrong = alter(valid, { target })
    if (wrong.operation !== 'retract') throw new Error('expected retract')
    expect(await f.sink.retract(wrong, { idempotencyKey: wrong.idempotencyKey, attempt: 1 })).toEqual({ status: 'conflict' })
    expect(await f.sink.verifyVisibility(publication)).toEqual({ status: 'visible', publication })
  })
  it('conflicts on duplicate retraction key with different reason without affecting any publication', async () => {
    const f = setup(), { e, publication } = await accepted(f), r = cleanup(e, publication)
    await f.sink.retract(r, { idempotencyKey: r.idempotencyKey, attempt: 1 })
    const wrong = alter(r, { reason: 'conflicting reason' })
    if (wrong.operation !== 'retract') throw new Error('expected retract')
    expect(await f.sink.retract(wrong, { idempotencyKey: r.idempotencyKey, attempt: 2 })).toEqual({ status: 'conflict' })
    expect(await f.sink.verifyAbsence(publication)).toEqual({ status: 'absent', publication })
    expect(f.sink.idempotencyEntries).toBe(2)
  })
  it.each(['forbidden', 'degraded', 'unsupported', 'conflict'] as const)('does not accept a scripted %s delivery', async (reply) => {
    const f = setup(), e = publishEnvelope(await proposed(f))
    f.sink.script('publish', { reply })
    expect(await f.sink.publish(e, { idempotencyKey: e.idempotencyKey, attempt: 1 })).toEqual({ status: reply })
    expect(f.sink.acceptedPublications()).toEqual([])
  })
})
