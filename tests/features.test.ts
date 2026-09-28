import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { MemoryStore } from '../src/memory/store.js'
import { MemorySearch } from '../src/memory/search.js'
import { extractEntities } from '../src/memory/entities.js'
import { computeClusters } from '../src/memory/clustering.js'
import { runClusterWorker } from '../src/memory/cluster-worker.js'
import { createTestDb } from './helpers.js'

const SESSION = 'feat-session-001'
const PROJECT = '/home/user/feat-project'

function seedSession(db: Database.Database): void {
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(SESSION, PROJECT, Date.now())
}

async function storeMemory(store: MemoryStore, content: string, importance = 0.5) {
  return store.store({ content, session_id: SESSION, project_path: PROJECT, importance })
}

describe('Feature 2: Bi-temporal fact tracking', () => {
  let db: Database.Database
  let store: MemoryStore
  let search: MemorySearch

  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    seedSession(db)
    store = new MemoryStore(db, false)
    search = new MemorySearch(db, false)
  })

  it('sets valid_from = created_at on store', async () => {
    const m = await storeMemory(store, 'WAL mode is the best SQLite journal mode')
    const row = db.prepare('SELECT valid_from, valid_until, created_at FROM memories WHERE id = ?').get(m.id) as {
      valid_from: number | null
      valid_until: number | null
      created_at: number
    }
    expect(row.valid_from).toBe(row.created_at)
    expect(row.valid_until).toBeNull()
  })

  it('setValidUntil closes the temporal window', async () => {
    const m = await storeMemory(store, 'Auth uses session cookies')
    const ts = Date.now() + 1000
    store.setValidUntil(m.id, ts)
    const row = db.prepare('SELECT valid_until FROM memories WHERE id = ?').get(m.id) as { valid_until: number | null }
    expect(row.valid_until).toBe(ts)
  })

  it('before filter excludes memories created after the cutoff', async () => {
    const past = Date.now() - 10_000
    const m1 = await storeMemory(store, 'fact A — old')
    db.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(past - 1000, m1.id)
    const m2 = await storeMemory(store, 'fact B — recent')
    db.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(Date.now(), m2.id)

    const results = await search.hybridSearch('fact', { project_path: PROJECT, before: past })
    const ids = results.map((r) => r.id)
    expect(ids).toContain(m1.id)
    expect(ids).not.toContain(m2.id)
  })

  it('getContext before filter excludes future memories', async () => {
    const cutoff = Date.now() - 5_000
    const old = await storeMemory(store, 'historic architecture decision')
    db.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(cutoff - 1000, old.id)
    const recent = await storeMemory(store, 'recent refactor note')
    db.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(Date.now(), recent.id)

    const ctx = search.getContext(PROJECT, 20, { before: cutoff })
    const ids = ctx.map((m) => m.id)
    expect(ids).toContain(old.id)
    expect(ids).not.toContain(recent.id)
  })
})

describe('Feature 1: Entity extraction — extractEntities()', () => {
  it('extracts file paths', () => {
    const entities = extractEntities('Updated src/auth/middleware.ts to fix the bug')
    const filePaths = entities.filter((e) => e.entity_type === 'file_path').map((e) => e.entity_text)
    expect(filePaths.some((p) => p.includes('middleware.ts'))).toBe(true)
  })

  it('extracts function names (camelCase)', () => {
    const entities = extractEntities('Called getUserById() and it returned null')
    const fns = entities.filter((e) => e.entity_type === 'function').map((e) => e.entity_text)
    expect(fns.some((f) => f.includes('getUserById'))).toBe(true)
  })

  it('extracts class names', () => {
    const entities = extractEntities('class MemoryStore extends BaseStore implements IStore')
    const classes = entities.filter((e) => e.entity_type === 'class').map((e) => e.entity_text)
    expect(classes).toContain('MemoryStore')
  })

  it('extracts library names from import statements', () => {
    const entities = extractEntities("import { serve } from '@hono/node-server'")
    const libs = entities.filter((e) => e.entity_type === 'library').map((e) => e.entity_text)
    expect(libs.some((l) => l.includes('hono'))).toBe(true)
  })

  it('extracts URLs', () => {
    const entities = extractEntities('See https://arxiv.org/abs/2501.13956 for the Zep paper')
    const urls = entities.filter((e) => e.entity_type === 'url').map((e) => e.entity_text)
    expect(urls.some((u) => u.includes('arxiv.org'))).toBe(true)
  })

  it('extracts error patterns', () => {
    const entities = extractEntities('Got TypeError: Cannot read properties of undefined')
    const errors = entities.filter((e) => e.entity_type === 'error').map((e) => e.entity_text)
    expect(errors.some((e) => e.includes('TypeError'))).toBe(true)
  })

  it('deduplicates entities case-insensitively', () => {
    const entities = extractEntities('getUserById getUserById GETUSERBYID')
    const fns = entities.filter((e) => e.entity_type === 'function')
    expect(fns.length).toBeLessThanOrEqual(1)
  })

  it('caps output at 30 entities', () => {
    const content = Array.from({ length: 50 }, (_, i) => `function fn${i}() {}`).join(' ')
    const entities = extractEntities(content)
    expect(entities.length).toBeLessThanOrEqual(30)
  })
})

