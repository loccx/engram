// the mcp surface of the assembled read: the tool, its schema, and the prompt that
// renders the same sections for a client that primes a session with them.
import { beforeEach, describe, expect, it } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { getPrompt, ASSEMBLED_CONTEXT } from '../src/mcp/prompts.js'
import { SCHEMAS } from '../src/mcp/schemas.js'
import { tools } from '../src/mcp/tools.js'
import type { AssembleResult } from '../src/memory/assemble.js'

const NS = '/home/user/assemble-mcp'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
}

function parse<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T
}

async function store(content: string, opts: Record<string, unknown> = {}): Promise<void> {
  await handleTool('store_memory', { content, project_path: NS, ...opts })
}

describe('assemble_context tool', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('is advertised and validated', () => {
    expect(tools.some((tool) => tool.name === 'assemble_context')).toBe(true)
    expect(Object.keys(SCHEMAS)).toContain('assemble_context')
  })

  it('assembles the requested recipe with its accounting', async () => {
    await store('kafka consumer lag spiked after the rebalance')
    await handleTool('task_start', {
      project_path: NS,
      title: 'ship the assembled read',
      goal: 'one read path',
    })

    const result = parse<AssembleResult>(
      await handleTool('assemble_context', {
        project_path: NS,
        query: 'kafka',
        budget_chars: 1200,
        recipe: 'session-priming',
      })
    )
    expect(result.sections.map((section) => section.kind)).toEqual([
      'working',
      'state',
      'summaries',
      'memories',
    ])
    expect(result.accounting.used).toBeLessThanOrEqual(1200)
    expect(result.trace.channels).toContain('memories')
    expect(result.legacy).toBeUndefined()
  })

  it('returns the recall_context payload under the default recipe', async () => {
    await store('kafka consumer lag spiked after the rebalance')
    await store('grocery list for the weekend', { type: 'note' })

    const assembled = parse<AssembleResult>(
      await handleTool('assemble_context', { project_path: NS, query: 'kafka', budget_chars: 1200 })
    )
    const recall = parse<Record<string, unknown>>(
      await handleTool('recall_context', { project_path: NS, query: 'kafka', budget_chars: 1200 })
    )
    expect(assembled.legacy).toBeDefined()
    expect(Object.keys(assembled.legacy as object)).toEqual(Object.keys(recall))
    expect(assembled.legacy?.namespace).toBe(recall.namespace)
  })

  it('rejects an unknown recipe with the registry names', async () => {
    const result = await handleTool('assemble_context', { project_path: NS, recipe: 'no-such-recipe' })
    expect(result.isError).toBe(true)
    expect(parse<{ error: string }>(result).error).toContain('unknown recipe "no-such-recipe"')
  })
})

describe('assembled context prompt', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('renders one block per section with ids kept for drill-down', async () => {
    await store('kafka consumer lag spiked after the rebalance')
    await handleTool('task_start', { project_path: NS, title: 'ship the assembled read', goal: 'one read path' })

    const reply = await getPrompt(ASSEMBLED_CONTEXT, { namespace: NS, recipe: 'session-priming' }, {})
    if ('error' in reply) throw new Error(reply.error)
    const text = reply.messages[0].content.text
    expect(text).toContain(`# assembled context — ${NS} (recipe session-priming`)
    expect(text).toContain('## working')
    expect(text).toContain('ship the assembled read')
    expect(text).toContain('## state')
    expect(text).toContain('## memories')
  })

  it('reports an unknown recipe instead of a broken message', async () => {
    const reply = await getPrompt(ASSEMBLED_CONTEXT, { namespace: NS, recipe: 'no-such-recipe' }, {})
    expect('error' in reply && reply.error).toContain('unknown recipe')
  })
})
