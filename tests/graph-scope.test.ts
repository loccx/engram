import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { MemorySearch } from '../src/memory/search.js'
import { createTestDb } from './helpers.js'

const NS_A = '/work/alpha'
const NS_A_CHILD = '/work/alpha/packages/api'
const NS_A_SIBLING = '/work/alpha-other'
const NS_B = '/work/beta'

function seedMemory(db: Database.Database, id: string, namespace: string, content = id, createdAt = 100): void {
  db.prepare("INSERT OR IGNORE INTO sessions(id, project_path, started_at) VALUES ('s1', ?, ?)").run(NS_A, createdAt)
  db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from)
     VALUES (?, 's1', ?, ?, ?, 'note', 0.5, '[]', ?, ?)`
  ).run(id, namespace, namespace, content, createdAt, createdAt)
}

function link(
  db: Database.Database,
  source: string,
  target: string,
  similarity = 0.9,
  link_type = 'semantic'
): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at)
     VALUES (?, ?, ?, ?, 1)`
  ).run(source, target, similarity, link_type)
}

describe('graph traversal namespace isolation', () => {
  let db: Database.Database
  let search: MemorySearch

  beforeEach(() => {
    db = createTestDb().db
    search = new MemorySearch(db, false)
    seedMemory(db, 'a-seed', NS_A)
    seedMemory(db, 'a-1', NS_A)
    seedMemory(db, 'a-child', NS_A_CHILD)
    seedMemory(db, 'a-sibling', NS_A_SIBLING)
    seedMemory(db, 'b-1', NS_B)
    seedMemory(db, 'b-2', NS_B)
  })

  it('keeps the previous (unscoped) behaviour when no namespace is requested', () => {
    link(db, 'a-seed', 'a-1')
    link(db, 'a-1', 'b-1')
    const ids = search.traverseGraph('a-seed', 3, 20).map((r) => r.id)
    expect(ids).toContain('a-1')
    expect(ids).toContain('b-1')
  })

  it('never leaves the requested namespace and rejects an out-of-scope seed', () => {
    link(db, 'a-seed', 'a-1')
    link(db, 'a-1', 'a-child')
    link(db, 'a-1', 'b-1')
    link(db, 'b-1', 'b-2')

    expect(search.traverseGraph('a-seed', 3, 20, { project_path: NS_A }).map((r) => r.id)).toEqual(['a-1'])
    // no walk at all, not a walk filtered afterwards
    expect(search.traverseGraph('b-1', 3, 20, { project_path: NS_A })).toEqual([])
    expect(search.traverseGraph('a-seed', 3, 20, { namespace_subtree: NS_A }).map((r) => r.id)).toEqual([
      'a-1',
      'a-child',
    ])
    expect(search.traverseGraph('a-seed', 3, 20, { namespace_subtree: NS_A }).map((r) => r.id)).not.toContain(
      'a-sibling'
    )
  })

  it('returns real link_type and hops instead of hard-coded values', () => {
    link(db, 'a-seed', 'a-1', 0.8, 'reference')
    link(db, 'a-1', 'a-child', 0.7, 'temporal')
    const rows = search.traverseGraph('a-seed', 3, 20, { namespace_subtree: NS_A })
    expect(rows.find((r) => r.id === 'a-1')).toMatchObject({ link_type: 'reference', hops: 1 })
    const child = search.pprSearch(['a-seed'], 20, { namespace_subtree: NS_A }).find((r) => r.id === 'a-child')
    expect(child).toBeDefined()
    expect(child!.hops).toBe(2)
    expect(child!.link_type).toBe('temporal')
    expect(child!.similarity).toBeGreaterThan(0)
  })
})

