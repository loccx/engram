import type Database from 'better-sqlite3'
import type { Migration } from './types.js'

// the content-addressed embedding cache: one row per distinct (model, dtype, dim, mode,
// text), so content repeated across memories, episodes, namespaces or a re-ingest is
// embedded once. key and vector bytes are written by src/embeddings/cache.ts;
// last_used_at is the lru stamp behind the row cap, so it carries an index.
export const migration022: Migration = {
  version: 22,
  description: 'Add the content-addressed embedding cache table',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        key TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dtype TEXT NOT NULL,
        mode TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_embedding_cache_lru ON embedding_cache(last_used_at);
    `)
  },
}
