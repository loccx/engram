// two jobs: metric correctness at unit level (no db) and end-to-end harness
// behaviour — isolated db, placement, determinism (same seed, byte-identical metrics),
// fts-only fallback, strict-budget invariant, registry auto-load, credential
// redaction. all of it runs fts-only, so the suite stays offline.
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  charEstimateTokens,
  corpusHash,
  leakRate,
  mrr,
  ndcgAtK,
  percentile,
  precisionAtK,
  recallAtK,
  resetTokenizerForTests,
  resolveTokenizer,
  staleRate,
  summarizeLatencies,
  tokenCost,
} from '../eval/lib/metrics.js'
import { buildCorpus, corpusNames, lexicalOverlapViolations, sharedRareTokens } from '../eval/lib/corpus.js'
import { EvalHarness } from '../eval/lib/harness.js'
import { resolveConfigs, loadConfigs, BASELINE_CONFIG, featureEnvKey, applyFeatureFlags } from '../eval/lib/registry.js'
import { buildHeader, renderSuiteSection, writeReport } from '../eval/lib/report.js'
import { buildQueryOptions } from '../eval/lib/score.js'
import { sweepThresholds, readRecordedVerdicts } from '../eval/suites/contradiction.js'
import { runRetrievalSuite } from '../eval/suites/retrieval.js'
import { runBudgetSuite } from '../eval/suites/budget.js'
import { parseEnvFile, gatewayStatus, redactSecrets, ENV_FILE, resetGatewayForTests } from '../eval/lib/llm.js'
import { buildThresholds, evaluateThresholds } from '../eval/lib/thresholds.js'
import type { SuiteContext } from '../eval/suites/types.js'
import type { HeaderInput } from '../eval/lib/report.js'

const tempDirs: string[] = []

function tempDir(prefix = 'engram-eval-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
  resetGatewayForTests()
  resetTokenizerForTests()
})

const SEED = 7

function suiteContext(overrides: Partial<SuiteContext> = {}): SuiteContext {
  return {
    seed: SEED,
    configs: [['baseline', BASELINE_CONFIG]],
    vectors: 'fts',
    qa: false,
    outDir: '/tmp/engram-eval-test-reports',
    buildHeader: (input: HeaderInput) => buildHeader({ ...input, git: undefined }),
    log: () => {},
    ...overrides,
  }
}

