import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { columnExists, indexExists, tableExists } from './types.js'

export const migration003: Migration = {
  version: 3,
  description: 'Add bi-temporal fields, entities table, and procedure metadata',
  up(db: Database.Database) {
    if (!columnExists(db, 'memories', 'valid_from')) {
      db.exec('ALTER TABLE memories ADD COLUMN valid_from INTEGER')
    }
    if (!columnExists(db, 'memories', 'valid_until')) {
      db.exec('ALTER TABLE memories ADD COLUMN valid_until INTEGER')
    }
    db.exec('UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL')

    if (!columnExists(db, 'memories', 'procedure_meta')) {
      db.exec('ALTER TABLE memories ADD COLUMN procedure_meta TEXT')
    }

    if (!tableExists(db, 'memory_entities')) {
      db.exec(`CREATE TABLE memory_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        entity_text TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`)
    }

    if (!indexExists(db, 'idx_memories_valid_from')) {
      db.exec('CREATE INDEX idx_memories_valid_from ON memories(valid_from)')
    }
    if (!indexExists(db, 'idx_memories_valid_until')) {
      db.exec('CREATE INDEX idx_memories_valid_until ON memories(valid_until)')
    }
    if (!indexExists(db, 'idx_memory_entities_memory_id')) {
      db.exec('CREATE INDEX idx_memory_entities_memory_id ON memory_entities(memory_id)')
    }
    if (!indexExists(db, 'idx_memory_entities_text')) {
      db.exec('CREATE INDEX idx_memory_entities_text ON memory_entities(entity_text COLLATE NOCASE)')
    }
  },
}
