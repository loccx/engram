import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS, findAgent, type AgentEntry } from '../src/delivery/registry.js'
import { PROTOCOL_RULES } from '../src/delivery/protocol.js'
import { engramCli, applyPlan, planSetup, type SetupContext, type SetupPlan } from '../src/delivery/setup.js'
import { renderAgents, renderPlan, renderSnippets } from '../src/cli/setup.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const homes: string[] = []

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'engram-home-'))
  homes.push(home)
  return home
}

function ctx(home: string): SetupContext {
  return { home, cli: 'engram', stdioServer: '/opt/engram/stdio.server.mjs' }
}

function read(home: string, path: string): string {
  return readFileSync(join(home, path), 'utf8')
}

function seed(home: string, path: string, content: string): void {
  mkdirSync(dirname(join(home, path)), { recursive: true })
  writeFileSync(join(home, path), content)
}

function claude(): AgentEntry {
  const entry = findAgent('claude-code')
  if (!entry) throw new Error('claude-code entry missing')
  return entry
}

function apply(entry: AgentEntry, home: string, uninstall = false): SetupPlan {
  const plan = planSetup(entry, ctx(home), { uninstall })
  applyPlan(plan)
  return plan
}

beforeEach(() => {
  homes.length = 0
})

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('setup registry', () => {
  it('names every agent once and only references hooks it can configure', () => {
    expect(new Set(AGENTS.map((agent) => agent.name)).size).toBe(AGENTS.length)
    for (const agent of AGENTS) {
      for (const binding of agent.hooks?.bindings ?? []) {
        expect(['session-start', 'pre-tool-use']).toContain(binding.event)
      }
    }
  })

  it('resolves agents by name', () => {
    expect(findAgent('codex')?.mcp?.path).toBe('.codex/config.toml')
    expect(findAgent('nope')).toBeUndefined()
  })

  it('prints snippets for a host it does not know', () => {
    const out = renderSnippets('some-other-host', ctx(tempHome()))
    expect(out).toContain('"mcpServers"')
    expect(out).toContain('[mcp_servers.engram]')
    expect(out).toContain('engram hook session-start')
    expect(out).toContain(PROTOCOL_RULES)
  })

  it('lists the agents it can wire', () => {
    const out = renderAgents()
    for (const agent of AGENTS) expect(out).toContain(agent.name)
  })
})

