import type Database from 'better-sqlite3'
import { ancestorPaths, ensureNode, getNode } from '../namespace/tree.js'
import { WEAK_RESULT_THRESHOLD } from '../metrics/retrieval-log.js'
import { visibilityClause } from '../memory/access.js'

// agent-facing health + miss explanation: read-only and bounded for the roster path

export const THIN_SCOPE_MIN_MEMORIES = 3
export const DEFAULT_DIGEST_STALE_MS = 7 * 24 * 60 * 60 * 1000
const HEALTH_SAMPLE_LIMIT = 5
/** the duplicate count is a floor on a large store, and that is the safe side */
const DUPLICATE_EDGE_LIMIT = 500
const DUPLICATE_SIMILARITY = 0.95

export interface MemoryHealth {
  scope: string
  scope_memories: number
  never_accessed: number
  duplicate_groups: number
  duplicate_sample: string[][]
  stale_digests: number
  stale_digest_paths: string[]
  thin_scopes: number
  thin_scope_paths: string[]
  namespaces_without_digest: number
  missing_digest_paths: string[]
  digest: {
    present: boolean
    chars: number
    updated_at: number | null
    age_ms: number | null
    stale: boolean
  }
  generated_at: number
}

export interface MemoryHealthOptions {
  now?: number
  digestStaleMs?: number
}

// root is the degenerate case: appending '/' would give a prefix that matches
// nothing. must stay in lockstep with subtreeCountFrom's `scope + '/'` prefix.
function descendantPatterns(ns: string): [string, string] {
  const escaped = ns.replace(/[\\%_]/g, '\\$&')
  if (ns === '/') return ['/%', '//%']
  return [`${escaped}/%`, `${escaped}//%`]
}

function subtree(ns: string): { clause: string; values: unknown[] } {
  const patterns = descendantPatterns(ns)
  // the health numbers count rows, so they count the rows this caller may read
  const visibility = visibilityClause('m')
  return {
    clause:
      "(COALESCE(m.namespace, m.project_path) = ?" +
      " OR COALESCE(m.namespace, m.project_path) LIKE ? ESCAPE '\\'" +
      " OR COALESCE(m.namespace, m.project_path) LIKE ? ESCAPE '\\')" +
      ` AND ${visibility.sql}`,
    values: [ns, ...patterns, ...visibility.params],
  }
}

interface ScopeAggregate {
  byNamespace: Map<string, number>
  total: number
  neverAccessed: number
}

// one grouped scan covers every "how many memories in scope X" number: the
// counting predicate cannot use an index, so a scan per ancestor (up to 6)
// would multiply the cost by the depth of the scope
function aggregateScope(db: Database.Database, scope: string): ScopeAggregate {
  const { clause, values } = subtree(scope)
  const rows = db
    .prepare(
      `SELECT COALESCE(m.namespace, m.project_path) AS path,
              COUNT(*) AS n,
              SUM(CASE WHEN m.access_count = 0 THEN 1 ELSE 0 END) AS never
       FROM memories m WHERE ${clause} GROUP BY path`
    )
    .all(...values) as Array<{ path: string; n: number; never: number }>

  const byNamespace = new Map<string, number>()
  let total = 0
  let neverAccessed = 0
  for (const row of rows) {
    byNamespace.set(row.path, row.n)
    total += row.n
    neverAccessed += row.never
  }
  return { byNamespace, total, neverAccessed }
}

function subtreeCountFrom(aggregate: ScopeAggregate, scannedScope: string, path: string): number {
  if (path === scannedScope) return aggregate.total
  let count = aggregate.byNamespace.get(path) ?? 0
  const prefix = `${path}/`
  for (const [namespace, n] of aggregate.byNamespace) {
    if (namespace.startsWith(prefix)) count += n
  }
  return count
}

// both units appear in the wild: the refresh path writes ms, migration 007 defaulted to s
function toMillis(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return value < 1e12 ? value * 1000 : value
}