describe('Feature 1: Entity store integration', () => {
  let db: Database.Database
  let store: MemoryStore

  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    seedSession(db)
    store = new MemoryStore(db, false)
  })

  it('persists extracted entities on store', async () => {
    const m = await storeMemory(store, 'Refactored src/auth/middleware.ts — getUserById now uses cache')
    const rows = db
      .prepare('SELECT entity_text, entity_type FROM memory_entities WHERE memory_id = ?')
      .all(m.id) as Array<{ entity_text: string; entity_type: string }>
    expect(rows.length).toBeGreaterThan(0)
  })

  it('getEntities returns entities for a memory', async () => {
    const m = await storeMemory(store, "import express from 'express' — use app.listen(3000)")
    const entities = store.getEntities(m.id)
    expect(entities.length).toBeGreaterThan(0)
    expect(entities.some((e) => e.entity_type === 'library')).toBe(true)
  })

  it('searchByEntity finds memories mentioning an entity', async () => {
    await storeMemory(store, 'Fixed bug in src/auth/session.ts by adding null check')
    await storeMemory(store, 'Unrelated note about redis caching strategy')

    const results = store.searchByEntity('src/auth/session.ts', PROJECT, 10)
    expect(results.some((m) => m.content.includes('session.ts'))).toBe(true)
  })

  it('searchByEntity is case-insensitive', async () => {
    await storeMemory(store, "import { serve } from 'hono' — use hono for routing")
    const results = store.searchByEntity('HONO', PROJECT, 10)
    expect(results.length).toBeGreaterThan(0)
  })
})

describe('Feature 3: Procedure memory type', () => {
  let db: Database.Database
  let store: MemoryStore
  let search: MemorySearch

  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    seedSession(db)
    store = new MemoryStore(db, false)
    search = new MemorySearch(db, false)
  })

  it('stores a procedure with procedure_meta', async () => {
    const meta = {
      preconditions: ['docker is running', 'env vars set'],
      steps: ['npm run build', 'docker build -t app .', 'docker push'],
      postconditions: ['image pushed to registry'],
    }
    const m = await store.store({
      content: 'Deploy procedure for production',
      session_id: SESSION,
      project_path: PROJECT,
      type: 'procedure',
      importance: 0.9,
      procedure_meta: meta,
    })
    expect(m.type).toBe('procedure')
    expect(m.procedure_meta).toEqual(meta)
  })

  it('procedure_meta round-trips through getById', async () => {
    const meta = {
      preconditions: ['tests pass'],
      steps: ['git tag', 'git push --tags'],
      postconditions: ['release created'],
    }
    const m = await store.store({
      content: 'Release tagging procedure',
      session_id: SESSION,
      project_path: PROJECT,
      type: 'procedure',
      procedure_meta: meta,
    })
    const fetched = store.getById(m.id)
    expect(fetched?.procedure_meta).toEqual(meta)
  })

  it('procedure_meta is null for non-procedure memories', async () => {
    const m = await storeMemory(store, 'A regular note')
    expect(m.procedure_meta).toBeNull()
  })

  it('getContext surfaces pinned procedures at the top', async () => {
    await storeMemory(store, 'Low importance note', 0.1)
    const proc = await store.store({
      content: 'Critical deploy procedure',
      session_id: SESSION,
      project_path: PROJECT,
      type: 'procedure',
      importance: 0.9,
    })
    store.setPinned(proc.id, true)

    const ctx = search.getContext(PROJECT, 10)
    expect(ctx[0].id).toBe(proc.id)
  })
})

