import type Database from 'better-sqlite3'
import type { Memory, MemoryCluster } from '../types.js'
import { notSupersededClause } from '../../contradictions/supersession.js'
import { rowToMemory, type MemoryRow } from '../row.js'

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
  options: { include_superseded?: boolean; before?: number } = {}
): Memory[] {
  const now = Date.now()
  const thirtyDaysAgo = now - THIRTY_DAYS_MS

  if (!options.include_superseded && options.before === undefined) {
    const rows = stmts.default.all(project_path, thirtyDaysAgo, limit) as MemoryRow[]
    return rows.map(rowToMemory)
  }

  const supersededFilter = options.include_superseded
    ? ''
    : ` AND ${notSupersededClause('memories.id')}`
  const beforeFilter = options.before !== undefined ? ' AND valid_from <= ?' : ''
  const params: unknown[] = [project_path]
  if (options.before !== undefined) params.push(options.before)
  params.push(thirtyDaysAgo, limit)

  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE COALESCE(namespace, project_path) = ?${supersededFilter}${beforeFilter}
        ORDER BY
          CASE WHEN type = 'procedure' AND pinned = 1 THEN 1 ELSE 0 END DESC,
          (importance * 0.5 + CASE WHEN created_at > ? THEN 0.5 ELSE 0 END) DESC,
          created_at DESC
        LIMIT ?`
    )
    .all(...params) as MemoryRow[]

  return rows.map(rowToMemory)
}

export function getClusters(stmts: ContextStatements, projectPath: string): MemoryCluster[] {
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
