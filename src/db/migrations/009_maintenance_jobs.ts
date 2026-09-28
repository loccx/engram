import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { indexExists, tableExists } from './types.js'

// durable maintenance job queue: it survives restarts (the in-memory background queue
// does not), takes idempotent enqueues, atomic leases with a terminal dead state, and
// retries. the partial unique index on (job_type, target_key) for active rows is what
// makes an enqueue idempotent. handlers are shadow-only by default: they inspect state
// and write a summary to result_json, never canonical memories, digests, clusters,
// importance or supersession links.
export const migration009: Migration = {
  version: 9,
  description: 'Add durable maintenance_jobs queue with lease-based claiming',
  up(db: Database.Database) {
    if (!tableExists(db, 'maintenance_jobs')) {
      db.exec(`CREATE TABLE maintenance_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL CHECK (job_type IN ('digest', 'cluster', 'importance', 'adjudication')),
        target_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'dead')),
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        enqueued_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        last_error TEXT,
        result_json TEXT,
        source TEXT
      )`)
    }
    if (!indexExists(db, 'idx_maintenance_jobs_active')) {
      db.exec(
        `CREATE UNIQUE INDEX idx_maintenance_jobs_active
         ON maintenance_jobs(job_type, target_key)
         WHERE status IN ('queued', 'running')`
      )
    }
    if (!indexExists(db, 'idx_maintenance_jobs_status')) {
      db.exec('CREATE INDEX idx_maintenance_jobs_status ON maintenance_jobs(status)')
    }
  },
}
