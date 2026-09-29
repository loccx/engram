import type Database from 'better-sqlite3'
import type { Migration } from './types.js'

// episodes: the raw evidence layer beside memories, one row per turn or chunk.
// untrusted volume lands here (a long session is thousands of turns), so the
// curated table keeps its size, its bm25 statistics and its digests. rows are
// immutable and idempotent on (source, external_id), which is what makes a delta
// batch re-ingestable. memory_episodes links a derived memory back to the evidence
// it came from, with the character span inside the episode.
//
// episode_vectors is not here: it is a vec0 table and sqlite-vec is loaded after
// the migrations run (src/db/init.ts), so that module creates it.
export const migration019: Migration = {
  version: 19,
  description: 'Add the episodes evidence layer, its fts index and memory_episodes links',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT,
        source TEXT NOT NULL,
        source_instance TEXT,
        source_version TEXT,
        external_id TEXT NOT NULL,
        author TEXT,
        role TEXT,
        occurred_at INTEGER,
        ingested_at INTEGER NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text/plain',
        content TEXT NOT NULL,
        uri TEXT,
        turn_index INTEGER,
        parent_external_id TEXT,
        chunk_index INTEGER,
        chunk_of INTEGER,
        visibility TEXT NOT NULL DEFAULT 'personal',
        retention TEXT NOT NULL DEFAULT 'durable',
        expires_at INTEGER,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        vec_rowid INTEGER,
        embed_state TEXT NOT NULL DEFAULT 'stale',
        embedding_model TEXT,
        embedding_dim INTEGER,
        UNIQUE (source, external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_namespace ON episodes(namespace);
      CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(namespace, session_id, turn_index);
      CREATE INDEX IF NOT EXISTS idx_episodes_occurred ON episodes(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_episodes_parent ON episodes(parent_external_id) WHERE parent_external_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_episodes_expires ON episodes(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_episodes_embed_state ON episodes(embed_state) WHERE embed_state != 'fresh';
      CREATE INDEX IF NOT EXISTS idx_episodes_vec_rowid ON episodes(vec_rowid);

      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        content,
        content=episodes,
        content_rowid=rowid
      );

      DROP TRIGGER IF EXISTS episodes_fts_insert;
      CREATE TRIGGER episodes_fts_insert AFTER INSERT ON episodes BEGIN
        INSERT INTO episodes_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      DROP TRIGGER IF EXISTS episodes_fts_delete;
      CREATE TRIGGER episodes_fts_delete AFTER DELETE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TABLE IF NOT EXISTS memory_episodes (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        span_start INTEGER,
        span_end INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_episodes_unique
        ON memory_episodes(memory_id, episode_id, ifnull(span_start, -1));
      CREATE INDEX IF NOT EXISTS idx_memory_episodes_episode ON memory_episodes(episode_id);
    `)
  },
}
