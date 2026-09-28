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
