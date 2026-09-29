// episodes: the raw evidence layer. the tests below cover the schema on a fresh and
// an upgraded database, the ingest contract (idempotency, delta batches, admission),
// the namespace-scoped channels, the assembly recipe and the memory_episodes links.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { runMigrations } from '../src/db/migrations/runner.js'
import { migrations } from '../src/db/migrations/index.js'
import { tableExists } from '../src/db/migrations/types.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { EMBEDDING_DIM, MODEL_ID } from '../src/embeddings/pipeline.js'
import { reembedStaleEpisodes } from '../src/db/workers/reembed.js'
import {
  countEpisodes,
  deleteEpisodes,
  episodeVectorsAvailable,
  episodesForMemory,
  ingestEpisodes,
  linkMemoryEpisode,
  setEpisodeBatchEmbedder,
  setEpisodeEmbedder,
  type EpisodeIngestResult,
  type IngestEpisodeItem,
} from '../src/memory/episodes.js'
import { searchEpisodes } from '../src/memory/search/episodes.js'
import {
  assembleEpisodeContext,
  retrieveEpisodeContext,
  type EpisodeSessionTurns,
} from '../src/memory/episode-context.js'
import { createTestDb } from './helpers.js'

const NS = '/home/user/episodes-project'
const OTHER_NS = '/home/user/other-project'
// assembled at runtime so no provider-shaped literal lands in the source
const SECRET = ['sk', '-', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')

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

const UP_TO_017 = migrations.filter((migration) => migration.version <= 17)

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'engram-episodes-'))
}

function item(overrides: Partial<IngestEpisodeItem> & { external_id: string }): IngestEpisodeItem {
  return {
    content: `content of ${overrides.external_id}`,
    session_id: 's1',
    turn_index: 0,
    occurred_at: 1_700_000_000_000,
    ...overrides,
  }
}

/** the id the batch answered with, for an item that was written or already there */
function idOf(result: EpisodeIngestResult, externalId: string): string {
  const entry = result.items.find((candidate) => candidate.external_id === externalId)
  if (!entry || entry.status === 'rejected') throw new Error(`no episode id for ${externalId}`)
  return entry.id
}

