import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { columnExists, indexExists, tableExists } from './types.js'

// lifecycle tier: archived_at, widened link identity, new job types, embed repair.
// the memory_links key was (source_id, target_id), which silently dropped any
// second link type for a pair (INSERT OR IGNORE is used everywhere), so it gains
// link_type; maintenance_jobs is rebuilt to widen its CHECK (sqlite cannot ALTER
// one); rows holding a vector but no embedding_model are marked stale so the
// re-embed worker fills the provenance columns honestly (next boot, batched).
// every step is guarded by a probe, so a re-run is a no-op.
export const migration013: Migration = {
  version: 13,
  description: 'Add archive tier (archived_at), widen memory_links identity, lifecycle job types',
  up(db: Database.Database) {
    if (!columnExists(db, 'memories', 'archived_at')) {
      db.exec('ALTER TABLE memories ADD COLUMN archived_at INTEGER')
    }
    if (!indexExists(db, 'idx_memories_archived_at')) {
      db.exec(
        'CREATE INDEX idx_memories_archived_at ON memories(archived_at) WHERE archived_at IS NOT NULL'
      )
    }

    const linkSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_links'")
        .get() as { sql: string } | undefined
    )?.sql
    if (linkSql && !linkSql.includes('source_id, target_id, link_type')) {
      db.exec(`
        ALTER TABLE memory_links RENAME TO memory_links_pre_link_identity;

        CREATE TABLE memory_links (
          source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          similarity REAL NOT NULL,
          link_type TEXT NOT NULL DEFAULT 'semantic',
          created_at INTEGER NOT NULL,
          confidence REAL,
          reason TEXT,
          decider_model TEXT,
          prompt_version TEXT,
          judged_at INTEGER,
          revision INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (source_id, target_id, link_type)
        );

        -- Dangling rows are dropped, not carried: older databases can hold
        -- memory_links entries whose source or target memory was deleted
        -- before this table enforced a foreign key, and the rebuilt table
        -- references memories(id) — copying such a row aborts the entire
        -- upgrade with FOREIGN KEY constraint failed.
        INSERT INTO memory_links
          (source_id, target_id, similarity, link_type, created_at, confidence, reason,
           decider_model, prompt_version, judged_at, revision)
        SELECT l.source_id, l.target_id, l.similarity, l.link_type, l.created_at, l.confidence, l.reason,
           l.decider_model, l.prompt_version, l.judged_at, l.revision
        FROM memory_links_pre_link_identity l
        WHERE EXISTS (SELECT 1 FROM memories m WHERE m.id = l.source_id)
          AND EXISTS (SELECT 1 FROM memories m WHERE m.id = l.target_id);

        DROP TABLE memory_links_pre_link_identity;
      `)
    }
    if (!indexExists(db, 'idx_memory_links_source')) {
      db.exec('CREATE INDEX idx_memory_links_source ON memory_links(source_id)')
    }
    if (!indexExists(db, 'idx_memory_links_target')) {
      db.exec('CREATE INDEX idx_memory_links_target ON memory_links(target_id)')
    }
    if (!indexExists(db, 'idx_memory_links_supersedes')) {
      db.exec(
        "CREATE INDEX idx_memory_links_supersedes ON memory_links(target_id, link_type, confidence) WHERE link_type = 'supersedes'"
      )
    }

    if (tableExists(db, 'maintenance_jobs')) {
      const jobsSql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_jobs'")
          .get() as { sql: string } | undefined
      )?.sql
      if (jobsSql && !jobsSql.includes('retention')) {
        db.exec(`
          ALTER TABLE maintenance_jobs RENAME TO maintenance_jobs_pre_lifecycle;

          CREATE TABLE maintenance_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_type TEXT NOT NULL CHECK (job_type IN ('digest', 'cluster', 'importance', 'adjudication', 'promote', 'prune', 'retention')),
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
          FROM maintenance_jobs_pre_lifecycle;

          DROP TABLE maintenance_jobs_pre_lifecycle;
        `)
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
    }

    if (columnExists(db, 'memories', 'embed_state')) {
      db.exec("UPDATE memories SET embed_state = 'stale' WHERE embed_state = 'pending'")
      db.exec(
        `UPDATE memories SET embed_state = 'stale'
         WHERE vec_rowid IS NOT NULL AND embedding_model IS NULL`
      )
    }
  },
}
