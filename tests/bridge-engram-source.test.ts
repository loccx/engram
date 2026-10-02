import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngramSourcePort, ENGRAM_SOURCE_PROVIDER } from '../src/bridge/adapters/index.js'
import type { EngramSourceOptions } from '../src/bridge/adapters/index.js'
import { normalizeSnapshot, sha256, snapshotProjection } from '../src/bridge/index.js'
import { withCaller } from '../src/memory/access.js'
import type { CallerScope, Verb } from '../src/memory/access.js'
import { available, engramFixture, engramLocator, engramNamespace, inertAlice, inertBob,
  linkEpisode, seedEpisode, seedMemory, setVerbs, supersede } from './fixtures/bridge-engram-db.js'
import type { EngramFixture } from './fixtures/bridge-engram-db.js'

describe('EngramSourcePort over real synthetic migrated source rows', () => {
  let f: EngramFixture
  beforeEach(() => { f = engramFixture() })
  afterEach(() => { vi.restoreAllMocks(); f.db.close() })

  it('exports the stable SourcePort shape with an explicit immutable identity, not a display name', async () => {
    expect(ENGRAM_SOURCE_PROVIDER).toBe('engram')
    expect(f.source.requester.principalId).toBe(`engram:principal:${JSON.stringify(inertAlice)}`)
    f.caller.name = 'engram:local-owner'
    f.caller.principalId = inertBob
    const snapshot = available(await f.source.resolveCurrent(engramLocator))
    expect(snapshot.ref).toMatchObject(engramLocator)
    expect(snapshot.content).toBe('curated inert Engram content')
    expect(snapshot.contentType).toBe('text/plain')
    expect(snapshot.tags).toEqual(['inert', 'bridge'])
    expect(snapshot.provenance[0].provider).toBe('engram:episode')
    expect(f.source.requester.principalId).toBe(`engram:principal:${JSON.stringify(inertAlice)}`)
    expect(Object.isFrozen(f.source.requester)).toBe(true)
  })

  it('requires explicit coherent caller input; no omitted or ambiguous local-owner fallback', () => {
    expect(() => new EngramSourcePort(f.db, undefined as unknown as EngramSourceOptions)).toThrow('CallerScope')
    for (const caller of [
      { ...f.caller, principalId: null }, { ...f.caller, localOwner: true },
      { ...f.caller, principalId: '' }, { ...f.caller, grants: [{ prefix: '', verbs: ['read', 'share'] }] },
    ]) expect(() => new EngramSourcePort(f.db, { caller: caller as CallerScope })).toThrow()
  })

  it('local owner is explicit and distinct from a named principal with that display name or id', async () => {
    const owner = new EngramSourcePort(f.db, { caller: { principalId: null, name: 'anything', localOwner: true, grants: [] }, now: f.clock.now })
    expect(owner.requester.principalId).toBe('engram:local-owner')
    f.db.prepare('UPDATE memories SET owner_principal = NULL, visibility = ?').run('personal')
    expect((await owner.resolveCurrent(engramLocator)).status).toBe('available')
    expect((await f.source.resolveCurrent(engramLocator)).status).toBe('not_found')
    f.db.prepare('UPDATE memories SET owner_principal = ?').run(inertAlice)
    expect((await owner.resolveCurrent(engramLocator)).status).toBe('not_found')
    f.db.prepare('INSERT INTO principals (id, name, created_at) VALUES (?, ?, 1)').run('engram:local-owner', 'inert alias')
    const alias = new EngramSourcePort(f.db, { caller: { ...f.caller, principalId: 'engram:local-owner' } })
    expect(alias.requester.principalId).not.toBe(owner.requester.principalId)
  })

  it.each(([['read'], ['share'], []] as Verb[][]).map((verbs) => [verbs]))('requires both original read and share grants: %j', async (verbs) => {
    const source = new EngramSourcePort(f.db, { caller: { ...f.caller, grants: [{ prefix: engramNamespace, verbs }] } })
    const prepare = vi.spyOn(f.db, 'prepare')
    expect(await source.resolveCurrent(engramLocator)).toEqual({ status: 'forbidden' })
    expect(prepare.mock.calls.every(([sql]) => !sql.includes('FROM memories'))).toBe(true)
  })

  it.each(([['read'], ['share'], []] as Verb[][]).map((verbs) => [verbs]))('refreshes current grants and refuses revocation: %j', async (verbs) => {
    const ref = available(await f.source.resolveCurrent(engramLocator)).ref
    setVerbs(f, verbs)
    expect(await f.source.readExact(ref)).toEqual({ status: 'forbidden' })
  })

  it('fails closed when grants disappear or the principal is disabled/deleted after construction', async () => {
    const ref = available(await f.source.resolveCurrent(engramLocator)).ref
    f.db.prepare('DELETE FROM grants WHERE principal_id = ?').run(inertAlice)
    expect(await f.source.readExact(ref)).toEqual({ status: 'forbidden' })
    f.db.prepare('INSERT INTO grants VALUES (?, ?, ?, 1)').run(inertAlice, engramNamespace, 'read,share')
    f.db.prepare('UPDATE principals SET disabled_at = ? WHERE id = ?').run(f.clock.time, inertAlice)
    expect(await f.source.readExact(ref)).toEqual({ status: 'forbidden' })
    f.db.prepare('DELETE FROM principals WHERE id = ?').run(inertAlice)
    expect(await f.source.readExact(ref)).toEqual({ status: 'forbidden' })
  })

  it('a changed current grant prefix cannot keep a previously authorized exact ref readable', async () => {
    const ref = available(await f.source.resolveCurrent(engramLocator)).ref
    f.db.prepare('UPDATE grants SET namespace_prefix = ? WHERE principal_id = ?').run('/fixture/unrelated', inertAlice)
    expect(await f.source.readExact(ref)).toEqual({ status: 'forbidden' })
  })

  it('current grants cannot widen the original host-bound scope', async () => {
    const source = new EngramSourcePort(f.db, { caller: { ...f.caller, grants: [{ prefix: `${engramNamespace}/narrow`, verbs: ['read', 'share'] }] } })
    expect(await source.resolveCurrent(engramLocator)).toEqual({ status: 'forbidden' })
    f.db.prepare('UPDATE grants SET namespace_prefix = ? WHERE principal_id = ?').run('/', inertAlice)
    expect(await source.resolveCurrent(engramLocator)).toEqual({ status: 'forbidden' })
  })

  it('neither ambient local owner nor ambient other caller changes the bound caller', async () => {
    f.db.prepare('UPDATE memories SET owner_principal = ?, visibility = ?').run(inertBob, 'personal')
    const owner: CallerScope = { principalId: null, name: 'owner', localOwner: true, grants: [] }
    expect(await withCaller(owner, () => f.source.resolveCurrent(engramLocator))).toEqual({ status: 'not_found' })
    expect(await withCaller({ ...f.caller, principalId: inertBob }, () => f.source.resolveCurrent(engramLocator))).toEqual({ status: 'not_found' })
  })

  it.each([
    { ...engramLocator, provider: 'other-source' }, { ...engramLocator, namespace: '/fixture/engram-sibling' },
    { ...engramLocator, namespace: '/fixture' }, { ...engramLocator, namespace: 'relative' }, { ...engramLocator, sourceId: '' },
  ])('refuses mismatched routing/scope before any memory lookup: %j', async (locator) => {
    const prepare = vi.spyOn(f.db, 'prepare')
    expect(await f.source.resolveCurrent(locator)).toEqual({ status: 'forbidden' })
    expect(await f.source.readExact({ ...locator, revision: 'inert-revision' })).toEqual({ status: 'forbidden' })
    expect(prepare.mock.calls.every(([sql]) => !sql.includes('FROM memories'))).toBe(true)
  })

  it('exact id/namespace/visibility probes are indistinguishable, including invisible lifecycle', async () => {
    seedMemory(f.db, { id: 'foreign', namespace: `${engramNamespace}/child`, content: 'foreign marker' })
    seedMemory(f.db, { id: 'personal', owner: inertBob, visibility: 'personal', archivedAt: 1, content: 'private marker' })
    f.db.prepare('UPDATE memories SET tags = ? WHERE id = ?').run('malformed JSON', 'personal')
    for (const id of ['missing', 'foreign', 'personal']) {
      expect(await f.source.resolveCurrent({ ...engramLocator, sourceId: id })).toEqual({ status: 'not_found' })
      expect(await f.source.readExact({ ...engramLocator, sourceId: id, revision: 'inert' })).toEqual({ status: 'not_found' })
    }
    expect(await f.source.readExact({ ...engramLocator, namespace: `${engramNamespace}/child`, revision: 'inert' })).toEqual({ status: 'not_found' })
    expect(f.db.prepare('SELECT * FROM read_audit').all()).toEqual([])
  })

  it('visibility is separate from grants, while an owned personal row remains source-eligible', async () => {
    f.db.prepare('UPDATE memories SET visibility = ?').run('personal')
    expect((await f.source.resolveCurrent(engramLocator)).status).toBe('available')
    f.db.prepare('UPDATE memories SET owner_principal = ?').run(inertBob)
    expect(await f.source.resolveCurrent(engramLocator)).toEqual({ status: 'not_found' })
    f.db.prepare('UPDATE memories SET visibility = ?').run('project')
    expect((await f.source.resolveCurrent(engramLocator)).status).toBe('available')
  })

  it('requires explicit source shareability even for readable pinned content', async () => {
    f.db.prepare('UPDATE memories SET pinned = 1, shareable = 0').run()
    expect(await f.source.resolveCurrent(engramLocator)).toEqual({ status: 'forbidden' })
  })

  it('verifies shared canonical hashes, immutable copy and capture-time-independent revision/projection', async () => {
    const a = available(await f.source.resolveCurrent(engramLocator))
    expect(a.contentSha256).toBe(sha256(a.content))
    expect(a.projectionSha256).toBe(sha256(snapshotProjection(a)))
    expect(normalizeSnapshot(a)).toEqual(a)
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(a.tags)).toBe(true)
    expect(Object.isFrozen(a.ref)).toBe(true)
    expect(Object.isFrozen(a.provenance[0])).toBe(true)
    f.clock.time++
    const b = available(await f.source.readExact(a.ref))
    expect(b.capturedAt).not.toBe(a.capturedAt)
    expect(b.ref).toEqual(a.ref)
    expect(b.projectionSha256).toBe(a.projectionSha256)
    f.db.prepare('UPDATE memories SET content = ?').run('later content')
    expect(a.content).toBe('curated inert Engram content')
  })

  it('unrepresented access, embedding, importance and pin metadata does not change the revision', async () => {
    const a = available(await f.source.resolveCurrent(engramLocator))
    f.db.prepare('UPDATE memories SET access_count = 12, last_accessed = 42, pinned = 1, importance = 0.9, embed_state = ?').run('stale')
    const b = available(await f.source.readExact(a.ref))
    expect(b.ref).toEqual(a.ref)
    expect(b.projectionSha256).toBe(a.projectionSha256)
  })

  it.each([
    ['content', "UPDATE memories SET content = 'changed content'"],
    ['tags', `UPDATE memories SET tags = '["changed tag"]'`],
    ['type', "UPDATE memories SET type = 'gotcha'"],
    ['state slot', "UPDATE memories SET state_key = 'changed slot'"],
    ['origin', "UPDATE memories SET origin = 'revision'"],
    ['valid from', 'UPDATE memories SET valid_from = 2'],
    ['valid until', 'UPDATE memories SET valid_until = 5000'],
    ['row visibility', "UPDATE memories SET visibility = 'team'"],
    ['shared owner', `UPDATE memories SET owner_principal = '${inertBob}'`],
  ])('represented %s mutation invalidates exact read', async (_name, sql) => {
    const a = available(await f.source.resolveCurrent(engramLocator))
    f.db.exec(sql)
    expect(await f.source.readExact(a.ref)).toEqual({ status: 'changed' })
    expect(available(await f.source.resolveCurrent(engramLocator)).ref.revision).not.toBe(a.ref.revision)
  })

  it.each([
    ['archive', 'UPDATE memories SET archived_at = 1', 'retired'],
    ['inclusive expiry', 'UPDATE memories SET valid_until = 1000', 'retired'],
    ['future state', 'UPDATE memories SET valid_from = 1001', 'retired'],
    ['delete', 'DELETE FROM memories', 'not_found'],
    ['withdraw shareability', 'UPDATE memories SET shareable = 0', 'forbidden'],
    ['private owner change', `UPDATE memories SET visibility = 'personal', owner_principal = '${inertBob}'`, 'not_found'],
    ['namespace change', "UPDATE memories SET namespace = '/fixture/other'", 'not_found'],
  ])('%s refuses both current and previously approved exact ref', async (_name, sql, status) => {
    const ref = available(await f.source.resolveCurrent(engramLocator)).ref
    f.db.exec(sql)
    expect(await f.source.readExact(ref)).toEqual({ status })
    expect(await f.source.resolveCurrent(engramLocator)).toEqual({ status })
  })

  it('expiry is inclusive at the clock boundary, independently of capture time', async () => {
    f.db.prepare('UPDATE memories SET valid_until = 1001').run()
    const ref = available(await f.source.resolveCurrent(engramLocator)).ref
    f.clock.time = 1001
    expect(await f.source.readExact(ref)).toEqual({ status: 'retired' })
  })

  it('concrete id refuses synthetic revision and never follows a foreign/private supersedes link', async () => {
    const ref = available(await f.source.resolveCurrent(engramLocator)).ref
    seedMemory(f.db, { id: 'revision-successor', content: 'revision marker' })
    supersede(f, 'revision-successor')
    expect(await f.source.resolveCurrent(engramLocator)).toEqual({ status: 'retired' })
    expect(await f.source.readExact(ref)).toEqual({ status: 'retired' })
    const current = available(await f.source.resolveCurrent({ ...engramLocator, sourceId: 'revision-successor' }))
    expect(current.ref.sourceId).toBe('revision-successor')
    f.db.prepare('UPDATE memories SET namespace = ?, owner_principal = ?, visibility = ? WHERE id = ?')
      .run('/fixture/foreign', inertBob, 'personal', 'revision-successor')
    expect(await f.source.resolveCurrent(engramLocator)).toEqual({ status: 'retired' })
    expect(await f.source.resolveCurrent({ ...engramLocator, sourceId: 'revision-successor' })).toEqual({ status: 'not_found' })
  })

  it('supersession reversal cannot retain an approval on the newly retired concrete successor', async () => {
    seedMemory(f.db, { id: 'inert-successor' })
    supersede(f, 'inert-successor')
    const ref = available(await f.source.resolveCurrent({ ...engramLocator, sourceId: 'inert-successor' })).ref
    f.db.prepare('DELETE FROM memory_links WHERE source_id = ?').run('inert-successor')
    supersede(f, engramLocator.sourceId, 'inert-successor')
    expect(await f.source.readExact(ref)).toEqual({ status: 'retired' })
    expect((await f.source.resolveCurrent(engramLocator)).status).toBe('available')
  })

  it('returns degraded without bytes or SQL details for malformed source tags / unavailable schema', async () => {
    f.db.prepare('UPDATE memories SET tags = ?').run('{bad inert JSON')
    expect(await f.source.resolveCurrent(engramLocator)).toEqual({ status: 'degraded' })
    f.db.exec('DROP TABLE grants')
    expect(await f.source.resolveCurrent(engramLocator)).toEqual({ status: 'degraded' })
  })

  it('reads and refusals leave the entire source DB dump unchanged, including cross-owner audit and cold/archive telemetry', async () => {
    f.db.prepare('UPDATE memories SET owner_principal = ?').run(inertBob)
    seedMemory(f.db, { id: 'archived', archivedAt: 1 })
    seedMemory(f.db, { id: 'private', visibility: 'personal', owner: inertBob })
    const before = f.db.serialize()
    const ref = available(await f.source.resolveCurrent(engramLocator)).ref
    await f.source.readExact(ref)
    await f.source.readExact({ ...ref, revision: 'changed-inert' })
    for (const id of ['archived', 'private', 'missing']) await f.source.resolveCurrent({ ...engramLocator, sourceId: id })
    await f.source.resolveCurrent({ ...engramLocator, namespace: '/denied' })
    expect(f.db.serialize()).toEqual(before)
  })
})

