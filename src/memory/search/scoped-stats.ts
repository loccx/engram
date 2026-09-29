import type Database from 'better-sqlite3'
import { namespaceClause, namespaceFilter } from './scope.js'

// scope-local lexical statistics for the fts channels. fts5's bm25() reads its idf and
// its average document length off the whole index, so rows another namespace wrote
// rescore this scope's hits; once a term passes half the index fts5 clamps its idf to
// 1e-6 and the channel gives up on bm25 altogether, which is the regime that let an
// unrelated namespace zero out this one's evidence and reorder it. the shape below is
// the same bm25 with every corpus statistic taken from the rows the query can serve:
//
//   score(d, q) = Σ_t idf_s(t) · Σ_c w_c · f_c(t,d)·(k1+1) / (f_c(t,d) + k1·(1 - b + b·dl(d)/avgdl_s))
//   idf_s(t) = log((N_s - n_s(t) + 0.5) / (n_s(t) + 0.5)), floored at 1e-6
//   dl(d) = characters of content + tags
//
// counts come from the scope: N_s rows inside it, n_s(t) those whose channel text holds t,
// avgdl_s their mean dl (the memory table, unless the channel counts its own corpus). k1, b,
// the column weights and idf down to its floor are fts5's, so a store with one namespace in
// play scores exactly what fts5 scored and the tuning that came from it still applies; only
// the corpus behind those counts moves.

export const BM25_K1 = 1.2
export const BM25_B = 0.75

/**
 * the length unit dl and avgdl share: characters of the memory text, the same for every
 * channel, and computed in sqlite so a candidate and the scope average agree on unicode
 */
export function docLengthSql(alias: string): string {
  return `length(COALESCE(${alias}.content, '')) + length(COALESCE(${alias}.tags, ''))`
}

/** scope keys held at once; a bounded map, never a leak across a long-lived daemon */
const MAX_CACHE_ENTRIES = 256

// rows a scoped search will rank. the window cannot be picked by fts5's bm25: that score is
// whole-index, so which rows make the cut would again depend on other namespaces. the
// scope's own matches are ranked instead, up to this ceiling. past it the cut is made on
// the scope's shortest rows, which is what bm25's length term rewards anyway, and matching
// more rows than this means the query's terms are everywhere in the scope. the number is
// what bounds the added work per query.
export const SCOPED_WINDOW_CEILING = 2_000

/** the scope's own match set, or a scope-local window of it when it is enormous */
export function scopedWindow(options: ScopeOptions, limit: number): number {
  return options.namespace_subtree || options.project_path || options.namespace
    ? SCOPED_WINDOW_CEILING
    : limit
}

export interface SqlFragment {
  sql: string
  params: unknown[]
}

export interface ScoredRow {
  bm25: number
}

/** one AND fragment out of the filter list a query built, alias-qualified to `m` */
export function combineFilters(filters: SqlFragment[]): SqlFragment {
  return {
    sql: filters.map((filter) => filter.sql).join(' AND '),
    params: filters.flatMap((filter) => filter.params),
  }
}

export interface RowText {
  /** text per weighted column, in weight order */
  columns: string[]
  /** indexed length of that row, in the same unit as the scope average */
  dl: number
}

/** the scope filters a query carries; either one narrows the set the statistics count */
export interface ScopeOptions {
  namespace_subtree?: string
  /** the exact scope key on the memory layer, where the column falls back to project_path */
  project_path?: string
  /** the exact scope key on a layer that stores it in `namespace` alone (episodes) */
  namespace?: string
}

/**
 * replaces whole-index bm25 on a channel's hits with the scope's own score, keeping the
 * order the channel returned them in so ties hold their sqlite tie-break.
 */
export function scoreRowsInScope<T extends ScoredRow>(
  db: Database.Database,
  options: ScopeOptions,
  scope: ScopedScope,
  spec: ChannelSpec,
  terms: string[],
  rows: T[],
  texts: RowText[]
): void {
  if (terms.length === 0 || rows.length === 0) return
  const stats = scopeStats(db, options, scope, spec, terms)
  rows.forEach((row, i) => {
    const text = texts[i] ?? { columns: [], dl: 0 }
    row.bm25 = -scopedBm25({
      terms,
      // one pass over the text per row, not one per term
      tokens: text.columns.map((column) => scoreTokens(column)),
      dl: text.dl,
      weights: spec.weights,
      stats,
      prefix: spec.prefix,
    })
  })
}

export interface ScopedScope {
  /** the authoritative scope + expiry/supersession filter, alias-qualified to the scope's alias */
  predicates: SqlFragment
  /** an extra narrowing of the same rows, only ever a superset: a short cut, never a filter */
  narrowing: SqlFragment | null
}