describe('metrics', () => {
  const results = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('computes recall/precision/MRR/nDCG with binary relevance', () => {
    expect(recallAtK(results, ['b'], 1)).toBe(0)
    expect(recallAtK(results, ['b'], 2)).toBe(1)
    expect(recallAtK(results, ['b', 'z'], 3)).toBeCloseTo(0.5, 10)
    expect(precisionAtK(results, ['b', 'c'], 3)).toBeCloseTo(2 / 3, 10)
    expect(mrr(results, ['c'])).toBeCloseTo(1 / 3, 10)
    expect(mrr(results, ['zz'])).toBe(0)
    // the single relevant hit comes first, so ndcg@3 = 1
    expect(ndcgAtK(results, ['a'], 3)).toBeCloseTo(1, 10)
    expect(ndcgAtK([{ id: 'z' }, ...results], ['a'], 3)).toBeLessThan(1)
  })

  it('never returns NaN for degenerate inputs', () => {
    expect(recallAtK([], ['a'], 5)).toBe(0)
    expect(recallAtK(results, [], 5)).toBe(0)
    expect(precisionAtK(results, ['a'], 0)).toBe(0)
    expect(mrr([], ['a'])).toBe(0)
    expect(ndcgAtK([], ['a'], 0)).toBe(0)
    expect(leakRate([], '/ns')).toBe(0)
    expect(staleRate([], ['a'])).toBe(0)
    expect(tokenCost([]).tokensPerChar).toBe(0)
    expect(percentile([], 0.5)).toBe(0)
    expect(summarizeLatencies([]).count).toBe(0)
  })

  it('leakRate honours namespace and the subtree option', () => {
    const rows = [
      { id: '1', namespace: '/ns' },
      { id: '2', namespace: '/ns//scope' },
      { id: '3', namespace: '/ns/sub' },
      { id: '4', namespace: '/ns2' },
      { id: '5', namespace: null, project_path: '/other' },
    ]
    // exact-namespace semantics: a synthetic scope and a child are both leaks
    expect(leakRate(rows, '/ns')).toBeCloseTo(4 / 5, 10)
    expect(leakRate(rows, '/ns', { subtree: true })).toBeCloseTo(2 / 5, 10)
    // a prefix that is not a path boundary must not count as inside
    expect(leakRate([{ id: 'x', namespace: '/ns2' }], '/ns', { subtree: true })).toBe(1)
  })

  it('staleRate flags superseded rows inside the result list', () => {
    expect(staleRate([{ id: 'a' }, { id: 'b' }], ['b'])).toBeCloseTo(0.5, 10)
    expect(staleRate([{ id: 'a' }], undefined)).toBe(0)
  })

  it('uses a real tokenizer when importable and states which one it used', async () => {
    const tokenizer = await resolveTokenizer()
    expect(['gpt-tokenizer', 'chars/4']).toContain(tokenizer.name)
    if (tokenizer.available) {
      expect(tokenizer.count('hello world')).toBeGreaterThan(0)
    } else {
      expect(tokenizer.count('abcd')).toBe(1)
      expect(charEstimateTokens('abcde')).toBe(2)
    }
    const cost = tokenCost(['abcd', 'efgh'], tokenizer)
    expect(cost.chars).toBe(8)
    expect(cost.tokens).toBeGreaterThan(0)
    expect(cost.tokensPerChar).toBeGreaterThan(0)
  })

  it('corpusHash is order-independent for object keys and stable for arrays', () => {
    const a = corpusHash([{ x: 1, y: 2 }])
    const b = corpusHash([{ y: 2, x: 1 }])
    expect(a.full).toBe(b.full)
    expect(corpusHash([1, 2]).full).not.toBe(corpusHash([2, 1]).full)
    expect(a.short).toHaveLength(16)
  })
})

describe('corpora', () => {
  it('are deterministic for a seed and change with the seed', () => {
    const a = buildCorpus('paraphrase', 11)
    const b = buildCorpus('paraphrase', 11)
    const c = buildCorpus('paraphrase', 12)
    expect(corpusHash(a.memories).full).toBe(corpusHash(b.memories).full)
    expect(corpusHash(a.memories).full).not.toBe(corpusHash(c.memories).full)
  })

  it('keeps every query target resolvable and namespaces non-empty', () => {
    for (const name of corpusNames()) {
      const corpus = buildCorpus(name, SEED)
      const ids = new Set(corpus.memories.map((m) => m.id))
      expect(ids.size, `${name}: duplicate memory ids`).toBe(corpus.memories.length)
      expect(corpus.queries.length, `${name}: no queries`).toBeGreaterThan(0)
      for (const query of corpus.queries) {
        expect(query.namespace.length, `${name}/${query.id}: empty namespace`).toBeGreaterThan(0)
        for (const target of query.target_ids) {
          expect(ids.has(target), `${name}/${query.id}: unknown target ${target}`).toBe(true)
        }
        for (const forbidden of query.must_not_retrieve ?? []) {
          expect(ids.has(forbidden), `${name}/${query.id}: unknown forbidden ${forbidden}`).toBe(true)
        }
      }
    }
  })

  it('paraphrase queries share no rare token with their target', () => {
    const violations = lexicalOverlapViolations(buildCorpus('paraphrase', SEED))
    expect(violations).toEqual([])
    // the check itself has to be able to fail
    expect(sharedRareTokens('postgres connection pool', 'postgres connection pool')).toEqual([
      'connection',
      'pool',
      'postgres',
    ])
  })

  it('has the adversarial and long-horizon properties the contract requires', () => {
    const distractor = buildCorpus('distractor', SEED)
    const decoys = distractor.memories.filter((m) => m.id.includes('-decoy-'))
    expect(decoys.length).toBeGreaterThanOrEqual(12)
    for (const decoy of decoys.slice(0, 4)) {
      const owner = distractor.memories.find((m) => decoy.id.startsWith(m.id) && !m.id.includes('-decoy-'))
      expect(owner).toBeDefined()
      expect(sharedRareTokens(decoy.content, owner!.content).length).toBeGreaterThan(1)
    }

    const horizon = buildCorpus('long-horizon', SEED)
    expect(horizon.memories.length).toBeGreaterThanOrEqual(50)
    expect(horizon.memories.filter((m) => m.superseded_by).length).toBeGreaterThan(0)

    const cross = buildCorpus('cross-namespace', SEED)
    const namespaces = new Set(cross.memories.map((m) => (m.scope ? `${m.namespace}//${m.scope}` : m.namespace)))
    expect(namespaces.size).toBeGreaterThanOrEqual(3)
    expect([...namespaces].some((ns) => ns.includes('//'))).toBe(true)
  })
})

