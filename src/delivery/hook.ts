import { PROTOCOL_SLIM } from './protocol.js'
import { daemonBaseUrl, daemonPost } from './daemon.js'
import { resolveWorkspaceNamespace } from './workspace.js'
import { cueStatePath, forgetSeen, markSeen } from './cue-state.js'
import type { CueHit } from './cue.js'
import type { RosterHit } from './roster.js'

/**
 * `engram hook <event>` is the push side: the host hands over its own json payload on
 * stdin and gets back what it expects on stdout. all of it is fail-open — an unreachable
 * daemon, a slow call or an unreadable payload produces no output and no error.
 */

export const HOOK_EVENTS = ['session-start', 'pre-tool-use'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** set during a hook, so a nested invocation exits instead of re-reading the store */
export const HOOK_GUARD_ENV = 'ENGRAM_HOOK_ACTIVE'

export const HOOK_TIMEOUT_MS = 1500

const CUE_CONTENT_CHARS = 240
const PATH_FIELDS = ['file_path', 'filePath', 'notebook_path']

export interface HookInput {
  cwd?: string
  session_id?: string
  source?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
}

export interface HookOptions {
  host?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  fetchImpl?: typeof fetch
  stateDir?: string
}

export function hookEventName(event: HookEvent): string {
  return event === 'session-start' ? 'SessionStart' : 'PreToolUse'
}

/** hosts that parse json get json; every other host gets the text */
export function formatForHost(host: string | undefined, event: HookEvent, text: string): string {
  if (host !== 'claude-code') return text
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: hookEventName(event), additionalContext: text },
  })
}

export function toolPaths(toolInput: Record<string, unknown> | undefined): string[] {
  if (!toolInput) return []
  for (const field of PATH_FIELDS) {
    const value = toolInput[field]
    if (typeof value === 'string' && value.trim()) return [value.trim()]
  }
  return []
}

export function renderCueText(hits: CueHit[]): string {
  const lines = [`engram found ${hits.length} memory referencing ${hits[0].matched}:`]
  for (const hit of hits) {
    const content = hit.content.replace(/\s+/g, ' ').trim().slice(0, CUE_CONTENT_CHARS)
    lines.push(`- [${hit.type}] ${content} (id ${hit.id})`)
  }
  return lines.join('\n')
}

async function renderSessionStart(input: HookInput, options: HookOptions): Promise<string> {
  const env = options.env ?? process.env
  const namespace = resolveWorkspaceNamespace(input.cwd ?? process.cwd(), env)
  const roster = await daemonPost<{ entries: RosterHit[] }>(
    '/delivery/roster',
    { namespace },
    {
      baseUrl: daemonBaseUrl(env),
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    }
  )
  if (!roster) return ''

  const parts = [PROTOCOL_SLIM]
  if (roster.entries.length > 0) {
    parts.push(`engram context for ${namespace}`)
    for (const entry of roster.entries) parts.push(`- [${entry.type}] ${entry.preview}`)
  }
  return formatForHost(options.host, 'session-start', parts.join('\n\n'))
}

async function renderCue(input: HookInput, options: HookOptions): Promise<string> {
  const env = options.env ?? process.env
  const filePath = toolPaths(input.tool_input)[0]
  if (!filePath) return ''

  const namespace = resolveWorkspaceNamespace(input.cwd ?? process.cwd(), env)
  const found = await daemonPost<{ entries: CueHit[] }>(
    '/delivery/cue',
    { namespace, path: filePath },
    {
      baseUrl: daemonBaseUrl(env),
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    }
  )
  if (!found || found.entries.length === 0) return ''

  const sessionId = input.session_id ?? ''
  const statePath = sessionId ? cueStatePath(sessionId, options.stateDir) : null
  let hits = found.entries
  if (statePath) {
    const unseen = new Set(forgetSeen(statePath, hits.map((hit) => hit.id)))
    hits = hits.filter((hit) => unseen.has(hit.id))
  }
  if (hits.length === 0) return ''

  if (statePath) markSeen(statePath, hits.map((hit) => hit.id))
  return formatForHost(options.host, 'pre-tool-use', renderCueText(hits))
}

export async function renderHook(
  event: HookEvent,
  input: HookInput,
  options: HookOptions = {}
): Promise<string> {
  if (event === 'pre-tool-use') return renderCue(input, options)
  return renderSessionStart(input, options)
}

/** a host payload; unreadable json is "no payload", never an error */
export function parseHookInput(raw: string): HookInput | null {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as HookInput) : null
  } catch {
    return null
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * the whole hook as a process runs it: recursion guard, stdin payload, hard deadline, and
 * no output on any failure
 */
export async function runHookProcess(
  event: string,
  options: HookOptions & { stdin?: string } = {}
): Promise<string> {
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) return ''
  const env = options.env ?? process.env
  if (env[HOOK_GUARD_ENV] === '1') return ''

  const input = parseHookInput(options.stdin ?? '')
  if (!input) return ''

  env[HOOK_GUARD_ENV] = '1'
  const text = await withTimeout(
    renderHook(event as HookEvent, input, { ...options, env }),
    options.timeoutMs ?? HOOK_TIMEOUT_MS
  )
  return text ?? ''
}
