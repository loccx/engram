import type Database from 'better-sqlite3'
import type { Migration } from './types.js'

// optional typed representations belong to canonical rows, never a second fact store.
// schema ids are immutable name@version definitions; no existing prose is backfilled.
// these tables intentionally contain no origin, authority, owner or evidence copies:
// reads inherit those from the canonical row and its currently visible evidence links.
export const migration028: Migration = {
  version: 28,
  description: 'Add trusted-host assertion schemas and optional canonical memory sidecars',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_assertion_schemas (
        schema_id TEXT PRIMARY KEY NOT NULL CHECK (length(CAST(schema_id AS BLOB)) BETWEEN 1 AND 192),
        predicate TEXT NOT NULL CHECK (length(CAST(predicate AS BLOB)) BETWEEN 1 AND 512),
        value_schema_json TEXT NOT NULL CHECK (
          json_valid(value_schema_json) AND length(CAST(value_schema_json AS BLOB)) <= 16384
        ),
        registered_at INTEGER NOT NULL CHECK (typeof(registered_at) = 'integer' AND registered_at >= 0),
        UNIQUE (schema_id, predicate)
      );

      CREATE TABLE IF NOT EXISTS memory_assertions (
        memory_id TEXT PRIMARY KEY NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        schema_id TEXT NOT NULL,
        subject TEXT NOT NULL CHECK (length(CAST(subject AS BLOB)) BETWEEN 1 AND 512),
        predicate TEXT NOT NULL CHECK (length(CAST(predicate AS BLOB)) BETWEEN 1 AND 512),
        value_json TEXT NOT NULL CHECK (
          json_valid(value_json) AND length(CAST(value_json AS BLOB)) <= 8192
        ),
        observed_at INTEGER NOT NULL CHECK (typeof(observed_at) = 'integer' AND observed_at >= 0),
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        attached_at INTEGER NOT NULL CHECK (typeof(attached_at) = 'integer' AND attached_at >= 0),
        represented_at INTEGER NOT NULL CHECK (typeof(represented_at) = 'integer' AND represented_at >= 0),
        representation_version INTEGER NOT NULL DEFAULT 1 CHECK (
          typeof(representation_version) = 'integer' AND representation_version >= 1
        ),
        FOREIGN KEY (schema_id, predicate) REFERENCES memory_assertion_schemas(schema_id, predicate)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_assertions_exact
        ON memory_assertions(subject, predicate, schema_id, value_json);
      CREATE INDEX IF NOT EXISTS idx_memory_assertions_schema ON memory_assertions(schema_id);

      -- REPLACE deletes conflicting rows without delete triggers unless recursive
      -- triggers are enabled. Guard unique ids and explicit rowids before insertion.
      CREATE TRIGGER IF NOT EXISTS memory_assertion_schemas_immutable_insert
      BEFORE INSERT ON memory_assertion_schemas WHEN EXISTS (
        SELECT 1 FROM memory_assertion_schemas WHERE schema_id = NEW.schema_id OR rowid = NEW.rowid
      ) BEGIN
        SELECT RAISE(ABORT, 'assertion schema ids are immutable; register a new version');
      END;
      CREATE TRIGGER IF NOT EXISTS memory_assertions_immutable_insert
      BEFORE INSERT ON memory_assertions WHEN EXISTS (
        SELECT 1 FROM memory_assertions WHERE memory_id = NEW.memory_id OR rowid = NEW.rowid
      ) BEGIN
        SELECT RAISE(ABORT, 'assertion claim changes require a new canonical revision');
      END;

      CREATE TRIGGER IF NOT EXISTS memory_assertion_schemas_immutable_update
      BEFORE UPDATE ON memory_assertion_schemas BEGIN
        SELECT RAISE(ABORT, 'assertion schema ids are immutable; register a new version');
      END;
      CREATE TRIGGER IF NOT EXISTS memory_assertion_schemas_immutable_delete
      BEFORE DELETE ON memory_assertion_schemas BEGIN
        SELECT RAISE(ABORT, 'assertion schema ids are immutable; register a new version');
      END;

      -- Even a legacy in-place canonical content edit must not leave a stale typed claim.
      CREATE TRIGGER IF NOT EXISTS memory_assertions_canonical_content_changed
      AFTER UPDATE OF content ON memories WHEN OLD.content IS NOT NEW.content BEGIN
        DELETE FROM memory_assertions WHERE memory_id = NEW.id;
      END;

      -- Only schema representation changes are allowed on an existing sidecar. Claim
      -- corrections are new canonical revisions; observation time never moves forward.
      CREATE TRIGGER IF NOT EXISTS memory_assertions_immutable_claim
      BEFORE UPDATE ON memory_assertions WHEN
        OLD.memory_id IS NOT NEW.memory_id OR OLD.subject IS NOT NEW.subject OR
        OLD.predicate IS NOT NEW.predicate OR OLD.value_json IS NOT NEW.value_json OR
        OLD.observed_at IS NOT NEW.observed_at OR OLD.content_sha256 IS NOT NEW.content_sha256 OR
        OLD.attached_at IS NOT NEW.attached_at OR
        NEW.representation_version <> OLD.representation_version + 1
      BEGIN
        SELECT RAISE(ABORT, 'assertion claim changes require a new canonical revision');
      END;
    `)
  },
}
