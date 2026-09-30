import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { columnExists, indexExists, tableExists } from './types.js'

// principals: the identity a request is served as, the tokens that carry it, and the
// namespace prefixes each one may reach. a namespace argument narrows what the
// credential already allows, so the grant table is the boundary and the argument is not.
//
// owner_principal is null for everything the local install wrote, which is what keeps a
// single-user database working unchanged: a null owner is the local owner's row.
// visibility is null on memories and tasks for the same reason (episodes already carry a
// not-null default of 'personal'), and a null visibility is not personal.
//
// episode identity moves from (source, external_id) to (namespace, source, source
// instance, external_id), so the same upstream id in two namespaces is two rows. sqlite
// cannot drop a table-level unique constraint, so the table is rebuilt with its rowid
// carried over: episodes_fts is external-content on content_rowid=rowid and
// episode_vectors keys rows by the same rowid.
export const migration025: Migration = {
  version: 25,
  description: 'Add principals, per-token grants, row ownership and the cross-principal read audit',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'agent', 'service')),
        created_at INTEGER NOT NULL,
        disabled_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS principal_tokens (
        token_hash TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_principal_tokens_principal
        ON principal_tokens(principal_id);

      CREATE TABLE IF NOT EXISTS grants (
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        namespace_prefix TEXT NOT NULL,
        verbs TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (principal_id, namespace_prefix)
      );

      CREATE TABLE IF NOT EXISTS read_audit (
        ts INTEGER NOT NULL,
        principal_id TEXT,
        namespace TEXT NOT NULL,
        tool TEXT NOT NULL,
        ids_json TEXT NOT NULL DEFAULT '[]',
        channel TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_read_audit_ts ON read_audit(ts);
      CREATE INDEX IF NOT EXISTS idx_read_audit_principal ON read_audit(principal_id, ts);
    `)

    if (!columnExists(db, 'memories', 'owner_principal')) {
      db.exec('ALTER TABLE memories ADD COLUMN owner_principal TEXT')
    }
    if (!columnExists(db, 'memories', 'visibility')) {
      db.exec('ALTER TABLE memories ADD COLUMN visibility TEXT')
    }
    if (!indexExists(db, 'idx_memories_owner')) {
      db.exec(
        'CREATE INDEX idx_memories_owner ON memories(owner_principal) WHERE owner_principal IS NOT NULL'
      )
    }

    // sessions carry the caller's own summary text and are read by list_sessions, so
    // they are owned like the rows they produced
    if (!columnExists(db, 'sessions', 'owner_principal')) {
      db.exec('ALTER TABLE sessions ADD COLUMN owner_principal TEXT')
    }

    if (!columnExists(db, 'tasks', 'owner_principal')) {
      db.exec('ALTER TABLE tasks ADD COLUMN owner_principal TEXT')
    }
    if (!columnExists(db, 'tasks', 'visibility')) {
      db.exec('ALTER TABLE tasks ADD COLUMN visibility TEXT')
    }

    if (!columnExists(db, 'episodes', 'owner_principal')) {
      db.exec('ALTER TABLE episodes ADD COLUMN owner_principal TEXT')
    }
    if (tableExists(db, 'episodes') && hasLegacyEpisodeKey(db)) {
      rebuildEpisodeIdentity(db)
    }
    if (tableExists(db, 'episodes') && !indexExists(db, 'idx_episodes_identity')) {
      db.exec(
        `CREATE UNIQUE INDEX idx_episodes_identity
         ON episodes(namespace, source, COALESCE(source_instance, ''), external_id)`
      )
    }
  },
}

/** the pre-migration table carries a table-level unique constraint; its index has no sql */
function hasLegacyEpisodeKey(db: Database.Database): boolean {
  const rows = db
    .prepare("SELECT name FROM pragma_index_list('episodes') WHERE \"unique\" = 1 AND origin = 'u'")
    .all() as Array<{ name: string }>
  return rows.length > 0
}

// the new table is built beside the old one and renamed into place: renaming the old one
// edits the foreign key clause in memory_episodes and leaves it pointing at a dropped
// table. foreign_keys is on, so that drop cascades to children: hence memory_episodes goes
// first.
function rebuildEpisodeIdentity(db: Database.Database): void {
  const bump = (nsExpr: string): string =>
    `INSERT INTO scope_write_epoch(namespace, epoch) VALUES (${nsExpr}, 1)
       ON CONFLICT(namespace) DO UPDATE SET epoch = epoch + 1`

  db.exec(`
    CREATE TABLE episodes_next (
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
      owner_principal TEXT
    );

    INSERT INTO episodes_next
      (rowid, id, namespace, session_id, task_id, source, source_instance, source_version,
       external_id, author, role, occurred_at, ingested_at, content_type, content, uri,
       turn_index, parent_external_id, chunk_index, chunk_of, visibility, retention,
       expires_at, provenance_json, vec_rowid, embed_state, embedding_model, embedding_dim,
       owner_principal)
    SELECT rowid, id, namespace, session_id, task_id, source, source_instance, source_version,
       external_id, author, role, occurred_at, ingested_at, content_type, content, uri,
       turn_index, parent_external_id, chunk_index, chunk_of, visibility, retention,
       expires_at, provenance_json, vec_rowid, embed_state, embedding_model, embedding_dim,
       owner_principal
    FROM episodes;

    -- Link rows whose episode is gone would abort the copy (the rebuilt table enforces
    -- the foreign key the old one may have been written without).
    CREATE TABLE memory_episodes_next (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES episodes_next(id) ON DELETE CASCADE,
      span_start INTEGER,
      span_end INTEGER,
      created_at INTEGER NOT NULL
    );
    INSERT INTO memory_episodes_next (memory_id, episode_id, span_start, span_end, created_at)
    SELECT me.memory_id, me.episode_id, me.span_start, me.span_end, me.created_at
    FROM memory_episodes me
    WHERE EXISTS (SELECT 1 FROM memories m WHERE m.id = me.memory_id)
      AND EXISTS (SELECT 1 FROM episodes e WHERE e.id = me.episode_id);

    DROP TABLE memory_episodes;
    DROP TABLE episodes;
    ALTER TABLE episodes_next RENAME TO episodes;
    ALTER TABLE memory_episodes_next RENAME TO memory_episodes;

    CREATE INDEX idx_episodes_namespace ON episodes(namespace);
    CREATE INDEX idx_episodes_session ON episodes(namespace, session_id, turn_index);
    CREATE INDEX idx_episodes_occurred ON episodes(occurred_at);
    CREATE INDEX idx_episodes_parent ON episodes(parent_external_id) WHERE parent_external_id IS NOT NULL;
    CREATE INDEX idx_episodes_expires ON episodes(expires_at) WHERE expires_at IS NOT NULL;
    CREATE INDEX idx_episodes_embed_state ON episodes(embed_state) WHERE embed_state != 'fresh';
    CREATE INDEX idx_episodes_vec_rowid ON episodes(vec_rowid);

    CREATE UNIQUE INDEX idx_memory_episodes_unique
      ON memory_episodes(memory_id, episode_id, ifnull(span_start, -1));
    CREATE INDEX idx_memory_episodes_episode ON memory_episodes(episode_id);

    CREATE TRIGGER episodes_fts_insert AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER episodes_fts_delete AFTER DELETE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER scope_write_epoch_episodes_insert AFTER INSERT ON episodes BEGIN
      ${bump('new.namespace')};
    END;

    CREATE TRIGGER scope_write_epoch_episodes_update AFTER UPDATE OF namespace, content ON episodes BEGIN
      ${bump('new.namespace')};
      ${bump('old.namespace')};
    END;

    CREATE TRIGGER scope_write_epoch_episodes_delete AFTER DELETE ON episodes BEGIN
      ${bump('old.namespace')};
    END;

    -- the drop of the old table does not fire its delete trigger, so the index is rebuilt
    -- from the content table instead of trusted to have emptied itself
    INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild');
  `)
}