describe('pprSearch namespace isolation and edge weighting', () => {
  let db: Database.Database
  let search: MemorySearch

  beforeEach(() => {
    db = createTestDb().db
    search = new MemorySearch(db, false)
  })

  it('cannot surface another project through a global _autoLink edge', () => {
    seedMemory(db, 'a-seed', NS_A)
    seedMemory(db, 'a-hub', NS_A)
    seedMemory(db, 'a-leaf', NS_A)
    // _autoLink edges are global: a memory in alpha can point at one in beta
    seedMemory(db, 'b-secret', NS_B)
    link(db, 'a-seed', 'a-hub')
    link(db, 'a-hub', 'a-leaf')
    link(db, 'a-seed', 'b-secret')

    const unscoped = search.pprSearch(['a-seed'], 20).map((r) => r.id)
    expect(unscoped).toContain('b-secret')

    const scoped = search.pprSearch(['a-seed'], 20, { project_path: NS_A }).map((r) => r.id)
    expect(scoped).toContain('a-hub')
    expect(scoped).not.toContain('b-secret')
    expect(search.pprSearch(['b-secret'], 20, { project_path: NS_A })).toEqual([])
  })

  it('weights transitions by the stored similarity', () => {
    seedMemory(db, 'a-seed', NS_A)
    seedMemory(db, 'a-strong', NS_A)
    seedMemory(db, 'a-weak', NS_A)
    link(db, 'a-seed', 'a-strong', 0.95)
    link(db, 'a-seed', 'a-weak', 0.1)

    const rows = search.pprSearch(['a-seed'], 20, { project_path: NS_A })
    const strong = rows.find((r) => r.id === 'a-strong')!
    const weak = rows.find((r) => r.id === 'a-weak')!
    expect(strong.similarity).toBeGreaterThan(weak.similarity)
    expect(rows[0].id).toBe('a-strong')
  })

  it('falls back to uniform out-degree when edges carry no positive weight', () => {
    seedMemory(db, 'a-seed', NS_A)
    seedMemory(db, 'a-x', NS_A)
    seedMemory(db, 'a-y', NS_A)
    link(db, 'a-seed', 'a-x', 0)
    link(db, 'a-seed', 'a-y', 0)

    const rows = search.pprSearch(['a-seed'], 20, { project_path: NS_A })
    const x = rows.find((r) => r.id === 'a-x')!
    const y = rows.find((r) => r.id === 'a-y')!
    expect(x.similarity).toBeCloseTo(y.similarity, 10)
  })

  it('is deterministic across identical calls', () => {
    seedMemory(db, 'a-seed', NS_A)
    seedMemory(db, 'a-1', NS_A)
    seedMemory(db, 'a-2', NS_A)
    seedMemory(db, 'a-3', NS_A)
    link(db, 'a-seed', 'a-1', 0.5)
    link(db, 'a-seed', 'a-2', 0.5)
    link(db, 'a-1', 'a-3', 0.5)
    link(db, 'a-2', 'a-3', 0.5)

    const first = search.pprSearch(['a-seed'], 20, { project_path: NS_A })
    const second = search.pprSearch(['a-seed'], 20, { project_path: NS_A })
    expect(first.map((r) => [r.id, r.similarity])).toEqual(second.map((r) => [r.id, r.similarity]))
  })

  it('still honours validity and supersession inside the scope', () => {
    seedMemory(db, 'a-seed', NS_A)
    seedMemory(db, 'a-old', NS_A, 'expired fact')
    seedMemory(db, 'a-new', NS_A, 'current fact')
    db.prepare("UPDATE memories SET valid_from = 10, valid_until = 20 WHERE id = 'a-old'").run()
    link(db, 'a-seed', 'a-old')
    link(db, 'a-seed', 'a-new')

    const rows = search.pprSearch(['a-seed'], 20, { project_path: NS_A, as_of: 15 }).map((r) => r.id)
    expect(rows).toEqual(['a-old'])
    // present-state reads apply supersession but keep the window open, so both
    // rows are candidates here; as_of is what closes it
    const current = search.pprSearch(['a-seed'], 20, { project_path: NS_A }).map((r) => r.id)
    expect(current.sort()).toEqual(['a-new', 'a-old'])

    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at, confidence, judged_at)
       VALUES ('a-new', 'a-old', 1, 'supersedes', 1, 1, 1)`
    ).run()
    expect(search.pprSearch(['a-seed'], 20, { project_path: NS_A }).map((r) => r.id)).toEqual(['a-new'])
    expect(
      search.pprSearch(['a-seed'], 20, { project_path: NS_A, include_superseded: true }).map((r) => r.id).sort()
    ).toEqual(['a-new', 'a-old'])
  })
})