describe('registry', () => {
  it('ships baseline with the shipped defaults and refuses unknown names', () => {
    expect(BASELINE_CONFIG.search).toEqual({ use_reranker: false, touch: false })
    expect(BASELINE_CONFIG.features).toBeUndefined()
    expect(resolveConfigs([]).map(([name]) => name)).toEqual(['baseline'])
    expect(() => resolveConfigs(['does-not-exist'])).toThrow(/unknown eval config/)
  })

  it('auto-loads contributed config modules and rejects a baseline redefinition', async () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'zz-lane.ts'),
      [
        "export const configs = {",
        "  'lane-config': { label: 'lane-config', search: { limit: 5 }, features: { graph_fused: 1 } },",
        "  baseline: { label: 'sneaky' },",
        '}',
        '',
      ].join('\n')
    )
    const loaded = await loadConfigs(dir)
    expect(Object.keys(loaded)).toContain('lane-config')
    // the harness owns baseline: a contributed redefinition is ignored, not merged
    
    expect(loaded.baseline).toBe(BASELINE_CONFIG)
    expect(loaded['lane-config'].search).toEqual({ limit: 5 })
  })

  it('records a broken config module instead of throwing', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'aa-broken.ts'), "export const configs = 'not-an-object'\n")
    const loaded = await loadConfigs(dir)
    expect(loaded.baseline).toBe(BASELINE_CONFIG)
    expect(Object.keys(loaded)).toEqual(['baseline'])
  })

  it('maps feature flags to env vars and restores them', () => {
    expect(featureEnvKey('graph_fused')).toBe('ENGRAM_GRAPH_FUSED')
    expect(featureEnvKey('ENGRAM_RERANKER_ENABLED')).toBe('ENGRAM_RERANKER_ENABLED')
    const applied = applyFeatureFlags({ graph_fused: true, threshold: 0.5 })
    expect(process.env.ENGRAM_GRAPH_FUSED).toBe('true')
    expect(process.env.ENGRAM_THRESHOLD).toBe('0.5')
    applied.restore()
    expect(process.env.ENGRAM_GRAPH_FUSED).toBeUndefined()
    expect(process.env.ENGRAM_THRESHOLD).toBeUndefined()
  })
})

describe('query options', () => {
  it('always forces touch:false and keeps the namespace honest', () => {
    const query = buildCorpus('cross-namespace', SEED).queries.find((q) => q.id === 'q-subtree-root')!
    const options = buildQueryOptions(query, { use_reranker: true, touch: true } as never, 5)
    expect(options.touch).toBe(false)
    expect(options.limit).toBe(5)
    expect(options.project_path).toBe(query.namespace)
    expect(options.namespace_subtree).toBe('/home/dev/grid')
    expect(options.as_of).toBeUndefined()
  })

  it('carries a query as_of into the search options', () => {
    const query = buildCorpus('temporal-update', SEED).queries.find((q) => q.kind === 'historical')!
    const options = buildQueryOptions(query, {}, 10)
    expect(options.as_of).toBe(query.as_of)
  })
})

