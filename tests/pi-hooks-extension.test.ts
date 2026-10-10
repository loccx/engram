import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PI_EXTENSION_MARKER, piHooksExtension } from '../src/delivery/pi-hooks.js'

const homes: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-pi-hooks-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** a stand-in for the engram CLI: the hook event is argv[2] after `hook <event>` */
function stubCli(dir: string): string {
  const cli = join(dir, 'engram-stub.sh')
  writeFileSync(
    cli,
    `#!/bin/sh
case "$2" in
  session-start) printf 'engram rules and roster\\n' ;;
  pre-tool-use) printf 'cue for the file\\n' ;;
  post-compact) printf 'post compact briefs\\n' ;;
esac
`
  )
  chmodSync(cli, 0o755)
  return cli
}

type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => Promise<unknown>

async function loadExtension(cli: string) {
  const dir = tempDir()
  const file = join(dir, 'engram-hooks.ts')
  writeFileSync(file, piHooksExtension([cli]))
  const module = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void }
  const handlers = new Map<string, Handler>()
  module.default({ on: (event: string, handler: Handler) => handlers.set(event, handler) })
  return handlers
}

describe('pi hooks extension', () => {
  it('wires the lifecycle events the daemon hook cli implements', async () => {
    const handlers = await loadExtension(stubCli(tempDir()))
    expect([...handlers.keys()]).toEqual([
      'session_start',
      'before_agent_start',
      'tool_call',
      'tool_result',
      'session_before_compact',
      'session_compact',
      'session_shutdown',
    ])
  })

  it('injects the session-start payload once and a post-compact payload after compaction', async () => {
    const handlers = await loadExtension(stubCli(tempDir()))
    const ctx = { cwd: '/tmp/project' }
    await handlers.get('session_start')!({ type: 'session_start' }, ctx)
    expect(await handlers.get('before_agent_start')!({ type: 'before_agent_start' }, ctx)).toEqual({
      message: { customType: 'engram', content: 'engram rules and roster', display: false },
    })
    expect(await handlers.get('before_agent_start')!({ type: 'before_agent_start' }, ctx)).toBeUndefined()

    await handlers.get('session_compact')!({ type: 'session_compact' }, ctx)
    expect(await handlers.get('before_agent_start')!({ type: 'before_agent_start' }, ctx)).toEqual({
      message: { customType: 'engram', content: 'post compact briefs', display: false },
    })
  })

  it('attaches a pre-tool-use cue to the matching edit result and nothing else', async () => {
    const handlers = await loadExtension(stubCli(tempDir()))
    const ctx = { cwd: '/tmp/project' }
    await handlers.get('tool_call')!(
      { type: 'tool_call', toolCallId: 't1', toolName: 'edit', input: { file_path: '/tmp/project/a.ts' } },
      ctx
    )
    expect(
      await handlers.get('tool_result')!(
        { type: 'tool_result', toolCallId: 't1', input: {}, content: [{ type: 'text', text: 'edited' }], isError: false },
        ctx
      )
    ).toEqual({ content: [{ type: 'text', text: 'edited' }, { type: 'text', text: 'cue for the file' }] })

    await handlers.get('tool_call')!({ type: 'tool_call', toolCallId: 't2', toolName: 'read', input: {} }, ctx)
    expect(
      await handlers.get('tool_result')!(
        { type: 'tool_result', toolCallId: 't2', input: {}, content: [], isError: false },
        ctx
      )
    ).toBeUndefined()
  })

  it('fails open when the hook command is missing', async () => {
    const handlers = await loadExtension(join(tempDir(), 'does-not-exist'))
    const ctx = { cwd: '/tmp/project' }
    await handlers.get('session_start')!({ type: 'session_start' }, ctx)
    expect(await handlers.get('before_agent_start')!({ type: 'before_agent_start' }, ctx)).toBeUndefined()
    await handlers.get('tool_call')!({ type: 'tool_call', toolCallId: 't1', toolName: 'write', input: {} }, ctx)
    expect(
      await handlers.get('tool_result')!(
        { type: 'tool_result', toolCallId: 't1', input: {}, content: [], isError: false },
        ctx
      )
    ).toBeUndefined()
  })

  it('marks the generated file so setup can own and remove it', () => {
    expect(piHooksExtension(['engram'])).toContain(PI_EXTENSION_MARKER)
  })
})
