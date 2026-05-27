import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, existsSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../src/db/migrations/runner.js'
import { migrations } from '../src/db/migrations/index.js'
import { columnExists } from '../src/db/migrations/types.js'

function mkTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'engram-migrations-'))
}

function applyBaselineSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, summary TEXT, tool_name TEXT);
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      project_path TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'note',
      importance REAL NOT NULL DEFAULT 0.5,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      last_accessed INTEGER,
      access_count INTEGER NOT NULL DEFAULT 0,
      vec_rowid INTEGER
    );
    CREATE TABLE memory_links (
      source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      similarity REAL NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'semantic',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, target_id)
    );
  `)
}

describe('migration runner', () => {
  it('applies all pending migrations and updates user_version', () => {
    const dir = mkTmpDir()
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    applyBaselineSchema(db)

    const result = runMigrations(db, dbPath, migrations, () => undefined)

    expect(result.startingVersion).toBe(0)
    expect(result.finalVersion).toBe(1)
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].version).toBe(1)
    expect(columnExists(db, 'memories', 'namespace')).toBe(true)
    expect(columnExists(db, 'memories', 'embedding_model')).toBe(true)
    expect(columnExists(db, 'memory_links', 'confidence')).toBe(true)

    const auditRows = db.prepare('SELECT version, description FROM schema_migrations ORDER BY version').all()
    expect(auditRows).toEqual([{ version: 1, description: migrations[0].description }])

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a VACUUM INTO backup when migrations are pending', () => {
    const dir = mkTmpDir()
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    applyBaselineSchema(db)
    db.prepare("INSERT INTO sessions(id, project_path, started_at) VALUES ('s1', '/p', ?)").run(Date.now())
    db.prepare("INSERT INTO memories(id, session_id, project_path, content, created_at) VALUES ('m1', 's1', '/p', 'pre-migration content', ?)").run(Date.now())

    const result = runMigrations(db, dbPath, migrations, () => undefined)

    expect(result.backupPath).not.toBeNull()
    expect(existsSync(result.backupPath!)).toBe(true)
    expect(statSync(result.backupPath!).size).toBeGreaterThan(0)

    const backupDb = new Database(result.backupPath!)
    const row = backupDb.prepare("SELECT content FROM memories WHERE id = 'm1'").get() as { content: string }
    expect(row.content).toBe('pre-migration content')
    expect(columnExists(backupDb, 'memories', 'namespace')).toBe(false)
    backupDb.close()

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does NOT create a backup when no migrations are pending', () => {
    const dir = mkTmpDir()
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    applyBaselineSchema(db)

    runMigrations(db, dbPath, migrations, () => undefined)
    const filesAfterFirst = readdirSync(dir)

    const result2 = runMigrations(db, dbPath, migrations, () => undefined)
    const filesAfterSecond = readdirSync(dir)

    expect(result2.startingVersion).toBe(1)
    expect(result2.finalVersion).toBe(1)
    expect(result2.applied).toHaveLength(0)
    expect(result2.backupPath).toBeNull()
    expect(filesAfterSecond.length).toBe(filesAfterFirst.length)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('migration up() is idempotent at the DDL level', () => {
    const dir = mkTmpDir()
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    applyBaselineSchema(db)
    db.exec('ALTER TABLE memories ADD COLUMN namespace TEXT')

    expect(() => migrations[0].up(db)).not.toThrow()
    expect(columnExists(db, 'memories', 'namespace')).toBe(true)
    expect(columnExists(db, 'memories', 'embedding_model')).toBe(true)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects non-contiguous migration sequences', () => {
    const dir = mkTmpDir()
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    applyBaselineSchema(db)

    const broken = [
      { version: 1, description: 'first', up: () => undefined },
      { version: 3, description: 'skip-2', up: () => undefined },
    ]

    expect(() => runMigrations(db, dbPath, broken, () => undefined)).toThrow(/contiguous/)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to run when a stale lock file exists', () => {
    const dir = mkTmpDir()
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    applyBaselineSchema(db)

    const lockPath = `${dbPath}.migrate.lock`
    require('fs').writeFileSync(lockPath, 'stale')

    expect(() => runMigrations(db, dbPath, migrations, () => undefined)).toThrow(/another migrator/)

    rmSync(lockPath)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it(':memory: databases skip backup and lock acquisition', () => {
    const db = new Database(':memory:')
    applyBaselineSchema(db)

    const result = runMigrations(db, ':memory:', migrations, () => undefined)

    expect(result.backupPath).toBeNull()
    expect(result.finalVersion).toBe(1)
    db.close()
  })
})
