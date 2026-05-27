import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { adjudicateMemory, SUPERSEDES_THRESHOLD } from '../src/contradictions/adjudicator.js'
import { AdjudicationQueue, withTimeout } from '../src/contradictions/queue.js'
import { resetLlmConfigForTests } from '../src/llm/client.js'
import { PROMPT_VERSION, type JudgeInput, type Verdict } from '../src/contradictions/judge.js'

function ensureSession(db: Database.Database, sid: string, pp: string): void {
  db.prepare(`INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)`).run(
    sid,
    pp,
    Date.now()
  )
}

function insertMemory(
  db: Database.Database,
  id: string,
  content: string,
  opts: { namespace?: string; pinned?: boolean } = {}
): void {
  const ns = opts.namespace ?? '/proj'
  ensureSession(db, 'sess1', ns)
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags, created_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, 'sess1', ns, ns, content, 'note', 0.5, '[]', Date.now(), opts.pinned ? 1 : 0)
}

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
  resetLlmConfigForTests()
}

const fakeJudge =
  (verdicts: Verdict[]) =>
  async (input: JudgeInput): Promise<{ verdicts: Verdict[]; model: string; promptVersion: string }> => ({
    verdicts: input.candidates.map(
      (c) => verdicts.find((v) => v.candidateId === c.memory.id) ?? {
        candidateId: c.memory.id,
        relation: 'unrelated',
        confidence: 0,
        reason: '',
      }
    ),
    model: 'gpt-test',
    promptVersion: PROMPT_VERSION,
  })

describe('adjudicator', () => {
  let dbm: ReturnType<typeof createTestDb>
  beforeEach(() => {
    dbm = createTestDb()
    configureLlm()
  })
  afterEach(() => {
    clearLlm()
  })

  it('returns memory-missing for unknown id', async () => {
    const result = await adjudicateMemory(dbm.db, 'nope', { vectorsAvailable: false })
    expect(result.status).toBe('memory-missing')
    expect(result.linksWritten).toBe(0)
  })

  it('returns pinned for pinned memory', async () => {
    const id = randomUUID()
    insertMemory(dbm.db, id, 'pinned content', { pinned: true })
    const result = await adjudicateMemory(dbm.db, id, { vectorsAvailable: false })
    expect(result.status).toBe('pinned')
  })

  it('returns llm-unavailable when LLM not configured', async () => {
    clearLlm()
    const id = randomUUID()
    insertMemory(dbm.db, id, 'use postgres')
    const result = await adjudicateMemory(dbm.db, id, { vectorsAvailable: false })
    expect(result.status).toBe('llm-unavailable')
  })

  it('returns no-candidates when nothing matches', async () => {
    const id = randomUUID()
    insertMemory(dbm.db, id, 'use postgres for production database')
    const result = await adjudicateMemory(dbm.db, id, {
      vectorsAvailable: false,
      judge: fakeJudge([]),
    })
    expect(result.status).toBe('no-candidates')
  })

  it('writes supersedes link when contradicts confidence above threshold', async () => {
    const oldId = randomUUID()
    const newId = randomUUID()
    insertMemory(dbm.db, oldId, 'use postgres for production database')
    insertMemory(dbm.db, newId, 'switch to mysql for production database')

    const verdicts: Verdict[] = [
      { candidateId: oldId, relation: 'contradicts', confidence: 0.9, reason: 'old says pg, new says mysql' },
    ]
    const result = await adjudicateMemory(dbm.db, newId, {
      vectorsAvailable: false,
      judge: fakeJudge(verdicts),
    })
    expect(result.status).toBe('ok')
    expect(result.linksWritten).toBe(1)

    const link = dbm.db
      .prepare(
        `SELECT * FROM memory_links
         WHERE source_id = ? AND target_id = ? AND link_type = 'supersedes'`
      )
      .get(newId, oldId) as Record<string, unknown> | undefined
    expect(link).toBeDefined()
    expect(link!.confidence).toBe(0.9)
    expect(link!.reason).toContain('mysql')
    expect(link!.decider_model).toBe('gpt-test')
    expect(link!.prompt_version).toBe(PROMPT_VERSION)
    expect(typeof link!.judged_at).toBe('number')
  })

  it('skips writes below SUPERSEDES_THRESHOLD', async () => {
    const oldId = randomUUID()
    const newId = randomUUID()
    insertMemory(dbm.db, oldId, 'use postgres for production database')
    insertMemory(dbm.db, newId, 'switch to mysql for production database')

    const verdicts: Verdict[] = [
      {
        candidateId: oldId,
        relation: 'contradicts',
        confidence: SUPERSEDES_THRESHOLD - 0.01,
        reason: 'low confidence',
      },
    ]
    const result = await adjudicateMemory(dbm.db, newId, {
      vectorsAvailable: false,
      judge: fakeJudge(verdicts),
    })
    expect(result.status).toBe('ok')
    expect(result.linksWritten).toBe(0)
  })

  it('skips writes for unrelated/supports relations', async () => {
    const oldId = randomUUID()
    const newId = randomUUID()
    insertMemory(dbm.db, oldId, 'use postgres for production database')
    insertMemory(dbm.db, newId, 'switch to mysql for production database')

    const verdicts: Verdict[] = [
      { candidateId: oldId, relation: 'unrelated', confidence: 0.95, reason: '' },
    ]
    const result = await adjudicateMemory(dbm.db, newId, {
      vectorsAvailable: false,
      judge: fakeJudge(verdicts),
    })
    expect(result.linksWritten).toBe(0)
  })

  it('does not write supersedes against pinned target', async () => {
    const oldId = randomUUID()
    const newId = randomUUID()
    insertMemory(dbm.db, oldId, 'use postgres for production database', { pinned: true })
    insertMemory(dbm.db, newId, 'switch to mysql for production database')

    const verdicts: Verdict[] = [
      { candidateId: oldId, relation: 'contradicts', confidence: 0.99, reason: 'override attempt' },
    ]
    const result = await adjudicateMemory(dbm.db, newId, {
      vectorsAvailable: false,
      judge: fakeJudge(verdicts),
    })
    expect(result.linksWritten).toBe(0)
  })

  it('writes for "updates" and "duplicate" relations above threshold', async () => {
    const updId = randomUUID()
    const dupId = randomUUID()
    const newId = randomUUID()
    insertMemory(dbm.db, updId, 'database connection pool size is 10')
    insertMemory(dbm.db, dupId, 'database connection pool size set to 10')
    insertMemory(dbm.db, newId, 'database connection pool size now 25')

    const verdicts: Verdict[] = [
      { candidateId: updId, relation: 'updates', confidence: 0.85, reason: 'refines' },
      { candidateId: dupId, relation: 'duplicate', confidence: 0.9, reason: 'same' },
    ]
    const result = await adjudicateMemory(dbm.db, newId, {
      vectorsAvailable: false,
      judge: fakeJudge(verdicts),
    })
    expect(result.linksWritten).toBe(2)
  })

  it('handles judge errors gracefully', async () => {
    const oldId = randomUUID()
    const newId = randomUUID()
    insertMemory(dbm.db, oldId, 'use postgres for production database')
    insertMemory(dbm.db, newId, 'switch to mysql for production database')

    const result = await adjudicateMemory(dbm.db, newId, {
      vectorsAvailable: false,
      judge: async () => {
        throw new Error('LLM exploded')
      },
    })
    expect(result.status).toBe('error')
    expect(result.error).toContain('LLM exploded')
    expect(result.linksWritten).toBe(0)
  })
})

