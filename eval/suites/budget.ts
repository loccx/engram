// budget suite: recall_context under a strict character budget. for every budget in the
// grid and every query in the budget corpus it calls the real recallContext with an
// injected clock and records where the characters went (per_section), how much was used,
// what was dropped or truncated, plus real token counts and target recall at each budget.
// one invariant is checked throughout: used_chars <= budget_chars.
// the corpus is small and synthetic, so it shows how the packer behaves under pressure,
// not how a real project's digest behaves.
import { EvalHarness } from '../lib/harness.js'
import { buildCorpus } from '../lib/corpus.js'
import {
  corpusHash,
  recallAtK,
  resolveTokenizer,
  round3,
  summarizeLatencies,
  tokenCost,
  type TokenizerInfo,
} from '../lib/metrics.js'
import { applyFeatureFlags, configSearchOptions, type RetrievalConfigPatch } from '../lib/registry.js'
import { markdownTable, renderTimings } from '../lib/report.js'
import { buildQueryOptions } from '../lib/score.js'

import { describeHarness } from './retrieval.js'
import type { SuiteContext, SuiteOutput } from './types.js'
import type { RecallResult } from '../../src/memory/recall.js'
import type { TimingSummary } from '../lib/types.js'

export const DEFAULT_BUDGET_GRID = [50, 200, 500, 2000]

/** cap applied to one served memory when pricing tokens */
const servedText = (recall: RecallResult): string[] => [
  recall.digest ?? '',
  ...recall.memories.map((m) => m.content),
  ...recall.topics.map((t) => t.summary ?? ''),
]

export async function runBudgetSuite(ctx: SuiteContext): Promise<SuiteOutput> {
  const corpus = buildCorpus('budget', ctx.seed)
  const grid = ctx.corpora && ctx.corpora.length > 0
    ? ctx.corpora.map((value) => Number(value)).filter((n) => Number.isFinite(n) && n > 0)
    : DEFAULT_BUDGET_GRID
  const budgets = [...new Set(grid)].sort((a, b) => a - b)
  const tokenizer = await resolveTokenizer()
  const hash = corpusHash(corpus)
  const notes: string[] = []
  const metrics: Record<string, unknown> = {}
  const timings: Record<string, TimingSummary> = {}
  const thresholds: Record<string, Record<string, number>> = {}
  const details: unknown[] = []
  const featureFlags: Record<string, string> = {}

  const harness = await EvalHarness.create({ seed: ctx.seed, vectors: ctx.vectors })

  try {
    const seedStats = await harness.seedCorpus(corpus)
    notes.push(
      `${corpus.name}: ${corpus.memories.length} memories ` +
        `(${seedStats.viaTool} via store_memory, ${seedStats.raw} raw-insert), ` +
        `${corpus.queries.length} queries, pinned=${harness.stats().pinned}, ` +
        `clusters=${harness.stats().clusters}, placement verified=${seedStats.placementVerified}`
    )
    if (!seedStats.placementVerified) {
      notes.push(`PLACEMENT MISMATCHES: ${seedStats.placementMismatches.slice(0, 5).join(' | ')}`)
    }

    for (const [configName, patch] of ctx.configs) {
      const { options: queryOptions, warnings } = configSearchOptions(patch, { limit: 10 })
      for (const warning of warnings) notes.push(warning)
      const flags = applyFeatureFlags(patch.features)
      featureFlags[configName] = JSON.stringify(patch.features ?? {})
      const perBudget: Record<string, unknown> = {}
      const budgetDetails: Array<Record<string, unknown>> = []
      const latencies: number[] = []
      let violations = 0

      try {
        for (const budget of budgets) {
          const rows: Array<Record<string, number>> = []
          for (const query of corpus.queries) {
            const searchOptions = buildQueryOptions(query, queryOptions, query.limit ?? 10)
            const start = performance.now()
            const recall = await harness.runRecall({
              query: query.query,
              project_path: query.namespace,
              budget_chars: budget,
              limit: searchOptions.limit ?? 10,
            })
            const ms = performance.now() - start
            latencies.push(ms)
            if (recall.budget.used_chars > recall.budget.total_chars) violations++

            const texts = servedText(recall)
            const cost = tokenCost(texts, tokenizer)
            // corpus-local ids: the corpus declares its targets in that id space
            const servedIds = recall.memories.map((m) => harness.localIdOf(m.id))
            const targetRecall = recallAtK(
              servedIds.map((id) => ({ id })),
              query.target_ids,
              servedIds.length
            )
            const row = {
              usedChars: recall.budget.used_chars,
              digestChars: recall.budget.per_section.digest,
              memoryChars: recall.budget.per_section.memories,
              topicChars: recall.budget.per_section.topics,
              servedChars: cost.chars,
              servedTokens: cost.tokens,
              memoriesServed: recall.memories.length,
              topicsServed: recall.topics.length,
              digestPresent: (recall.digest ?? '').length > 0 ? 1 : 0,
              droppedMemories: recall.dropped.memories,
              droppedTopics: recall.dropped.topics,
              droppedDigestChars: recall.dropped.digest_chars_cut,
              droppedTrustFiltered: recall.dropped.trust_filtered,
              droppedNearDuplicates: recall.dropped.near_duplicates,
              truncatedDigest: recall.truncated.digest ? 1 : 0,
              truncatedMemories: recall.truncated.memories,
              truncatedTopics: recall.truncated.topics,
              targetRecall: round3(targetRecall),
            }
            rows.push(row)
            budgetDetails.push({ budget, query_id: query.id, latencyMs: round3(ms), ...row })
          }
          perBudget[`budget${budget}`] = aggregateRows(rows, budget)
          timings[`${configName}/budget${budget}`] = summarizeLatencies(
            budgetDetails
              .filter((d) => d.budget === budget)
              .map((d) => Number(d.latencyMs))
          )
        }
      } finally {
        flags.restore()
      }

      notes.push(
        `${configName}: budget grid ${budgets.join(', ')}; strict-budget violations=${violations}`
      )
      const gridBlock = perBudget as Record<string, Record<string, number>>
      metrics[configName] = {
        byBudget: perBudget,
        // the pooled view is the largest budget's fidelity against the smallest one's
        // budget's cost — it answers "what does the tightest budget cost us?".
        tightestBudget: budgets[0],
        fidelityLossVsLargest: round3(
          (gridBlock[`budget${budgets[budgets.length - 1]}`]?.targetRecall ?? 0) -
            (gridBlock[`budget${budgets[0]}`]?.targetRecall ?? 0)
        ),
        budgetViolations: violations,
      }
      const tightest = gridBlock[`budget${budgets[0]}`]
      const largest = gridBlock[`budget${budgets[budgets.length - 1]}`]
      thresholds[configName] = {
        // the tightest budget is where fidelity is at risk, and the largest budget
        // is where the packer's cost is fully visible.
        fidelity: tightest?.targetRecall ?? 0,
        fidelityLossVsLargest: round3((largest?.targetRecall ?? 0) - (tightest?.targetRecall ?? 0)),
        servedTokens: largest?.servedTokens ?? 0,
        droppedMemories: largest?.droppedMemories ?? 0,
        budgetViolations: violations,
      }
      details.push({ config: configName, budgets: budgetDetails })
    }

    const markdown = renderBudgetMarkdown({ budgets, metrics, configNames: ctx.configs.map(([n]) => n), timings })

    return {
      result: {
        suite: 'budget',
        header: ctx.buildHeader({
          suite: 'budget',
          configs: ctx.configs.map(([name]) => name),
          seed: ctx.seed,
          corpusHash: hash,
          vectorsAvailable: harness.vectorsAvailable,
          vectorMode: harness.vectorMode,
          now: harness.now,
          tokenizer,
          featureFlags,
        }),
        metrics,
        timings,
        details,
        notes: [...notes, `harness: ${describeHarness(harness)}`, budgetColumnNote()],
      },
      markdown,
      thresholds,
    }
  } finally {
    harness.dispose()
  }
}