export interface ChannelSpec {
  /** the fts table whose hits this channel scored */
  table: string
  /** from-clause exposing that table as `f` and the scope's rows under the alias the predicates use */
  from: string
  /**
   * the corpus the scope's statistics count, exposed under the alias the scope predicates use.
   * memories by default; a channel over its own layer counts that layer instead.
   */
  corpus?: { from: string; dl: string }
  /** counts in-scope rows matching a term; per row for an index, per memory for entities */
  dfExpr: string
  /** per-column weights, in the order of the fts table's columns */
  weights: number[]
  /** the entity channel matches its tokens by prefix */
  prefix: boolean
}

/** the memory table, which is the corpus every memory channel counts */
const MEMORY_CORPUS = { from: 'memories m', dl: docLengthSql('m') }

export interface ScopeStats {
  docs: number
  avgdl: number
  df: Map<string, number>
}

/** holds one scope's counts while nothing has written to it; see migration 018 */
interface CachedScope {
  signature: string
  docs: number
  chars: number
  df: Map<string, number>
}

const statsCache = new Map<string, CachedScope>()

/**
 * per-connection identity for the cache key. the epoch signature is monotone inside one
 * database, but two databases (a test fixture, a rebuild, a second daemon) can carry the
 * same namespace at the same epoch, and a cached count from one must never answer the other.
 */
const connectionTokens = new WeakMap<object, number>()
let nextToken = 0

function connectionToken(db: Database.Database): number {
  let token = connectionTokens.get(db)
  if (token === undefined) {
    token = ++nextToken
    connectionTokens.set(db, token)
  }
  return token
}

/**
 * for a writer the epoch triggers cannot see: the identifier index is repaired by writing
 * fts tables directly, and sqlite has no triggers on a virtual table.
 */
export function clearScopeStatsCache(): void {
  statsCache.clear()
}



/**
 * unicode61-shaped tokens, used for scoring only: candidates come from the fts index, so a
 * token this misses costs that term's weight on that row and never the row. nothing splits
 * inside a word, since the index does not either, and diacritics fold as unicode61 folds.
 */
export function scoreTokens(text: string): string[] {
  // the ascii path is the one that runs per row per query, and it skips the unicode
  // normalisation the index only needs for non-ascii text
  if (isAscii(text)) return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false
  return true
}

/** occurrences of a scored term in a tokenised column; a prefix term opens every token it leads */
function countInTokens(tokens: string[], term: string, prefix: boolean): number {
  let count = 0
  for (const token of tokens) {
    if (token === term || (prefix && token.startsWith(term))) count++
  }
  return count
}

/** the scored terms of a built fts query: its quoted segments, tokenised the way the index does */
export function quotedTerms(ftsQuery: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of ftsQuery.matchAll(/"((?:[^"]|"")*)"/g)) {
    for (const token of scoreTokens(match[1].replace(/""/g, '"'))) {
      if (seen.has(token)) continue
      seen.add(token)
      out.push(token)
    }
  }
  return out
}

/**
 * the scope's own namespace clause, the predicate the candidate query applied. it began as a
 * range, which LIKE does not agree with: LIKE folds ascii case and a range does not, so a row a
 * case away was a candidate the statistics never counted. count the predicate itself.
 */
export function scopeNarrowing(options: {
  namespace_subtree?: string
  project_path?: string
}): SqlFragment | null {
  const clause = namespaceFilter('m', options)
  return clause.sql ? clause : null
}

/**
 * the epoch rows one scope reads: its own key, or the subtree under it. the subtree side is the
 * clause the scope predicate itself uses, so a write to a namespace only an ascii case away from
 * the scope key moves this signature exactly as it moves what the scope serves.
 */
function epochWhere(options: ScopeOptions): SqlFragment | null {
  if (options.namespace_subtree) {
    const clause = namespaceClause('namespace', { namespace_subtree: options.namespace_subtree })
    return clause.sql ? clause : null
  }
  // the epoch row is keyed by the scope's namespace string whatever layer wrote it: a memory's
  // coalesced namespace, or an episode's own column
  const exact = options.project_path ?? options.namespace
  return exact ? { sql: 'namespace = ?', params: [exact] } : null
}

/**
 * cheap change signal for one scope: the epoch rows inside it are summed, so a write to
 * any namespace under the scope moves it and a write elsewhere does not. null when the
 * table is missing, which turns the cache off rather than guessing.
 */
