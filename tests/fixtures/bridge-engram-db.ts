import Database from 'better-sqlite3'
import { migrations } from '../../src/db/migrations/index.js'
import { EngramSourcePort, ENGRAM_SOURCE_PROVIDER } from '../../src/bridge/adapters/index.js'
import type { CallerScope, Verb } from '../../src/memory/access.js'
import type { SourceLocator, SourceReadResult, SourceSnapshot } from '../../src/bridge/index.js'
import { FixtureClock } from './bridge-core-ports.js'

// in-memory source DB only: explicit inert identities/content, no auth tokens, source manager,
// embeddings, live store, credential helper, network client or maintenance worker is opened.
// baseline source tables mirror db/init.ts; the real migrations supply the current schema,
// including state_key, lifecycle, principals/grants, evidence, epochs and bridge persistence.
export const engramNamespace = '/fixture/engram'
export const engramLocator: SourceLocator = { provider: ENGRAM_SOURCE_PROVIDER, namespace: engramNamespace, sourceId: 'inert-memory' }
export const inertAlice = 'inert-principal-alice'
export const inertBob = 'inert-principal-bob'

export function engramFixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, summary TEXT, tool_name TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      project_path TEXT NOT NULL, content TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'note',
      importance REAL NOT NULL DEFAULT 0.5, tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
      last_accessed INTEGER, access_count INTEGER NOT NULL DEFAULT 0, vec_rowid INTEGER);
    CREATE TABLE memory_links (source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, similarity REAL NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'semantic', created_at INTEGER NOT NULL, PRIMARY KEY(source_id, target_id));
    CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, content=memories, content_rowid=rowid);
    CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags) VALUES(new.rowid, new.content, new.tags); END;
    CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags); END;
    CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
      INSERT INTO memories_fts(rowid, content, tags) VALUES(new.rowid, new.content, new.tags); END;
    CREATE TABLE engram_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE engram_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
      hit INTEGER NOT NULL DEFAULT 0, tokens_served INTEGER NOT NULL DEFAULT 0, result_count INTEGER NOT NULL DEFAULT 0,
      namespace TEXT, created_at INTEGER NOT NULL);
  `)
  for (const migration of migrations) migration.up(db)
  const clock = new FixtureClock()
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)')
    .run('inert-session', engramNamespace, 1)
  for (const id of [inertAlice, inertBob]) {
    db.prepare('INSERT INTO principals (id, name, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(id, id, 'agent', 1)
    db.prepare('INSERT INTO grants (principal_id, namespace_prefix, verbs, created_at) VALUES (?, ?, ?, ?)')
      .run(id, engramNamespace, 'read,share', 1)
  }
  const caller: CallerScope = { principalId: inertAlice, name: 'inert display name', localOwner: false,
    grants: [{ prefix: engramNamespace, verbs: ['read', 'share'] }] }
  seedMemory(db)
  seedEpisode(db)
  linkEpisode(db, 'inert-episode')
  const source = new EngramSourcePort(db, { caller, now: clock.now })
  return { db, clock, caller, source }
}
export type EngramFixture = ReturnType<typeof engramFixture>

export function seedMemory(db: Database.Database, input: {
  id?: string; namespace?: string; content?: string; owner?: string | null;
  visibility?: string | null; shareable?: number; archivedAt?: number | null;
} = {}) {
  const id = input.id ?? engramLocator.sourceId
  db.prepare(`INSERT INTO memories (id, session_id, project_path, namespace, content, tags, created_at,
    valid_from, origin, state_key, owner_principal, visibility, shareable, archived_at)
    VALUES (?, 'inert-session', ?, ?, ?, ?, 1, 1, 'mcp', 'inert state slot', ?, ?, ?, ?)`)
    .run(id, input.namespace ?? engramNamespace, input.namespace ?? engramNamespace, input.content ?? 'curated inert Engram content',
      JSON.stringify(['inert', 'bridge']), input.owner === undefined ? inertAlice : input.owner,
      input.visibility === undefined ? 'project' : input.visibility, input.shareable ?? 1, input.archivedAt ?? null)
  return id
}
export function seedEpisode(db: Database.Database, input: {
  id?: string; namespace?: string; content?: string; uri?: string | null;
  owner?: string | null; visibility?: string; expiresAt?: number | null;
} = {}) {
  const id = input.id ?? 'inert-episode'
  db.prepare(`INSERT INTO episodes (id, namespace, session_id, source, external_id, ingested_at,
    content, uri, owner_principal, visibility, expires_at) VALUES (?, ?, 'inert-session', 'inert-evidence', ?, 1, ?, ?, ?, ?, ?)`)
    .run(id, input.namespace ?? engramNamespace, id, input.content ?? 'inert episode evidence', input.uri ?? null,
      input.owner === undefined ? inertAlice : input.owner, input.visibility ?? 'project', input.expiresAt ?? null)
  return id
}
export function linkEpisode(db: Database.Database, id: string, start: number | null = null, end: number | null = null) {
  db.prepare('INSERT INTO memory_episodes(memory_id, episode_id, span_start, span_end, created_at) VALUES (?, ?, ?, ?, 1)')
    .run(engramLocator.sourceId, id, start, end)
}
export function setVerbs(f: EngramFixture, verbs: Verb[]) {
  f.db.prepare('UPDATE grants SET verbs = ? WHERE principal_id = ?').run(verbs.join(','), inertAlice)
}
export function supersede(f: EngramFixture, successor: string, predecessor = engramLocator.sourceId) {
  f.db.prepare(`INSERT INTO memory_links(source_id, target_id, similarity, link_type, created_at, confidence, revision)
    VALUES (?, ?, 1, 'supersedes', ?, 1, 2)`).run(successor, predecessor, f.clock.time)
}
export function available(result: SourceReadResult): SourceSnapshot {
  if (result.status !== 'available') throw new Error(`expected available, got ${result.status}`)
  return result.snapshot
}
