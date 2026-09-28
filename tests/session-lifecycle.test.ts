import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { SessionManager, sessionIdleMs } from '../src/session/manager.js'
import { createTestDb } from './helpers.js'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'


const TEST_PROJECT = '/home/user/session-project'
const HOUR_MS = 60 * 60 * 1000

interface SessionRow {
  id: string
  project_path: string
  started_at: number
  ended_at: number | null
  summary: string | null
}

describe('SessionManager idle sweep', () => {
  let db: Database.Database
  let manager: SessionManager

  beforeEach(() => {
    db = createTestDb().db
    manager = new SessionManager(db)
    delete process.env.ENGRAM_SESSION_IDLE_MS
  })

  afterEach(() => {
    delete process.env.ENGRAM_SESSION_IDLE_MS
  })

  function backdate(sessionId: string, startedAt: number, memoryCreatedAt?: number): void {
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(startedAt, sessionId)
    if (memoryCreatedAt !== undefined) {
      db.prepare(
        `INSERT INTO memories (id, session_id, project_path, content, created_at)
         VALUES (?, ?, ?, 'fact', ?)`
      ).run(`m-${sessionId}`, sessionId, '/p', memoryCreatedAt)
    }
  }

  it('defaults to a 12h idle window and honours the environment override', () => {
    expect(sessionIdleMs({})).toBe(12 * HOUR_MS)
    expect(sessionIdleMs({ ENGRAM_SESSION_IDLE_MS: '60000' })).toBe(60_000)
    expect(sessionIdleMs({ ENGRAM_SESSION_IDLE_MS: '0' })).toBe(0)
    expect(sessionIdleMs({ ENGRAM_SESSION_IDLE_MS: 'nonsense' })).toBe(12 * HOUR_MS)
    expect(sessionIdleMs({ ENGRAM_SESSION_IDLE_MS: '-5' })).toBe(12 * HOUR_MS)
  })

  it('ends only sessions older than the window, measured from the last write', async () => {
    const now = Date.now()
    const fresh = await manager.start({ project_path: '/p' })
    const quiet = await manager.start({ project_path: '/p' })
    backdate(quiet.id, now - 2 * HOUR_MS, now - 2 * HOUR_MS)
    const active = await manager.start({ project_path: '/p' })
    backdate(active.id, now - 2 * HOUR_MS, now - 60_000) // wrote a minute ago

    const idle = manager.idleSessions(now, HOUR_MS)
    expect(idle.map((s) => s.id)).toEqual([quiet.id])

    const swept = manager.sweepIdle(now, HOUR_MS)
    expect(swept.map((s) => s.id)).toEqual([quiet.id])
    expect(swept[0].ended_at).not.toBeNull()
    expect(swept[0].summary).toBe('auto-ended: idle')
    expect(manager.getById(fresh.id)!.ended_at).toBeNull()
    expect(manager.getById(active.id)!.ended_at).toBeNull()

    expect(manager.sweepIdle(now, HOUR_MS)).toEqual([])
  })

  it('falls back to started_at when a session never wrote anything', async () => {
    const now = Date.now()
    const silent = await manager.start({ project_path: '/p' })
    backdate(silent.id, now - 3 * HOUR_MS)

    expect(manager.sweepIdle(now, HOUR_MS).map((s) => s.id)).toEqual([silent.id])
  })

  it('disables the sweep when the idle window is 0', async () => {
    const now = Date.now()
    const old = await manager.start({ project_path: '/p' })
    backdate(old.id, now - 10 * HOUR_MS)

    expect(manager.sweepIdle(now, 0)).toEqual([])
    expect(manager.getById(old.id)!.ended_at).toBeNull()
  })
})

