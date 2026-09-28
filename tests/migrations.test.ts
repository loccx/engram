import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, existsSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../src/db/migrations/runner.js'
import { migrations } from '../src/db/migrations/index.js'
import { columnExists, indexExists, tableExists } from '../src/db/migrations/types.js'
import { migration014 } from '../src/db/migrations/014_retrieval_events.js'

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

    const latestVersion = migrations[migrations.length - 1].version
    expect(result.startingVersion).toBe(0)
    expect(result.finalVersion).toBe(latestVersion)
    expect(result.applied).toHaveLength(migrations.length)
    expect(result.applied.map((m) => m.version)).toEqual(migrations.map((m) => m.version))
    expect(columnExists(db, 'memories', 'namespace')).toBe(true)
    expect(columnExists(db, 'memories', 'embedding_model')).toBe(true)
    expect(columnExists(db, 'memory_links', 'confidence')).toBe(true)

    // 008: append-only revision/provenance foundation.
    expect(columnExists(db, 'memories', 'origin')).toBe(true)
    expect(columnExists(db, 'memory_links', 'revision')).toBe(true)
    const eventTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_events'")
      .all()
    expect(eventTables.length).toBe(1)
    const origin = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE origin = ?').get('legacy') as { n: number }
    expect(origin.n).toBeGreaterThanOrEqual(0)

    // 009: durable maintenance_jobs queue.
    const jobTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_jobs'")
      .all()
    expect(jobTables.length).toBe(1)

    expect(tableExists(db, 'retrieval_events')).toBe(true)
    for (const index of [
      'idx_retrieval_events_created',
      'idx_retrieval_events_namespace',
      'idx_retrieval_events_tool',
    ]) {
      expect(indexExists(db, index), index).toBe(true)
    }

    const auditRows = db.prepare('SELECT version, description FROM schema_migrations ORDER BY version').all()
    expect(auditRows).toEqual(
      migrations.map((m) => ({ version: m.version, description: m.description }))
    )

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

    const latestVersion = migrations[migrations.length - 1].version
    expect(result2.startingVersion).toBe(latestVersion)
    expect(result2.finalVersion).toBe(latestVersion)
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

    // a crashed run must be retryable, and the runner may re-apply it while its
    // reserved siblings are missing
    expect(() => migration014.up(db)).not.toThrow()
    expect(() => migration014.up(db)).not.toThrow()
    expect(tableExists(db, 'retrieval_events')).toBe(true)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects duplicate and non-1-based migration sequences', () => {
    const dir = mkTmpDir()
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    applyBaselineSchema(db)

    const duplicate = [
      { version: 1, description: 'first', up: () => undefined },
      { version: 1, description: 'same slot', up: () => undefined },
    ]
    const notOneBased = [{ version: 2, description: 'starts at two', up: () => undefined }]

    expect(() => runMigrations(db, dbPath, duplicate, () => undefined)).toThrow(
      /strictly increasing/
    )
    expect(() => runMigrations(db, dbPath, notOneBased, () => undefined)).toThrow(/start at 1/)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('tolerates a reserved-version gap and still applies the reserved migration when it lands', () => {
    const dir = mkTmpDir()
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    applyBaselineSchema(db)
    const applied: string[] = []
    const mk = (version: number, description: string) => ({
      version,
      description,
      up: () => {
        applied.push(description)
      },
    })

    // sibling branches reserve 12/13: modelled here as 1 and 3 with 2 reserved
    const first = [mk(1, 'one'), mk(3, 'three')]
    const r1 = runMigrations(db, dbPath, first, () => undefined)
    expect(r1.applied.map((m) => m.version)).toEqual([1, 3])
    expect(r1.finalVersion).toBe(3)
    expect(applied).toEqual(['one', 'three'])

    // the reserved migration lands later: a version-based filter would skip it
    // forever, and user_version must not rewind when it applies
    const second = [mk(1, 'one'), mk(2, 'two'), mk(3, 'three')]
    const r2 = runMigrations(db, dbPath, second, () => undefined)
    expect(r2.startingVersion).toBe(3)
    expect(r2.applied.map((m) => m.version)).toEqual([2])
    expect(r2.finalVersion).toBe(3)
    expect(applied).toEqual(['one', 'three', 'two'])
    expect(
      (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
        version: number
      }>).map((r) => r.version)
    ).toEqual([1, 2, 3])

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
    expect(result.finalVersion).toBe(migrations[migrations.length - 1].version)
    db.close()
  })
})