describe('AdjudicationQueue', () => {
  it('runs handler for each enqueue', async () => {
    const calls: string[] = []
    const q = new AdjudicationQueue(async (id) => {
      calls.push(id)
    })
    await Promise.all([q.enqueue('a').promise, q.enqueue('b').promise, q.enqueue('c').promise])
    expect(calls.sort()).toEqual(['a', 'b', 'c'])
  })

  it('coalesces duplicate enqueues for the same memoryId', async () => {
    let calls = 0
    let resolveJob: (() => void) | undefined
    const q = new AdjudicationQueue(async () => {
      calls++
      await new Promise<void>((r) => {
        resolveJob = r
      })
    })
    const a = q.enqueue('same')
    const b = q.enqueue('same')
    expect(a.promise).toBe(b.promise)
    resolveJob!()
    await a.promise
    expect(calls).toBe(1)
  })

  it('respects maxConcurrency', async () => {
    let active = 0
    let maxActive = 0
    const releases: Array<() => void> = []
    const q = new AdjudicationQueue(
      async () => {
        active++
        if (active > maxActive) maxActive = active
        await new Promise<void>((r) => releases.push(r))
        active--
      },
      { maxConcurrency: 2 }
    )
    const jobs = [q.enqueue('x'), q.enqueue('y'), q.enqueue('z'), q.enqueue('w')]
    await new Promise((r) => setTimeout(r, 10))
    expect(active).toBe(2)
    for (let i = 0; i < 4; i++) {
      while (releases.length === 0) await new Promise((r) => setTimeout(r, 5))
      releases.shift()!()
    }
    await Promise.all(jobs.map((j) => j.promise))
    expect(maxActive).toBe(2)
  })

  it('catches handler errors via onError', async () => {
    const errors: Array<{ id: string; err: unknown }> = []
    const q = new AdjudicationQueue(
      async () => {
        throw new Error('boom')
      },
      { onError: (id, err) => errors.push({ id, err }) }
    )
    await q.enqueue('a').promise
    expect(errors).toHaveLength(1)
    expect(errors[0].id).toBe('a')
  })

  it('drain waits for in-flight jobs', async () => {
    const order: string[] = []
    let release: (() => void) | undefined
    const q = new AdjudicationQueue(async (id) => {
      order.push(`start:${id}`)
      await new Promise<void>((r) => {
        release = r
      })
      order.push(`end:${id}`)
    })
    q.enqueue('a')
    await new Promise((r) => setTimeout(r, 5))
    const drainPromise = q.drain()
    release!()
    await drainPromise
    expect(order).toEqual(['start:a', 'end:a'])
  })
})

describe('withTimeout', () => {
  it('resolves with value when promise completes in time', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000)
    expect(result).toBe(42)
  })

  it('resolves null when promise exceeds timeout', async () => {
    const slow = new Promise<number>((r) => setTimeout(() => r(7), 200))
    const result = await withTimeout(slow, 20)
    expect(result).toBeNull()
  })

  it('propagates rejections', async () => {
    await expect(withTimeout(Promise.reject(new Error('fail')), 100)).rejects.toThrow('fail')
  })
})
