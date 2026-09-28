import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'

const mockState = vi.hoisted(() => ({
  logits: [] as number[],
  tokenizerDocs: [] as string[][],
  embedFails: false,
}))

vi.mock('@huggingface/transformers', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const AutoTokenizer = {
    from_pretrained: vi.fn(async () => (queries: string[], opts: { text_pair?: string[] }) => {
      mockState.tokenizerDocs.push(opts.text_pair ? [...opts.text_pair] : [])
      return { input_ids: queries, attention_mask: queries }
    }),
  }
  const AutoModelForSequenceClassification = {
    from_pretrained: vi.fn(async () => async (_inputs: unknown) => ({
      logits: { data: new Float32Array(mockState.logits), dims: [mockState.logits.length, 1] },
    })),
  }
  return { ...actual, AutoTokenizer, AutoModelForSequenceClassification }
})

vi.mock('../src/embeddings/pipeline.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getEmbedding: vi.fn(async () => {
      if (mockState.embedFails) return null
      const v = new Float32Array(768)
      v[0] = 1
      return v
    }),
  }
})

import { createTestDb } from './helpers.js'
import { MemorySearch } from '../src/memory/search.js'
import { resetRerankerForTests } from '../src/embeddings/reranker.js'
import {
  bm25Relevance,
  distanceRelevance,
  normalizeRerankScore,
  rerankBlendAlpha,
  resolveAccessSignalMode,
  DEFAULT_ACCESS_SIGNAL,
  DEFAULT_RERANK_BLEND_ALPHA,
} from '../src/memory/search/scoring.js'
import {
  setKnnRowidFilterSupportForTests,
  type SearchDiagnostics,
} from '../src/memory/search/hybrid.js'

const NS = '/proj/pr2'
const SESSION = 'pr2-session'

