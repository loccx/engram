import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import {
  computeTier,
  compositeScore,
  enrichMemories,
  enrichSearchResults,
  fetchSupersedesCounts,
  TIER_HOT_THRESHOLD,
  TIER_WARM_THRESHOLD,
  type RecallSignal,
} from '../src/memory/enrichment.js'
import type { Memory, SearchResult } from '../src/memory/types.js'

function ensureSession(db: Database.Database, sid: string, ns: string): void {
  db.prepare(`INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)`).run(
    sid,
    ns,
    Date.now()
  )
}

function insertMemory(
  db: Database.Database,
  id: string,
  opts: {
    content?: string
    namespace?: string
    importance?: number
    access_count?: number
    last_accessed?: number | null
    created_at?: number
    pinned?: boolean
  } = {}
): void {
  const ns = opts.namespace ?? '/proj'
  const created = opts.created_at ?? Date.now()
  ensureSession(db, 'sess1', ns)
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags,
        created_at, last_accessed, access_count, pinned)
     VALUES (?, ?, ?, ?, ?, 'note', ?, '[]', ?, ?, ?, ?)`
  ).run(
    id,
    'sess1',
    ns,
    ns,
    opts.content ?? 'content',
    opts.importance ?? 0.5,
    created,
    opts.last_accessed ?? null,
    opts.access_count ?? 0,
    opts.pinned ? 1 : 0
  )
}

function supersede(
  db: Database.Database,
  newerId: string,
  olderId: string,
  confidence: number = 0.9
): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_links
       (source_id, target_id, similarity, link_type, created_at, confidence, reason, decider_model, prompt_version, judged_at)
     VALUES (?, ?, ?, 'supersedes', ?, ?, 'test', 'gpt-test', 'contradiction-v1', ?)`
  ).run(newerId, olderId, confidence, Date.now(), confidence, Date.now())
}

function loadMemory(db: Database.Database, id: string): Memory {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any
  return { ...row, tags: JSON.parse(row.tags) }
}

describe('compositeScore', () => {
  const now = 1_000_000_000_000

  it('returns ~0.5 for default importance + no access + just-created', () => {
    const score = compositeScore(
      { importance: 0.5, access_count: 0, last_accessed: null, created_at: now },
      now
    )
    expect(score).toBeGreaterThan(0.4)
    expect(score).toBeLessThan(0.6)
  })

  it('high importance + frequent access + recent → close to 1', () => {
    const score = compositeScore(
      { importance: 1, access_count: 100, last_accessed: now, created_at: now },
      now
    )
    expect(score).toBeGreaterThan(0.95)
  })

  it('low importance + no access + ancient → close to 0', () => {
    const ancient = now - 365 * 24 * 60 * 60 * 1000
    const score = compositeScore(
      { importance: 0, access_count: 0, last_accessed: null, created_at: ancient },
      now
    )
    expect(score).toBeLessThan(0.05)
  })
})

describe('computeTier', () => {
  const now = 1_000_000_000_000

  it('pinned dominates regardless of score', () => {
    const tier = computeTier(
      { importance: 0, access_count: 0, last_accessed: null, created_at: 0, pinned: true },
      now
    )
    expect(tier).toBe('pinned')
  })

  it('high composite → hot', () => {
    const tier = computeTier(
      { importance: 1, access_count: 50, last_accessed: now, created_at: now, pinned: false },
      now
    )
    expect(tier).toBe('hot')
  })

  it('mid composite → warm', () => {
    const tier = computeTier(
      { importance: 0.5, access_count: 1, last_accessed: now, created_at: now, pinned: false },
      now
    )
    expect(tier).toBe('warm')
  })

  it('low composite → cold', () => {
    const ancient = now - 365 * 24 * 60 * 60 * 1000
    const tier = computeTier(
      { importance: 0.05, access_count: 0, last_accessed: null, created_at: ancient, pinned: false },
      now
    )
    expect(tier).toBe('cold')
  })

  it('thresholds are exposed and usable', () => {
    expect(TIER_HOT_THRESHOLD).toBeGreaterThan(TIER_WARM_THRESHOLD)
    expect(TIER_WARM_THRESHOLD).toBeGreaterThan(0)
  })
})

