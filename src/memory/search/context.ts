import type Database from 'better-sqlite3'
import type { Memory, MemoryCluster } from '../types.js'
import { notSupersededClause } from '../../contradictions/supersession.js'
import { rowToMemory, type MemoryRow } from '../row.js'
import { currentCaller, derivedVisible, holdsVerb, visibilityClause, type CallerScope } from '../access.js'
import { namespaceFilter, temporalFilter } from './scope.js'

interface ClusterRow {
  id: number
  project_path: string
  member_ids: string
  summary: string
  is_extractive: number
  created_at: number
  updated_at: number
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export interface ContextStatements {
  default: Database.Statement
  clusters: Database.Statement
}

export function prepareContextStatements(db: Database.Database): ContextStatements {
  return {
    default: db.prepare(
      `SELECT * FROM memories
       WHERE COALESCE(namespace, project_path) = ?
         AND ${notSupersededClause('memories.id', {
           successorFilter: `COALESCE(superseder.namespace, superseder.project_path) = ? AND ${visibilityClause('superseder').sql}`,
         })}
         AND ${visibilityClause('memories').sql}
       ORDER BY
         CASE WHEN type = 'procedure' AND pinned = 1 THEN 1 ELSE 0 END DESC,
         (importance * 0.5 + CASE WHEN created_at > ? THEN 0.5 ELSE 0 END) DESC,
         created_at DESC
       LIMIT ?`
    ),
    clusters: db.prepare(
      'SELECT * FROM memory_clusters WHERE project_path = ? ORDER BY updated_at DESC LIMIT 20'
    ),
  }
}

export function getContext(
  db: Database.Database,
  stmts: ContextStatements,
  project_path: string,
  limit: number = 20,
  options: {
    include_superseded?: boolean
    before?: number
    as_of?: number
    caller?: CallerScope
  } = {}
): Memory[] {
  const now = Date.now()
  const thirtyDaysAgo = now - THIRTY_DAYS_MS

  // the caller rides as the visibility parameter, so the prepared statement stays reused
  const caller = options.caller ?? currentCaller()
  if (!holdsVerb(caller, project_path, 'read')) return []
  const callerParam = visibilityClause('memories', caller).params

  // the default latest view needs no time clause at all
  if (!options.include_superseded && options.before === undefined && options.as_of === undefined) {
    const rows = stmts.default.all(
      project_path,
      project_path,
      ...callerParam,
      ...callerParam,
      thirtyDaysAgo,
      limit
    ) as MemoryRow[]
    return rows.map(rowToMemory)
  }

  const readOptions = { ...options, caller, project_path }
  const scope = namespaceFilter('memories', readOptions)
  const temporal = temporalFilter('memories', readOptions)
  const temporalClause = temporal.sql ? ` AND ${temporal.sql}` : ''

  // as_of uses time-aware supersession; before keeps the legacy present-state
  // filter; include_superseded disables filtering entirely.
  const params: unknown[] = [...scope.params, ...temporal.params, thirtyDaysAgo, limit]

  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE ${scope.sql}${temporalClause}
        ORDER BY
          CASE WHEN type = 'procedure' AND pinned = 1 THEN 1 ELSE 0 END DESC,
          (importance * 0.5 + CASE WHEN created_at > ? THEN 0.5 ELSE 0 END) DESC,
          created_at DESC,
          id DESC
        LIMIT ?`
    )
    .all(...params) as MemoryRow[]

  return rows.map(rowToMemory)
}

/** cluster summaries are derived from many rows, so they are withheld rather than filtered */
export function getClusters(
  db: Database.Database,
  stmts: ContextStatements,
  projectPath: string,
  caller: CallerScope = currentCaller()
): MemoryCluster[] {
  if (!derivedVisible(db, projectPath, caller)) return []
  const rows = stmts.clusters.all(projectPath) as ClusterRow[]

  return rows.flatMap((r) => {
    let memberIds: string[] = []
    try {
      const parsed = JSON.parse(r.member_ids)
      if (Array.isArray(parsed)) {
        memberIds = parsed.filter((v): v is string => typeof v === 'string')
      }
    } catch {
      // Malformed cluster JSON is ignored; empty members array is safe
    }
    if (memberIds.length > 0) {
      const scope = namespaceFilter('m', { project_path: projectPath, caller })
      const readable = new Set((db.prepare(
        `SELECT m.id FROM memories m WHERE m.id IN (${memberIds.map(() => '?').join(',')}) AND ${scope.sql}`
      ).all(...memberIds, ...scope.params) as Array<{ id: string }>).map((row) => row.id))
      // a stored membership list is not authority to read its foreign members or the
      // summary they contributed to, even if every row in this namespace is owned.
      if (memberIds.some((id) => !readable.has(id))) return []
    }
    return [{
      id: r.id,
      project_path: r.project_path,
      member_ids: memberIds,
      summary: r.summary,
      is_extractive: r.is_extractive === 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }]
  })
}
