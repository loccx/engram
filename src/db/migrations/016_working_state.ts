import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { indexExists, tableExists } from './types.js'

// working state sits beside the memory store, not inside it: tasks are their own table
// so no retrieval path can return half-finished work by similarity, and task_events is
// append-only so every progress claim has an audit trail. no fts or vector index here
// on purpose — the only route from a task into durable memory is the close summary,
// which goes through the normal store.
export const migration016: Migration = {
  version: 16,
  description: 'Add working-state tasks and the append-only task_events log',
  up(db: Database.Database) {
    if (!tableExists(db, 'tasks')) {
      db.exec(`CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        session_id TEXT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        plan_json TEXT NOT NULL DEFAULT '[]',
        progress_json TEXT NOT NULL DEFAULT '[]',
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        open_questions_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      )`)
    }
    if (!indexExists(db, 'idx_tasks_namespace_status')) {
      db.exec('CREATE INDEX idx_tasks_namespace_status ON tasks(namespace, status, updated_at)')
    }
    if (!tableExists(db, 'task_events')) {
      db.exec(`CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        author TEXT,
        created_at INTEGER NOT NULL
      )`)
    }
    if (!indexExists(db, 'idx_task_events_task')) {
      db.exec('CREATE INDEX idx_task_events_task ON task_events(task_id, id)')
    }
  },
}
