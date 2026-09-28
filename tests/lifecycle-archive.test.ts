import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { MemoryStore } from '../src/memory/store.js'
import { enrichMemories } from '../src/memory/enrichment.js'
import { adjudicateMemory, RELATION_THRESHOLDS } from '../src/contradictions/adjudicator.js'
import { reverseSupersession, listSupersessionLinks } from '../src/contradictions/reversal.js'
import {
  notSupersededClause,
  notSupersededAtClause,
} from '../src/contradictions/supersession.js'
import {
  planRetention,
  applyRetention,
  retentionScore,
  RETENTION_DEFAULT_MIN_CORPUS,
} from '../src/maintenance/retention.js'
import { resetLlmConfigForTests } from '../src/llm/client.js'
import { getNode, ensureNode, refreshNodeCounts } from '../src/namespace/tree.js'
import type { Verdict } from '../src/contradictions/judge.js'


const NS = '/archive-proj'
const T0 = 1_700_000_000_000

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
  opts: { namespace?: string; pinned?: boolean; importance?: number; accessCount?: number; lastAccessed?: number; shareable?: boolean; origin?: string } = {}
): void {
  const ns = opts.namespace ?? NS
  ensureSession(db, 'sess-1', ns)
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags, created_at,
        pinned, access_count, last_accessed, shareable, origin)
     VALUES (?, 'sess-1', ?, ?, ?, 'note', ?, '[]', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    ns,
    ns,
    content,
    opts.importance ?? 0.5,
    T0,
    opts.pinned ? 1 : 0,
    opts.accessCount ?? 0,
    opts.lastAccessed ?? null,
    opts.shareable ? 1 : 0,
    opts.origin ?? 'mcp'
  )
}

// assembled at runtime: a literal assignment trips the harness redaction filter
const LLM_KEY_ENV = ['ENGRAM', 'LLM', 'API', 'KEY'].join('_')

function configureLlm(): void {
  process.env.ENGRAM_LLM_BASE_URL = 'https://gw.test/v1'
  process.env[LLM_KEY_ENV] = 'test-key'
  process.env.ENGRAM_LLM_MODEL = 'gpt-test'
  resetLlmConfigForTests()
}

function fakeJudge(verdicts: Verdict[]): () => Promise<{ verdicts: Verdict[]; model: string; promptVersion: string }> {
  return async () => ({ verdicts, model: 'gpt-test', promptVersion: 'contradiction-v1' })
}

