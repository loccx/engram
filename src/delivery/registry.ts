import type { HookEvent } from './hook.js'

/**
 * one entry per agent: where its mcp servers go, which instruction file it reads, how it
 * runs hooks, and the path that proves the host is installed. adding a host is adding an
 * entry; every path is relative to the home directory, and only a verified format belongs.
 */

export interface McpTarget {
  path: string
  format: 'json-mcpServers' | 'toml-mcp-servers'
  /** extra server-entry fields this host needs beside command and args */
  entry?: Record<string, unknown>
}

export interface InstructionTarget {
  path: string
}

export interface HookBinding {
  event: HookEvent
  /** host-side pre-tool-use filter; absent means every event */
  matcher?: string
}

export interface HookTarget {
  path: string
  style: 'claude-settings' | 'pi-extension'
  host: string
  bindings: HookBinding[]
}

export interface AgentEntry {
  name: string
  summary: string
  /** home-relative path whose existence means this host is installed on the machine */
  probe: string
  mcp: McpTarget | null
  instructions: InstructionTarget | null
  hooks: HookTarget | null
  notes: string[]
}

const EDIT_TOOLS = 'Read|Edit|Write|MultiEdit|NotebookEdit'

export const AGENTS: AgentEntry[] = [
  {
    name: 'claude-code',
    summary:
      'Claude Code — MCP server, CLAUDE.md rules, and the full lifecycle hook set (session, compaction, subagent, session end)',
    probe: '.claude',
    mcp: { path: '.claude.json', format: 'json-mcpServers' },
    instructions: { path: '.claude/CLAUDE.md' },
    hooks: {
      path: '.claude/settings.json',
      style: 'claude-settings',
      host: 'claude-code',
      bindings: [
        { event: 'session-start' },
        { event: 'pre-tool-use', matcher: EDIT_TOOLS },
        { event: 'pre-compact', matcher: 'manual|auto' },
        { event: 'post-compact' },
        { event: 'subagent-start' },
        { event: 'subagent-stop' },
        { event: 'session-end' },
      ],
    },
    notes: [
      'user scope: mcpServers lives at the top level of ~/.claude.json, hooks in ~/.claude/settings.json',
      '`claude mcp list` lists the registered server; hooks can be disabled with "disableAllHooks": true',
      'pre-compact and session-end exit 0 without printing: compaction is the host\'s decision, and both run inside a shared 1.5 s budget',
    ],
  },
  {
    name: 'codex',
    summary: 'Codex — config.toml MCP server, ~/.codex/AGENTS.md rules',
    probe: '.codex',
    mcp: { path: '.codex/config.toml', format: 'toml-mcp-servers' },
    instructions: { path: '.codex/AGENTS.md' },
    hooks: null,
    notes: [
      'global instructions are ~/.codex/AGENTS.md (or AGENTS.override.md, which wins if present)',
      'codex documents no lifecycle hook surface, so the task tools are the whole working tier here',
    ],
  },
  {
    name: 'cursor',
    summary: 'Cursor — global mcp.json MCP server',
    probe: '.cursor',
    mcp: { path: '.cursor/mcp.json', format: 'json-mcpServers' },
    instructions: null,
    hooks: null,
    notes: [
      'cursor rules are edited in the app (Settings → Rules) or as .cursor/rules/*.mdc, so there is no file to own',
      'global config is ~/.cursor/mcp.json; a project can use .cursor/mcp.json instead',
      'cursor gets mcp tools only: its lifecycle hooks are not a verified surface, so nothing is registered',
    ],
  },
  {
    name: 'pi',
    summary: 'Pi — ~/.pi/agent/mcp.json MCP server and AGENTS.md rules',
    probe: '.pi',
    mcp: {
      path: '.pi/agent/mcp.json',
      format: 'json-mcpServers',
      // the default codemode exposure hides every tool from the model, which the rules
      // block does not assume: the five named tools are direct, the rest stay codemode
      entry: {
        exposure: 'codemode',
        toolExposure: {
          get_context: 'direct',
          search_memories: 'direct',
          store_memory: 'direct',
          revise_memory: 'direct',
          get_memory: 'direct',
        },
      },
    },
    instructions: { path: '.pi/agent/AGENTS.md' },
    hooks: {
      path: '.pi/agent/extensions/engram-hooks.ts',
      style: 'pi-extension',
      host: 'pi',
      bindings: [
        { event: 'session-start' },
        { event: 'pre-tool-use' },
        { event: 'pre-compact' },
        { event: 'post-compact' },
        { event: 'session-end' },
      ],
    },
    notes: [
      'user instructions are ~/.pi/agent/AGENTS.md, applied across working directories',
      'the extension runs engram hook <event> as a subprocess and fails open: no daemon, no output',
      'the stdio shim resolves the session cwd to its git root and forwards that as the namespace',
    ],
  },
]

export function findAgent(name: string): AgentEntry | undefined {
  return AGENTS.find((agent) => agent.name === name)
}
