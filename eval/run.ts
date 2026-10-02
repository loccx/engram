#!/usr/bin/env node
// eval cli (frozen interface, EVAL-CONTRACT.md):
//   npx tsx eval/run.ts --suite <suite> [--configs baseline,<name>,...] [--seed 1234]
//                       [--limit N] [--out eval/reports] [--json] [--assert]
// suites: retrieval | contradiction | budget | ab | longmemeval | all. offline by
// default — no network, no llm key, and with the default `--vectors fts` no vectors —
// so `npm run eval` is reproducible on any checkout.
import { Command } from 'commander'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { configLoadErrors, configNames, resolveConfigs } from './lib/registry.js'
import {
  buildHeader,
  currentGitInfo,
  renderSuiteSection,
  reportFileName,
  REPO_ROOT,
  writeReport,
  type GitInfo,
} from './lib/report.js'
import {
  buildThresholds,
  evaluateThresholds,
  formatFailures,
  loadThresholds,
  THRESHOLDS_PATH,
  writeThresholds,
} from './lib/thresholds.js'
import { redactSecrets } from './lib/llm.js'
import { engineRevisionIdentity } from './lib/run-identity.js'
import { DEFAULT_SPLIT } from './suites/longmemeval.js'
import { SUITES, suiteNames } from './suites/index.js'
import { defaultSystemNames, systemNames, systemSpecSlug } from './lib/systems.js'
import { DatasetMissingError, EvalSetupError } from './lib/errors.js'
import type { SuiteContext, SuiteOutput } from './suites/types.js'
import type { VectorMode } from './lib/types.js'

type SuiteName = string

interface CliOptions {
  suite: string
  configs?: string
  seed: string
  limit?: string
  out: string
  json?: boolean
  assert?: boolean
  vectors: string
  corpus?: string
  qa?: boolean
  verdicts?: string
  dataset?: string
  datasetPath?: string
  questionType?: string
  systems?: string
  readers?: string
  concurrency?: string
  checkpoint?: string
  yes?: boolean
  readerModel?: string
  judgeModel?: string
  contextBudgetChars?: string
  costCeilingCalls?: string
  baseline?: boolean
  writeThresholds?: boolean
  quiet?: boolean
}

const program = new Command()
program
  .name('engram-eval')
  .description('Retrieval / contradiction / budget measurement harness for engram')
  .option('--suite <suite>', `one of ${suiteNames().join('|')}|all`, 'all')
  .option('--configs <list>', 'comma-separated config names (default: baseline)', 'baseline')
  .option('--seed <n>', 'corpus seed', '1234')
  .option('--limit <n>', 'per-query result limit (longmemeval: question count)')
  .option('--out <dir>', 'report directory', join('eval', 'reports'))
  .option('--json', 'print the full JSON payload to stdout')
  .option('--assert', 'exit non-zero when a recorded threshold is missed')
  .option('--vectors <mode>', 'fts (default) | cached | on', 'fts')
  .option('--corpus <list>', 'corpus override; suite-specific (retrieval: names, budget: grid)')
  .option('--qa', `longmemeval: run the readers + judge (needs the gateway and pinned models)`)
  .option('--verdicts <path>', 'contradiction: use recorded verdicts instead of the gateway')
  .option('--dataset <split>', `longmemeval split name (default ${DEFAULT_SPLIT})`)
  .option('--dataset-path <path>', 'longmemeval: explicit dataset file (skips the manifest lookup)')
  .option('--question-type <list>', 'longmemeval: keep only these question_type values (comma-separated)')
  .option(
    '--systems <list>',
    `longmemeval: ${systemNames().join('|')}, or mcp:<adapter-config-path> (default: every builtin)`
  )
  .option('--readers <list>', 'alias of --systems')
  .option('--concurrency <n>', 'longmemeval --qa: questions in flight (default 2)')
  .option('--checkpoint <path>', 'longmemeval --qa: append-only jsonl; completed rows are skipped')
  .option('--yes', 'confirm the pre-run cost estimate when it is above the call ceiling')
  .option('--reader-model <name>', 'longmemeval --qa: pinned reader model (recorded on every row)')
  .option('--judge-model <name>', 'longmemeval --qa: pinned judge model (recorded on every row)')
  .option('--context-budget-chars <n>', 'longmemeval --qa: context budget for engram / naive-rag')
  .option('--cost-ceiling-calls <n>', 'longmemeval --qa: estimated calls above which --yes is required')
  .option('--baseline', 'also write the aggregate eval/reports/BASELINE.md and BASELINE.json')
  .option('--write-thresholds', 'regenerate eval/thresholds.json from this run')
  .option('--quiet', 'suppress per-suite markdown on stdout')
  .parse(process.argv)

