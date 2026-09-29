import type Database from 'better-sqlite3'
import type { Memory } from '../types.js'
import { MEMORY_ENTITY_FTS, lexicalIndexTablePresent } from '../../db/lexical-index.js'
import { rowToMemory, type MemoryRow } from '../row.js'
import type { ScoredLexicalHit, SearchDiagnostics, SearchOptions } from './hybrid.js'
import { namespaceFilter, temporalFilter } from './scope.js'
import {
  combineFilters,
  docLengthSql,
  SCOPED_WINDOW_CEILING,
  scopeNarrowing,
  scoreRowsInScope,
  type ChannelSpec,
} from './scoped-stats.js'

/** dropped only when another token survives, so an all-stopword query still searches */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'from', 'this', 'that', 'with', 'was', 'were', 'are',
  'how', 'does', 'did', 'what', 'when', 'where', 'which', 'why', 'who', 'into',
  'over', 'under', 'its', 'our', 'their', 'have', 'has', 'had', 'can', 'not',
  'but', 'any', 'all', 'not', 'use', 'used', 'using', 'about',
])

/**
 * multi-token prefix search: the store's entity lookup is exact-match, so a prose
 * query would never reach an identifier
 */
export function entitySearch(
  db: Database.Database,
  query: string,
  options: SearchOptions,
  limit: number
): Memory[] {
  const tokens = entityQueryTokens(query)
  if (tokens.length === 0) return []

  const hits = entitySearchHits(db, tokens, options, limit)
  return hits
    .sort(
      (a, b) =>
        a.bm25 - b.bm25 ||
        b.memory.created_at - a.memory.created_at ||
        (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0)
    )
    .slice(0, limit)
    .map((hit) => hit.memory)
}

export interface ScoredEntityHit extends ScoredLexicalHit {
  /** tie-break on rowid, not id: the id is a fresh uuid per store */
  rowid: number
}

/** same ranking as entitySearch, with the bm25 magnitude the fusion needs */
export function entitySearchScored(
  db: Database.Database,
  query: string,
  options: SearchOptions,
  limit: number,
  diagnostics?: SearchDiagnostics
): ScoredEntityHit[] {
  const tokens = entityQueryTokens(query)
  if (tokens.length === 0) return []

  return entitySearchHits(db, tokens, options, limit, diagnostics)
    .sort((a, b) => a.bm25 - b.bm25 || a.rowid - b.rowid)
    .slice(0, limit)
}

/** exported for tests: `[a-z0-9]+` only, so the MATCH string cannot carry FTS5 syntax */
export function entityQueryTokens(query: string): string[] {
  const words = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  // short tokens go only when a longer one survives, so a query that is just an
  // identifier (`db`, `ts`) still searches for it
  const withoutStopwords = words.filter((t) => !STOPWORDS.has(t))
  const candidates = withoutStopwords.length > 0 ? withoutStopwords : words
  const longEnough = candidates.filter((t) => t.length >= 3)
  const tokens = longEnough.length > 0 ? longEnough : candidates
  return [...new Set(tokens)]
}

function entitySearchHits(
  db: Database.Database,
  tokens: string[],
  options: SearchOptions,
  limit: number,
  diagnostics?: SearchDiagnostics
): ScoredEntityHit[] {
  const andRows = entityExec(
    db,
    tokens.map((t) => `${t}*`).join(' '),
    options,
    limit,
    diagnostics
  )
  if (andRows.length > 0 || tokens.length === 1) return andRows
  return entityExec(
    db,
    tokens.map((t) => `${t}*`).join(' OR '),
    options,
    limit,
    diagnostics
  )
}

// one indexed column and the memory it belongs to, so the scope filter reaches the rows
const ENTITY_SCOPE_CHANNEL: ChannelSpec = {
  table: MEMORY_ENTITY_FTS,
  from: `${MEMORY_ENTITY_FTS} f JOIN memories m ON m.id = f.memory_id`,
  dfExpr: 'COUNT(DISTINCT f.memory_id)',
  weights: [1],
  prefix: true,
}

