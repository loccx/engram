// report artifacts, at the frozen paths in EVAL-CONTRACT.md:
// eval/reports/<suite>-<configs>-<git-sha-short>.md and .json, plus the committed
// baseline pair. every artifact goes through redactSecrets(), so a stray prompt echo
// or error string cannot write a gateway credential into the repo.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactSecrets } from './llm.js'
import type { TokenizerInfo } from './metrics.js'
import type { ComparisonReport, LatencyPercentiles, PairStats } from './stats.js'
import type { RunHeader, SuiteResult, TimingSummary, VectorMode } from './types.js'

/** the checkout that contains eval/ */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function engramVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface HeaderInput {
  suite: string
  configs: string[]
  seed: number
  corpusHash: { short: string; full: string }
  vectorsAvailable: boolean
  vectorMode: VectorMode
  now: number
  tokenizer: TokenizerInfo
  featureFlags: Record<string, string>
  git?: GitInfo
}

/**
 * every field the contract requires in a header, including the ones that make a run
 * reproducible (git sha, seed, corpus hash, vectors, tokenizer) and the note on what
 * determinism covers
 */
export function buildHeader(input: HeaderInput): RunHeader {
  const git = input.git ?? currentGitInfo()
  return {
    suite: input.suite,
    configs: input.configs,
    seed: input.seed,
    gitSha: git.sha,
    gitShaShort: git.short + (git.dirty ? '-dirty' : ''),
    gitBranch: git.branch,
    corpusHash: input.corpusHash.short,
    corpusHashFull: input.corpusHash.full,
    vectorsAvailable: input.vectorsAvailable,
    vectorMode: input.vectorMode,
    tokenizer: input.tokenizer.name,
    now: input.now,
    nowIso: new Date(input.now).toISOString(),
    engramVersion: engramVersion(),
    nodeVersion: process.version,
    featureFlags: input.featureFlags,
    determinism: DETERMINISM_NOTE,
  }
}

export interface GitInfo {
  sha: string
  short: string
  branch: string
  dirty: boolean
}

export function currentGitInfo(cwd: string = process.cwd()): GitInfo {
  const run = (args: string[]): string => {
    try {
      const out = spawnSync('git', args, { cwd, encoding: 'utf8' })
      return out.status === 0 ? out.stdout.trim() : ''
    } catch {
      return ''
    }
  }
  const sha = run(['rev-parse', 'HEAD'])
  return {
    sha,
    short: sha ? sha.slice(0, 12) : 'nogit',
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: run(['status', '--porcelain']).length > 0,
  }
}

/** a stable slug for a config list: baseline, baseline+rerank-blend */
export function configSlug(names: string[]): string {
  return names.length === 0 ? 'baseline' : names.join('+')
}

export function reportFileName(
  suite: string,
  configs: string[],
  gitShaShort: string,
  suffix = ''
): string {
  return `${suite}-${[configSlug(configs), suffix, gitShaShort].filter(Boolean).join('-')}`
}

export function renderHeaderBlock(header: RunHeader, extras: Record<string, string> = {}): string {
  const rows: Array<[string, string]> = [
    ['suite', header.suite],
    ['configs', header.configs.join(', ')],
    ['seed', String(header.seed)],
    ['corpus hash', header.corpusHash],
    ['git sha', `${header.gitShaShort}${header.gitBranch ? ` (${header.gitBranch})` : ''}`],
    ['vectorsAvailable', String(header.vectorsAvailable)],
    ['vector mode', header.vectorMode],
    ['tokenizer', header.tokenizer],
    ['scoring clock', `${header.now} (${header.nowIso})`],
    ['engram version', header.engramVersion],
    ['node', header.nodeVersion],
    [
      'feature flags',
      Object.keys(header.featureFlags).length === 0
        ? '(none)'
        : Object.entries(header.featureFlags)
            .map(([k, v]) => `${k}=${v}`)
            .join(', '),
    ],
    ...Object.entries(extras),
  ]
  const width = Math.max(...rows.map(([k]) => k.length))
  const lines = rows.map(([k, v]) => `| ${k.padEnd(width)} | ${v} |`)
  return [
    `| field${' '.repeat(Math.max(0, width - 5))} | value |`,
    `| ${'-'.repeat(width)} | ${'-'.repeat(12)} |`,
    ...lines,
  ].join('\n')
}

export interface TableSpec {
  columns: string[]
  rows: Array<Array<string | number>>
}

export function markdownTable(spec: TableSpec): string {
  if (spec.rows.length === 0) return '_(no rows)_'
  const header = `| ${spec.columns.join(' | ')} |`
  const divider = `| ${spec.columns.map(() => '---').join(' | ')} |`
  const body = spec.rows.map((row) => `| ${row.map((c) => String(c)).join(' | ')} |`)
  return [header, divider, ...body].join('\n')
}

export interface WriteReportOptions {
  outDir: string
  /** file base without extension */
  fileBase: string
  /** the markdown body; this function prepends the header block */
  markdown: string
  /** the full per-query detail */
  json: unknown
}

