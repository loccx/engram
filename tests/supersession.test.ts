import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { MemoryStore } from '../src/memory/store.js'
import { MemorySearch } from '../src/memory/search.js'
import { SUPERSEDES_FILTER_THRESHOLD } from '../src/contradictions/supersession.js'

function ensureSession(db: Database.Database, sid: string, ns: string): void {
  db.prepare(`INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)`).run(
    sid,
    ns,
    Date.now()
  )
}

function insertMemory(
  db: Database.Database,
  id: string,
  content: string,
  opts: { namespace?: string; type?: string; tags?: string[] } = {}
): void {
  const ns = opts.namespace ?? '/proj'
  ensureSession(db, 'sess1', ns)
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    'sess1',
    ns,
    ns,
    content,
    opts.type ?? 'note',
    0.5,
    JSON.stringify(opts.tags ?? []),
    Date.now()
  )
}

function supersede(
  db: Database.Database,
  newerId: string,
  olderId: string,
  confidence: number = 0.9
): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_links
       (source_id, target_id, similarity, link_type, created_at, confidence, reason, decider_model, prompt_version, judged_at)
     VALUES (?, ?, ?, 'supersedes', ?, ?, 'test', 'gpt-test', 'contradiction-v1', ?)`
  ).run(newerId, olderId, confidence, Date.now(), confidence, Date.now())
}

function linkSemantic(
  db: Database.Database,
  src: string,
  tgt: string,
  similarity: number = 0.85
): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_links
       (source_id, target_id, similarity, link_type, created_at)
     VALUES (?, ?, ?, 'semantic', ?)`
  ).run(src, tgt, similarity, Date.now())
}

