// the episode lifecycle: evidence cited by the memories distilled from it, the
// item-level delete behind delete_episodes, and the retention sweep that reclaims what
// expiry already hides. the read paths have their own file (tests/episodes.test.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { migrations } from '../src/db/migrations/index.js'
import { runMigrations } from '../src/db/migrations/runner.js'
import { migration023 } from '../src/db/migrations/023_episode_expiry.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { EMBEDDING_DIM } from '../src/embeddings/pipeline.js'
import {
  citedEpisodes,
  countMatchingEpisodes,
  deleteEpisodes,
  episodesForMemory,
  ingestEpisodes,
  linkMemoryEpisode,
  setEpisodeEmbedder,
  type IngestEpisodeItem,
} from '../src/memory/episodes.js'
import {
  EPISODE_SWEEP_LIMIT,
  episodeSweepTargetKey,
  nextEpisodeSweepPage,
  sweepExpiredEpisodes,
} from '../src/maintenance/episode-retention.js'
import {
  enqueueEndSessionMaintenance,
  enqueueMaintenanceJob,
  enqueueNamespaceMaintenance,
  runPendingMaintenanceJobs,
} from '../src/maintenance/jobs.js'
import { runDuplicatePrune } from '../src/maintenance/prune.js'
import { promoteScopePatterns, PROMOTE_MIN_MEMORIES } from '../src/maintenance/promote.js'
import { ensureNode } from '../src/namespace/tree.js'
import { resetLlmConfigForTests } from '../src/llm/client.js'
import { createTestDb } from './helpers.js'

const NS = '/home/user/lifecycle-project'
const CHILD_NS = `${NS}/child`
const SOURCE = 'codex'

/** the legacy schema a database carries before the migrations run */
const BASELINE = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, summary TEXT, tool_name TEXT);
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    project_path TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'note',
    importance REAL NOT NULL DEFAULT 0.5,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    last_accessed INTEGER,
    access_count INTEGER NOT NULL DEFAULT 0,
    vec_rowid INTEGER
  );
  CREATE TABLE memory_links (
    source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    similarity REAL NOT NULL,
    link_type TEXT NOT NULL DEFAULT 'semantic',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, target_id)
  );
`

function parse<T>(result: { content: Array<{ text: string }>; isError?: boolean }): T {
  return JSON.parse(result.content[0].text) as T
}

function item(overrides: Partial<IngestEpisodeItem> & { external_id: string }): IngestEpisodeItem {
  return { content: `turn ${overrides.external_id}`, ...overrides }
}

/** deterministic per-text vector, unit length in a hashed direction */
function unitVector(text: string, dim: number = EMBEDDING_DIM): Float32Array {
  const vector = new Float32Array(dim)
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash = ((hash ^ text.charCodeAt(i)) * 16777619) >>> 0
  }
  vector[hash % dim] = 1
  return vector
}

function seedSession(db: Database.Database, id: string, ended: boolean): void {
  db.prepare(
    'INSERT OR IGNORE INTO sessions (id, project_path, started_at, ended_at) VALUES (?, ?, ?, ?)'
  ).run(id, NS, 1, ended ? 2 : null)
}

/** one episode row with the retention fields under test; the ingest path has its own file */
function seedEpisode(
  db: Database.Database,
  row: {
    id: string
    content: string
    namespace?: string
    session_id?: string
    retention?: string
    expires_at?: number | null
    occurred_at?: number | null
    source?: string
    external_id?: string
  }
): void {
  db.prepare(
    `INSERT INTO episodes
       (id, namespace, session_id, source, external_id, occurred_at, ingested_at, content,
        retention, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    row.id,
    row.namespace ?? NS,
    row.session_id ?? 'episode-session',
    row.source ?? SOURCE,
    row.external_id ?? row.id,
    row.occurred_at ?? null,
    row.content,
    row.retention ?? 'durable',
    row.expires_at ?? null
  )
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n
}

afterEach(() => {
  setEpisodeEmbedder(null)
  resetDatabase()
  resetServicesForTests()
})

