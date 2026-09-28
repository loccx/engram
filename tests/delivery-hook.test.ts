import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_SLIM } from '../src/delivery/protocol.js'
import {
  HOOK_GUARD_ENV,
  formatForHost,
  renderHook,
  runHookProcess,
  toolPaths,
} from '../src/delivery/hook.js'
import { cueStatePath, readSeen } from '../src/delivery/cue-state.js'

const NS = '/work/engram'
const stateDirs: string[] = []

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-hook-state-'))
  stateDirs.push(dir)
  return dir
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

const env = { ENGRAM_DEFAULT_NAMESPACE: NS }

describe('session-start hook', () => {
  it('injects the standing rules and the namespace roster', async () => {
    const requests: Recorded[] = []
    const out = await renderHook(
      'session-start',
      { cwd: '/work/engram', session_id: 's1', source: 'startup' },
      {
        env,
        fetchImpl: fakeFetch(
          { entries: [{ id: 'a', type: 'decision', importance: 0.9, pinned: true, preview: 'the port is 8888' }] },
          { requests }
        ),
      }
    )

    expect(out.startsWith(PROTOCOL_SLIM)).toBe(true)
    expect(out).toContain('engram context for /work/engram')
    expect(out).toContain('- [decision] the port is 8888')
    expect(requests[0].url).toContain('/delivery/roster')
    expect(requests[0].body).toEqual({ namespace: NS })
  })

  it('re-injects on compact, which is the whole point of handling that source', async () => {
    const out = await renderHook(
      'session-start',
      { cwd: '/work/engram', session_id: 's1', source: 'compact' },
      { env, fetchImpl: fakeFetch({ entries: [] }) }
    )

    expect(out).toBe(PROTOCOL_SLIM)
  })

  it('still injects the rules when the store has nothing for this namespace', async () => {
    const out = await renderHook(
      'session-start',
      { cwd: '/work/engram', session_id: 's1', source: 'startup' },
      { env, fetchImpl: fakeFetch({ entries: [] }) }
    )

    expect(out).toBe(PROTOCOL_SLIM)
    expect(out).not.toContain('engram context for')
  })

  it('wraps the context for claude-code once, in the shape that host reads', async () => {
    const options = { env, fetchImpl: fakeFetch({ entries: [{ id: 'a', type: 'note', preview: 'x' }] }) }
    const text = await renderHook('session-start', { cwd: '/work/engram' }, { ...options })
    const json = await renderHook('session-start', { cwd: '/work/engram' }, { ...options, host: 'claude-code' })

    expect(JSON.parse(json)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    })
  })

  it('says nothing at all when the daemon is down', async () => {
    const out = await renderHook(
      'session-start',
      { cwd: '/work/engram', session_id: 's1' },
      { env, fetchImpl: fakeFetch(null, { fail: true }) }
    )
    expect(out).toBe('')
  })

  it('says nothing at all when the daemon is too slow', async () => {
    const out = await runHookProcess('session-start', {
      env: { ...env },
      stdin: JSON.stringify({ cwd: '/work/engram', session_id: 's1' }),
      fetchImpl: fakeFetch(null, { hang: true }),
      timeoutMs: 30,
    })
    expect(out).toBe('')
  })
})