const options = program.opts<CliOptions>()

async function main(): Promise<number> {
  const requestedSuite = options.suite
  if (requestedSuite !== 'all' && !suiteNames().includes(requestedSuite)) {
    throw new Error(`unknown suite "${requestedSuite}" — expected ${suiteNames().join('|')}|all`)
  }
  const vectorMode = normalizeVectorMode(options.vectors)
  const seed = Number.parseInt(options.seed, 10)
  if (!Number.isFinite(seed)) throw new Error(`--seed must be an integer, got "${options.seed}"`)
  const limit = options.limit === undefined ? undefined : Number.parseInt(options.limit, 10)
  if (options.limit !== undefined && !Number.isFinite(limit)) {
    throw new Error(`--limit must be an integer, got "${options.limit}"`)
  }
  const concurrency = optionalInt(options.concurrency, '--concurrency')
  const contextBudgetChars = optionalInt(options.contextBudgetChars, '--context-budget-chars')
  const costCeilingCalls = optionalInt(options.costCeilingCalls, '--cost-ceiling-calls')

  const configsExplicit = options.configs !== undefined && options.configs.trim() !== ''
  const requestedConfigs = configsExplicit
    ? options.configs!.split(',').map((c) => c.trim()).filter(Boolean)
    : ['baseline']
  const configs = resolveConfigs(requestedConfigs)
  const outputDir = isAbsolute(options.out) ? options.out : join(REPO_ROOT, options.out)
  mkdirSync(outputDir, { recursive: true })

  const git: GitInfo = currentGitInfo(REPO_ROOT)
  const corpora = options.corpus
    ? options.corpus.split(',').map((c) => c.trim()).filter(Boolean)
    : undefined
  const systemsOption = splitList(options.systems)
  const readersOption = splitList(options.readers)
  if (systemsOption && readersOption) {
    throw new EvalSetupError('pass --systems or its alias --readers, not both')
  }
  const systems = systemsOption ?? readersOption

  const ctxBase: Omit<SuiteContext, 'log'> = {
    seed,
    configs,
    vectors: vectorMode,
    corpora,
    limit,
    qa: options.qa === true,
    verdictsPath: options.verdicts,
    dataset: options.dataset,
    datasetPath: options.datasetPath,
    questionTypes: splitList(options.questionType),
    systems,
    // a suite that still reads the reader name gets the same list
    readers: systems,
    concurrency,
    checkpointPath: options.checkpoint,
    readerModel: options.readerModel,
    judgeModel: options.judgeModel,
    yes: options.yes === true,
    costCeilingCalls,
    contextBudgetChars,
    gitSha: engineRevisionIdentity(git),
    outDir: outputDir,
    buildHeader: (input) => buildHeader({ ...input, git }),
  }

  const suitesToRun: SuiteName[] =
    requestedSuite === 'all' ? SUITES.map((suite) => suite.name) : [requestedSuite]

  const outputs = new Map<SuiteName, SuiteOutput>()
  const allThresholds: Record<string, Record<string, Record<string, number>>> = {}

  for (const suite of suitesToRun) {
    const ctx: SuiteContext = {
      ...ctxBase,
      ...(suite === 'ab' ? { configsExplicit } : {}),
      log: (message: string) => {
        if (!options.quiet) process.stdout.write(`${message}\n`)
      },
    }
    const started = performance.now()
    let output: SuiteOutput
    try {
      output = await runSuite(suite, ctx)
    } catch (error) {
      if (requestedSuite !== 'all' || !(error instanceof DatasetMissingError)) throw error
      if (!options.quiet) {
        process.stdout.write(`${suite}: skipped, dataset not fetched\n  ${error.message.replace(/\n/g, '\n  ')}\n`)
      }
      continue
    }
    outputs.set(suite, output)
    allThresholds[suite] = output.thresholds

    const fileBase = reportFileName(
      suite,
      output.result.header.configs,
      output.result.header.gitShaShort,
      suiteFileSuffix(suite, options)
    )
    const paths = writeReport({
      outDir: outputDir,
      fileBase,
      markdown: renderSuiteSection(output.result, output.markdown),
      json: {
        ...output.result,
        // The corpus hash is recorded in full as well; the short form is in the
        // header so two artifacts with the same header are the same corpus.
      },
    })

    if (!options.quiet) {
      process.stdout.write(
        `\n${renderSuiteSection(output.result, output.markdown)}\n` +
          `\nwrote ${paths.md} and ${paths.json} (${Math.round(performance.now() - started)} ms)\n`
      )
    }
  }

  if (options.baseline) {
    await writeBaselineArtifacts(outputDir, outputs, git)
  }

  if (options.writeThresholds) {
    const file = buildThresholds({ suites: allThresholds, gitSha: git.sha })
    const path = writeThresholds(file)
    process.stdout.write(`\nwrote thresholds ${path}\n`)
  }

  if (options.json) {
    process.stdout.write(
      redactSecrets(
        `${JSON.stringify(
          Object.fromEntries([...outputs.entries()].map(([suite, output]) => [suite, output.result])),
          null,
          2
        )}\n`
      ).text
    )
  }

  if (configLoadErrors().length > 0) {
    process.stdout.write('\nconfig load warnings:\n')
    for (const error of configLoadErrors()) {
      process.stdout.write(`  ${error.file}: ${error.message}\n`)
    }
    process.stdout.write(`known configs: ${configNames().join(', ')}\n`)
  }

  if (options.assert) {
    const file = loadThresholds()
    if (!file) {
      process.stdout.write(
        `\n--assert requested but ${THRESHOLDS_PATH} is missing; nothing to gate against.\n`
      )
      return 0
    }
    const { checked, failures } = evaluateThresholds(file, allThresholds)
    if (failures.length === 0) {
      process.stdout.write(`\n--assert: ${checked} threshold(s) checked, all satisfied.\n`)
      return 0
    }
    process.stdout.write(`\n--assert FAILED (${failures.length}/${checked}):\n`)
    for (const line of formatFailures(failures)) process.stdout.write(`  ${line}\n`)
    return 1
  }

  return 0
}

