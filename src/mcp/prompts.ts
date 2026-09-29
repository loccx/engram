import type Database from 'better-sqlite3'
import { PROTOCOL_RULES } from '../delivery/protocol.js'
import { rosterHits } from '../delivery/roster.js'
import { getDatabase } from '../db/init.js'
import { resolveNamespace } from '../namespace/resolver.js'
import { assemble, DEFAULT_ASSEMBLE_BUDGET_CHARS, DEFAULT_RECIPE_NAME } from '../memory/assemble.js'
import { MemorySearch } from '../memory/search.js'
import { MemoryStore } from '../memory/store.js'
import type { RequestContext } from './handlers.js'

export interface PromptArgument {
  name: string
  description: string
  required: boolean
}

export interface PromptEntry {
  name: string
  title: string
  description: string
  arguments: PromptArgument[]
}

export const SESSION_PRIMER = 'engram/session-primer'
export const ASSEMBLED_CONTEXT = 'engram/context'

export const PROMPTS: PromptEntry[] = [
  {
    name: SESSION_PRIMER,
    title: 'Session primer',
    description:
      'The standing rules plus the current roster for a namespace, to start a session with memory loaded.',
    arguments: [
      {
        name: 'namespace',
        description: 'Absolute namespace path; defaults to this request’s namespace',
        required: false,
      },
    ],
  },
  {
    name: ASSEMBLED_CONTEXT,
    title: 'Assembled context',
    description:
      'The assembled read for a namespace under one character budget: working task briefs, current state heads, summaries and ranked memories. A recipe decides which sections and how much of the budget each gets.',
    arguments: [
      {
        name: 'namespace',
        description: 'Absolute namespace path; defaults to this request’s namespace',
        required: false,
      },
      { name: 'query', description: 'Retrieval query for the memories section', required: false },
      {
        name: 'budget_chars',
        description: `Content-character budget across every section (default ${DEFAULT_ASSEMBLE_BUDGET_CHARS})`,
        required: false,
      },
      {
        name: 'recipe',
        description: 'default | session-priming | qa',
        required: false,
      },
    ],
  },
]

export function listPrompts(): PromptEntry[] {
  return PROMPTS
}

export interface PromptMessage {
  role: 'user'
  content: { type: 'text'; text: string }
}

export interface PromptReply {
  description: string
  messages: PromptMessage[]
}

function primerText(db: Database.Database, namespace: string): string {
  const hits = rosterHits(db, namespace)
  const roster =
    hits.length === 0
      ? `no memories in ${namespace} yet`
      : hits
          .map((hit) => `- [${hit.type}] ${hit.preview}${hit.pinned ? ' (pinned)' : ''} (id ${hit.id})`)
          .join('\n')
  return `${PROTOCOL_RULES}\n\n## current context — ${namespace}\n\n${roster}`
}

function budgetArg(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return raw >= 50 ? Math.floor(raw) : null
}

/** the assembled read as prompt text: one block per section, ids kept for drill-down */
async function assembledContextText(
  db: Database.Database,
  vectorsAvailable: boolean,
  namespace: string,
  args: Record<string, unknown>
): Promise<string | { error: string }> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  const recipe = typeof args.recipe === 'string' && args.recipe.trim() !== '' ? args.recipe.trim() : DEFAULT_RECIPE_NAME
  let result
  try {
    result = await assemble(db, new MemoryStore(db, vectorsAvailable), new MemorySearch(db, vectorsAvailable), {
      scope: namespace,
      ...(query !== '' ? { query } : {}),
      budgetChars: budgetArg(args.budget_chars) ?? DEFAULT_ASSEMBLE_BUDGET_CHARS,
      recipe,
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  const lines = [
    `# assembled context — ${namespace} (recipe ${recipe}, ${result.accounting.used}/${result.accounting.budget} chars)`,
    '',
  ]
  for (const section of result.sections) {
    lines.push(`## ${section.title}`, '')
    if (section.items.length === 0) {
      lines.push('- (empty)')
    } else {
      for (const item of section.items) lines.push(`- (${item.id}) ${item.text}`)
    }
    lines.push('')
  }
  if (result.degraded.length > 0) {
    lines.push('## degraded', '')
    for (const entry of result.degraded) lines.push(`- ${entry.signal}: ${entry.reason}`)
  }
  return lines.join('\n').trimEnd()
}

export async function getPrompt(
  name: string,
  args: Record<string, unknown>,
  ctx: RequestContext
): Promise<PromptReply | { error: string }> {
  const entry = PROMPTS.find((prompt) => prompt.name === name)
  if (!entry) return { error: `unknown prompt: ${name}` }
  const explicit = typeof args.namespace === 'string' ? args.namespace.trim() : ''
  const resolved = await resolveNamespace({
    argsNamespace: explicit || undefined,
    urlNamespace: ctx.urlNamespace,
    urlProject: ctx.urlProject,
  })
  const database = getDatabase()
  if (name === ASSEMBLED_CONTEXT) {
    const text = await assembledContextText(
      database.db,
      database.vectorsAvailable,
      resolved.namespace,
      args
    )
    if (typeof text !== 'string') return text
    return { description: entry.description, messages: [{ role: 'user', content: { type: 'text', text } }] }
  }
  return {
    description: entry.description,
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: primerText(database.db, resolved.namespace) },
      },
    ],
  }
}
