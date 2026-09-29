// paired statistics for a report: exact mcnemar on the discordant pairs, a seeded
// paired bootstrap for the accuracy and cost deltas, holm across a family of pairs, a
// pareto frontier on (accuracy, tokens) and the guard that refuses to compare rows which
// disagree on the fields a comparison stands on. pure: same input, same output, and the
// only randomness is a seeded prng whose seed is recorded in the report. the numeric
// distance between two systems is meaningless unless they answered the same question ids
// under the same judge, so the pairing key is the question id and nothing else.
import { mean, round3 } from './metrics.js'

export const DEFAULT_RESAMPLES = 10_000
export const DEFAULT_ALPHA = 0.05
/** a per-type bucket below this many paired questions is flagged, not silently read */
export const LOW_N_THRESHOLD = 30

/** the fields a row must carry to enter the paired stats; everything else is optional */
export interface StatsRow {
  question_id: string
  question_type?: string
  correct?: boolean
  /** per-question retrieval recall map, `recall@5` style keys */
  recall?: Record<string, number>
  mrr?: number
  servedTokens?: number
  served_tokens?: number
  context_tokens?: number
  input_tokens?: number
  write_llm_calls?: number
  write_llm_tokens?: number
  retrieval_ms?: number
  reader_ms?: number
  reader_model?: string
  judge_model?: string
  reader_prompt?: string
  judge_prompt?: string
  dataset_sha?: string
  budget_chars?: number
  [field: string]: unknown
}

/** what makes two accuracy numbers comparable */
export interface RunIdentity {
  dataset_sha?: string
  reader_model?: string
  judge_model?: string
  reader_prompt?: string
  judge_prompt?: string
  budget_chars?: number
}

export interface SystemInput {
  name: string
  rows: StatsRow[]
  /** per-system identity; falls back to the run identity and then to the rows */
  identity?: RunIdentity
}

export interface MetricSpec {
  name: string
  /** undefined when the row does not carry it, which excludes the pair from that metric */
  value: (row: StatsRow) => number | undefined
}

export const CONTINUOUS_METRICS: MetricSpec[] = [
  { name: 'recall@5', value: (row) => row.recall?.['recall@5'] },
  { name: 'recall@10', value: (row) => row.recall?.['recall@10'] },
  { name: 'mrr', value: (row) => num(row.mrr) },
  { name: 'served tokens', value: (row) => num(row.servedTokens) ?? num(row.served_tokens) },
  { name: 'context tokens', value: (row) => num(row.context_tokens) },
  { name: 'reader input tokens', value: (row) => num(row.input_tokens) },
]

export interface Rng {
  seed: number
  next: () => number
  index: (n: number) => number
}

/** mulberry32: 32-bit state, reproducible across node versions and platforms */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    seed: state,
    next,
    // a prng hitting exactly 1.0 would index past the end
    index: (n) => (n <= 0 ? 0 : Math.min(n - 1, Math.floor(next() * n))),
  }
}

