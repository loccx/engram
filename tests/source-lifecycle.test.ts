import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseManager } from '../src/db/init.js'
import { migrations, runMigrations } from '../src/db/migrations/index.js'
import { migration027 } from '../src/db/migrations/027_source_lifecycle.js'
import { withCaller, type CallerScope } from '../src/memory/access.js'
import { MemoryStore, setStoreEmbedder } from '../src/memory/store.js'
import { citedEpisodes, countEpisodes, countMatchingEpisodes, deleteEpisodes, inheritMemoryEpisodes, linkMemoryEpisode, setEpisodeEmbedder } from '../src/memory/episodes.js'
import { episodeLexicalHits, episodeVectorHits } from '../src/memory/search/episodes.js'
import { retrieveEpisodeContext } from '../src/memory/episode-context.js'
import { EMBEDDING_DIM } from '../src/embeddings/pipeline.js'
import {
  applySourcePage, createSourceConnection, forgetSourceEpisodes, forgetSourcesForMemory,
  getSourceConnection, revokeSourceConnection, sourceHash, stageSourcePage, syncSourcePage,
  SOURCE_PAGE_MAX, readSourceGeneration, sourceDerivedMemoryIds, type SourceConnector, type SourcePage, type SourceConnection,
} from '../src/sources/index.js'
import { runDuplicatePrune } from '../src/maintenance/prune.js'
import { runClusterWorker } from '../src/memory/cluster-worker.js'
import { refreshNavDigest, childRoster } from '../src/memory/nav.js'
import { ensureNode } from '../src/namespace/tree.js'
import { completeMaintenanceJob, enqueueMaintenanceJob } from '../src/maintenance/jobs.js'
vi.mock('../src/llm/client.js', () => ({ isLlmConfigured: () => false, chat: () => { throw new Error('models forbidden in source fixtures') } }))

const NS = '/synthetic/source-test'
const ALICE: CallerScope = { principalId: 'synthetic-alice', name: 'alice', localOwner: false, grants: [{ prefix: NS, verbs: ['read', 'write', 'delete'] }] }
const BOB: CallerScope = { ...ALICE, principalId: 'synthetic-bob', name: 'bob' }

/** inert, deterministic connector. No fetch, client, credential or real service exists. */
class FakeConnector implements SourceConnector {
  provider = 'fake'
  account_hash = sourceHash('synthetic-upstream-account')
  scope_hash = sourceHash('synthetic-upstream-scope')
  calls: Array<{ cursor: string | null; limit: number }> = []
  constructor(public page: unknown = upserts('1')) {}
  async changes(cursor: string | null, limit: number): Promise<unknown> {
    this.calls.push({ cursor, limit })
    return this.page
  }
}
function upserts(next: string, content = 'Synthetic launch date is October twelve.', revision = 'r1', externalId = 'item-1'): SourcePage {
  return { next_cursor: next, changes: [{ kind: 'upsert', external_id: externalId, revision, content }] }
}
function n(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}
function migrate(db: Database.Database, path = ':memory:'): void {
  runMigrations(db, path, [...migrations.filter((migration) => migration.version !== 27), migration027], () => {})
}
function position(connection: SourceConnection): { cursor: string | null; generation: number } {
  return { cursor: connection.cursor, generation: connection.generation }
}
function currentEpisode(db: Database.Database): string {
  return (db.prepare("SELECT id FROM episodes WHERE source_state = 'current' ORDER BY ingested_at DESC LIMIT 1").get() as { id: string }).id
}
async function derived(db: Database.Database, episodeId: string, owner: CallerScope | undefined = undefined, ns = NS): Promise<string> {
  return withCaller(owner, async () => {
    const sessionId = `session-${owner?.principalId ?? 'owner'}-${ns}`
    db.prepare('INSERT OR IGNORE INTO sessions(id, project_path, started_at, owner_principal) VALUES (?, ?, 1, ?)')
      .run(sessionId, ns, owner?.principalId ?? null)
    const result = await new MemoryStore(db, false).store({ session_id: sessionId, project_path: ns, content: 'Synthetic derived launch claim contains removed wording.', type: 'note' })
    if (result.status === 'rejected') throw new Error(result.reason)
    linkMemoryEpisode(db, { memory_id: result.id, episode_id: episodeId, span_start: null, span_end: null })
    return result.id
  })
}

