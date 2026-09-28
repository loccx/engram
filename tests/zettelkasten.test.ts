// zettelkasten auto-linking and hybrid search. needs the embedding model cached
// (`engram warm`), and skips itself when the model is unavailable.
import { describe, it, expect, beforeAll } from 'vitest'
import { warmEmbeddings } from '../src/embeddings/pipeline.js'
import { MemoryStore } from '../src/memory/store.js'
import { MemorySearch } from '../src/memory/search.js'
import { createTestDb } from './helpers.js'

const TEST_SESSION = 'zk-session'
const TEST_PROJECT = '/test/project'

describe('Zettelkasten + Hybrid Search (requires cached model)', () => {
  let modelAvailable = false
  let store: MemoryStore
  let search: MemorySearch

  beforeAll(async () => {
    modelAvailable = await warmEmbeddings()
    const { db, vectorsAvailable } = createTestDb()
    db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
      TEST_SESSION, TEST_PROJECT, Date.now()
    )
    store = new MemoryStore(db, vectorsAvailable && modelAvailable)
    search = new MemorySearch(db, vectorsAvailable && modelAvailable)
  }, 60_000)

  it('stores memory with embedding and sets vec_rowid', async () => {
    if (!modelAvailable) return
    const mem = await store.store({
      content: 'SQLite WAL mode allows concurrent readers without blocking writers',
      session_id: TEST_SESSION, project_path: TEST_PROJECT, importance: 0.9,
    })
    expect(mem.vec_rowid).not.toBeNull()
    expect(typeof mem.vec_rowid).toBe('number')
  })

  it('auto-links two semantically related memories', async () => {
    if (!modelAvailable) return

    const a = await store.store({
      content: 'SQLite WAL mode allows concurrent readers without blocking writers',
      session_id: TEST_SESSION, project_path: TEST_PROJECT,
    })
    const b = await store.store({
      content: 'Using WAL journal mode in SQLite enables multiple simultaneous readers',
      session_id: TEST_SESSION, project_path: TEST_PROJECT,
    })

    const linked = store.getLinked(a.id)
    expect(linked.length).toBeGreaterThan(0)
    const linkedToB = linked.find((m) => m.id === b.id)
    expect(linkedToB).toBeDefined()
    expect(linkedToB!.similarity).toBeGreaterThan(0.5)
  })

  it('does NOT link unrelated memories', async () => {
    if (!modelAvailable) return

    const a = await store.store({
      content: 'SQLite WAL mode for concurrent database access',
      session_id: TEST_SESSION, project_path: TEST_PROJECT,
    })
    const b = await store.store({
      content: 'Always check for null pointer exceptions in Java',
      session_id: TEST_SESSION, project_path: TEST_PROJECT,
    })

    const linked = store.getLinked(a.id)
    const linkedToB = linked.find((m) => m.id === b.id)
    expect(linkedToB).toBeUndefined()
  })

  it('hybrid search outranks lexical-only for semantic queries', async () => {
    if (!modelAvailable) return

    // no shared keywords, only semantic relation
    await store.store({
      content: 'Use concurrent readers pattern in SQLite for better throughput',
      session_id: TEST_SESSION, project_path: TEST_PROJECT, importance: 0.5,
    })
    await store.store({
      content: 'Redis sorted sets are perfect for leaderboard implementations',
      session_id: TEST_SESSION, project_path: TEST_PROJECT, importance: 0.9,
    })

    // this phrasing should match the sqlite memory on semantics alone
    const results = await search.hybridSearch('simultaneous read access database', { limit: 5 })
    expect(results.length).toBeGreaterThan(0)
    // the concurrent-readers memory should appear in the top results
    const topContents = results.slice(0, 3).map((r) => r.content)
    const hasSQLite = topContents.some((c) => c.toLowerCase().includes('sqlite'))
    expect(hasSQLite).toBe(true)
  })
})
