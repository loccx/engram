import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

const mockState = vi.hoisted(() => {
  return {
    tokenizerThrows: false as boolean,
    modelThrows: false as boolean,
    inferenceThrows: false as boolean,
    logits: [] as number[],
    tokenizerCalls: [] as Array<{ queries: string[]; docs: string[] }>,
    modelLoadCalls: 0,
  }
})

vi.mock('@huggingface/transformers', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const AutoTokenizer = {
    from_pretrained: vi.fn(async () => {
      if (mockState.tokenizerThrows) throw new Error('tokenizer load failed')
      const tokenizerFn = (queries: string[], opts: { text_pair?: string[] }) => {
        mockState.tokenizerCalls.push({
          queries: [...queries],
          docs: opts.text_pair ? [...opts.text_pair] : [],
        })
        return { input_ids: queries, attention_mask: queries }
      }
      return tokenizerFn
    }),
  }
  const AutoModelForSequenceClassification = {
    from_pretrained: vi.fn(async () => {
      mockState.modelLoadCalls += 1
      if (mockState.modelThrows) throw new Error('model load failed')
      const modelFn = async (_inputs: unknown) => {
        if (mockState.inferenceThrows) throw new Error('inference failed')
        const data = new Float32Array(mockState.logits)
        return { logits: { data, dims: [mockState.logits.length, 1] } }
      }
      return modelFn
    }),
  }
  return { ...actual, AutoTokenizer, AutoModelForSequenceClassification }
})

import {
  rerank,
  warmReranker,
  isRerankerEnabled,
  resetRerankerForTests,
} from '../src/embeddings/reranker.js'

function setEnabled(on: boolean) {
  if (on) process.env.ENGRAM_RERANKER_ENABLED = '1'
  else delete process.env.ENGRAM_RERANKER_ENABLED
}