describe('session lifecycle through the tool surface', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    delete process.env.ENGRAM_SESSION_IDLE_MS
  })

  afterEach(() => {
    delete process.env.ENGRAM_SESSION_IDLE_MS
  })

  function parse<T>(result: { content: Array<{ text: string }> }): T {
    return JSON.parse(result.content[0].text) as T
  }

  it('rotates the session on the next write after the idle window and enqueues its maintenance', async () => {
    process.env.ENGRAM_SESSION_IDLE_MS = '1'
    const db = getDatabase().db

    const first = parse<{ session_id: string }>(
      await handleTool('store_memory', { content: 'first fact', project_path: TEST_PROJECT })
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = parse<{ session_id: string; auto_ended_sessions?: string[] }>(
      await handleTool('store_memory', { content: 'second fact', project_path: TEST_PROJECT })
    )

    expect(second.session_id).not.toBe(first.session_id)
    expect(second.auto_ended_sessions).toEqual([first.session_id])
    const closed = db
      .prepare('SELECT ended_at, summary FROM sessions WHERE id = ?')
      .get(first.session_id) as { ended_at: number | null; summary: string | null }
    expect(closed.ended_at).not.toBeNull()
    expect(closed.summary).toBe('auto-ended: idle')

    const jobs = db
      .prepare("SELECT DISTINCT job_type FROM maintenance_jobs WHERE source = 'end_session'")
      .all() as Array<{ job_type: string }>
    expect(jobs.length).toBeGreaterThan(0)
  })

  it('list_sessions reports the current session id and sweeps idle sessions', async () => {
    process.env.ENGRAM_SESSION_IDLE_MS = '1'
    const db = getDatabase().db
    const first = parse<{ session_id: string }>(
      await handleTool('store_memory', { content: 'fact for session list', project_path: TEST_PROJECT })
    )
    await new Promise((resolve) => setTimeout(resolve, 5))

    const listed = parse<{
      current_session_id: string | null
      total: number
      active: number
      auto_ended: Array<{ id: string }>
      sessions: SessionRow[]
    }>(await handleTool('list_sessions', { project_path: TEST_PROJECT }))

    expect(listed.auto_ended.map((s) => s.id)).toEqual([first.session_id])
    expect(listed.current_session_id).toBeNull()
    expect(listed.active).toBe(0)
    expect(listed.total).toBe(1)
    const ended = db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(first.session_id) as {
      ended_at: number | null
    }
    expect(ended.ended_at).not.toBeNull()
  })

  it('ends the current session when no session_id is given', async () => {
    const stored = parse<{ session_id: string }>(
      await handleTool('store_memory', { content: 'a fact', project_path: TEST_PROJECT })
    )

    const ended = parse<{ id: string; ended: boolean; ended_at: number | null }>(
      await handleTool('end_session', { project_path: TEST_PROJECT, summary: 'done' })
    )
    expect(ended.id).toBe(stored.session_id)
    expect(ended.ended).toBe(true)
    expect(ended.ended_at).not.toBeNull()

    const again = parse<{ ended: boolean; reason: string }>(
      await handleTool('end_session', { project_path: TEST_PROJECT })
    )
    expect(again.ended).toBe(false)
    expect(again.reason).toContain(TEST_PROJECT)
  })

  it('still ends a session by explicit id (backward compatible)', async () => {
    const stored = parse<{ session_id: string }>(
      await handleTool('store_memory', { content: 'another fact', project_path: TEST_PROJECT })
    )
    const ended = parse<{ id: string; ended_at: number | null }>(
      await handleTool('end_session', { session_id: stored.session_id })
    )
    expect(ended.id).toBe(stored.session_id)
    expect(ended.ended_at).not.toBeNull()
  })

  it('filters and limits the session list', async () => {
    const db = getDatabase().db
    const ids = db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)')
    for (let i = 0; i < 3; i++) ids.run(`s-${i}`, TEST_PROJECT, Date.now() + i)
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(Date.now(), 's-0')

    const listed = parse<{ sessions: SessionRow[]; total: number; active: number }>(
      await handleTool('list_sessions', { project_path: TEST_PROJECT, active_only: true, limit: 1 })
    )
    expect(listed.total).toBe(3)
    expect(listed.active).toBe(2)
    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0].ended_at).toBeNull()
  })
})
