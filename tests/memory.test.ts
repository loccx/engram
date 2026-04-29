import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { MemoryStore } from '../src/memory/store.js'
import { createTestDb } from './helpers.js'

const TEST_SESSION_ID = 'test-session-001'
const TEST_PROJECT = '/home/user/my-project'

function seedSession(db: Database.Database): void {
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    TEST_SESSION_ID,
    TEST_PROJECT,
    Date.now()
  )
}

describe('MemoryStore', () => {
  let db: Database.Database
  let store: MemoryStore

  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    seedSession(db)
    store = new MemoryStore(db, false) // no vectors in unit tests (no model download)
  })

  it('stores a memory and returns it', async () => {
    const memory = await store.store({
      content: 'Always use WAL mode for SQLite',
      session_id: TEST_SESSION_ID,
      project_path: TEST_PROJECT,
      type: 'pattern',
      importance: 0.9,
      tags: ['sqlite', 'performance'],
    })

    expect(memory.id).toBeTruthy()
    expect(memory.content).toBe('Always use WAL mode for SQLite')
    expect(memory.type).toBe('pattern')
    expect(memory.importance).toBe(0.9)
    expect(memory.tags).toEqual(['sqlite', 'performance'])
    expect(memory.access_count).toBe(0)
    expect(memory.created_at).toBeGreaterThan(0)
    expect(memory.vec_rowid).toBeNull() // no embeddings in test mode
  })

  it('retrieves a memory by id', async () => {
    const stored = await store.store({
      content: 'Test memory',
      session_id: TEST_SESSION_ID,
      project_path: TEST_PROJECT,
    })

    const retrieved = store.getById(stored.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe(stored.id)
    expect(retrieved!.content).toBe('Test memory')
  })

  it('returns null for unknown id', () => {
    expect(store.getById('non-existent-id')).toBeNull()
  })

  it('deletes a memory', async () => {
    const stored = await store.store({
      content: 'To be deleted',
      session_id: TEST_SESSION_ID,
      project_path: TEST_PROJECT,
    })

    expect(store.delete(stored.id)).toBe(true)
    expect(store.getById(stored.id)).toBeNull()
  })

  it('returns false when deleting non-existent memory', () => {
    expect(store.delete('ghost-id')).toBe(false)
  })

  it('increments access_count on recordAccess', async () => {
    const stored = await store.store({
      content: 'Frequently accessed',
      session_id: TEST_SESSION_ID,
      project_path: TEST_PROJECT,
    })

    store.recordAccess(stored.id)
    store.recordAccess(stored.id)

    const updated = store.getById(stored.id)
    expect(updated!.access_count).toBe(2)
    expect(updated!.last_accessed).toBeGreaterThan(0)
  })

  it('lists memories with no filters', async () => {
    await store.store({ content: 'Memory 1', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT })
    await store.store({ content: 'Memory 2', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT })

    expect(store.list().length).toBe(2)
  })

  it('lists memories filtered by type', async () => {
    await store.store({ content: 'Note', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT, type: 'note' })
    await store.store({ content: 'Bug 1', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT, type: 'bug' })
    await store.store({ content: 'Bug 2', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT, type: 'bug' })

    const bugs = store.list({ type: 'bug' })
    expect(bugs.length).toBe(2)
    expect(bugs.every((m) => m.type === 'bug')).toBe(true)
  })

  it('lists memories filtered by tags', async () => {
    await store.store({ content: 'SQLite note', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT, tags: ['sqlite'] })
    await store.store({ content: 'Redis note', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT, tags: ['redis'] })
    await store.store({ content: 'Mixed', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT, tags: ['sqlite', 'cache'] })

    expect(store.list({ tags: ['sqlite'] }).length).toBe(2)
  })

  it('lists memories filtered by project_path', async () => {
    const other = '/other/project'
    db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run('other-session', other, Date.now())

    await store.store({ content: 'My memory', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT })
    await store.store({ content: 'Other memory', session_id: 'other-session', project_path: other })

    const mine = store.list({ project_path: TEST_PROJECT })
    expect(mine.length).toBe(1)
    expect(mine[0].content).toBe('My memory')
  })

  it('respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await store.store({ content: `Memory ${i}`, session_id: TEST_SESSION_ID, project_path: TEST_PROJECT })
    }
    expect(store.list({ limit: 3 }).length).toBe(3)
  })

  it('getLinked returns empty array when no links exist', async () => {
    const mem = await store.store({ content: 'Isolated', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT })
    expect(store.getLinked(mem.id)).toEqual([])
  })
})
