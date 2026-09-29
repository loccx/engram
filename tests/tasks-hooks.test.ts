import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOOK_EVENTS,
  hookEventName,
  lastAssistantText,
  renderHook,
  runHookProcess,
  subagentSummary,
} from '../src/delivery/hook.js'
import { planSetup, defaultContext } from '../src/delivery/setup.js'
import { findAgent } from '../src/delivery/registry.js'

const NS = '/work/engram'
const stateDirs: string[] = []

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-hook-state-'))
  stateDirs.push(dir)
  return dir
}

function hookEnv(): NodeJS.ProcessEnv {
  return { ENGRAM_DEFAULT_NAMESPACE: NS }
}

afterEach(() => {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Recorded {
  url: string
  body: Record<string, unknown>
}

function fakeFetch(
  payload: unknown,
  options: { fail?: boolean; hang?: boolean; requests?: Recorded[] } = {}
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    options.requests?.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    if (options.hang) return new Promise<Response>(() => {})
    if (options.fail) throw new Error('connect ECONNREFUSED 127.0.0.1:8888')
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const briefPayload = {
  briefs: [
    {
      task_id: 't1',
      title: 'wire the working tier',
      status: 'open',
      for: 'session',
      brief: { text: '[open] wire the working tier\nplan:\n- [active] brief renderer', budget_chars: 1200, used_chars: 62, omitted: [] },
    },
  ],
}

describe('hook events', () => {
  it('covers the lifecycle events a host with hooks actually has', () => {
    expect([...HOOK_EVENTS]).toEqual([
      'session-start',
      'pre-tool-use',
      'pre-compact',
      'post-compact',
      'subagent-start',
      'subagent-stop',
      'session-end',
    ])
    expect(HOOK_EVENTS.map(hookEventName)).toEqual([
      'SessionStart',
      'PreToolUse',
      'PreCompact',
      'PostCompact',
      'SubagentStart',
      'SubagentStop',
      'SessionEnd',
    ])
  })

  it('registers every event setup writes in the hosts own spelling', () => {
    const entry = findAgent('claude-code')!
    const plan = planSetup(entry, { ...defaultContext(), home: stateDir() })

    const settings = plan.ops.find((op) => op.path.endsWith('.claude/settings.json'))!
    const doc = JSON.parse(settings.after ?? '{}') as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    }

    expect(Object.keys(doc.hooks).sort()).toEqual([
      'PostCompact',
      'PreCompact',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'SubagentStart',
      'SubagentStop',
    ])
    expect(doc.hooks.PreCompact[0].matcher).toBe('manual|auto')
    expect(doc.hooks.PreCompact[0].hooks[0].command).toContain('hook pre-compact --host claude-code')
    expect(doc.hooks.SessionEnd[0].hooks[0].command).toContain('hook session-end --host claude-code')
    expect(doc.hooks.SubagentStart[0].hooks[0].command).toContain('hook subagent-start --host claude-code')
  })

  it('leaves hosts without a verified hook surface with no hooks', () => {
    expect(findAgent('codex')?.hooks).toBeNull()
    expect(findAgent('cursor')?.hooks).toBeNull()
  })
})

describe('pre-compact', () => {
  it('checkpoints the open tasks and prints nothing: compaction is the host decision', async () => {
    const requests: Recorded[] = []
    const out = await renderHook(
      'pre-compact',
      { cwd: NS, session_id: 's1', trigger: 'auto' },
      { env: hookEnv(), fetchImpl: fakeFetch({ task_ids: ['t1'], events: 1, enqueued: 4 }, { requests }) }
    )

    expect(out).toBe('')
    expect(requests[0].url).toContain('/delivery/task-checkpoint')
    expect(requests[0].body).toEqual({ namespace: NS, session_id: 's1', reason: 'auto' })
  })

  it('says nothing when the daemon is down', async () => {
    const out = await renderHook('pre-compact', { cwd: NS }, { env: hookEnv(), fetchImpl: fakeFetch(null, { fail: true }) })
    expect(out).toBe('')
  })

  it('gives up at the deadline rather than holding the host', async () => {
    const out = await runHookProcess('pre-compact', {
      env: hookEnv(),
      stdin: JSON.stringify({ cwd: NS }),
      fetchImpl: fakeFetch(null, { hang: true }),
      timeoutMs: 30,
    })
    expect(out).toBe('')
  })
})

describe('post-compact', () => {
  it('re-injects the open task brief', async () => {
    const requests: Recorded[] = []
    const out = await renderHook(
      'post-compact',
      { cwd: NS, session_id: 's1' },
      { env: hookEnv(), fetchImpl: fakeFetch(briefPayload, { requests }) }
    )

    expect(out).toContain('[open] wire the working tier')
    expect(out).toContain('- [active] brief renderer')
    expect(requests[0].url).toContain('/delivery/task-brief')
    expect(requests[0].body).toMatchObject({ namespace: NS, for: 'session', limit: 1 })
  })

  it('wraps the brief in the host envelope when the host parses json', async () => {
    const out = await renderHook(
      'post-compact',
      { cwd: NS, session_id: 's1' },
      { env: hookEnv(), host: 'claude-code', fetchImpl: fakeFetch(briefPayload) }
    )

    const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostCompact')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('brief renderer')
  })

  it('injects nothing when no task is open', async () => {
    const out = await renderHook(
      'post-compact',
      { cwd: NS },
      { env: hookEnv(), fetchImpl: fakeFetch({ briefs: [] }) }
    )
    expect(out).toBe('')
  })
})

describe('subagent-start', () => {
  it('injects a handoff brief sized for a subagent', async () => {
    const requests: Recorded[] = []
    const out = await renderHook(
      'subagent-start',
      { cwd: NS, session_id: 's1', agent_type: 'worker' },
      { env: hookEnv(), fetchImpl: fakeFetch(briefPayload, { requests }) }
    )

    expect(out).toContain('[open] wire the working tier')
    expect(requests[0].body).toMatchObject({ for: 'subagent', limit: 1, budget_chars: 900 })
  })

  it('stays silent when the daemon is slow', async () => {
    const out = await runHookProcess('subagent-start', {
      env: hookEnv(),
      stdin: JSON.stringify({ cwd: NS, agent_id: 'a1' }),
      fetchImpl: fakeFetch(null, { hang: true }),
      timeoutMs: 30,
    })
    expect(out).toBe('')
  })
})

describe('subagent-stop', () => {
  it('records the returned summary as a progress note and prints nothing', async () => {
    const requests: Recorded[] = []
    const out = await renderHook(
      'subagent-stop',
      {
        cwd: NS,
        session_id: 's1',
        agent_id: 'a1',
        agent_type: 'worker',
        last_assistant_message: '  migration 016 landed, tests green  ',
      },
      { env: hookEnv(), fetchImpl: fakeFetch({ recorded: true, task_id: 't1' }, { requests }) }
    )

    expect(out).toBe('')
    expect(requests[0].url).toContain('/delivery/task-progress')
    expect(requests[0].body).toEqual({
      namespace: NS,
      session_id: 's1',
      text: 'migration 016 landed, tests green',
      author: 'worker',
    })
  })

  it('reads the summary out of the transcript when the host hands over a path', async () => {
    const dir = stateDir()
    const transcript = join(dir, 'agent.jsonl')
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } }),
        'not json at all',
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the returned summary' }] } }),
      ].join('\n')
    )

    const requests: Recorded[] = []
    await renderHook(
      'subagent-stop',
      { cwd: NS, session_id: 's1', agent_transcript_path: transcript },
      { env: hookEnv(), fetchImpl: fakeFetch({ recorded: true, task_id: 't1' }, { requests }) }
    )

    expect(lastAssistantText(transcript)).toBe('the returned summary')
    expect(requests[0].body.text).toBe('the returned summary')
  })

  it('asks for nothing when the host hands over no summary', async () => {
    const requests: Recorded[] = []
    const out = await renderHook(
      'subagent-stop',
      { cwd: NS, session_id: 's1' },
      { env: hookEnv(), fetchImpl: fakeFetch({ recorded: false }, { requests }) }
    )

    expect(out).toBe('')
    expect(requests).toEqual([])
  })

  it('bounds a long summary and flattens its newlines', () => {
    const summary = subagentSummary({ last_assistant_message: `a\n\nb ${'x'.repeat(2000)}` }, 50)
    expect(summary.startsWith('a b x')).toBe(true)
    expect(summary.length).toBe(50)
    expect(subagentSummary({}, 50)).toBe('')
  })
})