describe('pre-tool-use hook', () => {
  const cue = {
    entries: [{ id: '7f3c1a2b-0000-4000-8000-000000000001', type: 'gotcha', content: 'exit 0 on every failure path', tags: [] }],
  }

  it('injects the memory that matches the file being touched', async () => {
    const out = await renderHook(
      'pre-tool-use',
      { cwd: '/work/engram', session_id: 's1', tool_name: 'Edit', tool_input: { file_path: '/work/engram/src/delivery/hook.ts' } },
      { env, stateDir: stateDir(), fetchImpl: fakeFetch(cue) }
    )

    expect(out).toContain('[gotcha] exit 0 on every failure path')
    expect(out).toContain('id 7f3c1a2b-0000-4000-8000-000000000001')
  })

  it('never injects the same memory twice in one session', async () => {
    const dir = stateDir()
    const input = {
      cwd: '/work/engram',
      session_id: 's1',
      tool_name: 'Read',
      tool_input: { file_path: '/work/engram/src/delivery/hook.ts' },
    }

    const first = await renderHook('pre-tool-use', input, { env, stateDir: dir, fetchImpl: fakeFetch(cue) })
    const second = await renderHook('pre-tool-use', input, { env, stateDir: dir, fetchImpl: fakeFetch(cue) })
    const other = await renderHook('pre-tool-use', { ...input, session_id: 's2' }, { env, stateDir: dir, fetchImpl: fakeFetch(cue) })

    expect(first).not.toBe('')
    expect(second).toBe('')
    expect(other).not.toBe('')
  })

  it('keeps the dedupe state in os.tmpdir, keyed by session', async () => {
    const dir = stateDir()
    await renderHook(
      'pre-tool-use',
      { cwd: '/work/engram', session_id: 's1', tool_input: { file_path: '/work/engram/src/delivery/hook.ts' } },
      { env, stateDir: dir, fetchImpl: fakeFetch(cue) }
    )

    expect(cueStatePath('s1', dir).startsWith(dir)).toBe(true)
    expect(readSeen(cueStatePath('s1', dir))).toEqual([cue.entries[0].id])
  })

  it('uses the claude-code envelope when that is the host', async () => {
    const out = await renderHook(
      'pre-tool-use',
      { cwd: '/work/engram', session_id: 's9', tool_input: { file_path: '/work/engram/src/delivery/hook.ts' } },
      { env, host: 'claude-code', stateDir: stateDir(), fetchImpl: fakeFetch(cue) }
    )

    const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('[gotcha]')
  })

  it('asks nothing and says nothing when the tool does not name a file', async () => {
    const requests: Recorded[] = []
    const out = await renderHook(
      'pre-tool-use',
      { cwd: '/work/engram', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' } },
      { env, stateDir: stateDir(), fetchImpl: fakeFetch(cue, { requests }) }
    )

    expect(out).toBe('')
    expect(requests).toEqual([])
  })

  it('says nothing when the store has no cue for the file', async () => {
    const out = await renderHook(
      'pre-tool-use',
      { cwd: '/work/engram', session_id: 's1', tool_input: { file_path: '/work/engram/src/unknown.ts' } },
      { env, stateDir: stateDir(), fetchImpl: fakeFetch({ entries: [] }) }
    )

    expect(out).toBe('')
  })
})

describe('hook process contract', () => {
  it('reads the file path out of the tool payloads that carry one', () => {
    expect(toolPaths({ file_path: '/a/b.ts' })).toEqual(['/a/b.ts'])
    expect(toolPaths({ filePath: '/a/b.ts' })).toEqual(['/a/b.ts'])
    expect(toolPaths({ notebook_path: '/a/b.ipynb' })).toEqual(['/a/b.ipynb'])
    expect(toolPaths({ command: 'ls', path: '/a' })).toEqual([])
    expect(toolPaths(undefined)).toEqual([])
  })

  it('emits plain text for a host with no json contract', () => {
    expect(formatForHost(undefined, 'session-start', 'hi')).toBe('hi')
    expect(formatForHost('cursor', 'pre-tool-use', 'hi')).toBe('hi')
  })

  it('exits silently when it is already running inside a hook', async () => {
    const out = await runHookProcess('session-start', {
      env: { ...env, [HOOK_GUARD_ENV]: '1' },
      stdin: JSON.stringify({ cwd: '/work/engram' }),
      fetchImpl: fakeFetch({ entries: [{ id: 'a', type: 'note', preview: 'x' }] }),
    })
    expect(out).toBe('')
  })

  it('exits silently on a payload it cannot read', async () => {
    for (const stdin of ['not json at all', '[1,2,3]', '"a string"']) {
      const out = await runHookProcess('session-start', { env: { ...env }, stdin, fetchImpl: fakeFetch({ entries: [] }) })
      expect(out).toBe('')
    }
  })

  it('exits silently on an event it does not implement', async () => {
    const out = await runHookProcess('post-tool-use', { env: { ...env }, stdin: '{}' })
    expect(out).toBe('')
  })

  it('treats an empty payload as a payload, so a host without stdin still gets context', async () => {
    const out = await runHookProcess('session-start', { env: { ...env }, stdin: '', fetchImpl: fakeFetch({ entries: [] }) })
    expect(out).toBe(PROTOCOL_SLIM)
  })
})
