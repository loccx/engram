import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { createServer } from '../src/server.js'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { resetServicesForTests } from '../src/mcp/handlers.js'
import { renderHook } from '../src/delivery/hook.js'
import type { Task } from '../src/tasks/types.js'

/**
 * the whole working tier over http: a task is opened and updated through mcp, a
 * compaction runs the two hooks against the same daemon, and the brief that comes back
 * after compaction has to carry the plan and the newest progress note.
 */

const NS = '/home/user/e2e-project'
const SESSION = 'host-session-1'

let server: Server
let base: string

function hookEnv(): NodeJS.ProcessEnv {
  return { ENGRAM_DEFAULT_NAMESPACE: NS, ENGRAM_DAEMON_URL: base }
}

interface ToolResponse {
  error?: string
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const body = (await res.json()) as {
    result?: { content: Array<{ text: string }>; isError?: boolean }
    error?: { message: string }
  }
  if (!body.result) throw new Error(body.error?.message ?? `no result for ${name}`)
  return JSON.parse(body.result.content[0].text) as ToolResponse
}

beforeAll(async () => {
  resetDatabase()
  resetServicesForTests()
  getDatabase(':memory:')
  server = serve({ fetch: createServer().fetch, port: 0 })
  await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
  resetDatabase()
})

describe('a task across a compaction', () => {
  it('survives the compaction, hands off and closes into one summary memory', async () => {
    const started = (await callTool('task_start', {
      project_path: NS,
      session_id: SESSION,
      title: 'wire the working tier',
      goal: 'task state survives compaction',
      plan: ['migration 016', 'brief renderer', 'hooks'],
      artifacts: ['src/tasks/store.ts'],
      open_questions: ['does the host read post-compact stdout?'],
    })) as { task: Task }

    expect(started.task.status).toBe('open')

    await callTool('task_update', {
      id: started.task.id,
      plan: [{ id: 'p1', status: 'done' }, { id: 'p2', status: 'active' }],
      progress: ['migration 016 landed', 'renderer drafted'],
      author: 'lane-a1',
    })

    // the host compacts: checkpoint first, then re-inject the brief
    const preCompact = await renderHook(
      'pre-compact',
      { cwd: NS, session_id: SESSION, trigger: 'auto' },
      { env: hookEnv() }
    )
    expect(preCompact).toBe('')

    const postCompact = await renderHook('post-compact', { cwd: NS, session_id: SESSION }, { env: hookEnv() })
    expect(postCompact).toContain('wire the working tier')
    expect(postCompact).toContain('- [done] migration 016')
    expect(postCompact).toContain('- [active] brief renderer')
    expect(postCompact).toContain('renderer drafted')
    expect(postCompact).toContain('does the host read post-compact stdout?')

    const afterCompaction = (await callTool('task_get', {
      id: started.task.id,
      include_events: true,
    })) as { task: Task; events: Array<{ kind: string }> }
    expect(afterCompaction.events.map((event) => event.kind)).toEqual(['update', 'update', 'checkpoint'])
    expect(afterCompaction.task.progress).toHaveLength(2)

    // a subagent picks the work up and reports back
    const subagentBrief = await renderHook(
      'subagent-start',
      { cwd: NS, session_id: SESSION, agent_id: 'a1', agent_type: 'worker' },
      { env: hookEnv() }
    )
    expect(subagentBrief).toContain('engram task brief for a subagent')
    expect(subagentBrief).toContain('brief renderer')

    const subagentStop = await renderHook(
      'subagent-stop',
      { cwd: NS, session_id: SESSION, agent_id: 'a1', agent_type: 'worker', last_assistant_message: 'renderer done, tests green' },
      { env: hookEnv() }
    )
    expect(subagentStop).toBe('')

    const withSubagent = (await callTool('task_get', { id: started.task.id })) as { task: Task }
    expect(withSubagent.task.progress.map((note) => note.text)).toEqual([
      'migration 016 landed',
      'renderer drafted',
      'renderer done, tests green',
    ])

    const handoff = (await callTool('task_handoff', {
      id: started.task.id,
      for: 'new-session',
      budget_chars: 400,
    })) as { text: string; used_chars: number; for: string }
    expect(handoff.for).toBe('new-session')
    expect(handoff.used_chars).toBeLessThanOrEqual(400)
    expect(handoff.text).toContain('renderer done, tests green')

    const closed = (await callTool('task_close', {
      id: started.task.id,
      summary: 'shipped behind the task tools',
    })) as { closed: boolean; task: Task; memory: { status: string; id?: string } }
    expect(closed.closed).toBe(true)
    expect(closed.task.status).toBe('done')
    expect(closed.memory.status).toBe('stored')

    const memories = (await callTool('list_memories', { project_path: NS })) as {
      memories: Array<{ id: string; content: string; type: string }>
    }
    expect(memories.memories).toHaveLength(1)
    expect(memories.memories[0].id).toBe(closed.memory.id)
    expect(memories.memories[0].content).toContain('wire the working tier')
    expect(memories.memories[0].content).toContain('shipped behind the task tools')

    // nothing is open any more, so a later compaction injects nothing
    const quiet = await renderHook('post-compact', { cwd: NS, session_id: SESSION }, { env: hookEnv() })
    expect(quiet).toBe('')

    const ended = await renderHook('session-end', { cwd: NS, session_id: SESSION }, { env: hookEnv() })
    expect(ended).toBe('')
    const session = getDatabase()
      .db.prepare('SELECT ended_at FROM sessions WHERE project_path = ?')
      .get(NS) as { ended_at: number | null } | undefined
    expect(session?.ended_at).toBeGreaterThan(0)
  })

  it('re-injects the closed task nowhere, but keeps its audit trail readable', async () => {
    const tasks = (await callTool('task_get', { project_path: NS, status: 'done' })) as { tasks: Task[] }
    expect(tasks.tasks).toHaveLength(1)

    const events = (await callTool('task_get', { id: tasks.tasks[0].id, include_events: true })) as {
      events: Array<{ kind: string; payload: Record<string, unknown> }>
    }
    const kinds = events.events.map((event) => event.kind)
    expect(kinds).toContain('handoff')
    expect(kinds).toContain('close')
    expect(events.events[events.events.length - 1].payload).toMatchObject({ status: 'done' })
  })
})
