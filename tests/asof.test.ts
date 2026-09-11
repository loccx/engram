import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { MemoryStore } from '../src/memory/store.js'
import { MemorySearch } from '../src/memory/search.js'

const NS = '/home/user/asof-project'
const T0 = 1_700_000_000_000

function ensureSession(db: Database.Database, sid: string, ns: string): void {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    sid,
    ns,
    T0
  )
}

function insertMemory(
  db: Database.Database,
  id: string,
  content: string,
  opts: { namespace?: string; valid_from?: number; valid_until?: number | null; entity?: string } = {}
): void {
  const ns = opts.namespace ?? NS
  ensureSession(db, 'sess1', ns)
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, valid_until)
     VALUES (?, ?, ?, ?, ?, 'note', 0.5, '[]', ?, ?, ?)`
  ).run(
    id,
    'sess1',
    ns,
    ns,
    content,
    opts.valid_from ?? T0,
    opts.valid_from ?? T0,
    opts.valid_until ?? null
  )
  if (opts.entity) {
    db.prepare(
      "INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at) VALUES (?, ?, 'symbol', ?)"
    ).run(id, opts.entity, T0)
  }
}

function supersedeAt(
  db: Database.Database,
  newerId: string,
  olderId: string,
  judgedAt: number,
  confidence: number = 0.9
): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_links
       (source_id, target_id, similarity, link_type, created_at, confidence, reason, judged_at)
     VALUES (?, ?, 1.0, 'supersedes', ?, ?, 'test', ?)`
  ).run(newerId, olderId, judgedAt, confidence, judgedAt)
}

