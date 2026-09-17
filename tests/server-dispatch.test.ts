import { describe, it, expect, beforeEach } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { resetServicesForTests } from '../src/mcp/handlers.js'
import { createServer } from '../src/server.js'
import { tools } from '../src/mcp/tools.js'

interface JsonRpcResponse {
  jsonrpc: string
  id: unknown
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

async function rpc(body: unknown): Promise<{ status: number; json: JsonRpcResponse | null }> {
  const app = createServer()
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? (JSON.parse(text) as JsonRpcResponse) : null }
}

describe('MCP JSON-RPC dispatch', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('rejects a bare unknown method with -32601', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'totally/unknown' })
    expect(status).toBe(400)
    expect(json?.error?.code).toBe(-32601)
    expect(json?.result).toBeUndefined()
  })

  it('does not let a bare tool name bypass tools/call', async () => {
    // Regression: the previous fallback dispatched ANY method string into
    // handleTool(), so `method: "get_stats"` invoked the tool with no
    // tools/call validation and no way to distinguish it from a real method.
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 2, method: 'get_stats' })
    expect(status).toBe(400)
    expect(json?.error?.code).toBe(-32601)
    expect(json?.result).toBeUndefined()
  })

  it('rejects every known tool name sent as a bare method', async () => {
    for (const tool of tools) {
      const { status, json } = await rpc({ jsonrpc: '2.0', id: 3, method: tool.name })
      expect(status, `${tool.name} must not be reachable as a bare method`).toBe(400)
      expect(json?.error?.code).toBe(-32601)
      expect(json?.result).toBeUndefined()
    }
  })

  it('rejects tools/call without params.name', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} })
    expect(status).toBe(400)
    expect(json?.error?.code).toBe(-32602)
  })

  it('rejects an unknown tool name before dispatch', async () => {
    const { status, json } = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'definitely_not_a_tool', arguments: {} },
    })
    expect(status).toBe(400)
    expect(json?.error?.code).toBe(-32602)
    expect(json?.error?.message).toContain('definitely_not_a_tool')
    expect(json?.result).toBeUndefined()
  })

  it('still serves a valid tools/call', async () => {
    const { status, json } = await rpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'get_stats', arguments: {} },
    })
    expect(status).toBe(200)
    expect(json?.error).toBeUndefined()
    expect(Array.isArray(json?.result?.content)).toBe(true)
  })

  it('still serves initialize and tools/list', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 7, method: 'initialize' })
    expect(init.status).toBe(200)
    expect((init.json?.result as { protocolVersion?: string })?.protocolVersion).toBeTruthy()

    const list = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/list' })
    expect(list.status).toBe(200)
    expect((list.json?.result as { tools?: unknown[] })?.tools).toHaveLength(tools.length)
  })

  it('answers ping and absorbs notifications without a JSON-RPC body', async () => {
    const ping = await rpc({ jsonrpc: '2.0', id: 9, method: 'ping' })
    expect(ping.status).toBe(200)
    expect(ping.json?.result).toEqual({})

    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(note.status).toBe(202)
    expect(note.json).toBeNull()
  })
})
