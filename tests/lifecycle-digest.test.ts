import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { MemoryStore } from '../src/memory/store.js'
import { getDigest, refreshDigest } from '../src/memory/digest.js'
import { refreshNavDigest } from '../src/memory/nav.js'


const NS = '/digest-proj'
const T0 = 1_700_000_000_000

function ensureSession(db: Database.Database): void {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    'sess-1',
    NS,
    T0
  )
}

function insertNode(
  db: Database.Database,
  path: string,
  opts: { parentPath?: string | null; digest?: string | null } = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO namespace_nodes
       (path, parent_path, depth, is_synthetic, real_path, digest, digest_source_hash,
        memory_count, child_count, last_activity_at, updated_at)
     VALUES (?, ?, ?, 0, NULL, ?, NULL, 0, 0, NULL, ?)`
  ).run(path, opts.parentPath ?? null, path.split('/').filter(Boolean).length, opts.digest ?? null, Date.now())
}

async function waitFor(check: () => boolean, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return check()
}

describe('digest refresh on the pin path', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb().db
    ensureSession(db)
  })

  it('a pinned store refreshes the digest before it returns', async () => {
    const store = new MemoryStore(db, false)
    await store.store({
      content: 'the release branch is the only place deploys may originate',
      session_id: 'sess-1',
      project_path: NS,
      type: 'note',
      pinned: true,
    })
    expect(getDigest(db, NS)).toContain('the release branch is the only place deploys may originate')
  })

  it('setPinned refreshes the digest in the background', async () => {
    const store = new MemoryStore(db, false)
    const memory = await store.store({
      content: 'pgbouncer must be restarted before the app',
      session_id: 'sess-1',
      project_path: NS,
      type: 'note',
    })
    expect(getDigest(db, NS)).toBe('')

    expect(store.setPinned(memory.id, true)).toBe(true)
    const appeared = await waitFor(() => getDigest(db, NS).includes('pgbouncer must be restarted'))
    expect(appeared).toBe(true)
  })

  it('unpinning removes the line again', async () => {
    const store = new MemoryStore(db, false)
    const memory = await store.store({
      content: 'a fact that will not stay pinned',
      session_id: 'sess-1',
      project_path: NS,
      type: 'note',
      pinned: true,
    })
    expect(getDigest(db, NS)).toContain('a fact that will not stay pinned')

    expect(store.setPinned(memory.id, false)).toBe(true)
    const removed = await waitFor(() => !getDigest(db, NS).includes('a fact that will not stay pinned'))
    expect(removed).toBe(true)
  })

  it('refreshDigest is still hash-guarded (no rewrite when nothing changed)', async () => {
    const store = new MemoryStore(db, false)
    await store.store({
      content: 'unchanged pinned fact',
      session_id: 'sess-1',
      project_path: NS,
      type: 'note',
      pinned: true,
    })
    const first = await refreshDigest(db, NS)
    expect(first.changed).toBe(false)
  })
})

describe('nav digest summarises the whole child digest', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb().db
    ensureSession(db)
  })

  it('keeps the child continuation lines in the parent text', async () => {
    insertNode(db, NS, { parentPath: '/digest-proj-root' })
    insertNode(db, `${NS}/sub`, {
      parentPath: NS,
      digest: 'first line of the child digest\nsecond line: pgbouncer pool sizing\nthird line: retry budget',
    })

    const result = await refreshNavDigest(db, NS)
    expect(result.content).toContain('[child ' + NS + '/sub] first line of the child digest')
    expect(result.content).toContain('second line: pgbouncer pool sizing')
    expect(result.content).toContain('third line: retry budget')
  })

  it('a change below the child first line propagates (hash covers full content)', async () => {
    insertNode(db, NS, { parentPath: '/digest-proj-root' })
    insertNode(db, `${NS}/sub`, { parentPath: NS, digest: 'same first line\noriginal second line' })
    const before = await refreshNavDigest(db, NS)
    expect(before.changed).toBe(true)

    db.prepare('UPDATE namespace_nodes SET digest = ? WHERE path = ?').run(
      'same first line\nREWRITTEN second line',
      `${NS}/sub`
    )
    const after = await refreshNavDigest(db, NS)
    expect(after.changed).toBe(true)
    expect(after.content).toContain('REWRITTEN second line')

    const row = db
      .prepare('SELECT digest, digest_source_hash FROM namespace_nodes WHERE path = ?')
      .get(NS) as { digest: string; digest_source_hash: string }
    expect(row.digest).toContain('REWRITTEN second line')
    expect(row.digest_source_hash).not.toBeNull()
  })

  it('a child with no digest contributes an explicit placeholder', async () => {
    insertNode(db, `${NS}/empty`, { parentPath: NS, digest: '' })
    insertNode(db, NS, { parentPath: '/digest-proj-root' })
    const result = await refreshNavDigest(db, NS)
    expect(result.content).toContain('[child ' + NS + '/empty] (no digest yet)')
  })
})
