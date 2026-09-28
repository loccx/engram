// thresholds for --assert (ci gating). a threshold file comes from a baseline run
// (`npx tsx eval/run.ts --suite all --write-thresholds`), where every entry is the
// baseline value minus a margin: a regression gate, not a quality claim, so a change
// cannot silently make retrieval worse than the committed baseline.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { round3 } from './metrics.js'
import { REPO_ROOT } from './report.js'
import type { MetricBlock } from './score.js'

export const THRESHOLDS_PATH = join(REPO_ROOT, 'eval', 'thresholds.json')

/** a baseline value minus 10% */
export const DEFAULT_MARGIN = 0.1

export interface ThresholdFile {
  note: string
  margin: number
  generated_at_sha?: string
  suites: Record<string, Record<string, Record<string, number>>>
}

/**
 * flat numeric view of a metric block, so a threshold path is one key (`recall@10`)
 */
export function topLineFromBlock(block: MetricBlock, ks: number[]): Record<string, number> {
  const out: Record<string, number> = {
    queries: block.queries,
    hits: block.hits,
    targets: block.targets,
    mrr: block.mrr,
    leakRate: block.leakRate,
    staleRate: block.staleRate,
    servedTokens: block.servedTokens,
    tokensPerQuery: block.tokensPerQuery,
    tokensPerChar: block.tokensPerChar,
  }
  for (const k of ks) {
    out[`recall@${k}`] = block[`recall@${k}`] ?? 0
    out[`ndcg@${k}`] = block[`ndcg@${k}`] ?? 0
    out[`precision@${k}`] = block[`precision@${k}`] ?? 0
  }
  return out
}

/** which metrics a threshold file may gate */
const GATED_METRICS = [
  'recall@1',
  'recall@5',
  'recall@10',
  'ndcg@10',
  'mrr',
  'precision@10',
  'leakRate',
  'staleRate',
  'fidelity',
  'candidateRecall',
  'qaAccuracy',
]

/**
 * invariants rather than scores: no margin is applied, so --assert fails the moment
 * one moves. leakRate is the namespace isolation guarantee — a corpus that leaks is a
 * bug, not a regression.
 */
const INVARIANT_METRICS = new Set(['leakRate'])

/** smaller is better here, so they gate from above */
const LOWER_IS_BETTER = new Set(['leakRate', 'staleRate', 'budgetViolations'])

export function loadThresholds(path: string = THRESHOLDS_PATH): ThresholdFile | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ThresholdFile
  } catch {
    return null
  }
}

export interface ThresholdFailure {
  suite: string
  config: string
  metric: string
  threshold: number
  actual: number
}

/**
 * compare the run against the recorded thresholds; a lower-is-better metric
 * (leakRate, staleRate) gates from above
 */
export function evaluateThresholds(
  file: ThresholdFile | null,
  suites: Record<string, Record<string, Record<string, number>>>
): { checked: number; failures: ThresholdFailure[] } {
  const failures: ThresholdFailure[] = []
  let checked = 0
  if (!file) return { checked, failures }
  for (const [suite, perConfig] of Object.entries(suites)) {
    const recorded = file.suites[suite]
    if (!recorded) continue
    for (const [config, metrics] of Object.entries(perConfig)) {
      const limits = recorded[config]
      if (!limits) continue
      for (const [metric, threshold] of Object.entries(limits)) {
        const actual = metrics[metric]
        if (typeof actual !== 'number') continue
        checked++
        const failed = LOWER_IS_BETTER.has(metric) ? actual > threshold : actual < threshold
        if (failed) failures.push({ suite, config, metric, threshold, actual })
      }
    }
  }
  return { checked, failures }
}

export interface ThresholdBuildInput {
  suites: Record<string, Record<string, Record<string, number>>>
  margin?: number
  gitSha?: string
}

/** the baseline value minus the margin, floored at 0 */
export function buildThresholds(input: ThresholdBuildInput): ThresholdFile {
  const margin = input.margin ?? DEFAULT_MARGIN
  const out: ThresholdFile = {
    note:
      'Generated from a baseline run: each value is (measured - margin), floored at 0. ' +
      'Lower-is-better metrics (leakRate, staleRate) are recorded as measured + margin ' +
      'instead, and gate from above. Regenerate with `npx tsx eval/run.ts --suite all ' +
      '--write-thresholds`; see eval/README.md.',
    margin,
    generated_at_sha: input.gitSha,
    suites: {},
  }
  for (const [suite, perConfig] of Object.entries(input.suites)) {
    out.suites[suite] = {}
    for (const [config, metrics] of Object.entries(perConfig)) {
      const limits: Record<string, number> = {}
      for (const metric of GATED_METRICS) {
        const value = metrics[metric]
        if (typeof value !== 'number') continue
        if (INVARIANT_METRICS.has(metric)) {
          // recorded exactly: any movement fails the gate
          limits[metric] = round3(value)
          continue
        }
        limits[metric] = LOWER_IS_BETTER.has(metric)
          ? round3(Math.min(1, value + margin))
          : round3(Math.max(0, value * (1 - margin)))
      }
      out.suites[suite][config] = limits
    }
  }
  return out
}

export function writeThresholds(file: ThresholdFile, path: string = THRESHOLDS_PATH): string {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  return path
}

export function formatFailures(failures: ThresholdFailure[]): string[] {
  return failures.map(
    (f) =>
      `${f.suite}/${f.config}: ${f.metric} = ${f.actual} is outside the recorded threshold ${f.threshold}`
  )
}
