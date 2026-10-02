// shared by every retrieval channel: a channel that skips the namespace subtree
// filter leaks another project's memories, so the escaping must match hybrid.ts

import {
  notSupersededClause,
  notSupersededAtClause,
  validityAtClause,
} from '../../contradictions/supersession.js'
import { currentCaller, readGrantClause, visibilityClause, type CallerScope } from '../access.js'

export interface NamespaceFilterOptions {
  namespace_subtree?: string
  project_path?: string
  /** the identity a read is served as; defaults to the caller in scope */
  caller?: CallerScope
}

/**
 * `sql` is a bare clause and empty when unscoped: callers must treat empty as no filter.
 * the visibility predicate rides here rather than at each call site, so lexical, vector,
 * entity, graph, episode and statistic channels all serve the same rows.
 */
export function namespaceFilter(
  alias: string,
  options: NamespaceFilterOptions
): { sql: string; params: unknown[] } {
  const scope = namespaceClause(`COALESCE(${alias}.namespace, ${alias}.project_path)`, options)
  const visibility = visibilityClause(alias, options.caller)
  return {
    sql: scope.sql ? `${scope.sql} AND ${visibility.sql}` : visibility.sql,
    params: [...scope.params, ...visibility.params],
  }
}

/**
 * the same predicate over any namespace expression: a layer that keeps the scope key in one
 * column of its own (the write epoch, the episodes table) passes that column here, so the
 * clause a statistic or a change signal reads is the clause the query itself applied.
 */
export function namespaceClause(
  nsExpr: string,
  options: NamespaceFilterOptions
): { sql: string; params: unknown[] } {
  const query = queryNamespaceClause(nsExpr, options)
  const grants = readGrantClause(nsExpr, options.caller)
  return {
    sql: [query.sql, grants.sql].filter(Boolean).join(' AND '),
    params: [...query.params, ...grants.params],
  }
}

function queryNamespaceClause(
  nsExpr: string,
  options: NamespaceFilterOptions
): { sql: string; params: unknown[] } {
  if (options.namespace_subtree) {
    const ns = options.namespace_subtree
    // _ and % are LIKE wildcards: escape them or a namespace matches sibling prefixes
    const esc = ns.replace(/[\\%_]/g, '\\$&')
    const localOwner = (options.caller ?? currentCaller()).localOwner
    // the local query retains its historical like semantics; named queries match the
    // case-sensitive grant boundary instead of widening through sqlite's ascii folding.
    return {
      sql:
        `(${nsExpr} = ?` +
        (localOwner
          ? ` OR ${nsExpr} LIKE ? ESCAPE '\\' OR ${nsExpr} LIKE ? ESCAPE '\\')`
          : ` OR (${nsExpr} LIKE ? ESCAPE '\\' AND instr(${nsExpr}, ?) = 1)` +
            ` OR (${nsExpr} LIKE ? ESCAPE '\\' AND instr(${nsExpr}, ?) = 1))`),
      params: localOwner
        ? [ns, `${esc}/%`, `${esc}//%`]
        : [ns, `${esc}/%`, `${ns}/`, `${esc}//%`, `${ns}//`],
    }
  }
  if (options.project_path) {
    return { sql: `${nsExpr} = ?`, params: [options.project_path] }
  }
  return { sql: '', params: [] }
}

export interface TemporalFilterOptions extends NamespaceFilterOptions {
  as_of?: number
  before?: number
  include_superseded?: boolean
  /** audit read-back: archived rows stay hidden otherwise, as in hybrid.ts */
  include_archived?: boolean
}

// as_of wins over before, and supersession is time-aware whenever as_of is set
export function temporalFilter(
  alias: string,
  options: TemporalFilterOptions
): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (options.as_of !== undefined) {
    clauses.push(validityAtClause(alias, '?'))
    params.push(options.as_of, options.as_of)
  } else if (options.before !== undefined) {
    clauses.push(`${alias}.valid_from <= ?`)
    params.push(options.before)
  }
  if (!options.include_superseded) {
    const successor = namespaceFilter('superseder', options)
    const supersessionOptions = {
      includeArchived: options.include_archived === true,
      successorFilter: successor.sql,
    }
    if (options.as_of !== undefined) {
      clauses.push(
        notSupersededAtClause(`${alias}.id`, '?', supersessionOptions)
      )
      params.push(options.as_of)
    } else {
      clauses.push(
        notSupersededClause(`${alias}.id`, supersessionOptions)
      )
    }
    params.push(...successor.params)
  } else if (!options.include_archived) {
    clauses.push(`${alias}.archived_at IS NULL`)
  }
  return { sql: clauses.join(' AND '), params }
}
