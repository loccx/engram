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
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].version !== i + 1) {
      throw new Error(
        `Engram: migration versions must be a contiguous sequence starting at 1. ` +
          `Got version ${sorted[i].version} at index ${i}.`
      )
    }
  }

  const startingVersion = readUserVersion(db)
  const pending = sorted.filter((m) => m.version > startingVersion)
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
        setUserVersion(db, m.version)
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
