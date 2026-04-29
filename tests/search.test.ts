import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { MemoryStore } from '../src/memory/store.js'
import { MemorySearch, classifyQuery } from '../src/memory/search.js'
import { createTestDb } from './helpers.js'

const TEST_SESSION_ID = 'search-session-001'
const TEST_PROJECT = '/home/user/my-project'
const OTHER_PROJECT = '/home/user/other-project'

function seedSession(db: Database.Database): void {
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(TEST_SESSION_ID, TEST_PROJECT, Date.now())
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run('other-session', OTHER_PROJECT, Date.now())
}

describe('MemorySearch (FTS5 mode — no model download in tests)', () => {
  let db: Database.Database
  let store: MemoryStore
  let search: MemorySearch

  beforeEach(async () => {
    const testDb = createTestDb()
    db = testDb.db
    seedSession(db)
    // Always test in FTS5-only mode (no embedding model download during tests)
    store = new MemoryStore(db, false)
    search = new MemorySearch(db, false)

    await store.store({ content: 'SQLite WAL mode enables concurrent reads', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT, type: 'pattern', importance: 0.9, tags: ['sqlite', 'performance'] })
    await store.store({ content: 'Use indexes on frequently queried columns', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT, type: 'pattern', importance: 0.7, tags: ['database', 'performance'] })
    await store.store({ content: 'Redis is great for caching session data', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT, type: 'note', importance: 0.5, tags: ['redis', 'cache'] })
    await store.store({ content: 'FTS5 full-text search in SQLite is very fast', session_id: 'other-session', project_path: OTHER_PROJECT, type: 'note', importance: 0.8, tags: ['sqlite', 'search'] })
  })

  it('finds memories matching a query via FTS5', async () => {
    const results = await search.hybridSearch('SQLite')
    expect(results.length).toBeGreaterThan(0)
  })

  it('returns scored results', async () => {
    const results = await search.hybridSearch('SQLite')
    expect(results.every((r) => typeof r.score === 'number')).toBe(true)
    expect(results.every((r) => r.score >= 0)).toBe(true)
  })

  it('returns results sorted by score descending', async () => {
    const results = await search.hybridSearch('SQLite')
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
  })

  it('higher importance memories score better when relevance is equal', async () => {
    // Both memories match 'performance' but have different importance
    const results = await search.hybridSearch('performance')
    expect(results.length).toBeGreaterThanOrEqual(2)
    // 0.9 importance should beat 0.7 importance
    expect(results[0].importance).toBeGreaterThanOrEqual(results[1].importance)
  })

  it('filters by project_path', async () => {
    const results = await search.hybridSearch('SQLite', { project_path: TEST_PROJECT })
    expect(results.every((r) => r.project_path === TEST_PROJECT)).toBe(true)
  })

  it('filters by type', async () => {
    const results = await search.hybridSearch('performance', { type: 'pattern' })
    expect(results.every((r) => r.type === 'pattern')).toBe(true)
  })

  it('respects limit', async () => {
    const results = await search.hybridSearch('SQLite', { limit: 1 })
    expect(results.length).toBeLessThanOrEqual(1)
  })

  it('returns empty array for no matches', async () => {
    const results = await search.hybridSearch('xyzzy nonexistent zork')
    expect(results).toEqual([])
  })

  describe('getContext', () => {
    it('returns memories for the project', () => {
      const ctx = search.getContext(TEST_PROJECT)
      expect(ctx.length).toBeGreaterThan(0)
      expect(ctx.every((m) => m.project_path === TEST_PROJECT)).toBe(true)
    })

    it('returns higher importance memories first', () => {
      const ctx = search.getContext(TEST_PROJECT)
      const importances = ctx.map((m) => m.importance)
      expect(importances[0]).toBeGreaterThanOrEqual(importances[importances.length - 1])
    })

    it('respects limit', () => {
      expect(search.getContext(TEST_PROJECT, 1).length).toBeLessThanOrEqual(1)
    })

    it('returns empty for unknown project', () => {
      expect(search.getContext('/no/such/project')).toEqual([])
    })
  })

  describe('findDuplicates', () => {
    it('returns empty when vectors are unavailable', () => {
      expect(search.findDuplicates()).toEqual([])
    })
  })

  describe('traverseGraph', () => {
    it('returns empty for a memory with no links', async () => {
      const mem = await store.store({ content: 'Isolated node', session_id: TEST_SESSION_ID, project_path: TEST_PROJECT })
      expect(search.traverseGraph(mem.id)).toEqual([])
    })
  })
})

describe('classifyQuery', () => {
  it('classifies temporal queries', () => {
    expect(classifyQuery('what did I do yesterday')).toBe('temporal')
    expect(classifyQuery('recent errors in the build')).toBe('temporal')
    expect(classifyQuery('changes from last session')).toBe('temporal')
    expect(classifyQuery('bugs found today')).toBe('temporal')
    expect(classifyQuery('what happened earlier')).toBe('temporal')
  })

  it('classifies lookup queries', () => {
    expect(classifyQuery('SQLITE_BUSY error')).toBe('lookup')
    expect(classifyQuery('handleUserAuth function')).toBe('lookup')
    expect(classifyQuery('the user_data table')).toBe('lookup')
    expect(classifyQuery('check `process.env.NODE_ENV`')).toBe('lookup')
  })

  it('classifies frequentist queries', () => {
    expect(classifyQuery('common error handling patterns')).toBe('frequentist')
    expect(classifyQuery('best practice for testing')).toBe('frequentist')
    expect(classifyQuery('what do we usually do for auth')).toBe('frequentist')
  })

  it('defaults to semantic for general queries', () => {
    expect(classifyQuery('how does authentication work')).toBe('semantic')
    expect(classifyQuery('explain the search pipeline')).toBe('semantic')
    expect(classifyQuery('database design considerations')).toBe('semantic')
  })

  it('temporal takes priority over other patterns', () => {
    expect(classifyQuery('recent handleAuth changes')).toBe('temporal')
    expect(classifyQuery('common patterns from last week')).toBe('temporal')
  })
})
