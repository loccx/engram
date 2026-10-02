// the episodes channel: lexical bm25 over episodes_fts plus an optional vec0 knn,
// fused with the same weights the memory channel uses, so the evidence layer ranks
// like the curated one. an episode carries no importance and no access count, so
// those two priors are the memory defaults; they shift every candidate by the same
// amount and cannot reorder it. the vector weight is handed to the other signals
// when no vector list contributed, exactly as in src/memory/search/hybrid.ts.
import type Database from 'better-sqlite3'
import { embedEpisodeText } from '../episodes.js'
import {
  bm25Relevance,
  classifyQuery,
  distanceRelevance,
  WEIGHT_PROFILES,
  type SignalKey,
} from './scoring.js'
import { queryTokens } from './expand.js'
import { quotedTerms, scoreRowsInScope, type ChannelSpec } from './scoped-stats.js'
import {
  episodeNamespaceFilter,
  episodeRowToEpisode,
  type Episode,
  type EpisodeNamespaceScope,
  type EpisodeRow,
} from '../episodes.js'

/** content carries the memory channel's weight, so the two evidence maps share a scale */
const EPISODE_FTS_CONTENT_WEIGHT = 10.0

/** an episode's length is its content: there are no weighted tag columns on that layer */
const EPISODE_DL = `length(COALESCE(e.content, ''))`

// the scope-local statistics of the episodes channel: the same bm25 the memory channels use,
// counted over the scope's episodes instead of the whole index. fts5's own bm25 reads idf and
// average length off every namespace that ever wrote evidence, so an unrelated project's turns
// rescored this one's and could reorder it.
const EPISODE_SCOPE_CHANNEL: ChannelSpec = {
  table: 'episodes_fts',
  from: 'episodes_fts f JOIN episodes e ON f.rowid = e.rowid',
  corpus: { from: 'episodes e', dl: EPISODE_DL },
  dfExpr: 'COUNT(*)',
  weights: [EPISODE_FTS_CONTENT_WEIGHT],
  prefix: false,
}

/** the clamped bm25 regime reports ~1e-6; real per-term magnitudes sit far above */
const BM25_MAGNITUDE_EPS = 1e-3
/** memories default to 0.5 and are never read unless asked */
const EPISODE_IMPORTANCE = 0.5
const EPISODE_ACCESS_COUNT = 0
const DAY_MS = 86_400_000

export interface EpisodeSearchDiagnostics {
  /** failed branches, so an empty result set is distinguishable from an outage */
  degraded: string[]
}

export interface EpisodeSearchOptions extends EpisodeNamespaceScope {
  limit?: number
  /** fixed clock for a deterministic recency prior */
  now?: number
  /** expired ephemeral evidence is hidden unless this is set */
  include_expired?: boolean
  diagnostics?: EpisodeSearchDiagnostics
}

export interface EpisodeHit {
  episode: Episode
  score: number
  /** the evidence share (fts + vector), priors excluded */
  relevance: number
  bm25?: number
  distance?: number
  signals: Record<SignalKey, number>
}

export interface EpisodeSearchResult {
  hits: EpisodeHit[]
  degraded: string[]
}

let knnRowidFilterSupported: boolean | null = null

/** the ebbinghaus curve of a memory with the default importance and no accesses */
export function episodeRecency(occurredAt: number | null, now: number): number {
  const at = occurredAt ?? now
  const strength = Math.max(EPISODE_IMPORTANCE + 0.3 * Math.log(EPISODE_ACCESS_COUNT + 1), 0.1)
  return Math.exp(-((now - at) / DAY_MS) / (30 * strength))
}

function expiredClause(options: EpisodeSearchOptions, alias: string, now: number): {
  sql: string
  params: number[]
} {
  if (options.include_expired === true) return { sql: '', params: [] }
  return { sql: `(${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)`, params: [now] }
}

/** per-token quoting, plus the episodes table's own namespace and expiry predicates */
function episodePredicates(
  options: EpisodeSearchOptions,
  now: number
): { sql: string[]; params: unknown[] } {
  const scope = episodeNamespaceFilter(options, 'e')
  const sql: string[] = []
  const params: unknown[] = []
  if (scope.sql) {
    sql.push(scope.sql)
    params.push(...scope.params)
  }
  const expiry = expiredClause(options, 'e', now)
  if (expiry.sql) {
    sql.push(expiry.sql)
    params.push(...expiry.params)
  }
  return { sql, params }
}

/**
 * implicit and first, or as the fallback: all-terms semantics is too strict for a
 * three-or-more-term query. a quoted query is already an fts5 phrase.
 */
