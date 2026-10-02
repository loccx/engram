import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BridgeCoordinator, BridgeStore } from '../src/bridge/index.js'
import { EngramSourcePort } from '../src/bridge/adapters/index.js'
import { InertAuthority, InertDestination, fixtureDestination } from './fixtures/bridge-core-ports.js'
import { engramFixture, engramLocator, inertAlice, inertBob, seedMemory, setVerbs, supersede } from './fixtures/bridge-engram-db.js'
import type { EngramFixture } from './fixtures/bridge-engram-db.js'

// this is the real Engram source seam -> core coordination over synthetic migrated DB rows.
// approval and destination are the existing explicitly inert fixtures, not production authority,
// live export or the parent's separate full reader/retraction integration acceptance.
describe('real Engram source port with core proposal/approval/queued-send revalidation', () => {
  let f: EngramFixture
  let store: BridgeStore
  let authority: InertAuthority
  let destination: InertDestination
  let coordinator: BridgeCoordinator
  beforeEach(() => {
    f = engramFixture()
    store = new BridgeStore(f.db, f.clock)
    authority = new InertAuthority()
    destination = new InertDestination()
    coordinator = new BridgeCoordinator({ store, source: f.source, requester: f.source.requester, verifier: authority })
  })
  afterEach(() => { f.db.close() })
  const proposal = () => coordinator.proposePublish({ source: engramLocator, destination: fixtureDestination,
    purpose: 'inert bridge source verification', policyId: 'inert-policy', policyVersion: 'v1' })

  it('shareable + pinned source rows do not confer approval; the core still defaults deny', async () => {
    f.db.prepare('UPDATE memories SET pinned = 1').run()
    const defaultDeny = new BridgeCoordinator({ store, source: f.source, requester: f.source.requester })
    const envelope = await defaultDeny.proposePublish({ source: engramLocator, destination: fixtureDestination,
      purpose: 'inert', policyId: 'inert-policy', policyVersion: 'v1' })
    expect(envelope.operation).toBe('publish')
    await expect(defaultDeny.approve(envelope.envelopeId, 'shareable-pinned-name-is-not-approval')).rejects.toThrow('authority denied')
    expect(store.getApproval(envelope.envelopeId)).toBeNull()
    expect(destination.calls).toEqual([])
  })

  it('explicit local-owner source eligibility still does not confer human approval', async () => {
    const ownerSource = new EngramSourcePort(f.db, { caller: { principalId: null, name: 'local owner', localOwner: true, grants: [] }, now: f.clock.now })
    const defaultDeny = new BridgeCoordinator({ store, source: ownerSource, requester: ownerSource.requester })
    const envelope = await defaultDeny.proposePublish({ source: engramLocator, destination: fixtureDestination,
      purpose: 'inert', policyId: 'inert-policy', policyVersion: 'v1' })
    await expect(defaultDeny.approve(envelope.envelopeId, 'local-owner-is-not-approval')).rejects.toThrow('authority denied')
    expect(store.getApproval(envelope.envelopeId)).toBeNull()
    expect(destination.calls).toEqual([])
  })

  it('a mismatched requester cannot construct the bound core coordinator', () => {
    expect(() => new BridgeCoordinator({ store, source: f.source, requester: { principalId: 'inert forged requester' }, verifier: authority }))
      .toThrow('source requester mismatch')
  })

  it('wrong provider and invisible source ids cannot create an outbound proposal', async () => {
    await expect(coordinator.proposePublish({ source: { ...engramLocator, provider: 'foreign' }, destination: fixtureDestination,
      purpose: 'inert', policyId: 'inert-policy', policyVersion: 'v1' })).rejects.toThrow('source provider mismatch')
    f.db.prepare('UPDATE memories SET owner_principal = ?, visibility = ?').run(inertBob, 'personal')
    await expect(proposal()).rejects.toThrow('source not_found')
    expect(f.db.prepare('SELECT * FROM read_audit').all()).toEqual([])
    expect(destination.calls).toEqual([])
  })

  it('an unchanged source remains stable across capture time and reaches only the inert destination', async () => {
    const envelope = await proposal()
    if (envelope.operation !== 'publish') throw new Error('expected inert publish proposal')
    await coordinator.approve(envelope.envelopeId, authority.issue(envelope))
    coordinator.enqueue(envelope.envelopeId)
    f.clock.time++
    const result = await coordinator.drain(destination, { owner: 'inert-drainer' })
    expect(result.completed).toEqual([{ envelopeId: envelope.envelopeId, state: 'acknowledged' }])
    expect(destination.calls).toHaveLength(1)
    expect(store.getEnvelope(envelope.envelopeId)).toEqual(envelope)
  })

  const mutations: Array<[string, (fixture: EngramFixture) => void]> = [
    ['content', ({ db }) => { db.prepare('UPDATE memories SET content = ?').run('mutated after approval') }],
    ['tags', ({ db }) => { db.prepare('UPDATE memories SET tags = ?').run('["mutated tag"]') }],
    ['lifecycle window', ({ db }) => { db.prepare('UPDATE memories SET valid_until = 5000').run() }],
    ['archive', ({ db }) => { db.prepare('UPDATE memories SET archived_at = 1').run() }],
    ['inclusive expiry', ({ db }) => { db.prepare('UPDATE memories SET valid_until = 1000').run() }],
    ['deleted memory', ({ db }) => { db.prepare('DELETE FROM memories').run() }],
    ['row invisibility', ({ db }) => { db.prepare('UPDATE memories SET owner_principal = ?, visibility = ?').run(inertBob, 'personal') }],
    ['namespace moved', ({ db }) => { db.prepare('UPDATE memories SET namespace = ?').run('/fixture/foreign') }],
    ['shareability revoked', ({ db }) => { db.prepare('UPDATE memories SET shareable = 0').run() }],
    ['read revoked', (fixture) => { setVerbs(fixture, ['share']) }],
    ['share revoked', (fixture) => { setVerbs(fixture, ['read']) }],
    ['principal disabled', ({ db }) => { db.prepare('UPDATE principals SET disabled_at = 1 WHERE id = ?').run(inertAlice) }],
    ['represented episode mutated', ({ db }) => { db.prepare('UPDATE episodes SET content = ?').run('changed represented evidence') }],
    ['represented episode expired', ({ db }) => { db.prepare('UPDATE episodes SET expires_at = 1000').run() }],
    ['represented episode deleted', ({ db }) => { db.prepare('DELETE FROM episodes').run() }],
    ['represented episode becomes private', ({ db }) => { db.prepare('UPDATE episodes SET visibility = ?, owner_principal = ?').run('personal', inertBob) }],
    ['synthetic revision', (fixture) => { seedMemory(fixture.db, { id: 'inert-new-version' }); supersede(fixture, 'inert-new-version') }],
    ['synthetic state reversal', (fixture) => {
      seedMemory(fixture.db, { id: 'inert-prior' })
      // the approved concrete row is retired by the restored prior state, never silently retargeted.
      supersede(fixture, 'inert-prior')
    }],
  ]
  it.each(mutations)('%s after explicit inert approval but before queued send is refused', async (_name, mutate) => {
    const envelope = await proposal()
    await coordinator.approve(envelope.envelopeId, authority.issue(envelope))
    coordinator.enqueue(envelope.envelopeId)
    mutate(f)
    const result = await coordinator.drain(destination, { owner: 'inert-drainer' })
    expect(result.completed).toEqual([{ envelopeId: envelope.envelopeId, state: 'rejected' }])
    expect(destination.calls).toEqual([])
    expect(store.getPublication(envelope.envelopeId)).toBeNull()
    expect(store.getEnvelope(envelope.envelopeId)).toEqual(envelope)
  })
})