describe('migration 019', () => {
  let dirs: string[] = []

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  it('creates the episodes tables on a fresh database, without touching memories', () => {
    resetDatabase()
    const { db } = createTestDb()

    expect(tableExists(db, 'episodes')).toBe(true)
    expect(tableExists(db, 'memory_episodes')).toBe(true)
    const fts = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'episodes_fts'")
      .all()
    expect(fts).toHaveLength(1)

    const columns = (db.prepare('PRAGMA table_info(episodes)').all() as Array<{ name: string }>).map(
      (row) => row.name
    )
    expect(columns).toEqual([
      'id',
      'namespace',
      'session_id',
      'task_id',
      'source',
      'source_instance',
      'source_version',
      'external_id',
      'author',
      'role',
      'occurred_at',
      'ingested_at',
      'content_type',
      'content',
      'uri',
      'turn_index',
      'parent_external_id',
      'chunk_index',
      'chunk_of',
      'visibility',
      'retention',
      'expires_at',
      'provenance_json',
      'vec_rowid',
      'embed_state',
      'embedding_model',
      'embedding_dim',
    ])

    const memoryColumns = (
      db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(memoryColumns).not.toContain('episode_id')
    resetDatabase()
  })

  it('upgrades a database at the latest main migration and keeps its rows', () => {
    const dir = tmpDir()
    dirs.push(dir)
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    db.exec(BASELINE)
    db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
      'sess',
      NS,
      1
    )
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, content, type, importance, tags, created_at)
       VALUES ('m1', 'sess', ?, 'the deploy window is 09:00-11:30 utc', 'note', 0.5, '[]', 1)`
    ).run(NS)

    const first = runMigrations(db, dbPath, UP_TO_017, () => undefined)
    expect(first.finalVersion).toBe(17)
    expect(tableExists(db, 'episodes')).toBe(false)

    const second = runMigrations(db, dbPath, migrations, () => undefined)
    expect(second.finalVersion).toBeGreaterThanOrEqual(19)
    expect(second.applied.map((m) => m.version)).toContain(19)
    expect(tableExists(db, 'episodes')).toBe(true)
    expect(tableExists(db, 'memory_episodes')).toBe(true)
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(1)

    const third = runMigrations(db, dbPath, migrations, () => undefined)
    expect(third.applied).toEqual([])
    db.close()
  })
})

describe('episode ingest', () => {
  let db: import('better-sqlite3').Database

  beforeEach(() => {
    resetDatabase()
    db = createTestDb().db
  })

  afterEach(() => {
    setEpisodeEmbedder(null)
    setEpisodeBatchEmbedder(null)
    resetDatabase()
  })

  it('writes a batch and re-ingests it as duplicates at no cost', async () => {
    const items = [
      item({ external_id: 's1:0', content: 'user: what is the deploy window?' }),
      item({ external_id: 's1:1', session_id: 's1', turn_index: 1, content: 'assistant: 09:00-11:30 utc' }),
      item({ external_id: 's1:2', session_id: 's1', turn_index: 2, content: 'user: thanks' }),
    ]
    const first = await ingestEpisodes(db, { namespace: NS, source: 'codex', items, now: 1_700_000_100_000 })

    expect(first.ingested).toBe(3)
    expect(first.duplicates).toBe(0)
    expect(first.rejected).toBe(0)
    expect(countEpisodes(db, { namespace: NS })).toBe(3)
    const stored = db
      .prepare('SELECT ingested_at, namespace, turn_index FROM episodes WHERE external_id = ?')
      .get('s1:1') as { ingested_at: number; namespace: string; turn_index: number }
    expect(stored.ingested_at).toBe(1_700_000_100_000)
    expect(stored.namespace).toBe(NS)
    expect(stored.turn_index).toBe(1)

    const again = await ingestEpisodes(db, { namespace: NS, source: 'codex', items })
    expect(again.ingested).toBe(0)
    expect(again.duplicates).toBe(3)
    expect(countEpisodes(db, { namespace: NS })).toBe(3)
    for (const entry of again.items) {
      expect(entry.status).toBe('duplicate')
    }
  })

  it('accepts a delta batch and keeps the ids it already wrote', async () => {
    const source = 'claude-code'
    const firstBatch = await ingestEpisodes(db, {
      namespace: NS,
      source,
      items: [item({ external_id: 'a' }), item({ external_id: 'b', turn_index: 1 })],
    })
    const idOfB = idOf(firstBatch, 'b')

    const delta = await ingestEpisodes(db, {
      namespace: NS,
      source,
      items: [
        item({ external_id: 'b', turn_index: 1 }),
        item({ external_id: 'c', turn_index: 2 }),
      ],
    })

    expect(delta.ingested).toBe(1)
    expect(delta.duplicates).toBe(1)
    expect(idOf(delta, 'b')).toBe(idOfB)
    expect(countEpisodes(db, { namespace: NS })).toBe(3)
  })

  it('refuses a credential on the ingest path, for an api and an mcp caller alike', async () => {
    for (const origin of ['eval-system', 'mcp']) {
      const result = await ingestEpisodes(db, {
        namespace: NS,
        source: 'codex',
        origin,
        items: [
          item({ external_id: `${origin}:ok`, content: 'the deploy window is 09:00-11:30 utc' }),
          item({ external_id: `${origin}:bad`, content: `the key is ${SECRET}` }),
        ],
      })
      expect(result.ingested).toBe(1)
      expect(result.rejected).toBe(1)
      const refusal = result.items.find((entry) => entry.status === 'rejected')!
      expect(refusal).toMatchObject({ external_id: `${origin}:bad`, rule: 'secrets' })
      // the reason names the shape, never the value
      expect(JSON.stringify(refusal)).not.toContain(SECRET)
    }
    expect(countEpisodes(db, { namespace: NS })).toBe(2)
  })

  it('refuses an item with no id or no content instead of writing half a row', async () => {
    const result = await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      items: [
        { external_id: '', content: 'orphan' },
        { external_id: 'empty', content: '' },
      ],
    })
    expect(result.rejected).toBe(2)
    expect(result.ingested).toBe(0)
    expect(countEpisodes(db, { namespace: NS })).toBe(0)
  })

  it('keeps the envelope fields, and the chunk it was cut from', async () => {
    await ingestEpisodes(db, {
      namespace: NS,
      source: 'adk',
      source_instance: 'host:alice',
      source_version: '2.1.0',
      visibility: 'project',
      retention: 'ephemeral',
      ttl_ms: 1000,
      now: 5_000,
      items: [
        {
          external_id: 'c0',
          content: 'chunk zero',
          session_id: 'run-1',
          task_id: 't-9f2',
          author: 'tool',
          role: 'tool',
          content_type: 'application/json',
          uri: 'file:///repo/src/server.ts',
          parent_external_id: 'whole',
          chunk_index: 0,
          chunk_of: 2,
          provenance: { repo: 'engram', commit: '046fa30' },
        },
      ],
    })
    const row = db.prepare('SELECT * FROM episodes WHERE external_id = ?').get('c0') as Record<
      string,
      unknown
    >
    expect(row.source_instance).toBe('host:alice')
    expect(row.source_version).toBe('2.1.0')
    expect(row.visibility).toBe('project')
    expect(row.retention).toBe('ephemeral')
    expect(row.expires_at).toBe(6_000)
    expect(row.task_id).toBe('t-9f2')
    expect(row.content_type).toBe('application/json')
    expect(row.uri).toBe('file:///repo/src/server.ts')
    expect(row.parent_external_id).toBe('whole')
    expect(row.chunk_index).toBe(0)
    expect(row.chunk_of).toBe(2)
    expect(JSON.parse(row.provenance_json as string)).toEqual({ repo: 'engram', commit: '046fa30' })
  })

  it('leaves memories untouched', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n
    await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      items: Array.from({ length: 50 }, (_, index) =>
        item({ external_id: `bulk-${index}`, turn_index: index })
      ),
    })
    const after = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n
    expect(after).toBe(before)
    expect(countEpisodes(db, { namespace: NS })).toBe(50)
  })
})

describe('episode retrieval', () => {
  let db: import('better-sqlite3').Database

  beforeEach(async () => {
    resetDatabase()
    db = createTestDb().db
    await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      items: [
        item({ external_id: 'd0', content: 'the deploy window is 09:00-11:30 utc', turn_index: 0 }),
        item({ external_id: 'd1', content: 'a rollback drill follows the deploy', turn_index: 1 }),
        item({ external_id: 'd2', content: 'the pricing table lives in a spreadsheet', turn_index: 2 }),
      ],
    })
    await ingestEpisodes(db, {
      namespace: OTHER_NS,
      source: 'codex',
      items: [item({ external_id: 'o0', content: 'the deploy window is 13:00-14:00 utc is wrong', turn_index: 0 })],
    })
  })

  afterEach(() => {
    setEpisodeEmbedder(null)
    setEpisodeBatchEmbedder(null)
    resetDatabase()
  })

  it('ranks lexically inside the namespace only', async () => {
    const found = await searchEpisodes(db, false, 'deploy window', { namespace: NS, limit: 10 })
    expect(found.hits.length).toBeGreaterThan(0)
    expect(found.hits.map((hit) => hit.episode.external_id)).toContain('d0')
    for (const hit of found.hits) expect(hit.episode.namespace).toBe(NS)

    const elsewhere = await searchEpisodes(db, false, 'deploy window', {
      namespace: OTHER_NS,
      limit: 10,
    })
    expect(elsewhere.hits.map((hit) => hit.episode.external_id)).toEqual(['o0'])
  })

  it('takes the subtree when asked, and hides expired evidence', async () => {
    await ingestEpisodes(db, {
      namespace: `${NS}//turns`,
      source: 'codex',
      items: [item({ external_id: 'child0', content: 'the deploy window notes live here' })],
    })
    const subtree = await searchEpisodes(db, false, 'deploy window', {
      namespace_subtree: NS,
      limit: 10,
    })
    expect(subtree.hits.map((hit) => hit.episode.external_id)).toContain('child0')

    await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      retention: 'ephemeral',
      ttl_ms: 1000,
      now: 1_000,
      items: [item({ external_id: 'gone', content: 'the deploy window is expired evidence' })],
    })
    const live = await searchEpisodes(db, false, 'deploy window expired', {
      namespace: NS,
      limit: 10,
      now: 5_000,
    })
    expect(live.hits.map((hit) => hit.episode.external_id)).not.toContain('gone')
    const kept = await searchEpisodes(db, false, 'deploy window expired', {
      namespace: NS,
      limit: 10,
      now: 5_000,
      include_expired: true,
    })
    expect(kept.hits.map((hit) => hit.episode.external_id)).toContain('gone')
  })

  it('finds an episode the query never matches lexically, through the vector channel', async () => {
    if (!episodeVectorsAvailable(db)) return
    const deploy = new Float32Array(EMBEDDING_DIM)
    deploy[0] = 1
    const other = new Float32Array(EMBEDDING_DIM)
    other[1] = 1
    const embedder = async (text: string): Promise<Float32Array> =>
      text.includes('deploy') || text.includes('ship') ? deploy : other
    setEpisodeEmbedder(embedder)
    await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      vectorsAvailable: true,
      items: [
        item({ external_id: 'v-deploy', content: 'the deploy window is 09:00-11:30 utc' }),
        item({ external_id: 'v-pricing', content: 'the pricing table lives in a spreadsheet' }),
      ],
    })
    // no query term appears in any episode, so only the vector list can produce a hit
    const found = await searchEpisodes(db, true, 'when may I ship', { namespace: NS, limit: 5 })
    expect(found.hits[0].episode.external_id).toBe('v-deploy')
    expect(found.hits[0].signals.vec).toBeGreaterThan(0)
    expect(found.hits[0].distance).toBe(0)
  })

  it('embeds one call per item by default, so a stored vector is what getEmbedding returns', async () => {
    if (!episodeVectorsAvailable(db)) return
    const calls: string[] = []
    const vector = new Float32Array(EMBEDDING_DIM)
    vector[0] = 1
    setEpisodeEmbedder(async (text) => {
      calls.push(text)
      return vector
    })

    const result = await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      vectorsAvailable: true,
      items: [
        item({ external_id: 's0', content: 'user: what is the deploy window?' }),
        item({ external_id: 's1', content: 'assistant: 09:00-11:30 utc' }),
      ],
    })

    expect(result.ingested).toBe(2)
    expect(calls).toEqual([
      'user: what is the deploy window?',
      'assistant: 09:00-11:30 utc',
    ])
    const stored = db
      .prepare(
        "SELECT COUNT(*) AS n FROM episodes WHERE external_id IN ('s0','s1') AND vec_rowid IS NOT NULL AND embed_state = 'fresh'"
      )
      .get() as { n: number }
    expect(stored.n).toBe(2)
  })

  it('embeds the whole batch in one call when the caller opts in', async () => {
    if (!episodeVectorsAvailable(db)) return
    const calls: string[][] = []
    const vector = new Float32Array(EMBEDDING_DIM)
    vector[0] = 1
    setEpisodeBatchEmbedder(async (texts) => {
      calls.push(texts)
      return texts.map(() => vector)
    })

    const result = await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      vectorsAvailable: true,
      batchEmbeddings: true,
      items: [
        item({ external_id: 'b0', content: 'user: what is the deploy window?' }),
        item({ external_id: 'b1', content: 'assistant: 09:00-11:30 utc' }),
        item({ external_id: 'b2', content: 'user: thanks' }),
      ],
    })

    expect(result.ingested).toBe(3)
    expect(calls).toEqual([
      ['user: what is the deploy window?', 'assistant: 09:00-11:30 utc', 'user: thanks'],
    ])
    const rows = db
      .prepare(
        "SELECT embed_state, vec_rowid, embedding_model FROM episodes WHERE external_id IN ('b0','b1','b2') ORDER BY external_id"
      )
      .all() as Array<{ embed_state: string; vec_rowid: number | null; embedding_model: string | null }>
    expect(rows.length).toBe(3)
    for (const row of rows) {
      expect(row.embed_state).toBe('fresh')
      expect(row.vec_rowid).not.toBeNull()
      expect(row.embedding_model).toBe(MODEL_ID)
    }
  })

  it('writes lexically now and leaves the vectors to the backlog when the caller defers', async () => {
    if (!episodeVectorsAvailable(db)) return
    let calls = 0
    setEpisodeBatchEmbedder(async (texts) => {
      calls++
      return texts.map(() => new Float32Array(EMBEDDING_DIM))
    })

    const result = await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      vectorsAvailable: true,
      deferVectors: true,
      items: [
        item({ external_id: 'defer0', content: 'user: when is the deploy window?' }),
        item({ external_id: 'defer1', content: 'assistant: 09:00-11:30 utc' }),
      ],
    })

    expect(result.ingested).toBe(2)
    expect(calls).toBe(0)
    const stale = db
      .prepare(
        "SELECT COUNT(*) AS n FROM episodes WHERE external_id LIKE 'defer%' AND embed_state = 'stale' AND vec_rowid IS NULL"
      )
      .get() as { n: number }
    expect(stale.n).toBe(2)
    // the lexical channel serves them the moment ingest returns
    const found = await searchEpisodes(db, false, 'deploy window', { namespace: NS, limit: 10 })
    expect(found.hits.map((hit) => hit.episode.external_id)).toContain('defer0')

    const vector = new Float32Array(EMBEDDING_DIM)
    vector[0] = 1
    const stats = await reembedStaleEpisodes(db, MODEL_ID, {
      batchSize: 10,
      pauseMs: 0,
      batchEmbedder: async (texts) => texts.map(() => vector),
    })
    // the retrieval describe's own rows are stale too, so the worker drains more than these
    expect(stats.totalReembedded).toBeGreaterThanOrEqual(2)
    const fresh = db
      .prepare(
        "SELECT COUNT(*) AS n FROM episodes WHERE external_id LIKE 'defer%' AND embed_state = 'fresh' AND vec_rowid IS NOT NULL"
      )
      .get() as { n: number }
    expect(fresh.n).toBe(2)
  })

  it('drops the fts rows and the vectors of a namespace when the evidence goes', async () => {
    deleteEpisodes(db, { namespace_subtree: NS, exclude_namespace: NS })
    expect(countEpisodes(db, { namespace: `${NS}//turns` })).toBe(0)
    expect(countEpisodes(db, { namespace: NS })).toBe(3)
    deleteEpisodes(db, { namespace: NS })
    expect(countEpisodes(db, { namespace: NS })).toBe(0)
    const orphan = db
      .prepare('SELECT COUNT(*) AS n FROM episodes_fts WHERE content LIKE ?')
      .get('%deploy window is 09:00%') as { n: number }
    expect(orphan.n).toBe(0)
  })
})

