import type Database from 'better-sqlite3'
import type { Memory } from '../types.js'
import { MEMORIES_IDENT_FTS, lexicalIndexTablePresent } from '../../db/lexical-index.js'
import { rowToMemory, type MemoryRow } from '../row.js'
import type { ScoredLexicalHit, SearchDiagnostics, SearchOptions } from './hybrid.js'
import { namespaceFilter, temporalFilter } from './scope.js'

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

  const scope = namespaceFilter('m', options)
  if (scope.sql) {
    conditions.push(scope.sql)
    values.push(...scope.params)
  }
  if (options.type) {
    conditions.push('m.type = ?')
    values.push(options.type)
  }
  const temporal = temporalFilter('m', options)
  if (temporal.sql) {
    conditions.push(temporal.sql)
    values.push(...temporal.params)
  }
  values.push(limit)

  try {
    const rows = db
      .prepare(
        `SELECT m.*, bm25(${MEMORIES_IDENT_FTS}) AS relevance_bm25 FROM ${MEMORIES_IDENT_FTS} fts
         JOIN memories m ON fts.rowid = m.rowid
         WHERE ${conditions.join(' AND ')}
         ORDER BY bm25(${MEMORIES_IDENT_FTS}) ASC, m.rowid ASC
         LIMIT ?`
      )
      .all(...values) as Array<MemoryRow & { relevance_bm25: number }>
    return rows.map((row) => ({ memory: rowToMemory(row), bm25: row.relevance_bm25 }))
  } catch {
    // a missing index only means no evidence yet; a failed MATCH with the index
    // present is a real degradation
    if (lexicalIndexTablePresent(db, MEMORIES_IDENT_FTS)) diagnostics?.degraded.push('ident')
    return []
  }
}
