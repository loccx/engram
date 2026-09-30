import type Database from 'better-sqlite3'
import type { Memory, MemoryCluster } from '../types.js'
import {
  notSupersededClause,
  notSupersededAtClause,
  validityAtClause,
} from '../../contradictions/supersession.js'
import { rowToMemory, type MemoryRow } from '../row.js'
import { currentCaller, derivedVisible, visibilityClause, type CallerScope } from '../access.js'

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
         AND ${notSupersededClause('memories.id')}
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
  const callerParam = visibilityClause('memories', caller).params

  // the default latest view needs no time clause at all
  if (!options.include_superseded && options.before === undefined && options.as_of === undefined) {
    const rows = stmts.default.all(
      project_path,
      ...callerParam,
      thirtyDaysAgo,
      limit
    ) as MemoryRow[]
    return rows.map(rowToMemory)
  }

  const params: unknown[] = [project_path]
  let timeFilter = ''
  if (options.as_of !== undefined) {
    timeFilter = ` AND ${validityAtClause('memories', '?')}`
    params.push(options.as_of, options.as_of)
  } else if (options.before !== undefined) {
    timeFilter = ' AND valid_from <= ?'
    params.push(options.before)
  }

  // as_of uses time-aware supersession; before keeps the legacy present-state
  // filter; include_superseded disables filtering entirely.
  let supersededFilter = ''
  if (!options.include_superseded) {
    if (options.as_of !== undefined) {
      supersededFilter = ` AND ${notSupersededAtClause('memories.id', '?')}`
      params.push(options.as_of)
    } else {
      supersededFilter = ` AND ${notSupersededClause('memories.id')}`
    }
  }
  params.push(...callerParam)
  params.push(thirtyDaysAgo, limit)

  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE COALESCE(namespace, project_path) = ?${timeFilter}${supersededFilter}
         AND ${visibilityClause('memories', caller).sql}
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

  return rows.map((r) => {
    let memberIds: string[] = []
    try {
      const parsed = JSON.parse(r.member_ids)
      if (Array.isArray(parsed)) {
        memberIds = parsed.filter((v): v is string => typeof v === 'string')
      }
    } catch {
      // Malformed cluster JSON is ignored; empty members array is safe
    }
    return {
      id: r.id,
      project_path: r.project_path,
      member_ids: memberIds,
      summary: r.summary,
      is_extractive: r.is_extractive === 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }
  })
}