describe('episode assembly', () => {
  const sessions = new Map<string, EpisodeSessionTurns>([
    [
      's-late',
      {
        sessionId: 's-late',
        occurredAt: 1_700_000_500_000,
        turns: [
          { episodeId: 'late-0', content: 'user: any news?', occurredAt: 1_700_000_500_000 },
          { episodeId: 'late-1', content: 'assistant: the pricing table moved', occurredAt: 1_700_000_500_000 },
        ],
      },
    ],
    [
      's-early',
      {
        sessionId: 's-early',
        occurredAt: 1_700_000_000_000,
        turns: [
          { episodeId: 'early-0', content: 'user: what is the deploy window?', occurredAt: 1_700_000_000_000 },
          { episodeId: 'early-1', content: 'assistant: 09:00-11:30 utc', occurredAt: 1_700_000_000_000 },
          { episodeId: 'early-2', content: 'user: noted', occurredAt: 1_700_000_000_000 },
        ],
      },
    ],
  ])

  it('groups hits by session, dates each group and serves them oldest first', () => {
    const assembled = assembleEpisodeContext({
      hits: [
        { episodeId: 'late-1', sessionId: 's-late' },
        { episodeId: 'early-1', sessionId: 's-early' },
      ],
      sessions,
      budgetChars: 4000,
      ingestWindow: 1,
      renderWindow: 1,
    })

    expect(assembled.sessionsServed).toBe(2)
    expect(assembled.blocks[0]).toMatch(/^\[2023-11-14 22:13 utc\]/)
    expect(assembled.blocks[0]).toContain('assistant: 09:00-11:30 utc')
    expect(assembled.blocks[1]).toMatch(/^\[2023-11-14 22:21 utc\]/)
    // the hit turn arrives with its neighbours, in session order
    expect(assembled.blocks[0].split('\n')).toEqual([
      '[2023-11-14 22:13 utc]',
      'user: what is the deploy window?',
      'assistant: 09:00-11:30 utc',
      'user: noted',
    ])
    // served lines keep the hit order (the best hit first), and each carries its
    // episode, session, turn and date
    expect(assembled.lines.map((line) => line.episode_id)).toEqual([
      'late-0',
      'late-1',
      'early-0',
      'early-1',
      'early-2',
    ])
    const answer = assembled.lines.find((line) => line.episode_id === 'early-1')!
    expect(answer).toMatchObject({
      session_id: 's-early',
      turn_index: 1,
      date: '2023-11-14 22:13 utc',
      block: 0,
      rank: 1,
    })
  })

  it('spends the budget on the best hits first and stays inside it', () => {
    const assembled = assembleEpisodeContext({
      hits: [
        { episodeId: 'late-0', sessionId: 's-late' },
        { episodeId: 'early-0', sessionId: 's-early' },
      ],
      sessions,
      budgetChars: 90,
      ingestWindow: 1,
      renderWindow: 1,
    })
    expect(assembled.usedChars).toBeLessThanOrEqual(90)
    expect(assembled.sessionsServed).toBe(1)
    expect(assembled.blocks[0]).toContain('any news')
    expect(assembled.skippedSessions).toBe(1)

    const wide = assembleEpisodeContext({
      hits: [
        { episodeId: 'late-0', sessionId: 's-late' },
        { episodeId: 'early-0', sessionId: 's-early' },
      ],
      sessions,
      budgetChars: 4000,
      ingestWindow: 1,
      renderWindow: 1,
    })
    expect(wide.sessionsServed).toBe(2)
    expect(wide.usedChars).toBeLessThanOrEqual(4000)
  })

  it('skips a hit whose episode is not in the loaded session', () => {
    const assembled = assembleEpisodeContext({
      hits: [
        { episodeId: 'missing', sessionId: 's-early' },
        { episodeId: 'gone', sessionId: 'not-loaded' },
      ],
      sessions,
      budgetChars: 4000,
      ingestWindow: 1,
      renderWindow: 1,
    })
    expect(assembled.sessionsServed).toBe(0)
    expect(assembled.turnsServed).toBe(0)
  })

  it('reads the whole timeline out of the engine, dated and in order', async () => {
    resetDatabase()
    const engineDb = createTestDb().db
    await ingestEpisodes(engineDb, {
      namespace: NS,
      source: 'eval-turns',
      items: [
        ...['user: what is the deploy window?', 'assistant: 09:00-11:30 utc', 'user: noted'].map(
          (content, index) => ({
            external_id: `e:${index}`,
            content,
            session_id: 's-early',
            turn_index: index,
            occurred_at: 1_700_000_000_000,
          })
        ),
        ...['user: any news?', 'assistant: the pricing table moved'].map((content, index) => ({
          external_id: `l:${index}`,
          content,
          session_id: 's-late',
          turn_index: index,
          occurred_at: 1_700_000_500_000,
        })),
      ],
      now: 1_700_000_600_000,
    })
    const result = await retrieveEpisodeContext({
      db: engineDb,
      query: 'deploy window',
      namespace: NS,
      budget_chars: 4000,
      now: 1_700_000_600_000,
    })
    expect(result.sessionsServed).toBe(1)
    expect(result.blocks[0].split('\n')[0]).toBe('[2023-11-14 22:13 utc]')
    // the hit is turn 0, so its own turn and the neighbour after it are served
    expect(result.lines.map((line) => line.turn_index)).toEqual([0, 1])
    expect(result.context).toContain('09:00-11:30 utc')
    expect(result.context.length).toBeLessThanOrEqual(4000)
    resetDatabase()
  })
})

