import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { indexExists, tableExists } from './types.js'

// eviction ledger: retention and prune already compute a per-row reason, and nothing
// recorded it, so a kept, archived or paged-back-in row was unrecoverable afterwards.
// version 24, not 23: that number is reserved by a parallel branch and the runner
// tolerates the gap (see runner.ts).
export const migration024: Migration = {
  version: 24,
  description: 'Add eviction_events telemetry for retention/prune decisions and cold-tier faults',
  up(db: Database.Database) {
    if (!tableExists(db, 'eviction_events')) {
      db.exec(`CREATE TABLE eviction_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        namespace TEXT,
        memory_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        tier TEXT,
        job_id INTEGER
      )`)
    }
    // the stats window reads ts first and the row cap deletes by ts
    if (!indexExists(db, 'idx_eviction_events_ts')) {
      db.exec('CREATE INDEX idx_eviction_events_ts ON eviction_events(ts)')
    }
    if (!indexExists(db, 'idx_eviction_events_action')) {
      db.exec('CREATE INDEX idx_eviction_events_action ON eviction_events(action, ts)')
    }
    if (!indexExists(db, 'idx_eviction_events_memory')) {
      db.exec('CREATE INDEX idx_eviction_events_memory ON eviction_events(memory_id)')
    }
  },
}
