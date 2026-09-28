import type { HookEvent } from './hook.js'

/**
 * one entry per agent: where its mcp servers go, which instruction file it reads, how
 * it runs hooks. adding a host is adding an entry; every path is relative to the user's
 * home directory, and only a format verified against the host's docs belongs here.
 */

export interface McpTarget {
  path: string
  format: 'json-mcpServers' | 'toml-mcp-servers'
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
  style: 'claude-settings'
  host: string
  bindings: HookBinding[]
}

export interface AgentEntry {
  name: string
  summary: string
  mcp: McpTarget | null
  instructions: InstructionTarget | null
  hooks: HookTarget | null
  notes: string[]
}

const EDIT_TOOLS = 'Read|Edit|Write|MultiEdit|NotebookEdit'

export const AGENTS: AgentEntry[] = [
  {
    name: 'claude-code',
    summary: 'Claude Code — MCP server, SessionStart + PreToolUse hooks, CLAUDE.md rules',
    mcp: { path: '.claude.json', format: 'json-mcpServers' },
    instructions: { path: '.claude/CLAUDE.md' },
    hooks: {
      path: '.claude/settings.json',
      style: 'claude-settings',
      host: 'claude-code',
      bindings: [{ event: 'session-start' }, { event: 'pre-tool-use', matcher: EDIT_TOOLS }],
    },
    notes: [
      'user scope: mcpServers lives at the top level of ~/.claude.json, hooks in ~/.claude/settings.json',
      '`claude mcp list` lists the registered server; hooks can be disabled with "disableAllHooks": true',
    ],
  },
  {
    name: 'codex',
    summary: 'Codex — config.toml MCP server, ~/.codex/AGENTS.md rules',
    mcp: { path: '.codex/config.toml', format: 'toml-mcp-servers' },
    instructions: { path: '.codex/AGENTS.md' },
    hooks: null,
    notes: ['global instructions are ~/.codex/AGENTS.md (or AGENTS.override.md, which wins if present)'],
  },
  {
    name: 'cursor',
    summary: 'Cursor — global mcp.json MCP server',
    mcp: { path: '.cursor/mcp.json', format: 'json-mcpServers' },
    instructions: null,
    hooks: null,
    notes: [
      'cursor rules are edited in the app (Settings → Rules) or as .cursor/rules/*.mdc, so there is no file to own',
      'global config is ~/.cursor/mcp.json; a project can use .cursor/mcp.json instead',
    ],
  },
]

export function findAgent(name: string): AgentEntry | undefined {
  return AGENTS.find((agent) => agent.name === name)
}