describe('harness isolation', () => {
  it('uses a temp DB, seeds through store_memory, and verifies placement', async () => {
    const harness = await EvalHarness.create({ seed: SEED, vectors: 'fts' })
    try {
      expect(harness.dbPath.startsWith(tmpdir())).toBe(true)
      expect(harness.dbPath).not.toContain('Library/Application Support')
      expect(harness.vectorsAvailable).toBe(false)

      const corpus = buildCorpus('cross-namespace', SEED)
      const stats = await harness.seedCorpus(corpus)
      expect(stats.placementVerified).toBe(true)
      expect(stats.viaTool).toBe(corpus.memories.length)
      expect(harness.stats().memories).toBe(corpus.memories.length)

      // scope routing really produced a synthetic namespace
      const scoped = harness.db
        .prepare("SELECT COUNT(*) AS n FROM memories WHERE namespace LIKE '%//%'")
        .get() as { n: number }
      expect(scoped.n).toBeGreaterThan(0)

      // the rows carry the corpus clock, not the wall clock
      const minCreated = harness.db
        .prepare('SELECT MIN(created_at) AS min FROM memories')
        .get() as { min: number }
      const maxCreated = harness.db
        .prepare('SELECT MAX(created_at) AS max FROM memories')
        .get() as { max: number }
      const epoch = Math.min(...corpus.memories.map((m) => m.created_at))
      expect(minCreated.min).toBeGreaterThanOrEqual(epoch)
      expect(maxCreated.max).toBeLessThan(Date.now() - 1000)
    } finally {
      harness.dispose()
    }
  })

  it('measures without strengthening what it measures (touch:false)', async () => {
    const harness = await EvalHarness.create({ seed: SEED, vectors: 'fts' })
    try {
      await harness.seedCorpus(buildCorpus('paraphrase', SEED))
      const before = harness.db
        .prepare('SELECT COALESCE(SUM(access_count), 0) AS n FROM memories')
        .get() as { n: number }
      const first = await harness.runSearch('When does the evening emergency-recovery rehearsal begin, and how much time does it need?')
      const second = await harness.runSearch('When does the evening emergency-recovery rehearsal begin, and how much time does it need?')
      const after = harness.db
        .prepare('SELECT COALESCE(SUM(access_count), 0) AS n FROM memories')
        .get() as { n: number }
      expect(after.n).toBe(before.n)
      expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id))
      expect(second.map((r) => r.score)).toEqual(first.map((r) => r.score))
    } finally {
      harness.dispose()
    }
  })

  it('resurfaces superseded rows only when include_superseded is set', async () => {
    const harness = await EvalHarness.create({ seed: SEED, vectors: 'fts' })
    try {
      await harness.seedCorpus(buildCorpus('temporal-update', SEED))
      const query = 'How long is the cantilever deploy window?'
      const strict = await harness.runSearch(query, { project_path: '/home/dev/cinder', limit: 10 })
      const withSuperseded = await harness.runSearch(query, {
        project_path: '/home/dev/cinder',
        limit: 10,
        include_superseded: true,
      })
      const staleId = harness.seedIdOf('tmp-deploy-window-v1')!
      const freshId = harness.seedIdOf('tmp-deploy-window-v2')!
      expect(strict.map((r) => r.id)).toContain(freshId)
      expect(strict.map((r) => r.id)).not.toContain(staleId)
      expect(withSuperseded.map((r) => r.id)).toContain(staleId)
    } finally {
      harness.dispose()
    }
  })
})

