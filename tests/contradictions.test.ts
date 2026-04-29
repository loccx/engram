import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { findContradictionCandidates } from '../src/contradictions/candidates.js'
import { judgeCandidates, PROMPT_VERSION, type JudgeInput } from '../src/contradictions/judge.js'
import { resetLlmConfigForTests, LlmUnavailableError } from '../src/llm/client.js'

interface InsertOpts {
  namespace?: string
  projectPath?: string
  type?: string
  tags?: string[]
  importance?: number
  createdAt?: number
}

function ensureSession(db: Database.Database, sessionId: string, projectPath: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, project_path, started_at)
     VALUES (?, ?, ?)`
  ).run(sessionId, projectPath, Date.now())
}

function insertMemory(
  db: Database.Database,
  id: string,
  content: string,
  opts: InsertOpts = {}
): void {
  const ns = opts.namespace ?? '/proj'
  const pp = opts.projectPath ?? ns
  const type = opts.type ?? 'note'
  const tags = JSON.stringify(opts.tags ?? [])
  const created = opts.createdAt ?? Date.now()
  ensureSession(db, 'sess1', pp)
  db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, 'sess1', pp, ns, content, type, opts.importance ?? 0.5, tags, created)
}

describe('contradiction candidates - FTS-only', () => {
  let dbm: ReturnType<typeof createTestDb>
  beforeEach(() => {
    dbm = createTestDb()
  })

  it('returns empty when no memories', () => {
    const out = findContradictionCandidates(dbm.db, {
      namespace: '/proj',
      excludeMemoryId: 'new-id',
      contentForFts: 'use postgres for prod',
      vectorsAvailable: false,
    })
    expect(out).toEqual([])
  })

  it('finds FTS overlap by content tokens', () => {
    const a = randomUUID()
    const b = randomUUID()
    insertMemory(dbm.db, a, 'we use postgres for production database')
    insertMemory(dbm.db, b, 'completely unrelated text about cats')
    const out = findContradictionCandidates(dbm.db, {
      namespace: '/proj',
      excludeMemoryId: 'new',
      contentForFts: 'switch to mysql for production database',
      vectorsAvailable: false,
    })
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].memory.id).toBe(a)
    expect(out[0].source).toBe('fts')
  })

  it('excludes the source memory id', () => {
    const id = randomUUID()
    insertMemory(dbm.db, id, 'use postgres for production')
    const out = findContradictionCandidates(dbm.db, {
      namespace: '/proj',
      excludeMemoryId: id,
      contentForFts: 'use postgres for production',
      vectorsAvailable: false,
    })
    expect(out.find((c) => c.memory.id === id)).toBeUndefined()
  })

  it('respects namespace boundary', () => {
    const a = randomUUID()
    const b = randomUUID()
    insertMemory(dbm.db, a, 'use postgres for production', { namespace: '/proj-a' })
    insertMemory(dbm.db, b, 'use postgres for production', { namespace: '/proj-b' })
    const out = findContradictionCandidates(dbm.db, {
      namespace: '/proj-a',
      excludeMemoryId: 'new',
      contentForFts: 'use postgres for production',
      vectorsAvailable: false,
    })
    expect(out.map((c) => c.memory.id)).toEqual([a])
  })

  it('caps results at maxCandidates', () => {
    for (let i = 0; i < 25; i++) {
      insertMemory(dbm.db, randomUUID(), `database postgres item number ${i}`)
    }
    const out = findContradictionCandidates(
      dbm.db,
      {
        namespace: '/proj',
        excludeMemoryId: 'new',
        contentForFts: 'database postgres',
        vectorsAvailable: false,
      },
      { maxCandidates: 5 }
    )
    expect(out.length).toBe(5)
  })

  it('handles content with only short tokens gracefully', () => {
    insertMemory(dbm.db, randomUUID(), 'use postgres')
    const out = findContradictionCandidates(dbm.db, {
      namespace: '/proj',
      excludeMemoryId: 'new',
      contentForFts: 'a b c',
      vectorsAvailable: false,
    })
    expect(out).toEqual([])
  })

  it('falls back from AND to OR when AND returns nothing', () => {
    insertMemory(dbm.db, randomUUID(), 'we deploy via terraform')
    const out = findContradictionCandidates(dbm.db, {
      namespace: '/proj',
      excludeMemoryId: 'new',
      contentForFts: 'terraform xyzzy plugh',
      vectorsAvailable: false,
    })
    expect(out.length).toBe(1)
  })
})

describe('contradiction judge - LLM mocked', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    process.env.ENGRAM_LLM_BASE_URL = 'https://gw.test/v1'
    process.env.ENGRAM_LLM_API_KEY = 'k'
    process.env.ENGRAM_LLM_MODEL = 'gpt-test'
    resetLlmConfigForTests()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.ENGRAM_LLM_BASE_URL
    delete process.env.ENGRAM_LLM_API_KEY
    delete process.env.ENGRAM_LLM_MODEL
    resetLlmConfigForTests()
  })

  function makeInput(numCandidates: number): JudgeInput {
    const candidates = Array.from({ length: numCandidates }, (_, i) => ({
      memory: {
        id: `cand-${i}`,
        session_id: 's',
        project_path: '/proj',
        content: `candidate ${i} body`,
        type: 'note' as const,
        importance: 0.5,
        tags: [],
        created_at: 1_000_000 + i,
        last_accessed: null,
        access_count: 0,
        vec_rowid: null,
      },
      source: 'fts' as const,
    }))
    return {
      newMemory: { id: 'new-id', content: 'new memory body', created_at: 2_000_000, type: 'note' },
      candidates,
    }
  }

  it('throws LlmUnavailableError when LLM not configured', async () => {
    delete process.env.ENGRAM_LLM_BASE_URL
    resetLlmConfigForTests()
    await expect(judgeCandidates(makeInput(1))).rejects.toBeInstanceOf(LlmUnavailableError)
  })

  it('returns empty verdicts immediately for zero candidates', async () => {
    const result = await judgeCandidates(makeInput(0))
    expect(result.verdicts).toEqual([])
    expect(result.promptVersion).toBe(PROMPT_VERSION)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('parses well-formed verdicts in candidate order', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'gpt-test',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdicts: [
                    { candidateId: 'cand-0', relation: 'contradicts', confidence: 0.92, reason: 'opposite claim' },
                    { candidateId: 'cand-1', relation: 'unrelated', confidence: 0.1, reason: 'different topic' },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
        }),
        { status: 200 }
      )
    )
    const result = await judgeCandidates(makeInput(2))
    expect(result.verdicts).toHaveLength(2)
    expect(result.verdicts[0]).toMatchObject({
      candidateId: 'cand-0',
      relation: 'contradicts',
      confidence: 0.92,
    })
    expect(result.verdicts[1]).toMatchObject({
      candidateId: 'cand-1',
      relation: 'unrelated',
    })
    expect(result.promptVersion).toBe(PROMPT_VERSION)
    expect(result.model).toBe('gpt-test')
  })

  it('coerces invalid relation to unrelated', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'gpt-test',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdicts: [{ candidateId: 'cand-0', relation: 'banana', confidence: 0.5, reason: 'idk' }],
                }),
              },
            },
          ],
        }),
        { status: 200 }
      )
    )
    const result = await judgeCandidates(makeInput(1))
    expect(result.verdicts[0].relation).toBe('unrelated')
  })

  it('clamps confidence to [0,1] and parses string numbers', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'gpt-test',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdicts: [
                    { candidateId: 'cand-0', relation: 'duplicate', confidence: '1.5', reason: 'over' },
                    { candidateId: 'cand-1', relation: 'supports', confidence: -0.3, reason: 'neg' },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 }
      )
    )
    const result = await judgeCandidates(makeInput(2))
    expect(result.verdicts[0].confidence).toBe(1)
    expect(result.verdicts[1].confidence).toBe(0)
  })

  it('synthesizes default verdict for missing candidate', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'gpt-test',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdicts: [{ candidateId: 'cand-0', relation: 'updates', confidence: 0.8, reason: 'refines' }],
                }),
              },
            },
          ],
        }),
        { status: 200 }
      )
    )
    const result = await judgeCandidates(makeInput(2))
    expect(result.verdicts).toHaveLength(2)
    expect(result.verdicts[0].relation).toBe('updates')
    expect(result.verdicts[1].relation).toBe('unrelated')
    expect(result.verdicts[1].confidence).toBe(0)
    expect(result.verdicts[1].reason).toMatch(/omitted/i)
  })

  it('sends temperature 0 and json response_format', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'gpt-test',
          choices: [
            { message: { content: JSON.stringify({ verdicts: [{ candidateId: 'cand-0', relation: 'unrelated', confidence: 0, reason: '' }] }) } },
          ],
        }),
        { status: 200 }
      )
    )
    await judgeCandidates(makeInput(1))
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.temperature).toBe(0)
    expect(sent.response_format).toEqual({ type: 'json_object' })
    expect(sent.messages[0].role).toBe('system')
    expect(sent.messages[1].content).toContain('CANDIDATE 1:')
    expect(sent.messages[1].content).toContain('NEW memory:')
  })
})
