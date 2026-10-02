import { DatabaseManager } from '../src/db/init.js'

export function createTestDb(): { db: import('better-sqlite3').Database; vectorsAvailable: boolean } {
  const manager = new DatabaseManager(':memory:')
  return { db: manager.db, vectorsAvailable: manager.vectorsAvailable }
}

/** topics reference real canonical rows so access filtering has a positive control. */
export function seedClusterMembers(db: import('better-sqlite3').Database, namespace: string, ids: string[]): void {
  const session = `cluster-fixture:${namespace}`
  db.prepare('INSERT OR IGNORE INTO sessions(id, project_path, started_at) VALUES (?, ?, 1)').run(session, namespace)
  const insert = db.prepare(`INSERT INTO memories(id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from)
    VALUES (?, ?, ?, ?, ?, 'note', 0.5, '[]', 1, 1)`)
  db.transaction(() => {
    for (const id of ids) insert.run(id, session, namespace, namespace, `Synthetic topic member ${id}.`)
  })()
}