// connected components of high-similarity links, bounded by DUPLICATE_EDGE_LIMIT
function findDuplicateGroups(
  db: Database.Database,
  ns: string
): { groups: number; sample: string[][] } {
  const { clause, values } = subtree(ns)
  const rows = db
    .prepare(
      `SELECT l.source_id AS source_id, l.target_id AS target_id
       FROM memory_links l
       JOIN memories ms ON ms.id = l.source_id
       JOIN memories mt ON mt.id = l.target_id
       WHERE l.similarity >= ?
         AND ${clause.replace(/m\./g, 'ms.')}
         AND ${clause.replace(/m\./g, 'mt.')}
       LIMIT ?`
    )
    .all(DUPLICATE_SIMILARITY, ...values, ...values, DUPLICATE_EDGE_LIMIT) as Array<{
    source_id: string
    target_id: string
  }>

  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = parent.get(id) ?? id
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const row of rows) union(row.source_id, row.target_id)

  const members = new Map<string, string[]>()
  for (const id of parent.keys()) {
    const root = find(id)
    const list = members.get(root)
    if (list) list.push(id)
    else members.set(root, [id])
  }
  const groups = [...members.values()].filter((ids) => ids.length > 1)
  groups.sort((a, b) => b.length - a.length)
  return {
    groups: groups.length,
    sample: groups.slice(0, 3).map((ids) => ids.slice(0, HEALTH_SAMPLE_LIMIT)),
  }
}

interface NodeHealthRow {
  path: string
  digest: string | null
  memory_count: number
}

export interface MissAncestorCount {
  path: string
  memory_count: number
}

export function buildMemoryHealth(
  db: Database.Database,
  namespace: string,
  options: MemoryHealthOptions = {}
): MemoryHealth {
  const now = options.now ?? Date.now()
  const staleMs = options.digestStaleMs ?? DEFAULT_DIGEST_STALE_MS
  const aggregate = aggregateScope(db, namespace)

  // materialized nodes only: a scope that never got one shows up in the digest block
  const [childPattern, syntheticPattern] = descendantPatterns(namespace)
  const nodes = db
    .prepare(
      `SELECT path, digest, memory_count FROM namespace_nodes
       WHERE path = ? OR path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
       ORDER BY depth ASC, path ASC`
    )
    .all(namespace, childPattern, syntheticPattern) as NodeHealthRow[]

  // maintenance refreshes memory_count, so a node can legitimately report 0 while
  // memories exist in it; the aggregate above supplies the truth for those
  const effectiveCount = (node: NodeHealthRow): number =>
    node.memory_count > 0 ? node.memory_count : (aggregate.byNamespace.get(node.path) ?? 0)

  const thin = nodes.filter(
    (n) => effectiveCount(n) > 0 && effectiveCount(n) < THIN_SCOPE_MIN_MEMORIES
  )
  const missingDigest = nodes.filter(
    (n) => effectiveCount(n) > 0 && (n.digest === null || n.digest.trim() === '')
  )

  const digestRows = db
    .prepare(
      `SELECT namespace, updated_at, LENGTH(content) AS chars FROM project_digests
       WHERE namespace = ? OR namespace LIKE ? ESCAPE '\\' OR namespace LIKE ? ESCAPE '\\'`
    )
    .all(namespace, childPattern, syntheticPattern) as Array<{
    namespace: string
    updated_at: number | null
    chars: number
  }>
  // an empty digest carries no facts: treat it as absent
  const presentDigests = digestRows.filter((r) => r.chars > 0)
  const stale = presentDigests.filter((r) => {
    const at = toMillis(r.updated_at)
    return at !== null && now - at > staleMs
  })

  const own = digestRows.find((r) => r.namespace === namespace && r.chars > 0)
  const ownAt = toMillis(own?.updated_at)

  const { groups, sample } = findDuplicateGroups(db, namespace)

  return {
    scope: namespace,
    scope_memories: aggregate.total,
    never_accessed: aggregate.neverAccessed,
    duplicate_groups: groups,
    duplicate_sample: sample,
    stale_digests: stale.length,
    stale_digest_paths: stale.slice(0, HEALTH_SAMPLE_LIMIT).map((r) => r.namespace),
    thin_scopes: thin.length,
    thin_scope_paths: thin.slice(0, HEALTH_SAMPLE_LIMIT).map((n) => n.path),
    namespaces_without_digest: missingDigest.length,
    missing_digest_paths: missingDigest.slice(0, HEALTH_SAMPLE_LIMIT).map((n) => n.path),
    digest: {
      present: own !== undefined,
      chars: own?.chars ?? 0,
      updated_at: ownAt,
      age_ms: ownAt === null ? null : now - ownAt,
      stale: own !== undefined && ownAt !== null && now - ownAt > staleMs,
    },
    generated_at: now,
  }
}