describe('as_of temporal correctness', () => {
  let db: Database.Database
  let store: MemoryStore
  let search: MemorySearch

  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    store = new MemoryStore(db, false)
    search = new MemorySearch(db, false)
  })

  it('excludes memories whose valid_until is before as_of (full interval predicate)', async () => {
    const expired = randomUUID()
    const alive = randomUUID()
    insertMemory(db, expired, 'kafka expired note', {
      valid_from: T0,
      valid_until: T0 + 1_000,
    })
    insertMemory(db, alive, 'kafka current note', { valid_from: T0 })

    const results = await search.hybridSearch('kafka', {
      project_path: NS,
      as_of: T0 + 5_000,
      touch: false,
    })
    const ids = results.map((r) => r.id)
    expect(ids).toContain(alive)
    expect(ids).not.toContain(expired)
  })

  it('includes a memory only during its validity window (inclusive boundaries)', async () => {
    const windowed = randomUUID()
    insertMemory(db, windowed, 'short-lived fact', {
      valid_from: T0 + 1_000,
      valid_until: T0 + 2_000,
    })

    const before = await search.hybridSearch('short-lived', {
      project_path: NS,
      as_of: T0 + 500,
      touch: false,
    })
    expect(before.map((r) => r.id)).not.toContain(windowed)

    const atStart = await search.hybridSearch('short-lived', {
      project_path: NS,
      as_of: T0 + 1_000,
      touch: false,
    })
    expect(atStart.map((r) => r.id)).toContain(windowed) // valid_from inclusive

    const atEnd = await search.hybridSearch('short-lived', {
      project_path: NS,
      as_of: T0 + 2_000,
      touch: false,
    })
    expect(atEnd.map((r) => r.id)).toContain(windowed) // valid_until inclusive

    const after = await search.hybridSearch('short-lived', {
      project_path: NS,
      as_of: T0 + 2_001,
      touch: false,
    })
    expect(after.map((r) => r.id)).not.toContain(windowed)
  })

  it('returns the historically-current (now-superseded) fact for past as_of', async () => {
    const oldId = randomUUID()
    const newId = randomUUID()
    insertMemory(db, oldId, 'use postgres for production db', { valid_from: T0 })
    insertMemory(db, newId, 'use mysql for production db', { valid_from: T0 + 10_000 })
    supersedeAt(db, newId, oldId, T0 + 5_000)

    const past = await search.hybridSearch('production db', {
      project_path: NS,
      as_of: T0 + 2_000,
      touch: false,
    })
    expect(past.map((r) => r.id)).toContain(oldId) // superseded later, valid then
    expect(past.map((r) => r.id)).not.toContain(newId) // successor not yet created

    const present = await search.hybridSearch('production db', {
      project_path: NS,
      as_of: T0 + 50_000,
      touch: false,
    })
    expect(present.map((r) => r.id)).toContain(newId)
    expect(present.map((r) => r.id)).not.toContain(oldId)
  })

  it('default (no as_of) keeps latest-view semantics unchanged', async () => {
    const oldId = randomUUID()
    const newId = randomUUID()
    insertMemory(db, oldId, 'old deployment fact', { valid_from: T0 })
    insertMemory(db, newId, 'new deployment fact', { valid_from: T0 + 10_000 })
    supersedeAt(db, newId, oldId, T0 + 5_000)

    const results = await search.hybridSearch('deployment fact', {
      project_path: NS,
      touch: false,
    })
    expect(results.map((r) => r.id)).toContain(newId)
    expect(results.map((r) => r.id)).not.toContain(oldId)
  })

  it('legacy before keeps its valid_from-only semantics even across supersession', async () => {
    const oldId = randomUUID()
    const newId = randomUUID()
    insertMemory(db, oldId, 'before-legacy fact', { valid_from: T0 })
    insertMemory(db, newId, 'before-legacy fact two', { valid_from: T0 + 10_000 })
    supersedeAt(db, newId, oldId, T0 + 15_000)

    // `before` = valid_from <= t with PRESENT-state supersession, so the
    // superseded row stays hidden even though there IS a past `before` where
    // it was the current fact — only as_of recovers that view.
    const results = await search.hybridSearch('before-legacy', {
      project_path: NS,
      before: T0 + 20_000,
      touch: false,
    })
    expect(results.map((r) => r.id)).toContain(newId)
    expect(results.map((r) => r.id)).not.toContain(oldId)
  })

  it('applies as_of to get_context', () => {
    const windowed = randomUUID()
    const alive = randomUUID()
    insertMemory(db, windowed, 'expired context fact', {
      valid_from: T0,
      valid_until: T0 + 1_000,
    })
    insertMemory(db, alive, 'live context fact', { valid_from: T0 })

    const past = search.getContext(NS, 10, { as_of: T0 + 500 })
    expect(past.map((m) => m.id)).toContain(windowed)

    const future = search.getContext(NS, 10, { as_of: T0 + 5_000 })
    expect(future.map((m) => m.id)).toContain(alive)
    expect(future.map((m) => m.id)).not.toContain(windowed)
  })

  it('applies as_of to store.list and entity search', () => {
    const gone = randomUUID()
    const stays = randomUUID()
    insertMemory(db, gone, 'retired entity thing', {
      valid_from: T0,
      valid_until: T0 + 1_000,
      entity: 'apiClient',
    })
    insertMemory(db, stays, 'current entity thing', {
      valid_from: T0,
      entity: 'apiClient',
    })

    const listed = store.list({ project_path: NS, as_of: T0 + 5_000 })
    expect(listed.map((m) => m.id)).toContain(stays)
    expect(listed.map((m) => m.id)).not.toContain(gone)

    const entities = store.searchByEntity('apiClient', NS, 10, { as_of: T0 + 5_000 })
    expect(entities.map((m) => m.id)).toContain(stays)
    expect(entities.map((m) => m.id)).not.toContain(gone)
  })

  it('get_memory with as_of resolves only the manual revision chain at link time', () => {
    const oldId = randomUUID()
    const newId = randomUUID()
    insertMemory(db, oldId, 'config default is A', { valid_from: T0, valid_until: T0 + 10_000 })
    insertMemory(db, newId, 'config default is B', { valid_from: T0 + 10_000 })
    // Manual revision edge (revision > 0), judged when the successor was
    // written and the predecessor's window closed.
    db.prepare(
      `INSERT OR IGNORE INTO memory_links
         (source_id, target_id, similarity, link_type, created_at, confidence, reason, judged_at, revision)
       VALUES (?, ?, 1.0, 'supersedes', ?, 1.0, 'manual', ?, 2)`
    ).run(newId, oldId, T0 + 10_000, T0 + 10_000)

    // Entry via the predecessor before the revision link existed: itself.
    const past = store.getByIdAt(oldId, T0 + 5_000)
    expect(past?.id).toBe(oldId)

    // Entry via the predecessor after the revision: the successor (the
    // predecessor's window is closed).
    const present = store.getByIdAt(oldId, T0 + 20_000)
    expect(present?.id).toBe(newId)

    // Entry via the successor before the link was judged: the chain holds
    // only the successor, which is not yet valid — null, never an invented
    // predecessor.
    expect(store.getByIdAt(newId, T0 + 5_000)).toBeNull()
    expect(store.getByIdAt(newId, T0 + 20_000)?.id).toBe(newId)

    // Outside any validity window -> null
    expect(store.getByIdAt(oldId, T0 - 100)).toBeNull()
  })

  it('get_memory with as_of never walks adjudicated (revision=0) supersession edges', () => {
    const original = randomUUID()
    insertMemory(db, original, 'the original fact', { valid_from: T0 })

    // An unrelated memory later adjudicated-supersedes the original. At the
    // moment of the adjudication the original is still valid, so a naive
    // max-valid_from walk would return the FOREIGN memory for getByIdAt,
    // even though it is not part of any manual revision chain.
    const foreign = randomUUID()
    insertMemory(db, foreign, 'unrelated newer fact', { valid_from: T0 + 5_000 })
    supersedeAt(db, foreign, original, T0 + 10_000)

    expect(store.getByIdAt(original, T0 + 6_000)?.id).toBe(original)
    expect(store.getByIdAt(foreign, T0 + 6_000)?.id).toBe(foreign)

    // Present view also stays on the own-chain rows.
    expect(store.getByIdAt(original, T0 + 20_000)?.id).toBe(original)
    expect(store.getByIdAt(foreign, T0 + 20_000)?.id).toBe(foreign)
  })

  it('get_memory with as_of respects revision link time (later edits never leak back)', () => {
    const v1 = randomUUID()
    const v2 = randomUUID()
    const someday = T0 + 40_000
    insertMemory(db, v1, 'version one', { valid_from: T0 })
    insertMemory(db, v2, 'version two', { valid_from: T0 + 30_000 })
    db.prepare(
      `INSERT OR IGNORE INTO memory_links
         (source_id, target_id, similarity, link_type, created_at, confidence, reason, judged_at, revision)
       VALUES (?, ?, 1.0, 'supersedes', ?, 1.0, 'manual', ?, 2)`
    ).run(v2, v1, someday, someday)

    // Before the revision link existed, the chain contains only v2 — and v2
    // is not yet valid, so nothing was current (null, never a made-up v1).
    expect(store.getByIdAt(v2, T0 + 10_000)).toBeNull()
    // After the link was judged, resolution walks v2 -> v1.
    expect(store.getByIdAt(v2, someday + 1_000)?.id).toBe(v2)
  })
})
