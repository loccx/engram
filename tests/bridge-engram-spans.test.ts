import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalJson, sha256, snapshotProjection } from '../src/bridge/index.js'
import type { SourcePort } from '../src/bridge/index.js'
import { available, engramFixture, engramLocator, engramNamespace, linkEpisode, seedEpisode } from './fixtures/bridge-engram-db.js'
import type { EngramFixture } from './fixtures/bridge-engram-db.js'

const content = 'inert-prefix-evidence'
type Endpoint = number | bigint | string | Buffer | null
type StorageClass = 'integer' | 'real' | 'text' | 'blob' | 'null'
interface SpanCase {
  name: string
  start: Endpoint
  end: Endpoint
  classes: [StorageClass, StorageClass]
}
const invalidSpans: SpanCase[] = [
  { name: 'fractional start', start: 1.5, end: null, classes: ['real', 'null'] },
  { name: 'fractional end', start: null, end: 5.5, classes: ['null', 'real'] },
  { name: 'fractional start and end', start: 1.5, end: 5.5, classes: ['real', 'real'] },
  { name: 'equal fractional endpoints', start: 1.5, end: 1.5, classes: ['real', 'real'] },
  { name: 'fractional numeric text', start: '1.5', end: '5.5', classes: ['real', 'real'] },
  { name: 'text start', start: 'inert-invalid-span', end: null, classes: ['text', 'null'] },
  { name: 'text end', start: null, end: 'inert-invalid-span', classes: ['null', 'text'] },
  { name: 'text start and end', start: 'inert-invalid-span', end: 'inert-invalid-span', classes: ['text', 'text'] },
  { name: 'partially numeric text start', start: '2-invalid', end: null, classes: ['text', 'null'] },
  { name: 'partially numeric text end', start: 2, end: '6-invalid', classes: ['integer', 'text'] },
  { name: 'blob start', start: Buffer.from('2'), end: null, classes: ['blob', 'null'] },
  { name: 'blob end', start: null, end: Buffer.from('6'), classes: ['null', 'blob'] },
  { name: 'negative start', start: -1, end: null, classes: ['integer', 'null'] },
  { name: 'negative end', start: null, end: -1, classes: ['null', 'integer'] },
  { name: 'negative start and end', start: -2, end: -1, classes: ['integer', 'integer'] },
  { name: 'reversed endpoints', start: 4, end: 3, classes: ['integer', 'integer'] },
  { name: 'start past content', start: content.length + 1, end: null, classes: ['integer', 'null'] },
  { name: 'end past content with null start', start: null, end: content.length + 1, classes: ['null', 'integer'] },
  { name: 'end past content with valid start', start: 2, end: content.length + 1, classes: ['integer', 'integer'] },
  { name: 'both endpoints past content', start: content.length + 1, end: content.length + 2, classes: ['integer', 'integer'] },
  { name: 'end past content with start at content end', start: content.length, end: content.length + 1, classes: ['integer', 'integer'] },
  { name: '32-bit-wrapping start', start: 4294967296, end: null, classes: ['integer', 'null'] },
  { name: '32-bit-wrapping end', start: 0, end: 4294967296, classes: ['integer', 'integer'] },
  { name: 'maximum SQLite integer start', start: 9223372036854775807n, end: null, classes: ['integer', 'null'] },
  { name: 'maximum SQLite integer end', start: null, end: 9223372036854775807n, classes: ['null', 'integer'] },
]
const validSpans: Array<SpanCase & { excerpt: string }> = [
  { name: 'both null prefix', start: null, end: null, classes: ['null', 'null'], excerpt: content },
  { name: 'null start and valid end', start: null, end: 5, classes: ['null', 'integer'], excerpt: 'inert' },
  { name: 'valid start and null end', start: 6, end: null, classes: ['integer', 'null'], excerpt: 'prefix-evidence' },
  { name: 'valid half-open span', start: 6, end: 12, classes: ['integer', 'integer'], excerpt: 'prefix' },
  { name: 'explicit full span', start: 0, end: content.length, classes: ['integer', 'integer'], excerpt: content },
  { name: 'integer-affinity numeric strings', start: '6', end: '12', classes: ['integer', 'integer'], excerpt: 'prefix' },
  { name: 'integer-affinity decimal strings', start: '6.0', end: '12.0', classes: ['integer', 'integer'], excerpt: 'prefix' },
  { name: 'empty span at zero', start: 0, end: 0, classes: ['integer', 'integer'], excerpt: '' },
  { name: 'null start and zero end', start: null, end: 0, classes: ['null', 'integer'], excerpt: '' },
  { name: 'empty interior span', start: 6, end: 6, classes: ['integer', 'integer'], excerpt: '' },
  { name: 'end exactly at content end', start: 13, end: content.length, classes: ['integer', 'integer'], excerpt: 'evidence' },
  { name: 'start exactly at content end with null end', start: content.length, end: null, classes: ['integer', 'null'], excerpt: '' },
  { name: 'both endpoints exactly at content end', start: content.length, end: content.length, classes: ['integer', 'integer'], excerpt: '' },
]

