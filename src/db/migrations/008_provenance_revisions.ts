import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { columnExists, indexExists, tableExists } from './types.js'

/**
 * Append-only revision/provenance foundation.
 *
 * - memories.origin: where a memory came from ('mcp', 'revision', 'import',
 *   backfilled 'legacy'). Safe default: existing rows become 'legacy'.
 * - memory_links.revision: 0 for adjudicated supersedes links, >= 1 for manual
 *   `revise_memory` links (the successor's version number). Distinguishes
 *   manual revision chains from LLM-adjudicated contradictions.
 * - memory_events: append-only mutation audit log. `memory_id` deliberately
 *   has NO foreign key so forgetting a memory preserves its audit trail (see
 *   store.delete). Payloads carry metadata only — never raw content — so the
 *   audit never retains more sensitive material than existing memory storage.
 */
export const migration008: Migration = {
  version: 8,
  description: 'Add memory origin, manual revision marker, and append-only mutation events',
  up(db: Database.Database) {
    if (!columnExists(db, 'memories', 'origin')) {
      db.exec('ALTER TABLE memories ADD COLUMN origin TEXT')
    }
    // Safe default for all pre-migration rows.
    db.exec("UPDATE memories SET origin = 'legacy' WHERE origin IS NULL")
    if (!indexExists(db, 'idx_memories_origin')) {
      db.exec('CREATE INDEX idx_memories_origin ON memories(origin)')
    }

    if (!columnExists(db, 'memory_links', 'revision')) {
      db.exec('ALTER TABLE memory_links ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
    }

    const eventsJustCreated = !tableExists(db, 'memory_events')
    if (eventsJustCreated) {
      db.exec(`CREATE TABLE memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'created', 'revised', 'superseded', 'updated', 'pinned', 'valid_until_set', 'deleted'
        )),
        origin TEXT,
        session_id TEXT,
        occurred_at INTEGER NOT NULL,
        payload TEXT
      )`)
    }
    if (!indexExists(db, 'idx_memory_events_memory_at')) {
      db.exec(
        'CREATE INDEX idx_memory_events_memory_at ON memory_events(memory_id, occurred_at)'
      )
    }
    if (eventsJustCreated) {
      // One 'created' event per pre-existing row so every memory has a
      // genesis record; payload stays metadata-only.
      db.exec(`INSERT INTO memory_events (memory_id, event_type, origin, session_id, occurred_at, payload)
        SELECT id, 'created', 'legacy', session_id, COALESCE(valid_from, created_at), '{}'
        FROM memories`)
    }
  },
}
