import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { columnExists, indexExists } from './types.js'

export const migration002: Migration = {
  version: 2,
  description: 'Add importance scoring provenance (source, model, prompt_version, scored_at)',
  up(db: Database.Database) {
    if (!columnExists(db, 'memories', 'importance_source')) {
      db.exec(
        "ALTER TABLE memories ADD COLUMN importance_source TEXT NOT NULL DEFAULT 'default'"
      )
    }
    if (!columnExists(db, 'memories', 'importance_model')) {
      db.exec('ALTER TABLE memories ADD COLUMN importance_model TEXT')
    }
    if (!columnExists(db, 'memories', 'importance_prompt_version')) {
      db.exec('ALTER TABLE memories ADD COLUMN importance_prompt_version TEXT')
    }
    if (!columnExists(db, 'memories', 'importance_scored_at')) {
      db.exec('ALTER TABLE memories ADD COLUMN importance_scored_at INTEGER')
    }

    if (!indexExists(db, 'idx_memories_importance_source')) {
      db.exec(
        "CREATE INDEX idx_memories_importance_source ON memories(importance_source) WHERE importance_source != 'llm'"
      )
    }
  },
}
