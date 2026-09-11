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

/**
 * Time-aware supersession filter for historical (`as_of`) reads.
 *
 * Unlike `notSupersededClause` (which reflects the *present* link graph), this
 * only counts supersedes links that were already judged at `whenExpr`, so a
 * fact superseded later still appears in a historical snapshot.
 *
 * `whenExpr` is a SQL expression. Pass `'?'` and push the bound timestamp in
 * the exact position where this fragment lands in the parameter sequence.
 * The fragment itself adds no bound parameters.
 */
export function notSupersededAtClause(aliasIdExpr: string, whenExpr: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM memory_links sl
    WHERE sl.target_id = ${aliasIdExpr}
      AND sl.link_type = 'supersedes'
      AND sl.confidence >= ${SUPERSEDES_FILTER_THRESHOLD}
      AND COALESCE(sl.judged_at, sl.created_at) <= ${whenExpr}
  )`
}

/**
 * Full bi-temporal validity predicate: a fact holds at time `whenExpr` when
 * valid_from <= when AND (valid_until IS NULL OR valid_until >= when).
 * Both boundaries are inclusive, matching the existing "`>=` filters out"
 * convention (see tests/supersession.test.ts boundary test).
 *
 * Bound-parameter-free composition contract: pass `'?'` as `whenExpr` and
 * push the same timestamp value TWICE in the exact position where this
 * fragment lands in the parameter sequence (the placeholder appears in both
 * the valid_from and valid_until comparisons, so two binds are required).
 */
export function validityAtClause(aliasExpr: string, whenExpr: string): string {
  return `(${aliasExpr}.valid_from <= ${whenExpr} AND (${aliasExpr}.valid_until IS NULL OR ${aliasExpr}.valid_until >= ${whenExpr}))`
}
