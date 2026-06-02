import { describe, it, expect } from 'vitest'
import { tools } from '../src/mcp/tools.js'

interface Tool {
  name: string
  description: string
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] }
  annotations: {
    title: string
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
}

const byName = new Map(tools.map((t) => [t.name, t as Tool]))

describe('mcp tool annotations', () => {
  it('every tool has full MCP Nov 2025 annotation set', () => {
    for (const t of tools as Tool[]) {
      expect(t.annotations).toBeDefined()
      expect(typeof t.annotations.title).toBe('string')
      expect(typeof t.annotations.readOnlyHint).toBe('boolean')
      expect(typeof t.annotations.destructiveHint).toBe('boolean')
      expect(typeof t.annotations.idempotentHint).toBe('boolean')
      expect(typeof t.annotations.openWorldHint).toBe('boolean')
    }
  })

  it('read-only tools are marked readOnlyHint=true and destructiveHint=false', () => {
    const readOnly = ['search_memories', 'get_context', 'get_related', 'consolidate_memories', 'list_memories']
    for (const name of readOnly) {
      const t = byName.get(name)!
      expect(t.annotations.readOnlyHint).toBe(true)
      expect(t.annotations.destructiveHint).toBe(false)
    }
  })

  it('forget_memory is the only destructive tool', () => {
    const destructive = (tools as Tool[]).filter((t) => t.annotations.destructiveHint)
    expect(destructive.map((t) => t.name)).toEqual(['forget_memory'])
  })

  it('store_memory has openWorldHint=true (LLM adjudication side-effect)', () => {
    const t = byName.get('store_memory')!
    expect(t.annotations.openWorldHint).toBe(true)
    expect(t.annotations.readOnlyHint).toBe(false)
  })

  it('namespace + project_path are accepted on every multi-tenant tool', () => {
    const namespaced = [
      'store_memory',
      'search_memories',
      'get_context',
      'consolidate_memories',
      'list_memories',
    ]
    for (const name of namespaced) {
      const t = byName.get(name)!
      expect(t.inputSchema.properties.namespace).toBeDefined()
      expect(t.inputSchema.properties.project_path).toBeDefined()
    }
  })

  it('include_superseded is accepted on every read tool that returns memory rows', () => {
    const reads = ['search_memories', 'get_context', 'get_related', 'list_memories']
    for (const name of reads) {
      const t = byName.get(name)!
      expect(t.inputSchema.properties.include_superseded).toBeDefined()
    }
  })

  it('store_memory exposes adjudicate_sync', () => {
    const t = byName.get('store_memory')!
    expect(t.inputSchema.properties.adjudicate_sync).toBeDefined()
  })

  it('tool names are unique', () => {
    const names = (tools as Tool[]).map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
