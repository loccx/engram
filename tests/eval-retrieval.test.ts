import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { EMBEDDING_DIM } from '../src/embeddings/pipeline.js'

const mockState = vi.hoisted(() => ({
  queryVectors: new Map<string, Float32Array>(),
  logits: [] as number[],
}))

vi.mock('../src/embeddings/pipeline.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getEmbedding: vi.fn(async (text: string) => mockState.queryVectors.get(text.trim()) ?? null),
  }
})

vi.mock('@huggingface/transformers', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const AutoTokenizer = {
    from_pretrained: vi.fn(async () => (queries: string[], opts: { text_pair?: string[] }) => ({
      input_ids: queries,
      attention_mask: queries,
      docs: opts.text_pair,
    })),
  }
  const AutoModelForSequenceClassification = {
    from_pretrained: vi.fn(async () => async (_inputs: unknown) => ({
      logits: { data: new Float32Array(mockState.logits), dims: [mockState.logits.length, 1] },
    })),
  }
  return { ...actual, AutoTokenizer, AutoModelForSequenceClassification }
})

import { createTestDb } from './helpers.js'
import { MemorySearch } from '../src/memory/search.js'
import { resetRerankerForTests } from '../src/embeddings/reranker.js'
import { WEIGHT_PROFILES, classifyQuery, bm25Relevance } from '../src/memory/search/scoring.js'

// mirrors of the frozen eval metrics (EVAL-CONTRACT.md), over plain id arrays

function recallAtK(results: string[], targets: string[], k: number): number {
  if (targets.length === 0) return 0
  const top = new Set(results.slice(0, k))
  return targets.filter((t) => top.has(t)).length / targets.length
}

function precisionAtK(results: string[], targets: string[], k: number): number {
  const top = results.slice(0, k)
  if (top.length === 0) return 0
  const target = new Set(targets)
  return top.filter((id) => target.has(id)).length / top.length
}

function mrr(results: string[], targets: string[]): number {
  const target = new Set(targets)
  const rank = results.findIndex((id) => target.has(id))
  return rank < 0 ? 0 : 1 / (rank + 1)
}

function leakRate(namespaces: string[], queryNamespace: string): number {
  if (namespaces.length === 0) return 0
  return namespaces.filter((ns) => ns !== queryNamespace).length / namespaces.length
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function angleVector(theta: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM)
  v[0] = Math.cos(theta)
  v[1] = Math.sin(theta)
  return v
}

function report(lines: Array<[string, string | number, string | number]>): void {
  const pad = (s: string | number, n: number) => String(s).padEnd(n)
  console.log('\n| measurement | before | after |')
  console.log('| --- | --- | --- |')
  for (const [name, before, after] of lines) console.log(`| ${pad(name, 46)} | ${pad(before, 12)} | ${after} |`)
}

const SEED = 1234

function sessionFor(db: Database.Database, id: string, ns: string): void {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    id,
    ns,
    Date.now()
  )
}

