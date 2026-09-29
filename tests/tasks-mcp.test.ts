import { describe, it, expect, beforeEach } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { SCHEMAS } from '../src/mcp/schemas.js'
import { tools } from '../src/mcp/tools.js'
import type { Task } from '../src/tasks/types.js'

const TEST_PROJECT = '/home/user/tasks-project'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function parse<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T
}

async function start(extra: Record<string, unknown> = {}): Promise<Task> {
  const result = parse<{ task: Task }>(
    await handleTool('task_start', {
      project_path: TEST_PROJECT,
      title: 'wire the working tier',
      goal: 'tasks survive compaction',
      plan: ['migration 016', 'brief renderer'],
      ...extra,
    })
  )
  return result.task
}

describe('task tools', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('registers every working-tier tool with a schema and an object input', () => {
    const names = ['task_start', 'task_update', 'task_get', 'task_close', 'task_handoff', 'session_start']
    for (const name of names) {
      expect(SCHEMAS[name], `${name} schema`).toBeDefined()
      const tool = tools.find((entry) => entry.name === name)
      expect(tool, `${name} definition`).toBeDefined()
      expect(tool?.inputSchema.type).toBe('object')
      expect(tool?.description.length, `${name} description`).toBeGreaterThan(80)
    }
  })

  it('opens a task for the resolved namespace and reads it back', async () => {
    const task = await start({ open_questions: ['does the host read post-compact stdout?'] })

    expect(task.namespace).toBe(TEST_PROJECT)
    expect(task.status).toBe('open')

    const read = parse<{ task: Task; namespace: string }>(await handleTool('task_get', { id: task.id }))
    expect(read.task).toEqual(task)

    const listed = parse<{ tasks: Task[] }>(
      await handleTool('task_get', { project_path: TEST_PROJECT })
    )
    expect(listed.tasks.map((row) => row.id)).toEqual([task.id])
  })

  it('returns the applied delta and the event log on request', async () => {
    const task = await start()

    const updated = parse<{ task: Task; applied: Record<string, unknown> }>(
      await handleTool('task_update', {
        id: task.id,
        plan: [{ id: 'p1', status: 'active' }],
        progress: ['renderer drafted'],
      })
    )

    expect(updated.applied).toEqual({ plan: [{ id: 'p1', status: 'active' }], progress: ['renderer drafted'] })
    expect(updated.task.plan[0].status).toBe('active')

    const withEvents = parse<{ events: Array<{ kind: string; payload: Record<string, unknown> }> }>(
      await handleTool('task_get', { id: task.id, include_events: true })
    )
    expect(withEvents.events.map((event) => event.kind)).toEqual(['update', 'update'])
    expect(withEvents.events[1].payload).toEqual(updated.applied)
  })

  it('refuses a task id from another namespace when the call declares its own', async () => {
    const task = await start()

    const result = await handleTool('task_update', {
      id: task.id,
      status: 'done',
      project_path: '/home/user/somewhere-else',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('belongs to')
  })

  it('rejects a malformed delta at the schema boundary', async () => {
    const task = await start()

    const result = await handleTool('task_update', { id: task.id, status: 'shipped' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Validation failed')
  })

  it('answers with an error for an id it does not have', async () => {
    const result = await handleTool('task_get', { id: 'not-a-task' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not found')
  })

  it('hands off a bounded brief and logs the handoff', async () => {
    const task = await start()
    await handleTool('task_update', { id: task.id, progress: ['renderer drafted'] })

    const brief = parse<{ task_id: string; for: string; text: string; used_chars: number; budget_chars: number }>(
      await handleTool('task_handoff', { id: task.id, for: 'new-session', budget_chars: 300 })
    )

    expect(brief.for).toBe('new-session')
    expect(brief.task_id).toBe(task.id)
    expect(brief.used_chars).toBeLessThanOrEqual(300)
    expect(brief.text).toContain('renderer drafted')

    const events = parse<{ events: Array<{ kind: string }> }>(
      await handleTool('task_get', { id: task.id, include_events: true })
    )
    expect(events.events.map((event) => event.kind)).toEqual(['update', 'update', 'handoff'])
  })

  it('closes a task by writing exactly one summary memory through the store', async () => {
    const task = await start()
    await handleTool('task_update', { id: task.id, plan: [{ id: 'p1', status: 'done' }] })

    const closed = parse<{ task: Task; closed: boolean; memory: { status: string; id?: string } }>(
      await handleTool('task_close', { id: task.id, summary: 'shipped behind the task tools' })
    )

    expect(closed.closed).toBe(true)
    expect(closed.task.status).toBe('done')
    expect(closed.memory.status).toBe('stored')
    expect(closed.memory.id).toBeTruthy()

    const listed = parse<{ memories: Array<{ id: string; content: string; type: string; tags: string[] }> }>(
      await handleTool('list_memories', { project_path: TEST_PROJECT })
    )
    expect(listed.memories).toHaveLength(1)
    expect(listed.memories[0].content).toContain('wire the working tier')
    expect(listed.memories[0].content).toContain('shipped behind the task tools')
    expect(listed.memories[0].tags).toContain('task-summary')
    expect(listed.memories[0].tags).toContain(task.id)

    const again = parse<{ closed: boolean; reason: string }>(
      await handleTool('task_close', { id: task.id })
    )
    expect(again.closed).toBe(false)
    expect(again.reason).toContain('already done')

    const memories = parse<{ memories: unknown[] }>(
      await handleTool('list_memories', { project_path: TEST_PROJECT })
    )
    expect(memories.memories).toHaveLength(1)
  })

  it('never returns working state from a search', async () => {
    const task = await start({ goal: 'zebra-compaction-survival checkpoint everest' })

    const found = parse<{ memories: unknown[]; results?: unknown[] }>(
      await handleTool('search_memories', {
        project_path: TEST_PROJECT,
        query: 'zebra-compaction-survival checkpoint everest',
      })
    )
    const context = parse<{ memories: unknown[] }>(
      await handleTool('get_context', { project_path: TEST_PROJECT })
    )

    expect(found.results ?? found.memories).toEqual([])
    expect(context.memories).toEqual([])
    expect(
      getDatabase().db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(task.id)
    ).toEqual({ n: 1 })
  })

  it('primes a session with the rules, the open task brief and the roster', async () => {
    const task = await start()
    await handleTool('task_update', { id: task.id, progress: ['renderer drafted'] })

    const payload = parse<{
      rules: string
      digest: string | null
      tasks: Array<{ task_id: string; brief: { text: string } }>
      roster: unknown[]
      used_chars: number
      budget_chars: number
    }>(await handleTool('session_start', { project_path: TEST_PROJECT }))

    expect(payload.rules).toContain('engram memory is available')
    expect(payload.budget_chars).toBe(2400)
    expect(payload.tasks).toHaveLength(1)
    expect(payload.tasks[0].task_id).toBe(task.id)
    expect(payload.tasks[0].brief.text).toContain('renderer drafted')
    expect(payload.used_chars).toBeLessThanOrEqual(payload.budget_chars)
  })

  it('keeps the priming payload inside a budget too small for everything', async () => {
    const task = await start()
    await handleTool('task_update', { id: task.id, progress: ['x'.repeat(2_000)] })

    const payload = parse<{ rules: string; used_chars: number; budget_chars: number; truncated: string[] }>(
      await handleTool('session_start', { project_path: TEST_PROJECT, budget_chars: 200 })
    )

    expect(payload.rules.length).toBeLessThanOrEqual(200)
    expect(payload.used_chars).toBeLessThanOrEqual(payload.budget_chars)
    expect(payload.truncated).toContain('tasks')
  })
})
