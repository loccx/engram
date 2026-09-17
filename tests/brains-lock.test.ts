import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireBrainLock } from '../src/brains/lock.js'

/**
 * The publish/refresh lock exists because concurrent brain operations corrupt
 * each other: two publishes interleave commits and can see one another's temp
 * export, and two refreshes race the git index and the shared .cache/brain.db.
 */
describe('brains/lock', () => {
  let tmp: string
  let brainDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-lock-'))
    brainDir = join(tmp, 'brain')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('acquires a lock inside .cache and releases it', () => {
    const lock = acquireBrainLock(brainDir)
    expect(lock.path).toBe(join(brainDir, '.cache', 'brain.lock'))
    expect(existsSync(lock.path)).toBe(true)
    // Under .cache so it can never be staged into the published tree.
    expect(lock.path.includes(`${join('brain', '.cache')}`)).toBe(true)
    lock.release()
    expect(existsSync(lock.path)).toBe(false)
  })

  it('refuses a second acquisition while the lock is held, naming the holder', () => {
    const first = acquireBrainLock(brainDir)
    try {
      expect(() => acquireBrainLock(brainDir)).toThrow(/locked by pid \d+/)
      expect(() => acquireBrainLock(brainDir)).toThrow(/Another publish or refresh is already running/)
    } finally {
      first.release()
    }
    // Once released, it is acquirable again.
    const second = acquireBrainLock(brainDir)
    second.release()
  })

  it('takes over a stale lock whose owner is gone', () => {
    const lockPath = join(brainDir, '.cache', 'brain.lock')
    acquireBrainLock(brainDir).release()
    // pid 1 is not ours to signal... use an impossible pid instead.
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, startedAt: Date.now() }), 'utf8')
    const lock = acquireBrainLock(brainDir)
    expect(existsSync(lock.path)).toBe(true)
    lock.release()
  })

  it('takes over an old lock even when the recorded pid is alive-shaped', () => {
    const lockPath = join(brainDir, '.cache', 'brain.lock')
    acquireBrainLock(brainDir).release()
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 6 * 60_000 }), 'utf8')
    const lock = acquireBrainLock(brainDir)
    lock.release()
  })

  it('treats an unreadable lock file as stale rather than wedging the brain', () => {
    const lockPath = join(brainDir, '.cache', 'brain.lock')
    acquireBrainLock(brainDir).release()
    writeFileSync(lockPath, 'not json at all', 'utf8')
    const lock = acquireBrainLock(brainDir)
    lock.release()
  })

  it('release is idempotent', () => {
    const lock = acquireBrainLock(brainDir)
    lock.release()
    expect(() => lock.release()).not.toThrow()
  })
})