function resetMockState() {
  mockState.tokenizerThrows = false
  mockState.modelThrows = false
  mockState.inferenceThrows = false
  mockState.logits = []
  mockState.tokenizerCalls = []
  mockState.modelLoadCalls = 0
}

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
  opts: { content?: string; namespace?: string; importance?: number } = {}
): void {
  const ns = opts.namespace ?? '/proj'
  ensureSession(db, 'sess1', ns)
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags,
        created_at, last_accessed, access_count, pinned)
     VALUES (?, ?, ?, ?, ?, 'note', ?, '[]', ?, NULL, 0, 0)`
  ).run(id, 'sess1', ns, ns, opts.content ?? 'content', opts.importance ?? 0.5, Date.now())
}

describe('reranker module', () => {
  beforeEach(() => {
    setEnabled(false)
    resetMockState()
    resetRerankerForTests()
  })

  afterEach(() => {
    setEnabled(false)
    resetRerankerForTests()
  })

  describe('isRerankerEnabled', () => {
    it('returns false when env var is unset', () => {
      expect(isRerankerEnabled()).toBe(false)
    })

    it('returns false for values other than "1"', () => {
      process.env.ENGRAM_RERANKER_ENABLED = 'true'
      expect(isRerankerEnabled()).toBe(false)
      process.env.ENGRAM_RERANKER_ENABLED = '0'
      expect(isRerankerEnabled()).toBe(false)
    })

    it('returns true when env var is "1" (whitespace tolerated)', () => {
      process.env.ENGRAM_RERANKER_ENABLED = '1'
      expect(isRerankerEnabled()).toBe(true)
      process.env.ENGRAM_RERANKER_ENABLED = ' 1 '
      expect(isRerankerEnabled()).toBe(true)
    })
  })

  describe('rerank', () => {
    it('returns null without loading the model when disabled', async () => {
      const result = await rerank('query', ['doc a', 'doc b'])
      expect(result).toBeNull()
      expect(mockState.modelLoadCalls).toBe(0)
    })

    it('returns [] for empty docs without loading the model', async () => {
      setEnabled(true)
      const result = await rerank('query', [])
      expect(result).toEqual([])
      expect(mockState.modelLoadCalls).toBe(0)
    })

    it('reorders docs by descending score and preserves original index', async () => {
      setEnabled(true)
      // sigmoid is strictly monotonic in its input, so testing logit order is
      // equivalent to testing score order without floating-point arithmetic.
      mockState.logits = [-2, 5, 1]
      const result = await rerank('q', ['doc-zero', 'doc-one', 'doc-two'])
      expect(result).not.toBeNull()
      expect(result!).toHaveLength(3)
      expect(result!.map((r) => r.index)).toEqual([1, 2, 0])
      for (let i = 0; i < result!.length - 1; i++) {
        expect(result![i].score).toBeGreaterThanOrEqual(result![i + 1].score)
      }
      expect(result!.every((r) => r.score > 0 && r.score < 1)).toBe(true)
    })

    it('batches all pairs in a single tokenizer call', async () => {
      setEnabled(true)
      mockState.logits = [0.1, 0.2, 0.3, 0.4]
      await rerank('q', ['a', 'b', 'c', 'd'])
      expect(mockState.tokenizerCalls).toHaveLength(1)
      expect(mockState.tokenizerCalls[0].docs).toEqual(['a', 'b', 'c', 'd'])
      expect(mockState.tokenizerCalls[0].queries).toEqual(['q', 'q', 'q', 'q'])
    })

    it('returns null and remembers failure when model load throws', async () => {
      setEnabled(true)
      mockState.modelThrows = true
      const first = await rerank('q', ['a'])
      expect(first).toBeNull()
      const second = await rerank('q', ['a'])
      expect(second).toBeNull()
      expect(mockState.modelLoadCalls).toBe(1)
    })

    it('returns null when inference throws but recovers on later success', async () => {
      setEnabled(true)
      mockState.inferenceThrows = true
      const failed = await rerank('q', ['a', 'b'])
      expect(failed).toBeNull()
      mockState.inferenceThrows = false
      mockState.logits = [0.5, 1.0]
      const ok = await rerank('q', ['a', 'b'])
      expect(ok).not.toBeNull()
      expect(ok!.map((r) => r.index)).toEqual([1, 0])
    })

    it('coalesces concurrent loads into a single model fetch', async () => {
      setEnabled(true)
      mockState.logits = [0.1, 0.2]
      await Promise.all([rerank('q', ['a', 'b']), rerank('q', ['a', 'b'])])
      expect(mockState.modelLoadCalls).toBe(1)
    })
  })

  describe('warmReranker', () => {
    it('returns false when disabled (does not load model)', async () => {
      const ok = await warmReranker()
      expect(ok).toBe(false)
      expect(mockState.modelLoadCalls).toBe(0)
    })

    it('returns true when load succeeds', async () => {
      setEnabled(true)
      const ok = await warmReranker()
      expect(ok).toBe(true)
    })

    it('returns false when load fails', async () => {
      setEnabled(true)
      mockState.modelThrows = true
      const ok = await warmReranker()
      expect(ok).toBe(false)
    })
  })
})

describe('hybridSearch + reranker integration', () => {
  beforeEach(() => {
    setEnabled(false)
    resetMockState()
    resetRerankerForTests()
  })

  afterEach(() => {
    setEnabled(false)
    resetRerankerForTests()
  })

  it('reorders by reranker score and populates signal_breakdown.reranker', async () => {
    const { createTestDb } = await import('./helpers.js')
    const { MemorySearch } = await import('../src/memory/search.js')
    const enrichmentMod = await import('../src/memory/enrichment.js')
    type RecallSignal = Parameters<typeof enrichmentMod.enrichSearchResults>[2] extends
      | Map<string, Record<infer K, number>>
      | undefined
      ? K
      : never

    const dbm = createTestDb()
    const search = new MemorySearch(dbm.db, false)

    insertMemory(dbm.db, randomUUID(), { content: 'kafka tuning notes for production', importance: 0.9 })
    insertMemory(dbm.db, randomUUID(), { content: 'kafka consumer lag investigation', importance: 0.5 })
    insertMemory(dbm.db, randomUUID(), { content: 'kafka broker config reference', importance: 0.3 })

    const breakdownBefore = new Map<string, Record<RecallSignal, number>>()
    const before = await search.hybridSearch(
      'kafka tuning',
      { project_path: '/proj' },
      breakdownBefore
    )
    expect(before.length).toBeGreaterThan(0)
    const beforeOrder = before.map((r) => r.id)

    // Logits are supplied in window-order, which equals the post-hybrid sort.
    // Push the last hybrid result to the top by giving it the highest logit.
    setEnabled(true)
    const windowSize = beforeOrder.length
    const logits = new Array(windowSize).fill(-5)
    logits[windowSize - 1] = 5
    mockState.logits = logits

    const breakdownAfter = new Map<string, Record<RecallSignal, number>>()
    const after = await search.hybridSearch(
      'kafka tuning',
      { project_path: '/proj', use_reranker: true },
      breakdownAfter
    )
    expect(after[0].id).toBe(beforeOrder[beforeOrder.length - 1])

    for (const r of after) {
      const entry = breakdownAfter.get(r.id)
      expect(entry).toBeDefined()
      expect(typeof entry!.reranker).toBe('number')
    }
  })

  it('skips rerank stage when use_reranker is false (no model load)', async () => {
    setEnabled(true)
    const { createTestDb } = await import('./helpers.js')
    const { MemorySearch } = await import('../src/memory/search.js')

    const dbm = createTestDb()
    const search = new MemorySearch(dbm.db, false)

    insertMemory(dbm.db, randomUUID(), { content: 'kafka tuning notes', importance: 0.9 })
    insertMemory(dbm.db, randomUUID(), { content: 'kafka broker config', importance: 0.3 })

    const breakdown = new Map<string, Record<string, number>>()
    const results = await search.hybridSearch(
      'kafka',
      { project_path: '/proj' },
      breakdown as never
    )
    expect(results.length).toBeGreaterThan(0)
    expect(mockState.modelLoadCalls).toBe(0)
    for (const r of results) {
      const entry = breakdown.get(r.id)
      expect(entry?.reranker ?? 0).toBe(0)
    }
  })

  it('falls back to hybrid order when reranker model fails to load', async () => {
    setEnabled(true)
    mockState.modelThrows = true
    const { createTestDb } = await import('./helpers.js')
    const { MemorySearch } = await import('../src/memory/search.js')

    const dbm = createTestDb()
    const search = new MemorySearch(dbm.db, false)

    insertMemory(dbm.db, randomUUID(), { content: 'kafka tuning notes', importance: 0.9 })
    insertMemory(dbm.db, randomUUID(), { content: 'kafka broker config', importance: 0.3 })

    const breakdownNoRerank = new Map<string, Record<string, number>>()
    const baseline = await search.hybridSearch(
      'kafka',
      { project_path: '/proj' },
      breakdownNoRerank as never
    )

    const breakdown = new Map<string, Record<string, number>>()
    const results = await search.hybridSearch(
      'kafka',
      { project_path: '/proj', use_reranker: true },
      breakdown as never
    )
    expect(results.map((r) => r.id)).toEqual(baseline.map((r) => r.id))
    for (const r of results) {
      const entry = breakdown.get(r.id)
      expect(entry?.reranker ?? 0).toBe(0)
    }
  })
})
