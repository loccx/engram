import { describe, it, expect, beforeEach } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { refreshDigest } from '../src/memory/digest.js'

const TEST_PROJECT = '/home/user/handlers-project'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
}

function parse<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T
}

async function store(content: string, opts: Record<string, unknown> = {}): Promise<void> {
  await handleTool('store_memory', { content, project_path: TEST_PROJECT, ...opts })
}

describe('get_context handler', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('without a query, returns a blanket importance-ranked set', async () => {
    await store('Redis is great for caching session data', { importance: 0.9 })
    await store('SQLite WAL mode enables concurrent reads', { importance: 0.5 })

    const result = parse<{
      memories: Array<{
        content?: string
        preview: string
        importance: number
        id: string
      }>
    }>(
      await handleTool('get_context', { project_path: TEST_PROJECT })
    )

    expect(result.memories.length).toBe(2)
    expect(result.memories[0].importance).toBeGreaterThanOrEqual(result.memories[1].importance)
    // Roster contract: no full content on the blanket path.
    expect(result.memories[0].content).toBeUndefined()
    expect(result.memories[0].preview).toContain('Redis')
  })

  it('includes a digest of pinned facts in both the query and no-query paths', async () => {
    await store('Redis is great for caching session data')
    const db = getDatabase().db
    db.prepare('UPDATE memories SET pinned = 1').run()
    await refreshDigest(db, TEST_PROJECT)

    const blanket = parse<{ digest: string }>(
      await handleTool('get_context', { project_path: TEST_PROJECT })
    )
    expect(blanket.digest).toContain('Redis is great for caching session data')

    const scoped = parse<{ digest: string }>(
      await handleTool('get_context', { project_path: TEST_PROJECT, query: 'redis' })
    )
    expect(scoped.digest).toBe(blanket.digest)
  })

  it('omits present-state digest and topics from historical as_of context', async () => {
    await store('Future pinned fact that must not leak into history')
    const db = getDatabase().db
    db.prepare('UPDATE memories SET pinned = 1').run()
    await refreshDigest(db, TEST_PROJECT)
    db.prepare(
      `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`
    ).run(TEST_PROJECT, JSON.stringify(['future-memory']), 'present-state topic', Date.now(), Date.now())

    const result = parse<{
      digest: string | null
      topics: unknown[]
      as_of_limitations: { digest_omitted: boolean; topics_omitted: boolean }
    }>(await handleTool('get_context', { project_path: TEST_PROJECT, as_of: 1 }))

    expect(result.digest).toBeNull()
    expect(result.topics).toEqual([])
    expect(result.as_of_limitations).toEqual({
      digest_omitted: true,
      topics_omitted: true,
    })
  })

  it('refreshes the digest in the background when set_pin runs', async () => {
    await store('Deploys must run from the release branch')
    const listed = parse<{ memories: Array<{ id: string }> }>(
      await handleTool('list_memories', { project_path: TEST_PROJECT })
    )

    await handleTool('set_pin', { id: listed.memories[0].id, pinned: true })
    await new Promise((resolve) => setImmediate(resolve))

    const result = parse<{ digest: string }>(
      await handleTool('get_context', { project_path: TEST_PROJECT })
    )
    expect(result.digest).toContain('Deploys must run from the release branch')
  })

  it('serves only roster previews on the blanket path, even with full_content set', async () => {
    const long = 'Rotation policy ' + 'x'.repeat(1000)
    await store(long)

    // Blanket path never serves full content — compact_content/full_content
    // are query-path flags.
    const roster = parse<{ memories: Array<{ content?: string; preview: string }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT, full_content: true })
    )
    expect(roster.memories[0].content).toBeUndefined()
    expect(roster.memories[0].preview.length).toBeLessThanOrEqual(161)
    expect(roster.memories[0].preview.endsWith('…')).toBe(true)

    // Query path: compact by default; full_content opts back into full content.
    const scoped = parse<{ memories: Array<{ content: string }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT, query: 'rotation policy' })
    )
    expect(scoped.memories[0].content.length).toBeLessThan(long.length)

    const expanded = parse<{ memories: Array<{ content: string }> }>(
      await handleTool('get_context', {
        project_path: TEST_PROJECT,
        query: 'rotation policy',
        full_content: true,
      })
    )
    expect(expanded.memories[0].content).toBe(long)
  })

  it('ranks by relevance when a query is given, unlike the importance-only blanket path', async () => {
    // High importance but irrelevant to the query; low importance but exactly on-topic.
    await store('Kubernetes pods restart on OOM kill', { importance: 0.9 })
    await store('Redis is great for caching session data', { importance: 0.1 })

    const blanket = parse<{ memories: Array<{ preview: string }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT })
    )
    expect(blanket.memories[0].preview).toContain('Kubernetes')

    const scoped = parse<{ memories: Array<{ content: string }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT, query: 'redis caching' })
    )
    expect(scoped.memories[0].content).toContain('Redis')
  })

  it('returns full cluster membership by default and caps only with compact_topics', async () => {
    const memberIds = Array.from({ length: 700 }, (_, i) => `mem-${i}`)
    getDatabase().db
      .prepare(
        `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`
      )
      .run(TEST_PROJECT, JSON.stringify(memberIds), 'a big topic', Date.now(), Date.now())

    // Blanket path: topics are always summarized (5-id sample + count).
    const blanket = parse<{ topics: Array<{ member_ids: string[]; member_count?: number }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT })
    )
    expect(blanket.topics.length).toBe(1)
    expect(blanket.topics[0].member_ids.length).toBeLessThan(700)

    // Explicit opt-in: full_topics forces complete membership.
    const expanded = parse<{ topics: Array<{ member_ids: string[] }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT, query: 'topic', full_topics: true })
    )
    expect(expanded.topics[0].member_ids.length).toBe(700)

    // compact_topics is accepted as a no-op for backward compatibility.

    const compact = parse<{
      topics: Array<{ member_ids: string[]; member_count: number }>
    }>(await handleTool('get_context', { project_path: TEST_PROJECT, query: 'topic', compact_topics: true }))
    expect(compact.topics[0].member_count).toBe(700)
    expect(compact.topics[0].member_ids.length).toBeLessThan(700)
  })
})