describe('session-end', () => {
  it('asks the daemon to close the session and prints nothing', async () => {
    const requests: Recorded[] = []
    const out = await renderHook(
      'session-end',
      { cwd: NS, session_id: 's1', reason: 'exit' },
      { env: hookEnv(), fetchImpl: fakeFetch({ ended: true, session_id: 's1' }, { requests }) }
    )

    expect(out).toBe('')
    expect(requests[0].url).toContain('/delivery/session-end')
    // the host session id is not an engram session id, so it is never sent
    expect(requests[0].body).toEqual({ namespace: NS, summary: 'exit' })
  })

  it('fails open on a dead daemon', async () => {
    const out = await runHookProcess('session-end', {
      env: hookEnv(),
      stdin: JSON.stringify({ cwd: NS, session_id: 's1' }),
      fetchImpl: fakeFetch(null, { fail: true }),
    })
    expect(out).toBe('')
  })
})

describe('session-start with a task open', () => {
  it('injects the rules, the brief and the roster', async () => {
    const out = await renderHook(
      'session-start',
      { cwd: NS, session_id: 's1', source: 'compact' },
      {
        env: hookEnv(),
        fetchImpl: fakeFetch({ entries: [], briefs: briefPayload.briefs }),
      }
    )

    expect(out).toContain('engram memory is available')
    expect(out).toContain('- [active] brief renderer')
  })

  it('uses a cue-state directory only where it needs one', async () => {
    const out = await renderHook(
      'session-start',
      { cwd: NS, session_id: 's1' },
      { env: hookEnv(), stateDir: stateDir(), fetchImpl: fakeFetch({ entries: [], briefs: [] }) }
    )
    expect(out).toContain('engram memory is available')
  })
})

describe('lifecycle hooks against an authenticated daemon', () => {
  it('sends the bearer token on every task route, not only roster and cue', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const recording = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
      return new Response(JSON.stringify({ briefs: [], entries: [], task_ids: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const env = { ...hookEnv(), ENGRAM_AUTH_TOKEN: 'inert-test-token' }

    for (const event of ['pre-compact', 'post-compact', 'subagent-start', 'session-end'] as const) {
      await renderHook(event, { cwd: NS, session_id: 's1' }, { env, stateDir: stateDir(), fetchImpl: recording })
    }

    expect(seen.length).toBeGreaterThanOrEqual(4)
    for (const request of seen) expect(request.auth).toBe('Bearer inert-test-token')
  })
})
