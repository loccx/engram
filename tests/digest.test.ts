import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { resetLlmConfigForTests } from '../src/llm/client.js'
import {
  getDigest,
  refreshDigest,
  DEFAULT_DIGEST_BUDGET_CHARS,
} from '../src/memory/digest.js'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'

const NS = '/home/user/digest-project'

function configureLlm(): void {
  process.env.ENGRAM_LLM_BASE_URL = 'https://gw.test/v1'
  process.env.ENGRAM_LLM_API_KEY = 'k'
  process.env.ENGRAM_LLM_MODEL = 'gpt-test'
  resetLlmConfigForTests()
}

function clearLlm(): void {
  delete process.env.ENGRAM_LLM_BASE_URL
  delete process.env.ENGRAM_LLM_API_KEY
  delete process.env.ENGRAM_LLM_MODEL
  delete process.env.ENGRAM_DIGEST_BUDGET_CHARS
  resetLlmConfigForTests()
}

function chatResponse(content: string, model = 'gpt-test'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

function insertPinned(
  db: Database.Database,
  id: string,
  content: string,
  opts: { type?: string; pinned?: boolean; namespace?: string; createdAt?: number } = {}
): void {
  const ns = opts.namespace ?? NS
  db.prepare(
    'INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)'
  ).run('sess1', ns, Date.now())
  db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, 0.5, '[]', ?, ?)`
  ).run(
    id,
    'sess1',
    ns,
    ns,
    content,
    opts.type ?? 'note',
    opts.createdAt ?? Date.now(),
    opts.pinned === false ? 0 : 1
  )
}

function rowCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM project_digests').get() as { n: number }
  return row.n
}

describe('project digest', () => {
  beforeEach(() => clearLlm())
  afterEach(() => {
    clearLlm()
    vi.restoreAllMocks()
  })

  it('returns an empty digest when there are no pinned memories', async () => {
    const { db } = createTestDb()
    expect(getDigest(db, NS)).toBe('')

    const result = await refreshDigest(db, NS)
    expect(result.content).toBe('')
    expect(getDigest(db, NS)).toBe('')
  })

  it('builds a deterministic bullet join under budget without calling the LLM', async () => {
    const { db } = createTestDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    insertPinned(db, 'm1', 'Use Postgres 16 for primary storage', {
      type: 'decision',
      createdAt: 1000,
    })
    insertPinned(db, 'm2', 'Never run migrations against prod without a backup', {
      type: 'gotcha',
      createdAt: 2000,
    })

    const result = await refreshDigest(db, NS)

    expect(result.content).toBe(
      '- [decision] Use Postgres 16 for primary storage\n' +
        '- [gotcha] Never run migrations against prod without a backup'
    )
    expect(result.changed).toBe(true)
    expect(getDigest(db, NS)).toBe(result.content)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ignores unpinned memories and other namespaces', async () => {
    const { db } = createTestDb()
    insertPinned(db, 'm1', 'pinned fact', { createdAt: 1000 })
    insertPinned(db, 'm2', 'unpinned fact', { pinned: false, createdAt: 2000 })
    insertPinned(db, 'm3', 'other project fact', { namespace: '/other', createdAt: 3000 })

    const result = await refreshDigest(db, NS)

    expect(result.content).toBe('- [note] pinned fact')
  })

  it('consolidates via the LLM when over budget and the LLM is configured', async () => {
    const { db } = createTestDb()
    configureLlm()
    const condensed = '- everything, condensed'
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(chatResponse(condensed))

    for (let i = 0; i < 20; i++) {
      insertPinned(db, `m${i}`, 'x'.repeat(100), { createdAt: 1000 + i })
    }

    const result = await refreshDigest(db, NS, { budgetChars: 200 })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.content).toBe(condensed)
    expect(result.content.length).toBeLessThanOrEqual(200)
    expect(getDigest(db, NS)).toBe(condensed)
  })

  it('hard-caps LLM output that overshoots the budget', async () => {
    const { db } = createTestDb()
    configureLlm()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(chatResponse('y'.repeat(5000)))

    for (let i = 0; i < 20; i++) {
      insertPinned(db, `m${i}`, 'x'.repeat(100), { createdAt: 1000 + i })
    }

    const result = await refreshDigest(db, NS, { budgetChars: 200 })

    expect(result.content.length).toBe(200)
  })

  it('truncates with a fallback marker when over budget and the LLM is not configured', async () => {
    const { db } = createTestDb()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (let i = 0; i < 20; i++) {
      insertPinned(db, `m${i}`, 'x'.repeat(100), { createdAt: 1000 + i })
    }

    const result = await refreshDigest(db, NS, { budgetChars: 300 })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.content.length).toBeLessThanOrEqual(300)
    expect(result.content).toContain('more pinned, set ENGRAM_LLM_BASE_URL to auto-consolidate')
    expect(result.content).toContain('- [note] xxx')
  })

  it('falls back to the previous digest when the LLM call fails', async () => {
    const { db } = createTestDb()
    insertPinned(db, 'm1', 'first fact', { createdAt: 1000 })
    const first = await refreshDigest(db, NS, { budgetChars: 500 })
    expect(first.content).toBe('- [note] first fact')

    configureLlm()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    for (let i = 0; i < 20; i++) {
      insertPinned(db, `n${i}`, 'x'.repeat(100), { createdAt: 2000 + i })
    }

    const result = await refreshDigest(db, NS, { budgetChars: 200 })

    expect(result.content).toBe('- [note] first fact')
    expect(result.changed).toBe(false)
    expect(getDigest(db, NS)).toBe('- [note] first fact')
  })

  it('short-circuits on an unchanged pinned set without calling the LLM', async () => {
    const { db } = createTestDb()
    configureLlm()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(chatResponse('- condensed'))

    for (let i = 0; i < 20; i++) {
      insertPinned(db, `m${i}`, 'x'.repeat(100), { createdAt: 1000 + i })
    }

    const first = await refreshDigest(db, NS, { budgetChars: 200 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const second = await refreshDigest(db, NS, { budgetChars: 200 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(second.content).toBe(first.content)
    expect(second.changed).toBe(false)
  })

  it('recomputes when the pinned set changes', async () => {
    const { db } = createTestDb()
    insertPinned(db, 'm1', 'first fact', { createdAt: 1000 })
    const first = await refreshDigest(db, NS)

    insertPinned(db, 'm2', 'second fact', { createdAt: 2000 })
    const second = await refreshDigest(db, NS)

    expect(second.changed).toBe(true)
    expect(second.content).not.toBe(first.content)
    expect(second.content).toContain('second fact')
  })

  it('keys refresh by the resolved namespace (namespace override, not raw project_path)', async () => {
    const { db } = createTestDb()
    db.prepare(
      'INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)'
    ).run('sess1', '/proj', Date.now())
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, pinned)
       VALUES (?, 'sess1', ?, ?, ?, 'note', 0.5, '[]', ?, 1)`
    ).run('m-ns', '/proj', 'work', 'namespaced pinned fact', Date.now())

    const result = await refreshDigest(db, 'work')
    expect(result.content).toContain('namespaced pinned fact')
    expect(getDigest(db, 'work')).toContain('namespaced pinned fact')

    // The raw project_path was never keyed: refreshing under it yields
    // nothing (and must not have produced a stale duplicate row).
    expect(getDigest(db, '/proj')).toBe('')
  })

  it('upserts a single row per namespace across repeated refreshes', async () => {
    const { db } = createTestDb()
    insertPinned(db, 'm1', 'first fact', { createdAt: 1000 })

    await refreshDigest(db, NS)
    await refreshDigest(db, NS)
    insertPinned(db, 'm2', 'second fact', { createdAt: 2000 })
    await refreshDigest(db, NS)

    expect(rowCount(db)).toBe(1)
  })

  it('reads the budget from ENGRAM_DIGEST_BUDGET_CHARS and falls back on garbage', async () => {
    const { db } = createTestDb()
    for (let i = 0; i < 5; i++) {
      insertPinned(db, `m${i}`, 'x'.repeat(60), { createdAt: 1000 + i })
    }

    process.env.ENGRAM_DIGEST_BUDGET_CHARS = '150'
    const capped = await refreshDigest(db, NS)
    expect(capped.content.length).toBeLessThanOrEqual(150)

    process.env.ENGRAM_DIGEST_BUDGET_CHARS = 'not-a-number'
    db.prepare('DELETE FROM project_digests').run()
    const fallback = await refreshDigest(db, NS)
    expect(fallback.content.length).toBeLessThanOrEqual(DEFAULT_DIGEST_BUDGET_CHARS)
    expect(fallback.content).not.toContain('more pinned')
  })

  it('does not mutate or supersede the pinned memory rows it reads', async () => {
    const { db } = createTestDb()
    configureLlm()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(chatResponse('- condensed'))
    for (let i = 0; i < 20; i++) {
      insertPinned(db, `m${i}`, 'x'.repeat(100), { createdAt: 1000 + i })
    }
    const before = db
      .prepare('SELECT id, content, type, pinned FROM memories ORDER BY id')
      .all()

    await refreshDigest(db, NS, { budgetChars: 200 })

    const after = db
      .prepare('SELECT id, content, type, pinned FROM memories ORDER BY id')
      .all()
    expect(after).toEqual(before)

    const links = db.prepare('SELECT COUNT(*) AS n FROM memory_links').get() as { n: number }
    expect(links.n).toBe(0)
  })
})