describe('memory_episodes', () => {
  beforeEach(() => {
    resetDatabase()
    getDatabase(':memory:')
    resetServicesForTests()
  })

  afterEach(() => {
    resetDatabase()
    resetServicesForTests()
  })

  it('links a derived memory to its evidence and reads it back', async () => {
    const db = getDatabase().db
    const stored = JSON.parse(
      (await handleTool('store_memory', { content: 'the deploy window is 09:00-11:30 utc', project_path: NS }))
        .content[0].text
    ) as { id: string }
    const ingested = await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      items: [item({ external_id: 'e0', content: 'assistant: the deploy window is 09:00-11:30 utc' })],
    })
    const episodeId = ingested.items[0].status === 'ingested' ? ingested.items[0].id : ''

    linkMemoryEpisode(db, { memory_id: stored.id, episode_id: episodeId, span_start: 12, span_end: 38 })
    linkMemoryEpisode(db, { memory_id: stored.id, episode_id: episodeId, span_start: 12, span_end: 38 })

    const evidence = episodesForMemory(db, stored.id)
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ episode_id: episodeId, span_start: 12, span_end: 38 })

    // deleting the evidence takes the link with it
    deleteEpisodes(db, { namespace: NS })
    expect(episodesForMemory(db, stored.id)).toHaveLength(0)
  })
})

