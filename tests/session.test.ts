import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { SessionManager } from '../src/session/manager.js'
import { createTestDb } from './helpers.js'

describe('SessionManager', () => {
  let db: Database.Database
  let manager: SessionManager

  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    manager = new SessionManager(db)
  })

  it('starts a session with a provided project_path', async () => {
    const session = await manager.start({ project_path: '/my/project', tool_name: 'claude-code' })

    expect(session.id).toBeTruthy()
    expect(session.project_path).toBe('/my/project')
    expect(session.tool_name).toBe('claude-code')
    expect(session.started_at).toBeGreaterThan(0)
    expect(session.ended_at).toBeNull()
    expect(session.summary).toBeNull()
  })

  it('retrieves a session by id', async () => {
    const session = await manager.start({ project_path: '/my/project' })
    const retrieved = manager.getById(session.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe(session.id)
  })

  it('returns null for unknown session id', () => {
    expect(manager.getById('ghost-id')).toBeNull()
  })

  it('ends a session with summary', async () => {
    const session = await manager.start({ project_path: '/my/project' })
    const ended = manager.end(session.id, 'Completed the feature')

    expect(ended).not.toBeNull()
    expect(ended!.ended_at).toBeGreaterThan(0)
    expect(ended!.summary).toBe('Completed the feature')
  })

  it('ends a session without summary', async () => {
    const session = await manager.start({ project_path: '/my/project' })
    const ended = manager.end(session.id)

    expect(ended).not.toBeNull()
    expect(ended!.ended_at).toBeGreaterThan(0)
    expect(ended!.summary).toBeNull()
  })

  it('returns null when ending non-existent session', () => {
    expect(manager.end('no-such-id', 'summary')).toBeNull()
  })

  it('getCurrentSession returns active session', async () => {
    const project = '/current/project'
    const session = await manager.start({ project_path: project })

    const current = manager.getCurrentSession(project)
    expect(current).not.toBeNull()
    expect(current!.id).toBe(session.id)
  })

  it('getCurrentSession returns null after session ends', async () => {
    const project = '/finished/project'
    const session = await manager.start({ project_path: project })
    manager.end(session.id, 'done')

    expect(manager.getCurrentSession(project)).toBeNull()
  })

  it('getCurrentSession returns null for unknown project', () => {
    expect(manager.getCurrentSession('/unknown/project')).toBeNull()
  })

  it('lists all sessions', async () => {
    await manager.start({ project_path: '/project-a' })
    await manager.start({ project_path: '/project-b' })
    await manager.start({ project_path: '/project-a' })

    expect(manager.list().length).toBe(3)
  })

  it('lists sessions filtered by project_path', async () => {
    await manager.start({ project_path: '/project-a' })
    await manager.start({ project_path: '/project-b' })
    await manager.start({ project_path: '/project-a' })

    const projectA = manager.list('/project-a')
    expect(projectA.length).toBe(2)
    expect(projectA.every((s) => s.project_path === '/project-a')).toBe(true)
  })

  it('handles multiple sessions for same project', async () => {
    const project = '/shared/project'
    await manager.start({ project_path: project })
    await manager.start({ project_path: project })

    expect(manager.getCurrentSession(project)).not.toBeNull()
    expect(manager.list(project).length).toBe(2)
  })
})