describe('determinism', () => {
  it('produces byte-identical metrics for two in-process runs with the same header', async () => {
    const corpora = ['paraphrase', 'cross-namespace', 'temporal-update']
    const first = await runRetrievalSuite(suiteContext({ corpora }))
    const second = await runRetrievalSuite(suiteContext({ corpora }))

    expect(first.result.header.seed).toBe(second.result.header.seed)
    expect(first.result.header.corpusHash).toBe(second.result.header.corpusHash)
    expect(first.result.header.tokenizer).toBe(second.result.header.tokenizer)
    expect(first.result.header.vectorsAvailable).toBe(second.result.header.vectorsAvailable)

    expect(JSON.stringify(second.result.metrics, null, 2)).toBe(
      JSON.stringify(first.result.metrics, null, 2)
    )
    // and the per-query detail as well, minus its latency sample
    const strip = (details: unknown[]): string =>
      JSON.stringify(details, (key, value) => (key === 'latencyMs' ? 0 : value), 2)
    expect(strip(second.result.details)).toBe(strip(first.result.details))
  }, 120_000)

  it('changes metrics when the seed changes', async () => {
    const corpora = ['distractor']
    const a = await runRetrievalSuite(suiteContext({ corpora, seed: 1 }))
    const b = await runRetrievalSuite(suiteContext({ corpora, seed: 2 }))
    expect(a.result.header.corpusHash).not.toBe(b.result.header.corpusHash)
  }, 120_000)
})

describe('budget suite', () => {
  it('never exceeds the strict budget and reports where characters went', async () => {
    const output = await runBudgetSuite(suiteContext({ corpora: ['50', '200'] }))
    const metrics = output.result.metrics.baseline as {
      byBudget: Record<string, Record<string, number>>
      budgetViolations: number
    }
    expect(metrics.budgetViolations).toBe(0)
    for (const [key, row] of Object.entries(metrics.byBudget)) {
      const budget = Number(key.replace('budget', ''))
      expect(row.usedChars, `${key}: used more than the budget`).toBeLessThanOrEqual(budget)
      const sections = row.digestChars + row.memoryChars + row.topicChars
      expect(Math.abs(sections - row.usedChars)).toBeLessThanOrEqual(12)
    }
    // a 200-char budget cannot hold the pinned digest plus a long memory
    expect(metrics.byBudget.budget50.usedChars).toBeLessThanOrEqual(50)
    expect(output.result.notes.join('\n')).toContain('strict-budget violations=0')
  }, 60_000)
})

describe('contradiction sweep', () => {
  it('computes precision, recall and the false-supersession rate per threshold', async () => {
    const corpus = buildCorpus('contradiction', SEED)
    const pairs = corpus.pairs!
    // a faithful fixture: one unrelated pair is wrongly judged to contradict at 0.85,
    // which is exactly what the false-supersession rate exists to expose
    const verdicts = pairs.map((pair) => {
      
      
      
      const wrong = pair.relation === 'unrelated' && pair.id === 'cx-unrelated-batch'
      return {
        pair_id: pair.id,
        relation: wrong ? 'contradicts' : pair.relation,
        confidence: wrong ? 0.85 : 0.95,
        reason: 'test fixture',
      }
    })
    const sweep = sweepThresholds(pairs, verdicts)
    expect(sweep[0].threshold).toBe(0.5)
    expect(sweep[sweep.length - 1].threshold).toBe(0.99)

    const at08 = sweep.find((row) => row.threshold === 0.8)!
    expect(at08.truePositives).toBe(8) // 4 contradicts + 4 updates
    expect(at08.falsePositives).toBe(1) // the wrongly superseded unrelated pair
    expect(at08.falseNegatives).toBe(0)
    expect(at08.precision).toBeCloseTo(8 / 9, 3)
    expect(at08.recall).toBe(1)
    expect(at08.falseSupersessionRate).toBeCloseTo(1 / 4, 3)
    expect(at08.duplicateSupersessionRate).toBe(1)

    const at09 = sweep.find((row) => row.threshold === 0.9)!
    expect(at09.falsePositives).toBe(0)
    expect(at09.precision).toBe(1)
    expect(at09.falseSupersessionRate).toBe(0)
  })

  it('reads recorded verdicts in both accepted shapes', () => {
    const dir = tempDir()
    const arrayFile = join(dir, 'array.json')
    writeFileSync(
      arrayFile,
      JSON.stringify({ verdicts: [{ pair_id: 'p1', relation: 'updates', confidence: 0.91 }] })
    )
    expect(readRecordedVerdicts(arrayFile).get('p1')?.confidence).toBe(0.91)

    const mapFile = join(dir, 'map.json')
    writeFileSync(mapFile, JSON.stringify({ p2: { relation: 'unrelated', confidence: 0.4 } }))
    expect(readRecordedVerdicts(mapFile).get('p2')?.relation).toBe('unrelated')

    const badFile = join(dir, 'bad.json')
    writeFileSync(badFile, JSON.stringify({ nothing: 'here' }))
    expect(() => readRecordedVerdicts(badFile)).toThrow(/no usable verdicts/)
  })
})

