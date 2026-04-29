/**
 * Supersession filter helpers.
 *
 * Latest-wins contradiction resolution is link-derived: a memory is considered
 * "superseded" when at least one `memory_links` row of `link_type='supersedes'`
 * with `confidence >= SUPERSEDES_FILTER_THRESHOLD` points at it.
 *
 * This module exposes the threshold + a SQL fragment so every read path stays
 * consistent. Default reads filter superseded rows out; callers can opt-in to
 * include them via `include_superseded=true` for audit/debug workflows.
 */

export const SUPERSEDES_FILTER_THRESHOLD = 0.8

/**
 * Returns a SQL fragment that evaluates to TRUE when the row referenced by
 * `aliasIdExpr` is NOT superseded. Designed to be appended to a WHERE clause:
 *
 *   WHERE ... AND <notSupersededClause('m.id')>
 *
 * The clause is a bound-parameter-free literal so it composes cleanly with any
 * surrounding query without disrupting the parameter index.
 */
export function notSupersededClause(aliasIdExpr: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM memory_links sl
    WHERE sl.target_id = ${aliasIdExpr}
      AND sl.link_type = 'supersedes'
      AND sl.confidence >= ${SUPERSEDES_FILTER_THRESHOLD}
  )`
}
