import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { indexExists, tableExists } from './types.js'

/**
 * Durable maintenance job queue. Survives restarts (unlike the in-memory
 * BackgroundJobQueue used by adjudication/importance), supports idempotent
 * enqueue, atomic lease/claim, retries, and a terminal dead state.
 *
 * The partial unique index is the idempotency mechanism: only one
 * (job_type, target_key) pair may be queued or running at a time, so
 * `INSERT ... ON CONFLICT DO NOTHING` coalesces duplicate enqueues.
 *
 * Patches run in SHADOW mode by default: handlers may inspect state and write
 * summary/proposed output to result_json only. They must never write canonical
 * memories, digests, clusters, importance, or supersession links.
 */
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
