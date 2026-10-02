import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeCoordinator, BridgeStore, sha256, snapshotProjection } from '../src/bridge/index.js'
import type { BridgeEnvelope, DestinationRef, PublicationReceipt, PublishProposal } from '../src/bridge/index.js'
import { EngramSourcePort, ENGRAM_SOURCE_PROVIDER } from '../src/bridge/adapters/index.js'
import type { CallerScope } from '../src/memory/access.js'
import { migration026 } from '../src/db/migrations/026_bridge.js'
import { FixtureClock, InertAuthority, deferred, fixtureDestination } from './fixtures/bridge-core-ports.js'
import { DeterministicDestination, exerciseDestinationConformance } from './fixtures/bridge-destination.js'
import { available, engramFixture, engramLocator, engramNamespace, inertAlice, inertBob,
  linkEpisode, seedEpisode, seedMemory, supersede } from './fixtures/bridge-engram-db.js'

// actual migrated Engram rows and host-bound source; only authority and remote protocol are inert.
const databases: Database.Database[] = []
const directories: string[] = []
const proposal: PublishProposal = { source: engramLocator, destination: fixtureDestination,
  purpose: 'inert Engram complete-path proof', policyId: 'inert-policy', policyVersion: 'v1' }
function open(path = ':memory:'): Database.Database {
  const db = new Database(path)
  db.pragma('foreign_keys = ON')
  databases.push(db)
  return db
}
function connect(sourceDb: Database.Database, bridgeDb: Database.Database, trustedCallerScope: CallerScope,
  clock: FixtureClock, authority = new InertAuthority(), sink = new DeterministicDestination(fixtureDestination)) {
  const source = new EngramSourcePort(sourceDb, { caller: trustedCallerScope, now: clock.now })
  const store = new BridgeStore(bridgeDb, clock)
  const coordinator = new BridgeCoordinator({ store, source, requester: source.requester, verifier: authority })
  return { sourceDb, bridgeDb, source, store, coordinator, clock, authority, sink, trustedCallerScope }
}
function setup(colocated = false) {
  const f = engramFixture()
  databases.push(f.db)
  const bridgeDb = colocated ? f.db : open()
  if (!colocated) migration026.up(bridgeDb)
  return connect(f.db, bridgeDb, f.caller, f.clock)
}
type Integration = ReturnType<typeof connect>
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function queue(f: Integration, input: PublishProposal = proposal) {
  const envelope = await f.coordinator.proposePublish(input)
  const grant = f.authority.issue(envelope)
  await f.coordinator.approve(envelope.envelopeId, grant)
  f.coordinator.enqueue(envelope.envelopeId)
  return { envelope, grant }
}
async function publish(f: Integration, input: PublishProposal = proposal) {
  const { envelope, grant } = await queue(f, input)
  const result = await f.coordinator.drain(f.sink, { owner: 'inert-e2e-publish' })
  expect(result.completed).toEqual([{ envelopeId: envelope.envelopeId, state: 'acknowledged' }])
  return { envelope, grant, publication: receipt(f, envelope.envelopeId) }
}
function receipt(f: Integration, id: string): PublicationReceipt {
  const publication = f.store.getPublication(id)
  if (!publication) throw new Error('expected actual exact acknowledgement')
  return publication
}
async function queueRetraction(f: Integration, targetEnvelopeId: string) {
  const envelope = f.coordinator.proposeRetraction({ targetEnvelopeId, reason: 'inert exact cleanup',
    purpose: proposal.purpose, policyId: proposal.policyId, policyVersion: proposal.policyVersion })
  await f.coordinator.approve(envelope.envelopeId, f.authority.issue(envelope))
  f.coordinator.enqueue(envelope.envelopeId)
  return envelope
}
async function expectReaderBytes(f: Integration, envelope: BridgeEnvelope, publication: PublicationReceipt) {
  const read = await f.sink.reader.read(publication)
  expect(read.status).toBe('found')
  if (read.status !== 'found' || envelope.operation !== 'publish') throw new Error('expected real published reader bytes')
  expect(read.record.envelope).toEqual(envelope)
  expect(read.record.envelope.snapshot.ref).toEqual(envelope.snapshot.ref)
  expect(read.record.envelope.payloadBytes).toBe(envelope.payloadBytes)
  expect(sha256(read.record.envelope.payloadBytes)).toBe(publication.payloadSha256)
  expect(read.record.publication).toEqual(publication)
  expect(publication).toMatchObject({ version: envelope.envelopeId, payloadSha256: envelope.payloadSha256,
    destination: envelope.destination })
}

