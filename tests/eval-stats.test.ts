// paired-stats checks: hand-computed mcnemar p-values, a bootstrap that must reproduce
// under its recorded seed, holm ordering, the comparability guard and the pareto
// frontier — then the longmemeval report end to end over the stub llm.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOW_N_THRESHOLD,
  answerLatency,
  checkComparability,
  compareSystems,
  exactBinomialTwoSided,
  frontierFlags,
  holmCorrection,
  mcnemarExact,
  pairedBootstrapDelta,
  seedFor,
  type RunIdentity,
  type StatsRow,
  type SystemInput,
} from '../eval/lib/stats.js'
import { renderComparisonReport } from '../eval/lib/report.js'
import { runLongMemEvalSuite } from '../eval/suites/longmemeval.js'
import { resetGatewayForTests, setLlmTransport, type LlmCall } from '../eval/lib/llm.js'
import { buildHeader } from '../eval/lib/report.js'
import { resolveConfigs } from '../eval/lib/registry.js'
import { resetTokenizerForTests } from '../eval/lib/metrics.js'
import type { SuiteContext } from '../eval/suites/types.js'
import type { ChatResult } from '../src/llm/client.js'

function rowsOf(ids: Array<[string, boolean]>, overrides: Partial<StatsRow> = {}): StatsRow[] {
  return ids.map(([id, correct]) => ({ question_id: id, correct, ...overrides }))
}

function idsWith(prefix: string, count: number, from: number): Array<[string, boolean]> {
  return Array.from({ length: count }, (_, i) => [`${prefix}${from + i}`, false] as [string, boolean])
}

describe('mcnemar (exact, two-sided)', () => {
  it('matches hand-computed binomial tails', () => {
    // n = 12 discordant pairs, k = min(b, c) = 2: 2 x (1 + 12 + 66) / 2^12
    expect(mcnemarExact(10, 2).p).toBeCloseTo(2 * 79 / 4096, 12)
    expect(mcnemarExact(9, 3).p).toBeCloseTo(2 * 299 / 4096, 12)
    expect(mcnemarExact(8, 0).p).toBeCloseTo(2 / 2 ** 8, 12)
    expect(mcnemarExact(14, 0).p).toBeCloseTo(2 / 2 ** 14, 12)
  })

  it('is 1 with no discordant pair and caps the doubled tail at 1', () => {
    expect(mcnemarExact(0, 0)).toEqual({ b: 0, c: 0, discordant: 0, p: 1 })
    expect(mcnemarExact(25, 25).p).toBe(1)
    expect(exactBinomialTwoSided(0, 0)).toBe(1)
    expect(exactBinomialTwoSided(1, 0)).toBe(1)
  })

  it('is symmetric in b and c', () => {
    expect(mcnemarExact(2, 10).p).toBe(mcnemarExact(10, 2).p)
    expect(mcnemarExact(7, 1).p).toBe(mcnemarExact(1, 7).p)
  })
})

describe('paired bootstrap delta', () => {
  const left = Array.from({ length: 200 }, (_, i) => (i < 170 ? 1 : 0))
  const right = Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? 1 : 0))

  it('reproduces byte for byte under the recorded seed', () => {
    const once = pairedBootstrapDelta(left, right, { seed: 5 })
    const twice = pairedBootstrapDelta(left, right, { seed: 5 })
    expect(twice).toEqual(once)
    expect(once.seed).toBe(5)
    expect(once.resamples).toBe(10_000)
  })

  it('brackets the observed delta and finds a real gap', () => {
    const boot = pairedBootstrapDelta(left, right, { seed: 5 })
    expect(boot.delta).toBeCloseTo(0.85 - 0.1, 12)
    expect(boot.ci_low).toBeLessThanOrEqual(boot.delta)
    expect(boot.ci_high).toBeGreaterThanOrEqual(boot.delta)
    expect(boot.ci_low).toBeGreaterThan(0)
  })

  it('covers zero when the two systems are identical', () => {
    const same = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 1 : 0))
    const boot = pairedBootstrapDelta(same, same, { seed: 3 })
    expect(boot.delta).toBe(0)
    expect(boot.ci_low).toBeLessThanOrEqual(0)
    expect(boot.ci_high).toBeGreaterThanOrEqual(0)
  })

  it('refuses sides of different length instead of truncating', () => {
    expect(() => pairedBootstrapDelta([1, 0], [1], { seed: 1 })).toThrow(/equal-length/)
  })

  it('derives a stable stream per label', () => {
    expect(seedFor(9, 'alpha')).toBe(seedFor(9, 'alpha'))
    expect(seedFor(9, 'alpha')).not.toBe(seedFor(9, 'beta'))
  })
})

