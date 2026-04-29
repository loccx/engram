import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { join } from 'path'
import envPaths from 'env-paths'
import * as sqliteVec from 'sqlite-vec'
import { EMBEDDING_DIM } from '../embeddings/pipeline.js'
import { migrations, runMigrations, type MigrationRunResult } from './migrations/index.js'

const paths = envPaths('engram')

const BASELINE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT,
  tool_name TEXT
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  project_path TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'note',
  importance REAL NOT NULL DEFAULT 0.5,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_accessed INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  vec_rowid INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  content=memories,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS memory_links (
  source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  similarity REAL NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'semantic',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id);
CREATE INDEX IF NOT EXISTS idx_memories_project_path ON memories(project_path);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_memories_vec_rowid ON memories(vec_rowid);
`

export class DatabaseManager {
  readonly db: Database.Database
  readonly dbPath: string
  vectorsAvailable = false
  lastMigrationResult: MigrationRunResult | null = null

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(paths.data, 'engram.db')
    if (!dbPath) {
      mkdirSync(paths.data, { recursive: true })
    }
    this.db = new Database(this.dbPath)
    this.init()
  }

  private init(): void {
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('foreign_keys = ON')

    this.db.exec(BASELINE_SCHEMA)

    this.lastMigrationResult = runMigrations(this.db, this.dbPath, migrations)

    try {
      sqliteVec.load(this.db)

      const existingVec = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_vectors'")
        .get() as { sql: string } | undefined
      if (existingVec) {
        const dimMatch = existingVec.sql.match(/float\[(\d+)\]/)
        const existingDim = dimMatch ? parseInt(dimMatch[1], 10) : 0
        if (existingDim !== EMBEDDING_DIM) {
          process.stderr.write(
            `Engram: embedding dimension changed ${existingDim}→${EMBEDDING_DIM}, ` +
              `marking ${this.countMemoriesWithVectors()} memory vectors as stale for background re-embed.\n`
          )
          this.db.exec('DROP TABLE memory_vectors')
          this.db.exec("UPDATE memories SET vec_rowid = NULL, embed_state = 'stale' WHERE vec_rowid IS NOT NULL")
        }
      }

      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(embedding float[${EMBEDDING_DIM}])`
      )
      this.vectorsAvailable = true
    } catch {
      process.stderr.write('Engram: sqlite-vec unavailable, using FTS5-only search.\n')
    }
  }

  private countMemoriesWithVectors(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM memories WHERE vec_rowid IS NOT NULL').get() as { n: number }
    return row.n
  }

  close(): void {
    this.db.close()
  }
}

let instance: DatabaseManager | null = null

export function getDatabase(dbPath?: string): DatabaseManager {
  if (!instance) {
    instance = new DatabaseManager(dbPath)
  }
  return instance
}

export function resetDatabase(): void {
  if (instance) {
    instance.close()
    instance = null
  }
}
