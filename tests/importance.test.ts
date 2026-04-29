import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { MemoryStore } from '../src/memory/store.js'
import { BackgroundJobQueue } from '../src/queue/background-queue.js'
import { resetLlmConfigForTests } from '../src/llm/client.js'
import {
  isImportanceScoringEnabled,
  resetImportanceQueueForTests,
  getImportanceQueue,
  drainImportanceQueue,
} from '../src/importance/runtime.js'
import { IMPORTANCE_PROMPT_VERSION } from '../src/importance/scorer.js'

function ensureSession(db: Database.Database, sid: string, pp: string): void {
  db.prepare(`INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)`).run(
    sid,
    pp,
    Date.now()
  )
}

function configureLlm(): void {
  process.env.ENGRAM_LLM_BASE_URL = 'https://gw.test/v1'
  process.env.ENGRAM_LLM_API_KEY = 'k'
  process.env.ENGRAM_LLM_MODEL = 'gpt-test'
  resetLlmConfigForTests()
  resetImportanceQueueForTests()
}

function clearLlm(): void {
  delete process.env.ENGRAM_LLM_BASE_URL
  delete process.env.ENGRAM_LLM_API_KEY
  delete process.env.ENGRAM_LLM_MODEL
  delete process.env.ENGRAM_IMPORTANCE_DISABLED
  resetLlmConfigForTests()
  resetImportanceQueueForTests()
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

interface MemoryRow {
  importance: number
  importance_source: string
  importance_model: string | null
  importance_prompt_version: string | null
  importance_scored_at: number | null
}

function fetchRow(db: Database.Database, id: string): MemoryRow {
  return db
    .prepare(
      `SELECT importance, importance_source, importance_model, importance_prompt_version, importance_scored_at
       FROM memories WHERE id = ?`
    )
    .get(id) as MemoryRow
}

describe('importance scoring - feature gating', () => {
  beforeEach(() => clearLlm())
  afterEach(() => clearLlm())

  it('is disabled when LLM env not configured', () => {
    expect(isImportanceScoringEnabled()).toBe(false)
  })

  it('is enabled when LLM is configured', () => {
    configureLlm()
    expect(isImportanceScoringEnabled()).toBe(true)
  })

  it('respects ENGRAM_IMPORTANCE_DISABLED=1 opt-out even with LLM configured', () => {
    configureLlm()
    process.env.ENGRAM_IMPORTANCE_DISABLED = '1'
    expect(isImportanceScoringEnabled()).toBe(false)
  })

  it('getImportanceQueue returns null when disabled', () => {
    const { db } = createTestDb()
    expect(getImportanceQueue(db)).toBeNull()
  })

  it('getImportanceQueue returns a queue instance when enabled', () => {
    configureLlm()
    const { db } = createTestDb()
    const q = getImportanceQueue(db)
    expect(q).toBeInstanceOf(BackgroundJobQueue)
  })
})

describe('importance scoring - end-to-end via MemoryStore', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    clearLlm()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearLlm()
  })

  it('llm-success: store updates importance from default to llm-scored value', async () => {
    configureLlm()
    fetchMock.mockResolvedValueOnce(chatResponse('{"importance": 0.85, "reason": "key decision"}'))

    const { db, vectorsAvailable } = createTestDb()
    const queue = getImportanceQueue(db)!
    const store = new MemoryStore(db, vectorsAvailable, null, queue)

    ensureSession(db, 'sess1', '/proj')
    const memory = await store.store({
      content: 'We chose Postgres over Mongo because of transactional guarantees.',
      session_id: 'sess1',
      project_path: '/proj',
      type: 'decision',
    })

    expect(memory.importance).toBe(0.5)
    expect(memory.importance_source).toBe('default')

    await drainImportanceQueue()

    const row = fetchRow(db, memory.id)
    expect(row.importance).toBe(0.85)
    expect(row.importance_source).toBe('llm')
    expect(row.importance_model).toBe('gpt-test')
    expect(row.importance_prompt_version).toBe(IMPORTANCE_PROMPT_VERSION)
    expect(row.importance_scored_at).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('llm-failure: importance falls back to default and source stays default', async () => {
    configureLlm()
    // Force non-retryable failure to avoid waiting through retries
    fetchMock.mockResolvedValue(new Response('bad', { status: 400 }))

    const { db, vectorsAvailable } = createTestDb()
    const queue = getImportanceQueue(db)!
    const store = new MemoryStore(db, vectorsAvailable, null, queue)

    ensureSession(db, 'sess1', '/proj')
    const memory = await store.store({
      content: 'minor note',
      session_id: 'sess1',
      project_path: '/proj',
    })

    await drainImportanceQueue()

    const row = fetchRow(db, memory.id)
    expect(row.importance).toBe(0.5)
    expect(row.importance_source).toBe('default')
    expect(row.importance_model).toBeNull()
    expect(row.importance_scored_at).toBeNull()
  })

  it('llm-disabled: store does not enqueue and importance stays default', async () => {
    const { db, vectorsAvailable } = createTestDb()
    const queue = getImportanceQueue(db)
    const store = new MemoryStore(db, vectorsAvailable, null, queue)

    ensureSession(db, 'sess1', '/proj')
    const memory = await store.store({
      content: 'whatever',
      session_id: 'sess1',
      project_path: '/proj',
    })

    expect(queue).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    const row = fetchRow(db, memory.id)
    expect(row.importance).toBe(0.5)
    expect(row.importance_source).toBe('default')
  })

  it('opt-out env: ENGRAM_IMPORTANCE_DISABLED prevents enqueue', async () => {
    configureLlm()
    process.env.ENGRAM_IMPORTANCE_DISABLED = '1'
    resetImportanceQueueForTests()

    const { db, vectorsAvailable } = createTestDb()
    const queue = getImportanceQueue(db)
    expect(queue).toBeNull()

    const store = new MemoryStore(db, vectorsAvailable, null, queue)
    ensureSession(db, 'sess1', '/proj')
    const memory = await store.store({
      content: 'foo',
      session_id: 'sess1',
      project_path: '/proj',
    })

    expect(fetchMock).not.toHaveBeenCalled()
    const row = fetchRow(db, memory.id)
    expect(row.importance_source).toBe('default')
  })

  it('user-provided respected: source=user and queue is not enqueued', async () => {
    configureLlm()

    const { db, vectorsAvailable } = createTestDb()
    const queue = getImportanceQueue(db)!
    const store = new MemoryStore(db, vectorsAvailable, null, queue)

    ensureSession(db, 'sess1', '/proj')
    const memory = await store.store({
      content: 'explicit user-set importance',
      session_id: 'sess1',
      project_path: '/proj',
      importance: 0.7,
      importanceProvided: true,
    })

    expect(memory.importance).toBe(0.7)
    expect(memory.importance_source).toBe('user')
    expect(queue.size()).toBe(0)
    await drainImportanceQueue()
    expect(fetchMock).not.toHaveBeenCalled()

    const row = fetchRow(db, memory.id)
    expect(row.importance).toBe(0.7)
    expect(row.importance_source).toBe('user')
    expect(row.importance_model).toBeNull()
  })

  it('user-provided is never overwritten even if a stale job races', async () => {
    configureLlm()
    fetchMock.mockResolvedValueOnce(chatResponse('{"importance": 0.95, "reason": "high"}'))

    const { db, vectorsAvailable } = createTestDb()
    const queue = getImportanceQueue(db)!
    const store = new MemoryStore(db, vectorsAvailable, null, queue)

    ensureSession(db, 'sess1', '/proj')
    // Insert WITHOUT importanceProvided so the worker enqueues...
    const memory = await store.store({
      content: 'race target',
      session_id: 'sess1',
      project_path: '/proj',
    })

    // ...then user "claims" it before the worker gets to write
    db.prepare(
      `UPDATE memories SET importance = 0.2, importance_source = 'user' WHERE id = ?`
    ).run(memory.id)

    await drainImportanceQueue()

    const row = fetchRow(db, memory.id)
    // User claim must win — worker's UPDATE has WHERE importance_source != 'user'
    expect(row.importance).toBe(0.2)
    expect(row.importance_source).toBe('user')
    expect(row.importance_model).toBeNull()
  })

  it('non-blocking: store() returns in <50ms even when LLM is slow', async () => {
    configureLlm()
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(chatResponse('{"importance": 0.6, "reason": "ok"}')), 5000)
        )
    )

    const { db, vectorsAvailable } = createTestDb()
    const queue = getImportanceQueue(db)!
    const store = new MemoryStore(db, vectorsAvailable, null, queue)

    ensureSession(db, 'sess1', '/proj')
    const t0 = Date.now()
    const memory = await store.store({
      content: 'speed test',
      session_id: 'sess1',
      project_path: '/proj',
    })
    const elapsed = Date.now() - t0

    expect(elapsed).toBeLessThan(50)
    expect(memory.importance_source).toBe('default')
    expect(queue.size()).toBeGreaterThanOrEqual(0)
  })

  it('drain waits for in-flight scoring jobs to complete', async () => {
    configureLlm()
    let resolveLlm: ((r: Response) => void) | null = null
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveLlm = resolve
        })
    )

    const { db, vectorsAvailable } = createTestDb()
    const queue = getImportanceQueue(db)!
    const store = new MemoryStore(db, vectorsAvailable, null, queue)

    ensureSession(db, 'sess1', '/proj')
    const memory = await store.store({
      content: 'drain test',
      session_id: 'sess1',
      project_path: '/proj',
    })

    const drainPromise = drainImportanceQueue()
    resolveLlm!(chatResponse('{"importance": 0.4, "reason": "ok"}'))
    await drainPromise

    const row = fetchRow(db, memory.id)
    expect(row.importance).toBe(0.4)
    expect(row.importance_source).toBe('llm')
  })
})
