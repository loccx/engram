import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_RULES } from './protocol.js'
import { HASH_MARKERS, MARKDOWN_MARKERS, removeBlock, upsertBlock, type Markers } from './markers.js'
import { hookEventName, type HookEvent } from './hook.js'
import type { AgentEntry, HookBinding, HookTarget, McpTarget } from './registry.js'

/**
 * `engram setup <agent>` turns a registry entry into a plan and a plan into writes.
 * planning and applying are separate on purpose: the default is a dry run, and every
 * write is idempotent and reversible (`--uninstall` removes only its own lines).
 */

export const SERVER_NAME = 'engram'
const BACKUP_SUFFIX = '.engram.bak'

export interface SetupContext {
  home: string
  /** how a hook invokes the CLI; `engram` when it is on PATH */
  cli: string
  /** absolute path of the stdio shim the MCP entry launches */
  stdioServer: string
}

export type PlanStatus = 'create' | 'update' | 'delete' | 'unchanged' | 'refused'

export interface PlanOp {
  path: string
  status: PlanStatus
  action: string
  reason?: string
  before: string | null
  after: string | null
}

export interface SetupPlan {
  agent: string
  ops: PlanOp[]
}

export interface ApplyResult extends PlanOp {
  wrote: boolean
  backup: string | null
}

/** a hook runs in a shell the host chooses, so a built entry point is spelled out
 *  absolutely, and a source checkout falls back to the PATH name */
export function engramCli(argv1: string | undefined, execPath = process.execPath): string {
  return argv1 && argv1.endsWith('.js') ? `${execPath} ${argv1}` : SERVER_NAME
}

export function stdioServerPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('../../stdio-server.mjs', moduleUrl))
}

export function defaultContext(): SetupContext {
  return {
    home: process.env.HOME ?? '',
    cli: engramCli(process.argv[1]),
    stdioServer: stdioServerPath(),
  }
}

export function hookCommand(ctx: SetupContext, event: HookEvent, host: string): string {
  return `${ctx.cli} hook ${event} --host ${host}`
}

export function mcpServerEntry(ctx: SetupContext): { command: string; args: string[] } {
  return { command: 'node', args: [ctx.stdioServer] }
}

export function planSetup(
  entry: AgentEntry,
  ctx: SetupContext,
  options: { uninstall?: boolean } = {}
): SetupPlan {
  const uninstall = options.uninstall === true
  const ops: PlanOp[] = []
  if (entry.mcp) ops.push(planMcp(entry.mcp, ctx, uninstall))
  if (entry.instructions) {
    ops.push(
      planMarkerFile(
        join(ctx.home, entry.instructions.path),
        PROTOCOL_RULES,
        MARKDOWN_MARKERS,
        ctx.home,
        uninstall
      )
    )
  }
  if (entry.hooks) ops.push(planHooks(entry.hooks, ctx, uninstall))
  return { agent: entry.name, ops }
}

export function applyPlan(plan: SetupPlan): ApplyResult[] {
  return plan.ops.map((op) => {
    if (op.status === 'delete') {
      const backup = backupBeforeWrite(op.path)
      rmSync(op.path, { force: true })
      return { ...op, wrote: true, backup }
    }
    if (op.status !== 'create' && op.status !== 'update') {
      return { ...op, wrote: false, backup: null }
    }
    const backup = backupBeforeWrite(op.path)
    mkdirSync(dirname(op.path), { recursive: true })
    writeFileSync(op.path, op.after ?? '')
    return { ...op, wrote: true, backup }
  })
}

