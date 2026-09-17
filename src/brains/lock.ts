/**
 * Advisory per-brain lock.
 *
 * Concurrent brain operations are not safe on their own: two publishes can see
 * each other's temp export and interleave commits, and two refreshes race the
 * git index and both decrypt into the same `.cache/brain.db`. Serialize them
 * with an O_EXCL lockfile keyed on the brain directory.
 *
 * The lock lives under `.cache/` so it can never reach the published git tree,
 * and a stale lock (dead pid, or older than STALE_MS) is taken over rather than
 * wedging a brain forever after a crash.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logger } from '../utils/logger.js'

const STALE_MS = 5 * 60_000

export interface BrainLock {
  path: string
  release: () => void
}

/** Is the recorded owner still running? EPERM means it exists but is not ours. */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function acquireBrainLock(brainDir: string): BrainLock {
  const cacheDir = join(brainDir, '.cache')
  mkdirSync(cacheDir, { recursive: true })
  const path = join(cacheDir, 'brain.lock')

  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() })
  const tryCreate = (): boolean => {
    try {
      writeFileSync(path, payload, { flag: 'wx', encoding: 'utf8' })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    }
  }

  if (!tryCreate()) {
    let holder: { pid?: number; startedAt?: number } = {}
    try {
      holder = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; startedAt?: number }
    } catch {
      // Unreadable lock file: treat it as stale rather than wedging the brain.
    }
    const age = typeof holder.startedAt === 'number' ? Date.now() - holder.startedAt : Number.POSITIVE_INFINITY
    const stale = !isAlive(holder.pid ?? -1) || age > STALE_MS
    if (!stale) {
      throw new Error(
        `Brain is locked by pid ${holder.pid ?? 'unknown'} (${path}). Another publish or refresh is already running; wait for it to finish, or delete that file if the process is gone.`
      )
    }
    logger.info({ path, pid: holder.pid, ageMs: age }, 'brains: taking over a stale lock')
    writeFileSync(path, payload, { encoding: 'utf8' })
  }

  let released = false
  return {
    path,
    release: () => {
      if (released) return
      released = true
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch {
        /* best effort: a leftover lock is reclaimed by stale takeover */
      }
    },
  }
}
