// shared query scoring: one corpus x one config x one clock. metrics are
// macro-averaged over queries, which keeps a corpus with many-target queries from
// dominating a mean, and hits/targets travel alongside so a reader can see what a mean
// stands on.
import type { SearchOptions } from '../../src/memory/search.js'
import type { SearchResult } from '../../src/memory/types.js'
import {
  leakRate,
  mrr,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  round3,
  staleRate,
  tokenCost,
  type TokenizerInfo,
  type ScoredResult,
} from './metrics.js'
import type { EvalHarness } from './harness.js'
import type { Corpus, CorpusQuery } from './types.js'

export const DEFAULT_KS = [1, 5, 10]

/** what every query inherits before a config patch */
export const MEASUREMENT_DEFAULTS: SearchOptions = {
  limit: 10,
  touch: false,
  include_superseded: false,
}

export interface QueryDetail {
  id: string
  kind: string
  namespace: string
  as_of?: number
  targets: string[]
  must_not_retrieve: string[]
  results: Array<{ rank: number; id: string; namespace: string; score: number }>
  recall: Record<string, number>
  precision: Record<string, number>
  ndcg: Record<string, number>
  mrr: number
  leakRate: number
  staleRate: number
  servedChars: number
  servedTokens: number
  latencyMs: number
}

export interface MetricBlock {
  queries: number
  hits: number
  targets: number
  mrr: number
  leakRate: number
  staleRate: number
  tokensPerChar: number
  servedChars: number
  servedTokens: number
  tokensPerQuery: number
  [key: string]: number
}

export interface ScoreInput {
  harness: EvalHarness
  corpus: Corpus
  /** the validated config patch, applied before query overrides */
  configOptions?: SearchOptions
  /** a subset of the corpus, used by ab and budget */
  queries?: CorpusQuery[]
  ks?: number[]
  limit?: number
  tokenizer: TokenizerInfo
  /** per-query hook, for a suite that needs extra facts */
  onQuery?: (detail: QueryDetail) => void
}

export interface ScoreResult {
  metrics: MetricBlock
  byKind: Record<string, MetricBlock>
  details: QueryDetail[]
  latencies: number[]
}

export async function scoreQueries(input: ScoreInput): Promise<ScoreResult> {
  const ks = input.ks ?? DEFAULT_KS
  const limit = input.limit ?? MEASUREMENT_DEFAULTS.limit ?? 10
  const queries = input.queries ?? input.corpus.queries
  const details: QueryDetail[] = []
  const latencies: number[] = []

  for (const query of queries) {
    const searchOptions = buildQueryOptions(query, input.configOptions, limit)
    const { results, ms } = await input.harness.timedSearch(query.query, searchOptions)
    latencies.push(ms)

    // one id space everywhere: the corpus declares targets in corpus-local ids and
    // store_memory mints a fresh uuid per run, so results are projected back before
    // anything is scored.
    // rank order is untouched; only `id` is replaced.
    const ranked: SearchResult[] = results.map((r) => ({ ...r, id: input.harness.localIdOf(r.id) }))

    const served = ranked.slice(0, limit).map((r) => r.content ?? '')
    const cost = tokenCost(served, input.tokenizer)
    const recall: Record<string, number> = {}
    const precision: Record<string, number> = {}
    const ndcg: Record<string, number> = {}
    for (const k of ks) {
      recall[`recall@${k}`] = round3(recallAtK(ranked, query.target_ids, k))
      precision[`precision@${k}`] = round3(precisionAtK(ranked, query.target_ids, k))
      ndcg[`ndcg@${k}`] = round3(ndcgAtK(ranked, query.target_ids, k))
    }

    const detail: QueryDetail = {
      id: query.id,
      kind: query.kind ?? 'default',
      namespace: query.namespace,
      as_of: query.as_of,
      targets: query.target_ids,
      must_not_retrieve: query.must_not_retrieve ?? [],
      results: ranked.slice(0, limit).map((r, i) => ({
        rank: i + 1,
        id: r.id,
        namespace: r.namespace ?? r.project_path,
        score: round3(r.score ?? 0),
      })),
      recall,
      precision,
      ndcg,
      mrr: round3(mrr(ranked, query.target_ids)),
      leakRate: round3(
        leakRate(ranked.slice(0, limit), query.namespace, { subtree: isSubtreeQuery(query) })
      ),
      staleRate: round3(staleRate(ranked.slice(0, limit), query.must_not_retrieve)),
      servedChars: cost.chars,
      servedTokens: cost.tokens,
      latencyMs: round3(ms),
    }
    details.push(detail)
    input.onQuery?.(detail)
  }

  return {
    metrics: aggregate(details, ks),
    byKind: groupByKind(details, ks),
    details,
    latencies,
  }
}

/**
 * precedence: defaults, then the config patch, then the query override. project_path
 * always comes from the query namespace, and namespace_subtree (query or config) wins
 * inside the engine, which checks it first in both backends.
 */
