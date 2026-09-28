import type Database from 'better-sqlite3'
import { notSupersededClause } from '../contradictions/supersession.js'

// materialized namespace tree: path-shaped namespaces form a tree by prefix, a
// `//scope` suffix makes a synthetic leaf under its real path, anything else is
// its own root. derived from stored strings only, no filesystem io. every write
// is an idempotent upsert, lazily via ensureNode or in bulk via backfillTree.

export interface NamespaceNode {
  path: string
  parent_path: string | null
  depth: number
  is_synthetic: boolean
  real_path: string | null
  digest: string | null
  memory_count: number
  child_count: number
  last_activity_at: number | null
  updated_at: number
}

export interface ParsedNamespacePath {
  /** the namespace string as given, and the primary key */
  full: string
  /** before the '//' when synthetic, else null */
  realPath: string | null
  /** after the '//' when synthetic, else null */
  scope: string | null
  isPathShaped: boolean
  /** the real path for a synthetic node; null at a root */
  parentPath: string | null
  depth: number
}

const SYNTHETIC_MARKER = '//'

export function parseNamespacePath(ns: string): ParsedNamespacePath {
  const full = ns
  const markerAt = ns.indexOf(SYNTHETIC_MARKER)
  const isSynthetic = markerAt >= 0
  const realPath = isSynthetic ? ns.slice(0, markerAt) : null
  const scope = isSynthetic ? ns.slice(markerAt + SYNTHETIC_MARKER.length) : null
  const basePath = isSynthetic ? (realPath as string) : ns
  const isPathShaped = basePath.startsWith('/') || basePath.startsWith('~')

  if (!isPathShaped) {
    return {
      full,
      realPath,
      scope,
      isPathShaped: false,
      parentPath: isSynthetic && basePath.length > 0 ? basePath : null,
      // a synthetic scope over a non-path base sits one below its root base
      depth: isSynthetic && basePath.length > 0 ? 1 : 0,
    }
  }

  // path-shaped: '~' and '/' are depth-0 roots, and depth counts real segments
  const root = basePath.startsWith('~') ? '~' : '/'
  const withoutRoot = basePath.slice(root.length)
  const segments = withoutRoot.split('/').filter((s) => s.length > 0)

  const realDepth = segments.length

  let parentPath: string | null = null
  if (isSynthetic) {
    // a synthetic node's parent is its real path
    parentPath = (realPath as string).length > 0 ? (realPath as string) : root
  } else if (segments.length === 0) {
    // the root itself ('/' or '~') has no parent
    parentPath = null
  } else if (segments.length === 1) {
    parentPath = root
  } else {
    // '~' is a named root: '~/x'. '/' is implicit: '/x'.
    parentPath = `${root}${root === '~' ? '/' : ''}${segments.slice(0, -1).join('/')}`
  }

  // a synthetic scope sits one level below its real path
  const depth = realDepth + (scope !== null ? 1 : 0)

  return { full, realPath, scope, isPathShaped: true, parentPath, depth }
}

interface NodeRow {
  path: string
  parent_path: string | null
  depth: number
  is_synthetic: number
  real_path: string | null
  digest: string | null
  memory_count: number
  child_count: number
  last_activity_at: number | null
  updated_at: number
}

function rowToNode(row: NodeRow): NamespaceNode {
  return {
    path: row.path,
    parent_path: row.parent_path,
    depth: row.depth,
    is_synthetic: row.is_synthetic === 1,
    real_path: row.real_path,
    digest: row.digest,
    memory_count: row.memory_count,
    child_count: row.child_count,
    last_activity_at: row.last_activity_at,
    updated_at: row.updated_at,
  }
}

/** ancestor paths of ns, root-first; pure string math, no db reads */
export function ancestorPaths(ns: string): string[] {
  const parsed = parseNamespacePath(ns)
  const chain: string[] = []
  let cursor = parsed.parentPath
  let guard = 0
  while (cursor !== null && guard++ < 64) {
    chain.unshift(cursor)
    cursor = parseNamespacePath(cursor).parentPath
  }
  return chain
}

export function ensureNode(db: Database.Database, ns: string): NamespaceNode {
  const now = Date.now()
  const insert = db.prepare(
    `INSERT INTO namespace_nodes (path, parent_path, depth, is_synthetic, real_path, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO NOTHING`
  )

  // the full chain: ancestors root-first, then the node itself
  const chain = [...ancestorPaths(ns), ns]

  db.transaction(() => {
    for (const path of chain) {
      const parsed = parseNamespacePath(path)
      insert.run(
        path,
        parsed.parentPath,
        parsed.depth,
        parsed.scope !== null ? 1 : 0,
        parsed.realPath,
        now
      )
    }
  })()

  const row = db
    .prepare('SELECT * FROM namespace_nodes WHERE path = ?')
    .get(ns) as NodeRow
  return rowToNode(row)
}

