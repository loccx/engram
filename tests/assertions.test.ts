import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { migration028 } from '../src/db/migrations/028_assertions.js'
import { MemoryStore } from '../src/memory/store.js'
import { LOCAL_OWNER, withCaller, withRequest, type CallerScope } from '../src/memory/access.js'
import {
  ASSERTION_EVIDENCE_MAX,
  attachAssertion,
  queryAssertions,
  registerAssertionSchema,
  replaceAssertionRepresentation,
  type AttachAssertionInput,
  type RegisterAssertionSchemaInput,
} from '../src/memory/assertions/index.js'

const NS = '/synthetic/assertions_%'
const OTHER = '/synthetic/other'
const SESSION = 'assertion-fixture-session'
const SCHEMA = 'profile.timezone@1'
const PREDICATE = 'profile.timezone'
const SUBJECT = 'person:fixture-owner'
const registration: RegisterAssertionSchemaInput = {
  schema_id: SCHEMA,
  predicate: PREDICATE,
  value_schema: { type: 'string', maxLength: 64 },
}
const reader = (id: string, namespace = NS): CallerScope => ({
  principalId: id,
  name: id,
  localOwner: false,
  grants: [{ prefix: namespace, verbs: ['read', 'write'] }],
})

// only an in-memory synthetic database and explicit no-vector stores are used. The
// network tripwire also covers accidentally introduced provider calls in this suite.
describe('canonical assertion sidecars', () => {
  let db: Database.Database
  let store: MemoryStore

  beforeEach(() => {
    vi.stubEnv('ENGRAM_EMBEDDINGS', 'off')
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network/provider calls forbidden in assertion tests') }))
    db = createTestDb().db
    migration028.up(db)
    store = new MemoryStore(db, false)
    db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(SESSION, NS, 100)
    vi.spyOn(Date, 'now').mockReturnValue(200)
  })

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled()
    db.close()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  async function memory(options: { namespace?: string; caller?: CallerScope; visibility?: string; content?: string } = {}): Promise<string> {
    const result = await withCaller(options.caller, () => store.store({
      content: options.content ?? 'The fixture owner uses Europe/Paris as their timezone.',
      session_id: SESSION,
      project_path: options.namespace ?? NS,
      origin: 'mcp',
      visibility: options.visibility,
    }))
    if (result.status === 'rejected') throw new Error(result.reason)
    return result.id
  }

  function attachment(id: string, value = 'Europe/Paris'): AttachAssertionInput {
    return { memory_id: id, schema_id: SCHEMA, subject: SUBJECT, predicate: PREDICATE, value }
  }

  function attach(id: string, value = 'Europe/Paris') {
    registerAssertionSchema(db, registration)
    return attachAssertion(db, attachment(id, value))
  }

  function ids(options: Parameters<typeof queryAssertions>[1] = { namespace: NS }): string[] {
    return queryAssertions(db, options).assertions.map((row) => row.memory_id)
  }

  function episode(id: string, options: { namespace?: string; owner?: string; visibility?: string; expired?: boolean; ingested?: number } = {}): void {
    db.prepare(
      `INSERT INTO episodes
       (id, namespace, session_id, source, source_instance, source_version, external_id,
        occurred_at, ingested_at, content, visibility, owner_principal, expires_at, provenance_json)
       VALUES (?, ?, ?, 'synthetic-source', 'fixture-instance', '1', ?, 90, ?,
               'A synthetic evidence turn.', ?, ?, ?, '{"origin":"do-not-elevate"}')`
    ).run(id, options.namespace ?? NS, SESSION, id, options.ingested ?? 100,
      options.visibility ?? 'project', options.owner ?? null, options.expired ? 150 : null)
  }

  function link(memoryId: string, episodeId: string, linkedAt = 100): void {
    db.prepare(
      'INSERT INTO memory_episodes (memory_id, episode_id, span_start, span_end, created_at) VALUES (?, ?, 2, 12, ?)'
    ).run(memoryId, episodeId, linkedAt)
  }

  it('migration is additive, idempotent, and never automatically types old prose', async () => {
    const id = await memory()
    migration028.up(db)
    migration028.up(db)
    expect(ids()).toEqual([])
    expect(store.getById(id)?.content).toContain('Europe/Paris')
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_assertion_schemas').get()).toEqual({ n: 0 })
  })

  it('schema registration is immutable, versioned and canonical-key-order independent', () => {
    const first = registerAssertionSchema(db, registration)
    vi.mocked(Date.now).mockReturnValue(300)
    expect(registerAssertionSchema(db, {
      ...registration, value_schema: { maxLength: 64, type: 'string' },
    })).toEqual(first)
    expect(() => registerAssertionSchema(db, { ...registration, value_schema: { type: 'number' } })).toThrow(/immutable/)
    expect(() => registerAssertionSchema(db, { ...registration, predicate: 'other' })).toThrow(/immutable/)
    expect(() => registerAssertionSchema(db, { ...registration, schema_id: 'unversioned' })).toThrow(/name@version/)
    expect(registerAssertionSchema(db, { ...registration, schema_id: 'profile.timezone@2.0.0' }).registered_at).toBe(300)
    expect(() => db.prepare('UPDATE memory_assertion_schemas SET predicate = ? WHERE schema_id = ?').run('other', SCHEMA)).toThrow(/immutable/)
    expect(() => db.prepare('DELETE FROM memory_assertion_schemas WHERE schema_id = ?').run(SCHEMA)).toThrow(/immutable/)
  })

  it('blocks replacement inserts on unique identities and explicit rowids without recursive triggers', async () => {
    const id = await memory()
    attach(id)
    expect(db.pragma('recursive_triggers', { simple: true })).toBe(0)
    const before = queryAssertions(db, { namespace: NS })
    expect(() => db.prepare(`INSERT OR REPLACE INTO memory_assertion_schemas
      SELECT schema_id, predicate, '{"type":"number"}', registered_at FROM memory_assertion_schemas WHERE schema_id = ?`).run(SCHEMA)).toThrow(/immutable/)
    expect(() => db.prepare(`INSERT OR REPLACE INTO memory_assertion_schemas(rowid, schema_id, predicate, value_schema_json, registered_at)
      SELECT rowid, 'other.schema@1', predicate, value_schema_json, registered_at FROM memory_assertion_schemas WHERE schema_id = ?`).run(SCHEMA)).toThrow(/immutable/)
    expect(() => db.prepare(`INSERT OR REPLACE INTO memory_assertions
      SELECT memory_id, schema_id, 'changed-subject', predicate, '123', 0, content_sha256, 0, 0, 1
      FROM memory_assertions WHERE memory_id = ?`).run(id)).toThrow(/new canonical revision/)
    const other = await memory({ content: 'Distinct synthetic claim for rowid replacement.' })
    expect(() => db.prepare(`INSERT OR REPLACE INTO memory_assertions(rowid, memory_id, schema_id, subject, predicate, value_json, observed_at, content_sha256, attached_at, represented_at, representation_version)
      SELECT rowid, ?, schema_id, subject, predicate, value_json, observed_at, content_sha256, attached_at, represented_at, representation_version
      FROM memory_assertions WHERE memory_id = ?`).run(other, id)).toThrow(/new canonical revision/)
    expect(queryAssertions(db, { namespace: NS })).toEqual(before)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('neither grants nor a local-owner tool request can authorize registration or attachment', async () => {
    const id = await memory()
    const alice = reader('alice')
    expect(() => withCaller(alice, () => registerAssertionSchema(db, registration))).toThrow(/trusted local-owner host/)
    expect(() => withRequest(LOCAL_OWNER, 'register_assertion_schema', () => registerAssertionSchema(db, registration))).toThrow(/outside tool requests/)
    registerAssertionSchema(db, registration)
    expect(() => withCaller(alice, () => attachAssertion(db, attachment(id)))).toThrow(/trusted local-owner host/)
    expect(() => withRequest(LOCAL_OWNER, 'attach_assertion', () => attachAssertion(db, attachment(id)))).toThrow(/outside tool requests/)
    expect(() => registerAssertionSchema(db, { ...registration, trusted_owner: true } as RegisterAssertionSchemaInput)).toThrow(/unknown input field/)
    expect(() => attachAssertion(db, { ...attachment(id), authority: 'verified-user' } as AttachAssertionInput)).toThrow(/unknown input field/)
    expect(ids()).toEqual([])
  })

  it('attaches only one sidecar, validates shape, and inherits observation and origin without editing the claim', async () => {
    const id = await memory()
    registerAssertionSchema(db, registration)
    const before = db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    expect(() => attachAssertion(db, { ...attachment(id), schema_id: 'missing@1' })).toThrow(/not registered/)
    expect(() => attachAssertion(db, { ...attachment(id), predicate: 'timezone.other' })).toThrow(/predicate/)
    expect(() => attachAssertion(db, { ...attachment(id), value: 1 })).toThrow(/expected string/)
    expect(() => attachAssertion(db, { ...attachment(id), value: 'x'.repeat(65) })).toThrow(/length/)
    expect(() => attachAssertion(db, { ...attachment(id), observed_at: 0 } as AttachAssertionInput)).toThrow(/unknown input field/)
    vi.mocked(Date.now).mockReturnValue(250)
    const assertion = attachAssertion(db, attachment(id))
    expect(assertion.observed_at).toBe(200)
    expect(assertion.attached_at).toBe(250)
    expect(assertion.provenance).toMatchObject({ origin: 'mcp', session_id: SESSION, created_at: 200, owner_principal: null, visibility: null })
    expect(assertion.memory.content).toContain('Europe/Paris')
    expect(assertion).not.toHaveProperty('authority')
    expect(db.prepare('SELECT * FROM memories WHERE id = ?').get(id)).toEqual(before)
    vi.mocked(Date.now).mockReturnValue(300)
    expect(attachAssertion(db, attachment(id))).toEqual(assertion)
    expect(() => attachAssertion(db, attachment(id, 'Europe/London'))).toThrow(/new canonical revision/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_assertions').get()).toEqual({ n: 1 })
  })

  it('uses schema-only CAS replacement and refuses every claim change', async () => {
    const id = await memory()
    const first = attach(id)
    registerAssertionSchema(db, { ...registration, schema_id: 'profile.timezone@2' })
    const replacement = { ...attachment(id), schema_id: 'profile.timezone@2', expected_representation_version: 1 }
    expect(() => withCaller(reader('alice'), () => replaceAssertionRepresentation(db, replacement))).toThrow(/trusted local-owner/)
    expect(() => replaceAssertionRepresentation(db, { ...replacement, value: 'Europe/London' })).toThrow(/new canonical revision/)
    expect(() => replaceAssertionRepresentation(db, { ...replacement, subject: 'other-person' })).toThrow(/new canonical revision/)
    vi.mocked(Date.now).mockReturnValue(400)
    const second = replaceAssertionRepresentation(db, replacement)
    expect(second).toMatchObject({ schema_id: 'profile.timezone@2', representation_version: 2, observed_at: first.observed_at, attached_at: first.attached_at, represented_at: 400 })
    expect(second.provenance).toEqual(first.provenance)
    expect(second.memory).toEqual(first.memory)
    expect(() => replaceAssertionRepresentation(db, replacement)).toThrow(/CAS conflict/)
    expect(replaceAssertionRepresentation(db, { ...replacement, expected_representation_version: 2 })).toEqual(second)
    expect(() => db.prepare('UPDATE memory_assertions SET value_json = ?, representation_version = 3 WHERE memory_id = ?').run('"Europe/London"', id)).toThrow(/new canonical revision/)
    expect(() => db.prepare('UPDATE memory_assertions SET observed_at = 400, representation_version = 3 WHERE memory_id = ?').run(id)).toThrow(/new canonical revision/)
  })

  it('matches subject/predicate/schema/value exactly, not lexical terms, case folds or wildcard expansions', async () => {
    const id = await memory()
    attach(id)
    expect(ids({ namespace: NS, subject: SUBJECT, predicate: PREDICATE, schema_id: SCHEMA, value: 'Europe/Paris' })).toEqual([id])
    for (const query of [
      { subject: 'fixture-owner' }, { subject: SUBJECT.toUpperCase() },
      { predicate: 'timezone' }, { predicate: PREDICATE.toUpperCase() },
      { schema_id: 'profile.timezone@2' }, { value: 'Paris' }, { value: 'europe/paris' }, { value: 1 },
    ]) expect(ids({ namespace: NS, ...query })).toEqual([])
    expect(ids({ namespace: '/synthetic/assertions_X' })).toEqual([])
    expect(ids({ namespace: '/synthetic' })).toEqual([])
    expect(ids({ namespace: `${NS}/child` })).toEqual([])
  })

  it('has canonical whole-JSON equality independent of key order and sensitive to number/string and array order', async () => {
    const id = await memory()
    registerAssertionSchema(db, {
      schema_id: 'fixture.composite@1', predicate: 'fixture.composite',
      value_schema: { type: 'object', additionalProperties: false, required: ['a', 'b'], properties: {
        a: { type: 'integer' }, b: { type: 'array', items: { type: 'string' } },
      } },
    })
    const input = { memory_id: id, schema_id: 'fixture.composite@1', subject: SUBJECT, predicate: 'fixture.composite', value: { b: ['x', 'y'], a: 1 } }
    attachAssertion(db, input)
    expect(ids({ namespace: NS, value: { a: 1, b: ['x', 'y'] } })).toEqual([id])
    expect(ids({ namespace: NS, value: { a: '1', b: ['x', 'y'] } })).toEqual([])
    expect(ids({ namespace: NS, value: { a: 1, b: ['y', 'x'] } })).toEqual([])
    expect(attachAssertion(db, { ...input, value: { a: 1, b: ['x', 'y'] } }).representation_version).toBe(1)
  })

  it('enforces exact namespace, grants and canonical personal ownership even for the local owner', async () => {
    const shared = await memory({ caller: reader('alice'), visibility: 'project' })
    attach(shared)
    const owners = await memory({ visibility: 'personal' })
    attach(owners)
    const foreign = await memory({ namespace: OTHER })
    attach(foreign)
    const privateAlice = await memory({ caller: reader('alice') })
    expect(() => attach(privateAlice)).toThrow(/unavailable/)
    // seed only as a synthetic database fixture to exercise private-owner reads. This
    // is not a library/MCP path by which a named principal could attach a sidecar.
    db.prepare(
      `INSERT INTO memory_assertions
       (memory_id, schema_id, subject, predicate, value_json, observed_at, content_sha256, attached_at, represented_at)
       SELECT ?, schema_id, subject, predicate, value_json, observed_at, content_sha256, attached_at, represented_at
       FROM memory_assertions WHERE memory_id = ?`
    ).run(privateAlice, owners)
    expect(ids().sort()).toEqual([shared, owners].sort())
    expect(withCaller(reader('alice'), () => ids()).sort()).toEqual([shared, privateAlice].sort())
    expect(withCaller(reader('bob'), () => ids())).toEqual([shared])
    expect(() => withCaller(reader('bob', OTHER), () => ids())).toThrow(/not covered/)
    expect(() => withCaller(reader('bob', '/synthetic/assertions'), () => ids())).toThrow(/not covered/)
    expect(() => queryAssertions(db, { namespace: NS, caller: LOCAL_OWNER } as Parameters<typeof queryAssertions>[1])).toThrow(/unknown input field/)
    const audit = db.prepare("SELECT principal_id, ids_json FROM read_audit WHERE principal_id = 'bob'").get() as { principal_id: string; ids_json: string }
    expect(JSON.parse(audit.ids_json)).toEqual([shared])
    db.prepare("UPDATE memories SET visibility = 'personal' WHERE id = ?").run(shared)
    expect(withCaller(reader('bob'), () => ids())).toEqual([])
  })

  it('distinguishes inherited observation cutoff from validity and reports current-only representations', async () => {
    const id = await memory()
    db.prepare('UPDATE memories SET valid_from = 100, valid_until = 190 WHERE id = ?').run(id)
    attach(id)
    expect(ids({ namespace: NS, valid_at: 150 })).toEqual([id])
    expect(ids({ namespace: NS, as_of: 150 })).toEqual([id])
    expect(ids({ namespace: NS, valid_at: 150, observed_before: 199 })).toEqual([])
    expect(ids({ namespace: NS, valid_at: 150, observed_before: 200 })).toEqual([id])
    expect(ids({ namespace: NS, valid_at: 100 })).toEqual([id])
    expect(ids({ namespace: NS, valid_at: 190 })).toEqual([id])
    expect(ids({ namespace: NS, valid_at: 191, observed_before: 1000 })).toEqual([])
    expect(ids({ namespace: NS, valid_at: 99 })).toEqual([])
    expect(() => ids({ namespace: NS, valid_at: 150, as_of: 151 })).toThrow(/must agree/)
    expect(ids({ namespace: NS, valid_at: 150, as_of: 150 })).toEqual([id])
    // match the existing canonical default: no implicit time-validity filter.
    expect(ids()).toEqual(store.list({ project_path: NS }).map((row) => row.id))
    registerAssertionSchema(db, { ...registration, schema_id: 'profile.timezone@2' })
    vi.mocked(Date.now).mockReturnValue(400)
    replaceAssertionRepresentation(db, { ...attachment(id), schema_id: 'profile.timezone@2', expected_representation_version: 1 })
    const snapshot = queryAssertions(db, { namespace: NS, valid_at: 150 })
    expect(snapshot.representation_history).toBe('current-only')
    expect(snapshot.evidence_history).toBe('current-visible-links')
    expect(snapshot.assertions[0].schema_id).toBe('profile.timezone@2')
    expect(snapshot.assertions[0].observed_at).toBe(200)
  })

  it('keeps canonical corrections append-only, never auto-copies typing, and reuses time-aware supersession', async () => {
    const original = await memory()
    attach(original)
    vi.mocked(Date.now).mockReturnValue(300)
    const revised = await store.revise({ id: original, content: 'The fixture owner now uses Europe/London.' })
    expect(revised).not.toBeNull()
    const next = revised!.id
    expect(ids()).toEqual([])
    expect(db.prepare('SELECT memory_id FROM memory_assertions WHERE memory_id = ?').get(next)).toBeUndefined()
    attach(next, 'Europe/London')
    expect(store.getById(original)?.content).toContain('Europe/Paris')
    expect(ids()).toEqual([next])
    expect(ids({ namespace: NS, as_of: 299 })).toEqual([original])
    expect(ids({ namespace: NS, as_of: 300 })).toEqual([next])
    expect(ids({ namespace: NS, as_of: 300, include_superseded: true }).sort()).toEqual([original, next].sort())
    expect(ids({ namespace: NS, include_superseded: true }).sort()).toEqual([original, next].sort())
    expect(queryAssertions(db, { namespace: NS }).assertions[0].provenance.origin).toBe('revision')
  })

  it('respects adjudication confidence, judged_at and archived audit opt-ins', async () => {
    const old = await memory()
    const next = await memory({ content: 'A later synthetic claim.' })
    attach(old)
    attach(next)
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at, confidence, judged_at)
       VALUES (?, ?, 1, 'supersedes', 250, 0.79, 300)`
    ).run(next, old)
    expect(ids().sort()).toEqual([old, next].sort())
    db.prepare('UPDATE memory_links SET confidence = 0.8 WHERE target_id = ?').run(old)
    expect(ids()).toEqual([next])
    expect(ids({ namespace: NS, as_of: 299 }).sort()).toEqual([old, next].sort())
    expect(ids({ namespace: NS, as_of: 300 })).toEqual([next])
    db.prepare('UPDATE memories SET archived_at = 350 WHERE id = ?').run(next)
    expect(ids()).toEqual([])
    expect(ids({ namespace: NS, include_superseded: true })).toEqual([old])
    expect(ids({ namespace: NS, include_archived: true })).toEqual([next])
    expect(ids({ namespace: NS, include_archived: true, include_superseded: true }).sort()).toEqual([old, next].sort())
  })

  it('inherits only real, currently readable canonical evidence links and never copies evidence authority', async () => {
    const id = await memory()
    episode('public-evidence')
    episode('own-evidence', { visibility: 'personal' })
    episode('alice-evidence', { visibility: 'personal', owner: 'alice' })
    episode('wrong-namespace', { namespace: OTHER })
    episode('expired-evidence', { expired: true })
    episode('unlinked-evidence')
    episode('future-evidence', { ingested: 250 })
    for (const evidenceId of ['public-evidence', 'own-evidence', 'alice-evidence', 'wrong-namespace', 'expired-evidence', 'future-evidence']) link(id, evidenceId)
    const assertion = attach(id)
    expect(assertion.provenance.evidence.map((ref) => ref.episode_id).sort()).toEqual(['public-evidence', 'own-evidence', 'future-evidence'].sort())
    expect(assertion.provenance.origin).toBe('mcp')
    expect(assertion.provenance.evidence.find((ref) => ref.episode_id === 'public-evidence')).toEqual({
      episode_id: 'public-evidence', session_id: SESSION, source: 'synthetic-source',
      source_instance: 'fixture-instance', source_version: '1', external_id: 'public-evidence',
      occurred_at: 90, ingested_at: 100, span_start: 2, span_end: 12, linked_at: 100,
    })
    const bob = withCaller(reader('bob'), () => queryAssertions(db, { namespace: NS }).assertions[0])
    expect(bob.provenance.evidence.map((ref) => ref.episode_id).sort()).toEqual(['public-evidence', 'future-evidence'].sort())
    const cut = queryAssertions(db, { namespace: NS, observed_before: 200 }).assertions[0]
    expect(cut.provenance.evidence.map((ref) => ref.episode_id)).not.toContain('future-evidence')
    episode('late-link')
    link(id, 'late-link', 250)
    expect(queryAssertions(db, { namespace: NS, observed_before: 200 }).assertions[0].provenance.evidence.map((ref) => ref.episode_id)).not.toContain('late-link')
    db.prepare('DELETE FROM episodes WHERE id = ?').run('public-evidence')
    expect(queryAssertions(db, { namespace: NS }).assertions[0].provenance.evidence.map((ref) => ref.episode_id)).not.toContain('public-evidence')
    expect(ids()).toEqual([id])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('bounds exact lookup and visible evidence independently, with deterministic ordering', async () => {
    const id = await memory()
    for (let index = 0; index < ASSERTION_EVIDENCE_MAX + 2; index++) {
      const evidenceId = `evidence-${String(index).padStart(2, '0')}`
      episode(evidenceId)
      link(id, evidenceId)
    }
    const assertion = attach(id)
    expect(assertion.provenance.evidence).toHaveLength(ASSERTION_EVIDENCE_MAX)
    expect(assertion.provenance.evidence_truncated).toBe(true)
    const second = await memory({ content: 'Another synthetic canonical row.' })
    attach(second)
    expect(ids({ namespace: NS, limit: 1 })).toEqual([id, second].sort().slice(0, 1))
    for (const limit of [0, -1, 101, 1.5, Infinity]) expect(() => ids({ namespace: NS, limit })).toThrow(/limit/)
    for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => ids({ namespace: NS, observed_before: value })).toThrow(/timestamp/)
      expect(() => ids({ namespace: NS, valid_at: value })).toThrow(/timestamp/)
    }
    expect(() => queryAssertions(db, { namespace: NS, include_archived: 'yes' } as unknown as Parameters<typeof queryAssertions>[1])).toThrow(/boolean/)
  })

  it('canonical forget/source purge cascades the sidecar without retaining the typed value', async () => {
    const id = await memory()
    attach(id)
    episode('forget-evidence')
    link(id, 'forget-evidence')
    expect(store.delete(id)).toBe(true)
    expect(ids()).toEqual([])
    expect(db.prepare('SELECT * FROM memory_assertions WHERE memory_id = ?').get(id)).toBeUndefined()
    expect(db.prepare('SELECT * FROM memory_episodes WHERE memory_id = ?').get(id)).toBeUndefined()
    expect(db.prepare('SELECT id FROM episodes WHERE id = ?').get('forget-evidence')).toEqual({ id: 'forget-evidence' })
    const purged = await memory()
    attach(purged)
    db.prepare('DELETE FROM memories WHERE id = ?').run(purged)
    expect(ids()).toEqual([])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('inherits live namespace changes without leaving a second namespace authority in the sidecar', async () => {
    const id = await memory()
    attach(id)
    db.prepare('UPDATE memories SET namespace = ? WHERE id = ?').run(OTHER, id)
    expect(ids()).toEqual([])
    expect(ids({ namespace: OTHER })).toEqual([id])
    expect(withCaller(reader('alice'), () => ids())).toEqual([])
    expect(() => withCaller(reader('alice'), () => ids({ namespace: OTHER }))).toThrow(/not covered/)
    db.prepare('UPDATE memories SET namespace = NULL WHERE id = ?').run(id)
    expect(ids()).toEqual([id])
  })

  it('enforces database value-size and canonical/schema foreign-key bounds', async () => {
    const id = await memory()
    attach(id)
    const insert = db.prepare(
      `INSERT INTO memory_assertions
       (memory_id, schema_id, subject, predicate, value_json, observed_at, content_sha256, attached_at, represented_at)
       VALUES (?, ?, ?, ?, ?, 200, ?, 200, 200)`
    )
    expect(() => insert.run('missing-memory', SCHEMA, SUBJECT, PREDICATE, 'null', '0'.repeat(64))).toThrow(/FOREIGN KEY/)
    expect(() => insert.run(null, SCHEMA, SUBJECT, PREDICATE, 'null', '0'.repeat(64))).toThrow(/NOT NULL/)
    const second = await memory({ content: 'An untyped synthetic row for constraint tests.' })
    expect(() => insert.run(second, 'missing@1', SUBJECT, PREDICATE, 'null', '0'.repeat(64))).toThrow(/FOREIGN KEY/)
    expect(() => insert.run(second, SCHEMA, SUBJECT, 'other', 'null', '0'.repeat(64))).toThrow(/FOREIGN KEY/)
    expect(() => insert.run(second, SCHEMA, SUBJECT, PREDICATE, JSON.stringify('x'.repeat(8192)), '0'.repeat(64))).toThrow(/CHECK constraint/)
    expect(() => insert.run(second, SCHEMA, SUBJECT, PREDICATE, 'not-json', '0'.repeat(64))).toThrow(/CHECK constraint/)
    expect(ids()).toEqual([id])
  })

  it('invalidates stale typing after legacy in-place content edits but not metadata changes', async () => {
    const id = await memory()
    attach(id)
    store.update(id, { importance: 0.9 })
    expect(ids()).toEqual([id])
    db.prepare('UPDATE memories SET content = content WHERE id = ?').run(id)
    expect(ids()).toEqual([id])
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('Legacy content mutation.', id)
    expect(ids()).toEqual([])
    expect(store.getById(id)?.content).toBe('Legacy content mutation.')
  })
})
