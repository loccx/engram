import { describe, it, expect, beforeEach } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { createServer } from '../src/server.js'
import { PROTOCOL_SLIM } from '../src/delivery/protocol.js'

interface InitializeResult {
  result?: {
    protocolVersion?: string
    capabilities?: Record<string, unknown>
    serverInfo?: { name?: string; version?: string }
    instructions?: string
  }
  error?: { message: string }
}

async function initialize(server = createServer()): Promise<InitializeResult> {
  const res = await server.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }),
  })
  return (await res.json()) as InitializeResult
}

describe('MCP initialize instructions', () => {
  beforeEach(() => {
    resetDatabase()
    getDatabase(':memory:')
  })

  it('carries the standing rules so a client gets them without calling a tool', async () => {
    const { result } = await initialize()
    expect(result?.instructions).toBe(PROTOCOL_SLIM)
    expect(result?.instructions).toContain('get_context')
    expect(result?.instructions).toContain('store_memory')
  })

  it('echoes the requested legacy version and advertises the non-tool surfaces', async () => {
    const { result, error } = await initialize()
    expect(error).toBeUndefined()
    expect(result?.protocolVersion).toBe('2024-11-05')
    expect(result?.serverInfo?.name).toBe('engram')
    expect(result?.capabilities).toEqual({
      tools: {},
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false },
    })
  })

  it('keeps the payload small enough to sit in a system prompt', () => {
    expect(PROTOCOL_SLIM.length).toBeLessThan(1400)
    expect(PROTOCOL_SLIM.split('\n').length).toBeLessThanOrEqual(30)
  })
})
