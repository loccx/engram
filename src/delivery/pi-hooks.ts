/**
 * the pi lifecycle extension `engram setup pi` writes: pi has no settings-file hook
 * surface, so the hooks are an extension module that runs `engram hook <event>` and
 * feeds the result back through pi's event results. fail-open everywhere.
 */
export const PI_EXTENSION_MARKER = 'engram-pi-hooks'

export function piHooksExtension(cliArgv: readonly string[]): string {
  return `// ${PI_EXTENSION_MARKER}: written by \`engram setup pi\`; rerun with --apply to update, --uninstall to remove.
import { execFile } from 'node:child_process'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const CLI: string[] = ${JSON.stringify(cliArgv)}
const TIMEOUT_MS = 1500
const EDIT_TOOLS = new Set(['edit', 'write'])

function runHook(event: string, input: Record<string, unknown>): Promise<string> {
  return new Promise((resolve) => {
    const [command, ...prefix] = CLI
    try {
      execFile(
        command,
        [...prefix, 'hook', event, '--payload', JSON.stringify(input)],
        { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, stdout) => resolve(error ? '' : String(stdout).trim())
      )
    } catch {
      resolve('')
    }
  })
}

export default function (pi: ExtensionAPI) {
  let pending: string[] = []
  const cues = new Map<string, Promise<string>>()

  const flush = () => {
    if (pending.length === 0) return undefined
    const content = pending.join('\\n\\n')
    pending = []
    return { message: { customType: 'engram', content, display: false } }
  }

  pi.on('session_start', async (_event, ctx) => {
    const text = await runHook('session-start', { cwd: ctx.cwd })
    if (text) pending.push(text)
  })

  pi.on('before_agent_start', async () => flush())

  pi.on('tool_call', (event, ctx) => {
    if (!EDIT_TOOLS.has(event.toolName)) return
    cues.set(
      event.toolCallId,
      runHook('pre-tool-use', { cwd: ctx.cwd, tool_name: event.toolName, tool_input: event.input })
    )
  })

  pi.on('tool_result', async (event) => {
    const pendingCue = cues.get(event.toolCallId)
    if (!pendingCue) return
    cues.delete(event.toolCallId)
    const text = await pendingCue
    if (!text) return
    return { content: [...event.content, { type: 'text', text }] }
  })

  pi.on('session_before_compact', async (_event, ctx) => {
    await runHook('pre-compact', { cwd: ctx.cwd })
  })

  pi.on('session_compact', async (_event, ctx) => {
    const text = await runHook('post-compact', { cwd: ctx.cwd })
    if (text) pending.push(text)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    await runHook('session-end', { cwd: ctx.cwd })
  })
}
`
}
