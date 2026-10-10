import type Database from 'better-sqlite3'
import type { Migration } from './types.js'

// the host-facing automatic-memory protocol. one preferences row per (namespace, host)
// carries the revision a host must present to write, so two windows cannot silently
// overwrite each other; the receipts table holds the newest recall/capture report.
export const migration029: Migration = {
  version: 29,
  description: 'Add host integration preferences and receipts',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS integration_preferences (
        namespace TEXT NOT NULL CHECK (length(CAST(namespace AS BLOB)) BETWEEN 1 AND 4096),
        host TEXT NOT NULL CHECK (length(CAST(host AS BLOB)) BETWEEN 1 AND 64),
        recall INTEGER NOT NULL CHECK (recall IN (0, 1)),
        capture INTEGER NOT NULL CHECK (capture IN (0, 1)),
        revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 0),
        updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
        PRIMARY KEY (namespace, host)
      );

      CREATE TABLE IF NOT EXISTS integration_receipts (
        namespace TEXT NOT NULL,
        host TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('recall', 'capture')),
        at INTEGER NOT NULL CHECK (typeof(at) = 'integer' AND at >= 0),
        status TEXT CHECK (status IS NULL OR length(CAST(status AS BLOB)) BETWEEN 1 AND 64),
        PRIMARY KEY (namespace, host, kind)
      );
    `)
  },
}
