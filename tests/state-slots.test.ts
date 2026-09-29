import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type DatabaseType from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { MemoryStore, setStoreEmbedder } from '../src/memory/store.js'
import { EMBEDDING_DIM } from '../src/embeddings/pipeline.js'
import { MemorySearch } from '../src/memory/search.js'
import { advanceStateHead, backfillChainKeys, getState, normalizeStateKey } from '../src/memory/state.js'
import { runMigrations } from '../src/db/migrations/runner.js'
import { migrations } from '../src/db/migrations/index.js'
import { columnExists, indexExists } from '../src/db/migrations/types.js'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'

const NS = '/home/user/state-project'
const TOOL_NS = '/home/user/state-tools'
const DAY = 86_400_000
const T0 = 1_700_000_000_000

function seedSession(db: DatabaseType.Database, id: string, ns: string): void {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    id,
    ns,
    T0
  )
}

function insertRow(
  db: DatabaseType.Database,
  id: string,
  content: string,
  opts: { ns?: string; valid_from?: number; valid_until?: number | null; state_key?: string } = {}
): void {
  const ns = opts.ns ?? NS
  seedSession(db, 'state-session', ns)
  // state_key exists only after migration 017, and the upgrade test seeds rows before it
  const withKey = opts.state_key !== undefined
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags, created_at,
        valid_from, valid_until${withKey ? ', state_key' : ''})
     VALUES (?, 'state-session', ?, ?, ?, 'note', 0.5, '[]', ?, ?, ?${withKey ? ', ?' : ''})`
  ).run(
    id,
    ns,
    ns,
    content,
    opts.valid_from ?? T0,
    opts.valid_from ?? T0,
    opts.valid_until ?? null,
    ...(withKey ? [opts.state_key] : [])
  )
}

// a deterministic bag-of-words embedder, so the write gate runs without the model
function fakeEmbedder(text: string): Promise<Float32Array> {
  const v = new Float32Array(EMBEDDING_DIM)
  for (const token of text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)) {
    let h = 2166136261
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    v[Math.abs(h) % EMBEDDING_DIM] += 1
  }
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return Promise.resolve(v)
}

function supersede(
  db: DatabaseType.Database,
  newerId: string,
  olderId: string,
  at: number,
  confidence = 0.9
): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_links
       (source_id, target_id, similarity, link_type, created_at, confidence, reason, judged_at)
     VALUES (?, ?, 1.0, 'supersedes', ?, ?, 'test', ?)`
  ).run(newerId, olderId, at, confidence, at)
}