describe('reports and credentials', () => {
  it('writes markdown + json artifacts and includes the required header fields', () => {
    const dir = tempDir('engram-eval-reports-')
    const output = {
      suite: 'unit',
      header: buildHeader({
        suite: 'unit',
        configs: ['baseline'],
        seed: 3,
        corpusHash: corpusHash({ x: 1 }),
        vectorsAvailable: false,
        vectorMode: 'fts',
        now: 1_700_000_000_000,
        tokenizer: { name: 'chars/4', available: false, count: charEstimateTokens },
        featureFlags: {},
        git: { sha: 'abc', short: 'abc', branch: 'test', dirty: false },
      }),
      metrics: { baseline: { 'recall@10': 1 } },
      timings: {},
      details: [],
      notes: [],
    }
    const paths = writeReport({
      outDir: dir,
      fileBase: 'unit-baseline-abc',
      markdown: renderSuiteSection(output, 'body'),
      json: output,
    })
    expect(existsSync(paths.md)).toBe(true)
    expect(existsSync(paths.json)).toBe(true)
    const text = readFileSync(paths.md, 'utf8')
    for (const field of ['git sha', 'seed', 'corpus hash', 'vectorsAvailable', 'tokenizer']) {
      expect(text).toContain(field)
    }
  })

  it('parses an env file without treating comments as values', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        'ENGRAM_LLM_BASE_URL="https://gateway.example.invalid/v1"',
        "ENGRAM_LLM_MODEL='some-model'",
        'export ENGRAM_LLM_API_KEY=sk-test-not-a-real-key',
        'not-a-key-value',
        '',
      ].join('\n')
    )
    expect(parsed.ENGRAM_LLM_BASE_URL).toBe('https://gateway.example.invalid/v1')
    expect(parsed.ENGRAM_LLM_MODEL).toBe('some-model')
    expect(parsed.ENGRAM_LLM_API_KEY).toBe('sk-test-not-a-real-key')
    expect(Object.keys(parsed)).toHaveLength(3)
  })

  it('reports only presence/host/model and never the credential', () => {
    const dir = tempDir()
    const file = join(dir, 'env')
    writeFileSync(
      file,
      [
        'ENGRAM_LLM_BASE_URL=https://user:hunter2@gateway.example.invalid/v1?token=hunter2',
        'ENGRAM_LLM_API_KEY=sk-test-not-a-real-key',
        'ENGRAM_LLM_MODEL=test-model',
        '',
      ].join('\n')
    )
    for (const key of ['ENGRAM_LLM_BASE_URL', 'ENGRAM_LLM_API_KEY', 'ENGRAM_LLM_MODEL']) {
      delete process.env[key]
    }
    const status = gatewayStatus(file)
    expect(status.configured).toBe(true)
    expect(status.host).toBe('gateway.example.invalid')
    expect(status.model).toBe('test-model')
    expect(ENV_FILE.endsWith('.engram-eval.env')).toBe(true)
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('sk-test')
    expect(serialized).not.toContain('token=')

    const redacted = redactSecrets(
      'Authorization: Bearer sk-test-not-a-real-key and https://user:hunter2@gateway.example.invalid/v1?token=hunter2'
    )
    expect(redacted.text).not.toContain('sk-test-not-a-real-key')
    expect(redacted.text).not.toContain('hunter2')
    expect(redacted.redactions).toBeGreaterThan(0)

    for (const key of ['ENGRAM_LLM_BASE_URL', 'ENGRAM_LLM_API_KEY', 'ENGRAM_LLM_MODEL']) {
      delete process.env[key]
    }
    const unconfigured = gatewayStatus(join(dir, 'does-not-exist'))
    expect(unconfigured.configured).toBe(false)
    expect(unconfigured.host).toBe('')
  })
})