export interface ReportPaths {
  md: string
  json: string
}

export function writeReport(options: WriteReportOptions): ReportPaths {
  mkdirSync(options.outDir, { recursive: true })
  const mdPath = join(options.outDir, `${options.fileBase}.md`)
  const jsonPath = join(options.outDir, `${options.fileBase}.json`)
  writeFileSync(mdPath, redactSecrets(options.markdown).text, 'utf8')
  writeFileSync(jsonPath, redactSecrets(`${JSON.stringify(options.json, null, 2)}\n`).text, 'utf8')
  return { md: mdPath, json: jsonPath }
}

/** header and metric tables for the aggregate baseline artifact */
export function renderSuiteSection(result: SuiteResult, body: string): string {
  return [
    `## suite: ${result.suite}`,
    '',
    renderHeaderBlock(result.header),
    '',
    body.trim(),
    '',
    result.notes.length > 0 ? `Notes:\n${result.notes.map((n) => `- ${n}`).join('\n')}` : '',
    '',
  ]
    .filter((part) => part !== '')
    .join('\n')
}

export function renderTimings(timings: Record<string, TimingSummary>): string {
  const names = Object.keys(timings).sort()
  if (names.length === 0) return '_(no timings)_'
  return markdownTable({
    columns: ['operation', 'n', 'p50 ms', 'p90 ms', 'p95 ms', 'p99 ms', 'max ms'],
    rows: names.map((name) => {
      const t = timings[name]
      return [name, t.count, t.p50Ms, t.p90Ms, t.p95Ms, t.p99Ms, t.maxMs]
    }),
  })
}

export const DETERMINISM_NOTE =
  'Determinism: metrics are a pure function of (corpus, seed, config, git sha); ' +
  'two runs with the same header produce identical metric values. Wall-clock timings ' +
  'are reported separately and are not covered by that guarantee.'

export interface ComparisonRenderOptions {
  /** wall clock per system; never part of the json metrics block */
  latencies?: Record<string, LatencyPercentiles>
}

/**
 * the paired-comparison block: does a difference survive its own noise, and what did
 * each system cost to get there. prose first, because "+3.2 pts, ci crossing zero" is
 * the sentence a reader needs before any table.
 */
export function renderComparisonReport(
  report: ComparisonReport,
  options: ComparisonRenderOptions = {}
): string {
  if (report.systems.length < 2) return ''
  if (!report.comparable) return renderWithheld(report)

  const sections: string[] = [
    `### paired comparison\n\n${comparisonHeader(report)}\n\n${guardLine(report)}`,
  ]
  const pairs = report.pairs.map((pair) => pairProse(pair, report.alpha))
  const unpaired = unpairedLines(report)
  sections.push([...pairs, ...unpaired].filter(Boolean).join('\n\n'))

  const typeRows = report.by_question_type.map((row) => [
    `${row.left} vs ${row.right}`,
    row.question_type,
    row.n,
    row.accuracy_left,
    row.accuracy_right,
    points(row.delta),
    `${points(row.delta_ci_low)} to ${points(row.delta_ci_high)}`,
    pValue(row.p),
    row.low_n ? `low n (${row.n} < 30)` : '',
  ])
  if (typeRows.length > 0) {
    sections.push(
      `### paired comparison by question_type\n\n${markdownTable({
        columns: [
          'pair',
          'question_type',
          'n',
          'accuracy left',
          'accuracy right',
          'delta pts',
          '95% ci',
          'mcnemar p',
          'flag',
        ],
        rows: typeRows,
      })}\n\nPer-type p-values are unadjusted: this is a breakdown, not another family of tests. ` +
        'A bucket under 30 paired questions is flagged; treat its delta as a direction, not a number.'
    )
  }

  const continuousRows = report.pairs.flatMap((pair) =>
    pair.continuous.map((stats) => [
      `${pair.left} vs ${pair.right}`,
      stats.metric,
      stats.n,
      stats.left_mean,
      stats.right_mean,
      stats.delta,
      `${stats.ci_low} to ${stats.ci_high}`,
    ])
  )
  if (continuousRows.length > 0) {
    sections.push(
      `### paired continuous metrics\n\n${markdownTable({
        columns: ['pair', 'metric', 'n', 'left mean', 'right mean', 'delta', '95% ci'],
        rows: continuousRows,
      })}\n\nPercentile 95% ci of the paired delta, seed ${report.seed}, ${report.resamples} resamples. ` +
        'Left and right follow the pair name; a metric a row does not carry is skipped for that metric only.'
    )
  }

  sections.push(renderPareto(report, options))
  return sections.filter((section) => section !== '').join('\n\n')
}

function renderWithheld(report: ComparisonReport): string {
  return [
    '### paired comparison',
    '',
    'comparison withheld: the rows are not comparable, so no delta is printed.',
    '',
    ...report.differences.map((difference) => `- ${difference}`),
    '',
    'Two accuracy numbers that disagree on a field above are not a measurement of either ' +
      'system; re-run both sides under the same dataset sha, models, prompt versions and budget.',
  ].join('\n')
}