describe('host-bound source lifecycle with inert connector', () => {
  let manager: DatabaseManager
  let db: Database.Database
  const dirs: string[] = []
  beforeEach(() => {
    manager = new DatabaseManager(':memory:')
    db = manager.db
    migrate(db)
    setEpisodeEmbedder(async () => { throw new Error('source evaluation must never embed') })
    setStoreEmbedder(async () => null)
  })
  afterEach(() => {
    if (manager.db.open) manager.close()
    setEpisodeEmbedder(null)
    setStoreEmbedder(null)
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const connect = (db: Database.Database, connector = new FakeConnector()): SourceConnection => createSourceConnection(db, connector, { namespace: NS })
  const apply = (db: Database.Database, connectionId: string, page: SourcePage): ReturnType<typeof applySourcePage> => {
    const connection = getSourceConnection(db, connectionId)
    const receipt = stageSourcePage(db, connectionId, position(connection), page)
    return applySourcePage(db, receipt.id, page)
  }

  it('binds immutable identity to host provider/scope/owner and rejects secret configuration', async () => {
    const connector = new FakeConnector()
    const connection = connect(db, connector)
    expect(connect(db, connector).id).toBe(connection.id)
    expect(() => createSourceConnection(db, connector, { namespace: NS, token: 'inert-not-a-credential' })).toThrow()
    expect(() => db.prepare('UPDATE source_connections SET owner_principal = ? WHERE id = ?').run('other', connection.id)).toThrow('immutable')
    expect(() => db.prepare('INSERT OR REPLACE INTO source_connections SELECT * FROM source_connections WHERE id = ?').run(connection.id)).toThrow('immutable')
    expect(() => db.prepare(`INSERT OR REPLACE INTO source_connections(id, namespace, owner_principal, provider, account_hash, scope_hash, created_at)
      SELECT 'replacement-id', namespace, '', provider, account_hash, scope_hash, created_at FROM source_connections WHERE id = ?`)
      .run(connection.id)).toThrow('immutable')
    expect(() => db.prepare('DELETE FROM source_connections WHERE id = ?').run(connection.id)).toThrow()
    await expect(syncSourcePage(db, connection.id, { ...connector, scope_hash: sourceHash('other'), changes: connector.changes.bind(connector) })).rejects.toThrow('binding mismatch')
    expect(connector.calls).toEqual([])
    // explicit synthetic credential shape, not a credential retrieved from any host.
    const synthetic = ['sk', '-', 'syntheticfixture00000000000000000000'].join('')
    expect(() => stageSourcePage(db, connection.id, position(connection), { ...upserts('1'), next_cursor: synthetic })).toThrow('secrets')
    expect(getSourceConnection(db, connection.id).cursor).toBeNull()
    expect(n(db, 'source_pages')).toBe(0)
  })

  it('validates strict scoped envelopes and enforces caller-requested page and byte bounds', () => {
    const connection = connect(db)
    expect(() => stageSourcePage(db, connection.id, position(connection), { ...upserts('1'), namespace: '/foreign' })).toThrow()
    expect(() => stageSourcePage(db, connection.id, position(connection), upserts('1'), 0)).toThrow('limit')
    expect(() => stageSourcePage(db, connection.id, position(connection), { next_cursor: '1', changes: Array.from({ length: SOURCE_PAGE_MAX + 1 }, (_, i) => ({ kind: 'delete', external_id: String(i) })) }, SOURCE_PAGE_MAX)).toThrow()
    expect(() => stageSourcePage(db, connection.id, position(connection), { next_cursor: '1', changes: [{ kind: 'delete', external_id: 'a' }, { kind: 'delete', external_id: 'b' }] }, 1)).toThrow('exceeded')
    expect(() => stageSourcePage(db, connection.id, position(connection), { next_cursor: '1', changes: [{ kind: 'delete', external_id: 'a' }, { kind: 'delete', external_id: 'a' }] })).toThrow('one change')
    expect(() => stageSourcePage(db, connection.id, position(connection), { ...upserts('1'), padding: 'x'.repeat(512_001) })).toThrow('too large')
    expect(n(db, 'source_pages')).toBe(0)
  })

  it('rejects a mixed-content page before journal or materialization changes, even with admission off', () => {
    const connection = connect(db)
    const original = process.env.ENGRAM_ADMISSION
    process.env.ENGRAM_ADMISSION = 'off'
    try {
      const page: SourcePage = { next_cursor: '1', changes: [upserts('1').changes[0], { kind: 'upsert', external_id: 'secret-item', revision: 'r1', content: ['-----BEGIN', ' PRIVATE KEY-----'].join('') }] }
      expect(() => stageSourcePage(db, connection.id, position(connection), page)).toThrow('secrets')
      expect(() => stageSourcePage(db, connection.id, position(connection), upserts('1', '<div></div>'))).toThrow('junk')
      for (const table of ['source_pages', 'source_revisions', 'source_items', 'episodes']) expect(n(db, table)).toBe(0)
      expect(getSourceConnection(db, connection.id).generation).toBe(0)
    } finally {
      if (original === undefined) delete process.env.ENGRAM_ADMISSION
      else process.env.ENGRAM_ADMISSION = original
    }
  })

  it('durably stages without text, recovers across migrated/reopened SQLite and replays exactly once', () => {
    manager.close()
    const dir = mkdtempSync(join(tmpdir(), 'engram-synthetic-source-'))
    dirs.push(dir)
    const path = join(dir, 'test.db')
    // construct a genuine pre-lifecycle fixture even after the registry gains 027/028.
    const newer = migrations.splice(migrations.findIndex((migration) => migration.version >= 27))
    try { manager = new DatabaseManager(path) } finally { migrations.push(...newer) }
    db = manager.db
    const legacyColumns = db.prepare('PRAGMA table_info(episodes)').all() as Array<{ name: string }>
    expect(legacyColumns.some((column) => column.name === 'source_state')).toBe(false)
    migrate(db, path)
    const connection = connect(db)
    const page = upserts('1')
    const receipt = stageSourcePage(db, connection.id, position(connection), page)
    expect(JSON.stringify(db.prepare('SELECT * FROM source_pages').all())).not.toContain(page.changes[0].kind === 'upsert' ? page.changes[0].content : 'unused')
    manager.close()
    manager = new DatabaseManager(path)
    db = manager.db
    expect(migrate(db, path)).toBeUndefined()
    migration027.up(db) // the DDL itself is idempotent too
    expect(applySourcePage(db, receipt.id, page)).toMatchObject({ upserted: 1, replay: false })
    manager.close()
    manager = new DatabaseManager(path)
    db = manager.db
    const replayReceipt = stageSourcePage(db, connection.id, position(connection), page)
    expect(replayReceipt.id).toBe(receipt.id)
    expect(applySourcePage(db, receipt.id, page)).toMatchObject({ upserted: 1, replay: true })
    expect(n(db, 'episodes')).toBe(1)
    expect(n(db, 'source_revisions')).toBe(1)
    expect(getSourceConnection(db, connection.id)).toMatchObject({ cursor: '1', generation: 1 })
    expect(db.prepare('SELECT embed_state, vec_rowid FROM episodes').get()).toEqual({ embed_state: 'stale', vec_rowid: null })
    expect(() => applySourcePage(db, receipt.id, upserts('1', 'Tampered synthetic content.'))).toThrow('hash conflict')
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('quick_check')).toEqual([{ quick_check: 'ok' }])
  })

  it('rolls back a materialization crash while preserving a durable staged page for retry', () => {
    const connection = connect(db)
    const page: SourcePage = { next_cursor: '1', changes: [upserts('1').changes[0], { kind: 'upsert', external_id: 'item-2', revision: 'r1', content: 'Synthetic second evidence row.' }] }
    const receipt = stageSourcePage(db, connection.id, position(connection), page)
    db.exec("CREATE TRIGGER synthetic_crash BEFORE INSERT ON episodes WHEN NEW.content = 'Synthetic second evidence row.' BEGIN SELECT RAISE(ABORT, 'injected crash'); END")
    expect(() => applySourcePage(db, receipt.id, page)).toThrow('injected crash')
    for (const table of ['source_revisions', 'source_items', 'episodes', 'source_events']) expect(n(db, table)).toBe(0)
    expect(getSourceConnection(db, connection.id)).toMatchObject({ cursor: null, generation: 0 })
    expect(db.prepare('SELECT state FROM source_pages').get()).toEqual({ state: 'staged' })
    db.exec('DROP TRIGGER synthetic_crash')
    expect(applySourcePage(db, receipt.id, page).upserted).toBe(2)
    expect(applySourcePage(db, receipt.id, page).replay).toBe(true)
  })

  it('uses cursor generation CAS to reject concurrent and ABA pages atomically', () => {
    const connection = connect(db)
    const a = upserts('cursor-a')
    const b = upserts('cursor-b', 'Synthetic competing content.', 'r1', 'item-b')
    const first = stageSourcePage(db, connection.id, position(connection), a)
    const competitor = stageSourcePage(db, connection.id, position(connection), b)
    applySourcePage(db, first.id, a)
    expect(() => applySourcePage(db, competitor.id, b)).toThrow('cursor conflict')
    expect(n(db, 'episodes')).toBe(1)
    apply(db, connection.id, { next_cursor: 'cursor-b', changes: [] })
    apply(db, connection.id, { next_cursor: 'cursor-a', changes: [] })
    expect(() => stageSourcePage(db, connection.id, { cursor: 'cursor-a', generation: 1 }, upserts('next', 'Synthetic ABA content.', 'r1', 'aba'))).toThrow('cursor conflict')
    expect(getSourceConnection(db, connection.id).generation).toBe(3)
  })

  it('replaces revisions, purges dependent claims and serves only current evidence lexically/vector/context', async () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1', 'Synthetic obsolete launch wording.'))
    const oldId = currentEpisode(db)
    const memoryId = await derived(db, oldId)
    const store = new MemoryStore(db, false)
    const revised = await store.revise({ id: memoryId, content: 'Synthetic manual descendant retained obsolete wording.', reason: 'synthetic revision' })
    if (!revised) throw new Error('synthetic revision missing')
    db.prepare('INSERT INTO project_digests(namespace, content) VALUES (?, ?)').run(NS, 'Synthetic obsolete cached digest.')
    db.prepare('INSERT INTO project_digests(namespace, content) VALUES (?, ?)').run('/synthetic', 'Synthetic obsolete ancestor digest.')
    db.prepare('INSERT INTO memory_clusters(project_path, member_ids, summary, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run(NS, JSON.stringify([memoryId, revised.memory.id]), 'Synthetic obsolete cached summary.')
    db.prepare('INSERT INTO namespace_nodes(path, depth, updated_at, digest) VALUES (?, 1, 1, ?)').run('/synthetic', 'Synthetic obsolete navigation.')
    db.prepare("INSERT INTO memory_events(memory_id, event_type, occurred_at, payload) VALUES (?, 'updated', 1, ?)")
      .run(memoryId, JSON.stringify({ before: { content: 'Synthetic obsolete audit plaintext.' }, after: { content: 'Synthetic obsolete mutation.' } }))
    db.prepare("INSERT INTO maintenance_jobs(job_type, target_key, status, enqueued_at, result_json, last_error) VALUES ('digest', ?, 'done', 1, ?, ?)")
      .run(`nav:${NS}`, JSON.stringify({ summary: 'Synthetic obsolete job plaintext.' }), 'Synthetic obsolete provider error.')
    db.prepare("INSERT INTO maintenance_jobs(job_type, target_key, status, enqueued_at, result_json) VALUES ('digest', ?, 'done', 1, ?)")
      .run('/unrelated', JSON.stringify({ note: 'Synthetic independent job status.' }))
    const replacement = apply(db, connection.id, upserts('2', 'Synthetic current launch wording.', 'r2'))
    expect(replacement.purged_memories).toBe(2)
    expect(n(db, 'memories')).toBe(0)
    expect(n(db, 'project_digests')).toBe(0)
    expect(n(db, 'memory_clusters')).toBe(0)
    expect(db.prepare('SELECT digest FROM namespace_nodes WHERE path = ?').get('/synthetic')).toEqual({ digest: null })
    expect(JSON.stringify(db.prepare('SELECT payload FROM memory_events WHERE memory_id = ?').all(memoryId))).not.toContain('obsolete')
    expect(db.prepare('SELECT result_json, last_error FROM maintenance_jobs WHERE target_key = ?').get(`nav:${NS}`))
      .toEqual({ result_json: '{"redacted":"source-lifecycle"}', last_error: null })
    expect(JSON.stringify(db.prepare('SELECT result_json FROM maintenance_jobs WHERE target_key = ?').get('/unrelated'))).toContain('independent')
    expect(n(db, 'episodes')).toBe(2)
    expect(countEpisodes(db, { namespace: NS })).toBe(1)
    expect(countEpisodes(db, { namespace: NS, include_source_history: true })).toBe(2)
    expect(episodeLexicalHits(db, 'obsolete', { namespace: NS })).toEqual([])
    expect(episodeLexicalHits(db, 'obsolete', { namespace: NS, include_source_history: true })).toHaveLength(1)
    const context = await retrieveEpisodeContext({ db, query: 'launch', namespace: NS, budget_chars: 5000, render_window: 5, include_source_history: true, vectorsAvailable: false })
    expect(context.context).toContain('current')
    expect(context.context).not.toContain('obsolete')
    expect(context.lines).toHaveLength(1)
    expect(citedEpisodes(db, memoryId)).toEqual([])
    if (manager.vectorsAvailable) {
      const vector = new Float32Array(EMBEDDING_DIM); vector[0] = 1
      for (const row of db.prepare('SELECT id FROM episodes').all() as Array<{ id: string }>) {
        const vecId = db.prepare('INSERT INTO episode_vectors(embedding) VALUES (?)').run(Buffer.from(vector.buffer)).lastInsertRowid
        db.prepare('UPDATE episodes SET vec_rowid = ? WHERE id = ?').run(vecId, row.id)
      }
      const hits = episodeVectorHits(db, vector, { namespace: NS }, 10)
      expect(hits.map((hit) => hit.episode.id)).toEqual([currentEpisode(db)])
    }
    expect(apply(db, connection.id, upserts('3', 'Synthetic obsolete launch wording.', 'r1')).skipped).toBe(1)
    expect(currentEpisode(db)).not.toBe(oldId)
    expect(n(db, 'source_revisions')).toBe(2)
  })

  it('rejects immutable revision reuse and rolls back every item and cursor in the rejected page', () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    const page: SourcePage = { next_cursor: '2', changes: [upserts('2', 'Synthetic brand new row.', 'r1', 'other').changes[0], upserts('2', 'Synthetic mutated old revision.').changes[0]] }
    const receipt = stageSourcePage(db, connection.id, { cursor: '1', generation: 1 }, page)
    expect(() => applySourcePage(db, receipt.id, page)).toThrow('immutable source revision conflict')
    expect(n(db, 'episodes')).toBe(1)
    expect(n(db, 'source_revisions')).toBe(1)
    expect(getSourceConnection(db, connection.id)).toMatchObject({ cursor: '1', generation: 1 })
    expect(() => db.prepare('UPDATE source_revisions SET revision = ?').run('evil')).toThrow('immutable')
    expect(() => db.exec('INSERT OR REPLACE INTO source_revisions SELECT * FROM source_revisions')).toThrow('immutable')
  })

  it('upstream deletes purge all raw revisions and claims; tombstones block newer or stale replay', async () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    const id = currentEpisode(db)
    await derived(db, id)
    const stale = upserts('future', 'Synthetic stale staged wording.', 'r2')
    const receipt = stageSourcePage(db, connection.id, { cursor: '1', generation: 1 }, stale)
    apply(db, connection.id, { next_cursor: '2', changes: [{ kind: 'delete', external_id: 'item-1' }] })
    expect(() => applySourcePage(db, receipt.id, stale)).toThrow('cursor conflict')
    expect(n(db, 'episodes')).toBe(0)
    expect(n(db, 'memories')).toBe(0)
    expect(n(db, 'source_tombstones')).toBe(1)
    expect(apply(db, connection.id, upserts('3', 'Synthetic revived wording.', 'r3')).skipped).toBe(1)
    expect(n(db, 'episodes')).toBe(0)
    expect(() => db.exec('DELETE FROM source_tombstones')).toThrow('immutable')
  })

  it('revocation is durable, purges cited text and cannot be bypassed by replay or recreate', async () => {
    const connector = new FakeConnector()
    const connection = connect(db, connector)
    await syncSourcePage(db, connection.id, connector)
    await derived(db, currentEpisode(db))
    const page = upserts('2', 'Synthetic staged future wording.', 'r2')
    const receipt = stageSourcePage(db, connection.id, { cursor: '1', generation: 1 }, page)
    expect(revokeSourceConnection(db, connection.id)).toBe(1)
    expect(n(db, 'episodes')).toBe(0)
    expect(n(db, 'memories')).toBe(0)
    expect(() => applySourcePage(db, receipt.id, page)).toThrow('revoked')
    expect(() => connect(db, connector)).toThrow('recreated')
    expect(() => db.prepare('UPDATE source_connections SET revoked_at = NULL WHERE id = ?').run(connection.id)).toThrow('immutable')
    expect(revokeSourceConnection(db, connection.id)).toBe(0)
  })

  it('explicit forget hooks tombstone evidence before citation loss and deny staged/new-revision replay', async () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    const memoryId = await derived(db, currentEpisode(db))
    const revised = await new MemoryStore(db, false).revise({ id: memoryId, content: 'Synthetic successor with no direct citation.' })
    if (!revised) throw new Error('synthetic revision missing')
    const page = upserts('2', 'Synthetic forbidden reimport.', 'r2')
    const receipt = stageSourcePage(db, connection.id, { cursor: '1', generation: 1 }, page)
    expect(forgetSourcesForMemory(db, revised.memory.id)).toBe(2)
    expect(n(db, 'episodes')).toBe(0)
    expect(n(db, 'memories')).toBe(0)
    expect(db.prepare('SELECT reason FROM source_tombstones').get()).toEqual({ reason: 'forgotten' })
    expect(applySourcePage(db, receipt.id, page)).toMatchObject({ skipped: 1, upserted: 0 })
    expect(apply(db, connection.id, upserts('3', 'Synthetic newer forbidden reimport.', 'r3')).skipped).toBe(1)
    expect(n(db, 'source_revisions')).toBe(1)
    expect(n(db, 'episodes')).toBe(0)
    expect(forgetSourcesForMemory(db, memoryId)).toBe(0)
  })

  it('normal deleteEpisodes records a source identity forget and previews all removed revisions and claim links', async () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    apply(db, connection.id, upserts('2', 'Synthetic current replacement.', 'r2'))
    const claim = await derived(db, currentEpisode(db))
    db.prepare('INSERT INTO episodes(id, namespace, session_id, source, external_id, ingested_at, content) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run('ordinary-evidence', NS, 'ordinary-session', 'ordinary', 'ordinary-id', 'Synthetic ordinary evidence stays.')
    linkMemoryEpisode(db, { memory_id: claim, episode_id: 'ordinary-evidence', span_start: null, span_end: null })
    const preview = countMatchingEpisodes(db, { namespace: NS }, { source: 'connector:fake' })
    expect(preview).toEqual({ episodes: 2, links: 2, vectors: 0, fts: 2 })
    expect(deleteEpisodes(db, { namespace: NS }, { source: 'connector:fake' })).toEqual(preview)
    expect(n(db, 'episodes')).toBe(1)
    expect(n(db, 'source_tombstones')).toBe(1)
    expect(apply(db, connection.id, upserts('3', 'Synthetic future content.', 'r3')).skipped).toBe(1)
    expect(new MemoryStore(db, false).getById(claim)).toBeNull()
  })

  it('rejects cross-principal operations even with the same namespace grants and atomically rejects mixed forgetting', () => {
    const connector = new FakeConnector()
    const alice = withCaller(ALICE, () => connect(db, connector))
    withCaller(ALICE, () => apply(db, alice.id, upserts('1')))
    const aliceEpisode = currentEpisode(db)
    const bob = withCaller(BOB, () => connect(db, connector))
    withCaller(BOB, () => apply(db, bob.id, upserts('1', 'Synthetic Bob private wording.')))
    const bobEpisode = (db.prepare('SELECT id FROM episodes WHERE owner_principal = ?').get(BOB.principalId) as { id: string }).id
    expect(alice.id).not.toBe(bob.id)
    withCaller(BOB, () => {
      expect(() => getSourceConnection(db, alice.id)).toThrow('owned')
      expect(() => stageSourcePage(db, alice.id, { cursor: '1', generation: 1 }, upserts('2'))).toThrow('owned')
      expect(() => revokeSourceConnection(db, alice.id)).toThrow('owned')
      expect(() => forgetSourceEpisodes(db, [bobEpisode, aliceEpisode])).toThrow('owned')
      expect(countEpisodes(db)).toBe(1)
      expect(episodeLexicalHits(db, 'launch')).toEqual([])
    })
    expect(n(db, 'source_tombstones')).toBe(0)
    withCaller({ ...ALICE, grants: [] }, () => {
      expect(() => getSourceConnection(db, alice.id)).toThrow('read')
      expect(countEpisodes(db, { namespace: NS })).toBe(0)
      expect(episodeLexicalHits(db, 'launch', { namespace: NS })).toEqual([])
    })
    withCaller({ ...ALICE, grants: [{ prefix: NS, verbs: ['write', 'read'] }] }, () => {
      const page: SourcePage = { next_cursor: '2', changes: [{ kind: 'delete', external_id: 'item-1' }] }
      expect(() => stageSourcePage(db, alice.id, { cursor: '1', generation: 1 }, page)).toThrow('delete')
      const receipt = stageSourcePage(db, alice.id, { cursor: '1', generation: 1 }, upserts('2', 'Synthetic replacement.', 'r2'))
      expect(() => applySourcePage(db, receipt.id, upserts('2', 'Synthetic replacement.', 'r2'))).toThrow('delete')
    })
    expect(n(db, 'episodes')).toBe(2)
  })

  it('uses the delete verb rather than read grants for source-aware episode teardown', () => {
    const connection = withCaller(ALICE, () => connect(db))
    withCaller(ALICE, () => apply(db, connection.id, upserts('1')))
    const deleter: CallerScope = { ...ALICE, grants: [{ prefix: NS, verbs: ['delete'] }] }
    withCaller(deleter, () => {
      expect(countEpisodes(db, { namespace: NS })).toBe(0)
      expect(countMatchingEpisodes(db, { namespace: NS }).episodes).toBe(1)
      expect(deleteEpisodes(db, { namespace: NS }).episodes).toBe(1)
    })
    expect(n(db, 'source_tombstones')).toBe(1)
  })

  it('rechecks a changed host grant after async changes and retains namespace/owner filters in assembly', async () => {
    const caller: CallerScope = { ...ALICE, grants: [...ALICE.grants] }
    const connector = new FakeConnector()
    const connection = withCaller(caller, () => connect(db, connector))
    connector.changes = async () => { caller.grants = []; return upserts('1') }
    await expect(withCaller(caller, () => syncSourcePage(db, connection.id, connector))).rejects.toThrow('write')
    expect(n(db, 'source_pages')).toBe(0)
    caller.grants = [...ALICE.grants]
    withCaller(caller, () => apply(db, connection.id, upserts('1')))
    const bob = withCaller(BOB, () => connect(db))
    withCaller(BOB, () => apply(db, bob.id, upserts('1', 'Synthetic Bob launch text.')))
    const context = await retrieveEpisodeContext({ db, caller, namespace: NS, query: 'launch', budget_chars: 5000, vectorsAvailable: false })
    expect(context.lines).toHaveLength(1)
    expect(context.context).not.toContain('Bob')
  })

  it('does not propagate malicious foreign citations or revision edges as deletion authority', async () => {
    const alice = withCaller(ALICE, () => connect(db))
    withCaller(ALICE, () => apply(db, alice.id, upserts('1')))
    const episodeId = currentEpisode(db)
    const aliceMemory = await derived(db, episodeId, ALICE)
    db.prepare('INSERT INTO sessions(id, project_path, started_at, owner_principal) VALUES (?, ?, 1, ?)').run('foreign-session', NS, BOB.principalId)
    const foreign = await withCaller(BOB, () => new MemoryStore(db, false).store({ session_id: 'foreign-session', project_path: NS, content: 'Synthetic unrelated Bob memory must survive.' }))
    if (foreign.status === 'rejected') throw new Error(foreign.reason)
    expect(() => withCaller(ALICE, () => linkMemoryEpisode(db, { memory_id: foreign.id, episode_id: episodeId, span_start: null, span_end: null }))).toThrow('same namespace')
    db.prepare('INSERT INTO memory_episodes(memory_id, episode_id, created_at) VALUES (?, ?, 1)').run(foreign.id, episodeId)
    db.prepare("INSERT INTO memory_links(source_id, target_id, similarity, link_type, created_at, revision) VALUES (?, ?, 1, 'supersedes', 1, 1)").run(foreign.id, aliceMemory)
    withCaller(ALICE, () => revokeSourceConnection(db, alice.id))
    expect(new MemoryStore(db, false).getById(aliceMemory)).toBeNull()
    expect(new MemoryStore(db, false).getById(foreign.id)).not.toBeNull()
    expect(n(db, 'memories')).toBe(1)
    expect(n(db, 'source_events')).toBeGreaterThan(0)
  })

  it('binds explicit forgetting to account identity across changed scopes but not colliding other accounts', async () => {
    const firstConnector = new FakeConnector()
    const first = connect(db, firstConnector)
    apply(db, first.id, upserts('1'))
    const firstEpisode = currentEpisode(db)
    const secondConnector = new FakeConnector()
    secondConnector.scope_hash = sourceHash('synthetic-other-permission-scope')
    const second = connect(db, secondConnector)
    apply(db, second.id, upserts('1', 'Synthetic same account evidence through another scope.'))
    const secondEpisode = (db.prepare('SELECT episode_id FROM source_revisions WHERE connection_id = ?').get(second.id) as { episode_id: string }).episode_id
    await derived(db, secondEpisode)
    expect(forgetSourceEpisodes(db, [firstEpisode])).toBe(1)
    expect(n(db, 'episodes')).toBe(0)
    expect(n(db, 'source_forget_barriers')).toBe(1)
    expect(n(db, 'source_tombstones')).toBe(2)
    expect(apply(db, second.id, upserts('2', 'Synthetic same-account forgotten revision.', 'r2')).skipped).toBe(1)
    const thirdConnector = new FakeConnector()
    thirdConnector.scope_hash = sourceHash('synthetic-new-permission-scope-after-forget')
    const third = connect(db, thirdConnector)
    expect(apply(db, third.id, upserts('1', 'Synthetic new connection reimport must be denied.')).skipped).toBe(1)
    const unrelatedConnector = new FakeConnector()
    unrelatedConnector.account_hash = sourceHash('synthetic-independent-account')
    const unrelated = connect(db, unrelatedConnector)
    expect(apply(db, unrelated.id, upserts('1', 'Synthetic unrelated account with colliding external id.')).upserted).toBe(1)
    expect(n(db, 'episodes')).toBe(1)
    expect(() => db.exec('DELETE FROM source_forget_barriers')).toThrow('immutable')
    expect(() => db.exec(`INSERT OR REPLACE INTO source_forget_barriers(id, namespace, owner_principal, provider, account_hash, external_id, created_at)
      SELECT 'replacement-barrier', namespace, '', provider, account_hash, external_id, created_at FROM source_forget_barriers`)).toThrow('immutable')
    expect(() => db.prepare('UPDATE source_connections SET account_hash = ? WHERE id = ?').run(unrelated.account_hash, first.id)).toThrow('immutable')
  })

  it('persists account-wide forgotten barriers across close/reopen and applies a staged stale page without resurrection', () => {
    manager.close()
    const dir = mkdtempSync(join(tmpdir(), 'engram-synthetic-source-forget-'))
    dirs.push(dir)
    const path = join(dir, 'test.db')
    manager = new DatabaseManager(path)
    db = manager.db
    migrate(db, path)
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    const stale = upserts('2', 'Synthetic forgotten stale replay.', 'r2')
    const receipt = stageSourcePage(db, connection.id, { cursor: '1', generation: 1 }, stale)
    forgetSourceEpisodes(db, [currentEpisode(db)])
    const generation = readSourceGeneration(db)
    manager.close()
    manager = new DatabaseManager(path)
    db = manager.db
    expect(readSourceGeneration(db)).toBe(generation)
    expect(applySourcePage(db, receipt.id, stale)).toMatchObject({ skipped: 1, upserted: 0 })
    const changedScope = new FakeConnector()
    changedScope.scope_hash = sourceHash('synthetic-reopened-new-scope')
    const reopened = connect(db, changedScope)
    expect(apply(db, reopened.id, upserts('1')).skipped).toBe(1)
    expect(n(db, 'episodes')).toBe(0)
    expect(n(db, 'source_forget_barriers')).toBe(1)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('uses stable canonical replay hashes without treating ordered change streams as unordered', () => {
    const connection = connect(db)
    const page = upserts('1')
    const reordered = { changes: [{ content: 'Synthetic launch date is October twelve.', revision: 'r1', external_id: 'item-1', kind: 'upsert' }], next_cursor: '1' }
    const receipt = stageSourcePage(db, connection.id, position(connection), page)
    expect(stageSourcePage(db, connection.id, position(connection), reordered).id).toBe(receipt.id)
    expect(applySourcePage(db, receipt.id, reordered).upserted).toBe(1)
    expect(sourceHash({ z: { b: 2, a: 1 }, a: [1, 2] })).toBe(sourceHash({ a: [1, 2], z: { a: 1, b: 2 } }))
    expect(sourceHash([1, 2])).not.toBe(sourceHash([2, 1]))
  })

  it('journals idle null/same/advancing cursors without content-generation churn and fences competing idle pages', () => {
    const connection = connect(db)
    const idle: SourcePage = { next_cursor: null, changes: [] }
    const receipt = stageSourcePage(db, connection.id, position(connection), idle)
    const competitor = stageSourcePage(db, connection.id, position(connection), { next_cursor: 'idle-advanced', changes: [] })
    expect(applySourcePage(db, receipt.id, idle)).toMatchObject({ upserted: 0, replay: false })
    expect(getSourceConnection(db, connection.id)).toMatchObject({ cursor: null, generation: 1 })
    expect(applySourcePage(db, receipt.id, idle).replay).toBe(true)
    expect(() => applySourcePage(db, competitor.id, { next_cursor: 'idle-advanced', changes: [] })).toThrow('cursor conflict')
    apply(db, connection.id, { next_cursor: 'idle-advanced', changes: [] })
    apply(db, connection.id, { next_cursor: 'idle-advanced', changes: [] })
    expect(getSourceConnection(db, connection.id)).toMatchObject({ cursor: 'idle-advanced', generation: 3 })
    expect(readSourceGeneration(db)).toBe(0)
    expect(n(db, 'episodes')).toBe(0)
    expect(() => stageSourcePage(db, connection.id, { cursor: 'idle-advanced', generation: 3 }, upserts('idle-advanced'))).toThrow('nonempty')
    expect(() => stageSourcePage(db, connection.id, { cursor: 'idle-advanced', generation: 3 }, idle)).toThrow('rebootstrap')
  })

  it('rejects a connector whose host authority binding changes during asynchronous fetch', async () => {
    const connector = new FakeConnector()
    const connection = connect(db, connector)
    connector.changes = async () => { connector.scope_hash = sourceHash('changed-synthetic-scope'); return upserts('1') }
    await expect(syncSourcePage(db, connection.id, connector)).rejects.toThrow('binding changed')
    expect(n(db, 'source_pages')).toBe(0)
  })

  it('reads an absent generation only for genuinely absent lifecycle schema and propagates DB errors', () => {
    const legacy = new Database(':memory:')
    expect(readSourceGeneration(legacy)).toBe(0)
    expect(sourceDerivedMemoryIds(legacy)).toEqual([])
    legacy.close()
    expect(() => readSourceGeneration(legacy)).toThrow()
    expect(() => sourceDerivedMemoryIds(legacy)).toThrow()
  })

  it('advances global source generation transactionally across changes, replacement, forget and revoke', () => {
    expect(readSourceGeneration(db)).toBe(0)
    const connection = connect(db)
    const page = upserts('1')
    const receipt = stageSourcePage(db, connection.id, position(connection), page)
    const before = readSourceGeneration(db)
    db.exec("CREATE TRIGGER synthetic_cursor_crash BEFORE UPDATE OF cursor ON source_connections BEGIN SELECT RAISE(ABORT, 'cursor crash'); END")
    expect(() => applySourcePage(db, receipt.id, page)).toThrow('cursor crash')
    expect(readSourceGeneration(db)).toBe(before)
    expect(n(db, 'episodes')).toBe(0)
    db.exec('DROP TRIGGER synthetic_cursor_crash')
    applySourcePage(db, receipt.id, page)
    const initial = readSourceGeneration(db)
    expect(initial).toBeGreaterThan(before)
    applySourcePage(db, receipt.id, page)
    expect(readSourceGeneration(db)).toBe(initial)
    apply(db, connection.id, upserts('2', 'Synthetic replacement generation.', 'r2'))
    const replacement = readSourceGeneration(db)
    expect(replacement).toBeGreaterThan(initial)
    forgetSourceEpisodes(db, [currentEpisode(db)])
    const forgotten = readSourceGeneration(db)
    expect(forgotten).toBeGreaterThan(replacement)
    revokeSourceConnection(db, connection.id)
    expect(readSourceGeneration(db)).toBeGreaterThan(forgotten)
    const other = connect(db, { ...new FakeConnector(), scope_hash: sourceHash('different-synthetic-scope'), changes: async () => upserts('1') })
    apply(db, other.id, upserts('1'))
    const beforeDelete = readSourceGeneration(db)
    apply(db, other.id, { next_cursor: '2', changes: [{ kind: 'delete', external_id: 'item-1' }] })
    expect(readSourceGeneration(db)).toBeGreaterThan(beforeDelete)
  })

  it('reports source-derived claims and legitimate manual successors but not foreign edges', async () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    const seed = await derived(db, currentEpisode(db))
    const revision = await new MemoryStore(db, false).revise({ id: seed, content: 'Synthetic source-derived manual successor.' })
    if (!revision) throw new Error('synthetic revision missing')
    expect(sourceDerivedMemoryIds(db)).toEqual([seed, revision.id].sort())
    const row = db.prepare('SELECT session_id FROM memories WHERE id = ?').get(seed) as { session_id: string }
    const foreign = await withCaller(BOB, () => new MemoryStore(db, false).store({ session_id: row.session_id, project_path: NS, content: 'Synthetic unrelated foreign claim.' }))
    if (foreign.status === 'rejected') throw new Error(foreign.reason)
    db.prepare("INSERT INTO memory_links(source_id, target_id, similarity, link_type, created_at, revision) VALUES (?, ?, 1, 'supersedes', 1, 1)").run(foreign.id, seed)
    expect(sourceDerivedMemoryIds(db)).not.toContain(foreign.id)
    revokeSourceConnection(db, connection.id)
    expect(sourceDerivedMemoryIds(db)).toEqual([])
  })

  it('rolls back derived purge, current evidence and global generation if replacement cursor commit fails', async () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    const oldId = currentEpisode(db)
    const memoryId = await derived(db, oldId)
    db.prepare('INSERT INTO project_digests(namespace, content) VALUES (?, ?)').run(NS, 'Synthetic cached old claim.')
    const before = readSourceGeneration(db)
    const page = upserts('2', 'Synthetic replacement after rollback.', 'r2')
    const receipt = stageSourcePage(db, connection.id, { cursor: '1', generation: 1 }, page)
    db.exec("CREATE TRIGGER synthetic_replacement_crash BEFORE UPDATE OF cursor ON source_connections BEGIN SELECT RAISE(ABORT, 'replacement crash'); END")
    expect(() => applySourcePage(db, receipt.id, page)).toThrow('replacement crash')
    expect(readSourceGeneration(db)).toBe(before)
    expect(currentEpisode(db)).toBe(oldId)
    expect(n(db, 'source_revisions')).toBe(1)
    expect(n(db, 'project_digests')).toBe(1)
    expect(new MemoryStore(db, false).getById(memoryId)).not.toBeNull()
    expect(citedEpisodes(db, memoryId)).toHaveLength(1)
    db.exec('DROP TRIGGER synthetic_replacement_crash')
    applySourcePage(db, receipt.id, page)
    expect(new MemoryStore(db, false).getById(memoryId)).toBeNull()
    expect(n(db, 'project_digests')).toBe(0)
  })

  it('does not purge unrelated same-owner memories in another namespace through forged provenance', async () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    const episodeId = currentEpisode(db)
    const sourceMemory = await derived(db, episodeId)
    db.prepare('INSERT INTO sessions(id, project_path, started_at) VALUES (?, ?, 1)').run('other-scope-session', '/synthetic/unrelated')
    const foreign = await new MemoryStore(db, false).store({ session_id: 'other-scope-session', project_path: '/synthetic/unrelated', content: 'Synthetic unrelated same-owner memory.' })
    if (foreign.status === 'rejected') throw new Error(foreign.reason)
    expect(() => linkMemoryEpisode(db, { memory_id: foreign.id, episode_id: episodeId, span_start: null, span_end: null })).toThrow('same namespace')
    db.prepare('INSERT INTO memory_episodes(memory_id, episode_id, created_at) VALUES (?, ?, 1)').run(foreign.id, episodeId)
    db.prepare("INSERT INTO memory_links(source_id, target_id, similarity, link_type, created_at, revision) VALUES (?, ?, 1, 'supersedes', 1, 1)").run(foreign.id, sourceMemory)
    expect(sourceDerivedMemoryIds(db)).not.toContain(foreign.id)
    revokeSourceConnection(db, connection.id)
    expect(new MemoryStore(db, false).getById(foreign.id)).not.toBeNull()
  })

  it('blocks citation inheritance from superseded managed evidence', async () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    const oldId = currentEpisode(db)
    apply(db, connection.id, upserts('2', 'Synthetic replacement text.', 'r2'))
    const newMemory = await derived(db, currentEpisode(db))
    expect(() => linkMemoryEpisode(db, { memory_id: newMemory, episode_id: oldId, span_start: null, span_end: null })).toThrow('current')
    expect(inheritMemoryEpisodes(db, newMemory, [newMemory])).toBe(0)
  })

  it('uses binary evidence grants and named query prefixes after authority changes', async () => {
    const broad: CallerScope = { ...ALICE, grants: [{ prefix: '/synthetic', verbs: ['read', 'write', 'delete'] }] }
    const connector = new FakeConnector()
    const connection = withCaller(broad, () => createSourceConnection(db, connector, { namespace: '/synthetic/Upper/child' }))
    await withCaller(broad, () => syncSourcePage(db, connection.id, connector))
    const lower: CallerScope = { ...broad, grants: [{ prefix: '/synthetic/upper', verbs: ['read'] }] }
    withCaller(lower, () => {
      expect(() => getSourceConnection(db, connection.id)).toThrow()
      expect(countEpisodes(db, {})).toBe(0)
      expect(episodeLexicalHits(db, 'Synthetic launch', { namespace_subtree: '/synthetic/upper' })).toEqual([])
    })
    withCaller(broad, () => {
      expect(countEpisodes(db, { namespace_subtree: '/synthetic/upper' })).toBe(0)
      expect(countEpisodes(db, { namespace_subtree: '/synthetic/Upper' })).toBe(1)
    })
  })

  it('preserves tracked revision lineage through duplicate pruning until revocation', async () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    const seed = await derived(db, currentEpisode(db))
    const store = new MemoryStore(db, false)
    const content = store.getById(seed)!.content
    const revised = await store.revise({ id: seed, content })
    const independent = await store.store({ session_id: store.getById(seed)!.session_id, project_path: NS, content, importance: 1 })
    if (independent.status === 'rejected') throw new Error(independent.reason)
    expect(sourceDerivedMemoryIds(db)).toContain(revised!.memory.id)
    runDuplicatePrune(db, { namespace: NS })
    expect(sourceDerivedMemoryIds(db)).toContain(revised!.memory.id)
    expect(db.prepare('SELECT archived_at FROM memories WHERE id = ?').get(revised!.memory.id)).toEqual({ archived_at: null })
    revokeSourceConnection(db, connection.id)
    expect(store.getById(seed)).toBeNull()
    expect(store.getById(revised!.memory.id)).toBeNull()
    expect(store.getById(independent.id)).not.toBeNull() // unlinked manual copies are outside source lineage
  })

  it('invalidates sibling-cluster navigation and job payloads along the cache dependency closure', async () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    const seed = await derived(db, currentEpisode(db))
    db.prepare('UPDATE memories SET importance = 1 WHERE id = ?').run(seed)
    const other = '/synthetic/source-sibling'
    ensureNode(db, other)
    db.prepare('INSERT INTO sessions(id, project_path, started_at) VALUES (?, ?, 1)').run('sibling-session', other)
    const independent = await new MemoryStore(db, false).store({ session_id: 'sibling-session', project_path: other, content: 'Independent synthetic sibling observation.', importance: 0.1 })
    if (independent.status === 'rejected') throw new Error(independent.reason)
    db.prepare("INSERT INTO memory_links(source_id, target_id, similarity, link_type, created_at) VALUES (?, ?, 1, 'semantic', 1)").run(seed, independent.id)
    expect(await runClusterWorker(db, other)).toBe(0) // new writes require members inside their declared scope
    // older host clustering supported cross-namespace members; validate its retained cache too.
    db.prepare('INSERT INTO memory_clusters(project_path, member_ids, summary, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run(other, JSON.stringify([seed, independent.id]), 'Synthetic removed wording from a retained cross-namespace cluster.')
    const cached = await refreshNavDigest(db, other)
    expect(cached.content).toContain('removed wording')
    const job = enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: `nav:${other}` })
    completeMaintenanceJob(db, job.id, { status: 'done', result: { content: cached.content } })
    revokeSourceConnection(db, connection.id)
    expect(db.prepare('SELECT digest FROM namespace_nodes WHERE path = ?').get(other)).toEqual({ digest: null })
    expect(db.prepare('SELECT result_json FROM maintenance_jobs WHERE id = ?').get(job.id)).toEqual({ result_json: '{"redacted":"source-lifecycle"}' })
    expect(JSON.stringify(childRoster(db, '/synthetic'))).not.toContain('removed wording')
    expect(new MemoryStore(db, false).getById(independent.id)).not.toBeNull()
  })

  it('does not return buffered source hits after the search await crosses revocation', async () => {
    const connection = connect(db)
    apply(db, connection.id, upserts('1'))
    const pending = retrieveEpisodeContext({ db, namespace: NS, query: 'Synthetic launch', budget_chars: 2000, vectorsAvailable: false })
    revokeSourceConnection(db, connection.id)
    const result = await pending
    expect(result.context).toBe('')
    expect(result.hits).toEqual([])
  })
})