describe('holm correction', () => {
  it('adjusts four ascending p-values and rejects only the smallest', () => {
    const holm = holmCorrection([
      { label: 'a', p: 0.01 },
      { label: 'b', p: 0.02 },
      { label: 'c', p: 0.03 },
      { label: 'd', p: 0.04 },
    ])
    expect(holm.map((r) => r.adjusted)).toEqual([0.04, 0.06, 0.06, 0.06])
    expect(holm.map((r) => r.rank)).toEqual([1, 2, 3, 4])
    expect(holm.map((r) => r.rejected)).toEqual([true, false, false, false])
  })

  it('leaves a single test unadjusted and returns the caller order', () => {
    expect(holmCorrection([{ label: 'only', p: 0.04 }])[0].adjusted).toBe(0.04)
    const unordered = holmCorrection([
      { label: 'big', p: 0.5 },
      { label: 'small', p: 0.001 },
    ])
    expect(unordered[0]).toMatchObject({ label: 'big', adjusted: 0.5, rejected: false })
    expect(unordered[1]).toMatchObject({ label: 'small', adjusted: 0.002, rejected: true })
  })
})

/**
 * the identity a comparison stands on: the required fields are the regime, the question
 * set and the code revision, so a fixture that omits them is not comparable at all
 */
const FULL_IDENTITY: RunIdentity = {
  dataset_sha: 'a1b2c3',
  reader_model: 'reader-a',
  judge_model: 'judge-a',
  reader_prompt: 'reader-v1',
  judge_prompt: 'judge-v1',
  budget_chars: 32_000,
  vectors: 'fts',
  question_set: 'all,limit=35,stride=1',
  engine_revision: 'sha-a',
}

