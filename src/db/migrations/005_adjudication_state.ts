import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { columnExists, indexExists } from './types.js'

export const migration005: Migration = {
  version: 5,
  description: 'Track adjudication state on memories for crash-safe replay',
  up(db: Database.Database) {
    if (!columnExists(db, 'memories', 'adjudication_state')) {
      // NULL = pre-feature row, treat as "no replay needed".
      // 'pending' = enqueued or in-flight when daemon last ran.
      // 'done' = adjudicator ran to a terminal status (ok, no-candidates, error).
      // 'skipped' = pinned, missing, or LLM unavailable; do not retry.
      db.exec("ALTER TABLE memories ADD COLUMN adjudication_state TEXT")
    }
    if (!indexExists(db, 'idx_memories_adjudication_state')) {
      db.exec(
        "CREATE INDEX idx_memories_adjudication_state ON memories(adjudication_state) WHERE adjudication_state = 'pending'"
      )
    }
  },
}
