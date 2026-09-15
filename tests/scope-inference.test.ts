import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { inferScope, scopeCandidates } from '../src/memory/scope-inference.js'
import { ensureNode } from '../src/namespace/tree.js'

const llm = vi.hoisted(() => ({
  isLlmConfigured: vi.fn(() => true),
  chatJson: vi.fn(),
}))

// Keep the real client module, override only the two functions scope-inference
// imports — so tests never hit a real endpoint.
vi.mock('../src/llm/client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/llm/client.js')>()
  return { ...orig, isLlmConfigured: llm.isLlmConfigured, chatJson: llm.chatJson }
})

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
  routed_via: 'explicit' | 'mention' | 'inferred' | 'root'
}

async function store(args: Record<string, unknown>): Promise<StoredMemory> {
  // Default an explicit importance so the store path skips async importance
  // scoring (which also calls the LLM) and the test only observes inference.
  return parse<StoredMemory>(await handleTool('store_memory', { importance: 0.5, ...args }))
}

describe('store_memory LLM scope inference (P3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    llm.isLlmConfigured.mockReturnValue(true)
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  afterEach(() => {
    delete process.env.ENGRAM_SCOPE_INFERENCE
    vi.restoreAllMocks()
  })

  it('invariant 1: deterministic mention wins over inference', async () => {
    await store({ content: 'seed invoice reconciliation', project_path: '/p', scope: 'payments' })
    llm.chatJson.mockReset()

    const mem = await store({ content: 'the payments module handles refunds', project_path: '/p' })

    expect(mem.namespace).toBe('/p//payments')
    expect(mem.routed_scope).toBe('payments')
    expect(mem.routed_via).toBe('mention')
    expect(llm.chatJson).not.toHaveBeenCalled()
  })

  it('invariant 2: an LLM-suggested token outside the candidates is ignored', async () => {
    await store({ content: 'seed invoice reconciliation', project_path: '/p', scope: 'payments' })
    llm.chatJson.mockResolvedValue({ data: { scope: 'other' } })

    const mem = await store({ content: 'cron job failure note', project_path: '/p' })

    expect(mem.namespace).toBe('/p')
    expect(mem.routed_scope).toBeUndefined()
    expect(mem.routed_via).toBe('root')
    expect(llm.chatJson).toHaveBeenCalledOnce()
  })

  it('invariant 3: unconfigured LLM degrades to root without failing the store', async () => {
    llm.isLlmConfigured.mockReturnValue(false)
    await store({ content: 'seed invoice reconciliation', project_path: '/p', scope: 'payments' })

    const mem = await store({ content: 'refund processing edge case', project_path: '/p' })

    expect(mem.namespace).toBe('/p')
    expect(mem.routed_via).toBe('root')
    expect(llm.chatJson).not.toHaveBeenCalled()
  })

  it('invariant 4: ENGRAM_SCOPE_INFERENCE=0 skips the LLM entirely', async () => {
    await store({ content: 'seed invoice reconciliation', project_path: '/p', scope: 'payments' })
    process.env.ENGRAM_SCOPE_INFERENCE = '0'
    llm.chatJson.mockReset()

    const mem = await store({ content: 'refund processing edge case', project_path: '/p' })

    expect(mem.namespace).toBe('/p')
    expect(mem.routed_via).toBe('root')
    expect(llm.chatJson).not.toHaveBeenCalled()
  })

  it('invariant 5: valid inference routes into the existing synthetic scope', async () => {
    await store({ content: 'seed invoice reconciliation', project_path: '/p', scope: 'payments' })
    llm.chatJson.mockResolvedValue({ data: { scope: 'payments' } })

    const mem = await store({ content: 'refund processing edge case', project_path: '/p' })

    expect(mem.namespace).toBe('/p//payments')
    expect(mem.routed_scope).toBe('payments')
    expect(mem.routed_via).toBe('inferred')
    expect(llm.chatJson).toHaveBeenCalledOnce()

    const row = getDatabase().db
      .prepare('SELECT namespace, project_path FROM memories WHERE id = ?')
      .get(mem.id) as { namespace: string; project_path: string }
    expect(row.namespace).toBe('/p//payments')
  })

  it('explicit scope reports routed_via explicit without routed_scope', async () => {
    const mem = await store({ content: 'stripe webhook signature', project_path: '/p', scope: 'payments' })
    expect(mem.namespace).toBe('/p//payments')
    expect(mem.routed_scope).toBeUndefined()
    expect(mem.routed_via).toBe('explicit')
  })
})

describe('inferScope unit behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    llm.isLlmConfigured.mockReturnValue(true)
    resetDatabase()
    getDatabase(':memory:')
  })

  afterEach(() => {
    delete process.env.ENGRAM_SCOPE_INFERENCE
    vi.restoreAllMocks()
  })

  it('returns unavailable without calling the LLM when no candidates exist', async () => {
    const db = getDatabase().db
    ensureNode(db, '/p/sub') // real (non-synthetic) child, not a candidate

    const res = await inferScope(db, '/p', 'whatever content')

    expect(res).toEqual({ scope: null, via: 'unavailable' })
    expect(llm.chatJson).not.toHaveBeenCalled()
  })

  it('scopeCandidates lists only synthetic children, richest first', async () => {
    const db = getDatabase().db
    ensureNode(db, '/p//billing')
    ensureNode(db, '/p//payments')
    ensureNode(db, '/p/sub') // real child, excluded

    // Bump billing's memory count so ordering is deterministic by count DESC.
    db.prepare('UPDATE namespace_nodes SET memory_count = 5 WHERE path = ?').run('/p//billing')

    const candidates = scopeCandidates(db, '/p')
    expect(candidates.map((c) => c.token)).toEqual(['billing', 'payments'])
  })

  it('downgrades an LLM failure to unavailable', async () => {
    const db = getDatabase().db
    ensureNode(db, '/p//payments')
    llm.chatJson.mockRejectedValue(new Error('boom'))

    const res = await inferScope(db, '/p', 'refund processing edge case')

    expect(res).toEqual({ scope: null, via: 'unavailable' })
  })

  it('downgrades non-object JSON to unavailable', async () => {
    const db = getDatabase().db
    ensureNode(db, '/p//payments')
    llm.chatJson.mockResolvedValue({ data: 'payments' })

    const res = await inferScope(db, '/p', 'refund processing edge case')

    expect(res).toEqual({ scope: null, via: 'unavailable' })
  })
})
