// shared by every retrieval channel: a channel that skips the namespace subtree
// filter leaks another project's memories, so the escaping must match hybrid.ts

import {
  notSupersededClause,
  notSupersededAtClause,
  validityAtClause,
} from '../../contradictions/supersession.js'

export interface NamespaceFilterOptions {
  namespace_subtree?: string
  project_path?: string
}

// `sql` is a bare clause and empty when unscoped: callers must treat empty as no filter
export function namespaceFilter(
  alias: string,
  options: NamespaceFilterOptions
): { sql: string; params: unknown[] } {
  return namespaceClause(`COALESCE(${alias}.namespace, ${alias}.project_path)`, options)
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
      clauses.push(notSupersededAtClause(`${alias}.id`, '?'))
      params.push(options.as_of)
    } else {
      clauses.push(notSupersededClause(`${alias}.id`))
    }
  }
  return { sql: clauses.join(' AND '), params }
}
