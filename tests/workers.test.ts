import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { backfillNamespaces } from '../src/db/workers/backfill.js'
import { reembedStaleMemories } from '../src/db/workers/reembed.js'
import { createTestDb } from './helpers.js'

const SESSION_ID = 'worker-session'

function seedSession(db: Database.Database, project = '/p'): void {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(SESSION_ID, project, Date.now())
}

function insertMemory(db: Database.Database, id: string, project: string, namespace: string | null = null): void {
  db.prepare(`
    INSERT INTO memories (id, session_id, project_path, namespace, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, SESSION_ID, project, namespace, `content for ${id}`, Date.now())
}

describe('backfillNamespaces', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb().db
  })

  it('updates rows where namespace IS NULL using project_path', async () => {
    seedSession(db, '/proj/a')
    insertMemory(db, 'm1', '/proj/a', null)
    insertMemory(db, 'm2', '/proj/a', null)
    insertMemory(db, 'm3', '/proj/a', '/already/set')

    const stats = await backfillNamespaces(db, { batchSize: 10, pauseMs: 0 })

    expect(stats.totalUpdated).toBe(2)
    const rows = db.prepare('SELECT id, namespace FROM memories ORDER BY id').all() as Array<{ id: string; namespace: string }>
    expect(rows).toEqual([
      { id: 'm1', namespace: '/proj/a' },
      { id: 'm2', namespace: '/proj/a' },
      { id: 'm3', namespace: '/already/set' },
    ])
  })

  it('processes in multiple batches when needed', async () => {
    seedSession(db, '/proj')
    for (let i = 0; i < 5; i++) insertMemory(db, `m${i}`, '/proj', null)

    const stats = await backfillNamespaces(db, { batchSize: 2, pauseMs: 0 })

    expect(stats.totalUpdated).toBe(5)
    expect(stats.batches).toBe(3)
  })

  it('is a no-op when nothing needs backfilling', async () => {
    seedSession(db, '/p')
    insertMemory(db, 'm1', '/p', '/p')

    const stats = await backfillNamespaces(db, { batchSize: 10, pauseMs: 0 })

    expect(stats.totalUpdated).toBe(0)
    expect(stats.batches).toBe(0)
  })

  it('is idempotent — running twice produces same result', async () => {
    seedSession(db, '/p')
    insertMemory(db, 'm1', '/p', null)

    const first = await backfillNamespaces(db, { batchSize: 10, pauseMs: 0 })
    const second = await backfillNamespaces(db, { batchSize: 10, pauseMs: 0 })

    expect(first.totalUpdated).toBe(1)
    expect(second.totalUpdated).toBe(0)
  })
})

describe('reembedStaleMemories', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb().db
  })

  function markStale(id: string): void {
    db.prepare("UPDATE memories SET embed_state = 'stale' WHERE id = ?").run(id)
  }

  it('re-embeds stale memories using injected embedder', async () => {
    if (!createTestDb().vectorsAvailable) return
    seedSession(db)
    insertMemory(db, 's1', '/p')
    insertMemory(db, 's2', '/p')
    markStale('s1')
    markStale('s2')

    const fakeEmbedder = async (): Promise<Float32Array> => {
      const v = new Float32Array(768)
      for (let i = 0; i < 768; i++) v[i] = Math.random()
      return v
    }

    const stats = await reembedStaleMemories(db, 'test-model', {
      batchSize: 10,
      pauseMs: 0,
      embedder: fakeEmbedder,
    })

    expect(stats.totalReembedded).toBe(2)
    expect(stats.failed).toBe(0)

    const rows = db
      .prepare("SELECT id, embed_state, embedding_model, embedding_dim, vec_rowid FROM memories WHERE embed_state = 'fresh'")
      .all() as Array<{ id: string; embed_state: string; embedding_model: string; embedding_dim: number; vec_rowid: number }>
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.embedding_model === 'test-model' && r.embedding_dim === 768 && r.vec_rowid !== null)).toBe(true)
  })

  it('marks rows as error when embedder returns null', async () => {
    if (!createTestDb().vectorsAvailable) return
    seedSession(db)
    insertMemory(db, 'fail1', '/p')
    markStale('fail1')

    const stats = await reembedStaleMemories(db, 'test-model', {
      batchSize: 10,
      pauseMs: 0,
      embedder: async () => null,
    })

    expect(stats.totalReembedded).toBe(0)
    expect(stats.failed).toBe(1)
    const row = db.prepare('SELECT embed_state FROM memories WHERE id = ?').get('fail1') as { embed_state: string }
    expect(row.embed_state).toBe('error')
  })

  it('claim is atomic — never picks up the same row twice', async () => {
    if (!createTestDb().vectorsAvailable) return
    seedSession(db)
    insertMemory(db, 'm1', '/p')
    markStale('m1')

    let calls = 0
    const embedder = async (): Promise<Float32Array> => {
      calls++
      const v = new Float32Array(768)
      v[0] = 1
      return v
    }

    await reembedStaleMemories(db, 'm', { batchSize: 10, pauseMs: 0, embedder })
    await reembedStaleMemories(db, 'm', { batchSize: 10, pauseMs: 0, embedder })

    expect(calls).toBe(1)
  })

  it('is a no-op when no stale memories exist', async () => {
    seedSession(db)
    insertMemory(db, 'm1', '/p')

    const stats = await reembedStaleMemories(db, 'm', {
      batchSize: 10,
      pauseMs: 0,
      embedder: async () => new Float32Array(768),
    })

    expect(stats.totalReembedded).toBe(0)
    expect(stats.failed).toBe(0)
    expect(stats.batches).toBe(0)
  })
})
