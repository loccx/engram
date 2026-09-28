// metric primitives. the names here are frozen by EVAL-CONTRACT.md (recallAtK,
// precisionAtK, mrr, ndcgAtK, leakRate, tokenCost, latencyMs): additive helpers may
// appear, nothing here may be renamed. every metric reads only `id` and `namespace`
// off the ranked list, so a test can pass plain objects instead of SearchResult.
import { createHash } from 'node:crypto'

export interface ScoredResult {
  id: string
  namespace?: string | null
  project_path?: string
  content?: string
}

/** |hits@k| / |targets|, 0 for a query with no targets (never NaN) */
export function recallAtK(results: ScoredResult[], targets: readonly string[], k: number): number {
  if (targets.length === 0) return 0
  const want = new Set(targets)
  const top = results.slice(0, Math.max(0, k))
  let hits = 0
  const seen = new Set<string>()
  for (const r of top) {
    if (want.has(r.id) && !seen.has(r.id)) {
      seen.add(r.id)
      hits++
    }
  }
  return hits / want.size
}

/** |hits@k| / k, 0 when k is 0 */
export function precisionAtK(results: ScoredResult[], targets: readonly string[], k: number): number {
  if (k <= 0) return 0
  const want = new Set(targets)
  const top = results.slice(0, k)
  let hits = 0
  for (const r of top) if (want.has(r.id)) hits++
  return hits / k
}

/** 1/rank of the first relevant result, 0 when none was retrieved */
export function mrr(results: ScoredResult[], targets: readonly string[]): number {
  const want = new Set(targets)
  for (let i = 0; i < results.length; i++) {
    if (want.has(results[i].id)) return 1 / (i + 1)
  }
  return 0
}

/**
 * ndcg@k with binary relevance: dcg = sum rel_i / log2(i+1), i 1-based, over the
 * ideal ordering
 */
export function ndcgAtK(results: ScoredResult[], targets: readonly string[], k: number): number {
  if (targets.length === 0 || k <= 0) return 0
  const want = new Set(targets)
  let dcg = 0
  const top = results.slice(0, k)
  for (let i = 0; i < top.length; i++) {
    if (want.has(top[i].id)) dcg += 1 / Math.log2(i + 2)
  }
  const idealHits = Math.min(want.size, k)
  let idcg = 0
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : dcg / idcg
}

/** namespace over project_path, the column rule every read uses */
function resultNamespace(r: ScoredResult): string {
  return r.namespace ?? r.project_path ?? ''
}

/**
 * share of results served outside the query namespace. subtree:false counts only an
 * exact match as inside, the strict-scope reading; subtree:true also accepts
 * `ns/...` and `ns//scope`, which is what a namespace_subtree query means.
 */
export function leakRate(
  results: ScoredResult[],
  namespace: string,
  options?: { subtree?: boolean }
): number {
  if (results.length === 0) return 0
  const subtree = options?.subtree === true
  let leaks = 0
  for (const r of results) {
    const ns = resultNamespace(r)
    const inside = ns === namespace || (subtree && (ns.startsWith(`${namespace}/`)))
    if (!inside) leaks++
  }
  return leaks / results.length
}

/**
 * share of results that must not be served (superseded or stale): recallAtK cannot
 * express "this row has to be gone"
 */
export function staleRate(results: ScoredResult[], forbidden: readonly string[] | undefined): number {
  if (!forbidden || forbidden.length === 0 || results.length === 0) return 0
  const bad = new Set(forbidden)
  let hits = 0
  for (const r of results) if (bad.has(r.id)) hits++
  return hits / results.length
}

export interface TokenizerInfo {
  /** reported in every report header */
  name: string
  /** false when the pure-js tokenizer is missing and chars/4 is in use */
  available: boolean
  count: (text: string) => number
}

const CHARS_PER_TOKEN = 4

export function charEstimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export const CHARS4_TOKENIZER: TokenizerInfo = {
  name: 'chars/4',
  available: false,
  count: charEstimateTokens,
}

let cachedTokenizer: TokenizerInfo | null = null

/**
 * the optional dev-only tokenizer, resolved once: pure js, so it works offline, but
 * not installed on every checkout. the specifier sits in a variable so tsc and
 * bundlers do not need the package to exist.
 */
export async function resolveTokenizer(): Promise<TokenizerInfo> {
  if (cachedTokenizer) return cachedTokenizer
  const specifier = 'gpt-tokenizer'
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(specifier)
    if (typeof mod?.encode === 'function') {
      const encode = mod.encode as (text: string) => number[]
      cachedTokenizer = {
        name: 'gpt-tokenizer',
        available: true,
        count: (text: string) => encode(text).length,
      }
      return cachedTokenizer
    }
  } catch {
    // Not installed (or unusable) — fall through to the estimate.
  }
  cachedTokenizer = CHARS4_TOKENIZER
  return cachedTokenizer
}

/** forget the resolved tokenizer */
export function resetTokenizerForTests(): void {
  cachedTokenizer = null
}

export interface TokenCost {
  chars: number
  tokens: number
  tokensPerChar: number
}

/**
 * real token accounting for the text a caller pays for; falls back to ceil(chars/4)
 * when no tokenizer is importable, and the header says which was used
 */
export function tokenCost(texts: string[], tokenizer: TokenizerInfo = CHARS4_TOKENIZER): TokenCost {
  let chars = 0
  let tokens = 0
  for (const text of texts) {
    chars += text.length
    tokens += tokenizer.count(text)
  }
  return { chars, tokens, tokensPerChar: chars === 0 ? 0 : tokens / chars }
}

/** wall-clock ms for a synchronous call */
export function latencyMs<T>(fn: () => T): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

/** wall-clock ms for an async call, plus its value */
export async function latencyMsAsync<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now()
  const value = await fn()
  return { ms: performance.now() - start, value }
}

/**
 * nearest-rank percentile over a copy (no mutation); p is a fraction, p=0.9 is p90
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  if (p <= 0) return sorted[0]
  if (p >= 1) return sorted[sorted.length - 1]
  const rank = Math.ceil(p * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

export interface TimingSummaryLike {
  count: number
  minMs: number
  p50Ms: number
  p90Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  meanMs: number
}

export function summarizeLatencies(values: number[]): TimingSummaryLike {
  if (values.length === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 }
  }
  const sum = values.reduce((a, b) => a + b, 0)
  return {
    count: values.length,
    minMs: round3(Math.min(...values)),
    p50Ms: round3(percentile(values, 0.5)),
    p90Ms: round3(percentile(values, 0.9)),
    p95Ms: round3(percentile(values, 0.95)),
    p99Ms: round3(percentile(values, 0.99)),
    maxMs: round3(Math.max(...values)),
    meanMs: round3(sum / values.length),
  }
}

/** 3 decimals, so a report number carries no float noise */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * deterministic corpus hash: json with recursively sorted keys, so key order in a
 * generator cannot change it
 */
export function corpusHash(payload: unknown): { short: string; full: string } {
  const canonical = JSON.stringify(canonicalize(payload))
  const full = createHash('sha256').update(canonical).digest('hex')
  return { short: full.slice(0, 16), full }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** mean, 0 for an empty list */
export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** f1 of precision and recall, 0 when both are 0 */
export function f1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0
  return (2 * precision * recall) / (precision + recall)
}
