import type { Command } from 'commander'
import { AGENTS, findAgent } from '../delivery/registry.js'
import { PROTOCOL_RULES } from '../delivery/protocol.js'
import { HOOK_EVENTS } from '../delivery/hook.js'
import {
  applyPlan,
  defaultContext,
  hookCommand,
  mcpServerEntry,
  planSetup,
  type ApplyResult,
  type PlanOp,
  type SetupContext,
  type SetupPlan,
} from '../delivery/setup.js'

/**
 * `engram setup` — dry run unless `--apply`, and the dry run shows the bytes.
 * The agent list is data (src/delivery/registry.ts); this file only renders
 * plans and applies them.
 */

const DIFF_LINES = 60

export function describeChange(op: PlanOp): string[] {
  if (op.after === null) return []
  const before = op.before === null ? [] : op.before.split('\n')
  const after = op.after.split('\n')

  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }

  const removed = before.slice(head, before.length - tail).map((line) => `- ${line}`)
  const added = after.slice(head, after.length - tail).map((line) => `+ ${line}`)
  const all = [...removed, ...added]
  return all.length > DIFF_LINES
    ? [...all.slice(0, DIFF_LINES), `  … ${all.length - DIFF_LINES} more lines`]
    : all
}

export function renderPlan(plan: SetupPlan, applied: ApplyResult[] | null): string {
  const lines = [applied ? `engram setup ${plan.agent}` : `engram setup ${plan.agent} (dry run, nothing written)`]
  for (const [index, op] of plan.ops.entries()) {
    const result = applied?.[index]
    const status = result?.wrote ? `${op.status}d` : op.status
    lines.push('', `${status}  ${op.path} — ${op.reason ?? op.action}`)
    if (result?.backup) lines.push(`  backup: ${result.backup}`)
    for (const line of describeChange(op)) lines.push(`  ${line}`)
  }
  if (!applied && plan.ops.some((op) => op.status !== 'unchanged' && op.status !== 'refused')) {
    lines.push('', 're-run with --apply to write these changes')
  }
  return `${lines.join('\n')}\n`
}

export function renderAgents(): string {
  const lines = ['engram setup <agent> [--apply] [--uninstall]', '']
  for (const agent of AGENTS) lines.push(`  ${agent.name.padEnd(12)} ${agent.summary}`)
  lines.push(
    '',
    'Nothing is written without --apply; a dry run prints the exact lines that would change.',
    'Other hosts: `engram setup print <agent>` prints the config to paste by hand.'
  )
  return `${lines.join('\n')}\n`
}

export function renderSnippets(agent: string, ctx: SetupContext): string {
  const entry = findAgent(agent)
  const mcp = mcpServerEntry(ctx)
  const json = JSON.stringify({ mcpServers: { engram: mcp } }, null, 2)
  const toml = ['[mcp_servers.engram]', `command = "${mcp.command}"`, `args = [${mcp.args.map((a) => `"${a}"`).join(', ')}]`].join('\n')

  const lines = entry ? [`${entry.name} — ${entry.summary}`] : [`${agent} — no registry entry; paste whichever block this host reads`]
  lines.push('', 'MCP server, JSON hosts (claude code, cursor, most mcp.json readers):', json)
  lines.push('', 'MCP server, TOML hosts (codex):', toml)
  lines.push(
    '',
    'hooks, if the host speaks claude-code style hook JSON:',
    `  ${hookCommand(ctx, 'session-start', 'claude-code')}`,
    `  ${hookCommand(ctx, 'pre-tool-use', 'claude-code')}`,
    'hooks, otherwise (plain text on stdout):',
    `  ${ctx.cli} hook ${HOOK_EVENTS[0]}`,
    `  ${ctx.cli} hook ${HOOK_EVENTS[1]}`
  )
  lines.push('', 'standing rules for the host instruction file:', '', PROTOCOL_RULES)
  if (entry) lines.push('', 'notes:', ...entry.notes.map((note) => `  - ${note}`))
  return `${lines.join('\n')}\n`
}

export function registerSetupCommands(program: Command): void {
  const setup = program
    .command('setup [agent]')
    .description('Wire engram into an agent (dry run unless --apply)')
    .option('--apply', 'write the planned changes')
    .option('--uninstall', 'remove only what setup added')
    .option('--json', 'print the plan as json')
    .action((agent: string | undefined, opts: { apply?: boolean; uninstall?: boolean; json?: boolean }) => {
      if (!agent) {
        process.stdout.write(renderAgents())
        return
      }
      const entry = findAgent(agent)
      if (!entry) {
        process.stderr.write(`unknown agent: ${agent}. Known: ${AGENTS.map((a) => a.name).join(', ')}\n`)
        process.exitCode = 1
        return
      }

      const ctx = defaultContext()
      const plan = planSetup(entry, ctx, { uninstall: opts.uninstall === true })
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ plan, applied: opts.apply === true }, null, 2)}\n`)
      } else {
        process.stdout.write(renderPlan(plan, opts.apply === true ? applyPlan(plan) : null))
      }
      if (plan.ops.some((op) => op.status === 'refused')) process.exitCode = 1
    })

  setup
    .command('print <agent>')
    .description('print the config an agent needs, without touching anything')
    .action((agent: string) => {
      process.stdout.write(renderSnippets(agent, defaultContext()))
    })
}