export interface MissExplanation {
  reason: string
  scope: string
  scope_memories: number
  ancestor_scopes: MissAncestorCount[]
  /** an upper bound: nesting counts a memory at every level above it */
  memories_in_ancestors: number
  nearest_rich_scope: string | null
}

export interface MissExplanationOptions {
  /** get_context materializes; search_memories stays read-only and counts instead */
  materialize?: boolean
  /** result count at/above which no explanation is produced */
  minHealthy?: number
}

// an empty scope and one whose memories sit a level up are different problems
export function explainMiss(
  db: Database.Database,
  namespace: string,
  resultCount: number,
  options: MissExplanationOptions = {}
): MissExplanation | null {
  const minHealthy = options.minHealthy ?? WEAK_RESULT_THRESHOLD
  if (resultCount >= minHealthy) return null

  if (options.materialize) ensureNode(db, namespace)

  const ancestorPathsList = ancestorPaths(namespace)
  // one scan from the outermost ancestor covers the scope and every level above it
  const scannedScope = ancestorPathsList.length > 0 ? ancestorPathsList[0] : namespace
  const aggregate = aggregateScope(db, scannedScope)

  // a stale node reports 0 and would claim an ancestor scope is empty, so fall
  // back to the aggregate when the tree has no count
  const countScope = (path: string): number => {
    const treeCount = getNode(db, path)?.memory_count ?? 0
    if (treeCount > 0) return treeCount
    return subtreeCountFrom(aggregate, scannedScope, path)
  }

  const scopeMemories = countScope(namespace)
  const ancestorScopes: Array<{ path: string; memory_count: number }> = ancestorPathsList.map(
    (path) => ({ path, memory_count: countScope(path) })
  )

  // deepest first: the nearest place the memories actually are
  const ordered = [...ancestorScopes].reverse()
  const memoriesInAncestors = ordered.reduce((sum, a) => sum + a.memory_count, 0)
  const nearestRich = ordered.find((a) => a.memory_count > 0) ?? null

  const ancestorClause =
    ordered.length === 0
      ? 'and it has no ancestor namespaces'
      : nearestRich
        ? `, but ${nearestRich.path} holds ${nearestRich.memory_count} ` +
          `(${ordered.length} ancestor scope${ordered.length === 1 ? '' : 's'} checked)`
        : `and none of its ${ordered.length} ancestor scope${ordered.length === 1 ? '' : 's'} holds any either`
  const reason =
    resultCount === 0
      ? `no results in ${namespace}; this scope holds ${scopeMemories}${ancestorClause}`
      : `weak result set (${resultCount}) in ${namespace}; this scope holds ${scopeMemories}${ancestorClause}`

  return {
    reason,
    scope: namespace,
    scope_memories: scopeMemories,
    ancestor_scopes: ordered,
    memories_in_ancestors: memoriesInAncestors,
    nearest_rich_scope: nearestRich?.path ?? null,
  }
}
