import { describe, it, expect } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import {
  checkpointTask,
  closeTask,
  createTask,
  getTask,
  listOpenTasks,
  listTaskEvents,
  listTasks,
  taskSummary,
  updateTask,
} from '../src/tasks/store.js'

const NS = '/work/engram'
const OTHER = '/work/other'

function db(): Database.Database {
  return createTestDb().db
}

function open(
  database: Database.Database,
  extra: Partial<Parameters<typeof createTask>[1]> = {}
): ReturnType<typeof createTask> {
  return createTask(database, {
    namespace: NS,
    title: 'wire the working tier',
    goal: 'tasks survive compaction and hand off',
    plan: ['migration 016', 'brief renderer'],
    now: 1_000,
    ...extra,
  })
}

describe('task store', () => {
  it('opens a task with a plan, artifacts and open questions', () => {
    const database = db()
    const task = open(database, {
      artifacts: ['src/tasks/store.ts', 'src/tasks/store.ts'],
      open_questions: ['does the host read post-compact stdout?'],
    })

    expect(task.status).toBe('open')
    expect(task.plan.map((item) => item.id)).toEqual(['p1', 'p2'])
    expect(task.plan.map((item) => item.text)).toEqual(['migration 016', 'brief renderer'])
    expect(task.plan.map((item) => item.status)).toEqual(['pending', 'pending'])
    expect(task.artifacts).toEqual(['src/tasks/store.ts'])
    expect(task.open_questions).toHaveLength(1)
    expect(task.created_at).toBe(1_000)
    expect(task.closed_at).toBeNull()
    expect(getTask(database, task.id)).toEqual(task)
  })

  it('logs the creation as the first event of the audit trail', () => {
    const database = db()
    const task = open(database)

    expect(listTaskEvents(database, task.id)).toEqual([
      { id: 1, task_id: task.id, kind: 'update', payload: { created: true }, author: null, created_at: 1_000 },
    ])
  })

  it('treats every update as a delta and records it as one event', () => {
    const database = db()
    const task = open(database)

    const first = updateTask(
      database,
      task.id,
      { plan: [{ id: 'p1', status: 'done' }], progress: ['migration landed'] },
      { author: 'lane-a1', now: 2_000 }
    )
    const second = updateTask(database, task.id, { status: 'blocked' }, { now: 3_000 })

    expect(first?.applied).toEqual({
      plan: [{ id: 'p1', status: 'done' }],
      progress: ['migration landed'],
    })
    expect(first?.task.progress).toEqual([{ text: 'migration landed', author: 'lane-a1', created_at: 2_000 }])
    expect(second?.applied).toEqual({ status: 'blocked' })
    expect(second?.task.progress).toHaveLength(1)

    const events = listTaskEvents(database, task.id)
    expect(events.map((event) => event.kind)).toEqual(['update', 'update', 'update'])
    expect(events[1].payload).toEqual(first?.applied)
    expect(events[1].author).toBe('lane-a1')
    expect(events[2].payload).toEqual({ status: 'blocked' })
  })

  it('addresses plan items by id and appends the ones without one', () => {
    const database = db()
    const task = open(database)

    const updated = updateTask(database, task.id, {
      plan: [{ id: 'p2', text: 'brief renderer with a budget', status: 'active' }, { text: 'hooks' }],
    })

    expect(updated?.task.plan).toEqual([
      { id: 'p1', text: 'migration 016', status: 'pending' },
      { id: 'p2', text: 'brief renderer with a budget', status: 'active' },
      { id: 'p3', text: 'hooks', status: 'pending' },
    ])
  })

  it('refuses a plan delta for an item the task does not have', () => {
    const database = db()
    const task = open(database)

    expect(() => updateTask(database, task.id, { plan: [{ id: 'p9', status: 'done' }] })).toThrow(
      /plan item p9 is not in task/
    )
  })

  it('logs nothing when a delta changes nothing', () => {
    const database = db()
    const task = open(database)

    const result = updateTask(database, task.id, { progress: ['   '], artifacts: [], status: 'open' })

    expect(result?.applied).toEqual({})
    expect(listTaskEvents(database, task.id)).toHaveLength(1)
  })

  it('keeps one progress note per distinct text and removes resolved questions', () => {
    const database = db()
    const task = open(database, { open_questions: ['a?', 'b?'] })

    updateTask(database, task.id, { open_questions: ['a?', 'c?'], resolved_questions: ['a?'] })

    expect(getTask(database, task.id)?.open_questions).toEqual(['b?', 'c?'])
  })

  it('stamps closed_at when the status finishes the task and clears it when it reopens', () => {
    const database = db()
    const task = open(database)

    const closed = updateTask(database, task.id, { status: 'done' }, { now: 5_000 })
    expect(closed?.task.closed_at).toBe(5_000)

    const reopened = updateTask(database, task.id, { status: 'open' }, { now: 6_000 })
    expect(reopened?.task.closed_at).toBeNull()
    expect(reopened?.task.status).toBe('open')
  })

  it('lists open tasks per namespace, preferring the session that asked', () => {
    const database = db()
    const older = open(database, { title: 'older', session_id: 's1', now: 1_000 })
    const newer = open(database, { title: 'newer', session_id: 's2', now: 2_000 })
    open(database, { namespace: OTHER, title: 'elsewhere' })
    updateTask(database, older.id, { status: 'done' }, { now: 500 })

    expect(listOpenTasks(database, NS).map((task) => task.title)).toEqual(['newer'])
    expect(listOpenTasks(database, NS, { sessionId: 's2' })[0].id).toBe(newer.id)
    expect(listTasks(database, { namespace: NS }).map((task) => task.title)).toEqual(['newer', 'older'])
    expect(listTasks(database, { namespace: OTHER })).toHaveLength(1)
  })

  it('checkpoints without changing the task, and records what the task holds', () => {
    const database = db()
    const task = open(database)
    updateTask(database, task.id, { plan: [{ id: 'p1', status: 'active' }], progress: ['started'] }, { now: 2_000 })
    const live = getTask(database, task.id)!

    const event = checkpointTask(database, task.id, { reason: 'pre-compact', now: 9_000 })

    expect(event?.kind).toBe('checkpoint')
    expect(event?.payload).toEqual({
      reason: 'pre-compact',
      status: 'open',
      plan_active: 1,
      progress_notes: 1,
      open_questions: 0,
    })
    const after = getTask(database, task.id)!
    expect(after.updated_at).toBe(live.updated_at)
    expect(after.progress).toHaveLength(1)
  })

  it('closes once: a second close writes no event and no second summary', () => {
    const database = db()
    const task = open(database)

    const first = closeTask(database, task.id, { status: 'done', summaryMemoryId: 'mem-1', now: 7_000 })
    const second = closeTask(database, task.id, { status: 'abandoned', now: 8_000 })

    expect(first?.status).toBe('done')
    expect(first?.closed_at).toBe(7_000)
    expect(second?.status).toBe('done')
    expect(second?.closed_at).toBe(7_000)
    const events = listTaskEvents(database, task.id)
    expect(events.filter((event) => event.kind === 'close')).toEqual([
      { id: 2, task_id: task.id, kind: 'close', payload: { status: 'done', summary_memory_id: 'mem-1' }, author: null, created_at: 7_000 },
    ])
  })

  it('refuses a close status that is not a finished one', () => {
    const database = db()
    const task = open(database)

    expect(() => closeTask(database, task.id, { status: 'open' })).toThrow(/close status "open"/)
  })

  it('summarises a finished task in one durable memory', () => {
    const database = db()
    const task = open(database, { open_questions: ['does the host read post-compact stdout?'] })
    updateTask(database, task.id, {
      plan: [{ id: 'p1', status: 'done' }],
      progress: ['migration landed'],
      artifacts: ['src/tasks/store.ts'],
    })
    closeTask(database, task.id, { status: 'done' })

    const summary = taskSummary(getTask(database, task.id)!, 'shipped behind task tools')

    expect(summary).toContain('task "wire the working tier" (done): tasks survive compaction')
    expect(summary).toContain('plan 1/2 done')
    expect(summary).toContain('unfinished: brief renderer')
    expect(summary).toContain('last progress: migration landed')
    expect(summary).toContain('open questions: does the host read post-compact stdout?')
    expect(summary).toContain('artifacts: src/tasks/store.ts')
    expect(summary).toContain('shipped behind task tools')
  })

  it('returns null for an id it does not have', () => {
    const database = db()
    expect(getTask(database, 'nope')).toBeNull()
    expect(updateTask(database, 'nope', { status: 'done' })).toBeNull()
    expect(closeTask(database, 'nope')).toBeNull()
    expect(checkpointTask(database, 'nope')).toBeNull()
  })
})