describe('state slot keys', () => {
  let db: DatabaseType.Database
  let store: MemoryStore
  let search: MemorySearch

  beforeEach(() => {
    db = createTestDb().db
    store = new MemoryStore(db, false)
    search = new MemorySearch(db, false)
  })

  async function write(content: string, stateKey?: string): Promise<string> {
    const result = await store.store({
      content,
      session_id: 'state-session',
      project_path: NS,
      state_key: stateKey,
    })
    if (result.status === 'rejected') throw new Error(`write refused: ${result.reason}`)
    return result.id
  }

  it('normalizes a key to one slot spelling', () => {
    expect(normalizeStateKey('  Atlas   Deploy Target ')).toBe('atlas deploy target')
    expect(normalizeStateKey('already-normal')).toBe('already-normal')
    expect(normalizeStateKey('   ')).toBeNull()
    expect(normalizeStateKey('x'.repeat(201))).toBeNull()
    expect(normalizeStateKey(undefined)).toBeNull()
  })

  it('retires the previous value when the same key is written again', async () => {
    seedSession(db, 'state-session', NS)
    const first = await write('The atlas deploy target is staging', 'atlas deploy target')
    const second = await write('The atlas deploy target is prod-eu', 'atlas deploy target')

    const old = store.getById(first)!
    expect(old.valid_until).not.toBeNull()
    expect(old.state_key).toBe('atlas deploy target')

    const link = db
      .prepare(
        "SELECT source_id, confidence, judged_at FROM memory_links WHERE link_type = 'supersedes' AND target_id = ?"
      )
      .get(first) as { source_id: string; confidence: number; judged_at: number } | undefined
    expect(link?.source_id).toBe(second)
    expect(link?.confidence).toBe(1)

    const served = await search.hybridSearch('atlas deploy target', {
      project_path: NS,
      limit: 10,
      touch: false,
    })
    expect(served.map((m) => m.id)).toEqual([second])

    const audit = await search.hybridSearch('atlas deploy target', {
      project_path: NS,
      limit: 10,
      touch: false,
      include_superseded: true,
    })
    expect(new Set(audit.map((m) => m.id))).toEqual(new Set([first, second]))
  })

  it('reads the current value with the value it replaced', async () => {
    seedSession(db, 'state-session', NS)
    const first = await write('The atlas deploy target is staging', 'atlas deploy target')
    const second = await write('The atlas deploy target is prod-eu', 'atlas deploy target')

    const view = getState(db, { namespace: NS, key: 'atlas deploy target' })
    expect(view.slots).toHaveLength(1)
    const slot = view.slots[0]
    expect(slot.current?.memory_id).toBe(second)
    expect(slot.prior?.memory_id).toBe(first)
    expect(slot.prior?.superseded_by).toBe(second)
    expect(slot.prior?.superseded_at).not.toBeNull()
    expect(slot.versions).toBe(2)
    expect(slot.trajectory).toBeUndefined()
  })

  it('keeps every value in the trajectory when asked', async () => {
    seedSession(db, 'state-session', NS)
    const first = await write('The atlas deploy target is staging', 'atlas deploy target')
    const second = await write('The atlas deploy target is prod-eu', 'atlas deploy target')

    const slot = getState(db, {
      namespace: NS,
      key: 'atlas deploy target',
      include_superseded: true,
    }).slots[0]
    expect(slot.trajectory?.map((e) => e.memory_id)).toEqual([first, second])
    expect(slot.trajectory?.[0].valid_until).not.toBeNull()
    expect(slot.trajectory?.[0].reason).toBe('state key update')
    expect(slot.trajectory?.[1].current).toBe(true)

    expect(store.getById(first)).not.toBeNull()
    const history = store.getHistory(second)
    expect(new Set(history?.versions.map((v) => v.id))).toEqual(new Set([first, second]))
    expect(history?.links).toHaveLength(1)
  })

  it('answers as-of reads with the value that was current then', async () => {
    seedSession(db, 'state-session', NS)
    const first = await write('The atlas deploy target is staging', 'atlas deploy target')
    const beforeSecond = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await write('The atlas deploy target is prod-eu', 'atlas deploy target')
    const afterSecond = Date.now()

    const past = getState(db, { namespace: NS, key: 'atlas deploy target', as_of: beforeSecond })
    expect(past.slots[0].current?.memory_id).toBe(first)
    expect(past.slots[0].current?.superseded_at).toBeNull()

    const present = getState(db, { namespace: NS, key: 'atlas deploy target', as_of: afterSecond + DAY })
    expect(present.slots[0].current?.memory_id).toBe(second)
  })

  it('walks to a successor that does not carry the key itself', async () => {
    seedSession(db, 'state-session', NS)
    const keyed = await write('The atlas deploy target is staging', 'atlas deploy target')
    const adjudicated = await write('The atlas deploy target is prod-us')
    db.prepare('UPDATE memories SET valid_until = ? WHERE id = ?').run(T0 + DAY, keyed)
    supersede(db, adjudicated, keyed, T0 + DAY)

    const slot = getState(db, { namespace: NS, key: 'atlas deploy target', include_superseded: true })
      .slots[0]
    expect(slot.current?.memory_id).toBe(adjudicated)
    expect(slot.current?.keyed).toBe(false)
    expect(slot.prior?.memory_id).toBe(keyed)
    expect(slot.prior?.keyed).toBe(true)
  })

  it('reports no current value once the head is gone, without losing the values', async () => {
    seedSession(db, 'state-session', NS)
    const first = await write('The atlas deploy target is staging', 'atlas deploy target')
    // a real gap, so the retired window closes strictly before the read clock
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await write('The atlas deploy target is prod-eu', 'atlas deploy target')
    store.delete(second)

    const slot = getState(db, { namespace: NS, key: 'atlas deploy target', include_superseded: true })
      .slots[0]
    expect(slot.current).toBeNull()
    expect(slot.prior?.memory_id).toBe(first)
    expect(slot.trajectory).toHaveLength(1)
  })

  it('lists the slots of a namespace with no key filter', async () => {
    seedSession(db, 'state-session', NS)
    await write('The atlas deploy target is staging', 'atlas deploy target')
    await write('The orbit cache ttl is fifteen minutes', 'orbit cache ttl')

    const view = getState(db, { namespace: NS })
    expect(view.key).toBeNull()
    expect(view.slots.map((s) => s.key).sort()).toEqual(['atlas deploy target', 'orbit cache ttl'])
    expect(getState(db, { namespace: '/home/user/other' }).slots).toEqual([])
  })

  it('leaves an unkeyed write out of the slot model', async () => {
    seedSession(db, 'state-session', NS)
    await write('A note with no slot')
    expect(getState(db, { namespace: NS }).slots).toEqual([])
  })

  it('retires the head through advanceStateHead alone', async () => {
    seedSession(db, 'state-session', NS)
    const first = await write('The atlas deploy target is staging', 'atlas deploy target')
    const now = Date.now() + DAY
    insertRow(db, 'manual-head', 'The atlas deploy target is prod-eu', {
      state_key: 'atlas deploy target',
      valid_from: now,
    })
    const result = advanceStateHead(db, {
      namespace: NS,
      key: 'atlas deploy target',
      memoryId: 'manual-head',
      now,
    })
    expect(result.superseded_id).toBe(first)
    expect(store.getById(first)!.valid_until).toBe(now)
  })

  it('adopts the key of a merged duplicate instead of moving it', async () => {
    const { db: gatedDb, vectorsAvailable } = createTestDb()
    seedSession(gatedDb, 'state-session', NS)
    setStoreEmbedder(fakeEmbedder)
    try {
      const gated = new MemoryStore(gatedDb, vectorsAvailable)
      const existing = await gated.store({
        content: 'The atlas deploy target is staging',
        session_id: 'state-session',
        project_path: NS,
      })
      expect(existing.status).toBe('stored')
      const merged = await gated.store({
        content: 'The atlas deploy target is staging',
        session_id: 'state-session',
        project_path: NS,
        state_key: 'atlas deploy target',
      })
      expect(merged.status).toBe('deduplicated')
      expect(gated.getById(existing.id)!.state_key).toBe('atlas deploy target')

      // the second write to the same key retires the merged head, not the other way round
      const next = await gated.store({
        content: 'The atlas deploy target is prod-eu, which is a different sentence',
        session_id: 'state-session',
        project_path: NS,
        state_key: 'atlas deploy target',
      })
      expect(next.status).toBe('stored')
      expect(gated.getById(existing.id)!.valid_until).not.toBeNull()
    } finally {
      setStoreEmbedder(null)
    }
  })
})