function episodeFtsQueries(query: string): string[] {
  const trimmed = query.trim()
  if (trimmed.length > 2 && trimmed.startsWith('"') && trimmed.endsWith('"') && !trimmed.slice(1, -1).includes('"')) {
    return [trimmed]
  }
  const tokens = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
  if (tokens.length <= 2) return [tokens.join(' ')]
  return [tokens.join(' '), tokens.join(' OR ')]
}

function execEpisodeFts(
  db: Database.Database,
  ftsQuery: string,
  options: EpisodeSearchOptions,
  limit: number,
  now: number,
  diagnostics?: EpisodeSearchDiagnostics,
  /** the coverage pass only counts which terms a turn matched: it reads no score */
  score = true
): Array<{ episode: Episode; bm25: number }> {
  const predicates = episodePredicates(options, now)
  const conditions = ['episodes_fts MATCH ?', ...predicates.sql]
  const scoped = Boolean(options.namespace || options.namespace_subtree)
  // a whole-index bm25 cannot pick a scoped window: which turns made the cut would again depend
  // on what other namespaces wrote, so a scoped query cuts on length, still out of the scope's
  // own matches, and the score below decides the order. the window stays the caller's
  // over-fetch, which is already a multiple of the list the fusion cuts to
  const order = scoped
    ? `${EPISODE_DL} ASC, e.rowid ASC`
    : `bm25(episodes_fts, ${EPISODE_FTS_CONTENT_WEIGHT}) ASC, e.rowid ASC`
  try {
    const rows = db
      .prepare(
        `SELECT e.*, ${EPISODE_DL} AS scope_dl,
                bm25(episodes_fts, ${EPISODE_FTS_CONTENT_WEIGHT}) AS relevance_bm25
         FROM episodes_fts fts
         JOIN episodes e ON fts.rowid = e.rowid
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${order}
         LIMIT ?`
      )
      .all(ftsQuery, ...predicates.params, limit) as Array<
      EpisodeRow & { relevance_bm25: number; scope_dl: number }
    >
    const hits = rows.map((row) => ({ episode: episodeRowToEpisode(row), bm25: row.relevance_bm25 }))
    if (scoped && score) scoreEpisodesInScope(db, options, ftsQuery, hits, rows)
    return hits
  } catch {
    diagnostics?.degraded.push('episodes-fts')
    return []
  }
}

/**
 * the scope's own statistics replace the whole-index score. the corpus is the scope's episodes
 * under its namespace predicate alone: expiry hides a row from one read, so it follows the
 * read's clock, while a corpus statistic follows writes.
 */
function scoreEpisodesInScope(
  db: Database.Database,
  options: EpisodeSearchOptions,
  ftsQuery: string,
  hits: Array<{ episode: Episode; bm25: number }>,
  rows: Array<EpisodeRow & { scope_dl: number }>
): void {
  const scope = episodeNamespaceFilter(options, 'e')
  if (!scope.sql) return
  scoreRowsInScope(
    db,
    options,
    { predicates: { sql: scope.sql, params: scope.params }, narrowing: null },
    EPISODE_SCOPE_CHANNEL,
    quotedTerms(ftsQuery),
    hits,
    rows.map((row) => ({ columns: [row.content], dl: row.scope_dl }))
  )
  hits.sort((a, b) => a.bm25 - b.bm25)
}

function episodeFtsHits(
  db: Database.Database,
  query: string,
  options: EpisodeSearchOptions,
  limit: number,
  now: number,
  score: boolean
): Array<{ episode: Episode; bm25: number }> {
  const diagnostics = options.diagnostics
  for (const ftsQuery of episodeFtsQueries(query)) {
    const rows = execEpisodeFts(db, ftsQuery, options, limit, now, diagnostics, score)
    if (rows.length > 0) return rows
  }
  return []
}

export function episodeLexicalHits(
  db: Database.Database,
  query: string,
  options: EpisodeSearchOptions = {},
  limit = 10,
  now: number = Date.now()
): Array<{ episode: Episode; bm25: number }> {
  return episodeFtsHits(db, query, options, limit, now, true)
}

