import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { lexicalIndexDdl } from '../lexical-index.js'

// adds the two identifier-normalised FTS5 tables and their triggers; see
// ../lexical-index.ts for the design. memories_fts is untouched: rebuilding it
// with a normalised column aborts inside the transaction and would blank the
// existing channel meanwhile. pre-existing rows are filled by the startup
// backfill worker, never inline here. the DDL is idempotent by construction.
export const migration012: Migration = {
  version: 12,
  description: 'Add identifier-normalised lexical index (memories_ident_fts, memory_entity_fts)',
  up(db: Database.Database) {
    db.exec(lexicalIndexDdl())
  },
}