export function getNode(db: Database.Database, path: string): NamespaceNode | null {
  const row = db
    .prepare('SELECT * FROM namespace_nodes WHERE path = ?')
    .get(path) as NodeRow | undefined
  return row ? rowToNode(row) : null
}

export function deepestKnownPrefix(db: Database.Database, ns: string): NamespaceNode | null {
  const parsed = parseNamespacePath(ns)
  // candidates: the full path first, then real-path segments, shortest first
  const candidates: string[] = []
  if (parsed.isPathShaped) {
    const root = ns.startsWith('~') ? '~' : '/'
    const basePath = parsed.realPath ?? ns
    const withoutRoot = basePath.slice(root.length)
    const segments = withoutRoot.split('/').filter((s) => s.length > 0)
    if (parsed.scope !== null) candidates.push(ns)
    for (let i = segments.length; i >= 1; i--) {
      candidates.push(root + (root === '~' ? '/' : '') + segments.slice(0, i).join('/'))
    }
    candidates.push(root)
  } else {
    candidates.push(ns)
  }

  const stmt = db.prepare('SELECT * FROM namespace_nodes WHERE path = ?')
  for (const candidate of candidates) {
    const row = stmt.get(candidate) as NodeRow | undefined
    if (row) return rowToNode(row)
  }
  return null
}

export function ancestors(db: Database.Database, ns: string): NamespaceNode[] {
  const paths = ancestorPaths(ns)
  if (paths.length === 0) return []
  const placeholders = paths.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT * FROM namespace_nodes WHERE path IN (${placeholders})
       ORDER BY depth ASC, path ASC`
    )
    .all(...paths) as NodeRow[]
  const byPath = new Map(rows.map((r) => [r.path, rowToNode(r)]))
  // root-first; an ancestor missing from the table was never ensured, so it is
  // skipped — callers that need them should ensureNode first.
  return paths.map((p) => byPath.get(p)).filter((n): n is NamespaceNode => n !== undefined)
}

export function children(db: Database.Database, path: string): NamespaceNode[] {
  const rows = db
    .prepare('SELECT * FROM namespace_nodes WHERE parent_path = ? ORDER BY path ASC')
    .all(path) as NodeRow[]
  return rows.map(rowToNode)
}

export function setNodeDigest(
  db: Database.Database,
  path: string,
  digest: string,
  sourceHash: string | null
): void {
  const now = Date.now()
  const res = db
    .prepare(
      `UPDATE namespace_nodes SET digest = ?, digest_source_hash = ?, updated_at = ? WHERE path = ?`
    )
    .run(digest, sourceHash, now, path)
  if (res.changes === 0) {
    ensureNode(db, path)
    db
      .prepare(
        `UPDATE namespace_nodes SET digest = ?, digest_source_hash = ?, updated_at = ? WHERE path = ?`
      )
      .run(digest, sourceHash, now, path)
  }
}

export function refreshNodeCounts(db: Database.Database, path: string): void {
  const node = getNode(db, path)
  if (!node) {
    ensureNode(db, path)
  }

  const memStats = db
    .prepare(
      `SELECT COUNT(*) AS cnt, MAX(created_at) AS last_at
       FROM memories
       WHERE COALESCE(namespace, project_path) = ?
         AND ${notSupersededClause('memories.id')}`
    )
    .get(path) as { cnt: number; last_at: number | null }

  const childRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM namespace_nodes WHERE parent_path = ?')
    .get(path) as { cnt: number }

  db.prepare(
    `UPDATE namespace_nodes
     SET memory_count = ?, child_count = ?, last_activity_at = ?, updated_at = ?
     WHERE path = ?`
  ).run(memStats.cnt, childRow.cnt, memStats.last_at, Date.now(), path)
}

export function backfillTree(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT DISTINCT COALESCE(namespace, project_path) AS ns
       FROM memories
       WHERE COALESCE(namespace, project_path) IS NOT NULL
         AND COALESCE(namespace, project_path) != ''`
    )
    .all() as Array<{ ns: string }>

  let ensured = 0
  const run = db.transaction(() => {
    for (const { ns } of rows) {
      ensureNode(db, ns)
      ensured++
      refreshNodeCounts(db, ns)
    }
  })
  run()
  return ensured
}
