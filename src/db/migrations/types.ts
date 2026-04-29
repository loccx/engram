import type Database from 'better-sqlite3'

/**
 * A single, idempotent, transactional migration step.
 *
 * Migrations MUST be:
 *  - Idempotent: safe to re-run if a previous attempt crashed mid-way (use
 *    column-existence / table-existence checks before issuing DDL).
 *  - Self-contained in `up(db)`: no cross-migration imports or shared state.
 *  - Backwards-compatible at the application layer: code reading the DB
 *    must tolerate the schema both before AND after this migration runs,
 *    because backfills run in the background after `up()` returns.
 *
 * The runner wraps each `up(db)` in `BEGIN IMMEDIATE ... COMMIT` and bumps
 * `PRAGMA user_version` in the same transaction, so partial application is
 * impossible.
 */
export interface Migration {
  /** Sequential, monotonically-increasing version number. Matches PRAGMA user_version. */
  version: number
  /** Short human-readable description, used in the audit table + logs. */
  description: string
  /** Forward migration. Must be idempotent. */
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