/** the stored evidence, fetched by rowid so a scoped knn never joins a filtered table */
function episodesByVecRowids(
  db: Database.Database,
  rows: Array<{ rowid: number; distance: number }>,
  options: EpisodeSearchOptions,
  now: number
): Array<{ episode: Episode; distance: number }> {
  if (rows.length === 0) return []
  const distanceByRowid = new Map<number, number>()
  for (const row of rows) distanceByRowid.set(row.rowid, row.distance)
  const rowids = [...distanceByRowid.keys()]
  const placeholders = rowids.map(() => '?').join(', ')
  const predicates = episodePredicates(options, now)
  const found = db
    .prepare(`SELECT e.* FROM episodes e WHERE e.vec_rowid IN (${placeholders})
      ${predicates.sql.length ? `AND ${predicates.sql.join(' AND ')}` : ''}`)
    .all(...rowids, ...predicates.params) as EpisodeRow[]
  const out: Array<{ episode: Episode; distance: number }> = []
  for (const row of found) {
    const distance = row.vec_rowid === null || row.vec_rowid === undefined ? undefined : distanceByRowid.get(row.vec_rowid)
    if (distance === undefined) continue
    out.push({ episode: episodeRowToEpisode(row), distance })
  }
  return out.sort(
    (a, b) =>
      a.distance - b.distance || (a.episode.id < b.episode.id ? -1 : a.episode.id > b.episode.id ? 1 : 0)
  )
}

function sortByDistance(
  rows: Array<{ rowid: number; distance: number }>,
  limit: number
): Array<{ rowid: number; distance: number }> {
  return [...rows].sort((a, b) => a.distance - b.distance || a.rowid - b.rowid).slice(0, limit)
}

/** a build that rejects the scoped knn shape fails the probe; empty scope on purpose */
function episodeKnnRowidFilterIsSupported(db: Database.Database, queryVec: Buffer): boolean {
  if (knnRowidFilterSupported === null) {
    try {
      db.prepare(
        `SELECT rowid FROM episode_vectors
         WHERE embedding MATCH ? AND k = 1
           AND rowid IN (SELECT vec_rowid FROM episodes WHERE 1 = 0)`
      ).all(queryVec)
      knnRowidFilterSupported = true
    } catch {
      knnRowidFilterSupported = false
    }
  }
  return knnRowidFilterSupported
}

export function episodeVectorHits(
  db: Database.Database,
  embedding: Float32Array,
  options: EpisodeSearchOptions = {},
  limit = 10,
  now: number = Date.now()
): Array<{ episode: Episode; distance: number }> {
  const queryVec = Buffer.from(embedding.buffer)
  const predicates = episodePredicates(options, now)
  try {
    if (predicates.sql.length === 0) {
      return episodesByVecRowids(
        db,
        db
          .prepare('SELECT rowid, distance FROM episode_vectors WHERE embedding MATCH ? LIMIT ?')
          .all(queryVec, limit) as Array<{ rowid: number; distance: number }>,
        options, now
      )
    }
    if (episodeKnnRowidFilterIsSupported(db, queryVec)) {
      const rows = db
        .prepare(
          `SELECT rowid, distance FROM episode_vectors
           WHERE embedding MATCH ? AND k = ?
             AND rowid IN (SELECT e.vec_rowid FROM episodes e
                           WHERE e.vec_rowid IS NOT NULL AND ${predicates.sql.join(' AND ')})`
        )
        .all(queryVec, limit, ...predicates.params) as Array<{ rowid: number; distance: number }>
      return episodesByVecRowids(db, sortByDistance(rows, limit), options, now)
    }
    // a build that rejects the set expression ranks the whole index instead; exact,
    // but a full scan, so it runs second
    const ids = new Set(
      (
        db
          .prepare(
            `SELECT e.vec_rowid AS rowid FROM episodes e
             WHERE e.vec_rowid IS NOT NULL AND ${predicates.sql.join(' AND ')}`
          )
          .all(...predicates.params) as Array<{ rowid: number }>
      ).map((row) => row.rowid)
    )
    if (ids.size === 0) return []
    const total = (db.prepare('SELECT COUNT(*) AS n FROM episode_vectors').get() as { n: number }).n
    if (total === 0) return []
    const all = db
      .prepare('SELECT rowid, distance FROM episode_vectors WHERE embedding MATCH ? AND k = ?')
      .all(queryVec, total) as Array<{ rowid: number; distance: number }>
    return episodesByVecRowids(
      db,
      sortByDistance(
        all.filter((row) => ids.has(row.rowid)),
        limit
      ),
      options, now
    )
  } catch {
    options.diagnostics?.degraded.push('episodes-vector')
    return []
  }
}

function listTerms(text: string): string[] {
  const unquoted =
    text.startsWith('"') && text.endsWith('"') && text.length > 1 ? text.slice(1, -1) : text
  return queryTokens(unquoted)
}

/**
 * the channel a query turns into: one lexical list, plus the vector list when a
 * model is available. relevance is the fused evidence, score adds the recency prior.
 */