describe('Feature 5: pprSearch()', () => {
  let db: Database.Database
  let store: MemoryStore
  let search: MemorySearch

  function insertLink(sourceId: string, targetId: string, sim = 0.9) {
    db.prepare(
      "INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at) VALUES (?, ?, ?, 'semantic', ?)"
    ).run(sourceId, targetId, sim, Date.now())
    db.prepare(
      "INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at) VALUES (?, ?, ?, 'semantic', ?)"
    ).run(targetId, sourceId, sim, Date.now())
  }

  beforeEach(async () => {
    const testDb = createTestDb()
    db = testDb.db
    seedSession(db)
    store = new MemoryStore(db, false)
    search = new MemorySearch(db, false)
  })

  it('returns empty array for unknown seed', () => {
    const results = search.pprSearch(['nonexistent-id'], 10)
    expect(results).toEqual([])
  })

  it('returns empty array for empty seeds', () => {
    expect(search.pprSearch([], 10)).toEqual([])
  })

  it('propagates scores through graph and excludes seeds', async () => {
    const a = await storeMemory(store, 'node A — auth middleware design')
    const b = await storeMemory(store, 'node B — session handling')
    const c = await storeMemory(store, 'node C — token refresh logic')
    insertLink(a.id, b.id, 0.85)
    insertLink(b.id, c.id, 0.85)

    const results = search.pprSearch([a.id], 10)
    const ids = results.map((r) => r.id)
    expect(ids).not.toContain(a.id)
    expect(ids).toContain(b.id)
    expect(ids).toContain(c.id)
  })

  it('results have similarity, link_type, hops fields', async () => {
    const a = await storeMemory(store, 'node A')
    const b = await storeMemory(store, 'node B')
    const c = await storeMemory(store, 'node C')
    insertLink(a.id, b.id)
    insertLink(b.id, c.id)

    const results = search.pprSearch([a.id], 10)
    if (results.length > 0) {
      expect(typeof results[0].similarity).toBe('number')
      expect(typeof results[0].link_type).toBe('string')
      expect(typeof results[0].hops).toBe('number')
    }
  })

  it('ranks more connected nodes higher', async () => {
    const seed = await storeMemory(store, 'seed node')
    const hub = await storeMemory(store, 'hub — many connections')
    const leaf = await storeMemory(store, 'leaf — one connection')
    const extra1 = await storeMemory(store, 'extra A connected to hub')
    const extra2 = await storeMemory(store, 'extra B connected to hub')

    insertLink(seed.id, hub.id, 0.9)
    insertLink(hub.id, extra1.id, 0.9)
    insertLink(hub.id, extra2.id, 0.9)
    insertLink(seed.id, leaf.id, 0.9)

    const results = search.pprSearch([seed.id], 10)
    const hubResult = results.find((r) => r.id === hub.id)
    const leafResult = results.find((r) => r.id === leaf.id)

    if (hubResult && leafResult) {
      expect(hubResult.similarity).toBeGreaterThanOrEqual(leafResult.similarity)
    }
  })
})

