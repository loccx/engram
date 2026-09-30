import type Database from 'better-sqlite3'
import { recordColdFaults } from '../metrics/eviction-log.js'

// the cold tier's way back in. clearing archived_at is the only reversal of prune and
// retention archiving, so the cli command and the mcp tool share this function rather
// than each running the update. paging a cold row back in is a fault, and it is
// recorded here so both paths count the same.

export interface UnarchiveResult {
  unarchived: boolean
  /** namespace of the row, so the caller can report what came back */
  namespace: string | null
}

interface ArchivedRow {
  id: string
  namespace: string | null
  importance: number
  access_count: number
  last_accessed: number | null
  created_at: number
  pinned: number
  archived_at: number | null
}

export function unarchiveMemory(db: Database.Database, id: string): UnarchiveResult {
  const row = db
    .prepare(
      `SELECT id, COALESCE(namespace, project_path) AS namespace, importance, access_count,
              last_accessed, created_at, pinned, archived_at
       FROM memories WHERE id = ?`
    )
    .get(id) as ArchivedRow | undefined
  if (!row || row.archived_at === null) return { unarchived: false, namespace: row?.namespace ?? null }

  const info = db
    .prepare('UPDATE memories SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL')
    .run(id)
  if (info.changes > 0) {
    recordColdFaults(db, [row], 'unarchive')
  }
  return { unarchived: info.changes > 0, namespace: row.namespace }
}
