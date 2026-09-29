import { describe, it, expect } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { createTask, getTask, updateTask, type Task } from '../src/tasks/store.js'
import { DEFAULT_BRIEF_CHARS, brief, handoff } from '../src/tasks/brief.js'

const NS = '/work/engram'

function seeded(database: Database.Database): Task {
  const created = createTask(database, {
    namespace: NS,
    title: 'wire the working tier',
    goal: 'tasks survive compaction and hand off',
    plan: ['migration 016', 'brief renderer', 'hooks'],
    artifacts: ['src/tasks/store.ts'],
    open_questions: ['does the host read post-compact stdout?'],
    now: 1_000,
  })
  updateTask(
    database,
    created.id,
    {
      plan: [{ id: 'p1', status: 'done' }, { id: 'p2', status: 'active' }],
      progress: ['migration landed', 'renderer drafted'],
    },
    { now: 1_060_000 }
  )
  return getTask(database, created.id)!
}

describe('brief', () => {
  it('is deterministic: the same task renders the same bytes twice', () => {
    const task = seeded(createTestDb().db)

    const first = brief(task)
    const second = brief(task)

    expect(first.text).toBe(second.text)
    expect(first.used_chars).toBe(first.text.length)
    expect(first.omitted).toEqual([])
  })

  it('renders goal, plan with status, recent progress, questions and artifacts', () => {
    const text = brief(seeded(createTestDb().db)).text

    expect(text).toContain('[open] wire the working tier')
    expect(text).toContain('goal: tasks survive compaction and hand off')
    expect(text).toContain('- [done] migration 016')
    expect(text).toContain('- [active] brief renderer')
    expect(text).toContain('progress:')
    expect(text).toContain('renderer drafted')
    expect(text).toContain('open questions:')
    expect(text).toContain('artifacts:')
  })

  it('keeps only the last five progress notes', () => {
    const database = createTestDb().db
    const task = seeded(database)
    updateTask(database, task.id, { progress: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'] })

    const text = brief(getTask(database, task.id)!).text

    expect(text).toContain('n7')
    expect(text).toContain('n3')
    expect(text).not.toContain('n2')
  })

  it('never exceeds the budget it is given', () => {
    const task = seeded(createTestDb().db)

    for (const budget of [80, 160, 240, 400, 600, DEFAULT_BRIEF_CHARS]) {
      const rendered = brief(task, budget)
      expect(rendered.used_chars, `budget ${budget}`).toBeLessThanOrEqual(budget)
      expect(rendered.text.length, `budget ${budget}`).toBeLessThanOrEqual(budget)
    }
  })

  it('drops whole sections rather than cutting a task mid-sentence', () => {
    const tight = brief(seeded(createTestDb().db), 150)

    expect(tight.text).toContain('goal:')
    expect(tight.omitted).toContain('artifacts')
    expect(tight.used_chars).toBeLessThanOrEqual(150)
  })

  it('renders empty for a budget of zero instead of throwing', () => {
    const rendered = brief(seeded(createTestDb().db), 0)
    expect(rendered.text).toBe('')
    expect(rendered.used_chars).toBe(0)
  })
})

describe('handoff', () => {
  it('names its audience and leads with what the reader should do', () => {
    const task = seeded(createTestDb().db)

    const subagent = handoff(task, 'subagent')
    const fresh = handoff(task, 'new-session')

    expect(subagent.task_id).toBe(task.id)
    expect(subagent.for).toBe('subagent')
    expect(subagent.text.startsWith('engram task brief for a subagent')).toBe(true)
    expect(fresh.text.startsWith('engram task brief for a new session')).toBe(true)
  })

  it('trims a subagent brief to the unfinished work and the last progress note', () => {
    const database = createTestDb().db
    const task = seeded(database)
    updateTask(database, task.id, { progress: ['third'], plan: [{ id: 'p3', status: 'done' }] })

    const text = handoff(getTask(database, task.id)!, 'subagent').text

    expect(text).toContain('- [active] brief renderer')
    expect(text).not.toContain('migration 016')
    expect(text).toContain('third')
    expect(text).not.toContain('renderer drafted')
    expect(text).toContain('open questions:')
  })

  it('carries the state a fresh session needs, including the finished steps', () => {
    const text = handoff(seeded(createTestDb().db), 'new-session').text

    expect(text).toContain('- [done] migration 016')
    expect(text).toContain('- [active] brief renderer')
    expect(text).toContain('renderer drafted')
    expect(text).toContain('artifacts:')
  })

  it('is deterministic and bounded like the brief', () => {
    const task = seeded(createTestDb().db)

    const first = handoff(task, 'new-session', 300)
    const second = handoff(task, 'new-session', 300)

    expect(first.text).toBe(second.text)
    expect(first.used_chars).toBeLessThanOrEqual(300)
  })

  it('refuses an audience it does not know', () => {
    const task = seeded(createTestDb().db)
    // @ts-expect-error the schema rejects this too; the renderer must not guess
    expect(() => handoff(task, 'everyone')).toThrow(/unknown handoff audience/)
  })
})