function epochSignature(db: Database.Database, options: ScopeOptions): string | null {
  const where = epochWhere(options)
  if (!where) return null

  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(epoch), 0) AS total FROM scope_write_epoch WHERE ${where.sql}`
      )
      .get(...where.params) as { rows: number; total: number }
    return `${row.rows}:${row.total}`
  } catch {
    return null
  }
}

function cacheKey(db: Database.Database, scope: ScopedScope, spec: ChannelSpec): string {
  return [
    String(connectionToken(db)),
    spec.table,
    scope.predicates.sql,
    JSON.stringify(scope.predicates.params),
    scope.narrowing?.sql ?? '',
    JSON.stringify(scope.narrowing?.params ?? []),
  ].join('\u0000')
}

function whereOf(scope: ScopedScope): SqlFragment {
  if (!scope.narrowing) return scope.predicates
  return {
    sql: `${scope.narrowing.sql} AND ${scope.predicates.sql}`,
    params: [...scope.narrowing.params, ...scope.predicates.params],
  }
}

/**
 * idf_s(t), as fts5 computes it: the log odds a document holds the term, floored at 1e-6
 * so a term inside half the scope cannot turn it negative. the floor is also what lets a
 * small scope fall back to term coverage.
 */
export function scopedIdf(docs: number, df: number): number {
  if (docs <= 0) return 0
  return Math.max(Math.log((docs - df + 0.5) / (df + 0.5)), 1e-6)
}

export function scopeStats(
  db: Database.Database,
  options: ScopeOptions,
  scope: ScopedScope,
  spec: ChannelSpec,
  terms: string[]
): ScopeStats {
  const signature = epochSignature(db, options)
  const key = cacheKey(db, scope, spec)
  let entry = signature === null ? undefined : statsCache.get(key)
  if (entry && entry.signature !== signature) entry = undefined

  if (!entry) {
    const where = whereOf(scope)
    const corpus = spec.corpus ?? MEMORY_CORPUS
    const row = db
      .prepare(
        `SELECT COUNT(*) AS docs, COALESCE(SUM(${corpus.dl}), 0) AS chars FROM ${corpus.from} WHERE ${where.sql}`
      )
      .get(...where.params) as { docs: number; chars: number }
    entry = { signature: signature ?? '', docs: row.docs, chars: row.chars, df: new Map() }
    if (signature !== null) {
      if (statsCache.size >= MAX_CACHE_ENTRIES) statsCache.clear()
      statsCache.set(key, entry)
    }
  }

  const cached = entry
  for (const term of terms) {
    if (cached.df.has(term)) continue
    const match = spec.prefix ? `${term}*` : `"${term.replace(/"/g, '""')}"`
    const where = whereOf(scope)
    const row = db
      .prepare(
        `SELECT ${spec.dfExpr} AS n FROM ${spec.from}
          WHERE ${spec.table} MATCH ? AND ${where.sql}`
      )
      .get(match, ...where.params) as { n: number }
    cached.df.set(term, row.n)
  }

  return {
    docs: cached.docs,
    avgdl: cached.docs > 0 ? cached.chars / cached.docs : 0,
    df: cached.df,
  }
}

/**
 * one hit's scope-local bm25. `columns` is the channel's indexed text per weighted
 * column, so a term in tags weighs less than the same term in content, as it did.
 */
export function scopedBm25(input: {
  terms: string[]
  /** each weighted column, tokenised once for the whole row */
  tokens: string[][]
  dl: number
  weights: number[]
  stats: ScopeStats
  prefix: boolean
}): number {
  const { terms, tokens, dl, weights, stats, prefix } = input
  const ratio = stats.avgdl > 0 ? dl / stats.avgdl : 1
  const norm = BM25_K1 * (1 - BM25_B + BM25_B * ratio)

  let score = 0
  for (const term of terms) {
    const idf = scopedIdf(stats.docs, stats.df.get(term) ?? 0)
    if (idf <= 0) continue
    let hit = 0
    for (let i = 0; i < tokens.length; i++) {
      // fts5 folds a column's weight into the frequency it saturates on, so a 10/5
      // content/tag pair makes a tag hit worth about half a content hit, not a fifth
      const f = (weights[i] ?? 1) * countInTokens(tokens[i] ?? [], term, prefix)
      if (f === 0) continue
      hit += (f * (BM25_K1 + 1)) / (f + norm)
    }
    score += idf * hit
  }

  if (score > 0) return score
  // the index matched this row but the scorer found none of the terms in its text: a
  // tokeniser disagreement, scored as one occurrence per term rather than as no evidence
  for (const term of terms) {
    score += scopedIdf(stats.docs, stats.df.get(term) ?? 0) * ((BM25_K1 + 1) / (1 + norm))
  }
  return score
}
