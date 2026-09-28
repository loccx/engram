import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { indexExists, tableExists } from './types.js'

// the query-level ledger: engram_events only counts calls, so which query missed
// is otherwise unrecoverable. version 14, not 12/13, because those numbers are
// reserved; the runner tolerates the gap (see runner.ts). has not shipped, so
// extending this file is safe where a shipped migration would need version 16.
export const migration014: Migration = {
  version: 14,
  description: 'Add retrieval_events ledger for query-level retrieval telemetry',
  up(db: Database.Database) {
    if (!tableExists(db, 'retrieval_events')) {
      db.exec(`CREATE TABLE retrieval_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool TEXT NOT NULL,
        mode TEXT,
        namespace TEXT,
        query TEXT,
        query_chars INTEGER NOT NULL DEFAULT 0,
        query_logged INTEGER NOT NULL DEFAULT 1,
        result_count INTEGER NOT NULL DEFAULT 0,
        result_ids TEXT NOT NULL DEFAULT '[]',
        latency_ms INTEGER NOT NULL DEFAULT 0,
        budget_chars INTEGER,
        used_chars INTEGER,
        dropped_memories INTEGER NOT NULL DEFAULT 0,
        dropped_topics INTEGER NOT NULL DEFAULT 0,
        digest_chars_cut INTEGER NOT NULL DEFAULT 0,
        truncated_digest INTEGER NOT NULL DEFAULT 0,
        truncated_memories INTEGER NOT NULL DEFAULT 0,
        truncated_topics INTEGER NOT NULL DEFAULT 0,
        weak INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`)
    }
    if (!indexExists(db, 'idx_retrieval_events_created')) {
      db.exec('CREATE INDEX idx_retrieval_events_created ON retrieval_events(created_at)')
    }
    if (!indexExists(db, 'idx_retrieval_events_namespace')) {
      db.exec('CREATE INDEX idx_retrieval_events_namespace ON retrieval_events(namespace)')
    }
    if (!indexExists(db, 'idx_retrieval_events_tool')) {
      db.exec('CREATE INDEX idx_retrieval_events_tool ON retrieval_events(tool)')
    }
    // duplicate-group detection filters memory_links by similarity; without this
    // index the query scans every link
    if (!indexExists(db, 'idx_memory_links_similarity')) {
      db.exec('CREATE INDEX idx_memory_links_similarity ON memory_links(similarity)')
    }
  },
}
