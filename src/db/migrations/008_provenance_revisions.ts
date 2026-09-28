import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { columnExists, indexExists, tableExists } from './types.js'

// append-only revision and provenance foundation: memories.origin says where a row
// came from ('mcp', 'revision', 'import', backfilled 'legacy'); memory_links.revision is
// 0 for a judged supersedes link and >= 1 for a manual revise_memory link, which is what
// separates a manual chain from an adjudicated contradiction; memory_events is the
// audit log, with no foreign key on memory_id so forgetting a row keeps its trail.
export const migration008: Migration = {
  version: 8,
  description: 'Add memory origin, manual revision marker, and append-only mutation events',
  up(db: Database.Database) {
    if (!columnExists(db, 'memories', 'origin')) {
      db.exec('ALTER TABLE memories ADD COLUMN origin TEXT')
    }
    // pre-migration rows become 'legacy'
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
      // one 'created' event per pre-existing row, so every memory has a genesis
      // record; the payload stays metadata-only
      db.exec(`INSERT INTO memory_events (memory_id, event_type, origin, session_id, occurred_at, payload)
        SELECT id, 'created', 'legacy', session_id, COALESCE(valid_from, created_at), '{}'
        FROM memories`)
    }
  },
}