describe('setup claude-code', () => {
  it('writes nothing on a dry run and shows the lines it would write', () => {
    const home = tempHome()
    const plan = planSetup(claude(), ctx(home))

    expect(plan.ops.map((op) => op.status)).toEqual(['create', 'create', 'create'])
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
    expect(existsSync(join(home, '.claude/settings.json'))).toBe(false)
    expect(existsSync(join(home, '.claude/CLAUDE.md'))).toBe(false)

    const rendered = renderPlan(plan, null)
    expect(rendered).toContain('dry run')
    expect(rendered).toContain('+   "mcpServers"')
    expect(rendered).toContain('re-run with --apply')
  })

  it('registers the mcp server, the rules block and both hooks', () => {
    const home = tempHome()
    apply(claude(), home)

    const claudeJson = JSON.parse(read(home, '.claude.json')) as Record<string, unknown>
    expect(claudeJson).toEqual({
      mcpServers: { engram: { command: 'node', args: ['/opt/engram/stdio.server.mjs'] } },
    })

    expect(read(home, '.claude/CLAUDE.md')).toBe(`<!-- engram:begin -->\n${PROTOCOL_RULES}\n<!-- engram:end -->\n`)

    const settings = JSON.parse(read(home, '.claude/settings.json')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>
    }
    expect(settings.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'engram hook session-start --host claude-code' }] },
    ])
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: 'engram hook pre-tool-use --host claude-code' }],
      },
    ])
  })

  it('changes nothing on a second run', () => {
    const home = tempHome()
    apply(claude(), home)
    const before = ['.claude.json', '.claude/CLAUDE.md', '.claude/settings.json'].map((p) => read(home, p))

    const plan = planSetup(claude(), ctx(home))
    expect(plan.ops.map((op) => op.status)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(applyPlan(plan).every((result) => !result.wrote)).toBe(true)

    const after = ['.claude.json', '.claude/CLAUDE.md', '.claude/settings.json'].map((p) => read(home, p))
    expect(after).toEqual(before)
  })

  it('leaves the user\'s own text and their own hooks alone', () => {
    const home = tempHome()
    seed(home, '.claude/CLAUDE.md', '# my notes\n\nkeep this\n')
    seed(
      home,
      '.claude/settings.json',
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2)
    )
    apply(claude(), home)

    const rules = read(home, '.claude/CLAUDE.md')
    expect(rules.startsWith('# my notes\n\nkeep this\n')).toBe(true)
    expect(rules).toContain(PROTOCOL_RULES)

    const settings = JSON.parse(read(home, '.claude/settings.json')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(settings.hooks.SessionStart.flatMap((group) => group.hooks.map((hook) => hook.command))).toEqual([
      'echo mine',
      'engram hook session-start --host claude-code',
    ])
  })

  it('replaces a stale engram block without touching the text around it', () => {
    const home = tempHome()
    seed(
      home,
      '.claude/CLAUDE.md',
      `# notes\n\nabove\n\n<!-- engram:begin -->\nstale rules\n<!-- engram:end -->\n\nbelow\n`
    )
    apply(claude(), home)

    const rules = read(home, '.claude/CLAUDE.md')
    expect(rules).toContain('above')
    expect(rules).toContain('below')
    expect(rules).not.toContain('stale rules')
    expect(rules).toContain(PROTOCOL_RULES)
  })

  it('uninstalls only its own command when a group holds someone else\'s too', () => {
    const home = tempHome()
    seed(
      home,
      '.claude/settings.json',
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Edit|Write',
                hooks: [
                  { type: 'command', command: 'echo mine' },
                  { type: 'command', command: 'engram hook pre-tool-use --host claude-code' },
                ],
              },
            ],
          },
        },
        null,
        2
      )
    )

    apply(claude(), home, true)
    const settings = JSON.parse(read(home, '.claude/settings.json')) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(settings.hooks?.PreToolUse).toEqual([{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'echo mine' }] }])
  })

  it('backs up a file before touching it, once', () => {
    const home = tempHome()
    const original = '{\n  "hooks": {}\n}\n'
    seed(home, '.claude/settings.json', original)

    apply(claude(), home)
    expect(read(home, '.claude/settings.json.engram.bak')).toBe(original)

    seed(home, '.claude/settings.json', '{"hooks":{"SessionStart":[]}}\n')
    apply(claude(), home)
    expect(read(home, '.claude/settings.json.engram.bak')).toBe(original)
  })

  it('removes exactly what it added on uninstall', () => {
    const home = tempHome()
    const rulesBefore = '# notes\n'
    seed(home, '.claude/CLAUDE.md', rulesBefore)
    apply(claude(), home)
    apply(claude(), home, true)

    expect(read(home, '.claude/CLAUDE.md')).toBe(rulesBefore)
    expect(JSON.parse(read(home, '.claude.json'))).toEqual({})
    expect(JSON.parse(read(home, '.claude/settings.json'))).toEqual({})
  })

  it('refuses a file it cannot parse instead of overwriting it', () => {
    const home = tempHome()
    seed(home, '.claude.json', 'this is not json')
    const plan = planSetup(claude(), ctx(home))

    expect(plan.ops[0].status).toBe('refused')
    expect(plan.ops[0].reason).toContain('not a JSON object')
    expect(applyPlan(plan)[0].wrote).toBe(false)
    expect(read(home, '.claude.json')).toBe('this is not json')
  })

  it('refuses to guess when the markers are not one well-formed block', () => {
    const home = tempHome()
    const broken = '<!-- engram:begin -->\ntext\n<!-- engram:begin -->\n<!-- engram:end -->\n'
    seed(home, '.claude/CLAUDE.md', broken)

    const plan = planSetup(claude(), ctx(home))
    expect(plan.ops[1].status).toBe('refused')
    expect(read(home, '.claude/CLAUDE.md')).toBe(broken)
  })

  it('refuses to write through a symlink out of the home directory', () => {
    const home = tempHome()
    const outside = tempHome()
    symlinkSync(outside, join(home, '.claude'))

    const plan = planSetup(claude(), ctx(home))
    expect(plan.ops.find((op) => op.path.includes('settings.json'))?.status).toBe('refused')
    expect(plan.ops.find((op) => op.path.includes('settings.json'))?.reason).toContain('outside')
    expect(existsSync(join(outside, 'settings.json'))).toBe(false)
    expect(existsSync(join(outside, 'CLAUDE.md'))).toBe(false)
  })

  it('refuses to follow a config file that is itself a symlink', () => {
    const home = tempHome()
    const outside = tempHome()
    seed(outside, 'settings.json', '{"hooks":{}}\n')
    mkdirSync(join(home, '.claude'), { recursive: true })
    symlinkSync(join(outside, 'settings.json'), join(home, '.claude/settings.json'))

    const plan = planSetup(claude(), ctx(home))
    const op = plan.ops.find((entry) => entry.path.endsWith('settings.json'))
    expect(op?.status).toBe('refused')
    expect(read(outside, 'settings.json')).toBe('{"hooks":{}}\n')
  })
})