/** mean of every numeric field across the queries at one budget */
function aggregateRows(rows: Array<Record<string, number>>, budget: number): Record<string, number> {
  const out: Record<string, number> = { budget, queries: rows.length }
  if (rows.length === 0) return out
  for (const key of Object.keys(rows[0])) {
    const values = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number')
    if (values.length === 0) continue
    const sum = values.reduce((a, b) => a + b, 0)
    out[key] = round3(sum / values.length)
  }
  out.budget = budget
  out.queries = rows.length
  return out
}

export function budgetColumnNote(): string {
  return (
    'Columns: usedChars = budget.used_chars; digestChars/memoryChars/topicChars = ' +
    'budget.per_section; dropped*/truncated* come from recall.dropped / recall.truncated; ' +
    'servedTokens counts digest + memory contents + topic summaries; targetRecall is the share ' +
    'of expected ids present in the served memories (there is no k cut here).'
  )
}

export function renderBudgetMarkdown(input: {
  budgets: number[]
  metrics: Record<string, unknown>
  configNames: string[]
  timings: Record<string, TimingSummary>
}): string {
  const rows: Array<Array<string | number>> = []
  for (const config of input.configNames) {
    const byBudget = (input.metrics[config] as { byBudget: Record<string, Record<string, number>> })
      .byBudget
    for (const budget of input.budgets) {
      const row = byBudget[`budget${budget}`]
      if (!row) continue
      rows.push([
        config,
        budget,
        row.usedChars,
        row.digestChars,
        row.memoryChars,
        row.topicChars,
        row.memoriesServed,
        row.topicsServed,
        row.targetRecall,
        row.droppedMemories,
        row.droppedTopics,
        row.droppedTrustFiltered,
        row.droppedNearDuplicates,
        row.truncatedDigest,
        row.truncatedMemories,
        row.truncatedTopics,
        row.servedTokens,
      ])
    }
  }

  return [
    'Strict-budget recall: the packer allocates in a fixed order (digest reserve, then ranked ' +
      'memories, then topics) and must never exceed `budget_chars`.',
    markdownTable({
      columns: [
        'config',
        'budget',
        'usedChars',
        'digestChars',
        'memoryChars',
        'topicChars',
        'memories',
        'topics',
        'targetRecall',
        'dropMem',
        'dropTopic',
        'dropTrust',
        'dropDup',
        'truncDigest',
        'truncMem',
        'truncTopic',
        'servedTokens',
      ],
      rows,
    }),
    `### latency (wall clock; not covered by the determinism guarantee)\n\n${renderTimings(
      input.timings
    )}`,
  ].join('\n\n')
}

export type BudgetTokenizer = TokenizerInfo
export type BudgetPatch = RetrievalConfigPatch