/** the scored terms of an entity query: its bare prefix tokens, minus the operator */
export function entityScoredTerms(ftsQuery: string): string[] {
  const terms = ftsQuery
    .trim()
    .split(/\s+/)
    .filter((token) => token !== 'OR')
    .map((token) => token.replace(/\*$/, '').toLowerCase())
  return [...new Set(terms.filter(Boolean))]
}

function entityExec(
  db: Database.Database,
  ftsQuery: string,
  options: SearchOptions,
  limit: number,
  diagnostics?: SearchDiagnostics
): ScoredEntityHit[] {
  // bm25() is only usable in a query over the FTS table itself (inside a CTE it
  // fails), so entities are ranked first and joined to memories after. the scope filter
  // rides in that join, or the window would be the whole index's top k, and a busy
  // namespace could crowd this one's entities out of it before the filter ran.
  const scoped = Boolean(options.namespace_subtree || options.project_path)
  const overFetch = scoped ? SCOPED_WINDOW_CEILING : Math.max(limit * 5, 50)
  const rankingFilters: Array<{ sql: string; params: unknown[] }> = []
  const scope = namespaceFilter('m', options)
  if (scope.sql) rankingFilters.push(scope)
  if (options.type) rankingFilters.push({ sql: 'm.type = ?', params: [options.type] })
  const temporal = temporalFilter('m', options)
  if (temporal.sql) rankingFilters.push(temporal)
  const joined = combineFilters(rankingFilters)

  // fts5 MATCH needs the table name; an alias is not accepted
  let hitRows: Array<{ memory_id: string; ident: string | null; score: number }>
  try {
    hitRows = db
      .prepare(
        `SELECT f.memory_id AS memory_id, f.ident AS ident, bm25(${MEMORY_ENTITY_FTS}) AS score
         FROM ${ENTITY_SCOPE_CHANNEL.from}
         WHERE ${[`${MEMORY_ENTITY_FTS} MATCH ?`, joined.sql].filter(Boolean).join(' AND ')}
         ORDER BY ${scoped ? `length(COALESCE(f.ident, '')) ASC, f.rowid ASC` : `bm25(${MEMORY_ENTITY_FTS}) ASC, f.rowid ASC`}
         LIMIT ?`
      )
      .all(ftsQuery, ...joined.params, overFetch) as typeof hitRows
  } catch {
    // a missing index is not a failure, just no evidence yet
    if (lexicalIndexTablePresent(db, MEMORY_ENTITY_FTS)) diagnostics?.degraded.push('entity')
    return []
  }

  const best = new Map<string, { score: number; ident: string }>()
  for (const row of hitRows) {
    const prev = best.get(row.memory_id)
    if (prev === undefined || row.score < prev.score) {
      best.set(row.memory_id, { score: row.score, ident: row.ident ?? '' })
    }
  }
  if (best.size === 0) return []

  const ids = [...best.keys()]
  const conditions: string[] = [`m.id IN (${ids.map(() => '?').join(',')})`]
  const values: unknown[] = [...ids]
  if (joined.sql) {
    conditions.push(joined.sql)
    values.push(...joined.params)
  }

  const rows = db
    .prepare(
      `SELECT m.*, m.rowid AS memory_rowid, ${docLengthSql('m')} AS scope_dl FROM memories m WHERE ${conditions.join(' AND ')}`
    )
    .all(...values) as Array<MemoryRow & { memory_rowid: number; scope_dl: number }>

  const hits = rows.map((row) => ({
    memory: rowToMemory(row),
    bm25: best.get(row.id)?.score ?? 0,
    rowid: row.memory_rowid,
  }))

  if (scope.sql) {
    scoreRowsInScope(
      db,
      options,
      { predicates: joined, narrowing: scopeNarrowing(options) },
      ENTITY_SCOPE_CHANNEL,
      entityScoredTerms(ftsQuery),
      hits,
      rows.map((row) => ({ columns: [best.get(row.id)?.ident ?? ''], dl: row.scope_dl }))
    )
  }
  return hits
}