async function runSuite(suite: SuiteName, ctx: SuiteContext): Promise<SuiteOutput> {
  const entry = SUITES.find((candidate) => candidate.name === suite)
  if (!entry) {
    throw new EvalSetupError(
      `unknown suite "${suite}" — expected ${suiteNames().join('|')}|all`
    )
  }
  return entry.run(ctx)
}

/**
 * the committed reference run, written only on `--baseline` and in one place, so a
 * later change appends its own report instead of overwriting the baseline
 */
async function writeBaselineArtifacts(
  outputDir: string,
  outputs: Map<SuiteName, SuiteOutput>,
  git: GitInfo
): Promise<void> {
  const entries = [...outputs.entries()]
  const configsForSlug = entries[0]?.[1].result.header.configs ?? ['baseline']
  const sha = entries[0]?.[1].result.header.gitShaShort ?? git.short

  const markdown = [
    '# Engram eval baseline',
    '',
    'Committed reference run for the `baseline` config (shipped defaults). Later PRs cite these',
    'numbers; they do not rewrite this file. Regenerate with:',
    '',
    '```',
    'npx tsx eval/run.ts --suite all --baseline',
    '```',
    '',
    'The JSON twin (`BASELINE.json`) carries the full per-query detail and every latency sample.',
    'The determinism guarantee covers the `metrics` blocks only — wall-clock `timings` vary.',
    '',
    ...entries.map(([, output]) =>
      `${renderSuiteSection(output.result, output.markdown)}\n\n---\n`
    ),
  ].join('\n')

  const json = {
    baseline: true,
    configs: configsForSlug,
    gitSha: git.sha,
    gitBranch: git.branch,
    suites: Object.fromEntries(entries.map(([suite, output]) => [suite, output.result])),
  }

  const paths = writeReport({ outDir: outputDir, fileBase: 'BASELINE', markdown, json })
  process.stdout.write(
    `\nwrote ${paths.md} and ${paths.json} (git ${sha}, configs ${configsForSlug.join(', ')})\n`
  )
}

function optionalInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * one artifact per (split, qa, system set), so an offline retrieval run and a paid qa
 * run cannot overwrite each other, and neither can two retrieval runs over different
 * system sets — the numbers only mean something next to the set that produced them
 */
function suiteFileSuffix(suite: SuiteName, options: CliOptions): string {
  if (suite !== 'longmemeval') return ''
  const split = options.dataset ?? DEFAULT_SPLIT
  const systems = splitList(options.systems) ?? splitList(options.readers)
  const slugs = (systems ?? defaultSystemNames()).map(systemSpecSlug).join('+')
  if (options.qa !== true) return systems ? `retrieval-${split}-${slugs}` : `retrieval-${split}`
  return `qa-${split}-${slugs}`
}

function normalizeVectorMode(value: string): VectorMode {
  switch (value) {
    case 'fts':
      return 'fts'
    case 'cached':
    case 'auto':
      return 'cached'
    case 'on':
    case 'vec':
      return 'on'
    default:
      throw new Error(`--vectors must be fts|cached|on (got "${value}")`)
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    const detail =
      error instanceof EvalSetupError
        ? error.message
        : error instanceof Error
          ? error.stack ?? error.message
          : String(error)
    process.stderr.write(`${detail}\n`)
    process.exitCode = 2
  })