describe('memory citations', () => {
  it('links the episodes a task summary was distilled from, through the mcp surface', async () => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')

    const task = parse<{ task: { id: string } }>(
      await handleTool('task_start', { title: 'ship the sweeper', goal: 'reclaim expired evidence', project_path: NS })
    )
    const taskId = task.task.id
    const ingested = parse<{ items: Array<{ id: string; status: string }> }>(
      await handleTool('ingest_episodes', {
        project_path: NS,
        source: { system: SOURCE, instance: 'host:alice' },
        episodes: [
          {
            external_id: 'turn-0',
            content: 'the sweeper deletes expired evidence in bounded pages',
            task_id: taskId,
            session_id: 'session-a',
            occurred_at: 1_700_000_000_000,
            uri: 'file:///tmp/transcript.jsonl',
          },
          // another task's evidence must not be cited
          { external_id: 'turn-1', content: 'an unrelated turn', task_id: 'some-other-task' },
        ],
      })
    )
    const episodeId = ingested.items[0].id

    const closed = parse<{ memory: { id: string }; linked_episodes: number }>(
      await handleTool('task_close', { id: taskId, project_path: NS })
    )
    expect(closed.linked_episodes).toBe(1)

    const fetched = parse<{ episodes: Array<Record<string, unknown>> }>(
      await handleTool('get_memory', { id: closed.memory.id })
    )
    expect(fetched.episodes).toHaveLength(1)
    expect(fetched.episodes[0]).toMatchObject({
      id: episodeId,
      source: SOURCE,
      external_id: 'turn-0',
      occurred_at: 1_700_000_000_000,
      uri: 'file:///tmp/transcript.jsonl',
      session_id: 'session-a',
      span_start: null,
      span_end: null,
    })

    // the cited episodes come back on the history view too, per version
    const history = parse<{ versions: Array<{ id: string; episodes: unknown[] }> }>(
      await handleTool('get_memory_history', { id: closed.memory.id })
    )
    expect(history.versions[0].episodes).toHaveLength(1)

    // a memory with no evidence answers with an empty list rather than an absent field
    const plain = parse<{ id: string }>(
      await handleTool('store_memory', { content: 'a fact with no evidence behind it', project_path: NS })
    )
    const plainFetched = parse<{ episodes: unknown[] }>(await handleTool('get_memory', { id: plain.id }))
    expect(plainFetched.episodes).toEqual([])
  })

  it('keeps the citation of a memory the prune absorbed', () => {
    const { db } = createTestDb()
    seedSession(db, 's-prune', true)
    const seed = db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
       VALUES (?, 's-prune', ?, ?, ?, 'note', 0.5, '[]', ?)`
    )
    seed.run('dup-old', NS, NS, 'the retention sweep reclaims expired evidence in pages', 100)
    seed.run('dup-new', NS, NS, 'the retention sweep reclaims expired evidence in pages', 200)
    seedEpisode(db, { id: 'ep-old', content: 'evidence for the older duplicate' })
    seedEpisode(db, { id: 'ep-new', content: 'evidence for the newer duplicate' })
    linkMemoryEpisode(db, { memory_id: 'dup-old', episode_id: 'ep-old', span_start: 2, span_end: 9 })
    linkMemoryEpisode(db, { memory_id: 'dup-new', episode_id: 'ep-new', span_start: 2, span_end: 9 })

    const report = runDuplicatePrune(db, { namespace: NS })

    expect(report.archived).toBe(1)
    expect(report.episodes_repointed).toBe(1)
    const keeper = report.groups[0].keeper_id
    const absorbed = keeper === 'dup-old' ? 'dup-new' : 'dup-old'
    const cited = episodesForMemory(db, keeper).map((row) => row.episode_id).sort()
    expect(cited).toEqual(['ep-new', 'ep-old'])
    // the absorbed row keeps its own citation: it is archived, not deleted
    expect(episodesForMemory(db, absorbed).map((row) => row.episode_id)).toEqual([
      absorbed === 'dup-old' ? 'ep-old' : 'ep-new',
    ])
  })

  it('links a promoted pattern to the union of its sources evidence', async () => {
    const { db } = createTestDb()
    process.env.ENGRAM_PROMOTE_EXTRACTIVE = '1'
    resetLlmConfigForTests()
    seedSession(db, 's-promote', true)
    ensureNode(db, NS)
    ensureNode(db, `${NS}//payments`)

    const seed = db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
       VALUES (?, 's-promote', ?, ?, ?, 'note', 0.5, '[]', ?)`
    )
    for (let i = 0; i < PROMOTE_MIN_MEMORIES; i++) {
      seed.run(`pay-${i}`, NS, `${NS}//payments`, `payments fact ${i} from this scope`, 100 + i)
    }
    const ingested = await ingestEpisodes(db, {
      namespace: `${NS}//payments`,
      source: SOURCE,
      items: [item({ external_id: 'scope-0' }), item({ external_id: 'scope-1' })],
      now: 1000,
    })
    linkMemoryEpisode(db, {
      memory_id: 'pay-0',
      episode_id: ingested.items[0].id,
      span_start: 0,
      span_end: 4,
    })
    linkMemoryEpisode(db, {
      memory_id: 'pay-1',
      episode_id: ingested.items[1].id,
      span_start: 1,
      span_end: 5,
    })

    const report = await promoteScopePatterns(db, NS)
    delete process.env.ENGRAM_PROMOTE_EXTRACTIVE

    expect(report.promoted).toEqual(['payments'])
    const pattern = db
      .prepare("SELECT id FROM memories WHERE origin = 'promotion'")
      .get() as { id: string }
    const cited = citedEpisodes(db, pattern.id)
    expect(cited.map((episode) => episode.external_id).sort()).toEqual(['scope-0', 'scope-1'])
    expect(cited.map((episode) => episode.span_start).sort()).toEqual([0, 1])
  })
})

