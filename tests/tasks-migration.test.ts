import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../src/db/migrations/runner.js'
import { migrations } from '../src/db/migrations/index.js'
import { indexExists, tableExists } from '../src/db/migrations/types.js'
import { migration016 } from '../src/db/migrations/016_working_state.js'

const BASELINE = `
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
`

const UP_TO_015 = migrations.filter((migration) => migration.version <= 15)

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'engram-tasks-migration-'))
}

describe('migration 016', () => {
  it('creates the working-state tables on a fresh database', () => {
    const dir = tmpDir()
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    db.exec(BASELINE)

    const result = runMigrations(db, dbPath, migrations, () => undefined)

    expect(result.finalVersion).toBeGreaterThanOrEqual(16)
    expect(tableExists(db, 'tasks')).toBe(true)
    expect(tableExists(db, 'task_events')).toBe(true)
    expect(indexExists(db, 'idx_tasks_namespace_status')).toBe(true)
    expect(indexExists(db, 'idx_task_events_task')).toBe(true)

    const columns = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(
      (row) => row.name
    )
    expect(columns).toEqual([
      'id',
      'namespace',
      'session_id',
      'title',
      'goal',
      'status',
      'plan_json',
      'progress_json',
      'artifacts_json',
      'open_questions_json',
      'created_at',
      'updated_at',
      'closed_at',
      'owner_principal',
      'visibility',
    ])

    // working state is not searchable by construction: no fts and no vector table
    const fts = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%task%'")
      .all() as Array<{ name: string }>
    expect(fts.map((row) => row.name).sort()).toEqual(['task_events', 'tasks'])

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('upgrades a database that stopped at 015 and keeps its rows', () => {
    const dir = tmpDir()
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    db.exec(BASELINE)
    db.prepare("INSERT INTO sessions (id, project_path, started_at) VALUES ('s1', '/p', 1)").run()
    db.prepare(
      "INSERT INTO memories (id, session_id, project_path, content, created_at) VALUES ('m1', 's1', '/p', 'before the working tier', 1)"
    ).run()

    const first = runMigrations(db, dbPath, UP_TO_015, () => undefined)
    expect(first.finalVersion).toBe(15)
    expect(tableExists(db, 'tasks')).toBe(false)

    const second = runMigrations(db, dbPath, migrations, () => undefined)
    expect(second.startingVersion).toBe(15)
    expect(second.applied.map((migration) => migration.version)).toContain(16)
    expect(tableExists(db, 'tasks')).toBe(true)
    expect(
      (db.prepare("SELECT content FROM memories WHERE id = 'm1'").get() as { content: string }).content
    ).toBe('before the working tier')

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is idempotent, so a retried upgrade never fails', () => {
    const dir = tmpDir()
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    db.exec(BASELINE)
    runMigrations(db, dbPath, UP_TO_015, () => undefined)

    expect(() => migration016.up(db)).not.toThrow()
    expect(() => migration016.up(db)).not.toThrow()
    expect(tableExists(db, 'tasks')).toBe(true)
    expect(indexExists(db, 'idx_task_events_task')).toBe(true)

    // the ddl is already there, so the migration still applies cleanly
    const third = runMigrations(db, dbPath, migrations, () => undefined)
    expect(third.applied.map((migration) => migration.version)).toContain(16)

    const fourth = runMigrations(db, dbPath, migrations, () => undefined)
    expect(fourth.applied).toEqual([])

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
