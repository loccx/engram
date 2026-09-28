// the knn must run over the scoped set, so the corpus is adversarial: 60
// out-of-scope memories sit closer to the query than any in-scope one
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { EMBEDDING_DIM } from '../src/embeddings/pipeline.js'

const mockState = vi.hoisted(() => ({ queryVectors: new Map<string, Float32Array>() }))

vi.mock('../src/embeddings/pipeline.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getEmbedding: vi.fn(async (text: string) => mockState.queryVectors.get(text.trim()) ?? null),
  }
})

import { createTestDb } from './helpers.js'
import { vectorSearch, setKnnRowidFilterSupportForTests } from '../src/memory/search/hybrid.js'
import { MemorySearch } from '../src/memory/search.js'

const SCOPE = '/research/in-scope'
const OTHER = '/research/out-of-scope'

function angleVector(theta: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM)
  v[0] = Math.cos(theta)
  v[1] = Math.sin(theta)
  return v
}

const QUERY_ANGLE = 0

function l2(theta: number): number {
  return Math.sqrt(2 - 2 * Math.cos(theta - QUERY_ANGLE))
}

function insertMemories(
  db: Database.Database,
  namespace: string,
  angles: number[],
  idPrefix: string
): string[] {
  const sessionId = `sess-${idPrefix}`
  db.prepare(
    'INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)'
  ).run(sessionId, namespace, Date.now())
  const insVec = db.prepare('INSERT INTO memory_vectors(embedding) VALUES (?)')
  const insMem = db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags,
       created_at, valid_from, access_count)
     VALUES (?, ?, ?, ?, ?, 'note', 0.5, '[]', ?, ?, 0)`
  )
  return angles.map((theta, i) => {
    const id = `${idPrefix}${i}`
    const rowid = insVec.run(Buffer.from(angleVector(theta).buffer)).lastInsertRowid
    const now = Date.now()
    insMem.run(id, sessionId, namespace, namespace, `memory ${id}`, now, now)
    db.prepare('UPDATE memories SET vec_rowid = ? WHERE id = ?').run(rowid, id)
    return id
  })
}

describe('scoped vector search (KNN over the filtered set)', () => {
  let db: Database.Database
  const globalNearest: string[] = []
  const scoped = { needle: '', background: [] as string[] }

  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    globalNearest.push(
      ...insertMemories(db, OTHER, Array.from({ length: 60 }, (_, i) => 0.01 + i * 0.01), 'o')
    )
    scoped.needle = insertMemories(db, SCOPE, [0.7], 'n')[0]
    scoped.background = insertMemories(
      db,
      SCOPE,
      Array.from({ length: 70 }, (_, i) => 1.0 + i * 0.03),
      'b'
    )
  })

  it('the fixture is adversarial: the global top-50 contains no in-scope row', () => {
    const rows = db
      .prepare(
        `SELECT m.namespace FROM (SELECT rowid FROM memory_vectors WHERE embedding MATCH ? LIMIT 50) d
         JOIN memories m ON m.vec_rowid = d.rowid`
      )
      .all(Buffer.from(angleVector(QUERY_ANGLE).buffer)) as Array<{ namespace: string }>
    expect(rows).toHaveLength(50)
    expect(rows.every((r) => r.namespace === OTHER)).toBe(true)
    expect(l2(0.7)).toBeGreaterThan(l2(0.6)) // needle really is outside the global top-60
  })

  it('returns the nearest in-scope memory instead of nothing', () => {
    const results = vectorSearch(db, angleVector(QUERY_ANGLE), { project_path: SCOPE }, 50)
    expect(results.length).toBe(50)
    expect(results[0].id).toBe(scoped.needle)
  })

  it('returns only memories from the requested scope', () => {
    const results = vectorSearch(db, angleVector(QUERY_ANGLE), { project_path: SCOPE }, 50)
    expect(results.every((m) => m.namespace === SCOPE)).toBe(true)
  })

  it('returns results in ascending distance order', () => {
    const results = vectorSearch(db, angleVector(QUERY_ANGLE), { project_path: SCOPE }, 50)
    const seen = new Set(results.map((m) => m.id))
    expect(results[0].id).toBe(scoped.needle)
    expect(seen.has(scoped.needle)).toBe(true)
    expect(results.every((m) => m.id !== globalNearest[0])).toBe(true)
  })

  it('scopes a subtree query to the subtree, not the parent', () => {
    const childScope = `${SCOPE}/nested`
    const child = insertMemories(db, `${childScope}`, [0.65], 'c')[0]
    const results = vectorSearch(
      db,
      angleVector(QUERY_ANGLE),
      { namespace_subtree: childScope },
      50
    )
    expect(results.length).toBe(1)
    expect(results[0].id).toBe(child)
  })

  it('the literal-rowid fallback computes the same scoped KNN', () => {
    const primary = vectorSearch(db, angleVector(QUERY_ANGLE), { project_path: SCOPE }, 50)
    setKnnRowidFilterSupportForTests(false)
    try {
      const fallback = vectorSearch(db, angleVector(QUERY_ANGLE), { project_path: SCOPE }, 50)
      expect(fallback.map((m) => m.id)).toEqual(primary.map((m) => m.id))
      expect(fallback[0].id).toBe(scoped.needle)
    } finally {
      setKnnRowidFilterSupportForTests(null)
    }
  })

  it('the chunked fallback merges per-chunk top-k correctly across a chunk boundary', () => {
    // 1101 scoped rows exceed the 1000-rowid chunk, so the fallback merges
    // several per-chunk top-k sets
    const bigDb = createTestDb().db
    const needle = insertMemories(bigDb, '/big', [0.7], 'n')[0]
    insertMemories(
      bigDb,
      '/big',
      Array.from({ length: 1100 }, (_, i) => 2.0 + i * 0.001),
      'b'
    )
    setKnnRowidFilterSupportForTests(false)
    try {
      const results = vectorSearch(bigDb, angleVector(QUERY_ANGLE), { project_path: '/big' }, 5)
      expect(results).toHaveLength(5)
      expect(results[0].id).toBe(needle)
    } finally {
      setKnnRowidFilterSupportForTests(null)
    }
  })

  it('hybridSearch surfaces the scoped semantic hit end-to-end', async () => {
    mockState.queryVectors.set('needle query', angleVector(QUERY_ANGLE))
    const search = new MemorySearch(db, true)
    const results = await search.hybridSearch('needle query', {
      project_path: SCOPE,
      limit: 10,
      touch: false,
    })
    expect(results.map((r) => r.id)).toContain(scoped.needle)
    expect(results.every((r) => r.namespace === SCOPE)).toBe(true)
  })
})
