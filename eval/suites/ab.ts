// ab suite: a config sweep on one fixed corpus — same corpus, seed and clock, so a
// config cannot gain from a different index by accident. this is the suite an
// improvement cites, and its table shows deltas against the baseline row.
// the corpus is seeded through the real store_memory path even when large, so the ab
// numbers stay comparable with the retrieval suite's. no --configs sweeps every
// registered config, baseline first.
import { EvalHarness } from '../lib/harness.js'
import { buildCorpus } from '../lib/corpus.js'
import { corpusHash, resolveTokenizer, round3, summarizeLatencies } from '../lib/metrics.js'
import {
  applyFeatureFlags,
  configSearchOptions,
  EVAL_CONFIGS,
  type RetrievalConfigPatch,
} from '../lib/registry.js'
import { markdownTable, renderTimings } from '../lib/report.js'
import { DEFAULT_KS, MEASUREMENT_DEFAULTS, scoreQueries, type MetricBlock } from '../lib/score.js'
import { topLineFromBlock } from '../lib/thresholds.js'
import { describeHarness } from './retrieval.js'
import type { SuiteContext, SuiteOutput } from './types.js'
import type { TimingSummary } from '../lib/types.js'

export const DELTA_METRICS = [
  'recall@1',
  'recall@5',
  'recall@10',
  'mrr',
  'ndcg@10',
  'leakRate',
  'staleRate',
]

export async function runAbSuite(ctx: SuiteContext): Promise<SuiteOutput> {
  const corpusName = ctx.corpora?.[0] ?? 'mixed'
  const corpus = buildCorpus(corpusName, ctx.seed)
  const limit = ctx.limit ?? MEASUREMENT_DEFAULTS.limit ?? 10
  const ks = DEFAULT_KS.filter((k) => k <= limit)
  const tokenizer = await resolveTokenizer()
  const hash = corpusHash(corpus)
  const notes: string[] = []

  const sweep: Array<[string, RetrievalConfigPatch]> = ctx.configsExplicit
    ? ctx.configs
    : [
        ['baseline', EVAL_CONFIGS.baseline],
        ...Object.entries(EVAL_CONFIGS)
          .filter(([name]) => name !== 'baseline')
          .map(([name, patch]) => [name, patch] as [string, RetrievalConfigPatch]),
      ]
  const configNames = sweep.map(([name]) => name)

  const harness = await EvalHarness.create({ seed: ctx.seed, vectors: ctx.vectors })
  const metrics: Record<string, unknown> = {}
  const timings: Record<string, TimingSummary> = {}
  const thresholds: Record<string, Record<string, number>> = {}
  const featureFlags: Record<string, string> = {}
  const details: unknown[] = []

  try {
    const seedStats = await harness.seedCorpus(corpus, { mode: 'tool' })
    notes.push(
      `${corpus.name}: ${corpus.memories.length} memories seeded via store_memory ` +
        `(${seedStats.raw} raw), ${corpus.queries.length} queries, ` +
        `placement verified=${seedStats.placementVerified}`
    )
    if (!seedStats.placementVerified) {
      notes.push(`PLACEMENT MISMATCHES: ${seedStats.placementMismatches.slice(0, 5).join(' | ')}`)
    }

    for (const [configName, patch] of sweep) {
      const { options: configOptions, warnings } = configSearchOptions(patch, {
        ...MEASUREMENT_DEFAULTS,
        limit,
      })
      for (const warning of warnings) notes.push(warning)
      const flags = applyFeatureFlags(patch.features)
      featureFlags[configName] = JSON.stringify(patch.features ?? {})
      try {
        const scored = await scoreQueries({
          harness,
          corpus,
          configOptions,
          ks,
          limit,
          tokenizer,
        })
        metrics[configName] = { overall: scored.metrics, byKind: scored.byKind }
        thresholds[configName] = topLineFromBlock(scored.metrics, ks)
        timings[`${configName}/all-queries`] = summarizeLatencies(scored.latencies)
        details.push({ config: configName, queries: scored.details })
        notes.push(
          `${configName}: search=${JSON.stringify(patch.search ?? {})} ` +
            `flags=${JSON.stringify(patch.features ?? {})}`
        )
      } finally {
        flags.restore()
      }
    }

    const deltas = computeDeltas(metrics, configNames)
    const markdown = renderAbMarkdown({
      corpusName,
      configNames,
      metrics,
      deltas,
      ks,
      timings,
    })

    return {
      result: {
        suite: 'ab',
        header: ctx.buildHeader({
          suite: 'ab',
          configs: configNames,
          seed: ctx.seed,
          corpusHash: hash,
          vectorsAvailable: harness.vectorsAvailable,
          vectorMode: harness.vectorMode,
          now: harness.now,
          tokenizer,
          featureFlags,
        }),
        metrics: { ...metrics, deltas_vs_baseline: deltas },
        timings,
        details,
        notes: [...notes, `harness: ${describeHarness(harness)}`],
      },
      markdown,
      thresholds,
    }
  } finally {
    harness.dispose()
  }
}

