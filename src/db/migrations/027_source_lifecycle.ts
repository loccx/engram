import type { Migration } from './types.js'
import { columnExists } from './types.js'

// source identity and revision hashes survive removal of the text. No page payload,
// account token, or connector configuration is stored here: the host holds those.
export const migration027: Migration = {
  version: 27,
  description: 'Add scoped source lifecycle, immutable revisions and durable page journals',
  up(db) {
    if (!columnExists(db, 'episodes', 'source_revision_id')) {
      db.exec('ALTER TABLE episodes ADD COLUMN source_revision_id TEXT')
    }
    if (!columnExists(db, 'episodes', 'source_state')) {
      db.exec("ALTER TABLE episodes ADD COLUMN source_state TEXT NOT NULL DEFAULT 'current' CHECK (source_state IN ('current', 'superseded'))")
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_episodes_source_revision ON episodes(source_revision_id)
        WHERE source_revision_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS source_lifecycle_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991)
      );
      INSERT INTO source_lifecycle_meta(singleton, generation) VALUES (1, 0) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS source_connections (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        owner_principal TEXT,
        provider TEXT NOT NULL,
        account_hash TEXT NOT NULL,
        scope_hash TEXT NOT NULL,
        cursor TEXT,
        generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_source_connections_binding
        ON source_connections(namespace, COALESCE(owner_principal, ''), provider, account_hash, scope_hash);
      CREATE TABLE IF NOT EXISTS source_items (
        connection_id TEXT NOT NULL REFERENCES source_connections(id),
        external_id TEXT NOT NULL,
        current_revision_id TEXT,
        PRIMARY KEY (connection_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS source_revisions (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES source_connections(id),
        external_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        episode_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        UNIQUE (connection_id, external_id, revision)
      );
      CREATE TABLE IF NOT EXISTS source_tombstones (
        connection_id TEXT NOT NULL REFERENCES source_connections(id),
        external_id TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('deleted', 'forgotten')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (connection_id, external_id, reason)
      );
      CREATE TABLE IF NOT EXISTS source_forget_barriers (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        owner_principal TEXT,
        provider TEXT NOT NULL,
        account_hash TEXT NOT NULL,
        external_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_source_forget_barriers_identity
        ON source_forget_barriers(namespace, COALESCE(owner_principal, ''), provider, account_hash, external_id);
      CREATE TABLE IF NOT EXISTS source_pages (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES source_connections(id),
        from_cursor TEXT,
        from_generation INTEGER NOT NULL CHECK (from_generation >= 0),
        next_cursor TEXT,
        page_hash TEXT NOT NULL,
        change_count INTEGER NOT NULL CHECK (change_count BETWEEN 0 AND 200),
        state TEXT NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'applied')),
        received_at INTEGER NOT NULL,
        applied_at INTEGER,
        result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_source_pages_connection ON source_pages(connection_id, from_generation);
      CREATE TABLE IF NOT EXISTS source_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL REFERENCES source_connections(id),
        kind TEXT NOT NULL CHECK (kind IN ('replaced', 'deleted', 'forgotten', 'revoked', 'purged')),
        external_id TEXT,
        memory_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS source_connections_binding_update BEFORE UPDATE ON source_connections
        WHEN NEW.id IS NOT OLD.id OR NEW.namespace IS NOT OLD.namespace
          OR NEW.owner_principal IS NOT OLD.owner_principal OR NEW.provider IS NOT OLD.provider
          OR NEW.account_hash IS NOT OLD.account_hash OR NEW.scope_hash IS NOT OLD.scope_hash OR NEW.created_at IS NOT OLD.created_at
          OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
        BEGIN SELECT RAISE(ABORT, 'immutable source connection binding'); END;
      CREATE TRIGGER IF NOT EXISTS source_connections_delete BEFORE DELETE ON source_connections
        BEGIN SELECT RAISE(ABORT, 'source identity must survive removal'); END;
      CREATE TRIGGER IF NOT EXISTS source_connections_replace BEFORE INSERT ON source_connections
        WHEN EXISTS (SELECT 1 FROM source_connections WHERE id = NEW.id OR
          (namespace = NEW.namespace AND COALESCE(owner_principal, '') = COALESCE(NEW.owner_principal, '')
            AND provider = NEW.provider AND account_hash = NEW.account_hash AND scope_hash = NEW.scope_hash) OR
          (NEW.rowid != -1 AND rowid = NEW.rowid))
        BEGIN SELECT RAISE(ABORT, 'immutable source connection binding'); END;
      CREATE TRIGGER IF NOT EXISTS source_items_identity_update BEFORE UPDATE ON source_items
        WHEN NEW.connection_id IS NOT OLD.connection_id OR NEW.external_id IS NOT OLD.external_id
        BEGIN SELECT RAISE(ABORT, 'immutable source item identity'); END;
      CREATE TRIGGER IF NOT EXISTS source_items_delete BEFORE DELETE ON source_items
        BEGIN SELECT RAISE(ABORT, 'source identity must survive removal'); END;
      CREATE TRIGGER IF NOT EXISTS source_items_replace BEFORE INSERT ON source_items
        WHEN EXISTS (SELECT 1 FROM source_items WHERE
          (connection_id = NEW.connection_id AND external_id = NEW.external_id) OR (NEW.rowid != -1 AND rowid = NEW.rowid))
        BEGIN SELECT RAISE(ABORT, 'immutable source item identity'); END;
      CREATE TRIGGER IF NOT EXISTS source_pages_identity_update BEFORE UPDATE ON source_pages
        WHEN NEW.id IS NOT OLD.id OR NEW.connection_id IS NOT OLD.connection_id
          OR NEW.from_cursor IS NOT OLD.from_cursor OR NEW.from_generation IS NOT OLD.from_generation
          OR NEW.next_cursor IS NOT OLD.next_cursor OR NEW.page_hash IS NOT OLD.page_hash
          OR NEW.change_count IS NOT OLD.change_count OR NEW.received_at IS NOT OLD.received_at
          OR OLD.state = 'applied'
        BEGIN SELECT RAISE(ABORT, 'immutable source page identity'); END;
      CREATE TRIGGER IF NOT EXISTS source_pages_delete BEFORE DELETE ON source_pages
        BEGIN SELECT RAISE(ABORT, 'source page journal must survive removal'); END;
      CREATE TRIGGER IF NOT EXISTS source_pages_replace BEFORE INSERT ON source_pages
        WHEN EXISTS (SELECT 1 FROM source_pages WHERE id = NEW.id OR (NEW.rowid != -1 AND rowid = NEW.rowid))
        BEGIN SELECT RAISE(ABORT, 'immutable source page identity'); END;
    `)
    for (const table of ['source_connections', 'source_items', 'source_pages', 'source_revisions', 'source_tombstones', 'source_forget_barriers', 'source_events']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_reserved_rowid AFTER INSERT ON ${table} WHEN NEW.rowid = -1
        BEGIN SELECT RAISE(ABORT, 'source history rowid -1 is reserved'); END`)
    }
    for (const [table, identity] of [
      ['source_revisions', "id = NEW.id OR episode_id = NEW.episode_id OR (connection_id = NEW.connection_id AND external_id = NEW.external_id AND revision = NEW.revision)"],
      ['source_tombstones', 'connection_id = NEW.connection_id AND external_id = NEW.external_id AND reason = NEW.reason'],
      ['source_forget_barriers', "id = NEW.id OR (namespace = NEW.namespace AND COALESCE(owner_principal, '') = COALESCE(NEW.owner_principal, '') AND provider = NEW.provider AND account_hash = NEW.account_hash AND external_id = NEW.external_id)"],
      ['source_events', 'NEW.sequence != -1 AND sequence = NEW.sequence'],
    ]) {
      // sqlite REPLACE bypasses delete triggers unless recursive_triggers is on.
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_replace BEFORE INSERT ON ${table}
        WHEN EXISTS (SELECT 1 FROM ${table} WHERE (${identity}) OR (NEW.rowid != -1 AND rowid = NEW.rowid))
        BEGIN SELECT RAISE(ABORT, 'immutable source history'); END`)
      for (const operation of ['UPDATE', 'DELETE']) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
          BEGIN SELECT RAISE(ABORT, 'immutable source history'); END`)
      }
    }
  },
}