describe('fetchSupersedesCounts', () => {
  let dbm: ReturnType<typeof createTestDb>
  beforeEach(() => {
    dbm = createTestDb()
  })

  it('returns 0/0 for memories with no supersedes links', () => {
    const id = randomUUID()
    insertMemory(dbm.db, id)
    const counts = fetchSupersedesCounts(dbm.db, [id])
    expect(counts.get(id)).toEqual({ supersedes: 0, superseded_by: 0 })
  })

  it('counts both directions correctly', () => {
    const a = randomUUID()
    const b = randomUUID()
    const c = randomUUID()
    insertMemory(dbm.db, a)
    insertMemory(dbm.db, b)
    insertMemory(dbm.db, c)
    supersede(dbm.db, b, a)
    supersede(dbm.db, c, a)
    supersede(dbm.db, c, b)

    const counts = fetchSupersedesCounts(dbm.db, [a, b, c])
    expect(counts.get(a)).toEqual({ supersedes: 0, superseded_by: 2 })
    expect(counts.get(b)).toEqual({ supersedes: 1, superseded_by: 1 })
    expect(counts.get(c)).toEqual({ supersedes: 2, superseded_by: 0 })
  })

  it('ignores sub-threshold supersedes links', () => {
    const a = randomUUID()
    const b = randomUUID()
    insertMemory(dbm.db, a)
    insertMemory(dbm.db, b)
    supersede(dbm.db, b, a, 0.5)

    const counts = fetchSupersedesCounts(dbm.db, [a, b])
    expect(counts.get(a)).toEqual({ supersedes: 0, superseded_by: 0 })
    expect(counts.get(b)).toEqual({ supersedes: 0, superseded_by: 0 })
  })

  it('returns empty map on empty input', () => {
    expect(fetchSupersedesCounts(dbm.db, []).size).toBe(0)
  })
})

describe('enrichMemories', () => {
  let dbm: ReturnType<typeof createTestDb>
  beforeEach(() => {
    dbm = createTestDb()
  })

  it('adds namespace, tier, pinned, supersedes_counts to every memory', () => {
    const id = randomUUID()
    insertMemory(dbm.db, id, { importance: 0.9, access_count: 50, namespace: '/myproj' })
    const memory = loadMemory(dbm.db, id)

    const [enriched] = enrichMemories(dbm.db, [memory])
    expect(enriched.id).toBe(id)
    expect(enriched.namespace).toBe('/myproj')
    expect(enriched.pinned).toBe(false)
    expect(enriched.tier).toBeDefined()
    expect(enriched.supersedes_counts).toEqual({ supersedes: 0, superseded_by: 0 })
  })

  it('reflects pinned=true and tier=pinned', () => {
    const id = randomUUID()
    insertMemory(dbm.db, id, { pinned: true, importance: 0 })
    const memory = loadMemory(dbm.db, id)

    const [enriched] = enrichMemories(dbm.db, [memory])
    expect(enriched.pinned).toBe(true)
    expect(enriched.tier).toBe('pinned')
  })

  it('reflects supersedes_counts after a link is written', () => {
    const oldId = randomUUID()
    const newId = randomUUID()
    insertMemory(dbm.db, oldId)
    insertMemory(dbm.db, newId)
    supersede(dbm.db, newId, oldId)

    const memories = [loadMemory(dbm.db, oldId), loadMemory(dbm.db, newId)]
    const [oldEnriched, newEnriched] = enrichMemories(dbm.db, memories)
    expect(oldEnriched.supersedes_counts).toEqual({ supersedes: 0, superseded_by: 1 })
    expect(newEnriched.supersedes_counts).toEqual({ supersedes: 1, superseded_by: 0 })
  })

  it('handles empty input', () => {
    expect(enrichMemories(dbm.db, [])).toEqual([])
  })

  it('falls back to project_path when namespace is null (legacy rows)', () => {
    const id = randomUUID()
    ensureSession(dbm.db, 'sess1', '/legacy')
    dbm.db
      .prepare(
        `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
         VALUES (?, ?, ?, NULL, ?, 'note', 0.5, '[]', ?)`
      )
      .run(id, 'sess1', '/legacy', 'legacy', Date.now())

    const memory = loadMemory(dbm.db, id)
    const [enriched] = enrichMemories(dbm.db, [memory])
    expect(enriched.namespace).toBe('/legacy')
  })
})