describe('ingest_episodes tool', () => {
  beforeEach(() => {
    resetDatabase()
    getDatabase(':memory:')
    resetServicesForTests()
  })

  afterEach(() => {
    resetDatabase()
    resetServicesForTests()
  })

  it('ingests through the mcp surface and reports the per-item status', async () => {
    const result = JSON.parse(
      (
        await handleTool('ingest_episodes', {
          project_path: NS,
          source: { system: 'claude-code', instance: 'host:alice', version: '2.1.281' },
          permissions: { visibility: 'project', retention: 'durable' },
          episodes: [
            {
              external_id: 'session:msg:42',
              content: 'user: what is the deploy window?',
              session_id: 'abc123',
              turn_index: 0,
              occurred_at: 1_700_000_000_000,
              provenance: { repo: 'engram', commit: '046fa30' },
              chunk: { index: 0, of: 1 },
            },
            { external_id: 'session:msg:43', content: `a key: ${SECRET}` },
          ],
        })
      ).content[0].text
    ) as {
      namespace: string
      ingested: number
      rejected: number
      items: Array<{ external_id: string; status: string; id?: string }>
    }

    expect(result.namespace).toBe(NS)
    expect(result.ingested).toBe(1)
    expect(result.rejected).toBe(1)
    expect(result.items[1]).toMatchObject({ external_id: 'session:msg:43', status: 'rejected' })

    const db = getDatabase().db
    const row = db.prepare('SELECT * FROM episodes WHERE external_id = ?').get('session:msg:42') as Record<string, unknown>
    expect(row.visibility).toBe('project')
    expect(row.chunk_index).toBe(0)
    expect(row.chunk_of).toBe(1)
    expect(JSON.parse(row.provenance_json as string)).toEqual({ repo: 'engram', commit: '046fa30' })
    expect(countEpisodes(db, { namespace: NS })).toBe(1)

    const replay = JSON.parse(
      (
        await handleTool('ingest_episodes', {
          project_path: NS,
          source: { system: 'claude-code' },
          episodes: [{ external_id: 'session:msg:42', content: 'user: what is the deploy window?' }],
        })
      ).content[0].text
    ) as { duplicates: number }
    expect(replay.duplicates).toBe(1)
  })

  it('rejects a batch the schema cannot describe', async () => {
    const result = await handleTool('ingest_episodes', {
      project_path: NS,
      source: { system: 'claude-code' },
      episodes: [{ external_id: 'x' }],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Validation failed')
  })
})