describe('actual local Engram source -> bridge -> inert destination -> bound reader -> exact cleanup', () => {
  it('derives complete-path visibility and tombstone-backed absence without mutating any source DB bytes', async () => {
    const f = setup()
    seedMemory(f.sourceDb, { id: 'foreign-memory', namespace: `${engramNamespace}/child`, content: 'foreign memory marker' })
    seedMemory(f.sourceDb, { id: 'private-memory', owner: inertBob, visibility: 'personal', content: 'private memory marker' })
    for (const input of [
      { id: 'private-evidence', owner: inertBob, visibility: 'personal', content: 'private evidence marker' },
      { id: 'foreign-evidence', namespace: `${engramNamespace}/child`, content: 'foreign evidence marker' },
    ]) linkEpisode(f.sourceDb, seedEpisode(f.sourceDb, input))
    f.sourceDb.prepare('UPDATE episodes SET provenance_json = ?').run('{"privateRaw":"raw evidence marker"}')
    const sourceBefore = f.sourceDb.serialize()
    expect(f.source.provider).toBe(ENGRAM_SOURCE_PROVIDER)
    expect(f.source.requester.principalId).toBe(`engram:principal:${JSON.stringify(inertAlice)}`)
    const stages: string[] = []
    const result = await exerciseDestinationConformance({ coordinator: f.coordinator, adapter: f.sink, proposal,
      grant: (envelope) => f.authority.issue(envelope), script: async (stage, envelope) => {
        stages.push(stage)
        const publication = receipt(f, envelope.envelopeId)
        if (stage === 'publish-acknowledged') {
          expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('acknowledged')
          expect(f.sink.reads).toEqual([])
          await expectReaderBytes(f, envelope, publication)
          expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('acknowledged')
          expect(await f.sink.verifyAbsence(publication)).toEqual({ status: 'present' })
        } else if (stage === 'retract-acknowledged') {
          expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('retract_acknowledged')
          expect(await f.sink.reader.read(publication)).toEqual({ status: 'empty' })
          expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('retract_acknowledged')
        }
      } })
    const publication = receipt(f, result.envelope.envelopeId)
    expect(result.publishDrain.completed).toEqual([{ envelopeId: result.envelope.envelopeId, state: 'acknowledged' }])
    expect(result.visibility).toEqual({ status: 'visible', publication })
    expect(result.retractDrain.completed).toEqual([{ envelopeId: result.retraction.envelopeId, state: 'retract_acknowledged' }])
    expect(result.absence).toEqual({ status: 'absent', publication })
    expect(stages).toEqual(['publish-acknowledged', 'publish-observed', 'retract-acknowledged', 'retract-observed'])
    if (result.envelope.operation !== 'publish' || result.retraction.operation !== 'retract') throw new Error('expected complete publish/retract path')
    const snapshot = result.envelope.snapshot
    expect(snapshot.ref).toMatchObject(engramLocator)
    expect(snapshot.ref.revision).toMatch(/^engram-memory\/v1:[a-f0-9]{64}$/)
    expect(snapshot.contentSha256).toBe(sha256(snapshot.content))
    expect(snapshot.projectionSha256).toBe(sha256(snapshotProjection(snapshot)))
    expect(snapshot.provenance.map((evidence) => evidence.evidenceId)).toEqual(['inert-episode'])
    expect(result.envelope.payloadBytes).not.toMatch(/private memory marker|foreign memory marker|private evidence marker|foreign evidence marker|raw evidence marker/)
    expect(result.retraction.target).toEqual({ envelopeId: result.envelope.envelopeId, sourceRef: snapshot.ref, publication })
    expect(f.store.getOutbox(result.envelope.envelopeId)?.state).toBe('visible')
    expect(f.store.getOutbox(result.retraction.envelopeId)?.state).toBe('retracted_verified')
    expect(f.sink.calls.map((call) => [call.operation, call.bytes])).toEqual([
      ['publish', result.envelope.payloadBytes], ['retract', result.retraction.payloadBytes],
    ])
    expect(f.sink.acceptedPublications()).toEqual([])
    expect(f.store.events(result.envelope.envelopeId).map((event) => event.type))
      .toEqual(['proposed', 'approved', 'queued', 'sending', 'delivery_started', 'acknowledged', 'visible'])
    expect(f.store.events(result.retraction.envelopeId).at(-1)?.type).toBe('retracted_verified')
    expect(f.sourceDb.serialize()).toEqual(sourceBefore)
  })

  it('shareable, pinned, source identity and even an exact inert grant do not override the default-deny verifier', async () => {
    const f = setup()
    f.sourceDb.prepare('UPDATE memories SET pinned = 1').run()
    const sourceBefore = f.sourceDb.serialize()
    const deny = new BridgeCoordinator({ store: f.store, source: f.source, requester: f.source.requester })
    const envelope = await deny.proposePublish(proposal)
    expect(() => deny.enqueue(envelope.envelopeId)).toThrow('approval required')
    await expect(deny.approve(envelope.envelopeId, f.authority.issue(envelope))).rejects.toThrow('authority denied')
    expect(() => deny.enqueue(envelope.envelopeId)).toThrow('approval required')
    expect((await deny.drain(f.sink, { owner: 'inert-denied' })).claimed).toBe(0)
    expect(f.store.getApproval(envelope.envelopeId)).toBeNull()
    expect(f.store.getOutbox(envelope.envelopeId)).toBeNull()
    expect(f.sink.calls).toEqual([])
    expect(f.sink.acceptedPublications()).toEqual([])
    expect(f.sourceDb.serialize()).toEqual(sourceBefore)
  })

  it.each(['payload', 'scope', 'reader'] as const)('a known grant for different %s cannot authorize a fresh real-source proposal', async (field) => {
    const f = setup(), original = await f.coordinator.proposePublish(proposal)
    const grant = f.authority.issue(original)
    const input = field === 'payload' ? { ...proposal, purpose: 'different inert purpose' }
      : { ...proposal, destination: { ...fixtureDestination, [field]: 'different inert binding' } }
    const envelope = await f.coordinator.proposePublish(input)
    expect(envelope.payloadSha256).not.toBe(original.payloadSha256)
    await expect(f.coordinator.approve(envelope.envelopeId, grant)).rejects.toThrow('authority denied')
    expect(() => f.coordinator.enqueue(envelope.envelopeId)).toThrow('approval required')
    expect((await f.coordinator.drain(f.sink, { owner: 'inert-wrong-grant' })).claimed).toBe(0)
    expect(f.store.getApproval(envelope.envelopeId)).toBeNull()
    expect(f.sink.acceptedPublications()).toEqual([])
    expect(f.sink.calls).toEqual([])
  })

  it.each(['adapterId', 'scope', 'reader'] as const)('actual published bytes are refused to a differently bound %s reader', async (field) => {
    const f = setup(), { envelope, publication } = await publish(f)
    const binding: DestinationRef = { ...fixtureDestination, [field]: 'wrong inert reader binding' }
    expect(await f.sink.bindReader(binding).read(publication)).toEqual({ status: 'forbidden' })
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('acknowledged')
    expect(f.sink.reads.at(-1)).toMatchObject({ destination: binding, status: 'forbidden' })
    await expectReaderBytes(f, envelope, publication)
    expect(await f.coordinator.verifyVisibility(envelope.envelopeId, f.sink)).toEqual({ status: 'visible', publication })
    const retraction = await queueRetraction(f, envelope.envelopeId)
    await f.coordinator.drain(f.sink, { owner: 'inert-reader-cleanup' })
    expect(await f.sink.bindReader(binding).read(publication)).toEqual({ status: 'forbidden' })
    expect(await f.coordinator.verifyRetraction(retraction.envelopeId, f.sink)).toEqual({ status: 'absent', publication })
  })

  it.each(['ungranted namespace', 'wrong exact namespace', 'foreign personal row', 'unshareable row', 'revoked share grant'] as const)
    ('%s cannot produce an outbound proposal or a reader-visible publication; refusals leave the entire source dump unchanged', async (kind) => {
      const f = setup()
      let input = proposal
      let error = 'source forbidden'
      if (kind === 'ungranted namespace') input = { ...proposal, source: { ...engramLocator, namespace: '/fixture/ungranted' } }
      else if (kind === 'wrong exact namespace') {
        input = { ...proposal, source: { ...engramLocator, namespace: `${engramNamespace}/child` } }
        error = 'source not_found'
      } else if (kind === 'foreign personal row') {
        f.sourceDb.prepare('UPDATE memories SET owner_principal = ?, visibility = ?').run(inertBob, 'personal')
        error = 'source not_found'
      } else if (kind === 'unshareable row') f.sourceDb.prepare('UPDATE memories SET shareable = 0').run()
      else f.sourceDb.prepare('UPDATE grants SET verbs = ? WHERE principal_id = ?').run('read', inertAlice)
      const sourceBefore = f.sourceDb.serialize()
      await expect(f.coordinator.proposePublish(input)).rejects.toThrow(error)
      expect((await f.coordinator.drain(f.sink, { owner: 'inert-source-denied' })).claimed).toBe(0)
      expect(f.bridgeDb.prepare('SELECT * FROM bridge_envelopes').all()).toEqual([])
      expect(f.sink.calls).toEqual([])
      expect(f.sink.acceptedPublications()).toEqual([])
      expect(f.sink.reads).toEqual([])
      expect(f.sourceDb.serialize()).toEqual(sourceBefore)
    })

  it.each(['content revision', 'share revocation'] as const)('final source preflight refuses %s changed during the verifier wait with zero destination I/O', async (kind) => {
    const f = setup(), { envelope } = await queue(f), entered = deferred(), release = deferred()
    f.authority.beforeRecheck = async () => { entered.resolve(); await release.promise; f.authority.beforeRecheck = undefined }
    const pending = f.coordinator.drain(f.sink, { owner: 'inert-source-authority-window' })
    await entered.promise
    if (kind === 'content revision') f.sourceDb.prepare('UPDATE memories SET content = ?').run('changed before actual destination call')
    else f.sourceDb.prepare('UPDATE grants SET verbs = ? WHERE principal_id = ?').run('read', inertAlice)
    const sourceBefore = f.sourceDb.serialize()
    release.resolve()
    expect((await pending).completed).toEqual([{ envelopeId: envelope.envelopeId, state: 'rejected' }])
    expect(f.sink.calls).toEqual([])
    expect(f.sink.acceptedPublications()).toEqual([])
    expect(f.sink.reads).toEqual([])
    expect(f.store.getPublication(envelope.envelopeId)).toBeNull()
    expect(f.store.hasDeliveryAttempt(envelope.envelopeId)).toBe(false)
    expect(f.store.getEnvelope(envelope.envelopeId)).toEqual(envelope)
    expect(f.sourceDb.serialize()).toEqual(sourceBefore)
  })

  it('requires real projected bytes for visibility and both exact tombstone and reader absence for cleanup', async () => {
    const f = setup()
    f.sink.script('publish', { project: false })
    const { envelope, publication } = await publish(f)
    expect(await f.sink.reader.read(publication)).toEqual({ status: 'empty' })
    expect(await f.sink.verifyAbsence(publication)).toEqual({ status: 'pending' })
    expect(await f.coordinator.verifyVisibility(envelope.envelopeId, f.sink)).toEqual({ status: 'empty' })
    expect(f.store.getOutbox(envelope.envelopeId)?.state).toBe('acknowledged')
    f.sink.projectPublication(publication)
    await expectReaderBytes(f, envelope, publication)
    expect(await f.coordinator.verifyVisibility(envelope.envelopeId, f.sink)).toEqual({ status: 'visible', publication })
    const retraction = await queueRetraction(f, envelope.envelopeId)
    f.sink.script('retract', { project: false })
    await f.coordinator.drain(f.sink, { owner: 'inert-delayed-cleanup' })
    expect(f.sink.acceptedPublications()).toEqual([])
    expect(await f.coordinator.verifyRetraction(retraction.envelopeId, f.sink)).toEqual({ status: 'present' })
    expect(f.store.getOutbox(retraction.envelopeId)?.state).toBe('retract_acknowledged')
    f.sink.projectRetraction(publication)
    expect(await f.sink.reader.read(publication)).toEqual({ status: 'empty' })
    expect(await f.coordinator.verifyRetraction(retraction.envelopeId, f.sink)).toEqual({ status: 'absent', publication })
    expect(f.store.getOutbox(retraction.envelopeId)?.state).toBe('retracted_verified')
  })
})