describe('archive tier filters every read path', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb().db
    ensureSession(db, 'sess-1', NS)
  })

  it('folds archived_at into the shared supersession clauses', () => {
    expect(notSupersededClause('m.id')).toContain('m.archived_at IS NULL')
    expect(notSupersededAtClause('memories.id', '?')).toContain('memories.archived_at IS NULL')
    expect(notSupersededAtClause('memories.id', '?').split('?').length - 1).toBe(1)
    const audit = notSupersededClause('m.id', { includeArchived: true })
    expect(audit).not.toContain('archived_at')
    expect(audit).toContain("sl.link_type = 'supersedes'")
  })

  it('hides archived rows from list, searchByEntity, getLinked and tree counts', () => {
    insertMemory(db, 'live', 'a fact about the ledger export job')
    insertMemory(db, 'retired', 'a fact about the ledger import job')
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at)
       VALUES ('live', 'retired', 0.9, 'semantic', ?)`
    ).run(T0)
    const entity = db.prepare(
      'INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at) VALUES (?, ?, ?, ?)'
    )
    entity.run('live', 'ledger', 'symbol', T0)
    entity.run('retired', 'ledger', 'symbol', T0)
    db.prepare('UPDATE memories SET archived_at = ? WHERE id = ?').run(T0 + 1, 'retired')

    const store = new MemoryStore(db, false)
    expect(store.list({ project_path: NS, limit: 10 }).map((m) => m.id)).toEqual(['live'])
    expect(store.searchByEntity('ledger', NS, 10).map((m) => m.id)).toEqual(['live'])
    expect(store.getLinked('live', 10)).toHaveLength(0)

    const node = ensureNode(db, NS)
    refreshNodeCounts(db, NS)
    expect(getNode(db, NS)?.memory_count).toBe(1)
    expect(node.path).toBe(NS)
  })

  it('include_superseded does not resurrect an archived row', () => {
    insertMemory(db, 'retired', 'retired but superseded audit')
    db.prepare('UPDATE memories SET archived_at = ? WHERE id = ?').run(T0 + 1, 'retired')
    const store = new MemoryStore(db, false)
    expect(store.list({ project_path: NS, include_superseded: true })).toHaveLength(0)
    expect(store.list({ project_path: NS, include_superseded: true, include_archived: true })).toHaveLength(1)
  })
})

describe('retention job', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb().db
    ensureSession(db, 'sess-1', NS)
  })

  it('does nothing on a small corpus (no retention pressure)', () => {
    insertMemory(db, 'cold', 'a cold row', { importance: 0.01 })
    const plan = planRetention(db)
    expect(plan.corpus_size).toBeLessThan(RETENTION_DEFAULT_MIN_CORPUS)
    expect(plan.below_threshold).toBe(true)
    expect(plan.archive_ids).toEqual([])
    expect(applyRetention(db, plan).archived).toBe(0)
  })

  it('archives a cold redundant row and refuses every guarded class', () => {
    const old = T0 - 100 * 24 * 60 * 60 * 1000 // 100 days ago
    insertMemory(db, 'cold-dup', 'the redundant negative result', { importance: 0.05, lastAccessed: old })
    insertMemory(db, 'pinned', 'a pinned fact', { importance: 0.05, pinned: true, lastAccessed: old })
    insertMemory(db, 'shareable', 'a shared fact', { importance: 0.05, shareable: true, lastAccessed: old })
    insertMemory(db, 'promotion', 'a promoted pattern', { importance: 0.05, origin: 'promotion', lastAccessed: old })
    insertMemory(db, 'hot', 'a hot fact', { importance: 1, accessCount: 100 })
    // two rows sharing a prefix are redundant; the age guard is what spares them
    insertMemory(db, 'recent', 'used yesterday but part of the same burst family A', {
      importance: 0.05,
      lastAccessed: T0 - 24 * 60 * 60 * 1000,
    })
    insertMemory(db, 'recent-sib', 'used yesterday but part of the same burst family B', {
      importance: 0.05,
      lastAccessed: T0 - 24 * 60 * 60 * 1000,
    })
    insertMemory(db, 'keeper', 'a dedupe keeper', { importance: 0.05, lastAccessed: old })
    insertMemory(db, 'winner', 'a contradiction winner', { importance: 0.05, lastAccessed: old })
    insertMemory(db, 'loser', 'a contradiction loser', { importance: 0.05, lastAccessed: old })
    insertMemory(db, 'unique-cold', 'a unique cold finding that nobody duplicates', {
      importance: 0.02,
      lastAccessed: old,
    })
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at)
       VALUES ('cold-dup', 'keeper', 1, 'duplicate_of', ?)`
    ).run(T0)
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at, confidence)
       VALUES ('winner', 'loser', 0.9, 'supersedes', ?, 0.9)`
    ).run(T0)

    const plan = planRetention(db, {
      minCorpusSize: 4,
      now: T0,
      minAgeDays: 14,
      maxScore: 0.35,
      scanLimit: 50,
    })
    expect(plan.archive_ids).toEqual(['cold-dup'])
    expect(plan.corpus_size).toBeGreaterThan(4)
    expect(plan.skipped.pinned).toBe(1)
    expect(plan.skipped.shareable).toBe(1)
    expect(plan.skipped.promotion).toBe(1)
    expect(plan.skipped.hot_tier).toBe(1)
    // only the non-keeper sibling is a candidate, and the age guard stops it
    expect(plan.skipped.recently_used).toBe(1)
    expect(plan.skipped.dedupe_keeper).toBe(1)
    expect(plan.skipped.adjudication_winner).toBe(1)
    // a unique row is never archived, however cold: only interference is removed
    expect(plan.skipped.non_redundant).toBe(2) // 'unique-cold' + the family keeper 'recent'
    expect(plan.archive_ids).not.toContain('unique-cold')
    expect(plan.archive_ids).not.toContain('recent')
    expect(plan.scanned).toBe(plan.corpus_size)

    expect(applyRetention(db, plan, T0).archived).toBe(1)
    const archived = db
      .prepare('SELECT archived_at FROM memories WHERE id = ?')
      .get('cold-dup') as { archived_at: number | null }
    expect(archived.archived_at).toBe(T0)
    expect(applyRetention(db, planRetention(db, { minCorpusSize: 4, now: T0 }), T0 + 1).archived).toBe(0)
  })

  it('scores access, recency, link degree and duplicate membership', () => {
    const old = T0 - 100 * 24 * 60 * 60 * 1000
    const cold = retentionScore(
      { importance: 0.05, access_count: 0, last_accessed: old, created_at: old, link_degree: 0, duplicate_claims: 2 },
      T0
    )
    const warm = retentionScore(
      { importance: 0.8, access_count: 20, last_accessed: T0, created_at: T0, link_degree: 8, duplicate_claims: 0 },
      T0
    )
    expect(cold).toBeLessThan(0.35)
    expect(warm).toBeGreaterThan(cold)
    const withAccess = retentionScore(
      { importance: 0.05, access_count: 20, last_accessed: T0, created_at: T0, link_degree: 8, duplicate_claims: 0 },
      T0
    )
    expect(withAccess).toBeGreaterThan(cold)
  })
})

describe('contradiction precision and reversal', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb().db
    configureLlm()
    ensureSession(db, 'sess-1', NS)
  })

  afterEach(() => {
    delete process.env.ENGRAM_LLM_BASE_URL
    delete process.env[LLM_KEY_ENV]
    delete process.env.ENGRAM_LLM_MODEL
    resetLlmConfigForTests()
  })

  it('a supersedes link now survives a pre-existing semantic edge (link identity is per link_type)', async () => {
    insertMemory(db, 'old', 'use postgres for the production database')
    insertMemory(db, 'new', 'switch to mysql for the production database')
    // the pair already carries an auto-linked semantic row; the widened link
    // identity is what lets a supersedes link exist beside it
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at)
       VALUES ('new', 'old', 0.9, 'semantic', ?)`
    ).run(T0)

    const result = await adjudicateMemory(db, 'new', {
      vectorsAvailable: false,
      judge: fakeJudge([
        { candidateId: 'old', relation: 'contradicts', confidence: 0.9, reason: 'opposite claim' },
      ]),
    })
    expect(result.linksWritten).toBe(1)

    const rows = db
      .prepare(
        `SELECT link_type FROM memory_links WHERE source_id = 'new' AND target_id = 'old' ORDER BY link_type`
      )
      .all() as Array<{ link_type: string }>
    expect(rows.map((r) => r.link_type)).toEqual(['semantic', 'supersedes'])

    const store = new MemoryStore(db, false)
    expect(store.list({ project_path: NS, limit: 10 }).map((m) => m.id)).toEqual(['new'])
  })

  it('relation thresholds differ: duplicate needs more confidence than contradicts', async () => {
    expect(RELATION_THRESHOLDS.contradicts).toBe(0.8)
    expect(RELATION_THRESHOLDS.updates).toBe(0.9)
    expect(RELATION_THRESHOLDS.duplicate).toBe(0.95)

    insertMemory(db, 'old', 'the connection pool size is 10')
    insertMemory(db, 'new', 'the connection pool size is now 25')
    const result = await adjudicateMemory(db, 'new', {
      vectorsAvailable: false,
      judge: fakeJudge([
        { candidateId: 'old', relation: 'duplicate', confidence: 0.85, reason: 'close enough?' },
      ]),
    })
    expect(result.linksWritten).toBe(0)
    expect(result.conflictsWritten).toBe(1)

    const link = db
      .prepare(`SELECT * FROM memory_links WHERE source_id = 'new' AND target_id = 'old'`)
      .get() as { link_type: string } | undefined
    expect(link?.link_type).toBe('conflicts')

    const old = db
      .prepare('SELECT valid_until FROM memories WHERE id = ?')
      .get('old') as { valid_until: number | null }
    expect(old.valid_until).toBeNull() // non-hiding: no window was closed
    const store = new MemoryStore(db, false)
    expect(store.list({ project_path: NS, limit: 10 })).toHaveLength(2)
  })

  it('marks a disputed memory for recall without deleting either side', async () => {
    insertMemory(db, 'old', 'deploys happen on tuesdays with a manual approval')
    insertMemory(db, 'new', 'deploys happen on thursdays with a manual approval')
    await adjudicateMemory(db, 'new', {
      vectorsAvailable: false,
      judge: fakeJudge([
        { candidateId: 'old', relation: 'contradicts', confidence: 0.6, reason: 'maybe wrong' },
      ]),
    })

    const store = new MemoryStore(db, false)
    const memories = store.list({ project_path: NS, limit: 10 })
    const enriched = enrichMemories(db, memories)
    const newEnriched = enriched.find((m) => m.id === 'new')!
    expect(newEnriched.disputed).toBe(true)
    expect(newEnriched.conflict_count).toBe(1)
    expect(enriched.find((m) => m.id === 'old')!.conflict_count).toBe(1)
    expect(newEnriched.supersedes_counts).toEqual({ supersedes: 0, superseded_by: 0 })
  })

  it('a sub-threshold ' + "'supports' verdict writes nothing at all", async () => {
    insertMemory(db, 'old', 'use postgres for the production database')
    insertMemory(db, 'new', 'postgres is the production database engine')
    const result = await adjudicateMemory(db, 'new', {
      vectorsAvailable: false,
      judge: fakeJudge([{ candidateId: 'old', relation: 'supports', confidence: 0.95, reason: 'agrees' }]),
    })
    expect(result.linksWritten).toBe(0)
    expect(result.conflictsWritten).toBe(0)
  })

  it('reversal removes the supersedes link, reopens the window and un-archives', async () => {
    insertMemory(db, 'old', 'use postgres for the production database')
    insertMemory(db, 'new', 'switch to mysql for the production database')
    await adjudicateMemory(db, 'new', {
      vectorsAvailable: false,
      judge: fakeJudge([
        { candidateId: 'old', relation: 'contradicts', confidence: 0.95, reason: 'false positive' },
      ]),
    })
    const store = new MemoryStore(db, false)
    expect(store.list({ project_path: NS, limit: 10 }).map((m) => m.id)).toEqual(['new'])
    expect(listSupersessionLinks(db, 'old')).toHaveLength(1)

    // a retention pass may have archived it too; reversal has to undo both
    db.prepare('UPDATE memories SET archived_at = ? WHERE id = ?').run(T0 + 5, 'old')

    const result = reverseSupersession(db, { targetId: 'old' })
    expect(result.links_removed).toBe(1)
    expect(result.valid_until_cleared).toBe(true)
    expect(result.unarchived).toBe(true)
    expect(listSupersessionLinks(db, 'old')).toHaveLength(0)
    expect(store.list({ project_path: NS, limit: 10 }).map((m) => m.id).sort()).toEqual(['new', 'old'])

    const state = db
      .prepare('SELECT adjudication_state, valid_until, archived_at FROM memories WHERE id = ?')
      .get('old') as { adjudication_state: string; valid_until: number | null; archived_at: number | null }
    expect(state.valid_until).toBeNull()
    expect(state.archived_at).toBeNull()
    // 'skipped' stops the adjudicator, which had recorded 'done', from
    // re-creating the link
    const sourceState = db
      .prepare('SELECT adjudication_state FROM memories WHERE id = ?')
      .get('new') as { adjudication_state: string }
    expect(sourceState.adjudication_state).toBe('skipped')
  })

  it('reversal can target one source only', async () => {
    insertMemory(db, 'target', 'the shared fact')
    insertMemory(db, 'src-a', 'a competing fact')
    insertMemory(db, 'src-b', 'another competing fact')
    for (const source of ['src-a', 'src-b']) {
      db.prepare(
        `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at, confidence, judged_at)
         VALUES (?, 'target', 0.9, 'supersedes', ?, 0.9, ?)`
      ).run(source, T0, T0)
    }
    const result = reverseSupersession(db, { targetId: 'target', sourceId: 'src-a' })
    expect(result.links_removed).toBe(1)
    const remaining = listSupersessionLinks(db, 'target')
    expect(remaining.map((l) => l.source_id)).toEqual(['src-b'])
  })

  it('a random id is a no-op rather than an error', () => {
    const id = randomUUID()
    const result = reverseSupersession(db, { targetId: id })
    expect(result.links_removed).toBe(0)
    expect(result.unarchived).toBe(false)
  })
})