describe('comparability guard', () => {
  const identity = FULL_IDENTITY

  it('accepts two identical identities', () => {
    expect(checkComparability(identity, { ...identity })).toMatchObject({
      comparable: true,
      differences: [],
      unverified: [],
      interventions: [],
    })
  })

  it('names the field that differs', () => {
    const mismatched = checkComparability(identity, { ...identity, judge_model: 'judge-b' })
    expect(mismatched.comparable).toBe(false)
    expect(mismatched.differences).toEqual(['judge model: judge-a vs judge-b'])
    expect(checkComparability(identity, { ...identity, budget_chars: 8_000 }).differences).toEqual([
      'budget: 32000 vs 8000',
    ])
    expect(checkComparability(identity, { ...identity, dataset_sha: 'deadbeef' }).comparable).toBe(false)
  })

  it('reports a field one side does not declare as unchecked, not as equal', () => {
    const guard = checkComparability(identity, {
      dataset_sha: 'a1b2c3',
      vectors: 'fts',
      question_set: 'all,limit=35,stride=1',
      engine_revision: 'sha-a',
    })
    expect(guard.comparable).toBe(true)
    expect(guard.unverified).toEqual([
      'reader model',
      'judge model',
      'reader prompt',
      'judge prompt',
      'budget',
    ])
  })

  it('marks optional fields missing from both sides as unchecked', () => {
    const identity = { vectors: 'fts', question_set: 'q1', engine_revision: 'sha-a' }
    const guard = checkComparability(identity, { ...identity })
    expect(guard.comparable).toBe(true)
    expect(guard.unverified).toEqual([
      'dataset sha', 'reader model', 'judge model', 'reader prompt', 'judge prompt', 'budget',
    ])
  })

  it('refuses a comparison that changes only the vector regime', () => {
    const guard = checkComparability(identity, { ...identity, vectors: 'cached+vectors' })
    expect(guard.comparable).toBe(false)
    expect(guard.differences).toEqual(['vectors: fts vs cached+vectors'])
  })

  it('refuses a comparison that changes only the sampled question set', () => {
    const guard = checkComparability(identity, {
      ...identity,
      question_set: 'types=multi-session,limit=60,stride=n/a',
    })
    expect(guard.comparable).toBe(false)
    expect(guard.differences).toEqual([
      'question set: all,limit=35,stride=1 vs types=multi-session,limit=60,stride=n/a',
    ])
  })

  it('refuses a comparison that changes only the code revision, and points at the intervention', () => {
    const guard = checkComparability(identity, { ...identity, engine_revision: 'sha-b' })
    expect(guard.comparable).toBe(false)
    expect(guard.differences).toEqual([
      'engine revision: sha-a vs sha-b — declare the same engine intervention on both sides to ' +
        'compare across revisions on purpose',
    ])
    expect(guard.interventions).toEqual([])
  })

  it('permits a cross-revision comparison under the same declared intervention', () => {
    const guard = checkComparability(
      { ...identity, engine_intervention: 'ab:fts-cache-lane' },
      { ...identity, engine_revision: 'sha-b', engine_intervention: 'ab:fts-cache-lane' }
    )
    expect(guard.comparable).toBe(true)
    expect(guard.differences).toEqual([])
    expect(guard.interventions).toEqual([
      'engine revision: sha-a vs sha-b, under intervention "ab:fts-cache-lane"',
    ])
  })

  it('renders deliberate interventions without calling their revision a match', () => {
    const report = compareSystems({
      systems: [
        {
          name: 'engram',
          rows: rowsOf([['q1', true]], { engine_revision: 'sha-a' }),
          identity: { ...identity, engine_intervention: 'controller-ab' },
        },
        {
          name: 'other',
          rows: rowsOf([['q1', true]], { engine_revision: 'sha-b' }),
          identity: { ...identity, engine_revision: 'sha-b', engine_intervention: 'controller-ab' },
        },
      ],
      seed: 7,
    })
    expect(report.comparable).toBe(true)
    const markdown = renderComparisonReport(report)
    expect(markdown).toContain('deliberate interventions:')
    expect(markdown).toContain('under intervention "controller-ab"')
    const matched = markdown.split('\n').find((line) => line.startsWith('comparability:'))!
    expect(matched).toContain('vectors, question set')
    expect(matched).not.toContain('engine revision')
    const withheld = renderComparisonReport({
      ...report, comparable: false, differences: ['vectors: fts vs cached+vectors'],
    })
    expect(withheld).toContain('comparison withheld')
    expect(withheld).toContain('under intervention "controller-ab"')
    expect(withheld).not.toContain('mcnemar')
  })

  it('refuses two sides that declare different interventions', () => {
    const guard = checkComparability(
      { ...identity, engine_intervention: 'ab:one' },
      { ...identity, engine_intervention: 'ab:two' }
    )
    expect(guard.comparable).toBe(false)
    expect(guard.differences).toEqual(['engine intervention: ab:one vs ab:two'])
  })

  it('does not accept a one-sided intervention', () => {
    const guard = checkComparability(
      { ...identity, engine_intervention: 'ab:only-one-side' },
      { ...identity, engine_revision: 'sha-b' }
    )
    expect(guard.comparable).toBe(false)
    expect(guard.differences).toHaveLength(1)
    expect(guard.interventions).toEqual([])
  })

  it('fails closed when a side does not declare the regime, the sample or the revision', () => {
    const legacy: RunIdentity = { dataset_sha: 'a1b2c3', reader_model: 'reader-a' }
    const guard = checkComparability(identity, legacy)
    expect(guard.comparable).toBe(false)
    expect(guard.differences).toEqual([
      'vectors: fts vs undeclared (the other side) — the two sides cannot be shown to match on vectors',
      'question set: all,limit=35,stride=1 vs undeclared (the other side) — the two sides cannot be ' +
        'shown to match on question set',
      'engine revision: sha-a vs undeclared (the other side) — the two sides cannot be shown to match ' +
        'on engine revision',
    ])
    // the optional fields stay unchecked rather than becoming refusals
    expect(guard.unverified).toEqual(['judge model', 'reader prompt', 'judge prompt', 'budget'])
  })

  it('fails closed when neither side declares them', () => {
    const guard = checkComparability({ dataset_sha: 'a1b2c3' }, { dataset_sha: 'a1b2c3' })
    expect(guard.comparable).toBe(false)
    expect(guard.differences).toEqual([
      'vectors: undeclared on both sides — the two sides cannot be shown to match on vectors',
      'question set: undeclared on both sides — the two sides cannot be shown to match on question set',
      'engine revision: undeclared on both sides — the two sides cannot be shown to match on engine revision',
    ])
  })

  it('makes compareSystems withhold the comparison entirely', () => {
    const report = compareSystems({
      systems: [
        {
          name: 'engram',
          rows: rowsOf([['q1', true]]),
          identity: { ...FULL_IDENTITY, judge_model: 'judge-a' },
        },
        {
          name: 'full-context',
          rows: rowsOf([['q1', true]]),
          identity: { ...FULL_IDENTITY, judge_model: 'judge-b' },
        },
      ],
      seed: 1,
    })
    expect(report.comparable).toBe(false)
    expect(report.pairs).toEqual([])
    expect(report.pareto).toEqual([])
    expect(report.differences[0]).toBe('full-context vs engram: judge model: judge-a vs judge-b')
    expect(report.interventions).toEqual([])
    const markdown = renderComparisonReport(report)
    expect(markdown).toContain('comparison withheld')
    expect(markdown).toContain('judge model: judge-a vs judge-b')
    expect(markdown).not.toContain('mcnemar')
  })

  it('withholds a comparison whose row sets disagree about their own identity', () => {
    const report = compareSystems({
      systems: [
        {
          name: 'engram',
          rows: rowsOf(
            [
              ['q1', true],
              ['q2', true],
            ],
            { vectors: FULL_IDENTITY.vectors, question_set: FULL_IDENTITY.question_set }
          ).map((row, i) => ({ ...row, git_sha: i === 0 ? 'sha-a' : 'sha-b' })),
        },
        {
          name: 'full-context',
          rows: rowsOf([
            ['q1', true],
            ['q2', true],
          ]),
        },
      ],
      runIdentity: FULL_IDENTITY,
      seed: 1,
    })
    expect(report.comparable).toBe(false)
    expect(report.pairs).toEqual([])
    expect(report.differences[0]).toBe(
      'engram: rows disagree on engine revision (sha-a, sha-b)'
    )
  })

  it('withholds a comparison whose rows contradict the run identity they are declared under', () => {
    const report = compareSystems({
      systems: [
        { name: 'engram', rows: rowsOf([['q1', true]], { vectors: 'cached+vectors' }) },
        { name: 'full-context', rows: rowsOf([['q1', true]]) },
      ],
      runIdentity: FULL_IDENTITY,
      seed: 1,
    })
    expect(report.comparable).toBe(false)
    expect(report.differences).toEqual([
      'engram: rows disagree on vectors: declared fts, rows say cached+vectors',
    ])
  })
})

