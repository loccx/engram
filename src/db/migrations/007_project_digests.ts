import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { tableExists } from './types.js'

export const migration007: Migration = {
  version: 7,
  description: 'Add project_digests table for pre-consolidated pinned-fact snapshots',
  up(db: Database.Database) {
    if (!tableExists(db, 'project_digests')) {
      db.exec(`CREATE TABLE project_digests (
        namespace TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        source_hash TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`)
    }
  },
}