describe('supersession filter', () => {
  let dbm: ReturnType<typeof createTestDb>
  let store: MemoryStore
  let search: MemorySearch

  beforeEach(() => {
    dbm = createTestDb()
    store = new MemoryStore(dbm.db, false, null)
    search = new MemorySearch(dbm.db, false)
  })

  describe('list_memories', () => {
    it('hides superseded by default', () => {
      const oldId = randomUUID()
      const newId = randomUUID()
      insertMemory(dbm.db, oldId, 'use postgres for production')
      insertMemory(dbm.db, newId, 'use mysql for production')
      supersede(dbm.db, newId, oldId)

      const results = store.list({ project_path: '/proj' })
      const ids = results.map((m) => m.id)
      expect(ids).toContain(newId)
      expect(ids).not.toContain(oldId)
    })

    it('shows superseded with include_superseded=true', () => {
      const oldId = randomUUID()
      const newId = randomUUID()
      insertMemory(dbm.db, oldId, 'use postgres for production')
      insertMemory(dbm.db, newId, 'use mysql for production')
      supersede(dbm.db, newId, oldId)

      const results = store.list({ project_path: '/proj', include_superseded: true })
      const ids = results.map((m) => m.id)
      expect(ids).toContain(newId)
      expect(ids).toContain(oldId)
    })

    it('keeps memories with sub-threshold supersedes link', () => {
      const oldId = randomUUID()
      const newId = randomUUID()
      insertMemory(dbm.db, oldId, 'use postgres')
      insertMemory(dbm.db, newId, 'use mysql')
      supersede(dbm.db, newId, oldId, SUPERSEDES_FILTER_THRESHOLD - 0.01)

      const results = store.list({ project_path: '/proj' })
      const ids = results.map((m) => m.id)
      expect(ids).toContain(oldId)
      expect(ids).toContain(newId)
    })

    it('does not filter on non-supersedes links', () => {
      const aId = randomUUID()
      const bId = randomUUID()
      insertMemory(dbm.db, aId, 'foo content')
      insertMemory(dbm.db, bId, 'bar content')
      linkSemantic(dbm.db, bId, aId, 0.99)

      const results = store.list({ project_path: '/proj' })
      const ids = results.map((m) => m.id)
      expect(ids).toContain(aId)
      expect(ids).toContain(bId)
    })
  })

  describe('hybridSearch', () => {
    it('hides superseded from FTS results by default', async () => {
      const oldId = randomUUID()
      const newId = randomUUID()
      insertMemory(dbm.db, oldId, 'kafka throughput tuning notes')
      insertMemory(dbm.db, newId, 'kafka throughput rewrite using newer client')
      supersede(dbm.db, newId, oldId)

      const results = await search.hybridSearch('kafka throughput', { project_path: '/proj' })
      const ids = results.map((r) => r.id)
      expect(ids).toContain(newId)
      expect(ids).not.toContain(oldId)
    })

    it('shows superseded in FTS results with include_superseded=true', async () => {
      const oldId = randomUUID()
      const newId = randomUUID()
      insertMemory(dbm.db, oldId, 'kafka throughput tuning notes')
      insertMemory(dbm.db, newId, 'kafka throughput rewrite using newer client')
      supersede(dbm.db, newId, oldId)

      const results = await search.hybridSearch('kafka throughput', {
        project_path: '/proj',
        include_superseded: true,
      })
      const ids = results.map((r) => r.id)
      expect(ids).toContain(newId)
      expect(ids).toContain(oldId)
    })
  })

  describe('getContext', () => {
    it('hides superseded by default', () => {
      const oldId = randomUUID()
      const newId = randomUUID()
      insertMemory(dbm.db, oldId, 'old config')
      insertMemory(dbm.db, newId, 'new config')
      supersede(dbm.db, newId, oldId)

      const memories = search.getContext('/proj', 10)
      const ids = memories.map((m) => m.id)
      expect(ids).toContain(newId)
      expect(ids).not.toContain(oldId)
    })

    it('shows superseded with include_superseded=true', () => {
      const oldId = randomUUID()
      const newId = randomUUID()
      insertMemory(dbm.db, oldId, 'old config')
      insertMemory(dbm.db, newId, 'new config')
      supersede(dbm.db, newId, oldId)

      const memories = search.getContext('/proj', 10, { include_superseded: true })
      const ids = memories.map((m) => m.id)
      expect(ids).toContain(oldId)
      expect(ids).toContain(newId)
    })
  })

  describe('getLinked', () => {
    it('hides superseded link targets by default', () => {
      const srcId = randomUUID()
      const liveId = randomUUID()
      const deadId = randomUUID()
      insertMemory(dbm.db, srcId, 'source')
      insertMemory(dbm.db, liveId, 'live target')
      insertMemory(dbm.db, deadId, 'dead target')
      linkSemantic(dbm.db, srcId, liveId)
      linkSemantic(dbm.db, srcId, deadId)
      supersede(dbm.db, liveId, deadId)

      const linked = store.getLinked(srcId, 10)
      const ids = linked.map((l) => l.id)
      expect(ids).toContain(liveId)
      expect(ids).not.toContain(deadId)
    })

    it('shows superseded link targets with include_superseded=true', () => {
      const srcId = randomUUID()
      const liveId = randomUUID()
      const deadId = randomUUID()
      insertMemory(dbm.db, srcId, 'source')
      insertMemory(dbm.db, liveId, 'live target')
      insertMemory(dbm.db, deadId, 'dead target')
      linkSemantic(dbm.db, srcId, liveId)
      linkSemantic(dbm.db, srcId, deadId)
      supersede(dbm.db, liveId, deadId)

      const linked = store.getLinked(srcId, 10, { include_superseded: true })
      const ids = linked.map((l) => l.id)
      expect(ids).toContain(liveId)
      expect(ids).toContain(deadId)
    })
  })

  describe('traverseGraph', () => {
    it('hides superseded nodes from multi-hop traversal by default', () => {
      const a = randomUUID()
      const b = randomUUID()
      const c = randomUUID()
      const d = randomUUID()
      insertMemory(dbm.db, a, 'a')
      insertMemory(dbm.db, b, 'b')
      insertMemory(dbm.db, c, 'c')
      insertMemory(dbm.db, d, 'd')
      linkSemantic(dbm.db, a, b)
      linkSemantic(dbm.db, b, c)
      linkSemantic(dbm.db, c, d)
      supersede(dbm.db, a, c)

      const result = search.traverseGraph(a, 3, 20)
      const ids = result.map((r) => r.id)
      expect(ids).toContain(b)
      expect(ids).toContain(d)
      expect(ids).not.toContain(c)
    })

    it('shows superseded nodes with include_superseded=true', () => {
      const a = randomUUID()
      const b = randomUUID()
      const c = randomUUID()
      insertMemory(dbm.db, a, 'a')
      insertMemory(dbm.db, b, 'b')
      insertMemory(dbm.db, c, 'c')
      linkSemantic(dbm.db, a, b)
      linkSemantic(dbm.db, b, c)
      supersede(dbm.db, a, c)

      const result = search.traverseGraph(a, 3, 20, { include_superseded: true })
      const ids = result.map((r) => r.id)
      expect(ids).toContain(b)
      expect(ids).toContain(c)
    })
  })

  describe('getById direct fetch', () => {
    it('always returns superseded memory (operator-explicit lookup)', () => {
      const oldId = randomUUID()
      const newId = randomUUID()
      insertMemory(dbm.db, oldId, 'old')
      insertMemory(dbm.db, newId, 'new')
      supersede(dbm.db, newId, oldId)

      const memory = store.getById(oldId)
      expect(memory).not.toBeNull()
      expect(memory!.id).toBe(oldId)
    })
  })

  describe('threshold boundary', () => {
    it('exactly at threshold filters out (>= semantics)', () => {
      const oldId = randomUUID()
      const newId = randomUUID()
      insertMemory(dbm.db, oldId, 'old')
      insertMemory(dbm.db, newId, 'new')
      supersede(dbm.db, newId, oldId, SUPERSEDES_FILTER_THRESHOLD)

      const results = store.list({ project_path: '/proj' })
      const ids = results.map((m) => m.id)
      expect(ids).not.toContain(oldId)
    })
  })
})
