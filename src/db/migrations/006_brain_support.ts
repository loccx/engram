import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { columnExists, indexExists, tableExists } from './types.js'

export const migration006: Migration = {
  version: 6,
  description: 'Add shareable flag on memories + brain subscription tracking tables',
  up(db: Database.Database) {
    if (!columnExists(db, 'memories', 'shareable')) {
      db.exec('ALTER TABLE memories ADD COLUMN shareable INTEGER NOT NULL DEFAULT 0')
    }
    if (!indexExists(db, 'idx_memories_shareable')) {
      db.exec(
        'CREATE INDEX idx_memories_shareable ON memories(namespace, shareable) WHERE shareable = 1'
      )
    }

    if (!tableExists(db, 'brain_subscriptions')) {
      db.exec(`CREATE TABLE brain_subscriptions (
        brain_name TEXT PRIMARY KEY,
        git_remote TEXT NOT NULL,
        owner_name TEXT,
        owner_pubkey TEXT,
        last_refreshed_at INTEGER,
        last_commit_sha TEXT,
        memory_count INTEGER DEFAULT 0,
        description TEXT,
        added_at INTEGER NOT NULL
      )`)
    }

    if (!tableExists(db, 'owned_brains')) {
      db.exec(`CREATE TABLE owned_brains (
        brain_name TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        git_remote TEXT,
        brain_dir TEXT NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL,
        last_published_at INTEGER
      )`)
    }
  },
}
