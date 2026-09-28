import { describe, it, expect } from 'vitest'
import { createTestDb } from './helpers.js'

// the rebuild branch only runs when the stored DDL lacks the new identity, so this
// test recreates the pre-013 shape (a fresh db has already run 013 and skips it)
describe('migration 013 tolerates orphan links', () => {
  const seedMemory = (db: ReturnType<typeof createTestDb>['db'], id: string, now: number): void => {
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from)
       VALUES (?, 's1', '/p', '/p', 'content', 'note', 0.5, '[]', ?, ?)`
    ).run(id, now, now)
  }

  it('drops dangling rows instead of aborting the upgrade, and keeps valid ones', async () => {
    const { db } = createTestDb()
    const now = 1

    db.exec(`
      DROP TABLE memory_links;
      CREATE TABLE memory_links (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        similarity REAL NOT NULL,
        link_type TEXT NOT NULL DEFAULT 'semantic',
        created_at INTEGER NOT NULL,
        confidence REAL,
        reason TEXT,
        decider_model TEXT,
        prompt_version TEXT,
        judged_at INTEGER,
        revision INTEGER NOT NULL DEFAULT 0
      );
    `)

    db.prepare("INSERT INTO sessions (id, project_path, started_at) VALUES ('s1', '/p', ?)").run(now)
    seedMemory(db, 'keep-a', now)
    seedMemory(db, 'keep-b', now)

    const insertLink = db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at)
       VALUES (?, ?, 0.9, 'semantic', ?)`
    )
    insertLink.run('keep-a', 'keep-b', now) // valid
    insertLink.run('keep-a', 'ghost-deleted', now) // dangling target
    insertLink.run('ghost-deleted', 'keep-b', now) // dangling source

    const { migration013 } = await import('../src/db/migrations/013_lifecycle_archive_tier.js')
    expect(() => migration013.up(db)).not.toThrow()

    const rows = db
      .prepare('SELECT source_id, target_id FROM memory_links ORDER BY source_id, target_id')
      .all()
    expect(rows).toEqual([{ source_id: 'keep-a', target_id: 'keep-b' }])

    const ddl = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_links'").get() as {
        sql: string
      }
    ).sql
    expect(ddl).toContain('REFERENCES memories(id)')
    expect(ddl).toContain('source_id, target_id, link_type')
  })
})