describe('pareto frontier', () => {
  it('keeps the points nothing else beats on accuracy at a lower cost', () => {
    const flags = frontierFlags([
      { accuracy: 0.8, cost: 1000 },
      { accuracy: 0.7, cost: 500 },
      { accuracy: 0.75, cost: 1500 },
      { accuracy: 0.8, cost: 1500 },
    ])
    expect(flags).toEqual([true, true, false, false])
  })

  it('keeps both points of an exact tie', () => {
    expect(frontierFlags([{ accuracy: 0.5, cost: 100 }, { accuracy: 0.5, cost: 100 }])).toEqual([
      true,
      true,
    ])
  })
})

describe('compareSystems', () => {
  const thirty = idsWith('q', 30, 1)
  const five = idsWith('t', 5, 1)

  /** the required identity fields, so these comparisons are about the numbers, not the guard */
  const RUN: RunIdentity = {
    vectors: 'fts',
    question_set: 'all,limit=35,stride=1',
    engine_revision: 'sha-a',
  }

  function twoSystems(): { systems: SystemInput[]; seed: number; runIdentity: RunIdentity } {
    const typed = (id: string, index: number): string =>
      index < thirty.length ? 'single-session-user' : 'multi-session'
    const left = rowsOf([...thirty, ...five].map(([id], i) => [id, i < 24] as [string, boolean])).map(
      (row, i) => ({ ...row, question_type: typed(row.question_id, i), context_tokens: 100 })
    )
    const right = rowsOf([...thirty, ...five].map(([id], i) => [id, i < 12] as [string, boolean])).map(
      (row, i) => ({ ...row, question_type: typed(row.question_id, i), context_tokens: 400 })
    )
    return {
      systems: [{ name: 'engram', rows: left }, { name: 'other', rows: right }],
      seed: 7,
      runIdentity: RUN,
    }
  }

  it('pairs on question id, counts b and c, and points the delta the right way', () => {
    const { systems, seed, runIdentity } = twoSystems()
    const report = compareSystems({ systems, seed, runIdentity })
    expect(report.comparable).toBe(true)
    expect(report.pairs).toHaveLength(1)
    const pair = report.pairs[0]
    expect(pair.n).toBe(35)
    expect(pair.mcnemar_b).toBe(12)
    expect(pair.mcnemar_c).toBe(0)
    expect(pair.delta).toBeGreaterThan(0.3)
    expect(pair.only_left).toEqual([])
    expect(pair.only_right).toEqual([])
    expect(pair.significant).toBe(true)
    expect(report.n_paired).toBe(35)
  })

  it('applies holm once more than one pair is compared', () => {
    const { systems, seed, runIdentity } = twoSystems()
    const third: SystemInput = { name: 'naive-rag', rows: rowsOf(thirty.map(([id]) => [id, true])) }
    const report = compareSystems({ systems: [...systems, third], seed, runIdentity })
    expect(report.pairs).toHaveLength(3)
    for (const pair of report.pairs) {
      expect(pair.family).toBe(3)
      expect(pair.holm_p).toBeGreaterThanOrEqual(pair.p)
    }
    const adjusted = report.pairs.map((pair) => pair.holm_p).sort((a, b) => a - b)
    expect(adjusted[adjusted.length - 1]).toBeLessThanOrEqual(1)
  })

  it('reports rows missing on one side and keeps them out of the pair', () => {
    const report = compareSystems({
      systems: [
        {
          name: 'engram',
          rows: rowsOf([
            ['q1', true],
            ['q2', true],
            ['q3', true],
          ]),
        },
        {
          name: 'full-context',
          rows: rowsOf([
            ['q1', true],
            ['q2', false],
            ['q4', true],
          ]),
        },
      ],
      runIdentity: RUN,
      seed: 3,
    })
    const pair = report.pairs[0]
    expect(pair.n).toBe(2)
    expect(pair.only_left).toEqual(['q3'])
    expect(pair.only_right).toEqual(['q4'])
    expect(pair.accuracy_left).toBe(1)
    expect(pair.accuracy_right).toBe(0.5)
    const markdown = renderComparisonReport(report)
    expect(markdown).toContain('graded on engram only (q3)')
    expect(markdown).toContain('graded on full-context only (q4)')
  })

  it('counts a row without a verdict as ungraded rather than wrong', () => {
    const report = compareSystems({
      systems: [
        { name: 'a', rows: [{ question_id: 'q1', correct: true }, { question_id: 'q2' }] },
        { name: 'b', rows: rowsOf([['q1', false]]) },
      ],
      runIdentity: RUN,
      seed: 2,
    })
    expect(report.ungraded).toEqual({ a: 1, b: 0 })
    expect(report.pairs[0].n).toBe(1)
  })

  it('flags a per-type bucket under 30 paired questions', () => {
    const { systems, seed, runIdentity } = twoSystems()
    const report = compareSystems({ systems, seed, runIdentity })
    const types = report.by_question_type
    expect(types).toHaveLength(2)
    expect(types.find((row) => row.question_type === 'single-session-user')).toMatchObject({
      n: 30,
      low_n: false,
    })
    expect(types.find((row) => row.question_type === 'multi-session')).toMatchObject({
      n: 5,
      low_n: true,
    })
    expect(LOW_N_THRESHOLD).toBe(30)
  })

  it('bootstraps recall@k, mrr and token metrics when the rows carry them', () => {
    const withMetrics = (mrr: number): StatsRow[] =>
      thirty.map(([id], i) => ({
        question_id: id,
        correct: i < 15,
        recall: { 'recall@5': i < 20 ? 1 : 0, 'recall@10': i < 25 ? 1 : 0 },
        mrr,
        servedTokens: i + 1,
      }))
    const report = compareSystems({
      systems: [
        { name: 'left', rows: withMetrics(1) },
        { name: 'right', rows: withMetrics(0.5) },
      ],
      runIdentity: RUN,
      seed: 11,
    })
    const metrics = report.pairs[0].continuous.map((stats) => stats.metric)
    expect(metrics).toEqual(['recall@5', 'recall@10', 'mrr', 'served tokens'])
    const mrr = report.pairs[0].continuous.find((stats) => stats.metric === 'mrr')
    expect(mrr).toMatchObject({ n: 30, left_mean: 1, right_mean: 0.5, delta: 0.5 })
    const markdown = renderComparisonReport(report)
    expect(markdown).toContain('### paired continuous metrics')
    expect(markdown).toContain('recall@5')
  })

  it('marks the frontier and prints the paired sentence', () => {
    const { systems, seed, runIdentity } = twoSystems()
    const report = compareSystems({ systems, seed, runIdentity })
    expect(report.cost_axis).toBe('mean context tokens')
    expect(report.pareto).toEqual([
      expect.objectContaining({ system: 'engram', n: 35, mean_context_tokens: 100, frontier: true }),
      expect.objectContaining({ system: 'other', n: 35, mean_context_tokens: 400, frontier: false }),
    ])
    const markdown = renderComparisonReport(report, {
      latencies: { engram: { p50Ms: 12, p95Ms: 30, n: 35 } },
    })
    expect(markdown).toContain('### paired comparison')
    expect(markdown).toContain('vectors, question set, engine revision')
    expect(markdown).toContain('bootstrap: seed 7, 10000 resamples')
    expect(markdown).toMatch(
      /engram vs other: \+\d+\.\d pts \(95% ci [+-]\d+\.\d to [+-]\d+\.\d\), mcnemar (p=[\d.]+|p<0\.001) \(b=\d+, c=\d+\) — significant at 0\.05/
    )
    expect(markdown).toContain('### pareto: accuracy vs cost')
    expect(markdown).toContain('p50 ms')
  })

  it('reads latency percentiles off the rows and never off the metrics block', () => {
    const rows = rowsOf([
      ['q1', true],
      ['q2', false],
    ]).map((row, i) => ({ ...row, retrieval_ms: 10, reader_ms: 10 * i }))
    expect(answerLatency(rows)).toEqual({ p50Ms: 15, p95Ms: 19.5, n: 2 })
    expect(answerLatency(rowsOf([['q1', true]]))).toBeNull()
  })
})

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-stats-test-'))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  resetGatewayForTests()
  resetTokenizerForTests()
})