describe('migration 017', () => {
  it('adds the slot column and index on a fresh database', () => {
    const db = createTestDb().db
    expect(columnExists(db, 'memories', 'state_key')).toBe(true)
    expect(indexExists(db, 'idx_memories_state_key')).toBe(true)
    const applied = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    expect(applied.map((row) => row.version)).toContain(17)
  })

  it('backfills an existing supersession chain when upgrading from 015', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-state-migration-'))
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, summary TEXT, tool_name TEXT);
        CREATE TABLE memories (
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
        CREATE TABLE memory_links (
          source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          similarity REAL NOT NULL,
          link_type TEXT NOT NULL DEFAULT 'semantic',
          created_at INTEGER NOT NULL,
          PRIMARY KEY (source_id, target_id)
        );
      `)

      const upToFifteen = migrations.filter((m) => m.version <= 15)
      const first = runMigrations(db, dbPath, upToFifteen, () => undefined)
      expect(first.finalVersion).toBe(15)
      expect(columnExists(db, 'memories', 'state_key')).toBe(false)

      seedSession(db, 'legacy-session', NS)
      insertRow(db, 'legacy-v1', 'The atlas deploy target is staging', { valid_from: T0 })
      insertRow(db, 'legacy-v2', 'The atlas deploy target is prod-eu', { valid_from: T0 + DAY })
      insertRow(db, 'legacy-v3', 'The atlas deploy target is prod-us', { valid_from: T0 + 2 * DAY })
      db.prepare('UPDATE memories SET valid_until = ? WHERE id = ?').run(T0 + DAY, 'legacy-v1')
      db.prepare('UPDATE memories SET valid_until = ? WHERE id = ?').run(T0 + 2 * DAY, 'legacy-v2')
      supersede(db, 'legacy-v2', 'legacy-v1', T0 + DAY)
      supersede(db, 'legacy-v3', 'legacy-v2', T0 + 2 * DAY)

      const upgrade = runMigrations(db, dbPath, migrations, () => undefined)
      expect(upgrade.applied.map((m) => m.version)).toContain(17)
      expect(columnExists(db, 'memories', 'state_key')).toBe(true)

      const keys = db
        .prepare("SELECT id, state_key FROM memories WHERE state_key IS NOT NULL ORDER BY id")
        .all() as Array<{ id: string; state_key: string }>
      expect(keys.map((r) => r.id)).toEqual(['legacy-v1', 'legacy-v2', 'legacy-v3'])
      expect(new Set(keys.map((r) => r.state_key))).toEqual(new Set(['chain:legacy-v1']))

      const slot = getState(db, {
        namespace: NS,
        key: 'chain:legacy-v1',
        include_superseded: true,
      }).slots[0]
      expect(slot.current?.memory_id).toBe('legacy-v3')
      expect(slot.prior?.memory_id).toBe('legacy-v2')
      expect(slot.trajectory).toHaveLength(3)
      expect(slot.prior?.valid_from).toBe(T0 + DAY)

      // idempotent: a second pass renames nothing and adds nothing
      const again = backfillChainKeys(db)
      expect(again).toEqual({ chains: 0, rows: 0 })
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps an explicit key when a chain has one', () => {
    const db = createTestDb().db
    seedSession(db, 'state-session', NS)
    insertRow(db, 'keyed-head', 'The atlas deploy target is prod-eu', {
      valid_from: T0 + DAY,
      state_key: 'atlas deploy target',
    })
    insertRow(db, 'plain-old', 'The atlas deploy target is staging', { valid_from: T0 })
    supersede(db, 'keyed-head', 'plain-old', T0 + DAY)
    expect(backfillChainKeys(db)).toEqual({ chains: 0, rows: 0 })
    expect(getState(db, { namespace: NS }).slots.map((s) => s.key)).toEqual(['atlas deploy target'])
  })
})

describe('state tools', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  function parse<T>(result: { content: Array<{ text: string }>; isError?: boolean }): T {
    return JSON.parse(result.content[0].text) as T
  }

  async function storeTool(content: string, opts: Record<string, unknown> = {}): Promise<string> {
    const result = parse<{ id: string; state_key?: string; error?: string }>(
      await handleTool('store_memory', { content, project_path: TOOL_NS, ...opts })
    )
    if (result.error) throw new Error(result.error)
    return result.id
  }

  it('advertises and honours state_key on store_memory', async () => {
    const first = await storeTool('The atlas deploy target is staging', {
      state_key: '  Atlas Deploy Target ',
    })
    const second = await storeTool('The atlas deploy target is prod-eu', {
      state_key: 'atlas deploy target',
    })
    expect(first).not.toBe(second)

    const state = parse<{
      slots: Array<{
        key: string
        current: { memory_id: string } | null
        prior: { memory_id: string } | null
        versions: number
      }>
    }>(await handleTool('get_state', { project_path: TOOL_NS, key: 'ATLAS deploy target' }))

    expect(state.slots).toHaveLength(1)
    expect(state.slots[0].key).toBe('atlas deploy target')
    expect(state.slots[0].current?.memory_id).toBe(second)
    expect(state.slots[0].prior?.memory_id).toBe(first)
  })

  it('rejects a key that cannot name a slot', async () => {
    const result = await handleTool('get_state', { project_path: TOOL_NS, key: '   ' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('key')
  })

  it('keeps a revision in its slot and tracks the head', async () => {
    const first = await storeTool('The atlas deploy target is staging', {
      state_key: 'atlas deploy target',
    })
    const revised = parse<{ id: string }>(
      await handleTool('revise_memory', {
        id: first,
        content: 'The atlas deploy target is prod-eu',
        project_path: TOOL_NS,
      })
    )
    const state = parse<{
      slots: Array<{ current: { memory_id: string } | null; versions: number }>
    }>(await handleTool('get_state', { project_path: TOOL_NS, key: 'atlas deploy target' }))
    expect(state.slots[0].current?.memory_id).toBe(revised.id)
    expect(state.slots[0].versions).toBe(2)
  })

  it('lists every slot in the namespace', async () => {
    await storeTool('The atlas deploy target is staging', { state_key: 'atlas deploy target' })
    await storeTool('The orbit cache ttl is fifteen minutes', { state_key: 'orbit cache ttl' })
    await storeTool('A note with no slot')

    const state = parse<{ slots: Array<{ key: string }> }>(
      await handleTool('get_state', { project_path: TOOL_NS })
    )
    expect(state.slots.map((s) => s.key).sort()).toEqual(['atlas deploy target', 'orbit cache ttl'])
  })

  it('serves the current-state section from get_context', async () => {
    await storeTool('The atlas deploy target is staging', { state_key: 'atlas deploy target' })
    const second = await storeTool('The atlas deploy target is prod-eu', {
      state_key: 'atlas deploy target',
    })

    const result = parse<{
      state?: Array<{ key: string; current: { id: string; value: string } | null }>
    }>(await handleTool('get_context', { project_path: TOOL_NS }))

    expect(result.state).toHaveLength(1)
    expect(result.state?.[0].key).toBe('atlas deploy target')
    expect(result.state?.[0].current?.id).toBe(second)
    expect(result.state?.[0].current?.value).toContain('prod-eu')

    const scoped = parse<{ state?: unknown[] }>(
      await handleTool('get_context', { project_path: TOOL_NS, query: 'atlas deploy target' })
    )
    expect(scoped.state).toHaveLength(1)
  })

  it('reads the value that was current at as_of', async () => {
    const first = await storeTool('The atlas deploy target is staging', {
      state_key: 'atlas deploy target',
    })
    const cutoff = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await storeTool('The atlas deploy target is prod-eu', { state_key: 'atlas deploy target' })

    const state = parse<{ slots: Array<{ current: { memory_id: string } | null }> }>(
      await handleTool('get_state', { project_path: TOOL_NS, key: 'atlas deploy target', as_of: cutoff })
    )
    expect(state.slots[0].current?.memory_id).toBe(first)
  })

  it('exposes the trajectory with include_superseded', async () => {
    await storeTool('The atlas deploy target is staging', { state_key: 'atlas deploy target' })
    await storeTool('The atlas deploy target is prod-eu', { state_key: 'atlas deploy target' })

    const state = parse<{ slots: Array<{ trajectory?: Array<{ content: string }> }> }>(
      await handleTool('get_state', {
        project_path: TOOL_NS,
        key: 'atlas deploy target',
        include_superseded: true,
      })
    )
    expect(state.slots[0].trajectory).toHaveLength(2)
  })
})
