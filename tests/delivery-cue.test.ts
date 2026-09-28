import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { DatabaseManager } from '../src/db/init.js'
import { normalizeIdentifiers } from '../src/db/lexical-index.js'
import { cueHits } from '../src/delivery/cue.js'

const NS = '/work/engram'
const OTHER = '/work/other'

function seed(
  db: Database.Database,
  id: string,
  content: string,
  opts: {
    type?: string
    namespace?: string
    entities?: string[]
    archived?: boolean
    createdAt?: number
  } = {}
): void {
  const now = opts.createdAt ?? 1000
  db.prepare("INSERT OR IGNORE INTO sessions(id, project_path, started_at) VALUES ('s1', ?, ?)").run(NS, now)
  db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, ident_text, archived_at)
     VALUES (?, 's1', ?, ?, ?, ?, 0.5, '[]', ?, ?, ?, ?)`
  ).run(
    id,
    opts.namespace ?? NS,
    opts.namespace ?? NS,
    content,
    opts.type ?? 'note',
    now,
    now,
    normalizeIdentifiers(content),
    opts.archived ? now : null
  )
  for (const entity of opts.entities ?? []) {
    db.prepare(
      `INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at, ident_text)
       VALUES (?, ?, 'file_path', ?, ?)`
    ).run(id, entity, now, normalizeIdentifiers(entity))
  }
}

describe('cue lookup', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseManager(':memory:').db
  })

  it('finds the memory that names the file the tool is about to touch', () => {
    seed(db, 'a', 'the retry loop in src/delivery/hook.ts double-counts on abort', { type: 'gotcha' })
    seed(db, 'b', 'unrelated note about the readme')

    const hits = cueHits(db, NS, '/work/engram/src/delivery/hook.ts')
    expect(hits.map((hit) => hit.id)).toEqual(['a'])
    expect(hits[0].matched).toBe('src/delivery/hook.ts')
  })

  it('matches a memory that quotes the absolute path', () => {
    seed(db, 'a', 'the retry loop in /work/engram/src/delivery/hook.ts double-counts', { type: 'gotcha' })

    const hits = cueHits(db, NS, '/work/engram/src/delivery/hook.ts')
    expect(hits.map((hit) => hit.id)).toEqual(['a'])
    expect(hits[0].matched).toBe('/work/engram/src/delivery/hook.ts')
  })

  it('finds a memory through an extracted file_path entity', () => {
    seed(db, 'a', 'pruning happens in the daemon boot path', {
      type: 'bug',
      entities: ['/work/engram/src/db/init.ts'],
    })

    const hits = cueHits(db, NS, '/work/engram/src/db/init.ts')
    expect(hits.map((hit) => hit.id)).toEqual(['a'])
    expect(hits[0].matched).toBe('/work/engram/src/db/init.ts')
  })

  it('falls back to the basename when the stored memory omits the directory', () => {
    seed(db, 'a', 'hook.ts must never exit non-zero', { type: 'decision' })

    const hits = cueHits(db, NS, '/work/engram/src/delivery/hook.ts')
    expect(hits.map((hit) => hit.id)).toEqual(['a'])
    expect(hits[0].matched).toBe('hook.ts')
  })

  it('injects only the types worth interrupting an edit for', () => {
    seed(db, 'a', 'today I looked at src/delivery/hook.ts', { type: 'note' })
    seed(db, 'b', 'a todo about src/delivery/hook.ts', { type: 'todo' })
    seed(db, 'c', 'a gotcha in src/delivery/hook.ts', { type: 'gotcha' })

    expect(cueHits(db, NS, '/work/engram/src/delivery/hook.ts').map((hit) => hit.id)).toEqual(['c'])
  })

  it('never crosses a namespace', () => {
    seed(db, 'a', 'gotcha in src/delivery/hook.ts', { type: 'gotcha', namespace: OTHER })

    expect(cueHits(db, NS, '/work/engram/src/delivery/hook.ts')).toEqual([])
    expect(cueHits(db, OTHER, '/work/engram/src/delivery/hook.ts').map((hit) => hit.id)).toEqual(['a'])
  })

  it('skips archived memories', () => {
    seed(db, 'a', 'retired gotcha about src/delivery/hook.ts', { type: 'gotcha', archived: true })

    expect(cueHits(db, NS, '/work/engram/src/delivery/hook.ts')).toEqual([])
  })

  it('returns at most the requested number, deterministically', () => {
    for (let i = 0; i < 5; i++) {
      seed(db, `m${i}`, `gotcha number ${i} in src/delivery/hook.ts`, { type: 'gotcha', createdAt: 1000 + i })
    }

    const first = cueHits(db, NS, '/work/engram/src/delivery/hook.ts', 2)
    const second = cueHits(db, NS, '/work/engram/src/delivery/hook.ts', 2)
    expect(first).toHaveLength(2)
    expect(second.map((hit) => hit.id)).toEqual(first.map((hit) => hit.id))
  })

  it('has nothing to say about a file the store never mentions', () => {
    seed(db, 'a', 'gotcha in src/delivery/hook.ts', { type: 'gotcha' })

    expect(cueHits(db, NS, '/work/engram/src/nowhere/else.ts')).toEqual([])
  })
})