describe('Engram evidence projection authorization and binding', () => {
  let f: EngramFixture
  beforeEach(() => { f = engramFixture() })
  afterEach(() => { f.db.close() })

  it('only selects visible, same-namespace, unexpired evidence; unknown/deleted/private/foreign links add no bytes', async () => {
    for (const input of [
      { id: 'private', owner: inertBob, visibility: 'personal', content: 'private marker' },
      { id: 'foreign', namespace: `${engramNamespace}/child`, content: 'foreign marker' },
      { id: 'expired', expiresAt: f.clock.time, content: 'expired marker' },
      { id: 'own-personal', owner: inertAlice, visibility: 'personal', content: 'owned evidence' },
    ]) linkEpisode(f.db, seedEpisode(f.db, input))
    const removed = seedEpisode(f.db, { id: 'removed', content: 'removed marker' })
    linkEpisode(f.db, removed)
    f.db.prepare('DELETE FROM episodes WHERE id = ?').run(removed)
    // deliberately malformed legacy dangling citation: existing production FK normally forbids it.
    f.db.pragma('foreign_keys = OFF')
    linkEpisode(f.db, 'unknown-inert-episode')
    f.db.pragma('foreign_keys = ON')
    const before = f.db.serialize()
    const snapshot = available(await f.source.resolveCurrent(engramLocator))
    expect(snapshot.provenance.map((e) => e.evidenceId)).toEqual(['inert-episode', 'own-personal'])
    expect(JSON.stringify(snapshot)).not.toMatch(/private marker|foreign marker|expired marker|removed marker|unknown-inert/)
    expect(f.db.serialize()).toEqual(before)
  })

  it('selects a bounded linked excerpt and stores URI as metadata without accessing it', async () => {
    f.db.prepare('DELETE FROM memory_episodes').run()
    f.db.prepare('UPDATE episodes SET content = ?, uri = ?').run(`skip ${'x'.repeat(700)} end`, 'file:///inert/nonexistent/do-not-read')
    linkEpisode(f.db, 'inert-episode', 5, 705)
    const snapshot = available(await f.source.resolveCurrent(engramLocator))
    expect(snapshot.provenance[0].excerpt).toBe('x'.repeat(512))
    expect(snapshot.provenance[0].uri).toBe('file:///inert/nonexistent/do-not-read')
  })

  it.each([
    ['excerpt', "UPDATE episodes SET content = 'changed evidence'"],
    ['uri metadata', "UPDATE episodes SET uri = 'https://inert.invalid/changed'"],
    ['expiry metadata', 'UPDATE episodes SET expires_at = 5000'],
    ['expired evidence', 'UPDATE episodes SET expires_at = 1000'],
    ['private evidence', `UPDATE episodes SET owner_principal = '${inertBob}', visibility = 'personal'`],
    ['foreign evidence', "UPDATE episodes SET namespace = '/fixture/other'"],
    ['deleted evidence', 'DELETE FROM episodes'],
    ['removed citation', 'DELETE FROM memory_episodes'],
    ['span metadata', 'UPDATE memory_episodes SET span_start = 1'],
    ['retention metadata', "UPDATE episodes SET retention = 'ephemeral'"],
  ])('%s mutation invalidates previously represented evidence', async (_name, sql) => {
    const ref = available(await f.source.resolveCurrent(engramLocator)).ref
    f.db.exec(sql)
    expect(await f.source.readExact(ref)).toEqual({ status: 'changed' })
  })

  it('evidence expires inclusively and its removal invalidates exact read', async () => {
    f.db.prepare('UPDATE episodes SET expires_at = 1001').run()
    const ref = available(await f.source.resolveCurrent(engramLocator)).ref
    f.clock.time = 1001
    expect(await f.source.readExact(ref)).toEqual({ status: 'changed' })
  })

  it('does not bind unrepresented raw episode tails or arbitrary provenance JSON', async () => {
    f.db.prepare('UPDATE episodes SET content = ?').run('x'.repeat(512) + 'unrepresented tail')
    const ref = available(await f.source.resolveCurrent(engramLocator)).ref
    f.db.prepare('UPDATE episodes SET content = ?, provenance_json = ?').run('x'.repeat(512) + 'changed tail', '{"privateRaw":"not exported"}')
    expect((await f.source.readExact(ref)).status).toBe('available')
  })
})
