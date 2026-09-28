import type Database from 'better-sqlite3'

// one idempotent, transactional migration step. every migration has to be safe to
// re-run (column/table existence checks before ddl), self-contained in up(db), and
// backwards-compatible for readers, since backfills run after up() returns. the runner
// wraps up(db) and the user_version bump in one BEGIN IMMEDIATE, so no partial state.
export interface Migration {
  /** sequential, matching PRAGMA user_version */
  version: number
  /** for the audit table and logs */
  description: string
  /** must be idempotent */
  up(db: Database.Database): void
}

export function columnExists(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}

export function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(name)
  return row !== undefined
}

export function indexExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name)
  return row !== undefined
}
