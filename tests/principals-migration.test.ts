import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrations, runMigrations } from '../src/db/migrations/index.js'
import { columnExists, indexExists, tableExists } from '../src/db/migrations/types.js'

function baseline(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, summary TEXT, tool_name TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), project_path TEXT NOT NULL, content TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'note', importance REAL NOT NULL DEFAULT 0.5, tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_accessed INTEGER, access_count INTEGER NOT NULL DEFAULT 0, vec_rowid INTEGER);
    CREATE TABLE memory_links (source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, similarity REAL NOT NULL, link_type TEXT NOT NULL DEFAULT 'semantic', created_at INTEGER NOT NULL, PRIMARY KEY (source_id, target_id));
  `)
}

function upTo(db: Database.Database, version: number): void {
  for (const m of migrations.filter((m) => m.version <= version).sort((a, b) => a.version - b.version)) {
    m.up(db)
  }
}

function seed(db: Database.Database): void {
  db.prepare(
    'INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)'
  ).run('s1', '/p', 1)
  db.prepare(
    'INSERT INTO memories (id, session_id, project_path, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run('m1', 's1', '/p', 'a memory', 1)
  const insert = db.prepare(
    `INSERT INTO episodes (id, namespace, session_id, source, external_id, content, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  insert.run('e1', '/p', 's1', 'host', 'turn-1', 'kafka rebalance lag', 1)
  insert.run('e2', '/p', 's1', 'host', 'turn-2', 'unrelated sentence', 2)
  db.prepare(
    'INSERT INTO memory_episodes (memory_id, episode_id, span_start, span_end, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run('m1', 'e1', 0, 5, 1)
}

describe('migration 025: principals, ownership and tenant-scoped episode identity', () => {
  it('adds the principal tables, the ownership columns and the tenant-scoped identity', () => {
    const db = new Database(':memory:')
    baseline(db)
    const result = runMigrations(db, ':memory:', migrations, () => undefined)
    expect(result.finalVersion).toBe(28)
    expect(tableExists(db, 'bridge_envelopes')).toBe(true)
    expect(tableExists(db, 'bridge_outbox')).toBe(true)
    expect(db.prepare("SELECT COUNT(*) AS n FROM bridge_events").get()).toEqual({ n: 0 })

    for (const table of ['principals', 'principal_tokens', 'grants', 'read_audit']) {
      expect(tableExists(db, table)).toBe(true)
    }
    expect(columnExists(db, 'memories', 'owner_principal')).toBe(true)
    expect(columnExists(db, 'memories', 'visibility')).toBe(true)
    expect(columnExists(db, 'episodes', 'owner_principal')).toBe(true)
    expect(columnExists(db, 'tasks', 'owner_principal')).toBe(true)
    expect(columnExists(db, 'tasks', 'visibility')).toBe(true)
    expect(indexExists(db, 'idx_episodes_identity')).toBe(true)

    const identity = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_episodes_identity'")
      .get() as { sql: string }
    expect(identity.sql).toContain('namespace, source')
    expect(identity.sql).toContain('external_id')
  })

  it('keeps rows, links, fts content and vector rowids across the episodes rebuild', () => {
    const db = new Database(':memory:')
    baseline(db)
    upTo(db, 24)
    seed(db)
    const before = db
      .prepare('SELECT rowid, id, vec_rowid FROM episodes ORDER BY rowid')
      .all() as Array<{ rowid: number; id: string; vec_rowid: number | null }>

    const migration025 = migrations.find((m) => m.version === 25)!
    migration025.up(db)

    const after = db
      .prepare('SELECT rowid, id, vec_rowid FROM episodes ORDER BY rowid')
      .all() as Array<{ rowid: number; id: string; vec_rowid: number | null }>
    expect(after).toEqual(before)
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM episodes_fts WHERE episodes_fts MATCH 'kafka'").get()
    ).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_episodes').get()).toEqual({ n: 1 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    // the triggers the rebuild has to restore by hand
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'episodes'").all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(triggers).toEqual(
      expect.arrayContaining([
        'episodes_fts_insert',
        'episodes_fts_delete',
        'scope_write_epoch_episodes_insert',
        'scope_write_epoch_episodes_delete',
      ])
    )
    const post = db.prepare(
      `INSERT INTO episodes (id, namespace, session_id, source, external_id, content, ingested_at)
       VALUES ('e3', '/p', 's1', 'host', 'turn-3', 'after the rebuild', 3)`
    )
    post.run()
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM episodes_fts WHERE episodes_fts MATCH 'rebuild'").get()
    ).toEqual({ n: 1 })
  })

  it('treats the same upstream id in two namespaces as two rows', () => {
    const db = new Database(':memory:')
    baseline(db)
    runMigrations(db, ':memory:', migrations, () => undefined)
    db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run('s1', '/p', 1)
    const insert = db.prepare(
      `INSERT INTO episodes (id, namespace, session_id, source, external_id, content, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run('e1', '/p1', 's1', 'host', 'turn-1', 'same id, first project', 1)
    insert.run('e2', '/p2', 's1', 'host', 'turn-1', 'same id, second project', 1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM episodes').get()).toEqual({ n: 2 })
    // the same namespace and source instance still deduplicates
    expect(() =>
      insert.run('e3', '/p1', 's1', 'host', 'turn-1', 'a re-send', 1)
    ).toThrow(/UNIQUE/)
    // a null instance is one instance, not a wildcard
    insert.run('e4', '/p1', 's1', 'host', 'turn-9', 'instance named', 1)
    expect(() =>
      insert.run('e5', '/p1', 's1', 'host', 'turn-9', 'instance named again', 1)
    ).toThrow(/UNIQUE/)
  })

  it('is a no-op when re-run', () => {
    const db = new Database(':memory:')
    baseline(db)
    upTo(db, 24)
    seed(db)
    const migration025 = migrations.find((m) => m.version === 25)!
    migration025.up(db)
    const shape = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'episodes'").get()
    migration025.up(db)
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'episodes'").get()).toEqual(shape)
    expect(db.prepare('SELECT COUNT(*) AS n FROM episodes').get()).toEqual({ n: 2 })
  })
})