describe('real-source correction, retained history and explicit reopen/replay', () => {
  it.each(['same concrete id revision', 'explicit successor id'] as const)('a correction using %s requires fresh approval; old exact cleanup preserves newer local and remote content', async (kind) => {
    const f = setup(), old = await publish(f)
    expect(await f.coordinator.verifyVisibility(old.envelope.envelopeId, f.sink)).toEqual({ status: 'visible', publication: old.publication })
    const oldEvents = f.store.events(old.envelope.envelopeId)
    let locator = engramLocator
    if (kind === 'same concrete id revision') f.sourceDb.prepare('UPDATE memories SET content = ? WHERE id = ?').run('new corrected inert content', engramLocator.sourceId)
    else {
      const id = seedMemory(f.sourceDb, { id: 'inert-corrected-successor', content: 'new corrected inert content' })
      supersede({ db: f.sourceDb, clock: f.clock, caller: f.trustedCallerScope, source: f.source }, id)
      locator = { ...engramLocator, sourceId: id }
      expect(await f.source.resolveCurrent(engramLocator)).toEqual({ status: 'retired' })
    }
    const newer = await f.coordinator.proposePublish({ ...proposal, source: locator, supersedesEnvelopeId: old.envelope.envelopeId })
    if (newer.operation !== 'publish' || old.envelope.operation !== 'publish') throw new Error('expected actual source revisions')
    expect(newer.snapshot.content).toBe('new corrected inert content')
    expect(newer.snapshot.ref.revision).not.toBe(old.envelope.snapshot.ref.revision)
    await expect(f.coordinator.approve(newer.envelopeId, old.grant)).rejects.toThrow('authority denied')
    expect(() => f.coordinator.enqueue(newer.envelopeId)).toThrow('approval required')
    await f.coordinator.approve(newer.envelopeId, f.authority.issue(newer))
    f.coordinator.enqueue(newer.envelopeId)
    await f.coordinator.drain(f.sink, { owner: 'inert-corrected-publish' })
    const newPublication = receipt(f, newer.envelopeId)
    expect(newPublication.version).not.toBe(old.publication.version)
    if (kind === 'same concrete id revision') expect(newPublication.publicationId).toBe(old.publication.publicationId)
    expect(await f.coordinator.verifyVisibility(newer.envelopeId, f.sink)).toEqual({ status: 'visible', publication: newPublication })
    expect(f.sink.acceptedPublications()).toHaveLength(2)
    const sourceBefore = f.sourceDb.serialize(), retraction = await queueRetraction(f, old.envelope.envelopeId)
    if (retraction.operation !== 'retract') throw new Error('expected exact old retraction')
    expect(retraction.target).toEqual({ envelopeId: old.envelope.envelopeId, sourceRef: old.envelope.snapshot.ref, publication: old.publication })
    await f.coordinator.drain(f.sink, { owner: 'inert-old-cleanup' })
    expect(await f.coordinator.verifyRetraction(retraction.envelopeId, f.sink)).toEqual({ status: 'absent', publication: old.publication })
    expect(await f.sink.reader.read(old.publication)).toEqual({ status: 'empty' })
    await expectReaderBytes(f, newer, newPublication)
    expect(f.sink.acceptedPublications().map((record) => record.publication)).toEqual([newPublication])
    expect(available(await f.source.resolveCurrent(locator)).content).toBe('new corrected inert content')
    expect(f.store.getEnvelope(old.envelope.envelopeId)).toEqual(old.envelope)
    expect(f.store.events(old.envelope.envelopeId)).toEqual(oldEvents)
    expect(f.store.getOutbox(newer.envelopeId)?.state).toBe('visible')
    expect(f.store.events(newer.envelopeId).some((event) => event.type === 'supersedes')).toBe(true)
    expect(f.sourceDb.serialize()).toEqual(sourceBefore)
  })

  it('source deletion in the same migrated DB cannot cascade bridge proposals, grants, receipts or audit; separately approved cleanup still works', async () => {
    const f = setup(true), { envelope, publication } = await publish(f)
    await f.coordinator.verifyVisibility(envelope.envelopeId, f.sink)
    const retraction = await queueRetraction(f, envelope.envelopeId)
    const tables = ['bridge_envelopes', 'bridge_approvals', 'bridge_approval_events', 'bridge_events', 'bridge_outbox']
    const history = () => tables.map((table) => f.bridgeDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = history(), oldEvents = f.store.events(envelope.envelopeId), cleanupEvents = f.store.events(retraction.envelopeId)
    const oldApproval = f.store.getApproval(envelope.envelopeId), cleanupApproval = f.store.getApproval(retraction.envelopeId)
    f.sourceDb.prepare('DELETE FROM memories WHERE id = ?').run(engramLocator.sourceId)
    expect(await f.source.resolveCurrent(engramLocator)).toEqual({ status: 'not_found' })
    expect(history()).toEqual(before)
    const cleanup = new BridgeCoordinator({ store: f.store, requester: f.source.requester, verifier: f.authority })
    expect((await cleanup.drain(f.sink, { owner: 'inert-deleted-source-cleanup' })).completed)
      .toEqual([{ envelopeId: retraction.envelopeId, state: 'retract_acknowledged' }])
    expect(await cleanup.verifyRetraction(retraction.envelopeId, f.sink)).toEqual({ status: 'absent', publication })
    expect(await f.sink.reader.read(publication)).toEqual({ status: 'empty' })
    expect(f.store.getEnvelope(envelope.envelopeId)).toEqual(envelope)
    expect(f.store.getEnvelope(retraction.envelopeId)).toEqual(retraction)
    expect(f.store.getApproval(envelope.envelopeId)).toEqual(oldApproval)
    expect(f.store.getApproval(retraction.envelopeId)).toEqual(cleanupApproval)
    expect(f.store.getPublication(envelope.envelopeId)).toEqual(publication)
    expect(f.store.events(envelope.envelopeId)).toEqual(oldEvents)
    expect(f.store.events(retraction.envelopeId).slice(0, cleanupEvents.length)).toEqual(cleanupEvents)
    expect(f.store.events(retraction.envelopeId).at(-1)?.type).toBe('retracted_verified')
  })

  it.each(['publish', 'retract'] as const)('reopens synthetic source and bridge SQLite after accepted %s loses local completion, replaying identical approved bytes into the retained inert sink', async (operation) => {
    const dir = mkdtempSync(join(tmpdir(), 'be-')); directories.push(dir)
    const sourcePath = join(dir, 'source.db'), bridgePath = join(dir, 'bridge.db')
    const seed = engramFixture(); databases.push(seed.db)
    await seed.db.backup(sourcePath)
    seed.db.close()
    const sourceDb = open(sourcePath), bridgeDb = open(bridgePath)
    migration026.up(bridgeDb)
    const f = connect(sourceDb, bridgeDb, seed.caller, seed.clock)
    const sourceBefore = f.sourceDb.serialize()
    const envelope = operation === 'publish' ? (await queue(f)).envelope : await queueRetraction(f, (await publish(f)).envelope.envelopeId)
    const callsBefore = f.sink.calls.length, approval = f.store.getApproval(envelope.envelopeId)
    f.sink.script(operation, { afterAccept: async () => {
      f.sourceDb.close()
      f.bridgeDb.close()
      throw new Error('inert acceptance followed by lost local completion')
    } })
    await expect(f.coordinator.drain(f.sink, { owner: 'inert-lost-completion', leaseMs: 10 })).rejects.toThrow()
    expect(f.sink.calls).toHaveLength(callsBefore + 1)
    expect(f.sink.acceptedPublications()).toHaveLength(operation === 'publish' ? 1 : 0)
    expect(f.sink.reads).toEqual([])
    f.clock.time += 10
    const reopened = connect(open(sourcePath), open(bridgePath), seed.caller, f.clock, f.authority, f.sink)
    expect(reopened.source).not.toBe(f.source)
    expect(reopened.coordinator).not.toBe(f.coordinator)
    expect(reopened.sourceDb.serialize()).toEqual(sourceBefore)
    expect(reopened.store.getOutbox(envelope.envelopeId)?.state).toBe('sending')
    expect(reopened.store.getEnvelope(envelope.envelopeId)).toEqual(envelope)
    expect(reopened.store.getApproval(envelope.envelopeId)).toEqual(approval)
    expect(f.sink.calls).toHaveLength(callsBefore + 1)
    const result = await reopened.coordinator.drain(f.sink, { owner: 'inert-reopened', leaseMs: 100 })
    const state = operation === 'publish' ? 'acknowledged' : 'retract_acknowledged'
    expect(result.completed).toEqual([{ envelopeId: envelope.envelopeId, state }])
    expect(reopened.store.getOutbox(envelope.envelopeId)).toMatchObject({ state, attempt: 2, leaseGeneration: 2 })
    const deliveries = f.sink.calls.filter((call) => call.operation === operation)
    expect(deliveries.map((call) => [call.key, call.bytes, call.attempt])).toEqual([
      [envelope.idempotencyKey, envelope.payloadBytes, 1], [envelope.idempotencyKey, envelope.payloadBytes, 2],
    ])
    expect(f.sink.idempotencyEntries).toBe(operation === 'publish' ? 1 : 2)
    expect(reopened.store.events(envelope.envelopeId).filter((event) => event.type === state)).toHaveLength(1)
    expect(f.sink.reads).toEqual([])
    const publication = receipt(reopened, envelope.envelopeId)
    if (operation === 'publish') {
      await expectReaderBytes(reopened, envelope, publication)
      expect(await reopened.coordinator.verifyVisibility(envelope.envelopeId, f.sink)).toEqual({ status: 'visible', publication })
      expect(f.sink.acceptedPublications()).toHaveLength(1)
      const retraction = await queueRetraction(reopened, envelope.envelopeId)
      await reopened.coordinator.drain(f.sink, { owner: 'inert-replay-cleanup' })
      expect(await reopened.coordinator.verifyRetraction(retraction.envelopeId, f.sink)).toEqual({ status: 'absent', publication })
    } else {
      expect(await reopened.sink.reader.read(publication)).toEqual({ status: 'empty' })
      expect(await reopened.coordinator.verifyRetraction(envelope.envelopeId, f.sink)).toEqual({ status: 'absent', publication })
    }
    expect(f.sink.acceptedPublications()).toEqual([])
    expect(reopened.sourceDb.serialize()).toEqual(sourceBefore)
  })
})
