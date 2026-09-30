import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { Session, StartSessionInput } from './types.js'
import { detectProjectPath } from './detector.js'
import { currentCaller, type CallerScope } from '../memory/access.js'

interface SessionRow {
  id: string
  project_path: string
  started_at: number
  ended_at: number | null
  summary: string | null
  tool_name: string | null
  owner_principal?: string | null
}

function rowToSession(row: SessionRow): Session {
  return { ...row, owner_principal: row.owner_principal ?? null }
}

/** a session belongs to whoever opened it; the local owner's own is the null owner */
function ownerPredicate(caller: CallerScope): { sql: string; params: unknown[] } {
  return { sql: 'owner_principal IS ?', params: [caller.localOwner ? null : caller.principalId] }
}

const DEFAULT_SESSION_IDLE_MS = 12 * 60 * 60 * 1000

// the idle window is ENGRAM_SESSION_IDLE_MS, and 0 disables the sweep entirely; without
// it a session opened by store_memory stays open, since nothing else ends one
// and everything gated on end_session never ran.
export function sessionIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ENGRAM_SESSION_IDLE_MS?.trim()
  if (!raw) return DEFAULT_SESSION_IDLE_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SESSION_IDLE_MS
  return parsed
}

export class SessionManager {
  constructor(private readonly db: Database.Database) {}

  async start(input: StartSessionInput = {}): Promise<Session> {
    const project_path = input.project_path ?? (await detectProjectPath())
    const id = randomUUID()
    const now = Date.now()
    const caller = currentCaller()

    this.db
      .prepare(
        `INSERT INTO sessions (id, project_path, started_at, tool_name, owner_principal)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, project_path, now, input.tool_name ?? null, caller.localOwner ? null : caller.principalId)

    return this.getById(id)!
  }

  end(id: string, summary?: string): Session | null {
    const session = this.getById(id)
    if (!session) return null

    this.db
      .prepare('UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?')
      .run(Date.now(), summary ?? null, id)

    return this.getById(id)
  }

  getById(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return row ? rowToSession(row) : null
  }

  list(project_path?: string, caller: CallerScope = currentCaller()): Session[] {
    const owner = ownerPredicate(caller)
    if (project_path) {
      const rows = this.db
        .prepare(
          `SELECT * FROM sessions WHERE project_path = ? AND ${owner.sql} ORDER BY started_at DESC`
        )
        .all(project_path, ...owner.params) as SessionRow[]
      return rows.map(rowToSession)
    }
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE ${owner.sql} ORDER BY started_at DESC`)
      .all(...owner.params) as SessionRow[]
    return rows.map(rowToSession)
  }

  /** read-only: sweepIdle performs the writes */
  idleSessions(now: number = Date.now(), idleMs: number = sessionIdleMs()): Session[] {
    if (idleMs <= 0) return []
    const cutoff = now - idleMs
    const rows = this.db
      .prepare(
        `SELECT s.* FROM sessions s
         WHERE s.ended_at IS NULL
           AND s.started_at < ?
           AND COALESCE(
                 (SELECT MAX(m.created_at) FROM memories m WHERE m.session_id = s.id),
                 s.started_at
               ) < ?
         ORDER BY s.started_at ASC`
      )
      .all(cutoff, cutoff) as SessionRow[]
    return rows.map(rowToSession)
  }

/**
   * returns the closed rows so the caller can enqueue the maintenance they gate;
   * idempotent, since closed sessions are excluded.
   */
  sweepIdle(now: number = Date.now(), idleMs: number = sessionIdleMs()): Session[] {
    const ended: Session[] = []
    for (const session of this.idleSessions(now, idleMs)) {
      const closed = this.end(session.id, 'auto-ended: idle')
      if (closed) ended.push(closed)
    }
    return ended
  }

  getCurrentSession(project_path: string, caller: CallerScope = currentCaller()): Session | null {
    const owner = ownerPredicate(caller)
    const row = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE project_path = ? AND ended_at IS NULL AND ${owner.sql}
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get(project_path, ...owner.params) as SessionRow | undefined
    return row ? rowToSession(row) : null
  }
}
