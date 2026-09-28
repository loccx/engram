// retrieval suite: recall@k, precision@k, mrr, ndcg@k, leak rate, token cost, latency
// and the superseded-row staleRate. per config it emits one metric block per corpus plus
// a pooled `overall` block, and a change citing numbers should quote the per-corpus
// blocks: pooling paraphrase (lexically impossible for fts) with distractor (lexically
// saturated) hides both effects.
import { EvalHarness } from '../lib/harness.js'
import { corpusHash, resolveTokenizer, round3, summarizeLatencies } from '../lib/metrics.js'
import { applyFeatureFlags, configSearchOptions, type RetrievalConfigPatch } from '../lib/registry.js'
import { markdownTable, renderTimings } from '../lib/report.js'
import {
  DEFAULT_KS,
  MEASUREMENT_DEFAULTS,
  metricColumns,
  metricRow,
  scoreQueries,
  type MetricBlock,
  type QueryDetail,
} from '../lib/score.js'
import { buildCorpus } from '../lib/corpus.js'
import { topLineFromBlock } from '../lib/thresholds.js'
import type { SuiteContext, SuiteOutput } from './types.js'
import type { Corpus, TimingSummary } from '../lib/types.js'

/** what the retrieval suite scores without --corpus */
export const DEFAULT_RETRIEVAL_CORPORA = [
  'cross-notation',
  'paraphrase',
  'distractor',
  'temporal-update',
  'cross-namespace',
  'long-horizon',
]

export async function runRetrievalSuite(ctx: SuiteContext): Promise<SuiteOutput> {
  const corporaNames = ctx.corpora ?? DEFAULT_RETRIEVAL_CORPORA
  const corpora: Corpus[] = corporaNames.map((name) => buildCorpus(name, ctx.seed))
  const limit = ctx.limit ?? MEASUREMENT_DEFAULTS.limit ?? 10
  const candidateKs = DEFAULT_KS.filter((k) => k <= limit)
  const ks = candidateKs.length > 0 ? candidateKs : [limit]
  const tokenizer = await resolveTokenizer()
  const hash = corpusHash(corpora)
  const configNames = ctx.configs.map(([name]) => name)

  const harness = await EvalHarness.create({ seed: ctx.seed, vectors: ctx.vectors })
  const notes: string[] = []
  const metrics: Record<string, unknown> = {}
  const timings: Record<string, TimingSummary> = {}
  const details: unknown[] = []
  const featureFlags: Record<string, string> = {}
  const thresholds: Record<string, Record<string, number>> = {}

  try {
    for (const corpus of corpora) {
      const seedStats = await harness.seedCorpus(corpus)
      notes.push(
        `${corpus.name}: ${corpus.memories.length} memories seeded ` +
          `(${seedStats.viaTool} via store_memory, ${seedStats.raw} raw-insert), ` +
          `${corpus.queries.length} queries, placement verified=${seedStats.placementVerified}`
      )
      if (!seedStats.placementVerified) {
        notes.push(`PLACEMENT MISMATCHES: ${seedStats.placementMismatches.slice(0, 5).join(' | ')}`)
      }
    }

    for (const [configName, patch] of ctx.configs) {
      const { options: configOptions, warnings } = configSearchOptions(patch, {
        ...MEASUREMENT_DEFAULTS,
        limit,
      })
      for (const warning of warnings) notes.push(warning)
      const flags = applyFeatureFlags(patch.features)
      featureFlags[configName] = JSON.stringify(patch.features ?? {})
      notes.push(`${configName}: ${describeConfig(patch, flags.applied)}`)

      const perCorpus: Record<string, MetricBlock> = {}
      const byKind: Record<string, MetricBlock> = {}
      const configDetails: Array<Record<string, unknown>> = []
      const latencies: number[] = []
      let pooled: MetricBlock | null = null

      try {
        for (const corpus of corpora) {
          const scored = await scoreQueries({
            harness,
            corpus,
            configOptions,
            ks,
            limit,
            tokenizer,
          })
          perCorpus[corpus.name] = scored.metrics
          for (const [kind, block] of Object.entries(scored.byKind)) {
            byKind[`${corpus.name}:${kind}`] = block
          }
          latencies.push(...scored.latencies)
          configDetails.push(
            ...scored.details.map((detail: QueryDetail) => ({ corpus: corpus.name, ...detail }))
          )
          pooled = poolBlocks(pooled, scored.metrics)
        }
      } finally {
        flags.restore()
      }

      timings[`${configName}/all-queries`] = summarizeLatencies(latencies)
      metrics[configName] = { overall: pooled, byCorpus: perCorpus, byKind }
      details.push({ config: configName, queries: configDetails })
      thresholds[configName] = pooled ? topLineFromBlock(pooled, ks) : {}
    }

    const markdown = renderRetrievalMarkdown({
      corpora: corporaNames,
      metrics,
      configNames,
      ks,
      timings,
    })

    const seedNotes = notes.filter((n) => n.includes('seeded'))
    const corpusHashForHeader = hash
    return {
      result: {
        suite: 'retrieval',
        header: ctx.buildHeader({
          suite: 'retrieval',
          configs: configNames,
          seed: ctx.seed,
          corpusHash: corpusHashForHeader,
          vectorsAvailable: harness.vectorsAvailable,
          vectorMode: harness.vectorMode,
          now: harness.now,
          tokenizer,
          featureFlags,
        }),
        metrics,
        timings,
        details,
        notes: [
          ...seedNotes,
          `harness: ${describeHarness(harness)}`,
          ...notes.filter((n) => !seedNotes.includes(n)),
        ],
      },
      markdown,
      thresholds,
    }
  } finally {
    harness.dispose()
  }
}

