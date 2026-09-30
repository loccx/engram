// shared by every retrieval channel: a channel that skips the namespace subtree
// filter leaks another project's memories, so the escaping must match hybrid.ts

import {
  notSupersededClause,
  notSupersededAtClause,
  validityAtClause,
} from '../../contradictions/supersession.js'
import { visibilityClause, type CallerScope } from '../access.js'

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
  if (options.namespace_subtree) {
    const ns = options.namespace_subtree
    // _ and % are LIKE wildcards: escape them or a namespace matches sibling prefixes
    const esc = ns.replace(/[\\%_]/g, '\\$&')
    return {
      sql:
        `(${nsExpr} = ?` +
        ` OR ${nsExpr} LIKE ? ESCAPE '\\'` +
        ` OR ${nsExpr} LIKE ? ESCAPE '\\')`,
      params: [ns, `${esc}/%`, `${esc}//%`],
    }
  }
  if (options.project_path) {
    return { sql: `${nsExpr} = ?`, params: [options.project_path] }
  }
  return { sql: '', params: [] }
}

export interface TemporalFilterOptions {
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
    if (options.as_of !== undefined) {
      clauses.push(
        notSupersededAtClause(`${alias}.id`, '?', {
          includeArchived: options.include_archived === true,
        })
      )
      params.push(options.as_of)
    } else {
      clauses.push(
        notSupersededClause(`${alias}.id`, { includeArchived: options.include_archived === true })
      )
    }
  } else if (!options.include_archived) {
    clauses.push(`${alias}.archived_at IS NULL`)
  }
  return { sql: clauses.join(' AND '), params }
}
