import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
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

  it('searchBrain returns full-text matches', () => {
    buildBrainDb('work')
    const results = searchBrain('work', 'kubernetes', 10, brainsDir)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('mem-shared')
    expect(results[0].content).toContain('kubernetes')
  })

  it('searchBrain throws when brain has no decrypted DB', () => {
    mkdirSync(join(brainsDir, 'empty-brain'), { recursive: true })
    expect(() => searchBrain('empty-brain', 'anything', 10, brainsDir)).toThrow(/no decrypted/i)
  })

  it('searchBrain rejects invalid brain names', () => {
    expect(() => searchBrain('../escape', 'anything', 10, brainsDir)).toThrow(/invalid/i)
  })

  it('searchBrain does NOT return private/non-shareable memories', () => {
    buildBrainDb('work')
    const results = searchBrain('work', 'password', 10, brainsDir)
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
})