describe('enrichSearchResults', () => {
  let dbm: ReturnType<typeof createTestDb>
  beforeEach(() => {
    dbm = createTestDb()
  })

  it('preserves score and attaches recall_reason from breakdown', () => {
    const id = randomUUID()
    insertMemory(dbm.db, id, { importance: 0.9 })
    const memory = loadMemory(dbm.db, id)
    const result: SearchResult = { ...memory, score: 0.42 }

    const breakdown = new Map<string, Record<RecallSignal, number>>([
      [id, { fts: 0.05, vec: 0.3, recency: 0.02, access: 0.01, importance: 0.04, reranker: 0 }],
    ])

    const [enriched] = enrichSearchResults(dbm.db, [result], breakdown)
    expect(enriched.score).toBe(0.42)
    expect(enriched.recall_reason).toBe('vec')
    expect(enriched.signal_breakdown).toBeDefined()
    expect(enriched.signal_breakdown!.vec).toBe(0.3)
  })

  it('omits recall_reason when no breakdown is provided for a result', () => {
    const id = randomUUID()
    insertMemory(dbm.db, id)
    const memory = loadMemory(dbm.db, id)
    const result: SearchResult = { ...memory, score: 0.5 }

    const [enriched] = enrichSearchResults(dbm.db, [result], new Map())
    expect(enriched.recall_reason).toBeUndefined()
    expect(enriched.signal_breakdown).toBeUndefined()
  })

  it('picks importance as recall_reason when it dominates', () => {
    const id = randomUUID()
    insertMemory(dbm.db, id, { importance: 1 })
    const memory = loadMemory(dbm.db, id)
    const result: SearchResult = { ...memory, score: 0.5 }
    const breakdown = new Map<string, Record<RecallSignal, number>>([
      [id, { fts: 0.05, vec: 0.05, recency: 0.05, access: 0.05, importance: 0.4, reranker: 0 }],
    ])

    const [enriched] = enrichSearchResults(dbm.db, [result], breakdown)
    expect(enriched.recall_reason).toBe('importance')
  })
})

describe('hybridSearch breakdown integration', () => {
  it('populates breakdown map keyed by memory id with all 6 signals', async () => {
    const dbm = createTestDb()
    const { MemorySearch } = await import('../src/memory/search.js')
    const search = new MemorySearch(dbm.db, false)

    const id = randomUUID()
    insertMemory(dbm.db, id, { content: 'kafka tuning notes', importance: 0.7 })

    const breakdown = new Map<string, Record<RecallSignal, number>>()
    const results = await search.hybridSearch('kafka tuning', { project_path: '/proj' }, breakdown)
    expect(results.length).toBeGreaterThan(0)
    const entry = breakdown.get(id)
    expect(entry).toBeDefined()
    expect(entry).toHaveProperty('fts')
    expect(entry).toHaveProperty('vec')
    expect(entry).toHaveProperty('recency')
    expect(entry).toHaveProperty('access')
    expect(entry).toHaveProperty('importance')
    expect(entry).toHaveProperty('reranker')
  })
})
