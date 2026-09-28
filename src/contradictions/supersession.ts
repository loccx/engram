// supersession filters. latest-wins is link-derived: a row counts as superseded when a
// memory_links row of link_type='supersedes' with confidence >= the threshold points at
// it. the threshold and sql fragment live here so every read path agrees, default reads
// hide superseded rows, and include_superseded opts back in for audit. the archive filter
// composes into the same fragments, so those reads hide archived rows by construction.

export interface SupersessionClauseOptions {
  /** audit reads only */
  includeArchived?: boolean
}

export const SUPERSEDES_FILTER_THRESHOLD = 0.8

// the archive filter needs the row alias, not just the id, to reach archived_at;
// null for anything that is not `<alias>.id`, and the filter is omitted then
function rowAlias(aliasIdExpr: string): string | null {
  const suffix = '.id'
  return aliasIdExpr.endsWith(suffix) ? aliasIdExpr.slice(0, -suffix.length) : null
}

// bound-parameter free: a `?` here would shift every caller's parameter index
function archivedAtClause(aliasIdExpr: string, includeArchived: boolean): string {
  if (includeArchived) return ''
  const alias = rowAlias(aliasIdExpr)
  return alias ? `
    AND ${alias}.archived_at IS NULL` : ''
}

/** true when the row at `aliasIdExpr` is neither superseded nor archived */
export function notSupersededClause(
  aliasIdExpr: string,
  opts: SupersessionClauseOptions = {}
): string {
  return `NOT EXISTS (
    SELECT 1 FROM memory_links sl
    WHERE sl.target_id = ${aliasIdExpr}
      AND sl.link_type = 'supersedes'
      AND sl.confidence >= ${SUPERSEDES_FILTER_THRESHOLD}
  )${archivedAtClause(aliasIdExpr, opts.includeArchived === true)}`
}

// only supersedes links already judged at `whenExpr` count, so a fact superseded
// later still appears in a historical snapshot. whenExpr is a SQL expression:
// pass `'?'` and push the timestamp where the fragment lands; it adds no binds.
export function notSupersededAtClause(
  aliasIdExpr: string,
  whenExpr: string,
  opts: SupersessionClauseOptions = {}
): string {
  return `NOT EXISTS (
    SELECT 1 FROM memory_links sl
    WHERE sl.target_id = ${aliasIdExpr}
      AND sl.link_type = 'supersedes'
      AND sl.confidence >= ${SUPERSEDES_FILTER_THRESHOLD}
      AND COALESCE(sl.judged_at, sl.created_at) <= ${whenExpr}
  )${archivedAtClause(aliasIdExpr, opts.includeArchived === true)}`
}

/**
 * full bi-temporal validity, boundaries inclusive: valid_from <= when AND (valid_until IS
 * NULL OR valid_until >= when). pass `'?'` as whenExpr and bind the timestamp twice, once
 * for each comparison.
 */
export function validityAtClause(aliasExpr: string, whenExpr: string): string {
  return `(${aliasExpr}.valid_from <= ${whenExpr} AND (${aliasExpr}.valid_until IS NULL OR ${aliasExpr}.valid_until >= ${whenExpr}))`
}