export function describeHarness(harness: EvalHarness): string {
  const stats = harness.stats()
  return (
    `isolated db ${harness.dbPath}; ${stats.memories} memories, ${stats.pinned} pinned, ` +
    `${stats.clusters} clusters, digests for ${stats.digests.length} namespace(s), ` +
    `${stats.vectors} rows with vectors`
  )
}

function describeConfig(
  patch: RetrievalConfigPatch,
  applied: Record<string, string>
): string {
  const flags = Object.keys(applied).length > 0 ? ` flags=${JSON.stringify(applied)}` : ''
  const search = patch.search ? ` search=${JSON.stringify(patch.search)}` : ''
  return `${patch.notes ?? patch.label}${search}${flags}`
}

/**
 * rates are the query-weighted mean of the per-corpus means, so the pooled value equals
 * one pass over the concatenated corpus, and counts add up
 */
function poolBlocks(acc: MetricBlock | null, block: MetricBlock): MetricBlock {
  if (!acc) return { ...block }
  const n = acc.queries + block.queries
  const out: MetricBlock = { ...acc }
  out.queries = n
  out.hits = acc.hits + block.hits
  out.targets = acc.targets + block.targets
  out.servedChars = acc.servedChars + block.servedChars
  out.servedTokens = acc.servedTokens + block.servedTokens
  for (const key of Object.keys(block)) {
    if (key === 'queries' || key === 'hits' || key === 'targets' || key.startsWith('served')) continue
    if (typeof block[key] !== 'number') continue
    const prev = typeof acc[key] === 'number' ? acc[key] : 0
    out[key] = round3((prev * acc.queries + block[key] * block.queries) / n)
  }
  out.tokensPerChar = round3(out.servedChars === 0 ? 0 : out.servedTokens / out.servedChars)
  out.tokensPerQuery = round3(out.servedTokens / Math.max(1, n))
  return out
}

export function renderRetrievalMarkdown(input: {
  corpora: string[]
  metrics: Record<string, unknown>
  configNames: string[]
  ks: number[]
  timings: Record<string, TimingSummary>
}): string {
  const sections: string[] = []
  sections.push(
    'Metrics are macro-averaged over queries. `recall@k` = |hits@k| / |targets|; ' +
      '`leakRate` = share of results outside the query namespace (descendants count as inside ' +
      'for subtree queries); `staleRate` = share of results that are superseded or otherwise ' +
      'must-not-retrieve; `servedTokens`/`tokens/char` price the top-k content a caller would ' +
      'actually receive.'
  )

  for (const corpus of input.corpora) {
    const rows: Array<Array<string | number>> = []
    for (const config of input.configNames) {
      const block = perCorpusBlock(input.metrics, config, corpus)
      if (!block) continue
      rows.push([config, ...metricRow(block, input.ks), block.queries])
    }
    sections.push(
      `### corpus: ${corpus}\n\n${markdownTable({
        columns: ['config', ...metricColumns(input.ks), 'queries'],
        rows,
      })}`
    )
  }

  const overallRows: Array<Array<string | number>> = []
  for (const config of input.configNames) {
    const block = overallBlock(input.metrics, config)
    if (!block) continue
    overallRows.push([config, ...metricRow(block, input.ks), block.queries])
  }
  sections.push(
    `### pooled (all scored corpora, mean over queries)\n\n${markdownTable({
      columns: ['config', ...metricColumns(input.ks), 'queries'],
      rows: overallRows,
    })}`
  )

  const kindRows: Array<Array<string | number>> = []
  const kindKeys = new Set<string>()
  for (const config of input.configNames) {
    const byKind = byKindOf(input.metrics, config)
    for (const key of Object.keys(byKind)) kindKeys.add(key)
  }
  for (const config of input.configNames) {
    const byKind = byKindOf(input.metrics, config)
    for (const key of [...kindKeys].sort()) {
      const block = byKind[key]
      if (!block) continue
      kindRows.push([
        `${config} / ${key}`,
        block['recall@1'] ?? 0,
        block.mrr,
        block['recall@10'] ?? 0,
        block.queries,
      ])
    }
  }
  if (kindRows.length > 0) {
    sections.push(
      `### by probe kind (the columns that carry the signal)\n\n${markdownTable({
        columns: ['config / kind', 'recall@1', 'mrr', 'recall@10', 'queries'],
        rows: kindRows,
      })}`
    )
  }

  sections.push(
    `### latency (wall clock; not covered by the determinism guarantee)\n\n${renderTimings(
      input.timings
    )}`
  )
  return sections.join('\n\n')
}

function byKindOf(metrics: Record<string, unknown>, config: string): Record<string, MetricBlock> {
  const entry = metrics[config] as { byKind: Record<string, MetricBlock> } | undefined
  return entry?.byKind ?? {}
}

function perCorpusBlock(
  metrics: Record<string, unknown>,
  config: string,
  corpus: string
): MetricBlock | null {
  const entry = metrics[config] as { byCorpus: Record<string, MetricBlock> } | undefined
  return entry?.byCorpus[corpus] ?? null
}

function overallBlock(metrics: Record<string, unknown>, config: string): MetricBlock | null {
  const entry = metrics[config] as { overall: MetricBlock | null } | undefined
  return entry?.overall ?? null
}
