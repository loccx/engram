import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { PROTOCOL_SLIM } from './protocol.js'
import { daemonBaseUrl, daemonPost } from './daemon.js'
import { authHeaders } from '../mcp/auth.js'
import { resolveWorkspaceNamespace } from './workspace.js'
import { beginWindow, cueStatePath, forgetSeen, markSeen } from './cue-state.js'
import {
  POST_COMPACT_BRIEF_CHARS,
  SUBAGENT_BRIEF_CHARS,
  type TaskBriefPayload,
} from './tasks.js'
import { DEFAULT_BRIEF_CHARS } from '../tasks/brief.js'
import type { CueHit } from './cue.js'
import type { RosterHit } from './roster.js'
import type { HandoffAudience } from '../tasks/types.js'

/**
 * `engram hook <event>` is the push side: the host hands over its own json payload on
 * stdin and gets back what it expects on stdout. all of it is fail-open — an unreachable
 * daemon, a slow call or an unreadable payload produces no output and no error.
 */

export const HOOK_EVENTS = [
  'session-start',
  'pre-tool-use',
  'pre-compact',
  'post-compact',
  'subagent-start',
  'subagent-stop',
  'session-end',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** set during a hook, so a nested invocation exits instead of re-reading the store */
export const HOOK_GUARD_ENV = 'ENGRAM_HOOK_ACTIVE'

export const HOOK_TIMEOUT_MS = 1500

const CUE_CONTENT_CHARS = 240
const PATH_FIELDS = ['file_path', 'filePath', 'notebook_path']
const TRANSCRIPT_TAIL_BYTES = 256 * 1024
export const SUBAGENT_SUMMARY_CHARS = 1200

/** the host's own name for each event, which is also what its hook envelope wants back */
const HOST_EVENT_NAMES: Record<HookEvent, string> = {
  'session-start': 'SessionStart',
  'pre-tool-use': 'PreToolUse',
  'pre-compact': 'PreCompact',
  'post-compact': 'PostCompact',
  'subagent-start': 'SubagentStart',
  'subagent-stop': 'SubagentStop',
  'session-end': 'SessionEnd',
}

export interface HookInput {
  cwd?: string
  session_id?: string
  source?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  /** pre-compact: manual or auto */
  trigger?: string
  /** subagent events */
  agent_id?: string
  agent_type?: string
  agent_transcript_path?: string
  transcript_path?: string
  last_assistant_message?: string
  summary?: string
  reason?: string
}

export interface HookOptions {
  host?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  fetchImpl?: typeof fetch
  stateDir?: string
}

export function hookEventName(event: HookEvent): string {
  return HOST_EVENT_NAMES[event]
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

function namespaceFor(input: HookInput, env: NodeJS.ProcessEnv): string {
  return resolveWorkspaceNamespace(input.cwd ?? process.cwd(), env)
}

async function postTo<T>(
  path: string,
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  options: HookOptions
): Promise<T | null> {
  return daemonPost<T>(path, body, {
    baseUrl: daemonBaseUrl(env),
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    headers: authHeaders(env),
  })
}

async function fetchBriefs(
  input: HookInput,
  options: HookOptions,
  params: { for: 'session' | HandoffAudience; budgetChars: number; limit?: number }
): Promise<TaskBriefPayload[]> {
  const env = options.env ?? process.env
  const result = await postTo<{ briefs: TaskBriefPayload[] }>(
    '/delivery/task-brief',
    {
      namespace: namespaceFor(input, env),
      session_id: input.session_id,
      for: params.for,
      budget_chars: params.budgetChars,
      limit: params.limit,
    },
    env,
    options
  )
  return result?.briefs ?? []
}

function briefText(entries: TaskBriefPayload[]): string {
  return entries
    .map((entry) => entry.brief.text)
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/** compaction rebuilds the model's context, so what it was shown is gone from it: the
 *  cues of the previous window are deliverable again, once, in the next one */
function reopenCueWindow(input: HookInput, options: HookOptions, kind: string): void {
  const sessionId = input.session_id ?? ''
  if (!sessionId) return
  beginWindow(cueStatePath(sessionId, options.stateDir), kind)
}

async function renderSessionStart(input: HookInput, options: HookOptions): Promise<string> {
  const env = options.env ?? process.env
  if (input.source === 'compact') reopenCueWindow(input, options, 'session-start-compact')
  const namespace = namespaceFor(input, env)
  const [roster, briefs] = await Promise.all([
    postTo<{ entries: RosterHit[] }>('/delivery/roster', { namespace }, env, options),
    fetchBriefs(input, options, { for: 'session', budgetChars: DEFAULT_BRIEF_CHARS, limit: 1 }),
  ])
  if (!roster && briefs.length === 0) return ''

  const parts = [PROTOCOL_SLIM]
  const tasks = briefText(briefs)
  if (tasks) parts.push(tasks)
  if (roster && roster.entries.length > 0) {
    parts.push(`engram context for ${namespace}`)
    for (const entry of roster.entries) parts.push(`- [${entry.type}] ${entry.preview}`)
  }
  return formatForHost(options.host, 'session-start', parts.join('\n\n'))
}

async function renderCue(input: HookInput, options: HookOptions): Promise<string> {
  const env = options.env ?? process.env
  const filePath = toolPaths(input.tool_input)[0]
  if (!filePath) return ''

  const namespace = namespaceFor(input, env)
  const found = await postTo<{ entries: CueHit[] }>(
    '/delivery/cue',
    { namespace, path: filePath },
    env,
    options
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

/** pre-compact: checkpoint every open task and queue consolidation, then say nothing at all */
async function renderPreCompact(input: HookInput, options: HookOptions): Promise<string> {
  const env = options.env ?? process.env
  await postTo(
    '/delivery/task-checkpoint',
    { namespace: namespaceFor(input, env), session_id: input.session_id, reason: input.trigger },
    env,
    options
  )
  return ''
}

async function renderPostCompact(input: HookInput, options: HookOptions): Promise<string> {
  reopenCueWindow(input, options, 'post-compact')
  const briefs = await fetchBriefs(input, options, {
    for: 'session',
    budgetChars: POST_COMPACT_BRIEF_CHARS,
    limit: 1,
  })
  const text = briefText(briefs)
  return text ? formatForHost(options.host, 'post-compact', text) : ''
}

async function renderSubagentStart(input: HookInput, options: HookOptions): Promise<string> {
  const briefs = await fetchBriefs(input, options, {
    for: 'subagent',
    budgetChars: SUBAGENT_BRIEF_CHARS,
    limit: 1,
  })
  const text = briefText(briefs)
  return text ? formatForHost(options.host, 'subagent-start', text) : ''
}

/** subagent-stop: whatever the subagent returned becomes a progress note on the parent task */
async function renderSubagentStop(input: HookInput, options: HookOptions): Promise<string> {
  const env = options.env ?? process.env
  const text = subagentSummary(input)
  if (!text) return ''
  await postTo(
    '/delivery/task-progress',
    {
      namespace: namespaceFor(input, env),
      session_id: input.session_id,
      text,
      author: input.agent_type ?? input.agent_id ?? 'subagent',
    },
    env,
    options
  )
  return ''
}

/**
 * session-end: close the namespace's current session and queue its consolidation.
 * the host's own session id is not an engram session id, so it is not sent — the daemon
 * resolves the session for the namespace it was told about.
 */
async function renderSessionEnd(input: HookInput, options: HookOptions): Promise<string> {
  const env = options.env ?? process.env
  await postTo(
    '/delivery/session-end',
    { namespace: namespaceFor(input, env), summary: input.reason },
    env,
    options
  )
  return ''
}

function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size
  const length = Math.min(size, maxBytes)
  if (length <= 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(isRecord)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim()
}

function assistantText(entry: unknown): string {
  if (!isRecord(entry)) return ''
  const message = isRecord(entry.message) ? entry.message : entry
  if (message.role !== 'assistant') return ''
  return textOf(message.content)
}

/** the last assistant message in a jsonl transcript; a line that does not parse is skipped */
export function lastAssistantText(path: string): string {
  let tail: string
  try {
    tail = readTail(path, TRANSCRIPT_TAIL_BYTES)
  } catch {
    return ''
  }
  const lines = tail.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const text = assistantText(parsed)
    if (text) return text
  }
  return ''
}

/** the host either hands over the summary directly or names the transcript to read it from */
export function subagentSummary(
  input: HookInput,
  maxChars: number = SUBAGENT_SUMMARY_CHARS
): string {
  const direct = [input.last_assistant_message, input.summary].find(
    (value) => typeof value === 'string' && value.trim().length > 0
  )
  const raw = direct ?? lastAssistantText(input.agent_transcript_path ?? input.transcript_path ?? '')
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat
}

export async function renderHook(
  event: HookEvent,
  input: HookInput,
  options: HookOptions = {}
): Promise<string> {
  switch (event) {
    case 'pre-tool-use':
      return renderCue(input, options)
    case 'session-start':
      return renderSessionStart(input, options)
    case 'pre-compact':
      return renderPreCompact(input, options)
    case 'post-compact':
      return renderPostCompact(input, options)
    case 'subagent-start':
      return renderSubagentStart(input, options)
    case 'subagent-stop':
      return renderSubagentStop(input, options)
    case 'session-end':
      return renderSessionEnd(input, options)
    default:
      return ''
  }
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
