import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { indexExists, tableExists } from './types.js'

/**
 * Materialized namespace tree for hierarchical memory scoping (funnel retrieval).
 *
 * Rows are created lazily by `ensureNode` (src/namespace/tree.ts) and by the
 * `backfillTree` sweep over distinct memory namespaces. Digest columns form the
 * "thin navigation layer" that funnel retrieval consults when a leaf scope is
 * thin; they are written by the nav digest refresher, never by this migration.
 */
export const migration010: Migration = {
  version: 10,
  description: 'Add namespace_nodes tree for hierarchical scoping and funnel retrieval',
  up(db: Database.Database) {
    if (!tableExists(db, 'namespace_nodes')) {
      db.exec(`CREATE TABLE namespace_nodes (
        path TEXT PRIMARY KEY,
        parent_path TEXT,
        depth INTEGER NOT NULL,
        is_synthetic INTEGER NOT NULL DEFAULT 0,
        real_path TEXT,
        digest TEXT,
        digest_source_hash TEXT,
        memory_count INTEGER NOT NULL DEFAULT 0,
        child_count INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER,
        updated_at INTEGER NOT NULL
      )`)
    }
    if (!indexExists(db, 'idx_namespace_nodes_parent')) {
      db.exec('CREATE INDEX idx_namespace_nodes_parent ON namespace_nodes(parent_path)')
    }
    if (!indexExists(db, 'idx_namespace_nodes_depth')) {
      db.exec('CREATE INDEX idx_namespace_nodes_depth ON namespace_nodes(depth)')
    }
  },
}