function planMcp(target: McpTarget, ctx: SetupContext, uninstall: boolean): PlanOp {
  const path = join(ctx.home, target.path)
  const before = readText(path)
  const guard = symlinkGuard(ctx.home, path)
  if (guard) return refused(path, before, guard)

  if (target.format === 'toml-mcp-servers') {
    const entry = mcpServerEntry(ctx)
    const block = [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = "${entry.command}"`,
      `args = [${entry.args.map((arg) => `"${arg}"`).join(', ')}]`,
    ].join('\n')
    return planMarkerFile(path, block, HASH_MARKERS, ctx.home, uninstall)
  }

  let doc: Record<string, unknown> = {}
  if (before) {
    const parsed = parseJsonObject(before)
    if (!parsed) return refused(path, before, `${basename(path)} is not a JSON object; leaving it untouched`)
    doc = parsed
  }

  const servers = isRecord(doc.mcpServers) ? { ...doc.mcpServers } : {}
  const desired = mcpServerEntry(ctx)

  if (uninstall) {
    if (!(SERVER_NAME in servers)) return unchanged(path, before, 'no engram server registered')
    delete servers[SERVER_NAME]
    if (Object.keys(servers).length === 0) delete doc.mcpServers
    else doc.mcpServers = servers
    return writeOp(path, before, serializeJson(doc, before), `remove mcpServers.${SERVER_NAME}`)
  }

  if (stable(servers[SERVER_NAME]) === stable(desired)) {
    return unchanged(path, before, `mcpServers.${SERVER_NAME} already points at the stdio shim`)
  }
  servers[SERVER_NAME] = desired
  doc.mcpServers = servers
  return writeOp(path, before, serializeJson(doc, before), `set mcpServers.${SERVER_NAME}`)
}

function planMarkerFile(
  path: string,
  body: string,
  markers: Markers,
  home: string,
  uninstall: boolean
): PlanOp {
  const before = readText(path)
  const guard = symlinkGuard(home, path)
  if (guard) return refused(path, before, guard)
  const block = [markers.begin, body, markers.end].join('\n')

  if (uninstall) {
    if (before === null) return unchanged(path, before, 'file does not exist')
    const result = removeBlock(before, markers)
    if (result.status === 'absent') return unchanged(path, before, 'no engram block')
    if (result.status === 'malformed') {
      return refused(path, before, `markers in ${basename(path)} are not a single well-formed block`)
    }
    if (!result.text.trim()) {
      return { path, status: 'delete', action: 'remove the file setup created', before, after: '' }
    }
    return update(path, before, result.text, 'remove the engram block')
  }

  const result = upsertBlock(before, block, markers)
  if (result.status === 'malformed') {
    return refused(path, before, `markers in ${basename(path)} are not a single well-formed block`)
  }
  if (result.text === before) return unchanged(path, before, 'engram block already up to date')
  return before === null
    ? create(path, result.text, 'write the engram block')
    : update(path, before, result.text, 'replace the engram block')
}

function planHooks(target: HookTarget, ctx: SetupContext, uninstall: boolean): PlanOp {
  const path = join(ctx.home, target.path)
  const before = readText(path)
  const guard = symlinkGuard(ctx.home, path)
  if (guard) return refused(path, before, guard)

  let doc: Record<string, unknown> = {}
  if (before) {
    const parsed = parseJsonObject(before)
    if (!parsed) return refused(path, before, `${basename(path)} is not a JSON object; leaving it untouched`)
    doc = parsed
  }

  const hooks = isRecord(doc.hooks) ? { ...doc.hooks } : {}
  const changed: string[] = []

  for (const binding of target.bindings) {
    const key = hookEventName(binding.event)
    const command = hookCommand(ctx, binding.event, target.host)
    const groups = Array.isArray(hooks[key]) ? (hooks[key] as Array<Record<string, unknown>>) : []
    if (uninstall) {
      const kept: Array<Record<string, unknown>> = []
      let removed = false
      for (const group of groups) {
        const stripped = stripCommand(group, command)
        removed = removed || stripped.removed
        if (stripped.group) kept.push(stripped.group)
      }
      if (!removed) continue
      changed.push(`remove the ${key} hook`)
      if (kept.length > 0) hooks[key] = kept
      else delete hooks[key]
      continue
    }
    if (groups.some((group) => hasCommand(group, command))) continue
    changed.push(`add the ${key} hook`)
    hooks[key] = [...groups, groupFor(binding, command)]
  }

  if (changed.length === 0) return unchanged(path, before, 'hooks already registered')
  if (Object.keys(hooks).length === 0) delete doc.hooks
  else doc.hooks = hooks
  return writeOp(path, before, serializeJson(doc, before), changed.join(', '))
}

function groupFor(binding: HookBinding, command: string): Record<string, unknown> {
  const group: Record<string, unknown> = { hooks: [{ type: 'command', command }] }
  if (binding.matcher) group.matcher = binding.matcher
  return group
}

function hasCommand(group: Record<string, unknown>, command: string): boolean {
  const hooks = Array.isArray(group.hooks) ? group.hooks : []
  return hooks.some((hook) => isRecord(hook) && hook.command === command)
}

/** drop this tool's command from one group: a group left with no handlers goes away, and
 *  one that also holds a foreign hook keeps it */
function stripCommand(
  group: Record<string, unknown>,
  command: string
): { group: Record<string, unknown> | null; removed: boolean } {
  const hooks = Array.isArray(group.hooks) ? group.hooks : []
  const kept = hooks.filter((hook) => !isRecord(hook) || hook.command !== command)
  if (kept.length === hooks.length) return { group, removed: false }
  return { group: kept.length > 0 ? { ...group, hooks: kept } : null, removed: true }
}

export function symlinkGuard(home: string, target: string): string | null {
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    return `${target} is a symlink; refusing to write through it`
  }
  let probe = target
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
  const roots = [...new Set([resolve(home), safeRealpath(home)])]
  const real = safeRealpath(probe)
  const inside = roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep))
  return inside ? null : `${probe} resolves to ${real}, outside ${roots[0]}`
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function backupBeforeWrite(path: string): string | null {
  if (!existsSync(path)) return null
  const backup = `${path}${BACKUP_SUFFIX}`
  // keep the first backup: it is the only copy of the user's pre-engram file
  if (existsSync(backup)) return backup
  copyFileSync(path, backup)
  return backup
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** a stable comparison of a server entry, insensitive to key order */
function stable(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value)
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]))
}

/** re-render json with the indentation the file already uses, so a diff shows the
 *  changed lines rather than the whole document; a compact file, including a single-line
 *  mcp.json, stays compact */
function serializeJson(doc: Record<string, unknown>, before: string | null): string {
  if (before === null) return `${JSON.stringify(doc, null, 2)}\n`
  const indent = before.match(/\n([ \t]+)\S/)?.[1] ?? ''
  return `${JSON.stringify(doc, null, indent)}\n`
}

function writeOp(path: string, before: string | null, after: string, action: string): PlanOp {
  return before === null ? create(path, after, action) : update(path, before, after, action)
}

function create(path: string, after: string, action: string): PlanOp {
  return { path, status: 'create', action, before: null, after }
}

function update(path: string, before: string | null, after: string, action: string): PlanOp {
  return { path, status: 'update', action, before, after }
}

function unchanged(path: string, before: string | null, action: string): PlanOp {
  return { path, status: 'unchanged', action, before, after: before }
}

function refused(path: string, before: string | null, reason: string): PlanOp {
  return { path, status: 'refused', action: 'skip', reason, before, after: before }
}
