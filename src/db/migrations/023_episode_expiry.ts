import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { tableExists } from './types.js'

// the evidence tier's expiry: the 'episodes_expired' job type, the sweep that reclaims
// rows whose retention ended, and the index that sweep reads. sqlite cannot alter a
// check constraint, so the job table is rebuilt with the extended check, every row
// copied and every index recreated — the partial unique index on active
// (job_type, target_key) rows above all, since that is what keeps a re-enqueue
// coalesced. skipped when the table is absent or its sqlite_master sql already mentions
// the job type; the index is created either way.
export const migration023: Migration = {
  version: 23,
  description: 'Add the episodes_expired job type and a retention index for the episode sweep',
  up(db: Database.Database) {
    if (tableExists(db, 'maintenance_jobs')) {
      const current = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_jobs'")
        .get() as { sql: string } | undefined
      if (!current?.sql || !current.sql.includes('episodes_expired')) {
        db.exec(`
          ALTER TABLE maintenance_jobs RENAME TO maintenance_jobs_pre_episode_sweep;

          CREATE TABLE maintenance_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_type TEXT NOT NULL CHECK (job_type IN ('digest', 'cluster', 'importance', 'adjudication', 'promote', 'prune', 'retention', 'reembed_episodes', 'episodes_expired')),
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
          FROM maintenance_jobs_pre_episode_sweep;

          DROP TABLE maintenance_jobs_pre_episode_sweep;

          CREATE UNIQUE INDEX idx_maintenance_jobs_active
            ON maintenance_jobs(job_type, target_key)
            WHERE status IN ('queued', 'running');

          CREATE INDEX idx_maintenance_jobs_status ON maintenance_jobs(status);
        `)
      }
    }

    if (tableExists(db, 'episodes')) {
      // partial: a durable episode is never swept, and the two readers here are the
      // sweep's retention='session' half and a session's own end
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_episodes_retention
          ON episodes(retention, session_id) WHERE retention != 'durable';
      `)
    }
  },
}