afterEach(() => {
  setLlmTransport(null)
  resetGatewayForTests()
  resetTokenizerForTests()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
  for (const key of ['ENGRAM_LLM_BASE_URL', 'ENGRAM_LLM_API_KEY', 'ENGRAM_LLM_MODEL']) {
    delete process.env[key]
  }
})

const EVIDENCE = 'gold-fact'
const READERS = ['engram', 'full-context']

interface FakeQuestion {
  id: string
  type: string
  sessions: number
  evidenceAt: number
}

const QUESTIONS: FakeQuestion[] = [
  { id: 'q-one', type: 'single-session-user', sessions: 4, evidenceAt: 3 },
  { id: 'q-two', type: 'knowledge-update', sessions: 4, evidenceAt: 1 },
  { id: 'q-three', type: 'multi-session', sessions: 4, evidenceAt: 2 },
  { id: 'q-four_abs', type: 'single-session-user', sessions: 3, evidenceAt: -1 },
]

function buildDataset(path: string): void {
  const records = QUESTIONS.map((question) => {
    const sessions = Array.from({ length: question.sessions }, (_, i) => {
      const evidence = i === question.evidenceAt
      return [
        {
          role: 'user',
          content: evidence
            ? `the cinder deploy window detail is ${EVIDENCE}, written down once`
            : `about the cinder deploy window, session ${i}: reviewers, offsets and timings`,
        },
        {
          role: 'assistant',
          content: `noted for the cinder deploy window (part ${i}) ` + 'checklist '.repeat(40),
          ...(evidence ? { has_answer: true } : {}),
        },
      ]
    })
    return {
      question_id: question.id,
      question: `what is the cinder deploy window detail (${question.id})?`,
      answer: `${EVIDENCE} is the cinder deploy window detail`,
      question_type: question.type,
      question_date: '2023/04/10 (Mon) 17:50',
      haystack_session_ids: sessions.map((_, i) => `sess-${question.id}-${i}`),
      haystack_dates: sessions.map(() => '2023/04/10 (Mon) 17:50'),
      haystack_sessions: sessions,
      answer_session_ids:
        question.evidenceAt >= 0 ? [`sess-${question.id}-${question.evidenceAt}`] : [`sess-${question.id}-0`],
    }
  })
  writeFileSync(path, JSON.stringify(records), 'utf8')
}