describe('thresholds', () => {
  it('builds a margin-adjusted file and gates in both directions', () => {
    const file = buildThresholds({
      suites: { retrieval: { baseline: { 'recall@10': 0.8, mrr: 1, leakRate: 0, staleRate: 0 } } },
      margin: 0.1,
    })
    expect(file.suites.retrieval.baseline['recall@10']).toBeCloseTo(0.72, 6)
    expect(file.suites.retrieval.baseline.mrr).toBeCloseTo(0.9, 6)
    expect(file.suites.retrieval.baseline.staleRate).toBeCloseTo(0.1, 6)
    // leakRate is an invariant, so it is recorded exactly rather than with a margin:
    // any movement fails the gate
    expect(file.suites.retrieval.baseline.leakRate).toBe(0)
    expect(
      evaluateThresholds(file, {
        retrieval: { baseline: { 'recall@10': 0.8, mrr: 1, leakRate: 0.01, staleRate: 0 } },
      }).failures.map((f) => f.metric)
    ).toEqual(['leakRate'])

    const pass = evaluateThresholds(file, {
      retrieval: { baseline: { 'recall@10': 0.8, mrr: 1, leakRate: 0, staleRate: 0 } },
    })
    expect(pass.failures).toEqual([])
    expect(pass.checked).toBe(4)

    const fail = evaluateThresholds(file, {
      retrieval: { baseline: { 'recall@10': 0.1, mrr: 1, leakRate: 0.1, staleRate: 0.5 } },
    })
    expect(fail.failures.map((f) => f.metric).sort()).toEqual([
      'leakRate',
      'recall@10',
      'staleRate',
    ])
  })
})

describe('end-to-end exit behaviour', () => {
  it('longmemeval reports dataset-missing instead of crashing', async () => {
    const { runLongMemEvalSuite } = await import('../eval/suites/longmemeval.js')
    const output = await runLongMemEvalSuite(
      suiteContext({ dataset: 'longmemeval_oracle', corpora: ['longmemeval_oracle'] })
    )
    const metrics = output.result.metrics as { status: string }
    // either the dataset is present or the run degrades cleanly
    expect(['dataset-missing', undefined]).toContain(metrics.status)
    if (metrics.status === 'dataset-missing') {
      expect(output.markdown).toContain('eval:datasets')
      expect(output.thresholds).toEqual({})
    }
  }, 60_000)
})

describe('harness teardown', () => {
  it('restores the environment it borrowed', async () => {
    const before = { ...process.env }
    const harness = await EvalHarness.create({ seed: SEED, vectors: 'fts', tmpDir: tempDir() })
    const during = process.env.ENGRAM_DB_PATH
    expect(during).not.toBe(before.ENGRAM_DB_PATH)
    harness.dispose()
    expect(process.env.ENGRAM_DB_PATH).toBe(before.ENGRAM_DB_PATH)
    expect(process.env.ENGRAM_SCOPE_INFERENCE).toBe(before.ENGRAM_SCOPE_INFERENCE)
  })
})