function setSpan(f: EngramFixture, start: Endpoint, end: Endpoint) {
  f.db.prepare('UPDATE memory_episodes SET span_start = ?, span_end = ?').run(start, end)
}
function expectStorageClasses(f: EngramFixture, classes: [StorageClass, StorageClass]) {
  const row = f.db.prepare('SELECT typeof(span_start) AS start, typeof(span_end) AS end FROM memory_episodes')
    .get() as { start: StorageClass; end: StorageClass }
  expect([row.start, row.end]).toEqual(classes)
}

describe('Engram linked evidence validates persisted spans before projection', () => {
  let f: EngramFixture
  let source: SourcePort
  beforeEach(() => {
    f = engramFixture()
    source = f.source
    f.db.prepare('UPDATE episodes SET content = ?').run(content)
  })
  afterEach(() => { f.db.close() })

  it.each(invalidSpans)('omits $name without degrading the authorized memory or changing the source DB', async ({ start, end, classes }) => {
    setSpan(f, start, end)
    expectStorageClasses(f, classes)
    const before = f.db.serialize()
    const snapshot = available(await source.resolveCurrent(engramLocator))
    expect(snapshot.content).toBe('curated inert Engram content')
    expect(snapshot.provenance).toEqual([])
    expect(snapshot.contentSha256).toBe(sha256(snapshot.content))
    expect(snapshot.projectionSha256).toBe(sha256(snapshotProjection(snapshot)))
    expect(available(await source.readExact(snapshot.ref))).toEqual(snapshot)
    expect(f.db.serialize()).toEqual(before)
  })

  it.each(validSpans)('preserves $name and capture-time-independent hashes without changing the source DB', async ({ start, end, classes, excerpt }) => {
    setSpan(f, start, end)
    expectStorageClasses(f, classes)
    const before = f.db.serialize()
    const snapshot = available(await source.resolveCurrent(engramLocator))
    expect(snapshot.provenance).toHaveLength(1)
    expect(snapshot.provenance[0]).toMatchObject({ provider: 'engram:episode', evidenceId: 'inert-episode', uri: null, excerpt })
    expect(snapshot.contentSha256).toBe(sha256(snapshot.content))
    expect(snapshot.projectionSha256).toBe(sha256(snapshotProjection(snapshot)))
    f.clock.time++
    const later = available(await source.readExact(snapshot.ref))
    expect(later).toEqual({ ...snapshot, capturedAt: f.clock.time })
    expect(f.db.serialize()).toEqual(before)
  })

  it.each([
    [null, null], [null, 0], [0, null], [0, 0],
  ] as Array<[number | null, number | null]>)('represents empty content with legitimate endpoints %s, %s as an empty excerpt', async (start, end) => {
    f.db.prepare('UPDATE episodes SET content = ?').run('')
    setSpan(f, start, end)
    const before = f.db.serialize()
    const snapshot = available(await source.resolveCurrent(engramLocator))
    expect(snapshot.provenance).toHaveLength(1)
    expect(snapshot.provenance[0].excerpt).toBe('')
    expect((await source.readExact(snapshot.ref)).status).toBe('available')
    expect(f.db.serialize()).toEqual(before)
  })

  it.each([
    [1, null], [null, 1], [0, 1], [1, 1],
  ] as Array<[number | null, number | null]>)('omits endpoints %s, %s that extend beyond empty content', async (start, end) => {
    f.db.prepare('UPDATE episodes SET content = ?').run('')
    setSpan(f, start, end)
    const before = f.db.serialize()
    expect(available(await source.resolveCurrent(engramLocator)).provenance).toEqual([])
    expect(f.db.serialize()).toEqual(before)
  })

  it.each([
    ['null prefix', null, null], ['open-ended span', 5, null], ['explicit span', 5, 705],
  ] as Array<[string, number | null, number | null]>)('keeps the 512-character bound for a %s', async (_name, start, end) => {
    f.db.prepare('UPDATE episodes SET content = ?').run(`skip ${'x'.repeat(700)} end`)
    setSpan(f, start, end)
    const before = f.db.serialize()
    const snapshot = available(await source.resolveCurrent(engramLocator))
    expect(snapshot.provenance[0].excerpt).toBe(start === null ? `skip ${'x'.repeat(507)}` : 'x'.repeat(512))
    expect(f.db.serialize()).toEqual(before)
  })

  it('uses SQLite character offsets, not UTF-16 units, bytes or normalized graphemes', async () => {
    f.db.prepare('UPDATE episodes SET content = ?').run('A😀e\u0301Z')
    setSpan(f, 1, 4)
    const before = f.db.serialize()
    const snapshot = available(await source.resolveCurrent(engramLocator))
    expect(snapshot.provenance[0].excerpt).toBe('😀e\u0301')
    expect(f.db.serialize()).toEqual(before)
    setSpan(f, 5, null)
    expect(available(await source.resolveCurrent(engramLocator)).provenance[0].excerpt).toBe('')
    setSpan(f, 6, null)
    expect(available(await source.resolveCurrent(engramLocator)).provenance).toEqual([])
  })

  it('caps supplementary characters at 512 SQLite characters without splitting them', async () => {
    f.db.prepare('UPDATE episodes SET content = ?').run(`A${'😀'.repeat(600)}Z`)
    setSpan(f, 1, 601)
    const before = f.db.serialize()
    const snapshot = available(await source.resolveCurrent(engramLocator))
    expect(snapshot.provenance[0].excerpt).toBe('😀'.repeat(512))
    expect(Array.from(snapshot.provenance[0].excerpt!).length).toBe(512)
    expect(f.db.serialize()).toEqual(before)
  })

  it('keeps the represented evidence row and revision/hash preimages unchanged for a valid span', async () => {
    setSpan(f, 6, 12)
    const row = f.db.prepare(`SELECT e.id, e.uri, e.owner_principal, e.visibility, e.expires_at, e.retention,
      me.span_start, me.span_end FROM memory_episodes me JOIN episodes e ON e.id = me.episode_id`).get() as Record<string, unknown>
    const memory = f.db.prepare(`SELECT type, created_at, valid_from, valid_until, archived_at,
      state_key, origin, owner_principal, visibility, shareable FROM memories WHERE id = ?`)
      .get(engramLocator.sourceId) as Record<string, unknown>
    const before = f.db.serialize()
    const snapshot = available(await source.resolveCurrent(engramLocator))
    expect(snapshot.provenance[0].revision).toBe(`engram-episode/v1:${sha256(canonicalJson({ namespace: engramNamespace, ...row, excerpt: 'prefix' }))}`)
    const revisionInput = { ...snapshot, ref: { ...snapshot.ref, revision: 'revision-input/v1' } }
    expect(snapshot.ref.revision).toBe(`engram-memory/v1:${sha256(canonicalJson({ projection: snapshotProjection(revisionInput),
      lifecycle: { type: memory.type, createdAt: memory.created_at, validFrom: memory.valid_from, validUntil: memory.valid_until,
        archivedAt: memory.archived_at, stateKey: memory.state_key, origin: memory.origin,
        owner: memory.owner_principal, visibility: memory.visibility, shareable: memory.shareable } }))}`)
    expect(snapshot.projectionSha256).toBe(sha256(snapshotProjection(snapshot)))
    expect(f.db.serialize()).toEqual(before)
  })

  it('omits invalid links individually while preserving valid links and their deterministic ordering', async () => {
    setSpan(f, 1.5, 5.5)
    linkEpisode(f.db, 'inert-episode', 6, 12)
    linkEpisode(f.db, 'inert-episode', 0, 5)
    linkEpisode(f.db, seedEpisode(f.db, { id: 'a-valid-episode', content: 'other inert evidence' }))
    const before = f.db.serialize()
    const snapshot = available(await source.resolveCurrent(engramLocator))
    expect(snapshot.provenance.map(({ evidenceId, excerpt }) => ({ evidenceId, excerpt }))).toEqual([
      { evidenceId: 'a-valid-episode', excerpt: 'other inert evidence' },
      { evidenceId: 'inert-episode', excerpt: 'inert' },
      { evidenceId: 'inert-episode', excerpt: 'prefix' },
    ])
    expect(f.db.serialize()).toEqual(before)
  })

  it('invalid-to-valid representation changes invalidate readExact while unrepresented invalid changes do not', async () => {
    setSpan(f, 1.5, 5.5)
    const beforeInvalidRead = f.db.serialize()
    const invalid = available(await source.resolveCurrent(engramLocator))
    expect(invalid.provenance).toEqual([])
    expect(f.db.serialize()).toEqual(beforeInvalidRead)
    setSpan(f, 'inert-invalid-span', null)
    const beforeStillInvalidRead = f.db.serialize()
    f.clock.time++
    expect(available(await source.readExact(invalid.ref))).toEqual({ ...invalid, capturedAt: f.clock.time })
    expect(f.db.serialize()).toEqual(beforeStillInvalidRead)
    setSpan(f, 6, 12)
    const beforeValidReads = f.db.serialize()
    expect(await source.readExact(invalid.ref)).toEqual({ status: 'changed' })
    const valid = available(await source.resolveCurrent(engramLocator))
    expect(valid.provenance[0].excerpt).toBe('prefix')
    expect(valid.ref.revision).not.toBe(invalid.ref.revision)
    expect(valid.projectionSha256).not.toBe(invalid.projectionSha256)
    expect(valid.contentSha256).toBe(invalid.contentSha256)
    f.clock.time++
    expect(available(await source.readExact(valid.ref))).toEqual({ ...valid, capturedAt: f.clock.time })
    expect(f.db.serialize()).toEqual(beforeValidReads)
    setSpan(f, content.length + 1, null)
    const beforeOmittedReads = f.db.serialize()
    expect(await source.readExact(valid.ref)).toEqual({ status: 'changed' })
    const omitted = available(await source.resolveCurrent(engramLocator))
    expect(omitted.provenance).toEqual([])
    expect(omitted.ref).toEqual(invalid.ref)
    expect(omitted.projectionSha256).toBe(invalid.projectionSha256)
    expect(f.db.serialize()).toEqual(beforeOmittedReads)
  })
})