/** one user message is the judge call, two are the reader call; no socket involved */
function stubLlm(): { requests: LlmCall[]; transport: (call: LlmCall) => Promise<ChatResult> } {
  const requests: LlmCall[] = []
  return {
    requests,
    transport: async (call) => {
      requests.push(call)
      const text = call.messages.map((message) => message.content).join('\n')
      if (call.messages.length === 1) {
        const wantsAbstention = text.includes('unanswerable')
        const satisfied = wantsAbstention ? text.includes("I don't know") : text.includes('ANSWER-OK')
        return { content: satisfied ? 'yes' : 'no', model: call.model }
      }
      return { content: text.includes(EVIDENCE) ? 'ANSWER-OK' : "I don't know", model: call.model }
    },
  }
}

function suiteContext(dir: string, overrides: Partial<SuiteContext> = {}): SuiteContext {
  return {
    seed: 11,
    configs: resolveConfigs([]),
    vectors: 'fts',
    qa: true,
    outDir: dir,
    gitSha: 'testsha',
    buildHeader: (input) => buildHeader({ ...input, git: undefined }),
    log: () => {},
    ...overrides,
  }
}

interface ComparisonMetrics {
  pairs: Array<{ left: string; right: string; n: number; p: number }>
  comparable: boolean
  n_paired: number
  seed: number
}