describe('delete_episodes', () => {
  let db: Database.Database

  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    db = getDatabase().db
  })

  it('deletes a namespace subtree and reports the counts per table', async () => {
    const ingested = await ingestEpisodes(db, {
      namespace: CHILD_NS,
      source: SOURCE,
      items: [item({ external_id: 'child-0' }), item({ external_id: 'child-1' })],
      now: 1,
    })
    await ingestEpisodes(db, { namespace: NS, source: SOURCE, items: [item({ external_id: 'root-0' })], now: 1 })
    db.prepare("INSERT INTO sessions (id, project_path, started_at) VALUES ('s-sub', ?, 1)").run(NS)
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, created_at)
       VALUES ('m-sub', 's-sub', ?, ?, 'a fact cited by the child evidence', 1)`
    ).run(NS, NS)
    linkMemoryEpisode(db, { memory_id: 'm-sub', episode_id: ingested.items[0].id, span_start: 0, span_end: 1 })

    const deleted = parse<{ episodes: number; links: number; vectors: number; fts: number }>(
      await handleTool('delete_episodes', { namespace: NS, subtree: true })
    )
    expect(deleted).toMatchObject({ episodes: 3, links: 1, vectors: 0, fts: 3 })
    expect(count(db, 'SELECT COUNT(*) AS n FROM episodes')).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM episodes_fts')).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM memory_episodes')).toBe(0)
  })

  it('narrows by source, by external ids and by occurred_at', async () => {
    await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      items: [item({ external_id: 'c-0', occurred_at: 100 }), item({ external_id: 'c-1', occurred_at: 200 })],
      now: 1,
    })
    await ingestEpisodes(db, {
      namespace: NS,
      source: 'cursor',
      items: [item({ external_id: 'u-0', occurred_at: 100 }), item({ external_id: 'u-undated' })],
      now: 1,
    })

    const dry = parse<{ episodes: number; dry_run: boolean }>(
      await handleTool('delete_episodes', { namespace: NS, source: 'cursor', dry_run: true })
    )
    expect(dry.dry_run).toBe(true)
    expect(dry.episodes).toBe(2)
    expect(count(db, 'SELECT COUNT(*) AS n FROM episodes')).toBe(4)

    const bySource = parse<{ episodes: number }>(
      await handleTool('delete_episodes', { namespace: NS, source: 'cursor' })
    )
    expect(bySource.episodes).toBe(2)
    expect(
      (db.prepare('SELECT source FROM episodes ORDER BY external_id').all() as Array<{ source: string }>).map(
        (row) => row.source
      )
    ).toEqual(['codex', 'codex'])

    const byIds = parse<{ episodes: number }>(
      await handleTool('delete_episodes', { namespace: NS, external_ids: ['c-1'] })
    )
    expect(byIds.episodes).toBe(1)

    // only the dated row goes; an episode with no occurred_at has no time to compare
    await ingestEpisodes(db, {
      namespace: NS,
      source: 'cursor',
      items: [item({ external_id: 'u-1', occurred_at: 100 }), item({ external_id: 'u-undated-2' })],
      now: 1,
    })
    const byBefore = parse<{ episodes: number }>(
      await handleTool('delete_episodes', { namespace: NS, before: 150 })
    )
    expect(byBefore.episodes).toBe(2)
    expect(
      (db.prepare('SELECT external_id FROM episodes ORDER BY external_id').all() as Array<{
        external_id: string
      }>).map((row) => row.external_id)
    ).toEqual(['u-undated-2'])
  })

  it('removes the vectors and the citations along with the rows', async () => {
    const vectors = createTestDb().vectorsAvailable
    if (!vectors) return
    setEpisodeEmbedder(async (text) => unitVector(text))
    const ingested = await ingestEpisodes(db, {
      namespace: NS,
      source: SOURCE,
      items: [item({ external_id: 'v-0' }), item({ external_id: 'v-1' })],
      vectorsAvailable: true,
      now: 1,
    })
    db.prepare(
      `INSERT INTO sessions (id, project_path, started_at) VALUES ('s-vec', ?, 1)`
    ).run(NS)
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, created_at)
       VALUES ('m-vec', 's-vec', ?, ?, 'a fact cited by evidence', 1)`
    ).run(NS, NS)
    linkMemoryEpisode(db, { memory_id: 'm-vec', episode_id: ingested.items[0].id, span_start: 0, span_end: 2 })
    linkMemoryEpisode(db, { memory_id: 'm-vec', episode_id: ingested.items[1].id, span_start: 0, span_end: 2 })
    expect(count(db, 'SELECT COUNT(*) AS n FROM episode_vectors')).toBe(2)

    const deleted = parse<{ episodes: number; vectors: number; links: number; fts: number }>(
      await handleTool('delete_episodes', { namespace: NS })
    )

    expect(deleted).toMatchObject({ episodes: 2, vectors: 2, links: 2, fts: 2 })
    expect(count(db, 'SELECT COUNT(*) AS n FROM episode_vectors')).toBe(0)
    expect(episodesForMemory(db, 'm-vec')).toHaveLength(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM episodes_fts')).toBe(0)
  })

  it('refuses a call that would match the whole store', async () => {
    resetServicesForTests()
    getDatabase(':memory:')
    const mcpDb = getDatabase().db
    seedEpisode(mcpDb, { id: 'any', content: 'evidence in this store' })

    const missing = await handleTool('delete_episodes', {})
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toContain('namespace')

    const root = await handleTool('delete_episodes', { namespace: '/', subtree: true })
    expect(root.isError).toBe(true)
    expect(root.content[0].text).toContain('refusing')

    expect(count(mcpDb, 'SELECT COUNT(*) AS n FROM episodes')).toBe(1)

    // the library refuses the same shape, so a caller cannot route around the tool
    expect(() => deleteEpisodes(mcpDb, {}, {})).toThrow(/refuses/)
    expect(() => countMatchingEpisodes(mcpDb, {}, {})).toThrow(/refuses/)
    // a selector alone is a legitimate narrowing, and the namespace alone is too
    expect(countMatchingEpisodes(mcpDb, {}, { source: SOURCE }).episodes).toBe(1)
    expect(countMatchingEpisodes(mcpDb, { namespace: NS }).episodes).toBe(1)
  })

  it('treats an empty id list as naming nothing, never as no filter', async () => {
    resetServicesForTests()
    getDatabase(':memory:')
    const mcpDb = getDatabase().db
    seedEpisode(mcpDb, { id: 'kept', content: 'evidence that must survive' })

    const root = await handleTool('delete_episodes', { namespace: '/', subtree: true, external_ids: [] })
    expect(root.isError).toBe(true)

    // the library is the path a caller can reach without the schema in front of it
    expect(deleteEpisodes(mcpDb, { namespace_subtree: '/' }, { external_ids: [] }).episodes).toBe(0)
    expect(deleteEpisodes(mcpDb, { namespace: NS }, { external_ids: [] }).episodes).toBe(0)
    expect(countMatchingEpisodes(mcpDb, { namespace_subtree: '/' }, { external_ids: [] }).episodes).toBe(0)
    expect(count(mcpDb, 'SELECT COUNT(*) AS n FROM episodes')).toBe(1)
  })
})