describe('setup other agents', () => {
  it('appends a marker block to an existing codex config.toml and uninstalls it', () => {
    const home = tempHome()
    const codex = findAgent('codex')
    if (!codex) throw new Error('codex entry missing')
    seed(home, '.codex/config.toml', 'model = "gpt-5"\n')

    apply(codex, home)
    const toml = read(home, '.codex/config.toml')
    expect(toml.startsWith('model = "gpt-5"\n')).toBe(true)
    expect(toml).toContain('[mcp_servers.engram]')
    expect(toml).toContain('command = "node"')
    expect(toml).toContain('args = ["/opt/engram/stdio.server.mjs"]')
    expect(read(home, '.codex/AGENTS.md')).toContain(PROTOCOL_RULES)

    expect(planSetup(codex, ctx(home)).ops.map((op) => op.status)).toEqual(['unchanged', 'unchanged'])

    apply(codex, home, true)
    expect(read(home, '.codex/config.toml')).toBe('model = "gpt-5"\n')
    expect(existsSync(join(home, '.codex/AGENTS.md'))).toBe(false)
  })

  it('keeps a compact mcp.json compact', () => {
    const home = tempHome()
    const cursor = findAgent('cursor')
    if (!cursor) throw new Error('cursor entry missing')
    seed(home, '.cursor/mcp.json', '{"mcpServers":{}}')

    apply(cursor, home)
    const json = read(home, '.cursor/mcp.json')
    expect(json.split('\n')).toHaveLength(2)
    expect(JSON.parse(json)).toEqual({ mcpServers: { engram: { command: 'node', args: ['/opt/engram/stdio.server.mjs'] } } })
  })
})

describe('setup cli', () => {
  it('spells out a built entry point and falls back to the PATH name otherwise', () => {
    expect(engramCli('dist/index.js', '/usr/bin/node')).toBe('/usr/bin/node dist/index.js')
    expect(engramCli('src/index.ts', '/usr/bin/node')).toBe('engram')
    expect(engramCli(undefined, '/usr/bin/node')).toBe('engram')
  })

  it('dry runs by default, applies on request, and re-runs clean', () => {
    const home = tempHome()
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), 'src/index.ts', ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      })

    const dry = run('setup', 'cursor')
    expect(dry).toContain('dry run')
    expect(existsSync(join(home, '.cursor/mcp.json'))).toBe(false)

    expect(run('setup', 'cursor', '--apply')).toContain('created')
    expect(JSON.parse(read(home, '.cursor/mcp.json')).mcpServers.engram.command).toBe('node')

    expect(run('setup', 'cursor')).toContain('unchanged')
    expect(run('setup')).toContain('claude-code')
    expect(run('setup', 'print', 'codex')).toContain('[mcp_servers.engram]')
  })
})