describe('longmemeval report (stub llm, two readers)', () => {
  it('prints the paired comparison section with a mcnemar verdict and the bootstrap seed', async () => {
    const dir = tempDir()
    process.env.ENGRAM_LLM_BASE_URL = 'https://gateway.example.invalid/v1'
    process.env.ENGRAM_LLM_API_KEY = 'inert-fixture'
    process.env.ENGRAM_LLM_MODEL = 'test-model'
    resetGatewayForTests()
    setLlmTransport(stubLlm().transport)
    const datasetPath = join(dir, 'longmemeval_s_cleaned.json')
    buildDataset(datasetPath)

    const output = await runLongMemEvalSuite(
      suiteContext(dir, {
        dataset: 'longmemeval_s_cleaned',
        datasetPath,
        readers: READERS,
        readerModel: 'stub-reader',
        judgeModel: 'stub-judge',
        checkpointPath: join(dir, 'run.jsonl'),
        contextBudgetChars: 2000,
        concurrency: 2,
        yes: true,
        envFile: join(dir, 'no-such-env-file'),
      })
    )

    const metrics = output.result.metrics as Record<string, { qa: { comparison?: ComparisonMetrics } }>
    const comparison = metrics.baseline.qa.comparison
    expect(comparison).toBeDefined()
    expect(comparison!.comparable).toBe(true)
    expect(comparison!.n_paired).toBe(QUESTIONS.length)
    expect(comparison!.seed).toBe(11)
    expect(comparison!.pairs).toHaveLength(1)
    expect([comparison!.pairs[0].left, comparison!.pairs[0].right].sort()).toEqual([...READERS].sort())

    const markdown = output.markdown
    expect(markdown).toContain('### paired comparison')
    expect(markdown).toContain('bootstrap: seed 11, 10000 resamples')
    expect(markdown).toMatch(
      /engram vs full-context: [+-]\d+\.\d pts \(95% ci [+-]\d+\.\d to [+-]\d+\.\d\), mcnemar (p=[\d.]+|p<0\.001) \(b=\d+, c=\d+\)/
    )
    expect(markdown).toMatch(/significant at 0\.05/)
    expect(markdown).toContain('### pareto: accuracy vs cost')
    expect(markdown).toContain('mean ctx tokens')
    expect(markdown).toContain('p50 ms')
    // the latency columns are wall clock, so the paired block stays after the latency table
    expect(markdown.indexOf('### paired comparison')).toBeGreaterThan(
      markdown.indexOf('### latency')
    )
    expect(readFileSync(join(dir, 'run.jsonl'), 'utf8').trim().split('\n')).toHaveLength(
      QUESTIONS.length * READERS.length
    )
  }, 120_000)
})
