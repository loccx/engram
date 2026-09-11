import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { MemoryStore } from '../src/memory/store.js'
import { MemorySearch } from '../src/memory/search.js'
import { recallContext, type RecallResult } from '../src/memory/recall.js'
import { refreshDigest } from '../src/memory/digest.js'

const NS = '/home/user/recall-project'
const T0 = 1_700_000_000_000

let db: Database.Database
let store: MemoryStore
let search: MemorySearch

function seedSession(): void {
  db.prepare(
    'INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)'
  ).run('sess1', NS, T0)
}

function insertMemory(
  id: string,
  content: string,
  opts: { importance?: number; valid_from?: number; valid_until?: number | null; entity?: string; access?: number } = {}
): void {
  seedSession()
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, valid_until, access_count)
     VALUES (?, 'sess1', ?, ?, ?, 'note', ?, '[]', ?, ?, ?, ?)`
  ).run(
    id,
    NS,
    NS,
    content,
    opts.importance ?? 0.5,
    opts.valid_from ?? T0,
    opts.valid_from ?? T0,
    opts.valid_until ?? null,
    opts.access ?? 0
  )
  if (opts.entity) {
    db.prepare(
      "INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at) VALUES (?, ?, 'symbol', ?)"
    ).run(id, opts.entity, T0)
  }
}

async function recall(opts: Partial<Parameters<typeof recallContext>[3]> & { budget_chars: number; query: string }): Promise<RecallResult> {
  return recallContext(db, store, search, {
    project_path: NS,
    limit: 10,
    ...opts,
  })
}

describe('recall_context', () => {
  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    store = new MemoryStore(db, false)
    search = new MemorySearch(db, false)
  })

  it('enforces the strict budget and reports usage per section', async () => {
    insertMemory('m1', 'kafka tuning notes '.repeat(60), { importance: 0.9 })
    insertMemory('m2', 'kafka consumer group behavior', { importance: 0.5 })

    const result = await recall({ query: 'kafka', budget_chars: 300, now: T0 })
    const contentChars =
      (result.digest?.length ?? 0) +
      result.memories.reduce((sum, m) => sum + m.content.length, 0) +
      result.topics.reduce((sum, t) => sum + (t.summary?.length ?? 0), 0)
    expect(contentChars).toBeLessThanOrEqual(300)
    expect(result.budget.total_chars).toBe(300)
    expect(result.budget.used_chars).toBe(contentChars)
    expect(result.budget.per_section.digest + result.budget.per_section.memories + result.budget.per_section.topics).toBe(contentChars)
    expect(result.truncated.memories).toBeGreaterThanOrEqual(1)
    expect(result.dropped.memories).toBeGreaterThanOrEqual(1)
  })

  it('is read-only: touch:false leaves access state untouched', async () => {
    insertMemory('m1', 'repeatable query target', { access: 3 })
    const before = db
      .prepare('SELECT access_count, last_accessed FROM memories WHERE id = ?')
      .get('m1') as { access_count: number; last_accessed: number | null }

    await recall({ query: 'repeatable', budget_chars: 500, now: T0 + 50_000 })
    await recall({ query: 'repeatable', budget_chars: 500, now: T0 + 50_000 })

    const after = db
      .prepare('SELECT access_count, last_accessed FROM memories WHERE id = ?')
      .get('m1') as { access_count: number; last_accessed: number | null }
    expect(after).toEqual(before)
  })

  it('is deterministic: identical inputs produce identical payloads', async () => {
    insertMemory('m1', 'deterministic ranking probe', { importance: 0.8 })
    insertMemory('m2', 'probe with more terms matched here', { importance: 0.7 })

    const a = await recall({ query: 'deterministic probe', budget_chars: 500, now: T0 + 10_000 })
    const b = await recall({ query: 'deterministic probe', budget_chars: 500, now: T0 + 10_000 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.memories.length).toBeGreaterThan(0)
  })

  it('applies as_of validity to hybrid, entity, graph, and topic branches', async () => {
    insertMemory('gone', 'expired kafka insight', {
      valid_from: T0,
      valid_until: T0 + 1_000,
      entity: 'apiClient',
    })
    insertMemory('live', 'live kafka insight', { valid_from: T0, entity: 'apiClient' })
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at)
       VALUES ('live', 'gone', 0.9, 'semantic', ?)`
    ).run(T0)
    db.prepare(
      `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
       VALUES (?, ?, 'kafka topic', 1, ?, ?)`
    ).run(NS, JSON.stringify(['gone', 'live']), T0, T0)

    const past = await recall({ query: 'kafka', budget_chars: 600, as_of: T0 + 500, now: T0 })
    expect(past.memories.map((m) => m.id)).toContain('gone')

    const future = await recall({ query: 'kafka', budget_chars: 600, as_of: T0 + 5_000, now: T0 })
    expect(future.memories.map((m) => m.id)).toContain('live')
    expect(future.memories.map((m) => m.id)).not.toContain('gone')
    // Topic membership only surfaces facts valid at as_of.
    for (const topic of future.topics) {
      expect(topic.member_ids).not.toContain('gone')
    }

    const entityResult = await recall({
      query: 'apiClient',
      budget_chars: 600,
      mode: 'entity',
      as_of: T0 + 5_000,
      now: T0,
    })
    expect(entityResult.memories.map((m) => m.id)).toContain('live')
    expect(entityResult.memories.map((m) => m.id)).not.toContain('gone')

    const graphResult = await recall({
      query: 'anything',
      budget_chars: 600,
      mode: 'graph',
      seed_id: 'live',
      as_of: T0 + 5_000,
      now: T0,
    })
    // PPR walks from live; gone is expired at as_of so it must not appear.
    expect(graphResult.memories.map((m) => m.id)).not.toContain('gone')
  })

  it('filters by minimum trust while pinned memories bypass', async () => {
    insertMemory('cold', 'rarely accessed cold fact', { importance: 0.1, access: 0 })
    insertMemory('hot', 'frequently accessed hot fact', { importance: 0.9, access: 100 })
    insertMemory('pinned', 'pinned fact always surfaces', { importance: 0.1, access: 0 })
    db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run('pinned')

    const result = await recall({
      query: 'fact',
      budget_chars: 800,
      min_trust: 0.5,
      now: T0 + 2_000,
    })
    const ids = result.memories.map((m) => m.id)
    expect(ids).toContain('hot')
    expect(ids).toContain('pinned')
    expect(ids).not.toContain('cold')
  })

  it('dedupes identities and suppresses near-duplicates deterministically', async () => {
    insertMemory('a', 'token unique alpha', { importance: 0.9 })
    insertMemory('b', 'token unique alpha near copy', { importance: 0.8 })
    // High-similarity semantic edge: b is a near-duplicate of a.
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at)
       VALUES ('a', 'b', 0.97, 'semantic', ?)`
    ).run(T0)

    const result = await recall({ query: 'token unique alpha', budget_chars: 800, now: T0 })
    const ids = result.memories.map((m) => m.id)
    expect(ids).toContain('a')
    expect(ids).not.toContain('b')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns drilldown handles and source provenance per memory', async () => {
    insertMemory('m1', 'drilldown documentation target', { importance: 0.9 })

    const result = await recall({ query: 'drilldown', budget_chars: 500, now: T0 })
    expect(result.memories.length).toBeGreaterThan(0)
    const mem = result.memories[0]
    expect(mem.source).toBe('hybrid')
    expect(mem.handles.get_memory).toEqual({ id: mem.id })
    expect(mem.handles.get_related).toEqual({ id: mem.id, depth: 1 })
    expect(mem.id).toBeTruthy()
  })

  it('serves the digest with truncation metadata when over its reserve', async () => {
    db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run('m1')
    const longFact = 'pinned fact text '.repeat(30)
    insertMemory('m1', 'short pinned probe', { importance: 0.9 })
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(longFact, 'm1')
    db.prepare(
      `INSERT OR REPLACE INTO project_digests (namespace, content, source_hash, updated_at)
       VALUES (?, ?, 'h', ?)`
    ).run(NS, longFact, T0)

    const result = await recall({ query: 'probe', budget_chars: 300 })
    expect((result.digest?.length ?? 0)).toBeLessThanOrEqual(
      Math.floor(300 * 0.4) + 1 // reserve + ellipsis
    )
    expect(result.truncated.digest).toBe(true)
    expect(result.dropped.digest_chars_cut).toBe(longFact.length - (result.digest?.length ?? 0))
    expect(result.dropped.digest_chars_cut).toBeGreaterThan(0)
  })

  it('holds the strict budget and exact accounting when a topic summary is truncated', async () => {
    // One memory that exactly fits after the empty digest, leaving just
    // enough room for a partially-truncated topic summary.
    insertMemory('mt', 'topic probe fact', { importance: 0.9 })
    const topicSummary = 'kafka consumer rebalancing internals explained honestly'.repeat(6)
    db.prepare(
      `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`
    ).run(NS, JSON.stringify(['mt']), topicSummary, T0, T0)

    const budget = 300
    const result = await recall({ query: 'topic probe', budget_chars: budget, now: T0 })
    const digestLen = result.digest?.length ?? 0
    const memoryChars = result.memories.reduce((s, m) => s + m.content.length, 0)
    const topicChars = result.topics.reduce((s, t) => s + (t.summary?.length ?? 0), 0)
    const actual = digestLen + memoryChars + topicChars

    // The strict-budget contract: real emitted characters never exceed the
    // budget, and the self-reported accounting is EXACT.
    expect(actual).toBeLessThanOrEqual(budget)
    expect(result.budget.used_chars).toBe(actual)
    expect(result.budget.per_section.digest).toBe(digestLen)
    expect(result.budget.per_section.memories).toBe(memoryChars)
    expect(result.budget.per_section.topics).toBe(topicChars)

    // At least one topic was truncated (marker reserved inside the budget).
    expect(result.topics.length).toBe(1)
    expect(result.truncated.topics).toBe(1)
    expect(result.topics[0].summary).toBeTruthy()
    expect(result.topics[0].summary!.endsWith('…')).toBe(true)
  })

  it('omits present-state digest and topic summaries in historical as_of recalls', async () => {
    insertMemory('hist', 'historical fact under test', { importance: 0.9 })
    db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run('hist')

    // Present-state digest would leak into the historical view if injected.
    await refreshDigest(db, NS)

    // A cluster whose summary is present-state; membership mixes a memory
    // valid at as_of and one created after it.
    const later = 'later-mem'
    insertMemory('early', 'early cluster member', { importance: 0.8, valid_from: T0 })
    insertMemory(later, 'post-as_of cluster member', {
      importance: 0.8,
      valid_from: T0 + 60_000,
    })
    db.prepare(
      `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
       VALUES (?, ?, 'present-day cluster summary', 1, ?, ?)`
    ).run(NS, JSON.stringify(['early', later]), T0 + 60_000, T0 + 60_000)

    const result = await recall({ query: 'cluster member', budget_chars: 600, as_of: T0 + 1_000, now: T0 })

    expect(result.digest).toBeNull()
    expect(result.as_of_limitations).toEqual({
      digest_omitted: true,
      topic_summaries_omitted: true,
    })
    for (const topic of result.topics) {
      expect(topic.summary).toBeNull()
    }
    // Membership remains correctly filtered to facts valid at as_of.
    const memberIds = result.topics.flatMap((t) => t.member_ids)
    expect(memberIds).toContain('early')
    expect(memberIds).not.toContain(later)
  })

  it('applies min_trust BEFORE near-duplicate suppression so a passing sibling survives', async () => {
    insertMemory('lowtrust-top', 'dedupe pair twin content', { importance: 0.05, access: 0 })
    insertMemory('passing-sibling', 'dedupe pair twin content', { importance: 0.9, access: 100 })
    // The two are near-duplicates; the low-trust representative ranks first.
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at)
       VALUES ('lowtrust-top', 'passing-sibling', 0.97, 'semantic', ?)`
    ).run(T0)

    const result = await recall({
      query: 'dedupe pair twin content',
      budget_chars: 800,
      min_trust: 0.5,
      now: T0 + 2_000,
    })
    const ids = result.memories.map((m) => m.id)
    expect(ids).not.toContain('lowtrust-top')
    expect(ids).toContain('passing-sibling')
    // Drops are accounted for.
    expect(result.dropped.trust_filtered).toBeGreaterThanOrEqual(1)
  })

  it('get_context output is unaffected by recall availability', async () => {
    insertMemory('m1', 'context invariance check', { importance: 0.9 })
    const before = search.getContext(NS, 10).map((m) => m.id)
    await recall({ query: 'context invariance', budget_chars: 500, now: T0 })
    const after = search.getContext(NS, 10).map((m) => m.id)
    expect(after).toEqual(before)
  })
})
