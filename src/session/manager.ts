import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { Session, StartSessionInput } from './types.js'
import { detectProjectPath } from './detector.js'

interface SessionRow {
  id: string
  project_path: string
  started_at: number
  ended_at: number | null
  summary: string | null
  tool_name: string | null
}

function rowToSession(row: SessionRow): Session {
  return { ...row }
}

export class SessionManager {
  constructor(private readonly db: Database.Database) {}

  async start(input: StartSessionInput = {}): Promise<Session> {
    const project_path = input.project_path ?? (await detectProjectPath())
    const id = randomUUID()
    const now = Date.now()

    this.db
      .prepare(
        `INSERT INTO sessions (id, project_path, started_at, tool_name)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, project_path, now, input.tool_name ?? null)

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

  list(project_path?: string): Session[] {
    if (project_path) {
      const rows = this.db
        .prepare('SELECT * FROM sessions WHERE project_path = ? ORDER BY started_at DESC')
        .all(project_path) as SessionRow[]
      return rows.map(rowToSession)
    }
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC')
      .all() as SessionRow[]
    return rows.map(rowToSession)
  }

  getCurrentSession(project_path: string): Session | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE project_path = ? AND ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get(project_path) as SessionRow | undefined
    return row ? rowToSession(row) : null
  }
}