function insertMemory(
  db: Database.Database,
  id: string,
  ns: string,
  content: string,
  opts: { importance?: number; theta?: number } = {}
): void {
  sessionFor(db, 'eval-session', ns)
  const now = Date.now()
  db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags,
       created_at, valid_from, access_count)
     VALUES (?, 'eval-session', ?, ?, ?, 'note', ?, '[]', ?, ?, 0)`
  ).run(id, ns, ns, content, opts.importance ?? 0.5, now, now)
  if (opts.theta !== undefined) {
    const vec = angleVector(opts.theta)
    const rowid = db.prepare('INSERT INTO memory_vectors(embedding) VALUES (?)').run(Buffer.from(vec.buffer))
      .lastInsertRowid
    db.prepare('UPDATE memories SET vec_rowid = ? WHERE id = ?').run(rowid, id)
  }
}

describe('eval: knn-scoped (semantic recall under a namespace scope)', () => {
  let db: Database.Database
  const SCOPE = '/eval/scope'
  const OTHER = '/eval/other'
  const QUERY = 'semantic probe of the deploy pipeline'
  let target: string

  beforeEach(() => {
    mockState.queryVectors.clear()
    db = createTestDb().db
    // every out-of-scope vector is nearer the query than any in-scope one, so a
    // global top-50 holds no in-scope row at all
    const rand = lcg(SEED)
    for (let i = 0; i < 70; i++) {
      insertMemory(db, `other-${i}`, OTHER, `unrelated deploy note ${i}`, {
        theta: 0.01 + rand() * 0.38,
      })
    }
    target = 'scope-target'
    insertMemory(db, target, SCOPE, 'the scoped deploy note that answers the query', { theta: 0.4 })
    for (let i = 0; i < 69; i++) {
      insertMemory(db, `scope-${i}`, SCOPE, `scoped deploy note ${i}`, { theta: 0.41 + rand() * 2.5 })
    }
    mockState.queryVectors.set(QUERY, angleVector(0))
  })

  it('a scoped semantic query returns its target; the pre-fix SQL form returns nothing', async () => {
    // before arm: global top-k, then filter on the joined row
    const preFix = db
      .prepare(
        `SELECT m.id FROM
           (SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? LIMIT ?) knn
         JOIN memories m ON m.vec_rowid = knn.rowid
         WHERE COALESCE(m.namespace, m.project_path) = ?
         ORDER BY knn.distance`
      )
      .all(Buffer.from(angleVector(0).buffer), 50, SCOPE) as Array<{ id: string }>

    const search = new MemorySearch(db, true)
    const after = await search.hybridSearch(QUERY, { project_path: SCOPE, limit: 10, touch: false })

    const beforeIds = preFix.map((r) => r.id)
    const afterIds = after.map((r) => r.id)

    expect(beforeIds).toHaveLength(0)
    expect(afterIds[0]).toBe(target)
    expect(leakRate(after.map((r) => r.namespace ?? ''), SCOPE)).toBe(0)
    expect(recallAtK(afterIds, [target], 10)).toBe(1)
    expect(recallAtK(beforeIds, [target], 10)).toBe(0)
    report([
      ['knn-scoped: recall@10 (scoped semantic query)', 0, 1],
      ['knn-scoped: results returned', 0, afterIds.length],
      ['knn-scoped: leak rate', 'n/a (empty)', leakRate(after.map((r) => r.namespace ?? ''), SCOPE)],
    ])
  })
})

describe('eval: absolute-floor + access-explicit + expand-multi-query (lexical)', () => {
  let db: Database.Database
  const NS = '/eval/lexical'

  beforeEach(() => {
    mockState.queryVectors.clear()
    db = createTestDb().db
  })

  function seedLexicalCorpus(): { strong: string; weak: string } {
    const filler = Array.from({ length: 18 }, (_, i) => `unrelated reference note number ${i}`)
    sessionFor(db, 'eval-session', NS)
    const now = Date.now()
    const stmt = db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags,
         created_at, valid_from, access_count)
       VALUES (?, 'eval-session', ?, ?, ?, 'note', ?, '[]', ?, ?, 0)`
    )
    stmt.run('strong', NS, NS, 'zkafka zconsumer zlag zestimate zbudget formula', 0.5, now, now)
    stmt.run('weak', NS, NS, `zquartz ${'padding '.repeat(120)}`, 0.5, now, now)
    filler.forEach((content, i) => stmt.run(`filler-${i}`, NS, NS, content, 0.5, now, now))
    return { strong: 'strong', weak: 'weak' }
  }

  it('absolute relevance separates a weak match from a strong one, and min_score acts as a floor', async () => {
    const { strong, weak } = seedLexicalCorpus()
    const search = new MemorySearch(db, false)
    const STRONG_QUERY = 'zkafka zconsumer zlag zestimate zbudget'
    const WEAK_QUERY = 'zquartz zeta ztheta ziota zkappa'

    const strongHit = (
      await search.hybridSearch(STRONG_QUERY, { project_path: NS, touch: false, limit: 20 })
    ).find((r) => r.id === strong)!
    const weakHit = (
      await search.hybridSearch(WEAK_QUERY, { project_path: NS, touch: false, limit: 20 })
    ).find((r) => r.id === weak)!

    // before arm: each rank list divided by its own max, so both candidates hit
    // the full lexical weight and the score separation was the priors alone
    const w = WEIGHT_PROFILES[classifyQuery(WEAK_QUERY)]
    const priors = w.recency + w.access * 0 + w.importance * 0.5
    const beforeDelta = w.fts * 1.0 + priors - (w.fts * 1.0 + priors)
    const afterDelta = strongHit.score - weakHit.score

    expect(strongHit.relevance!).toBeGreaterThan(0.6)
    expect(weakHit.relevance!).toBeLessThan(0.5)
    expect(afterDelta).toBeGreaterThan(0.1)
    expect(beforeDelta).toBeCloseTo(0, 10)

    const floor = (weakHit.relevance! + strongHit.relevance!) / 2
    const floored = await search.hybridSearch(STRONG_QUERY, {
      project_path: NS,
      touch: false,
      limit: 20,
      min_score: floor,
    })
    expect(floored.map((r) => r.id)).toContain(strong)
    expect(precisionAtK(floored.map((r) => r.id), [strong], 10)).toBe(1)
    expect(mrr(floored.map((r) => r.id), [strong])).toBe(1)

    report([
      ['absolute-floor: relevance strong match', 'n/a (no absolute value)', strongHit.relevance!.toFixed(3)],
      ['absolute-floor: relevance weak match', 'n/a (no absolute value)', weakHit.relevance!.toFixed(3)],
      ['absolute-floor: score separation strong-weak', beforeDelta.toFixed(3), afterDelta.toFixed(3)],
      ['absolute-floor: precision@10 with floor', '1.000 (nothing to filter)', precisionAtK(floored.map((r) => r.id), [strong], 10).toFixed(3)],
    ])
  })

  it('access-explicit: a retrieval no longer strengthens the ranking signal it feeds', async () => {
    seedLexicalCorpus()
    const search = new MemorySearch(db, false)
    const QUERY = 'zkafka zconsumer'
    const searches = 3
    const inflate = (id: string) =>
      (db.prepare('SELECT access_count AS n FROM memories WHERE id = ?').get(id) as { n: number }).n

    const run = async (mode: string | undefined) => {
      db.prepare('UPDATE memories SET access_count = 0, last_accessed = NULL').run()
      if (mode) process.env.ENGRAM_ACCESS_SIGNAL = mode
      else delete process.env.ENGRAM_ACCESS_SIGNAL
      await Promise.all(
        Array.from({ length: searches }, () => search.hybridSearch(QUERY, { project_path: NS }))
      ).catch(async () => {
        for (let i = 0; i < searches; i++) await search.hybridSearch(QUERY, { project_path: NS })
      })
      return inflate('strong')
    }

    const retrieval = await run('retrieval')
    const explicit = await run('explicit')
    const off = await run('off')
    delete process.env.ENGRAM_ACCESS_SIGNAL

    expect(retrieval).toBe(searches)
    expect(explicit).toBe(0)
    expect(off).toBe(0)
    expect(retrieval).toBeGreaterThan(explicit)

    report([
      ['access-explicit: access_count after 3 searches (retrieval)', searches, retrieval],
      ['access-explicit: access_count after 3 searches (explicit)', searches, explicit],
      ['access-explicit: access_count after 3 searches (off)', searches, off],
    ])
  })

  it('expand-multi-query: an identifier query reaches the split-word memory, offline and deterministically', async () => {
    sessionFor(db, 'eval-session', NS)
    const now = Date.now()
    const stmt = db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags,
         created_at, valid_from, access_count)
       VALUES (?, 'eval-session', ?, ?, ?, 'note', 0.5, '[]', ?, ?, 0)`
    )
    stmt.run('compound', NS, NS, 'the hybridSearch entry point fuses the lists', now, now)
    stmt.run('split', NS, NS, 'the hybrid search entry point fuses the lists', now, now)

    const search = new MemorySearch(db, false)
    const before = await search.hybridSearch('hybridSearch', { project_path: NS, touch: false, limit: 10 })
    const after = await search.hybridSearch('hybridSearch', {
      project_path: NS,
      touch: false,
      limit: 10,
      expand: true,
    })

    const beforeIds = before.map((r) => r.id)
    const afterIds = after.map((r) => r.id)
    expect(recallAtK(beforeIds, ['split'], 10)).toBe(0)
    expect(recallAtK(afterIds, ['split'], 10)).toBe(1)
    expect(recallAtK(afterIds, ['compound'], 10)).toBe(1)

    const { expandQuery } = await import('../src/memory/search/expand.js')
    const first = await expandQuery('hybridSearch')
    const second = await expandQuery('hybridSearch')
    expect(first).toEqual(second)

    report([
      ['expand-multi-query: recall@10 (identifier query)', 0, recallAtK(afterIds, ['split'], 10)],
      ['expand-multi-query: precision@10 (identifier query)', precisionAtK(beforeIds, ['split'], 10).toFixed(3), precisionAtK(afterIds, ['split'], 10).toFixed(3)],
    ])
  })
})

describe('eval: rerank-blend (the window boundary no longer splits the scale)', () => {
  let db: Database.Database
  const NS = '/eval/rerank'

  beforeEach(() => {
    process.env.ENGRAM_RERANKER_ENABLED = '1'
    mockState.logits = []
    resetRerankerForTests()
    db = createTestDb().db
  })

  afterEach(() => {
    delete process.env.ENGRAM_RERANKER_ENABLED
    resetRerankerForTests()
  })

  it('the reranker can reach a candidate beyond the old 20-item window, and no candidate is left on a fused-only scale', async () => {
    const now = 1_700_000_000_000
    sessionFor(db, 'eval-session', NS)
    const stmt = db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags,
         created_at, valid_from, access_count)
       VALUES (?, 'eval-session', ?, ?, ?, 'note', ?, '[]', ?, ?, 0)`
    )
    for (let i = 0; i < 25; i++) {
      stmt.run(`r${i}`, NS, NS, `kafka tuning note number ${i} ${'x'.repeat(i)}`, 0.9 - i * 0.03, now, now)
    }

    const search = new MemorySearch(db, false)
    const fused = await search.hybridSearch('kafka tuning', { project_path: NS, touch: false, limit: 30, now })
    expect(fused).toHaveLength(25)

    // the favourite sits at fused rank 23, outside a 20-item window. logits stay
    // in the sigmoid's linear region so every candidate gets a non-zero
    // contribution: exactly 0 is indistinguishable from "never scored".
    mockState.logits = new Array(25).fill(-1.0)
    mockState.logits[22] = 1.1
    const breakdown = new Map<string, Record<string, number>>()
    const after = await search.hybridSearch(
      'kafka tuning',
      { project_path: NS, touch: false, limit: 30, now, use_reranker: true },
      breakdown as never
    )

    const fusedRank = fused.findIndex((r) => r.id === fused[22].id) + 1
    const afterRank = after.findIndex((r) => r.id === fused[22].id) + 1
    expect(fusedRank).toBeGreaterThan(20)
    expect(afterRank).toBe(1)
    expect(after.every((r) => breakdown.get(r.id)!.reranker > 0)).toBe(true)
    expect(after[1].id).toBe(fused[0].id)

    report([
      ['rerank-blend: rank of the reranker favourite', fusedRank, afterRank],
      ['rerank-blend: candidates the reranker influences', 20, after.length],
      ['rerank-blend: results on a fused-only scale', 5, 0],
    ])
  })

  it('removes the cross-scale inversion at the window boundary', async () => {
    const now = 1_700_000_000_000
    sessionFor(db, 'eval-session', NS)
    const stmt = db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags,
         created_at, valid_from, access_count)
       VALUES (?, 'eval-session', ?, ?, ?, 'note', ?, '[]', ?, ?, 0)`
    )
    for (let i = 0; i < 24; i++) {
      stmt.run(`s${i}`, NS, NS, `kafka tuning note number ${i}`, 0.9 - (i * 0.8) / 23, now, now)
    }
    const search = new MemorySearch(db, false)
    const fused = await search.hybridSearch('kafka tuning', { project_path: NS, touch: false, limit: 30, now })
    expect(fused).toHaveLength(24)

    const tailFused = fused[20].score
    // guards: a false measurement has to fail loudly, not pass vacuously
    expect(fused[0].score - tailFused).toBeGreaterThan(0.05)
    expect(tailFused).toBeGreaterThan(0.475)

    // a tail exists (window narrowed to 20). the reranker is mildly negative
    // about the fused leader and neutral about the rest
    const leaderLogit = Math.log(0.475 / (1 - 0.475))
    mockState.logits = new Array(20).fill(0)
    mockState.logits[0] = leaderLogit
    const withRerank = await search.hybridSearch('kafka tuning', {
      project_path: NS,
      touch: false,
      limit: 30,
      now,
      use_reranker: true,
      rerank_top_n: 20,
    })

    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))
    const before = fused
      .map((r, i) => ({ id: r.id, score: i < 20 ? sigmoid(mockState.logits[i]) : r.score }))
      .sort((a, b) => b.score - a.score)
    const beforeLeader = before.findIndex((r) => r.id === fused[0].id) + 1
    const beforeTail = before.findIndex((r) => r.id === fused[20].id) + 1
    const afterLeader = withRerank.findIndex((r) => r.id === fused[0].id) + 1
    const afterTail = withRerank.findIndex((r) => r.id === fused[20].id) + 1

    // before arm: the leader on the sigmoid scale, the unjudged tail on the fused
    // one, so a strictly better candidate ranks below one the reranker never saw
    expect(beforeTail).toBeLessThan(beforeLeader)
    expect(afterLeader).toBeLessThan(afterTail)

    report([
      ['rerank-blend: rank of the fused leader (before -> after)', beforeLeader, afterLeader],
      ['rerank-blend: rank of the unjudged tail item (before -> after)', beforeTail, afterTail],
    ])
  })
})
