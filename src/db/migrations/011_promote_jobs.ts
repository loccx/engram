import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { tableExists } from './types.js'

/**
 * Adds the 'promote' job type to the durable maintenance queue.
 *
 * SQLite cannot ALTER a column CHECK constraint, and migration 009 declared
 * job_type with `CHECK (job_type IN ('digest','cluster','importance','adjudication'))`.
 * So this migration rebuilds the table with the extended CHECK, copying every
 * existing row and recreating all indexes — most importantly the partial
 * unique index on (job_type, target_key) for active rows, which is the
 * enqueue-idempotency mechanism (see jobs.ts `enqueueMaintenanceJob`).
 *
 * Idempotent: skipped when the table is absent (migration 009 always creates
 * it) and when its sqlite_master SQL already contains the 'promote' term.
 */
export const migration011: Migration = {
  version: 11,
  description: 'Add promote job type to maintenance_jobs (rebuild CHECK constraint)',
  up(db: Database.Database) {
    if (!tableExists(db, 'maintenance_jobs')) return

    const current = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_jobs'")
      .get() as { sql: string } | undefined
    if (current?.sql && current.sql.includes('promote')) return

    db.exec(`
      ALTER TABLE maintenance_jobs RENAME TO maintenance_jobs_pre_promote;

      CREATE TABLE maintenance_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL CHECK (job_type IN ('digest', 'cluster', 'importance', 'adjudication', 'promote')),
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
      );

      INSERT INTO maintenance_jobs
        (id, job_type, target_key, status, attempt, max_attempts, lease_owner, lease_expires_at,
         enqueued_at, started_at, finished_at, last_error, result_json, source)
      SELECT id, job_type, target_key, status, attempt, max_attempts, lease_owner, lease_expires_at,
         enqueued_at, started_at, finished_at, last_error, result_json, source
      FROM maintenance_jobs_pre_promote;

      DROP TABLE maintenance_jobs_pre_promote;

      CREATE UNIQUE INDEX idx_maintenance_jobs_active
        ON maintenance_jobs(job_type, target_key)
        WHERE status IN ('queued', 'running');

      CREATE INDEX idx_maintenance_jobs_status ON maintenance_jobs(status);
    `)
  },
}
