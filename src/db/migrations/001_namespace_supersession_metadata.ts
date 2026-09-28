import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { columnExists, indexExists } from './types.js'

export const migration001: Migration = {
  version: 1,
  description: 'Add namespace, embedding provenance, and supersession adjudication metadata',
  up(db: Database.Database) {
    if (!columnExists(db, 'memories', 'namespace')) {
      db.exec('ALTER TABLE memories ADD COLUMN namespace TEXT')
    }
    if (!columnExists(db, 'memories', 'embedding_model')) {
      db.exec('ALTER TABLE memories ADD COLUMN embedding_model TEXT')
    }
    if (!columnExists(db, 'memories', 'embedding_dim')) {
      db.exec('ALTER TABLE memories ADD COLUMN embedding_dim INTEGER')
    }
    if (!columnExists(db, 'memories', 'embed_state')) {
      db.exec("ALTER TABLE memories ADD COLUMN embed_state TEXT NOT NULL DEFAULT 'fresh'")
    }
    if (!columnExists(db, 'memories', 'confidence')) {
      db.exec('ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0')
    }
    if (!columnExists(db, 'memories', 'pinned')) {
      db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
    }

    if (!columnExists(db, 'memory_links', 'confidence')) {
      db.exec('ALTER TABLE memory_links ADD COLUMN confidence REAL')
    }
    if (!columnExists(db, 'memory_links', 'reason')) {
      db.exec('ALTER TABLE memory_links ADD COLUMN reason TEXT')
    }
    if (!columnExists(db, 'memory_links', 'decider_model')) {
      db.exec('ALTER TABLE memory_links ADD COLUMN decider_model TEXT')
    }
    if (!columnExists(db, 'memory_links', 'prompt_version')) {
      db.exec('ALTER TABLE memory_links ADD COLUMN prompt_version TEXT')
    }
    if (!columnExists(db, 'memory_links', 'judged_at')) {
      db.exec('ALTER TABLE memory_links ADD COLUMN judged_at INTEGER')
    }

    if (!indexExists(db, 'idx_memories_namespace')) {
      db.exec('CREATE INDEX idx_memories_namespace ON memories(namespace)')
    }
    if (!indexExists(db, 'idx_memories_embed_state')) {
      db.exec("CREATE INDEX idx_memories_embed_state ON memories(embed_state) WHERE embed_state != 'fresh'")
    }
    if (!indexExists(db, 'idx_memories_pinned')) {
      db.exec('CREATE INDEX idx_memories_pinned ON memories(pinned) WHERE pinned = 1')
    }
    if (!indexExists(db, 'idx_memory_links_supersedes')) {
      db.exec(
        "CREATE INDEX idx_memory_links_supersedes ON memory_links(target_id, link_type, confidence) WHERE link_type = 'supersedes'"
      )
    }
  },
}
