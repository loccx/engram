import type Database from 'better-sqlite3'
import { existsSync, openSync, closeSync, unlinkSync, writeSync } from 'fs'
import { join, dirname, basename } from 'path'
import type { Migration } from './types.js'

export interface MigrationRunResult {
  startingVersion: number
  finalVersion: number
  applied: Array<{ version: number; description: string; durationMs: number }>
  backupPath: string | null
}

const AUDIT_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  )
`

function readUserVersion(db: Database.Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

function setUserVersion(db: Database.Database, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`)
}

// null when the ledger is absent: a database migrated before schema_migrations
function readAppliedVersions(db: Database.Database): Set<number> | null {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get()
  if (!table) return null
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number
  }>
  return new Set(rows.map((r) => r.version))
}

function quickCheck(db: Database.Database): void {
  const row = db.prepare('PRAGMA quick_check').get() as { quick_check: string }
  if (row.quick_check !== 'ok') {
    throw new Error(`Engram: post-migration integrity check failed: ${row.quick_check}`)
  }
}

function backupViaVacuumInto(db: Database.Database, dbPath: string): string {
  const ts = Date.now()
  const backupPath = join(dirname(dbPath), `${basename(dbPath)}.bak.${ts}`)
  if (existsSync(backupPath)) {
    unlinkSync(backupPath)
  }
  db.prepare('VACUUM INTO ?').run(backupPath)
  return backupPath
}

function acquireMigrationLock(dbPath: string): { release: () => void } {
  const lockPath = `${dbPath}.migrate.lock`
  let fd: number
  try {
    fd = openSync(lockPath, 'wx')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      throw new Error(
        `Engram: another migrator appears to be running (lock file exists at ${lockPath}). ` +
          `If no daemon is running, remove the file and retry.`
      )
    }
    throw err
  }
  writeSync(fd, `${process.pid}\n`)
  return {
    release: () => {
      try { closeSync(fd) } catch { /* already closed */ }
      try { unlinkSync(lockPath) } catch { /* already gone */ }
    },
  }
}

export function runMigrations(
  db: Database.Database,
  dbPath: string,
  migrations: Migration[],
  log: (msg: string) => void = (m) => process.stderr.write(`Engram: ${m}\n`)
): MigrationRunResult {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  // versions must start at 1 and strictly increase, but a gap is tolerated:
  // parallel branches reserve numbers ahead of a merge. a duplicate or a
  // renumbered (lowered) version is what must never happen, since that is how
  // two migrations share one user_version slot.
  for (let i = 0; i < sorted.length; i++) {
    const expected = i === 0 ? 1 : sorted[i - 1].version + 1
    if (sorted[i].version === expected) continue
    if (i > 0 && sorted[i].version > sorted[i - 1].version) continue // reserved gap
    throw new Error(
      `Engram: migration versions must be unique, strictly increasing and start at 1. ` +
        `Got version ${sorted[i].version} at index ${i}.`
    )
  }

  const startingVersion = readUserVersion(db)
  // pending comes from the ledger, not user_version: with a reserved gap, a
  // version filter would treat a later-arriving lower number as already applied
  // and skip it forever, while the ledger only records a migration once its own
  // row exists.
  const appliedVersions = readAppliedVersions(db)
  const pending =
    appliedVersions === null
      ? // no ledger on a pre-audit database: user_version is all there is
        sorted.filter((m) => m.version > startingVersion)
      : sorted.filter((m) => !appliedVersions.has(m.version))
  const result: MigrationRunResult = {
    startingVersion,
    finalVersion: startingVersion,
    applied: [],
    backupPath: null,
  }

  if (pending.length === 0) {
    db.exec(AUDIT_TABLE_DDL)
    return result
  }

  const isInMemory = dbPath === ':memory:'
  const lock = isInMemory ? { release: () => undefined } : acquireMigrationLock(dbPath)
  try {
    if (!isInMemory) {
      result.backupPath = backupViaVacuumInto(db, dbPath)
      log(`backed up DB to ${result.backupPath} before applying ${pending.length} migration(s)`)
    }

    db.exec(AUDIT_TABLE_DDL)

    for (const m of pending) {
      const t0 = Date.now()
      const tx = db.transaction(() => {
        m.up(db)
        // never lower the high-water mark: a reserved version can be applied
        // before a lower-numbered sibling, which must not rewind it
        setUserVersion(db, Math.max(readUserVersion(db), m.version))
        db.prepare(
          'INSERT OR REPLACE INTO schema_migrations (version, description, applied_at, duration_ms) VALUES (?, ?, ?, ?)'
        ).run(m.version, m.description, Date.now(), Date.now() - t0)
      })
      try {
        tx.immediate()
      } catch (err) {
        log(
          `migration ${m.version} (${m.description}) FAILED. ` +
            `DB is at version ${readUserVersion(db)}. Backup: ${result.backupPath ?? 'n/a'}. ` +
            `Error: ${(err as Error).message}`
        )
        throw err
      }
      const durationMs = Date.now() - t0
      result.applied.push({ version: m.version, description: m.description, durationMs })
      log(`applied migration ${m.version}: ${m.description} (${durationMs}ms)`)
    }

    quickCheck(db)
    result.finalVersion = readUserVersion(db)
    return result
  } finally {
    lock.release()
  }
}