function comparisonHeader(report: ComparisonReport): string {
  const first = report.systems[0]
  return (
    `bootstrap: seed ${report.seed}, ${report.resamples} resamples, percentile 95% ci. ` +
    `mcnemar: exact two-sided binomial on the discordant pairs, b = ${first} correct and the other wrong, ` +
    `c = the reverse. every number below stands on the ${report.n_paired} question(s) every system graded.`
  )
}

function guardLine(report: ComparisonReport): string {
  const fields = ['dataset sha', 'reader model', 'judge model', 'reader prompt', 'judge prompt', 'budget']
  const checked = fields.filter((field) => !report.unverified.includes(field))
  const line = `comparability: matched on ${checked.join(', ')}`
  return report.unverified.length === 0
    ? `${line}.`
    : `${line} — unchecked: ${report.unverified.join(', ')} (no field declared on both sides).`
}

function pairProse(pair: PairStats, alpha: number): string {
  const label = `${pair.left} vs ${pair.right}`
  if (pair.n === 0) return `${label}: no question graded by both systems, nothing to compare`
  const verdict = pair.significant
    ? `significant at ${alpha}`
    : `not significant at ${alpha}`
  const holm = pair.family > 1 ? `, holm over ${pair.family} pairs ${formatP(pair.holm_p)}` : ''
  return (
    `${label}: ${points(pair.delta)} pts (95% ci ${points(pair.delta_ci_low)} to ` +
    `${points(pair.delta_ci_high)}), mcnemar ${formatP(pair.p)} ` +
    `(b=${pair.mcnemar_b}, c=${pair.mcnemar_c})${holm} — ${verdict}`
  )
}

function unpairedLines(report: ComparisonReport): string[] {
  const lines: string[] = []
  for (const pair of report.pairs) {
    const label = `${pair.left} vs ${pair.right}`
    if (pair.only_right.length > 0) {
      lines.push(
        `${label}: ${pair.only_right.length} question(s) graded on ${pair.right} only ` +
          `(${listIds(pair.only_right)}) — unpaired, excluded from the stats above`
      )
    }
    if (pair.only_left.length > 0) {
      lines.push(
        `${label}: ${pair.only_left.length} question(s) graded on ${pair.left} only ` +
          `(${listIds(pair.only_left)}) — unpaired, excluded from the stats above`
      )
    }
  }
  for (const [system, count] of Object.entries(report.ungraded).sort()) {
    if (count > 0) lines.push(`${system}: ${count} row(s) without a verdict, excluded`)
  }
  return lines
}

function listIds(ids: string[]): string {
  return ids.length <= 5 ? ids.join(', ') : `${ids.slice(0, 5).join(', ')}, +${ids.length - 5} more`
}

function renderPareto(report: ComparisonReport, options: ComparisonRenderOptions): string {
  const latencies = options.latencies ?? {}
  const withLatency = report.pareto.some((point) => latencies[point.system] !== undefined)
  const withWriteCost = report.pareto.some((point) => point.write_llm_calls !== null)
  const columns = ['system', 'n', 'accuracy', 'mean ctx tokens', 'mean reader tokens']
  // model calls a system makes while writing, not store operations: engram makes none
  if (withWriteCost) columns.push('write llm calls', 'write llm tokens')
  if (withLatency) columns.push('p50 ms', 'p95 ms')
  columns.push('frontier')
  const rows = report.pareto.map((point) => {
    const latency = latencies[point.system]
    const row: Array<string | number> = [
      point.system,
      point.n,
      point.accuracy,
      point.mean_context_tokens,
      point.mean_reader_input_tokens,
    ]
    if (withWriteCost) {
      row.push(point.write_llm_calls ?? '-', point.write_llm_tokens ?? '-')
    }
    if (withLatency) row.push(latency?.p50Ms ?? '-', latency?.p95Ms ?? '-')
    row.push(point.frontier ? 'yes' : '-')
    return row
  })
  return (
    `### pareto: accuracy vs cost\n\n${markdownTable({ columns, rows })}\n\n` +
    `Frontier = nothing else matches or beats its accuracy at a lower cost axis ` +
    `(\`${report.cost_axis}\`), so a frontier row is the reason to pick a system at all. ` +
    'Costs are means over the same paired subset as the accuracy column; p50/p95 are wall clock ' +
    'for retrieval plus the reader call (the judge is the measuring instrument, so it is excluded) ' +
    'and vary per run.'
  )
}

/** points, one decimal: +3.2, -0.4, so a delta is never read as a fraction */
function points(value: number): string {
  const rounded = Math.round(value * 1000) / 10
  const magnitude = Math.abs(rounded) < 0.05 ? 0 : rounded
  return `${magnitude < 0 ? '-' : '+'}${Math.abs(magnitude).toFixed(1)}`
}

function formatP(p: number): string {
  return p < 0.001 ? 'p<0.001' : `p=${pValue(p)}`
}

function pValue(p: number): string {
  return p < 0.001 ? '<0.001' : String(Math.round(p * 1000) / 1000)
}