/** fnv-1a of `label:seed`, so one metric's stream cannot shift when another is added */
export function seedFor(seed: number, label: string): number {
  let hash = 2166136261
  for (const ch of `${label}:${seed}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619)
  return hash >>> 0
}

export interface McNemar {
  /** pairs where the left system was right and the right system was wrong */
  b: number
  /** the reverse */
  c: number
  discordant: number
  p: number
}

export function mcnemarExact(b: number, c: number): McNemar {
  const n = b + c
  return { b, c, discordant: n, p: exactBinomialTwoSided(Math.min(b, c), n) }
}

/**
 * two-sided exact p for `k` successes in `n` trials at p=0.5: twice the smaller tail,
 * capped at 1. the chi-square form is an approximation and reports p=0 for small
 * discordant counts, which is the case a small eval run always has.
 */
export function exactBinomialTwoSided(k: number, n: number): number {
  if (n <= 0) return 1
  return Math.min(1, 2 * binomialTail(k, n))
}

/** the chance of at most k successes in n trials at p=0.5, accumulated in log space so a long run does not underflow */
function binomialTail(k: number, n: number): number {
  const limit = Math.max(0, Math.min(k, n))
  let logP = -n * Math.LN2
  let sum = Math.exp(logP)
  for (let i = 1; i <= limit; i++) {
    logP += Math.log(n - i + 1) - Math.log(i)
    sum += Math.exp(logP)
  }
  return Math.min(1, sum)
}

export interface BootstrapDelta {
  n: number
  delta: number
  ci_low: number
  ci_high: number
  resamples: number
  /** the base seed, the one the report prints */
  seed: number
}

export interface BootstrapOptions {
  seed: number
  resamples?: number
  alpha?: number
  label?: string
}

/**
 * percentile ci for the mean of a-reduced-by-b over resampled pair indices: the same
 * question ids on both sides, so the resample keeps the pairing that the variance of a
 * difference depends on.
 */
export function pairedBootstrapDelta(
  a: number[],
  b: number[],
  options: BootstrapOptions
): BootstrapDelta {
  if (a.length !== b.length) {
    throw new Error(
      `paired bootstrap needs two equal-length sides, got ${a.length} and ${b.length}`
    )
  }
  const n = a.length
  const resamples = Math.max(1, options.resamples ?? DEFAULT_RESAMPLES)
  const alpha = options.alpha ?? DEFAULT_ALPHA
  const rng = makeRng(seedFor(options.seed, options.label ?? 'delta'))
  const samples: number[] = []
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      const index = rng.index(n)
      sum += a[index] - b[index]
    }
    samples.push(n === 0 ? 0 : sum / n)
  }
  samples.sort((x, y) => x - y)
  return {
    n,
    delta: n === 0 ? 0 : mean(a) - mean(b),
    ci_low: quantile(samples, alpha / 2),
    ci_high: quantile(samples, 1 - alpha / 2),
    resamples,
    seed: options.seed,
  }
}

/** linear-interpolated quantile, p a fraction */
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const clamped = Math.min(1, Math.max(0, p))
  const at = (sorted.length - 1) * clamped
  const low = Math.floor(at)
  const high = Math.ceil(at)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low)
}

export interface HolmTest {
  label: string
  p: number
}

export interface HolmResult {
  label: string
  p: number
  /** 1 = smallest p in the family */
  rank: number
  /** step-down adjusted p, monotone in the rank */
  adjusted: number
  rejected: boolean
}

/** holm step-down over a family of p-values, returned in the caller's order */
export function holmCorrection(tests: HolmTest[], alpha = DEFAULT_ALPHA): HolmResult[] {
  const m = tests.length
  const order = tests
    .map((test, index) => ({ ...test, index }))
    .sort((x, y) => (x.p !== y.p ? x.p - y.p : x.label < y.label ? -1 : x.label > y.label ? 1 : 0))
  const out: HolmResult[] = new Array(m)
  let running = 0
  order.forEach((test, rank) => {
    const adjusted = Math.min(1, Math.max(running, (m - rank) * test.p))
    running = adjusted
    out[test.index] = {
      label: test.label,
      p: test.p,
      rank: rank + 1,
      adjusted,
      rejected: adjusted <= alpha,
    }
  })
  return out
}

export interface Comparability {
  comparable: boolean
  /** `field: left value vs right value`, for every field both sides declare and disagree on */
  differences: string[]
  /** fields only one side declares: not a refusal, but the report says it is unchecked */
  unverified: string[]
}

const IDENTITY_FIELDS: Array<{ key: keyof RunIdentity; label: string }> = [
  { key: 'dataset_sha', label: 'dataset sha' },
  { key: 'reader_model', label: 'reader model' },
  { key: 'judge_model', label: 'judge model' },
  { key: 'reader_prompt', label: 'reader prompt' },
  { key: 'judge_prompt', label: 'judge prompt' },
  { key: 'budget_chars', label: 'budget' },
]

export function checkComparability(left: RunIdentity, right: RunIdentity): Comparability {
  const differences: string[] = []
  const unverified: string[] = []
  for (const { key, label } of IDENTITY_FIELDS) {
    const a = left[key]
    const b = right[key]
    if (a === undefined && b === undefined) continue
    if (a === undefined || b === undefined) {
      unverified.push(label)
      continue
    }
    if (a !== b) differences.push(`${label}: ${a} vs ${b}`)
  }
  return { comparable: differences.length === 0, differences, unverified }
}

export interface ContinuousStats {
  metric: string
  n: number
  left_mean: number
  right_mean: number
  delta: number
  ci_low: number
  ci_high: number
  /** pairs where the metric is missing on one side */
  skipped: number
}

export interface PairStats {
  left: string
  right: string
  n: number
  accuracy_left: number
  accuracy_right: number
  delta: number
  delta_ci_low: number
  delta_ci_high: number
  mcnemar_b: number
  mcnemar_c: number
  discordant: number
  p: number
  /** holm-adjusted p over the whole pair family */
  holm_p: number
  family: number
  significant: boolean
  /** graded on the left only, and the reverse: reported, never folded into the stats */
  only_left: string[]
  only_right: string[]
  continuous: ContinuousStats[]
}

export interface CategoryStats {
  left: string
  right: string
  question_type: string
  n: number
  accuracy_left: number
  accuracy_right: number
  delta: number
  delta_ci_low: number
  delta_ci_high: number
  mcnemar_b: number
  mcnemar_c: number
  p: number
  /** fewer than LOW_N_THRESHOLD paired questions: exploratory only */
  low_n: boolean
}

export interface ParetoPoint {
  system: string
  /** questions every system graded, the subset the point stands on */
  n: number
  accuracy: number
  mean_context_tokens: number
  mean_reader_input_tokens: number
  write_llm_calls: number | null
  write_llm_tokens: number | null
  frontier: boolean
}

export interface ComparisonReport {
  systems: string[]
  seed: number
  resamples: number
  alpha: number
  comparable: boolean
  differences: string[]
  unverified: string[]
  /** questions every system graded */
  n_paired: number
  /** rows a system carries without a boolean verdict */
  ungraded: Record<string, number>
  /** which token axis the frontier uses */
  cost_axis: string
  pairs: PairStats[]
  by_question_type: CategoryStats[]
  pareto: ParetoPoint[]
}

export interface ComparisonInput {
  systems: SystemInput[]
  /** dataset sha and budget live on the run, not on a row */
  runIdentity?: RunIdentity
  seed: number
  resamples?: number
  alpha?: number
  metrics?: MetricSpec[]
}

export function compareSystems(input: ComparisonInput): ComparisonReport {
  const systems = input.systems.filter((system) => system.rows.length > 0)
  const seed = input.seed
  const resamples = input.resamples ?? DEFAULT_RESAMPLES
  const alpha = input.alpha ?? DEFAULT_ALPHA
  const metrics = input.metrics ?? CONTINUOUS_METRICS

  const identities = systems.map((system) =>
    rowIdentity(system.rows, { ...input.runIdentity, ...system.identity })
  )
  const differences: string[] = []
  const unverified = new Set<string>()
  for (let i = 1; i < systems.length; i++) {
    const guard = checkComparability(identities[0], identities[i])
    for (const difference of guard.differences) {
      differences.push(`${systems[i].name} vs ${systems[0].name}: ${difference}`)
    }
    for (const field of guard.unverified) unverified.add(field)
  }
  const comparable = differences.length === 0

  const graded = new Map<string, Map<string, StatsRow>>()
  const ungraded: Record<string, number> = {}
  for (const system of systems) {
    const byId = new Map<string, StatsRow>()
    let skipped = 0
    for (const row of system.rows) {
      if (typeof row.correct !== 'boolean') {
        skipped++
        continue
      }
      byId.set(row.question_id, row)
    }
    graded.set(system.name, byId)
    ungraded[system.name] = skipped
  }

  const idLists = systems.map((system) => [...(graded.get(system.name) ?? new Map()).keys()])
  const common =
    idLists.length === 0
      ? []
      : idLists[0].filter((id) => idLists.every((list) => list.includes(id))).sort()

  const pairs: PairStats[] = []
  const byType: CategoryStats[] = []
  for (let i = 0; i < systems.length; i++) {
    for (let j = i + 1; j < systems.length; j++) {
      const left = graded.get(systems[i].name) ?? new Map<string, StatsRow>()
      const right = graded.get(systems[j].name) ?? new Map<string, StatsRow>()
      const pair = pairStats({
        leftName: systems[i].name,
        rightName: systems[j].name,
        left,
        right,
        seed,
        resamples,
        alpha,
        metrics,
      })
      pairs.push(pair.stats)
      byType.push(
        ...categoryStats({
          leftName: systems[i].name,
          rightName: systems[j].name,
          left,
          right,
          shared: pair.shared,
          seed,
          resamples,
          alpha,
        })
      )
    }
  }
  applyHolm(pairs, alpha)

  const costAxis = systems.some((system) => hasContextTokens(graded.get(system.name))) 
    ? 'mean context tokens'
    : 'mean reader input tokens'
  const pareto = systems.map((system) => {
    const rows = common
      .map((id) => graded.get(system.name)?.get(id))
      .filter((row): row is StatsRow => row !== undefined)
    const correct = rows.filter((row) => row.correct === true).length
    const context = numbers(rows.map((row) => num(row.context_tokens)))
    const reader = numbers(rows.map((row) => num(row.input_tokens)))
    const writeCalls = numbers(rows.map((row) => num(row.write_llm_calls)))
    const writeTokens = numbers(rows.map((row) => num(row.write_llm_tokens)))
    return {
      system: system.name,
      n: rows.length,
      accuracy: round3(rows.length === 0 ? 0 : correct / rows.length),
      mean_context_tokens: round3(mean(context)),
      mean_reader_input_tokens: round3(mean(reader)),
      write_llm_calls: writeCalls.length === 0 ? null : round3(mean(writeCalls)),
      write_llm_tokens: writeTokens.length === 0 ? null : round3(mean(writeTokens)),
      frontier: false,
    }
  })
  const flags = frontierFlags(
    pareto.map((point) => ({
      accuracy: point.accuracy,
      cost: costAxis === 'mean context tokens' ? point.mean_context_tokens : point.mean_reader_input_tokens,
    }))
  )
  pareto.forEach((point, i) => {
    point.frontier = flags[i]
  })

  return {
    systems: systems.map((system) => system.name),
    seed,
    resamples,
    alpha,
    comparable,
    differences,
    unverified: [...unverified].sort(),
    n_paired: common.length,
    ungraded,
    cost_axis: costAxis,
    pairs: comparable ? pairs : [],
    by_question_type: comparable ? byType : [],
    pareto: comparable ? pareto : [],
  }
}

/**
 * a point is on the frontier when no other point matches or beats its accuracy at no
 * higher cost: the read is accuracy up, tokens down, never one column alone
 */
export function frontierFlags(points: Array<{ accuracy: number; cost: number }>): boolean[] {
  return points.map((point, i) =>
    points.every((other, j) => {
      if (i === j) return true
      const noWorse = other.accuracy >= point.accuracy && other.cost <= point.cost
      const better = other.accuracy > point.accuracy || other.cost < point.cost
      return !(noWorse && better)
    })
  )
}

export interface LatencyPercentiles {
  p50Ms: number
  p95Ms: number
  n: number
}

/**
 * wall clock for one system's answer path (retrieval + reader call, judge excluded
 * because it is the measuring instrument). wall clock is never part of the json metrics
 * block, so a report stays reproducible without it.
 */
export function answerLatency(rows: StatsRow[]): LatencyPercentiles | null {
  const values: number[] = []
  for (const row of rows) {
    const retrieval = num(row.retrieval_ms)
    const reader = num(row.reader_ms)
    if (retrieval === undefined || reader === undefined) continue
    values.push(retrieval + reader)
  }
  if (values.length === 0) return null
  values.sort((a, b) => a - b)
  return { p50Ms: round3(quantile(values, 0.5)), p95Ms: round3(quantile(values, 0.95)), n: values.length }
}

interface PairArgs {
  leftName: string
  rightName: string
  left: Map<string, StatsRow>
  right: Map<string, StatsRow>
  seed: number
  resamples: number
  alpha: number
  metrics: MetricSpec[]
}

/** pair stats plus the shared ids, so the per-type pass reuses one pairing decision */
interface PairComputation {
  stats: PairStats
  shared: string[]
}

function pairStats(args: PairArgs): PairComputation {
  const shared = [...args.left.keys()].filter((id) => args.right.has(id)).sort()
  const onlyLeft = [...args.left.keys()].filter((id) => !args.right.has(id)).sort()
  const onlyRight = [...args.right.keys()].filter((id) => !args.left.has(id)).sort()
  const binary = binaryCounts(shared, args.left, args.right)
  const n = shared.length
  const label = `${args.leftName}|${args.rightName}`
  const bootstrap = pairedBootstrapDelta(binary.left, binary.right, {
    seed: args.seed,
    resamples: args.resamples,
    alpha: args.alpha,
    label: `${label}|accuracy`,
  })
  const test = mcnemarExact(binary.b, binary.c)
  return {
    shared,
    stats: {
      left: args.leftName,
      right: args.rightName,
      n,
      accuracy_left: round3(n === 0 ? 0 : binary.correctLeft / n),
      accuracy_right: round3(n === 0 ? 0 : binary.correctRight / n),
      delta: round3(bootstrap.delta),
      delta_ci_low: round3(bootstrap.ci_low),
      delta_ci_high: round3(bootstrap.ci_high),
      mcnemar_b: binary.b,
      mcnemar_c: binary.c,
      discordant: test.discordant,
      p: roundP(test.p),
      holm_p: roundP(test.p),
      family: 1,
      significant: false,
      only_left: onlyLeft,
      only_right: onlyRight,
      continuous: continuousStats({
        shared,
        left: args.left,
        right: args.right,
        metrics: args.metrics,
        seed: args.seed,
        resamples: args.resamples,
        alpha: args.alpha,
        label,
      }),
    },
  }
}

function binaryCounts(
  shared: string[],
  left: Map<string, StatsRow>,
  right: Map<string, StatsRow>
): { correctLeft: number; correctRight: number; b: number; c: number; left: number[]; right: number[] } {
  let correctLeft = 0
  let correctRight = 0
  let b = 0
  let c = 0
  const leftVector: number[] = []
  const rightVector: number[] = []
  for (const id of shared) {
    const okLeft = left.get(id)?.correct === true
    const okRight = right.get(id)?.correct === true
    if (okLeft) correctLeft++
    if (okRight) correctRight++
    if (okLeft && !okRight) b++
    if (!okLeft && okRight) c++
    leftVector.push(okLeft ? 1 : 0)
    rightVector.push(okRight ? 1 : 0)
  }
  return { correctLeft, correctRight, b, c, left: leftVector, right: rightVector }
}

function continuousStats(args: {
  shared: string[]
  left: Map<string, StatsRow>
  right: Map<string, StatsRow>
  metrics: MetricSpec[]
  seed: number
  resamples: number
  alpha: number
  label: string
}): ContinuousStats[] {
  const out: ContinuousStats[] = []
  for (const metric of args.metrics) {
    const a: number[] = []
    const b: number[] = []
    for (const id of args.shared) {
      const leftRow = args.left.get(id)
      const rightRow = args.right.get(id)
      if (!leftRow || !rightRow) continue
      const x = metric.value(leftRow)
      const y = metric.value(rightRow)
      if (x === undefined || y === undefined) continue
      a.push(x)
      b.push(y)
    }
    if (a.length === 0) continue
    const bootstrap = pairedBootstrapDelta(a, b, {
      seed: args.seed,
      resamples: args.resamples,
      alpha: args.alpha,
      label: `${args.label}|${metric.name}`,
    })
    out.push({
      metric: metric.name,
      n: a.length,
      left_mean: round3(mean(a)),
      right_mean: round3(mean(b)),
      delta: round3(bootstrap.delta),
      ci_low: round3(bootstrap.ci_low),
      ci_high: round3(bootstrap.ci_high),
      skipped: args.shared.length - a.length,
    })
  }
  return out
}

function categoryStats(args: {
  leftName: string
  rightName: string
  left: Map<string, StatsRow>
  right: Map<string, StatsRow>
  shared: string[]
  seed: number
  resamples: number
  alpha: number
}): CategoryStats[] {
  const byType = new Map<string, string[]>()
  for (const id of args.shared) {
    const type = str(args.left.get(id)?.question_type) ?? 'unknown'
    const list = byType.get(type) ?? []
    list.push(id)
    byType.set(type, list)
  }
  const out: CategoryStats[] = []
  for (const type of [...byType.keys()].sort()) {
    const ids = byType.get(type) ?? []
    const binary = binaryCounts(ids, args.left, args.right)
    const bootstrap = pairedBootstrapDelta(binary.left, binary.right, {
      seed: args.seed,
      resamples: args.resamples,
      alpha: args.alpha,
      label: `${args.leftName}|${args.rightName}|${type}`,
    })
    out.push({
      left: args.leftName,
      right: args.rightName,
      question_type: type,
      n: ids.length,
      accuracy_left: round3(ids.length === 0 ? 0 : binary.correctLeft / ids.length),
      accuracy_right: round3(ids.length === 0 ? 0 : binary.correctRight / ids.length),
      delta: round3(bootstrap.delta),
      delta_ci_low: round3(bootstrap.ci_low),
      delta_ci_high: round3(bootstrap.ci_high),
      mcnemar_b: binary.b,
      mcnemar_c: binary.c,
      p: roundP(mcnemarExact(binary.b, binary.c).p),
      low_n: ids.length < LOW_N_THRESHOLD,
    })
  }
  return out
}

function applyHolm(pairs: PairStats[], alpha: number): void {
  if (pairs.length === 0) return
  if (pairs.length === 1) {
    pairs[0].significant = pairs[0].p <= alpha
    return
  }
  const adjusted = holmCorrection(
    pairs.map((pair) => ({ label: `${pair.left} vs ${pair.right}`, p: pair.p })),
    alpha
  )
  pairs.forEach((pair, i) => {
    pair.holm_p = roundP(adjusted[i].adjusted)
    pair.family = pairs.length
    pair.significant = adjusted[i].rejected
  })
}

function rowIdentity(rows: StatsRow[], fallback: RunIdentity): RunIdentity {
  const out: RunIdentity = { ...fallback }
  for (const row of rows) {
    out.dataset_sha ??= str(row.dataset_sha)
    out.reader_model ??= str(row.reader_model)
    out.judge_model ??= str(row.judge_model)
    out.reader_prompt ??= str(row.reader_prompt)
    out.judge_prompt ??= str(row.judge_prompt)
    out.budget_chars ??= num(row.budget_chars)
  }
  return out
}

function hasContextTokens(rows: Map<string, StatsRow> | undefined): boolean {
  if (!rows) return false
  for (const row of rows.values()) if (num(row.context_tokens) !== undefined) return true
  return false
}

function numbers(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => value !== undefined)
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 6 decimals: a p-value of 1e-4 must not round to 0 */
function roundP(p: number): number {
  return Math.round(p * 1e6) / 1e6
}
