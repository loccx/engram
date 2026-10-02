import type { Migration } from './types.js'

// bridge history outlives source rows; only the fenced outbox projection is mutable.
export const migration026: Migration = {
  version: 26,
  description: 'Add immutable governed bridge history and a fenced explicit outbox',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_envelopes (
        envelope_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('publish', 'retract')),
        payload_bytes TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        target_envelope_id TEXT REFERENCES bridge_envelopes(envelope_id),
        supersedes_envelope_id TEXT REFERENCES bridge_envelopes(envelope_id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_approvals (
        envelope_id TEXT PRIMARY KEY REFERENCES bridge_envelopes(envelope_id),
        opaque_grant TEXT NOT NULL,
        approval_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_approval_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        envelope_id TEXT NOT NULL REFERENCES bridge_envelopes(envelope_id),
        event_type TEXT NOT NULL CHECK (event_type IN ('granted', 'revoked')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bridge_approval_events_envelope ON bridge_approval_events(envelope_id, sequence);
      CREATE TABLE IF NOT EXISTS bridge_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        envelope_id TEXT NOT NULL REFERENCES bridge_envelopes(envelope_id),
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        detail_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bridge_events_envelope ON bridge_events(envelope_id, sequence);
      CREATE TABLE IF NOT EXISTS bridge_outbox (
        envelope_id TEXT PRIMARY KEY REFERENCES bridge_envelopes(envelope_id),
        state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'acknowledged', 'visible', 'retract_acknowledged', 'retracted_verified', 'reconciliation_required', 'conflict', 'rejected', 'dead', 'cancelled')),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
        lease_owner TEXT,
        lease_token TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        receipt_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bridge_outbox_due ON bridge_outbox(state, next_attempt_at, lease_expires_at);
    `)
    const immutableIdentities = [
      ['bridge_envelopes', 'envelope_id = NEW.envelope_id OR idempotency_key = NEW.idempotency_key OR (NEW.rowid != -1 AND rowid = NEW.rowid)'],
      ['bridge_approvals', 'envelope_id = NEW.envelope_id OR (NEW.rowid != -1 AND rowid = NEW.rowid)'],
      ['bridge_approval_events', 'NEW.sequence != -1 AND sequence = NEW.sequence'],
      ['bridge_events', 'NEW.sequence != -1 AND sequence = NEW.sequence'],
    ]
    for (const [table, conflict] of immutableIdentities) {
      // replace can delete implicitly without firing delete triggers; guard every unique identity.
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_insert
        BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${conflict})
        BEGIN SELECT RAISE(ABORT, 'immutable bridge history'); END`)
      // before-insert rowid is -1 for automatic allocation; reserve stored -1 without blocking appends.
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_rowid
        AFTER INSERT ON ${table} WHEN NEW.rowid = -1
        BEGIN SELECT RAISE(ABORT, 'immutable bridge history: rowid -1 is reserved'); END`)
      for (const operation of ['UPDATE', 'DELETE']) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()}
          BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable bridge history'); END`)
      }
    }
  },
}
