import { describe, it, expect, beforeEach } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { getNode } from '../src/namespace/tree.js'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
}

function parse<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T
}

interface StoredMemory {
  id: string
  content: string
  namespace: string
  routed_scope?: string
}

async function store(args: Record<string, unknown>): Promise<StoredMemory> {
  return parse<StoredMemory>(await handleTool('store_memory', args))
}

describe('store_memory scope routing', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('invariant 1: explicit scope stores into a synthetic namespace + node row', async () => {
    const mem = await store({
      content: 'stripe webhook verifies signatures',
      project_path: '/p',
      scope: 'payments',
    })

    expect(mem.namespace).toBe('/p//payments')
    expect(mem.routed_scope).toBeUndefined()

    const node = getNode(getDatabase().db, '/p//payments')
    expect(node).not.toBeNull()
    expect(node!.is_synthetic).toBe(true)
    expect(node!.parent_path).toBe('/p')
    expect(node!.depth).toBe(2)

    const row = getDatabase().db
      .prepare('SELECT namespace, project_path FROM memories WHERE id = ?')
      .get(mem.id) as { namespace: string; project_path: string }
    expect(row.namespace).toBe('/p//payments')
    expect(row.project_path).toBe('/p//payments')
  })

  it('invariant 2: invalid scopes are rejected with validation errors', async () => {
    for (const scope of ['a/b', 'a//b', '', '   ', 'x'.repeat(65)]) {
      const result = parse<{ error: string }>(
        await handleTool('store_memory', { content: 'test', project_path: '/p', scope })
      )
      expect(result.error).toMatch(/Validation failed/)
    }
  })

  it('invariant 3: auto-route fires only on a word-boundary match of an existing scope', async () => {
    // Seed a synthetic sibling scope.
    await store({ content: 'seed invoice reconciliation', project_path: '/p', scope: 'payments' })

    // Standalone word match routes in.
    const hit = await store({
      content: 'the payments module handles refunds',
      project_path: '/p',
    })
    expect(hit.namespace).toBe('/p//payments')
    expect(hit.routed_scope).toBe('payments')

    // Substring must NOT match: 'payment' != scope 'payments'.
    const miss = await store({
      content: 'a payment gateway timeout happened',
      project_path: '/p',
    })
    expect(miss.namespace).toBe('/p')
    expect(miss.routed_scope).toBeUndefined()
  })

  it('invariant 3b: explicit scope wins and never auto-routes', async () => {
    await store({ content: 'seed billing cycle', project_path: '/p', scope: 'payments' })
    await store({ content: 'seed payout schedule', project_path: '/p', scope: 'billing' })

    // Content mentions 'billing' but an explicit scope forces 'payments'.
    const mem = await store({
      content: 'billing payout gets routed nowhere else',
      project_path: '/p',
      scope: 'payments',
    })
    expect(mem.namespace).toBe('/p//payments')
    expect(mem.routed_scope).toBeUndefined()
  })

  it('invariant 4: funnel sees scoped memories; sibling scopes stay invisible', async () => {
    await store({ content: 'zebra payments ledger entry', project_path: '/p', scope: 'payments' })
    await store({ content: 'zebra billing recurring charge', project_path: '/p', scope: 'billing' })
    await store({ content: 'zebra generic project note', project_path: '/p' })

    const res = parse<{ memories: Array<{ namespace: string }> }>(
      await handleTool('get_context', { namespace: '/p//payments', query: 'zebra' })
    )

    expect(res.memories.length).toBeGreaterThan(0)
    for (const m of res.memories) {
      expect(m.namespace).toBe('/p//payments')
    }
  })
})