export interface ConfigDelta {
  metric: string
  baseline: number
  value: number
  delta: number
}

export function computeDeltas(
  metrics: Record<string, unknown>,
  configNames: string[]
): Record<string, ConfigDelta[]> {
  const out: Record<string, ConfigDelta[]> = {}
  const base = overallBlock(metrics, 'baseline')
  if (!base) return out
  for (const config of configNames) {
    if (config === 'baseline') continue
    const block = overallBlock(metrics, config)
    if (!block) continue
    out[config] = DELTA_METRICS.filter(
      (metric) => typeof base[metric] === 'number' && typeof block[metric] === 'number'
    ).map((metric) => ({
      metric,
      baseline: base[metric],
      value: block[metric],
      delta: round3(block[metric] - base[metric]),
    }))
  }
  return out
}

export function renderAbMarkdown(input: {
  corpusName: string
  configNames: string[]
  metrics: Record<string, unknown>
  deltas: Record<string, ConfigDelta[]>
  ks: number[]
  timings: Record<string, TimingSummary>
}): string {
  const rows: Array<Array<string | number>> = []
  for (const config of input.configNames) {
    const block = overallBlock(input.metrics, config)
    if (!block) continue
    const cells: Array<string | number> = [config]
    for (const k of input.ks) cells.push(block[`recall@${k}`] ?? 0)
    cells.push(
      block.mrr,
      block['ndcg@10'] ?? 0,
      block.leakRate,
      block.staleRate,
      block.servedTokens
    )
    rows.push(cells)
  }

  const deltaRows: Array<Array<string | number>> = []
  for (const [config, deltas] of Object.entries(input.deltas)) {
    const byMetric = new Map(deltas.map((d) => [d.metric, d.delta]))
    deltaRows.push([
      config,
      ...DELTA_METRICS.map((metric) => {
        const delta = byMetric.get(metric)
        if (delta === undefined) return '—'
        return `${delta >= 0 ? '+' : ''}${delta}`
      }),
    ])
  }

  return [
    `Fixed corpus: **${input.corpusName}** — seeded once per run, every config queries the same DB state.`,
    'Deltas are relative to `baseline` (a positive delta is better, except for `leakRate`/`staleRate`).',
    markdownTable({
      columns: [
        'config',
        ...input.ks.map((k) => `recall@${k}`),
        'mrr',
        'ndcg@10',
        'leakRate',
        'staleRate',
        'servedTokens',
      ],
      rows,
    }),
    `### deltas vs baseline\n\n${
      deltaRows.length === 0
        ? '_only the baseline config was requested_'
        : markdownTable({ columns: ['config', ...DELTA_METRICS], rows: deltaRows })
    }`,
    `### latency (wall clock; not covered by the determinism guarantee)\n\n${renderTimings(
      input.timings
    )}`,
  ].join('\n\n')
}

function overallBlock(metrics: Record<string, unknown>, config: string): MetricBlock | null {
  const entry = metrics[config] as { overall: MetricBlock } | undefined
  return entry?.overall ?? null
}
