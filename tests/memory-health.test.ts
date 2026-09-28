import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { buildMemoryHealth, explainMiss } from '../src/mcp/health.js'
import { ensureNode } from '../src/namespace/tree.js'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'


const PARENT = '/home/user/health-parent'
const CHILD = `${PARENT}/child`
const DAY_MS = 24 * 60 * 60 * 1000

interface HealthPayload {
  scope_memories: number
  never_accessed: number
  duplicate_groups: number
  duplicate_sample: string[][]
  stale_digests: number
  stale_digest_paths: string[]
  thin_scopes: number
  thin_scope_paths: string[]
  namespaces_without_digest: number
  missing_digest_paths: string[]
  digest: { present: boolean; chars: number; age_ms: number | null; stale: boolean }
}

function parse<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0].text) as T
}

let db: Database.Database

async function store(content: string, project = PARENT): Promise<string> {
  const stored = parse<{ id: string; session_id: string }>(
    await handleTool('store_memory', { content, project_path: project })
  )
  // serving a memory counts as an access, so reset it to measure the rest
  db.prepare('UPDATE memories SET access_count = 0 WHERE id = ?').run(stored.id)
  return stored.id
}

describe('memory_health', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    db = getDatabase(':memory:').db
  })

  it('counts scope memories and the never-accessed backlog', async () => {
    const a = await store('alpha fact')
    await store('beta fact')
    db.prepare('UPDATE memories SET access_count = 3 WHERE id = ?').run(a)

    const health = buildMemoryHealth(db, PARENT)
    expect(health.scope_memories).toBe(2)
    expect(health.never_accessed).toBe(1)
    expect(health.generated_at).toBeGreaterThan(0)
  })

  it('reports duplicate groups from high-similarity links', async () => {
    const a = await store('duplicate candidate one')
    const b = await store('duplicate candidate two')
    const c = await store('unrelated distinct fact')
    const now = Date.now()
    db.prepare(
      `INSERT OR REPLACE INTO memory_links (source_id, target_id, similarity, link_type, created_at)
       VALUES (?, ?, 0.97, 'semantic', ?), (?, ?, 0.4, 'semantic', ?)`
    ).run(a, b, now, b, c, now)

    const health = buildMemoryHealth(db, PARENT)
    expect(health.duplicate_groups).toBe(1)
    expect(health.duplicate_sample[0].sort()).toEqual([a, b].sort())
  })

  it('reports stale and missing digests, and thin scopes', async () => {
    const parentId = await store('a fact in the parent scope')
    void parentId
    const now = Date.now()
    // node exists but was never recounted, so the memories table is the source
    ensureNode(db, PARENT)
    ensureNode(db, CHILD)
    db.prepare('UPDATE namespace_nodes SET memory_count = 1, digest = NULL WHERE path = ?').run(CHILD)
    db.prepare('UPDATE namespace_nodes SET memory_count = 1, digest = ? WHERE path = ?').run('child nav', CHILD)

    db.prepare(
      `INSERT INTO project_digests (namespace, content, updated_at) VALUES (?, ?, ?)`
    ).run(PARENT, '- stale pinned fact', now - 30 * DAY_MS)

    const health = buildMemoryHealth(db, PARENT)
    expect(health.namespaces_without_digest).toBeGreaterThanOrEqual(1)
    expect(health.missing_digest_paths).toContain(PARENT)
    expect(health.stale_digests).toBe(1)
    expect(health.stale_digest_paths).toEqual([PARENT])
    expect(health.thin_scopes).toBeGreaterThanOrEqual(1)
    expect(health.thin_scope_paths).toContain(CHILD)
    expect(health.digest.present).toBe(true)
    expect(health.digest.stale).toBe(true)
    expect(health.digest.age_ms).toBeGreaterThan(29 * DAY_MS)
  })

  it('does not call a fresh digest stale', async () => {
    await store('fresh fact')
    db.prepare('INSERT INTO project_digests (namespace, content, updated_at) VALUES (?, ?, ?)').run(
      PARENT,
      '- fresh pinned fact',
      Date.now() - 1000
    )
    const health = buildMemoryHealth(db, PARENT)
    expect(health.digest.present).toBe(true)
    expect(health.digest.stale).toBe(false)
    expect(health.stale_digests).toBe(0)
  })

  it('rides on the get_context roster response', async () => {
    await store('roster health fact')
    const payload = parse<{ memory_health: HealthPayload }>(
      await handleTool('get_context', { project_path: PARENT })
    )
    expect(payload.memory_health.scope_memories).toBe(1)
    expect(payload.memory_health.never_accessed).toBe(1)
    expect(payload.memory_health.digest).toBeDefined()
  })
})

describe('miss explanation', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    db = getDatabase(':memory:').db
  })

  it('says which ancestor scope holds the memories when the leaf is empty', async () => {
    await store('parent scope fact one')
    await store('parent scope fact two')

    const payload = parse<{ memories: unknown[]; miss?: { reason: string; memories_in_ancestors: number } }>(
      await handleTool('get_context', { project_path: CHILD, query: 'parent scope fact' })
    )
    expect(payload.memories).toHaveLength(0)
    expect(payload.miss).toBeDefined()
    expect(payload.miss!.reason).toContain(`no results in ${CHILD}`)
    expect(payload.miss!.reason).toContain('this scope holds 0')
    expect(payload.miss!.reason).toContain(`but ${PARENT} holds 2`)
    expect(payload.miss!.memories_in_ancestors).toBeGreaterThanOrEqual(2)
  })

  it('explains an empty search too, without materializing anything', async () => {
    await store('a fact the child scope does not have')

    const payload = parse<{ results: unknown[]; miss?: { reason: string } }>(
      await handleTool('search_memories', { project_path: CHILD, query: 'a fact' })
    )
    expect(payload.results).toHaveLength(0)
    expect(payload.miss?.reason).toContain('no results in')

    const rows = db.prepare('SELECT COUNT(*) AS n FROM namespace_nodes').get() as { n: number }
    expect(rows.n).toBe(0)
  })

  it('says so when there is no ancestor scope at all', async () => {
    const miss = explainMiss(db, 'work', 0, { materialize: false })
    expect(miss?.reason).toContain('no ancestor namespaces')
    expect(miss?.ancestor_scopes).toEqual([])
  })

  it('stays silent for a healthy result set', async () => {
    for (let i = 0; i < 4; i++) await store(`healthy fact ${i}`)
    const payload = parse<{ memories: unknown[]; miss?: unknown }>(
      await handleTool('get_context', { project_path: PARENT, query: 'healthy fact' })
    )
    expect(payload.memories.length).toBeGreaterThanOrEqual(3)
    expect(payload.miss).toBeUndefined()
  })

  it('flags a weak (non-empty) result set', async () => {
    await store('only one fact here')
    const payload = parse<{ memories: unknown[]; miss?: { reason: string } }>(
      await handleTool('get_context', { project_path: PARENT, query: 'only one fact here' })
    )
    expect(payload.memories).toHaveLength(1)
    expect(payload.miss?.reason).toContain('weak result set (1)')
  })
})
