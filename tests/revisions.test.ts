import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { MemoryStore } from '../src/memory/store.js'
import { getDigest, refreshDigest } from '../src/memory/digest.js'
import { resetLlmConfigForTests } from '../src/llm/client.js'

const SESSION = 'rev-session-001'
const NS = '/home/user/revisions-project'

function seedSession(db: Database.Database): void {
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    SESSION,
    NS,
    Date.now()
  )
}

function storeMemory(store: MemoryStore, content: string, opts: Record<string, unknown> = {}) {
  return store.store({
    content,
    session_id: SESSION,
    project_path: NS,
    origin: 'mcp',
    ...opts,
  })
}

function eventRows(db: Database.Database, memoryId: string) {
  return db
    .prepare('SELECT event_type, payload FROM memory_events WHERE memory_id = ? ORDER BY id')
    .all(memoryId) as Array<{ event_type: string; payload: string | null }>
}

describe('append-only revisions', () => {
  let db: Database.Database
  let store: MemoryStore

  beforeEach(() => {
    delete process.env.ENGRAM_LLM_BASE_URL
    delete process.env.ENGRAM_LLM_API_KEY
    delete process.env.ENGRAM_LLM_MODEL
    resetLlmConfigForTests()
    const testDb = createTestDb()
    db = testDb.db
    store = new MemoryStore(db, false)
    seedSession(db)
  })
  afterEach(() => {
    delete process.env.ENGRAM_LLM_BASE_URL
    delete process.env.ENGRAM_LLM_API_KEY
    delete process.env.ENGRAM_LLM_MODEL
    resetLlmConfigForTests()
    vi.restoreAllMocks()
  })

  it('creates a new row, hides the predecessor, preserves content immutably', async () => {
    const original = await storeMemory(store, 'Deploy from the release branch', {
      tags: ['deploy'],
      importance: 0.9,
    })

    const result = await store.revise({
      id: original.id,
      content: 'Deploy from the main branch only',
      reason: 'branch renamed',
    })
    expect(result).not.toBeNull()
    expect(result!.id).not.toBe(original.id)
    expect(result!.previous_id).toBe(original.id)
    expect(result!.version).toBe(2)

    // Original row is untouched (append-only, no in-place content edit).
    const originalRow = db.prepare('SELECT content, tags FROM memories WHERE id = ?').get(original.id) as {
      content: string
      tags: string
    }
    expect(originalRow.content).toBe('Deploy from the release branch')
    expect(JSON.parse(originalRow.tags)).toEqual(['deploy'])

    // New row inherits importance/tags and is linked via confidence=1 supersedes.
    const link = db
      .prepare(
        "SELECT confidence, reason, revision, link_type, decider_model FROM memory_links WHERE source_id = ? AND target_id = ?"
      )
      .get(result!.id, original.id) as {
        confidence: number
        reason: string
        revision: number
        link_type: string
        decider_model: string
      }
    expect(link.link_type).toBe('supersedes')
    expect(link.confidence).toBe(1.0)
    expect(link.revision).toBe(2)
    expect(link.decider_model).toBe('manual')
    expect(link.reason).toBe('branch renamed')
    expect(result!.memory.importance).toBe(0.9)
    expect(result!.memory.tags).toEqual(['deploy'])

    // Predecessor hidden by default, visible with include_superseded.
    const defaultList = store.list({ project_path: NS })
    expect(defaultList.map((m) => m.id)).toContain(result!.id)
    expect(defaultList.map((m) => m.id)).not.toContain(original.id)
    const withSuperseded = store.list({ project_path: NS, include_superseded: true })
    expect(withSuperseded.map((m) => m.id)).toEqual(
      expect.arrayContaining([result!.id, original.id])
    )
  })

  it('closes predecessor validity and keeps the earliest close on repeat revisions', async () => {
    const v1 = await storeMemory(store, 'Fact version one')
    const before = Date.now() - 50_000
    db.prepare('UPDATE memories SET valid_until = ? WHERE id = ?').run(before, v1.id)

    const v2 = await store.revise({ id: v1.id, content: 'Fact version two' })
    const closed = db
      .prepare('SELECT valid_until FROM memories WHERE id = ?')
      .get(v1.id) as { valid_until: number }
    expect(closed.valid_until).toBe(before) // never moves an earlier close
    expect(v2).not.toBeNull()
  })

  it('writes atomic audit events and preserves them across forget_memory', async () => {
    const original = await storeMemory(store, 'Audit me')
    const createdEvents = eventRows(db, original.id)
    expect(createdEvents.map((e) => e.event_type)).toContain('created')
    expect(createdEvents[0].payload).toContain('note')

    await store.revise({ id: original.id, content: 'Audit me, revised' })
    const supersededEvent = eventRows(db, original.id).find((e) => e.event_type === 'superseded')
    expect(supersededEvent).toBeTruthy()
    expect(JSON.parse(supersededEvent!.payload ?? '{}').superseded_by).toBeTruthy()

    // forget_memory must NOT cascade away the audit trail.
    const deleted = store.delete(original.id)
    expect(deleted).toBe(true)
    const afterDelete = eventRows(db, original.id)
    expect(afterDelete.map((e) => e.event_type)).toContain('deleted')
    expect(afterDelete.map((e) => e.event_type)).toContain('superseded')
    // deleted payload is metadata-only: hash + length, never raw content.
    const deletedPayload = JSON.parse(
      afterDelete.find((e) => e.event_type === 'deleted')!.payload ?? '{}'
    )
    expect(deletedPayload).toHaveProperty('content_sha256')
    expect(deletedPayload).toHaveProperty('content_chars')
    expect(JSON.stringify(deletedPayload)).not.toContain('Audit me')
  })

  it('returns ordered chain history with versions and links', async () => {
    const T0 = Date.now() - 10_000
    const v1 = await storeMemory(store, 'History v1')
    db.prepare('UPDATE memories SET created_at = ?, valid_from = ? WHERE id = ?').run(T0, T0, v1.id)
    const r1 = await store.revise({ id: v1.id, content: 'History v2' })
    db.prepare('UPDATE memories SET created_at = ?, valid_from = ? WHERE id = ?').run(T0 + 1_000, T0 + 1_000, r1!.id)
    const r2 = await store.revise({ id: r1!.id, content: 'History v3' })
    db.prepare('UPDATE memories SET created_at = ?, valid_from = ? WHERE id = ?').run(T0 + 2_000, T0 + 2_000, r2!.id)

    const history = store.getHistory(r2!.id)!
    expect(history.versions.map((m) => m.id)).toEqual([v1.id, r1!.id, r2!.id])
    expect(history.versions.map((m) => m.content)).toEqual([
      'History v1',
      'History v2',
      'History v3',
    ])
    expect(history.links.length).toBe(2)
    expect(r2!.version).toBe(3)

    // Any chain member works as an entry point.
    expect(store.getHistory(v1.id)!.versions.length).toBe(3)
  })

  it('as_of on history returns the historical chain view', async () => {
    const T0 = Date.now() - 60_000
    const v1 = await storeMemory(store, 'asof v1')
    db.prepare('UPDATE memories SET valid_from = ?, created_at = ? WHERE id = ?').run(T0, T0, v1.id)
    const r1 = await store.revise({ id: v1.id, content: 'asof v2' })
    db.prepare('UPDATE memories SET valid_from = ?, created_at = ? WHERE id = ?').run(T0 + 10_000, T0 + 10_000, r1!.id)
    const latest = await store.revise({ id: r1!.id, content: 'asof v3' })
    db.prepare('UPDATE memories SET valid_from = ?, created_at = ? WHERE id = ?').run(T0 + 20_000, T0 + 20_000, latest!.id)

    // Historical view at a moment between v1 and v2: v1 was closed by the
    // first revision, v2/v3 did not exist yet, so only v1 is valid.
    const past = store.getHistory(latest!.id, {
      as_of: T0 + 2_000,
    })
    expect(past!.versions.map((m) => m.id)).toEqual([v1.id])

    // Without as_of the full chain returns oldest-first.
    const full = store.getHistory(latest!.id)
    expect(full!.versions.map((m) => m.id)).toEqual([v1.id, r1!.id, latest!.id])
  })

  it('transfers the pin safely so digest refreshes to current content', async () => {
    const pinned = await storeMemory(store, 'Pinned original fact')
    db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run(pinned.id)
    await refreshDigest(db, NS)
    expect(getDigest(db, NS)).toContain('Pinned original fact')

    const revised = await store.revise({ id: pinned.id, content: 'Pinned corrected fact' })
    expect(revised).not.toBeNull()

    // Pin moved to the revision; predecessor unpinned (digest must not serve
    // the retired content).
    const prevRow = db.prepare('SELECT pinned FROM memories WHERE id = ?').get(pinned.id) as { pinned: number }
    const newRow = db.prepare('SELECT pinned FROM memories WHERE id = ?').get(revised!.id) as { pinned: number }
    expect(prevRow.pinned).toBe(0)
    expect(newRow.pinned).toBe(1)

    const refreshed = await refreshDigest(db, NS)
    expect(refreshed.content).toContain('Pinned corrected fact')
    expect(refreshed.content).not.toContain('Pinned original fact')
    expect(refreshed.changed).toBe(true)
  })

  it('never inherits shareable without explicit opt-in', async () => {
    const original = await storeMemory(store, 'Secret deployment procedure')
    db.prepare('UPDATE memories SET shareable = 1 WHERE id = ?').run(original.id)

    const inherited = await store.revise({ id: original.id, content: 'Secret procedure v2' })
    const inheritedRow = db
      .prepare('SELECT shareable FROM memories WHERE id = ?')
      .get(inherited!.id) as { shareable: number }
    expect(inheritedRow.shareable).toBe(0) // NOT inherited

    const optedIn = await store.revise({
      id: inherited!.id,
      content: 'Secret procedure v3',
      shareable: true,
    })
    const optedRow = db
      .prepare('SELECT shareable FROM memories WHERE id = ?')
      .get(optedIn!.id) as { shareable: number }
    expect(optedRow.shareable).toBe(1) // explicit opt-in only
  })

  it('is atomic: a failing revision leaves no partial state', async () => {
    const original = await storeMemory(store, 'Atomicity check')
    const before = db
      .prepare('SELECT id, content, pinned, valid_until FROM memories WHERE id = ?')
      .get(original.id)

    // A revision with a session_id that violates the FK must fail wholesale.
    const result = await store
      .revise({ id: original.id, content: 'must not land', session_id: 'no-such-session' })
      .then((r) => ({ ok: true, r }))
      .catch(() => ({ ok: false, r: null }))
    expect(result.ok).toBe(false)

    const counts = (
      db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content = 'must not land'").get() as { n: number }
    ).n
    expect(counts).toBe(0)
    const after = db
      .prepare('SELECT id, content, pinned, valid_until FROM memories WHERE id = ?')
      .get(original.id)
    expect(after).toEqual(before)
    const linkCount = (
      db.prepare("SELECT COUNT(*) AS n FROM memory_links WHERE link_type = 'supersedes'").get() as { n: number }
    ).n
    expect(linkCount).toBe(0)
  })

  it('update_memory stays metadata-only (no content change, no supersede)', async () => {
    const original = await storeMemory(store, 'Metadata target content')
    const updated = store.update(original.id, { type: 'gotcha', importance: 0.8 })
    expect(updated).toBe(true)

    const row = db.prepare('SELECT content, type, importance FROM memories WHERE id = ?').get(original.id) as {
      content: string
      type: string
      importance: number
    }
    expect(row.content).toBe('Metadata target content')
    expect(row.type).toBe('gotcha')
    expect(row.importance).toBe(0.8)
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(1)
    expect(store.getHistory(original.id)!.links.length).toBe(0)

    const events = eventRows(db, original.id)
    expect(events.map((e) => e.event_type)).toContain('updated')
  })

  it('records origin with a safe legacy default on pre-008 rows and per-new-row origin', async () => {
    const legacyId = randomUUID()
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
       VALUES (?, ?, ?, ?, 'legacy row', 'note', 0.5, '[]', ?)`
    ).run(legacyId, SESSION, NS, NS, Date.now())
    // Simulate pre-008 write path: origin never set at insert time.
    db.prepare('UPDATE memories SET origin = NULL WHERE id = ?').run(legacyId)

    const legacy = store.getById(legacyId)!
    expect(legacy.origin ?? null).toBeNull() // backfill happens at migration time, not read time

    const fresh = await storeMemory(store, 'fresh row')
    expect(fresh.origin).toBe('mcp')
  })

  it('revision inherits namespace/project_path and lands in the same scope', async () => {
    const original = await storeMemory(store, 'Scoped fact')
    const revised = await store.revise({ id: original.id, content: 'Scoped fact v2' })
    expect(revised!.memory.project_path).toBe(NS)
    const scopeList = store.list({ project_path: NS })
    expect(scopeList.map((m) => m.id)).toContain(revised!.id)
  })

  it('revise emits a coherent revised event on the new row', async () => {
    const original = await storeMemory(store, 'Revise event v1')
    const result = await store.revise({ id: original.id, content: 'Revise event v2' })
    expect(result).not.toBeNull()

    const events = eventRows(db, result!.id)
    const revised = events.find((e) => e.event_type === 'revised')
    expect(revised).toBeTruthy()
    expect(JSON.parse(revised!.payload ?? '{}')).toMatchObject({
      previous_id: original.id,
      revision: 2,
    })
  })

  it('update_memory writes no fabricated events for missing ids or no-op patches', async () => {
    const original = await storeMemory(store, 'Event hygiene target')
    const before = eventRows(db, original.id)

    // Identical values: no mutation, no event.
    expect(store.update(original.id, { type: original.type, importance: original.importance })).toBe(false)
    expect(eventRows(db, original.id).length).toBe(before.length)

    // Missing id: false, and never a fabricated no-id event.
    expect(store.update('no-such-id', { type: 'gotcha' })).toBe(false)
    const noSuchCount = (
      db.prepare("SELECT COUNT(*) AS n FROM memory_events WHERE memory_id = 'no-such-id'").get() as { n: number }
    ).n
    expect(noSuchCount).toBe(0)
    expect(eventRows(db, original.id).length).toBe(before.length)

    // A real change writes exactly one updated event with provenance.
    expect(store.update(original.id, { type: 'gotcha' })).toBe(true)
    const afterEvent = (
      db.prepare(
        "SELECT payload, origin, session_id FROM memory_events WHERE memory_id = ? AND event_type = 'updated' ORDER BY id DESC LIMIT 1"
      ).get(original.id) as { payload: string | null; origin: string | null; session_id: string | null } | undefined
    )!
    expect(afterEvent).toBeTruthy()
    expect(JSON.parse(afterEvent.payload ?? '{}').updated_fields).toEqual(['type'])
    expect(afterEvent.origin).toBe('mcp')
    expect(afterEvent.session_id).toBe(SESSION)
  })

  it('setPinned and setValidUntil skip events when the value is unchanged', async () => {
    const original = await storeMemory(store, 'No-op pin target')

    // Unpinned is the default: pinning to false changes nothing.
    expect(store.setPinned(original.id, false)).toBe(false)
    expect(eventRows(db, original.id).map((e) => e.event_type)).not.toContain('pinned')

    expect(store.setPinned(original.id, true)).toBe(true)
    expect(eventRows(db, original.id).map((e) => e.event_type)).toContain('pinned')

    // setValidUntil uses COALESCE: the first call closes the window, later
    // calls are no-ops and must not duplicate events.
    store.setValidUntil(original.id, Date.now() + 1_000)
    const afterFirst = eventRows(db, original.id).filter((e) => e.event_type === 'valid_until_set').length
    expect(afterFirst).toBe(1)

    store.setValidUntil(original.id, Date.now() + 2_000)
    const afterSecond = eventRows(db, original.id).filter((e) => e.event_type === 'valid_until_set').length
    expect(afterSecond).toBe(1)
  })

  it('event writes recover after a transient failure instead of latching off forever', async () => {
    // Simulate a transient audit outage: drop the table mid-life.
    db.exec('DROP TABLE memory_events')
    const original = await storeMemory(store, 'Recovery first write')

    // Restore the exact table; the next event write must succeed.
    db.exec(`CREATE TABLE memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'created', 'revised', 'superseded', 'updated', 'pinned', 'valid_until_set', 'deleted'
      )),
      origin TEXT,
      session_id TEXT,
      occurred_at INTEGER NOT NULL,
      payload TEXT
    )`)
    db.exec(
      'CREATE INDEX idx_memory_events_memory_at ON memory_events(memory_id, occurred_at)'
    )

    const result = await store.revise({ id: original.id, content: 'Recovery second write' })
    expect(result).not.toBeNull()
    const events = eventRows(db, original.id)
    expect(events.map((e) => e.event_type)).toContain('superseded')
    const newEvents = eventRows(db, result!.id)
    expect(newEvents.map((e) => e.event_type)).toContain('created')
    expect(newEvents.map((e) => e.event_type)).toContain('revised')
  })
})
