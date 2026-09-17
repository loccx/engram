import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseManager } from '../src/db/init.js'
import { exportBrain } from '../src/brains/snapshot.js'
import { listLocalBrains, searchBrain, getBrainMemory, markShareable } from '../src/brains/mcp.js'

describe('brains/mcp', () => {
  let tmp: string
  let brainsDir: string
  let sourceMgr: DatabaseManager

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-brains-mcp-'))
    brainsDir = join(tmp, 'brains')
    mkdirSync(brainsDir, { recursive: true })

    sourceMgr = new DatabaseManager(':memory:')
    sourceMgr.db.prepare('INSERT INTO sessions(id, project_path, started_at) VALUES (?, ?, ?)').run('s1', '/p', Date.now())
    sourceMgr.db
      .prepare(
        'INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run('mem-shared', 's1', '/p', 'how to deploy with kubernetes rollout', 'note', 0.7, '[]', Date.now(), 0, 'work', 1)
    sourceMgr.db
      .prepare(
        'INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run('mem-private', 's1', '/p', 'internal password is rotated weekly', 'note', 0.9, '[]', Date.now(), 0, 'work', 0)
  })
  afterEach(() => {
    sourceMgr.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function buildBrainDb(name: string): void {
    const brainDir = join(brainsDir, name)
    mkdirSync(join(brainDir, '.cache'), { recursive: true })
    exportBrain(sourceMgr.db, { namespace: 'work', outputPath: join(brainDir, '.cache', 'brain.db') })
  }

  interface ExtraMemory {
    id: string
    content: string
    type?: string
    importance?: number
    namespace?: string
    shareable?: number
    created_at?: number
  }

  function addMemory(row: ExtraMemory): void {
    sourceMgr.db
      .prepare(
        'INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        row.id,
        's1',
        '/p',
        row.content,
        row.type ?? 'note',
        row.importance ?? 0.5,
        '[]',
        row.created_at ?? Date.now(),
        0,
        row.namespace ?? 'work',
        row.shareable ?? 1
      )
  }

  it('listLocalBrains returns empty array when dir missing', () => {
    expect(listLocalBrains(join(tmp, 'nonexistent'))).toEqual([])
  })

  it('listLocalBrains summarizes a built brain with cache present', () => {
    buildBrainDb('work')
    const brains = listLocalBrains(brainsDir)
    expect(brains).toHaveLength(1)
    expect(brains[0].name).toBe('work')
    expect(brains[0].memory_count).toBe(1)
    expect(brains[0].has_decrypted_cache).toBe(true)
    expect(brains[0].embedding_model).toBe('nomic-ai/nomic-embed-text-v1.5')
  })

  it('listLocalBrains handles brain dir with no DB gracefully', () => {
    mkdirSync(join(brainsDir, 'empty-brain'), { recursive: true })
    const brains = listLocalBrains(brainsDir)
    expect(brains).toHaveLength(1)
    expect(brains[0].name).toBe('empty-brain')
    expect(brains[0].memory_count).toBe(0)
    expect(brains[0].has_decrypted_cache).toBe(false)
  })

  it('searchBrain returns full-text matches', async () => {
    buildBrainDb('work')
    const results = await searchBrain('work', 'kubernetes', 10, brainsDir)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('mem-shared')
    expect(results[0].content).toContain('kubernetes')
  })

  it('searchBrain throws when brain has no decrypted DB', async () => {
    mkdirSync(join(brainsDir, 'empty-brain'), { recursive: true })
    await expect(searchBrain('empty-brain', 'anything', 10, brainsDir)).rejects.toThrow(/no decrypted/i)
  })

  it('searchBrain rejects invalid brain names', async () => {
    await expect(searchBrain('../escape', 'anything', 10, brainsDir)).rejects.toThrow(/invalid/i)
  })

  it('searchBrain does NOT return private/non-shareable memories', async () => {
    buildBrainDb('work')
    const results = await searchBrain('work', 'password', 10, brainsDir)
    expect(results).toEqual([])
  })

  it('getBrainMemory returns the memory by id', () => {
    buildBrainDb('work')
    const m = getBrainMemory('work', 'mem-shared', brainsDir)
    expect(m?.id).toBe('mem-shared')
    expect(m?.content).toContain('kubernetes')
  })

  it('getBrainMemory returns null for unknown id', () => {
    buildBrainDb('work')
    expect(getBrainMemory('work', 'unknown', brainsDir)).toBeNull()
  })

  it('getBrainMemory does NOT return private memory by id (not in snapshot)', () => {
    buildBrainDb('work')
    expect(getBrainMemory('work', 'mem-private', brainsDir)).toBeNull()
  })

  it('markShareable flips flag and is idempotent', () => {
    const r1 = markShareable(sourceMgr.db, 'mem-private', true, 'test')
    expect(r1).toEqual({ id: 'mem-private', shareable: true, changed: true })
    const r2 = markShareable(sourceMgr.db, 'mem-private', true, 'test')
    expect(r2.changed).toBe(false)
    const row = sourceMgr.db.prepare('SELECT shareable FROM memories WHERE id = ?').get('mem-private') as { shareable: number }
    expect(row.shareable).toBe(1)
  })

  it('markShareable can unmark', () => {
    const r = markShareable(sourceMgr.db, 'mem-shared', false, 'test')
    expect(r.changed).toBe(true)
    const row = sourceMgr.db.prepare('SELECT shareable FROM memories WHERE id = ?').get('mem-shared') as { shareable: number }
    expect(row.shareable).toBe(0)
  })

  it('markShareable throws for unknown memory id', () => {
    expect(() => markShareable(sourceMgr.db, 'no-such-id', true, 'test')).toThrow(/not found/i)
  })

  // --- natural-language retrieval + FTS safety -----------------------------

  it('searchBrain matches a multi-word query precisely when every term is present', () => {
    addMemory({
      id: 'mem-pg',
      content: 'We picked postgres over mysql for the billing service because of transactional DDL',
      type: 'decision',
      importance: 0.9,
    })
    addMemory({
      id: 'mem-pg-note',
      content: 'A note that mentions postgres once while discussing dashboards',
      type: 'note',
      importance: 0.2,
    })
    buildBrainDb('work')
    const ids = searchBrain('work', 'postgres billing', 10, brainsDir).map((r) => r.id)
    expect(ids).toEqual(['mem-pg'])
  })

  it('searchBrain answers a natural-language question via the OR fallback', () => {
    addMemory({
      id: 'mem-pg',
      content: 'We picked postgres over mysql for the billing service because of transactional DDL',
      type: 'decision',
      importance: 0.9,
    })
    buildBrainDb('work')
    const ids = searchBrain('work', 'why did we pick postgres over mysql for the billing service', 10, brainsDir).map(
      (r) => r.id
    )
    expect(ids).toContain('mem-pg')
  })

  it('searchBrain falls back to OR when no single memory contains every term', () => {
    addMemory({ id: 'mem-pg', content: 'We picked postgres over mysql for the billing service', type: 'decision', importance: 0.9 })
    buildBrainDb('work')
    const ids = searchBrain('work', 'kubernetes postgres', 10, brainsDir).map((r) => r.id)
    expect(ids).toContain('mem-shared')
    expect(ids).toContain('mem-pg')
  })

  it('searchBrain treats FTS5 operators, quotes and parens as plain terms', () => {
    addMemory({ id: 'mem-pg', content: 'We picked postgres over mysql for billing', type: 'decision' })
    buildBrainDb('work')
    const hostile = [
      'NEAR("a" OR "b")',
      '"postgres" OR (mysql)',
      'content:kubernetes',
      'postgres NOT kubernetes',
      '*',
      '()',
      'a"b',
      '^postgres$',
    ]
    for (const query of hostile) {
      expect(() => searchBrain('work', query, 10, brainsDir)).not.toThrow()
      expect(Array.isArray(searchBrain('work', query, 10, brainsDir))).toBe(true)
    }
  })

  it('searchBrain returns nothing for empty or stopword-only queries', () => {
    buildBrainDb('work')
    expect(searchBrain('work', '', 10, brainsDir)).toEqual([])
    expect(searchBrain('work', 'why did we the of', 10, brainsDir)).toEqual([])
  })

  it('searchBrain ranks a prominent decision above a passing note for the same term', () => {
    addMemory({ id: 'mem-pg', content: 'postgres was chosen for billing because of transactional DDL', type: 'decision', importance: 0.9 })
    addMemory({ id: 'mem-pg-note', content: 'postgres appeared in a dashboard note', type: 'note', importance: 0.1 })
    buildBrainDb('work')
    expect(searchBrain('work', 'postgres', 10, brainsDir)[0]?.id).toBe('mem-pg')
  })

  it('searchBrain respects the limit', () => {
    addMemory({ id: 'mem-p1', content: 'postgres alpha', created_at: 1 })
    addMemory({ id: 'mem-p2', content: 'postgres beta', created_at: 2 })
    addMemory({ id: 'mem-p3', content: 'postgres gamma', created_at: 3 })
    buildBrainDb('work')
    expect(searchBrain('work', 'postgres', 2, brainsDir)).toHaveLength(2)
  })

  // --- supersession + manifest gating -------------------------------------

  it('searchBrain and getBrainMemory hide memories the owner has superseded', () => {
    addMemory({ id: 'mem-old', content: 'Billing uses mysql for the ledger', type: 'decision', importance: 0.8 })
    addMemory({ id: 'mem-new', content: 'Billing uses postgres for the ledger', type: 'decision', importance: 0.8 })
    sourceMgr.db
      .prepare(
        'INSERT INTO memory_links(source_id, target_id, similarity, link_type, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('mem-new', 'mem-old', 1, 'supersedes', 0.95, Date.now())
    buildBrainDb('work')
    const ids = searchBrain('work', 'billing', 10, brainsDir).map((r) => r.id)
    expect(ids).toContain('mem-new')
    expect(ids).not.toContain('mem-old')
    expect(getBrainMemory('work', 'mem-old', brainsDir)).toBeNull()
    expect(getBrainMemory('work', 'mem-new', brainsDir)?.id).toBe('mem-new')
  })

  it('searchBrain and getBrainMemory refuse a brain published with a newer schema', () => {
    buildBrainDb('work')
    const cachePath = join(brainsDir, 'work', '.cache', 'brain.db')
    const db = new Database(cachePath)
    db.prepare("UPDATE brain_manifest SET value = '999' WHERE key = 'schema_version'").run()
    db.close()
    expect(() => searchBrain('work', 'kubernetes', 10, brainsDir)).toThrow(/cannot be read/i)
    expect(() => getBrainMemory('work', 'mem-shared', brainsDir)).toThrow(/cannot be read/i)
  })

  // --- scoped shareable marking -------------------------------------------

  it('markShareable refuses memories outside the caller namespace', () => {
    expect(() => markShareable(sourceMgr.db, 'mem-private', true, 'test', { allowedNamespace: '/other' })).toThrow(
      /outside the caller/i
    )
  })

  it('markShareable allows the namespace itself and its child layers', () => {
    addMemory({ id: 'mem-scope', content: 'payments scope retries webhooks', namespace: 'work//payments', shareable: 0 })
    addMemory({ id: 'mem-sub', content: 'subdirectory memory', namespace: 'work/sub', shareable: 0 })
    expect(markShareable(sourceMgr.db, 'mem-shared', true, 'test', { allowedNamespace: 'work' }).id).toBe('mem-shared')
    expect(markShareable(sourceMgr.db, 'mem-scope', true, 'test', { allowedNamespace: 'work' }).changed).toBe(true)
    expect(markShareable(sourceMgr.db, 'mem-sub', true, 'test', { allowedNamespace: 'work' }).changed).toBe(true)
  })

  it('markShareable rejects a sibling namespace with the same prefix', () => {
    addMemory({ id: 'mem-sibling', content: 'other project memory', namespace: 'work2', shareable: 0 })
    expect(() => markShareable(sourceMgr.db, 'mem-sibling', true, 'test', { allowedNamespace: 'work' })).toThrow(
      /outside the caller/i
    )
  })

  it('markShareable without an allowed namespace keeps working for internal callers', () => {
    expect(markShareable(sourceMgr.db, 'mem-private', true, 'test').changed).toBe(true)
  })
})