export function buildQueryOptions(
  query: CorpusQuery,
  configOptions: SearchOptions | undefined,
  limit: number
): SearchOptions {
  const options: SearchOptions = {
    ...MEASUREMENT_DEFAULTS,
    ...configOptions,
    ...query.search,
    limit,
    touch: false,
    project_path: query.namespace,
  }
  if (query.as_of !== undefined) options.as_of = query.as_of
  return options
}

/** a subtree query is the one that sets namespace_subtree */
export function isSubtreeQuery(query: CorpusQuery): boolean {
  return typeof query.search?.namespace_subtree === 'string'
}

export function aggregate(details: QueryDetail[], ks: number[]): MetricBlock {
  const n = details.length
  const block: MetricBlock = {
    queries: n,
    hits: 0,
    targets: 0,
    mrr: 0,
    leakRate: 0,
    staleRate: 0,
    tokensPerChar: 0,
    servedChars: 0,
    servedTokens: 0,
    tokensPerQuery: 0,
  }
  if (n === 0) {
    for (const k of ks) {
      block[`recall@${k}`] = 0
      block[`precision@${k}`] = 0
      block[`ndcg@${k}`] = 0
    }
    return block
  }
  for (const k of ks) {
    block[`recall@${k}`] = 0
    block[`precision@${k}`] = 0
    block[`ndcg@${k}`] = 0
  }
  for (const detail of details) {
    for (const k of ks) {
      block[`recall@${k}`] += detail.recall[`recall@${k}`] / n
      block[`precision@${k}`] += detail.precision[`precision@${k}`] / n
      block[`ndcg@${k}`] += detail.ndcg[`ndcg@${k}`] / n
    }
    block.mrr += detail.mrr / n
    block.leakRate += detail.leakRate / n
    block.staleRate += detail.staleRate / n
    block.servedChars += detail.servedChars
    block.servedTokens += detail.servedTokens
    block.targets += detail.targets.length
    const targetSet = new Set(detail.targets)
    const retrieved = new Set(detail.results.map((r) => r.id))
    for (const id of targetSet) if (retrieved.has(id)) block.hits++
  }
  block.servedChars = Math.round(block.servedChars)
  block.servedTokens = Math.round(block.servedTokens)
  block.tokensPerChar = round3(block.servedChars === 0 ? 0 : block.servedTokens / block.servedChars)
  block.tokensPerQuery = round3(block.servedTokens / n)
  return roundBlock(block, ks)
}

function groupByKind(details: QueryDetail[], ks: number[]): Record<string, MetricBlock> {
  const groups = new Map<string, QueryDetail[]>()
  for (const detail of details) {
    const list = groups.get(detail.kind) ?? []
    list.push(detail)
    groups.set(detail.kind, list)
  }
  const out: Record<string, MetricBlock> = {}
  for (const kind of [...groups.keys()].sort()) {
    out[kind] = aggregate(groups.get(kind) ?? [], ks)
  }
  return out
}

function roundBlock(block: MetricBlock, ks: number[]): MetricBlock {
  const out: MetricBlock = { ...block }
  for (const key of Object.keys(out)) {
    if (key === 'queries' || key === 'hits' || key === 'targets') continue
    if (typeof out[key] === 'number') out[key] = round3(out[key])
  }
  for (const k of ks) {
    out[`recall@${k}`] = round3(out[`recall@${k}`] ?? 0)
    out[`precision@${k}`] = round3(out[`precision@${k}`] ?? 0)
    out[`ndcg@${k}`] = round3(out[`ndcg@${k}`] ?? 0)
  }
  return out
}

/** a report table row, built from a metric block */
export function metricRow(block: MetricBlock, ks: number[] = DEFAULT_KS): Array<string | number> {
  const cells: Array<string | number> = []
  for (const k of ks) {
    cells.push(block[`recall@${k}`] ?? 0, block[`precision@${k}`] ?? 0, block[`ndcg@${k}`] ?? 0)
  }
  cells.push(block.mrr, block.leakRate, block.staleRate, block.servedTokens, block.tokensPerChar)
  return cells
}

export function metricColumns(ks: number[] = DEFAULT_KS): string[] {
  const cols: string[] = []
  for (const k of ks) cols.push(`recall@${k}`, `precision@${k}`, `ndcg@${k}`)
  cols.push('mrr', 'leakRate', 'staleRate', 'servedTokens', 'tokens/char')
  return cols
}

/** the suite's top-line metrics, for thresholds */
export function topLine(block: MetricBlock, ks: number[] = DEFAULT_KS): Record<string, number> {
  const out: Record<string, number> = {
    queries: block.queries,
    hits: block.hits,
    targets: block.targets,
    mrr: block.mrr,
    leakRate: block.leakRate,
    staleRate: block.staleRate,
    servedTokens: block.servedTokens,
    tokensPerQuery: block.tokensPerQuery,
  }
  for (const k of ks) {
    out[`recall@${k}`] = block[`recall@${k}`] ?? 0
    out[`ndcg@${k}`] = block[`ndcg@${k}`] ?? 0
    out[`precision@${k}`] = block[`precision@${k}`] ?? 0
  }
  return out
}

export type ScoredResultList = ScoredResult[]
