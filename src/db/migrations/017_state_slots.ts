import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { columnExists, indexExists } from './types.js'
import { backfillChainKeys } from '../../memory/state.js'

// state slots: one nullable column names the slot a value belongs to, and the head is
// derived from the supersedes links every write path already writes, so nothing can
// drift out of sync with them. the partial index keeps "which slots does this namespace
// have" off the ordinary memory rows. the backfill names the chains that predate the
// column (one supersedes component = one slot), which is a key derived from existing
// data: no history moves and re-running is a no-op.
export const migration017: Migration = {
  version: 17,
  description: 'Add the state_key slot column and backfill existing supersession chains',
  up(db: Database.Database) {
    if (!columnExists(db, 'memories', 'state_key')) {
      db.exec('ALTER TABLE memories ADD COLUMN state_key TEXT')
    }
    if (!indexExists(db, 'idx_memories_state_key')) {
      db.exec(
        'CREATE INDEX idx_memories_state_key ON memories(namespace, state_key) WHERE state_key IS NOT NULL'
      )
    }
    backfillChainKeys(db)
  },
}