function seedMemories(
  db: Database.Database,
  contents: string[],
  opts: { importance?: number; importances?: number[] } = {}
): string[] {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    SESSION,
    NS,
    Date.now()
  )
  const stmt = db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags,
       created_at, valid_from, access_count)
     VALUES (?, ?, ?, ?, ?, 'note', ?, '[]', ?, ?, 0)`
  )
  return contents.map((content, i) => {
    const id = `m${String(i).padStart(3, '0')}`
    const now = Date.now()
    stmt.run(id, SESSION, NS, NS, content, opts.importances?.[i] ?? opts.importance ?? 0.5, now, now)
    return id
  })
}

function accessCount(db: Database.Database, id: string): number {
  return (db.prepare('SELECT access_count AS n FROM memories WHERE id = ?').get(id) as { n: number }).n
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

// independent restatement of the documented affine normaliser
function expectedNorm(logit: number): number {
  const n = 0.5 + (sigmoid(logit) - 0.5) * 2
  return n < 0 ? 0 : n > 1 ? 1 : n
}

describe('reranker blend', () => {
  let db: Database.Database

  beforeEach(() => {
    process.env.ENGRAM_RERANKER_ENABLED = '1'
    delete process.env.ENGRAM_RERANK_BLEND_ALPHA
    mockState.logits = []
    mockState.tokenizerDocs = []
    resetRerankerForTests()
    db = createTestDb().db
  })

  afterEach(() => {
    delete process.env.ENGRAM_RERANKER_ENABLED
    resetRerankerForTests()
  })

  it('normalizeRerankScore is an affine map around the sigmoid midpoint, clamped to [0,1]', () => {
    expect(normalizeRerankScore(0.5)).toBeCloseTo(0.5, 10)
    expect(normalizeRerankScore(0.75)).toBeCloseTo(1, 10)
    expect(normalizeRerankScore(0.25)).toBeCloseTo(0, 10)
    expect(normalizeRerankScore(0.99)).toBe(1)
    expect(normalizeRerankScore(0.01)).toBe(0)
    expect(normalizeRerankScore(Number.NaN)).toBe(0.5)
  })

  it('scores as alpha*norm(rerank) + (1-alpha)*fused across the whole candidate set', async () => {
    seedMemories(
      db,
      [
        'kafka tuning notes for production brokers',
        'kafka tuning log for consumer lag',
        'kafka tuning config reference sheet',
        'kafka tuning checklist for staging',
      ],
      { importances: [0.9, 0.6, 0.3, 0.1] }
    )
    const search = new MemorySearch(db, false)

    // fixed clock: the recency term would otherwise differ between the two runs
    const now = 1_700_000_000_000
    const fused = await search.hybridSearch('kafka tuning', { project_path: NS, touch: false, now })
    expect(fused).toHaveLength(4)
    const fusedScore = new Map(fused.map((r) => [r.id, r.score]))

    mockState.logits = [4, -4, 0, 2]
    const breakdown = new Map<string, Record<string, number>>()
    const alpha = DEFAULT_RERANK_BLEND_ALPHA
    const blended = await search.hybridSearch(
      'kafka tuning',
      { project_path: NS, touch: false, use_reranker: true, now },
      breakdown as never
    )

    expect(blended).toHaveLength(fused.length)
    for (const r of blended) {
      const rank = fused.findIndex((f) => f.id === r.id)
      const norm = expectedNorm(mockState.logits[rank])
      const expected = alpha * norm + (1 - alpha) * fusedScore.get(r.id)!
      expect(r.score).toBeCloseTo(expected, 9)
      expect(breakdown.get(r.id)!.reranker).toBeCloseTo(alpha * norm, 9)
      expect(r.score).not.toBeCloseTo(sigmoid(mockState.logits[rank]), 6)
    }
  })

  it('reranks the whole over-fetch candidate set, not a 20-item window', async () => {
    seedMemories(
      db,
      Array.from({ length: 30 }, (_, i) => `kafka tuning note number ${i} about brokers`)
    )
    const search = new MemorySearch(db, false)
    mockState.logits = new Array(30).fill(0)
    const breakdown = new Map<string, Record<string, number>>()
    const results = await search.hybridSearch(
      'kafka tuning',
      { project_path: NS, touch: false, use_reranker: true, limit: 30 },
      breakdown as never
    )

    expect(results).toHaveLength(30)
    expect(mockState.tokenizerDocs[0]).toHaveLength(30)
    // every candidate carries a contribution, including the unwindowed tail
    for (const r of results) {
      expect(breakdown.get(r.id)!.reranker).toBeCloseTo(0.25, 9)
    }
  })

  it('keeps an explicitly narrowed window comparable by giving the tail the neutral value', async () => {
    seedMemories(
      db,
      Array.from({ length: 6 }, (_, i) => `kafka tuning note number ${i} about brokers`),
      { importances: [0.9, 0.8, 0.7, 0.6, 0.5, 0.4] }
    )
    const search = new MemorySearch(db, false)
    const now = 1_700_000_000_000
    const fused = await search.hybridSearch('kafka tuning', { project_path: NS, touch: false, now })
    mockState.logits = [-8, 8]
    const breakdown = new Map<string, Record<string, number>>()
    const results = await search.hybridSearch(
      'kafka tuning',
      { project_path: NS, touch: false, use_reranker: true, rerank_top_n: 2, now },
      breakdown as never
    )

    expect(mockState.tokenizerDocs[0]).toHaveLength(2)
    const fusedScore = new Map(fused.map((r) => [r.id, r.score]))
    for (const r of results) {
      const inWindow = r.id === fused[0].id || r.id === fused[1].id
      const norm = inWindow ? expectedNorm(r.id === fused[0].id ? -8 : 8) : 0.5
      expect(r.score).toBeCloseTo(0.5 * norm + 0.5 * fusedScore.get(r.id)!, 9)
      expect(breakdown.get(r.id)!.reranker).toBeCloseTo(0.5 * norm, 9)
    }
  })

  it('alpha comes from ENGRAM_RERANK_BLEND_ALPHA and is clamped', () => {
    expect(rerankBlendAlpha({})).toBe(DEFAULT_RERANK_BLEND_ALPHA)
    expect(rerankBlendAlpha({ ENGRAM_RERANK_BLEND_ALPHA: '0.25' })).toBeCloseTo(0.25, 10)
    expect(rerankBlendAlpha({ ENGRAM_RERANK_BLEND_ALPHA: 'not-a-number' })).toBe(
      DEFAULT_RERANK_BLEND_ALPHA
    )
    expect(rerankBlendAlpha({ ENGRAM_RERANK_BLEND_ALPHA: '5' })).toBe(1)
    expect(rerankBlendAlpha({ ENGRAM_RERANK_BLEND_ALPHA: '-2' })).toBe(0)
  })

  it('alpha=0 ignores the reranker entirely; alpha=1 reproduces reranker order', async () => {
    seedMemories(
      db,
      [
        'kafka tuning notes for production brokers',
        'kafka tuning log for consumer lag',
        'kafka tuning config reference sheet',
      ],
      { importances: [0.9, 0.5, 0.1] }
    )
    const search = new MemorySearch(db, false)
    const now = 1_700_000_000_000
    const fused = await search.hybridSearch('kafka tuning', { project_path: NS, touch: false, now })

    mockState.logits = [-8, 8, -8]
    const noRerank = await search.hybridSearch('kafka tuning', {
      project_path: NS,
      touch: false,
      use_reranker: true,
      rerank_blend_alpha: 0,
      now,
    })
    expect(noRerank.map((r) => r.id)).toEqual(fused.map((r) => r.id))

    const fullRerank = await search.hybridSearch('kafka tuning', {
      project_path: NS,
      touch: false,
      use_reranker: true,
      rerank_blend_alpha: 1,
      now,
    })
    expect(fullRerank[0].id).toBe(fused[1].id)
  })
})

describe('absolute relevance and min_score', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb().db
  })

  it('maps bm25 and vector distance to absolute, corpus-independent values', () => {
    expect(bm25Relevance(-1, 1)).toBeCloseTo(0.5, 10)
    expect(bm25Relevance(-4, 4)).toBeCloseTo(0.5, 10)
    expect(bm25Relevance(0, 1)).toBe(0)
    expect(bm25Relevance(Number.NaN, 1)).toBe(0)
    expect(bm25Relevance(-8, 4)).toBeGreaterThan(bm25Relevance(-2, 4))
    expect(distanceRelevance(0)).toBeCloseTo(1, 10)
    expect(distanceRelevance(Math.sqrt(2))).toBeCloseTo(0, 10)
    expect(distanceRelevance(3)).toBe(0)
    expect(distanceRelevance(Number.NaN)).toBe(0)
  })

  // one matching memory each, so a strong and a weak match compare on the same
  // absolute scale: the weak one is a single rare term in a very long memory
  const STRONG_QUERY = 'zkafka zconsumer zlag zestimate zbudget'
  const WEAK_QUERY = 'zquartz zeta ztheta ziota zkappa'
  async function seedStrongAndWeak(): Promise<{ strong: string; weak: string }> {
    const filler = Array.from(
      { length: 18 },
      (_, i) => `unrelated reference document number ${i} about deploys`
    )
    const [strong, weak] = seedMemories(db, [
      'zkafka zconsumer zlag zestimate zbudget computation formula',
      `zquartz ${'padding '.repeat(120)}`,
      ...filler,
    ])
    return { strong, weak }
  }

  it('a weak partial match scores below a strong match instead of tying at the set maximum', async () => {
    const { strong, weak } = await seedStrongAndWeak()
    const search = new MemorySearch(db, false)
    const strongResults = await search.hybridSearch(STRONG_QUERY, {
      project_path: NS,
      touch: false,
      limit: 20,
    })
    const weakResults = await search.hybridSearch(WEAK_QUERY, {
      project_path: NS,
      touch: false,
      limit: 20,
    })
    const strongHit = strongResults.find((r) => r.id === strong)!
    const weakHit = weakResults.find((r) => r.id === weak)!
    expect(strongHit).toBeDefined()
    expect(weakHit).toBeDefined()

    expect(strongHit.relevance!).toBeGreaterThan(0.6)
    expect(weakHit.relevance!).toBeLessThan(0.5)
    expect(strongHit.relevance!).toBeGreaterThan(1.5 * weakHit.relevance!)
    expect(strongHit.score - weakHit.score).toBeGreaterThan(0.1)
  })

  it('min_score applies an absolute floor the old normaliser could not express', async () => {
    const { strong, weak } = await seedStrongAndWeak()
    const search = new MemorySearch(db, false)
    const unfiltered = await search.hybridSearch(WEAK_QUERY, {
      project_path: NS,
      touch: false,
      limit: 20,
    })
    expect(unfiltered.map((r) => r.id)).toContain(weak)

    const weakScore = unfiltered.find((r) => r.id === weak)!.score
    const floored = await search.hybridSearch(WEAK_QUERY, {
      project_path: NS,
      touch: false,
      limit: 20,
      min_score: weakScore + 0.01,
    })
    expect(floored).toEqual([])

    const stillThere = await search.hybridSearch(STRONG_QUERY, {
      project_path: NS,
      touch: false,
      limit: 20,
      min_score: weakScore + 0.01,
    })
    expect(stillThere.map((r) => r.id)).toContain(strong)
    expect(stillThere.every((r) => r.score >= weakScore + 0.01)).toBe(true)
  })

  it('falls back to term coverage when the corpus is inside SQLite\u2019s idf-clamped regime', async () => {
    // two documents: FTS5 clamps idf to 1e-6 for both, so coverage has to tell
    // a 3-of-3 match from a 1-of-3 one
    const [full, partial] = seedMemories(db, [
      'alpha beta gamma',
      'alpha only',
    ])
    const search = new MemorySearch(db, false)
    const results = await search.hybridSearch('alpha beta gamma', {
      project_path: NS,
      touch: false,
      limit: 10,
    })
    const byId = new Map(results.map((r) => [r.id, r]))
    expect(byId.get(full)!.relevance!).toBeCloseTo(1, 6)
    expect(byId.get(partial)!.relevance!).toBeCloseTo(1 / 3, 6)
    expect(results[0].id).toBe(full)
  })
})

describe('access signal policy', () => {
  let db: Database.Database
  let ids: string[]

  beforeEach(() => {
    delete process.env.ENGRAM_ACCESS_SIGNAL
    db = createTestDb().db
    ids = seedMemories(db, ['redis caching notes for the session store'])
  })

  afterEach(() => {
    delete process.env.ENGRAM_ACCESS_SIGNAL
  })

  it('defaults to explicit, which does not stamp a retrieval', async () => {
    expect(resolveAccessSignalMode({})).toBe(DEFAULT_ACCESS_SIGNAL)
    expect(DEFAULT_ACCESS_SIGNAL).toBe('explicit')
    expect(resolveAccessSignalMode({ ENGRAM_ACCESS_SIGNAL: 'nonsense' })).toBe('explicit')

    const search = new MemorySearch(db, false)
    // touch unset: the policy decides
    await search.hybridSearch('redis caching', { project_path: NS, now: 1000 })
    expect(accessCount(db, ids[0])).toBe(0)
  })

  it('ENGRAM_ACCESS_SIGNAL=retrieval restores stamp-on-retrieval', async () => {
    process.env.ENGRAM_ACCESS_SIGNAL = 'retrieval'
    const search = new MemorySearch(db, false)
    await search.hybridSearch('redis caching', { project_path: NS, now: 1000 })
    expect(accessCount(db, ids[0])).toBe(1)
  })

  it('ENGRAM_ACCESS_SIGNAL=off never stamps, even with touch:true', async () => {
    process.env.ENGRAM_ACCESS_SIGNAL = 'off'
    const search = new MemorySearch(db, false)
    await search.hybridSearch('redis caching', { project_path: NS, now: 1000, touch: true })
    expect(accessCount(db, ids[0])).toBe(0)
  })

  it('an explicit touch still wins in both directions', async () => {
    process.env.ENGRAM_ACCESS_SIGNAL = 'explicit'
    const search = new MemorySearch(db, false)
    await search.hybridSearch('redis caching', { project_path: NS, now: 1000, touch: true })
    expect(accessCount(db, ids[0])).toBe(1)
    await search.hybridSearch('redis caching', { project_path: NS, now: 2000, touch: false })
    expect(accessCount(db, ids[0])).toBe(1)
  })
})

describe('degraded branch marker', () => {
  let db: Database.Database

  beforeEach(() => {
    mockState.embedFails = false
    setKnnRowidFilterSupportForTests(null)
    db = createTestDb().db
    const [id] = seedMemories(db, ['redis caching notes for the session store'])
    // a real vector row, so a failure here is genuinely the branch's
    const v = new Float32Array(768)
    v[0] = 1
    const rowid = db.prepare('INSERT INTO memory_vectors(embedding) VALUES (?)').run(Buffer.from(v.buffer))
      .lastInsertRowid
    db.prepare('UPDATE memories SET vec_rowid = ? WHERE id = ?').run(rowid, id)
  })

  afterEach(() => {
    mockState.embedFails = false
    setKnnRowidFilterSupportForTests(null)
    delete process.env.ENGRAM_RERANKER_ENABLED
  })

  it('reports an embedding outage instead of looking like an empty index', async () => {
    mockState.embedFails = true
    const search = new MemorySearch(db, true)
    const diagnostics: SearchDiagnostics = { degraded: [] }
    const results = await search.hybridSearch('redis caching', {
      project_path: NS,
      touch: false,
      diagnostics,
    })
    expect(diagnostics.degraded).toContain('embedding')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.degraded === true)).toBe(true)
  })

  it('reports a failing semantic branch', async () => {
    db.exec('DROP TABLE memory_vectors')
    const search = new MemorySearch(db, true)
    const diagnostics: SearchDiagnostics = { degraded: [] }
    const results = await search.hybridSearch('redis caching', {
      project_path: NS,
      touch: false,
      diagnostics,
    })
    expect(diagnostics.degraded).toContain('vector')
    expect(results.every((r) => r.degraded === true)).toBe(true)
  })

  it('reports a failing lexical branch (empty result set stays explainable)', async () => {
    db.exec('DROP TABLE memories_fts')
    const search = new MemorySearch(db, false)
    const diagnostics: SearchDiagnostics = { degraded: [] }
    const results = await search.hybridSearch('redis caching', {
      project_path: NS,
      touch: false,
      diagnostics,
    })
    expect(results).toEqual([])
    expect(diagnostics.degraded).toContain('fts')
  })

  it('reports a reranker that was requested but did not contribute', async () => {
    delete process.env.ENGRAM_RERANKER_ENABLED
    resetRerankerForTests()
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags,
         created_at, valid_from, access_count)
       VALUES ('extra', ?, ?, ?, 'redis caching second note', 'note', 0.5, '[]', ?, ?, 0)`
    ).run(SESSION, NS, NS, Date.now(), Date.now())
    const search = new MemorySearch(db, false)
    const diagnostics: SearchDiagnostics = { degraded: [] }
    const results = await search.hybridSearch('redis caching', {
      project_path: NS,
      touch: false,
      use_reranker: true,
      diagnostics,
    })
    expect(diagnostics.degraded).toContain('reranker')
    expect(results.every((r) => r.degraded === true)).toBe(true)
  })

  it('leaves degraded unset on a healthy search', async () => {
    const search = new MemorySearch(db, true)
    const diagnostics: SearchDiagnostics = { degraded: [] }
    const results = await search.hybridSearch('redis caching', {
      project_path: NS,
      touch: false,
      diagnostics,
    })
    expect(diagnostics.degraded).toEqual([])
    expect(results.some((r) => r.degraded === true)).toBe(false)
  })
})