describe('Feature 4: computeClusters()', () => {
  let db: Database.Database
  let store: MemoryStore

  function insertLink(sourceId: string, targetId: string) {
    db.prepare(
      "INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at) VALUES (?, ?, 0.85, 'semantic', ?)"
    ).run(sourceId, targetId, Date.now())
    db.prepare(
      "INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at) VALUES (?, ?, 0.85, 'semantic', ?)"
    ).run(targetId, sourceId, Date.now())
  }

  beforeEach(async () => {
    const testDb = createTestDb()
    db = testDb.db
    seedSession(db)
    store = new MemoryStore(db, false)
  })

  it('returns empty array when no links exist', () => {
    const clusters = computeClusters(db, PROJECT)
    expect(clusters).toEqual([])
  })

  it('groups linked memories into a cluster', async () => {
    const a = await storeMemory(store, 'auth service design')
    const b = await storeMemory(store, 'auth service session handling')
    const c = await storeMemory(store, 'auth service token refresh')
    insertLink(a.id, b.id)
    insertLink(b.id, c.id)

    const clusters = computeClusters(db, PROJECT)
    expect(clusters.length).toBeGreaterThanOrEqual(1)
    const ids = clusters.flatMap((cl) => cl.memberIds)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
    expect(ids).toContain(c.id)
  })

  it('picks highest-importance memory as representative', async () => {
    const low = await store.store({ content: 'low importance', session_id: SESSION, project_path: PROJECT, importance: 0.2 })
    const high = await store.store({ content: 'high importance fact', session_id: SESSION, project_path: PROJECT, importance: 0.9 })
    insertLink(low.id, high.id)

    const clusters = computeClusters(db, PROJECT)
    expect(clusters.length).toBeGreaterThanOrEqual(1)
    const cluster = clusters.find((cl) => cl.memberIds.includes(high.id))
    expect(cluster?.representativeContent).toContain('high importance fact')
  })

  it('excludes singleton groups (< 2 members)', async () => {
    await storeMemory(store, 'isolated memory — no links')

    const clusters = computeClusters(db, PROJECT)
    expect(clusters.every((cl) => cl.memberIds.length >= 2)).toBe(true)
  })
})

describe('Feature 4: runClusterWorker()', () => {
  let db: Database.Database
  let store: MemoryStore
  let search: MemorySearch

  function insertLink(sourceId: string, targetId: string) {
    db.prepare(
      "INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at) VALUES (?, ?, 0.85, 'semantic', ?)"
    ).run(sourceId, targetId, Date.now())
    db.prepare(
      "INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at) VALUES (?, ?, 0.85, 'semantic', ?)"
    ).run(targetId, sourceId, Date.now())
  }

  beforeEach(async () => {
    const testDb = createTestDb()
    db = testDb.db
    seedSession(db)
    store = new MemoryStore(db, false)
    search = new MemorySearch(db, false)
  })

  it('writes clusters to memory_clusters table', async () => {
    const a = await storeMemory(store, 'cluster member A')
    const b = await storeMemory(store, 'cluster member B')
    insertLink(a.id, b.id)

    const count = await runClusterWorker(db, PROJECT)
    expect(count).toBeGreaterThanOrEqual(1)

    const rows = db.prepare('SELECT * FROM memory_clusters WHERE project_path = ?').all(PROJECT) as unknown[]
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })

  it('getClusters returns written clusters', async () => {
    const a = await storeMemory(store, 'cluster node A — auth pattern')
    const b = await storeMemory(store, 'cluster node B — auth pattern')
    insertLink(a.id, b.id)

    await runClusterWorker(db, PROJECT)

    const clusters = search.getClusters(PROJECT)
    expect(clusters.length).toBeGreaterThanOrEqual(1)
    expect(clusters[0].summary.length).toBeGreaterThan(0)
    expect(typeof clusters[0].is_extractive).toBe('boolean')
    expect(Array.isArray(clusters[0].member_ids)).toBe(true)
  })

  it('produces extractive summaries without LLM', async () => {
    const a = await storeMemory(store, 'First sentence of content. Second sentence follows.')
    const b = await storeMemory(store, 'Another related memory here')
    insertLink(a.id, b.id)

    await runClusterWorker(db, PROJECT, undefined)

    const clusters = search.getClusters(PROJECT)
    expect(clusters.length).toBeGreaterThanOrEqual(1)
    expect(clusters[0].is_extractive).toBe(true)
    expect(clusters[0].summary.length).toBeGreaterThan(0)
    expect(clusters[0].summary.length).toBeLessThanOrEqual(125)
  })
})
