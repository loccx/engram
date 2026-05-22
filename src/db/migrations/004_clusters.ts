import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { indexExists, tableExists } from './types.js'

export const migration004: Migration = {
  version: 4,
  description: 'Add memory_clusters table for community summaries',
  up(db: Database.Database) {
    if (!tableExists(db, 'memory_clusters')) {
      db.exec(`CREATE TABLE memory_clusters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        member_ids TEXT NOT NULL,
        summary TEXT NOT NULL,
        is_extractive INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`)
    }

    if (!indexExists(db, 'idx_memory_clusters_project')) {
      db.exec('CREATE INDEX idx_memory_clusters_project ON memory_clusters(project_path)')
    }
  },
}
