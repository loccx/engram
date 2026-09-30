// cold tier: archived rows answer as missing unless a read names them, reading one back
// is a page fault, and every retention/prune decision lands in eviction_events.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { runDuplicatePrune } from '../src/maintenance/prune.js'
import {
  planRetention,
  applyRetention,
  RETENTION_ARCHIVE_REASON,
  RETENTION_CAP_REASON,
} from '../src/maintenance/retention.js'
import {
  evictionMaxRows,
  enforceEvictionRowCap,
  pruneEvictionEvents,
  recordColdFaults,
  summarizeEvictions,
} from '../src/metrics/eviction-log.js'
import { createTestDb } from './helpers.js'

const NS = '/home/user/cold-tier'
const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const OLD = T0 - 100 * DAY

interface ToolResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

function parse<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T
}

function ensureSession(db: Database.Database, id: string, ns: string): void {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    id,
    ns,
    T0
  )
}

function insertMemory(
  db: Database.Database,
  id: string,
  content: string,
  opts: {
    namespace?: string
    importance?: number
    pinned?: boolean
    lastAccessed?: number
    created_at?: number
  } = {}
): void {
  const ns = opts.namespace ?? NS
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags, created_at,
        pinned, access_count, last_accessed)
     VALUES (?, 'sess-1', ?, ?, ?, 'note', ?, '[]', ?, ?, 0, ?)`
  ).run(
    id,
    ns,
    ns,
    content,
    opts.importance ?? 0.5,
    opts.created_at ?? T0,
    opts.pinned ? 1 : 0,
    opts.lastAccessed ?? null
  )
}

interface EventRow {
  ts: number
  namespace: string | null
  memory_id: string
  action: string
  reason: string
  tier: string | null
  job_id: number | null
}

function events(db: Database.Database): EventRow[] {
  return db
    .prepare(
      `SELECT ts, namespace, memory_id, action, reason, tier, job_id
       FROM eviction_events ORDER BY id ASC`
    )
    .all() as EventRow[]
}

function eventFor(db: Database.Database, memoryId: string, action: string): EventRow | undefined {
  return events(db).find((e) => e.memory_id === memoryId && e.action === action)
}

const GOLDEN_GET_MEMORY = {
  project_path: NS,
  namespace: NS,
  content: 'the ledger export runs nightly at 02:00 utc',
  type: 'note',
  importance: 0.5,
  tags: [],
  created_at: T0,
  valid_from: T0,
  valid_until: null,
  procedure_meta: null,
  last_accessed: null,
  access_count: 0,
  vec_rowid: null,
  importance_source: 'default',
  pinned: false,
  origin: 'mcp',
  shareable: false,
  tier: 'warm',
  supersedes_counts: { supersedes: 0, superseded_by: 0 },
  disputed: false,
  conflict_count: 0,
}

const GOLDEN_SEARCH_RESULT = {
  project_path: NS,
  namespace: NS,
  content: 'the ledger export runs nightly at 02:00 utc',
  type: 'note',
  importance: 0.5,
  tags: [],
  created_at: T0,
  valid_from: T0,
  valid_until: null,
  procedure_meta: null,
  last_accessed: T0,
  access_count: 1,
  vec_rowid: null,
  importance_source: 'default',
  pinned: false,
  origin: 'mcp',
  shareable: false,
  relevance: 1,
  degraded: true,
  tier: 'warm',
  supersedes_counts: { supersedes: 0, superseded_by: 0 },
  disputed: false,
  conflict_count: 0,
  score: 0.7154638458203063,
  signal_breakdown: {
    fts: 0.3076923076923077,
    vec: 0,
    recency: 0.23076923076923078,
    access: 0.023156153512613936,
    importance: 0.15384615384615385,
    reranker: 0,
  },
  recall_reason: 'fts',
}

const GOLDEN_MISS = {
  reason:
    'weak result set (1) in /home/user/cold-tier; this scope holds 1, but /home/user holds 1 (3 ancestor scopes checked)',
  scope: NS,
  scope_memories: 1,
  ancestor_scopes: [
    { path: '/home/user', memory_count: 1 },
    { path: '/home', memory_count: 1 },
    { path: '/', memory_count: 1 },
  ],
  memories_in_ancestors: 3,
  nearest_rich_scope: '/home/user',
}

describe('cold-tier reads over mcp', () => {
  let db: Database.Database

  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    db = getDatabase(':memory:').db
    ensureSession(db, 'sess-1', NS)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers the default calls exactly as before the flags existed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const stored = parse<{ id: string }>(
      await handleTool('store_memory', {
        content: 'the ledger export runs nightly at 02:00 utc',
        type: 'note',
        project_path: NS,
      })
    )

    const fetched = parse<Record<string, unknown>>(await handleTool('get_memory', { id: stored.id }))
    const { id: fetchedId, session_id: fetchedSession, ...rest } = fetched
    expect(fetchedId).toBe(stored.id)
    expect(fetchedSession).toBeTruthy()
    // episodes is the cited-evidence list, empty for a memory stored directly
    expect(rest).toEqual({ ...GOLDEN_GET_MEMORY, episodes: [] })

    const searched = parse<{
      namespace: string
      results: Array<Record<string, unknown>>
      miss: unknown
    }>(await handleTool('search_memories', { query: 'ledger export', project_path: NS }))
    expect(searched.namespace).toBe(NS)
    expect(searched.results).toHaveLength(1)
    const { id: resultId, session_id: resultSession, ...resultRest } = searched.results[0]
    expect(resultId).toBe(stored.id)
    expect(resultSession).toBeTruthy()
    expect(resultRest).toEqual(GOLDEN_SEARCH_RESULT)
    expect(searched.miss).toEqual(GOLDEN_MISS)
  })

  it('hides an archived row from get_memory and search, and returns it with include_archived', async () => {
    insertMemory(db, 'retired', 'the ledger export runs nightly at 02:00 utc')
    db.prepare('UPDATE memories SET archived_at = ? WHERE id = ?').run(T0 + 1, 'retired')

    const hidden = (await handleTool('get_memory', { id: 'retired' })) as ToolResult
    expect(hidden.isError).toBe(true)
    expect(parse<{ error: string }>(hidden).error).toBe('Memory retired not found')

    const cold = parse<{ id: string; archived_at: number }>(
      (await handleTool('get_memory', { id: 'retired', include_archived: true })) as ToolResult
    )
    expect(cold.id).toBe('retired')
    expect(cold.archived_at).toBe(T0 + 1)

    const searched = parse<{ results: Array<{ id: string }> }>(
      (await handleTool('search_memories', {
        query: 'ledger export',
        project_path: NS,
      })) as ToolResult
    )
    expect(searched.results).toEqual([])

    // get_related reads its anchor by id and has no cold-tier flag, so it hides it too
    const related = (await handleTool('get_related', { id: 'retired' })) as ToolResult
    expect(related.isError).toBe(true)
    expect(parse<{ error: string }>(related).error).toBe('Memory retired not found')

    const coldSearch = parse<{ results: Array<{ id: string; archived_at: number }> }>(
      (await handleTool('search_memories', {
        query: 'ledger export',
        project_path: NS,
        include_archived: true,
      })) as ToolResult
    )
    expect(coldSearch.results.map((r) => r.id)).toEqual(['retired'])
    expect(coldSearch.results[0].archived_at).toBe(T0 + 1)
  })

  it('does not resurrect an archived row through an include_superseded audit read', async () => {
    insertMemory(db, 'retired', 'a retired fact about the ledger export job')
    db.prepare('UPDATE memories SET archived_at = ? WHERE id = ?').run(T0 + 1, 'retired')

    const audit = parse<{ results: Array<{ id: string }> }>(
      (await handleTool('search_memories', {
        query: 'ledger export',
        project_path: NS,
        include_superseded: true,
      })) as ToolResult
    )
    expect(audit.results).toEqual([])

    const cold = parse<{ results: Array<{ id: string }> }>(
      (await handleTool('search_memories', {
        query: 'ledger export',
        project_path: NS,
        include_superseded: true,
        include_archived: true,
      })) as ToolResult
    )
    expect(cold.results.map((r) => r.id)).toEqual(['retired'])
  })

  it('unarchives through the tool, counts faults and reports them in get_stats', async () => {
    const shared = 'the ledger export job writes one shard per project '
    insertMemory(db, 'keep-me', `${shared}A`)
    insertMemory(db, 'retired', `${shared}B`, { created_at: T0 + 1 })
    expect(runDuplicatePrune(db).archived).toBe(1)
    expect(eventFor(db, 'retired', 'pruned')?.reason).toBe('duplicate_family')

    const beforeUnarchive = parse<{ results: Array<{ id: string }> }>(
      (await handleTool('search_memories', {
        query: 'ledger export',
        project_path: NS,
      })) as ToolResult
    )
    expect(beforeUnarchive.results.map((r) => r.id)).toEqual(['keep-me'])

    // one fault each for a by-id read, a search that serves a cold row, and the restore
    await handleTool('get_memory', { id: 'retired', include_archived: true })
    const coldSearch = parse<{ results: Array<{ id: string }> }>(
      (await handleTool('search_memories', {
        query: 'ledger export',
        project_path: NS,
        include_archived: true,
      })) as ToolResult
    )
    expect(coldSearch.results.map((r) => r.id).sort()).toEqual(['keep-me', 'retired'])

    const restored = parse<{ success: boolean; id: string; memory: { id: string } }>(
      (await handleTool('unarchive_memory', { id: 'retired' })) as ToolResult
    )
    expect(restored.success).toBe(true)
    expect(restored.memory.id).toBe('retired')

    const again = parse<{ success: boolean; reason: string }>(
      (await handleTool('unarchive_memory', { id: 'retired' })) as ToolResult
    )
    expect(again.success).toBe(false)
    expect(again.reason).toBe('not archived')

    const missing = parse<{ success: boolean; reason: string }>(
      (await handleTool('unarchive_memory', { id: 'no-such-row' })) as ToolResult
    )
    expect(missing.reason).toBe('not found')

    const stats = parse<{
      evictions: {
        archived: number
        kept: number
        faults: number
        fault_rate: number | null
        by_action: Record<string, number>
        by_reason: Array<{ action: string; reason: string; count: number }>
      }
    }>(await handleTool('get_stats', { project_path: NS }))

    expect(stats.evictions.archived).toBe(1)
    expect(stats.evictions.kept).toBe(1)
    expect(stats.evictions.faults).toBe(3)
    expect(stats.evictions.fault_rate).toBe(3)
    expect(stats.evictions.by_action).toEqual({ archived: 0, pruned: 1, kept: 1, fault: 3 })
    expect(stats.evictions.by_reason).toEqual(
      expect.arrayContaining([
        { action: 'pruned', reason: 'duplicate_family', count: 1 },
        { action: 'kept', reason: 'family_keeper', count: 1 },
        { action: 'fault', reason: 'read', count: 1 },
        { action: 'fault', reason: 'search', count: 1 },
        { action: 'fault', reason: 'unarchive', count: 1 },
      ])
    )

    // a window with no archives in it reports no faults and no rate, not a division by zero
    const windowed = parse<{
      evictions: { archived: number; faults: number; fault_rate: number | null; by_reason: unknown[] }
    }>(await handleTool('get_stats', { project_path: NS, since: Date.now() + DAY }))
    expect(windowed.evictions.archived).toBe(0)
    expect(windowed.evictions.faults).toBe(0)
    expect(windowed.evictions.fault_rate).toBeNull()
    expect(windowed.evictions.by_reason).toEqual([])

    const afterUnarchive = parse<{ results: Array<{ id: string }> }>(
      (await handleTool('search_memories', {
        query: 'ledger export',
        project_path: NS,
      })) as ToolResult
    )
    expect(afterUnarchive.results.map((r) => r.id).sort()).toEqual(['keep-me', 'retired'])
  })
})

describe('eviction telemetry', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb().db
    ensureSession(db, 'sess-1', NS)
  })

  function seedRetentionCorpus(): void {
    const family = 'a redundant burst member with one shared opening line '
    insertMemory(db, 'pinned-row', 'a pinned rule that must survive any pass', {
      importance: 0.05,
      pinned: true,
      lastAccessed: OLD,
    })
    insertMemory(db, 'unique-cold', 'a unique cold finding that nobody duplicates', {
      importance: 0.02,
      lastAccessed: OLD,
    })
    insertMemory(db, 'cold-dup', 'a duplicate body pointing at its keeper', {
      importance: 0.05,
      lastAccessed: OLD,
    })
    insertMemory(db, 'keeper', 'the keeper of that duplicate body', { importance: 0.05 })
    insertMemory(db, 'family-a', `${family}A`, { importance: 0.05, lastAccessed: OLD })
    insertMemory(db, 'family-b', `${family}B`, { importance: 0.05, lastAccessed: OLD })
    insertMemory(db, 'recent-a', `${family}C`, { importance: 0.05, lastAccessed: T0 - DAY })
    insertMemory(db, 'recent-b', `${family}D`, { importance: 0.05, lastAccessed: T0 - DAY })
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at)
       VALUES ('cold-dup', 'keeper', 1, 'duplicate_of', ?)`
    ).run(T0)
  }

  const retentionOptions = () => ({ minCorpusSize: 4, now: T0, minAgeDays: 14, maxScore: 0.35 })

  it('records one decision per row with the gate that decided it', () => {
    seedRetentionCorpus()
    const plan = planRetention(db, { ...retentionOptions(), scanLimit: 50 })
    expect(plan.decisions).toHaveLength(plan.scanned)

    const applied = applyRetention(db, plan, T0)
    expect(applied.archived).toBe(2)
    expect(events(db)).toHaveLength(plan.scanned)

    const archived = eventFor(db, 'family-b', 'archived')
    expect(archived?.reason).toBe(RETENTION_ARCHIVE_REASON)
    expect(archived?.namespace).toBe(NS)
    expect(archived?.tier).toBe('cold')
    expect(archived?.job_id).toBeNull()
    expect(eventFor(db, 'cold-dup', 'archived')?.reason).toBe(RETENTION_ARCHIVE_REASON)

    expect(eventFor(db, 'pinned-row', 'kept')?.reason).toBe('pinned')
    expect(eventFor(db, 'keeper', 'kept')?.reason).toBe('dedupe_keeper')
    expect(eventFor(db, 'unique-cold', 'kept')?.reason).toBe('non_redundant')
    expect(eventFor(db, 'family-a', 'kept')?.reason).toBe('non_redundant')
    expect(eventFor(db, 'recent-a', 'kept')?.reason).toBe('recently_used')
  })

  it('reads back a row whose archive update threw as kept, not archived', () => {
    seedRetentionCorpus()
    // a trigger stands in for a locked or failing write on one candidate
    db.exec(`CREATE TRIGGER block_archive BEFORE UPDATE OF archived_at ON memories
             WHEN OLD.id = 'cold-dup' BEGIN SELECT RAISE(ABORT, 'blocked by test'); END`)

    const plan = planRetention(db, { ...retentionOptions(), scanLimit: 50 })
    expect(plan.archive_ids.sort()).toEqual(['cold-dup', 'family-b'])
    const applied = applyRetention(db, plan, T0)
    expect(applied.archived).toBe(1)

    const blocked = eventFor(db, 'cold-dup', 'kept')
    expect(blocked?.reason).toBe('archive_failed')
    expect(eventFor(db, 'family-b', 'archived')?.reason).toBe(RETENTION_ARCHIVE_REASON)
    const stillLive = db.prepare('SELECT archived_at FROM memories WHERE id = ?').get('cold-dup') as {
      archived_at: number | null
    }
    expect(stillLive.archived_at).toBeNull()
  })

  it('marks candidates past the archive cap as kept, and stamps the job id', () => {
    seedRetentionCorpus()
    const plan = planRetention(db, { ...retentionOptions(), maxArchive: 1, scanLimit: 50 })
    expect(plan.archive_ids).toHaveLength(1)
    const { archived } = applyRetention(db, plan, T0, { jobId: 7 })
    expect(archived).toBe(1)

    // family-b scores higher (a unique row earns the uniqueness share), so it is the
    // one the cap leaves in place
    expect(plan.archive_ids).toEqual(['cold-dup'])
    expect(eventFor(db, 'cold-dup', 'archived')?.job_id).toBe(7)
    expect(eventFor(db, 'family-b', 'kept')?.reason).toBe(RETENTION_CAP_REASON)
    expect(eventFor(db, 'family-b', 'kept')?.job_id).toBe(7)
  })

  it('records a retention run on a small corpus as kept, never archived', () => {
    insertMemory(db, 'lonely', 'a lone row below the corpus floor', { importance: 0.01 })
    const plan = planRetention(db, retentionOptions())
    expect(plan.below_threshold).toBe(true)
    expect(applyRetention(db, plan, T0).archived).toBe(0)
    expect(events(db)).toEqual([
      expect.objectContaining({ memory_id: 'lonely', action: 'kept', reason: 'corpus_too_small' }),
    ])
  })

  it('bounds the table by age and by row count in the same call', () => {
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      insertMemory(db, `old-${i}`, `an event written long ago ${i}`)
      db.prepare(
        `INSERT INTO eviction_events (ts, namespace, memory_id, action, reason, tier, job_id)
         VALUES (?, ?, ?, 'kept', 'non_redundant', 'cold', NULL)`
      ).run(now - 200 * DAY, NS, `old-${i}`)
    }
    for (let i = 0; i < 6; i++) {
      db.prepare(
        `INSERT INTO eviction_events (ts, namespace, memory_id, action, reason, tier, job_id)
         VALUES (?, ?, ?, 'kept', 'non_redundant', 'cold', NULL)`
      ).run(now - i, NS, `fresh-${i}`)
    }

    const pruned = pruneEvictionEvents(db, { now, maxAgeDays: 90, maxRows: 4 })
    expect(pruned.by_age).toBe(3)
    expect(pruned.by_rows).toBe(2)
    // the row cap keeps the newest ids, whatever ts they carry
    const remaining = events(db).map((e) => e.memory_id)
    expect(remaining).toEqual(['fresh-2', 'fresh-3', 'fresh-4', 'fresh-5'])
    expect(remaining).toHaveLength(4)
    // the default row cap is what get_stats reports against
    expect(evictionMaxRows({})).toBe(100_000)

    // the row-cap helper alone, without the age bound
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO eviction_events (ts, namespace, memory_id, action, reason, tier, job_id)
         VALUES (?, ?, ?, 'kept', 'non_redundant', 'cold', NULL)`
      ).run(now, NS, `extra-${i}`)
    }
    expect(enforceEvictionRowCap(db, 2)).toBe(5)
    expect(events(db).map((e) => e.memory_id)).toEqual(['extra-1', 'extra-2'])
  })

  it('prunes old events during the maintenance pass that writes new ones', () => {
    // the pass runs at T0, so this predates its own age bound
    const oldTs = T0 - 200 * DAY
    db.prepare(
      `INSERT INTO eviction_events (ts, namespace, memory_id, action, reason, tier, job_id)
       VALUES (?, ?, 'ancient', 'archived', 'duplicate_family', 'cold', NULL)`
    ).run(oldTs, NS)

    insertMemory(db, 'lonely', 'a lone row below the corpus floor')
    const plan = planRetention(db, retentionOptions())
    applyRetention(db, plan, T0)

    const remaining = events(db).map((e) => e.memory_id)
    expect(remaining).not.toContain('ancient')
    expect(remaining).toContain('lonely')
  })

  it('holds the row cap on the read path, where faults keep arriving', () => {
    for (let i = 0; i < 5; i++) insertMemory(db, `fault-${i}`, `an archived row read back ${i}`)
    db.prepare("UPDATE memories SET archived_at = ? WHERE id LIKE 'fault-%'").run(T0 + 1)
    const bars = db
      .prepare(
        `SELECT id, COALESCE(namespace, project_path) AS namespace, importance, access_count,
                last_accessed, created_at, pinned, archived_at
         FROM memories`
      )
      .all() as Array<{
      id: string
      namespace: string
      importance: number
      access_count: number
      last_accessed: number | null
      created_at: number
      pinned: number
      archived_at: number | null
    }>

    process.env.ENGRAM_EVICTION_MAX_ROWS = '3'
    try {
      const written = recordColdFaults(db, bars, 'read')
      expect(written).toBe(5)
      expect(events(db)).toHaveLength(3)
    } finally {
      delete process.env.ENGRAM_EVICTION_MAX_ROWS
    }
  })

  it('reports null instead of failing when the table is missing', () => {
    db.exec('DROP TABLE eviction_events')
    expect(summarizeEvictions(db)).toBeNull()
    expect(
      pruneEvictionEvents(db, { now: T0, maxAgeDays: 90, maxRows: 10 }).deleted
    ).toBe(0)
  })
})
