import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { columnExists, tableExists } from './types.js'
import { lexicalIdentColumnDdl } from '../lexical-index.js'

// moves identifier normalisation out of the trigger path. 012's triggers ran a
// per-character recursive CTE on every write, which grows with memory size; this
// adds ident_text, computed in JS instead, and the triggers only copy it.
// a NULL ident_text degrades to an empty FTS document (which matches nothing)
// rather than throwing, and the bounded backfill fills the column on next boot.
// new columns only, nothing re-indexed inline, so a live upgrade cannot block boot.
export const migration015: Migration = {
  version: 15,
  description: 'Add precomputed ident_text columns; identifier index triggers read them',
  up(db: Database.Database) {
    if (!columnExists(db, 'memories', 'ident_text')) {
      db.exec('ALTER TABLE memories ADD COLUMN ident_text TEXT')
    }
    if (tableExists(db, 'memory_entities') && !columnExists(db, 'memory_entities', 'ident_text')) {
      db.exec('ALTER TABLE memory_entities ADD COLUMN ident_text TEXT')
    }
    // replaces 012's triggers; needs the columns added above
    db.exec(lexicalIdentColumnDdl())
  },
}