describe('episode expiry sweep', () => {
  let db: Database.Database

  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    db = getDatabase().db
  })

  it('reclaims expired and session-ended evidence and nothing else', async () => {
    seedSession(db, 'session-closed', true)
    seedSession(db, 'session-open', false)
    const now = Date.now()

    const vectors = createTestDb().vectorsAvailable
    if (vectors) setEpisodeEmbedder(async (text) => unitVector(text))
    const expiredIngest = await ingestEpisodes(db, {
      namespace: NS,
      source: SOURCE,
      retention: 'ephemeral',
      ttl_ms: 1,
      items: [item({ external_id: 'expired', session_id: 'session-closed' })],
      vectorsAvailable: vectors,
      now,
    })
    const expiredId = expiredIngest.items[0].id
    await ingestEpisodes(db, {
      namespace: NS,
      source: SOURCE,
      retention: 'ephemeral',
      ttl_ms: 60_000,
      items: [item({ external_id: 'still-fresh' })],
      now,
    })
    seedEpisode(db, {
      id: 'session-ended',
      content: 'a turn from a session that closed',
      session_id: 'session-closed',
      retention: 'session',
    })
    seedEpisode(db, {
      id: 'session-live',
      content: 'a turn from a session still open',
      session_id: 'session-open',
      retention: 'session',
    })
    seedEpisode(db, {
      id: 'session-unknown',
      content: 'a turn from a session this store never saw',
      session_id: 'never-ingested',
      retention: 'session',
    })
    seedEpisode(db, { id: 'durable', content: 'durable evidence stays' })

    db.prepare("INSERT INTO sessions (id, project_path, started_at) VALUES ('s-sweep', ?, 1)").run(NS)
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, created_at)
       VALUES ('m-sweep', 's-sweep', ?, ?, 'a fact cited by expired evidence', 1)`
    ).run(NS, NS)
    linkMemoryEpisode(db, { memory_id: 'm-sweep', episode_id: expiredId, span_start: 0, span_end: 3 })
    const vectorsBefore = count(db, 'SELECT COUNT(*) AS n FROM episode_vectors')

    enqueueMaintenanceJob(db, {
      jobType: 'episodes_expired',
      targetKey: episodeSweepTargetKey(0),
      source: 'test',
      now,
    })
    const drained = await runPendingMaintenanceJobs(db, { maxJobs: 1 })

    expect(drained.done).toBe(1)
    const job = db
      .prepare("SELECT status, result_json FROM maintenance_jobs WHERE job_type = 'episodes_expired'")
      .get() as { status: string; result_json: string }
    expect(job.status).toBe('done')
    expect(JSON.parse(job.result_json)).toMatchObject({
      episodes_expired: true,
      episodes: 2,
      links: 1,
      vectors: vectorsBefore,
      fts: 2,
    })

    expect(
      (db.prepare('SELECT external_id FROM episodes ORDER BY external_id').all() as Array<{
        external_id: string
      }>).map((row) => row.external_id)
    ).toEqual(['durable', 'session-live', 'session-unknown', 'still-fresh'])
    expect(count(db, 'SELECT COUNT(*) AS n FROM episodes_fts')).toBe(4)
    if (vectors) expect(count(db, 'SELECT COUNT(*) AS n FROM episode_vectors')).toBe(0)
    expect(episodesForMemory(db, 'm-sweep')).toHaveLength(0)
  })

  it('is idempotent and reports an empty pass', () => {
    seedEpisode(db, { id: 'gone', content: 'expired evidence', expires_at: 10 })
    seedEpisode(db, { id: 'kept', content: 'durable evidence' })

    const first = sweepExpiredEpisodes(db, { now: 20 })
    expect(first).toMatchObject({ episodes: 1, fts: 1, truncated: false, limit: EPISODE_SWEEP_LIMIT })

    const second = sweepExpiredEpisodes(db, { now: 20 })
    expect(second).toMatchObject({ episodes: 0, links: 0, vectors: 0, fts: 0 })
    expect(count(db, 'SELECT COUNT(*) AS n FROM episodes')).toBe(1)
  })

  it('bounds one pass and flags the page that is left', () => {
    seedEpisode(db, { id: 'e1', content: 'expired one', expires_at: 10 })
    seedEpisode(db, { id: 'e2', content: 'expired two', expires_at: 10 })
    seedEpisode(db, { id: 'e3', content: 'expired three', expires_at: 10 })

    const page = sweepExpiredEpisodes(db, { now: 20, limit: 2 })

    expect(page).toMatchObject({ episodes: 2, truncated: true, limit: 2 })
    expect(count(db, 'SELECT COUNT(*) AS n FROM episodes')).toBe(1)
    // the continuation key walks the same page ladder the re-embed job uses
    expect(episodeSweepTargetKey(0)).toBe('episodes:expired')
    expect(episodeSweepTargetKey(2)).toBe('episodes:expired:2')
    expect(nextEpisodeSweepPage('episodes:expired')).toBe(1)
    expect(nextEpisodeSweepPage('episodes:expired:2')).toBe(3)
  })
})

describe('sweep scheduling', () => {
  it('is queued once at boot, and the next boot coalesces onto it', () => {
    const { db } = createTestDb()

    enqueueNamespaceMaintenance(db)
    expect(
      count(db, "SELECT COUNT(*) AS n FROM maintenance_jobs WHERE job_type = 'episodes_expired'")
    ).toBe(1)

    enqueueNamespaceMaintenance(db)
    expect(
      count(db, "SELECT COUNT(*) AS n FROM maintenance_jobs WHERE job_type = 'episodes_expired'")
    ).toBe(1)
  })

  it('is queued when a session that held session-retention evidence ends, and not otherwise', () => {
    const { db } = createTestDb()
    seedSession(db, 's-holder', false)
    seedEpisode(db, {
      id: 'held',
      content: 'a turn whose session is ending',
      session_id: 's-holder',
      retention: 'session',
    })

    expect(enqueueEndSessionMaintenance(db, 's-holder', NS)).toBeGreaterThan(0)
    expect(
      count(db, "SELECT COUNT(*) AS n FROM maintenance_jobs WHERE job_type = 'episodes_expired'")
    ).toBe(1)

    const { db: quiet } = createTestDb()
    seedSession(quiet, 's-quiet', false)
    enqueueEndSessionMaintenance(quiet, 's-quiet', NS)
    expect(
      count(quiet, "SELECT COUNT(*) AS n FROM maintenance_jobs WHERE job_type = 'episodes_expired'")
    ).toBe(0)
  })
})

describe('episode expiry migration', () => {
  let dirs: string[] = []

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  it('upgrades a database sitting at 22 with its job rows and episode rows intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-episode-expiry-'))
    dirs.push(dir)
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    db.exec(BASELINE)
    const upTo22 = migrations.filter((migration) => migration.version <= 22)

    const first = runMigrations(db, dbPath, upTo22, () => undefined)
    expect(first.finalVersion).toBe(22)
    db.prepare(
      `INSERT INTO maintenance_jobs (job_type, target_key, status, enqueued_at)
       VALUES ('reembed_episodes', 'episodes:pending', 'queued', 1)`
    ).run()
    db.prepare(
      `INSERT INTO episodes (id, namespace, session_id, source, external_id, ingested_at, content)
       VALUES ('pre-23', ?, 's1', 'codex', 'pre-23', 1, 'evidence written before the upgrade')`
    ).run(NS)

    const second = runMigrations(db, dbPath, migrations, () => undefined)
    expect(second.applied.map((m) => m.version)).toContain(23)
    expect((db.prepare('SELECT COUNT(*) AS n FROM maintenance_jobs').get() as { n: number }).n).toBe(1)
    expect(
      (db.prepare('SELECT job_type FROM maintenance_jobs').get() as { job_type: string }).job_type
    ).toBe('reembed_episodes')
    expect((db.prepare('SELECT COUNT(*) AS n FROM episodes').get() as { n: number }).n).toBe(1)
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'maintenance_jobs'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(indexes).toContain('idx_maintenance_jobs_active')
    expect(indexes).toContain('idx_maintenance_jobs_status')
    // the rebuilt table still coalesces a re-enqueue on its active row
    expect(() =>
      db
        .prepare(
          `INSERT INTO maintenance_jobs (job_type, target_key, status, enqueued_at)
           VALUES ('reembed_episodes', 'episodes:pending', 'queued', 2)`
        )
        .run()
    ).toThrow(/UNIQUE/)

    const third = runMigrations(db, dbPath, migrations, () => undefined)
    expect(third.applied).toEqual([])
    db.close()
  })

  it('registers version 23 and accepts the job type it adds', () => {
    const { db } = createTestDb()
    expect(migrations.map((m) => m.version)).toContain(23)

    db.prepare(
      `INSERT INTO maintenance_jobs (job_type, target_key, status, enqueued_at)
       VALUES ('episodes_expired', 'episodes:expired', 'queued', 1)`
    ).run()
    expect(
      count(db, "SELECT COUNT(*) AS n FROM maintenance_jobs WHERE job_type = 'episodes_expired'")
    ).toBe(1)
    expect(() =>
      db
        .prepare(
          `INSERT INTO maintenance_jobs (job_type, target_key, status, enqueued_at)
           VALUES ('not_a_job', 'x', 'queued', 1)`
        )
        .run()
    ).toThrow(/CHECK/)

    // a second application keeps the rows and stays a no-op
    migration023.up(db)
    expect(count(db, 'SELECT COUNT(*) AS n FROM maintenance_jobs')).toBe(1)
    expect(
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_jobs'"
        )
        .get() as { sql: string }
    ).toMatchObject({ sql: expect.stringContaining('episodes_expired') })
  })
})
