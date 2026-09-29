import { describe, it, expect, beforeEach } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { resetServicesForTests } from '../src/mcp/handlers.js'
import { createServer } from '../src/server.js'
import { tools } from '../src/mcp/tools.js'
import { decodeHeaderValue, encodeHeaderValue, SERVER_INFO } from '../src/mcp/revisions.js'

const MODERN_VERSION = '2026-07-28'
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo'

interface RpcResponse {
  jsonrpc: string
  id: unknown
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}

function modernMeta(version = MODERN_VERSION): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientCapabilities': {},
  }
}

/** the headers a modern client mirrors out of its body */
function modernHeaders(method: string, params: Record<string, unknown> = {}): Record<string, string> {
  const name = params.name ?? params.uri
  return {
    'mcp-protocol-version': MODERN_VERSION,
    'mcp-method': method,
    ...(typeof name === 'string' ? { 'mcp-name': encodeHeaderValue(name) } : {}),
  }
}

async function post(
  body: unknown,
  headers: Record<string, string> = {},
  query = ''
): Promise<{ status: number; json: RpcResponse }> {
  const res = await createServer().request(`/mcp${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? (JSON.parse(text) as RpcResponse) : (null as never) }
}

describe('legacy mcp revisions', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('echoes a requested legacy version and advertises the non-tool surfaces', async () => {
    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
      const { status, json } = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '0' } },
      })
      expect(status, version).toBe(200)
      expect(json.result?.protocolVersion, version).toBe(version)
      expect(json.result?.capabilities, version).toEqual({
        tools: {},
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
      })
      expect(json.result?.instructions, version).toBeTruthy()
      expect(json.result?.resultType, version).toBeUndefined()
      expect(json.result?._meta, version).toBeUndefined()
    }
  })

  it('answers with the newest revision it speaks at or below the requested one', async () => {
    const future = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2027-01-01' },
    })
    expect(future.json.result?.protocolVersion).toBe('2025-11-25')

    const silent = await post({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })
    expect(silent.json.result?.protocolVersion).toBe('2024-11-05')
  })

  it('serves tools in the legacy shape, with no resultType or caching hints', async () => {
    const { status, json } = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
    expect(status).toBe(200)
    expect((json.result?.tools as unknown[]).length).toBe(tools.length)
    expect(json.result?.resultType).toBeUndefined()
    expect(json.result?.ttlMs).toBeUndefined()
  })

  it('serves a tool call without per-request metadata', async () => {
    const { status, json } = await post({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_stats', arguments: {} },
    })
    expect(status).toBe(200)
    expect(Array.isArray(json.result?.content)).toBe(true)
    expect(json.result?.resultType).toBeUndefined()
  })

  it('ignores the protocol headers a 2025-06-18 client adds without per-request metadata', async () => {
    const { status, json } = await post(
      { jsonrpc: '2.0', id: 6, method: 'tools/list' },
      { 'mcp-protocol-version': '2025-06-18', 'mcp-method': 'tools/list' }
    )
    expect(status).toBe(200)
    expect((json.result?.tools as unknown[]).length).toBe(tools.length)
    expect(json.result?.resultType).toBeUndefined()
  })

  it('rejects an unknown method with a 400', async () => {
    const { status, json } = await post({ jsonrpc: '2.0', id: 7, method: 'totally/unknown' })
    expect(status).toBe(400)
    expect(json.error?.code).toBe(-32601)
  })
})

describe('modern mcp revision', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('discovers supported versions, capabilities, identity and instructions', async () => {
    const body = { jsonrpc: '2.0', id: 11, method: 'server/discover', params: { _meta: modernMeta() } }
    const { status, json } = await post(body, modernHeaders('server/discover'))
    expect(status).toBe(200)
    expect(json.result?.resultType).toBe('complete')
    expect(json.result?.supportedVersions).toEqual([
      '2026-07-28',
      '2025-11-25',
      '2025-06-18',
      '2025-03-26',
      '2024-11-05',
    ])
    expect(json.result?.capabilities).toEqual({
      tools: {},
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false },
    })
    expect(json.result?.instructions).toBeTruthy()
    expect((json.result?._meta as Record<string, unknown>)?.[SERVER_INFO_META]).toEqual(SERVER_INFO)
    expect(json.result?.ttlMs as number).toBeGreaterThanOrEqual(0)
    expect(json.result?.cacheScope).toBe('public')
  })

  it('treats a discover probe without per-request metadata as a legacy method miss', async () => {
    const { status, json } = await post({ jsonrpc: '2.0', id: 12, method: 'server/discover' })
    expect(status).toBe(400)
    expect(json.error?.code).toBe(-32601)
  })

  it('serves tools/list and tools/call statelessly with a complete result', async () => {
    const list = await post(
      { jsonrpc: '2.0', id: 13, method: 'tools/list', params: { _meta: modernMeta() } },
      modernHeaders('tools/list')
    )
    expect(list.status).toBe(200)
    expect((list.json.result?.tools as unknown[]).length).toBe(tools.length)
    expect(list.json.result?.resultType).toBe('complete')
    expect(list.json.result?.ttlMs as number).toBeGreaterThanOrEqual(0)
    expect(list.json.result?.cacheScope).toBe('public')

    const call = await post(
      {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: { name: 'get_stats', arguments: {}, _meta: modernMeta() },
      },
      modernHeaders('tools/call', { name: 'get_stats' })
    )
    expect(call.status).toBe(200)
    expect(call.json.result?.resultType).toBe('complete')
    expect(Array.isArray(call.json.result?.content)).toBe(true)
  })

  it('answers an unsupported version with -32022 and the versions it does support', async () => {
    const body = {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/list',
      params: { _meta: modernMeta('2027-01-01') },
    }
    const { status, json } = await post(body, {
      'mcp-protocol-version': '2027-01-01',
      'mcp-method': 'tools/list',
    })
    expect(status).toBe(400)
    expect(json.error?.code).toBe(-32022)
    const data = json.error?.data as { supported: string[]; requested: string }
    expect(data.supported).toContain(MODERN_VERSION)
    expect(data.requested).toBe('2027-01-01')
  })

  it('rejects a request missing either required per-request field with -32602', async () => {
    const noVersion = await post(
      {
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/clientCapabilities': {} } },
      },
      modernHeaders('tools/list')
    )
    expect(noVersion.status).toBe(400)
    expect(noVersion.json.error?.code).toBe(-32602)

    const noCapabilities = await post(
      {
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION } },
      },
      modernHeaders('tools/list')
    )
    expect(noCapabilities.status).toBe(400)
    expect(noCapabilities.json.error?.code).toBe(-32602)
  })

  it('refuses a modern request whose mirrored headers are missing or disagree', async () => {
    const body = {
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: { name: 'get_stats', arguments: {}, _meta: modernMeta() },
    }
    const cases: Array<[string, Record<string, string>]> = [
      ['no headers', {}],
      ['no protocol header', { 'mcp-method': 'tools/call', 'mcp-name': 'get_stats' }],
      [
        'protocol header disagrees',
        { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/call', 'mcp-name': 'get_stats' },
      ],
      [
        'method header disagrees',
        { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list', 'mcp-name': 'get_stats' },
      ],
      [
        'name header missing',
        { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/call' },
      ],
      [
        'name header disagrees',
        { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/call', 'mcp-name': 'store_memory' },
      ],
    ]
    for (const [label, headers] of cases) {
      const { status, json } = await post(body, headers)
      expect(status, label).toBe(400)
      expect(json.error?.code, label).toBe(-32020)
    }
  })

  it('decodes the base64 sentinel form of a header value', async () => {
    // plain ascii travels as-is; anything else uses the sentinel form
    expect(encodeHeaderValue('get_stats')).toBe('get_stats')
    const encoded = encodeHeaderValue('naïve stats')
    expect(encoded.startsWith('=?base64?')).toBe(true)
    expect(decodeHeaderValue(encoded)).toBe('naïve stats')
    expect(decodeHeaderValue('=?base64?Z2V0X3N0YXRz?=')).toBe('get_stats')

    const { status, json } = await post(
      {
        jsonrpc: '2.0',
        id: 19,
        method: 'tools/call',
        params: { name: 'get_stats', arguments: {}, _meta: modernMeta() },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': '=?base64?Z2V0X3N0YXRz?=',
      }
    )
    expect(status).toBe(200)
    expect(json.result?.resultType).toBe('complete')
  })

  it('rejects an unknown method with a 404, which legacy servers use for something else', async () => {
    const { status, json } = await post(
      { jsonrpc: '2.0', id: 20, method: 'subscriptions/listen', params: { _meta: modernMeta() } },
      modernHeaders('subscriptions/listen')
    )
    expect(status).toBe(404)
    expect(json.error?.code).toBe(-32601)
  })

  it('ignores a session header and never mints one, because the revision is stateless', async () => {
    const legacy = await createServer().request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'stale-session' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/list' }),
    })
    expect(legacy.status).toBe(200)
    expect(legacy.headers.get('mcp-session-id')).toBeNull()

    const res = await createServer().request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...modernHeaders('tools/list') },
      body: JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/list', params: { _meta: modernMeta() } }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBeNull()
  })

  it('answers the http verbs this revision dropped with 405', async () => {
    const app = createServer()
    expect((await app.request('/mcp', { method: 'GET' })).status).toBe(405)
    expect((await app.request('/mcp', { method: 'DELETE' })).status).toBe(405)
  })
})
