import type Database from 'better-sqlite3'
import type { Memory } from '../types.js'
import { MEMORIES_IDENT_FTS, lexicalIndexTablePresent } from '../../db/lexical-index.js'
import { rowToMemory, type MemoryRow } from '../row.js'
import type { ScoredLexicalHit, SearchDiagnostics, SearchOptions } from './hybrid.js'
import { namespaceFilter, temporalFilter } from './scope.js'
import {
  combineFilters,
  docLengthSql,
  quotedTerms,
  scopeNarrowing,
  scopedWindow,
  scoreRowsInScope,
  type ChannelSpec,
} from './scoped-stats.js'

// one indexed column, so the whole-index bm25 and the scope-local one carry weight 1
const IDENT_SCOPE_CHANNEL: ChannelSpec = {
  table: MEMORIES_IDENT_FTS,
  from: `${MEMORIES_IDENT_FTS} f JOIN memories m ON f.rowid = m.rowid`,
  dfExpr: 'COUNT(*)',
  weights: [1],
  prefix: false,
}

// the stored text is normalised, so every notation matches it and the query side needs
// no help
export function identSearch(
  db: Database.Database,
  query: string,
  options: SearchOptions,
  limit: number
): Memory[] {
  return identSearchScored(db, query, options, limit).map((hit) => hit.memory)
}

/** keeps the bm25 magnitude, which the fusion needs and a Memory[] has dropped */
export function identSearchScored(
  db: Database.Database,
  query: string,
  options: SearchOptions,
  limit: number,
  diagnostics?: SearchDiagnostics
): ScoredLexicalHit[] {
  const tokens = identQueryTokens(query)
  if (tokens.length === 0) return []

  const andRows = identExecScored(db, tokens.join(' '), options, limit, diagnostics)
  if (andRows.length > 0 || tokens.length <= 2) return andRows
  return identExecScored(db, tokens.join(' OR '), options, limit, diagnostics)
}

/** every token quoted, so none can be read as FTS5 operator syntax */
function identQueryTokens(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
}

function identExecScored(
  db: Database.Database,
  ftsQuery: string,
  options: SearchOptions,
  limit: number,
  diagnostics?: SearchDiagnostics
): ScoredLexicalHit[] {
  const conditions: string[] = [`${MEMORIES_IDENT_FTS} MATCH ?`]
  const values: unknown[] = [ftsQuery]

  // the scope-local statistics count the same rows this query can serve, so the filter
  // fragments are kept in one list and reused in both places
  const scope = namespaceFilter('m', options)
  const rankingFilters: Array<{ sql: string; params: unknown[] }> = []
  if (scope.sql) rankingFilters.push(scope)
  if (options.type) rankingFilters.push({ sql: 'm.type = ?', params: [options.type] })
  const temporal = temporalFilter('m', options)
  if (temporal.sql) rankingFilters.push(temporal)

  for (const filter of rankingFilters) {
    conditions.push(filter.sql)
    values.push(...filter.params)
  }
  const window = scopedWindow(options, limit)
  values.push(window)

  // a scoped query ranks its own matches, so its window cannot come from the whole-index bm25
  const order =
    window === limit
      ? `bm25(${MEMORIES_IDENT_FTS}) ASC, m.rowid ASC`
      : `${docLengthSql('m')} ASC, m.rowid ASC`

  try {
    const rows = db
      .prepare(
        `SELECT m.*, ${docLengthSql('m')} AS scope_dl, bm25(${MEMORIES_IDENT_FTS}) AS relevance_bm25 FROM ${MEMORIES_IDENT_FTS} fts
         JOIN memories m ON fts.rowid = m.rowid
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${order}
         LIMIT ?`
      )
      .all(...values) as Array<MemoryRow & { ident_text?: string | null; relevance_bm25: number; scope_dl: number }>

    const hits = rows.map((row) => ({ memory: rowToMemory(row), bm25: row.relevance_bm25 }))
    if (scope.sql) {
      scoreRowsInScope(
        db,
        options,
        { predicates: combineFilters(rankingFilters), narrowing: scopeNarrowing(options) },
        IDENT_SCOPE_CHANNEL,
        quotedTerms(ftsQuery),
        hits,
        rows.map((row) => ({ columns: [row.ident_text ?? ''], dl: row.scope_dl }))
      )
      hits.sort((a, b) => a.bm25 - b.bm25)
    }
    return hits
  } catch {
    // a missing index only means no evidence yet; a failed MATCH with the index
    // present is a real degradation
    if (lexicalIndexTablePresent(db, MEMORIES_IDENT_FTS)) diagnostics?.degraded.push('ident')
    return []
  }
}