describe('digest invalidation via MCP with namespace overrides', () => {
  const PROJECT = '/proj'
  const NAMESPACE = 'work'

  interface ToolResult {
    content: Array<{ type: 'text'; text: string }>
  }

  function parse<T>(result: ToolResult): T {
    return JSON.parse(result.content[0].text) as T
  }

  function insertNamespacedMemory(): string {
    const db = getDatabase().db
    db.prepare("INSERT INTO sessions(id, project_path, started_at) VALUES ('s-ns', ?, ?)").run(PROJECT, Date.now())
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, pinned)
       VALUES ('m-pin', 's-ns', ?, ?, 'SUPER SECRET NAMESPACED FACT', 'note', 0.5, '[]', ?, 1)`
    ).run(PROJECT, NAMESPACE, Date.now())
    return 'm-pin'
  }

  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('set_pin refreshes the digest under namespace ?? project_path', async () => {
    insertNamespacedMemory()
    await handleTool('set_pin', { id: 'm-pin', pinned: true })
    await new Promise((resolve) => setImmediate(resolve))

    const db = getDatabase().db
    expect(getDigest(db, NAMESPACE)).toContain('SUPER SECRET NAMESPACED FACT')
    // The raw project_path must not hold a phantom digest row.
    expect(getDigest(db, PROJECT)).toBe('')
  })

  it('forget_memory invalidates the namespace digest so deleted pinned content is never served', async () => {
    insertNamespacedMemory()
    await handleTool('set_pin', { id: 'm-pin', pinned: true })
    await new Promise((resolve) => setImmediate(resolve))

    const db = getDatabase().db
    expect(getDigest(db, NAMESPACE)).toContain('SUPER SECRET NAMESPACED FACT')

    const forgetResult = parse<{ success: boolean }>(
      await handleTool('forget_memory', { id: 'm-pin' })
    )
    expect(forgetResult.success).toBe(true)
    // Immediate invalidation prevents stale secret content even if the
    // asynchronous rebuild fails or has not run yet.
    expect(getDigest(db, NAMESPACE)).toBe('')
    await new Promise((resolve) => setImmediate(resolve))

    // Deleted pinned content is gone from the digest and from get_context.
    expect(getDigest(db, NAMESPACE)).not.toContain('SUPER SECRET NAMESPACED FACT')
    const ctx = parse<{ digest: string }>(
      await handleTool('get_context', { project_path: NAMESPACE })
    )
    expect(ctx.digest).not.toContain('SUPER SECRET NAMESPACED FACT')
  })
})