export async function searchEpisodes(
  db: Database.Database,
  vectorsAvailable: boolean,
  query: string,
  options: EpisodeSearchOptions = {}
): Promise<EpisodeSearchResult> {
  const limit = Math.max(1, options.limit ?? 10)
  const now = options.now ?? Date.now()
  const diagnostics = options.diagnostics ?? { degraded: [] }
  const overFetch = Math.max(limit * 5, 50)

  const hits = episodeLexicalHits(db, query, options, overFetch, now)
  const terms = listTerms(query)
  const lexById = new Map<string, { episode: Episode; relevance: number; bm25?: number }>()
  const maxPerTerm = hits.reduce(
    (max, hit) => Math.max(max, -hit.bm25 / Math.max(1, terms.length)),
    0
  )
  if (maxPerTerm >= BM25_MAGNITUDE_EPS) {
    for (const hit of hits) {
      lexById.set(hit.episode.id, {
        episode: hit.episode,
        relevance: bm25Relevance(hit.bm25, terms.length),
        bm25: hit.bm25,
      })
    }
  } else if (terms.length > 0) {
    // the clamped regime reports no magnitude, so coverage carries the evidence. a term's
    // hit list is read for membership alone here, so it is built without a scope rescore
    const matched = new Map<string, number>()
    const byId = new Map<string, Episode>()
    for (const term of terms) {
      for (const hit of episodeFtsHits(db, term, options, overFetch, now, false)) {
        matched.set(hit.episode.id, (matched.get(hit.episode.id) ?? 0) + 1)
        byId.set(hit.episode.id, hit.episode)
      }
    }
    for (const [id, episode] of byId) {
      lexById.set(id, { episode, relevance: (matched.get(id) ?? 0) / terms.length })
    }
  }

  const vecById = new Map<string, { episode: Episode; relevance: number; distance: number }>()
  if (vectorsAvailable) {
    let queryEmbed: Float32Array | null = null
    try {
      queryEmbed = await embedEpisodeText(query, 'query')
    } catch {
      queryEmbed = null
    }
    if (!queryEmbed) {
      diagnostics.degraded.push('embedding')
    } else {
      for (const { episode, distance } of episodeVectorHits(db, queryEmbed, options, overFetch, now)) {
        vecById.set(episode.id, { episode, relevance: distanceRelevance(distance), distance })
      }
    }
  }

  const candidates = new Map<
    string,
    { lex: number; vec: number; episode: Episode; bm25?: number; distance?: number }
  >()
  for (const [id, entry] of lexById) {
    candidates.set(id, {
      lex: entry.relevance,
      vec: 0,
      episode: entry.episode,
      ...(entry.bm25 === undefined ? {} : { bm25: entry.bm25 }),
    })
  }
  for (const [id, entry] of vecById) {
    const existing = candidates.get(id)
    if (existing) {
      existing.vec = entry.relevance
      existing.distance = entry.distance
    } else {
      candidates.set(id, {
        lex: 0,
        vec: entry.relevance,
        episode: entry.episode,
        distance: entry.distance,
      })
    }
  }

  const weights = { ...WEIGHT_PROFILES[classifyQuery(query)] }
  if (vecById.size === 0 && weights.vec > 0) {
    const spare = weights.vec
    weights.vec = 0
    const rest = weights.fts + weights.recency + weights.access + weights.importance
    if (rest > 0) {
      const scale = (rest + spare) / rest
      weights.fts *= scale
      weights.recency *= scale
      weights.access *= scale
      weights.importance *= scale
    }
  }

  const candidateOrder = new Map<string, number>()
  for (const id of candidates.keys()) candidateOrder.set(id, candidateOrder.size)

  const out: EpisodeHit[] = [...candidates.values()].map(({ lex, vec, episode, bm25, distance }) => {
    const recency = episodeRecency(episode.occurred_at, now)
    const access = Math.min(Math.log(EPISODE_ACCESS_COUNT + 1) / Math.log(100), 1)
    const signals: Record<SignalKey, number> = {
      fts: weights.fts * lex,
      vec: weights.vec * vec,
      recency: weights.recency * recency,
      access: weights.access * access,
      importance: weights.importance * EPISODE_IMPORTANCE,
      reranker: 0,
    }
    const evidenceMass = weights.fts + weights.vec
    const score =
      signals.fts + signals.vec + signals.recency + signals.access + signals.importance
    return {
      episode,
      score,
      relevance: evidenceMass > 0 ? (signals.fts + signals.vec) / evidenceMass : 0,
      ...(bm25 === undefined ? {} : { bm25 }),
      ...(distance === undefined ? {} : { distance }),
      signals,
    }
  })

  out.sort(
    (a, b) =>
      b.score - a.score ||
      (candidateOrder.get(a.episode.id) ?? 0) - (candidateOrder.get(b.episode.id) ?? 0)
  )
  return { hits: out.slice(0, limit), degraded: diagnostics.degraded }
}
