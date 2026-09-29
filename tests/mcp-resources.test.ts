import { describe, it, expect, beforeEach } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { resetServicesForTests } from '../src/mcp/handlers.js'
import { createServer } from '../src/server.js'
import { refreshDigest } from '../src/memory/digest.js'
import { PROTOCOL_RULES } from '../src/delivery/protocol.js'
import { encodeHeaderValue, SERVER_INFO } from '../src/mcp/revisions.js'

const NS = '/work/engram'
const MODERN_VERSION = '2026-07-28'
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo'

interface RpcResponse {
  jsonrpc: string
  id: unknown
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

function seed(id: string, content: string, opts: { pinned?: boolean } = {}): void {
  const db = getDatabase().db
  db.prepare("INSERT OR IGNORE INTO sessions(id, project_path, started_at) VALUES ('s1', ?, 1000)").run(NS)
  db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, pinned)
     VALUES (?, 's1', ?, ?, ?, 'decision', 0.8, '[]', 1000, 1000, ?)`
  ).run(id, NS, NS, content, opts.pinned ? 1 : 0)
}

function modernMeta(): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
  }
}

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

describe('mcp resources', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('lists the standing rules plus the namespace resources the url scopes to', async () => {
    const scoped = await post(
      { jsonrpc: '2.0', id: 1, method: 'resources/list' },
      {},
      `?project=${encodeURIComponent(NS)}`
    )
    expect(scoped.status).toBe(200)
    const resources = scoped.json.result?.resources as Array<{ uri: string; mimeType: string }>
    expect(resources.map((entry) => entry.uri)).toEqual([
      'engram://protocol/rules',
      `engram://${NS}/digest`,
      `engram://${NS}/roster`,
    ])
    expect(resources.every((entry) => entry.mimeType === 'text/markdown')).toBe(true)
    expect(scoped.json.result?.resultType).toBeUndefined()

    const unscoped = await post({ jsonrpc: '2.0', id: 2, method: 'resources/list' })
    expect((unscoped.json.result?.resources as unknown[]).length).toBe(1)
  })

  it('lists the parameterized resources as templates', async () => {
    const { status, json } = await post({ jsonrpc: '2.0', id: 3, method: 'resources/templates/list' })
    expect(status).toBe(200)
    const templates = json.result?.resourceTemplates as Array<{ uriTemplate: string; mimeType: string }>
    expect(templates.map((entry) => entry.uriTemplate)).toEqual([
      'engram://{namespace}/digest',
      'engram://{namespace}/roster',
    ])
    expect(templates.every((entry) => entry.mimeType === 'text/markdown')).toBe(true)
  })

  it('reads the standing rules', async () => {
    const uri = 'engram://protocol/rules'
    const { status, json } = await post({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri },
    })
    expect(status).toBe(200)
    const contents = json.result?.contents as Array<{ uri: string; mimeType: string; text: string }>
    expect(contents[0].mimeType).toBe('text/markdown')
    expect(contents[0].text).toBe(PROTOCOL_RULES)
  })

  it('reads a namespace digest, as markdown and cacheable', async () => {
    seed('p1', 'the deploy window is 09:00-11:30 utc', { pinned: true })
    await refreshDigest(getDatabase().db, NS)

    const uri = `engram://${NS}/digest`
    const params = { uri, _meta: modernMeta() }
    const { status, json } = await post(
      { jsonrpc: '2.0', id: 5, method: 'resources/read', params },
      modernHeaders('resources/read', params)
    )
    expect(status).toBe(200)
    const contents = json.result?.contents as Array<{ uri: string; text: string }>
    expect(contents[0].uri).toBe(uri)
    expect(contents[0].text).toContain('the deploy window is 09:00-11:30 utc')
    expect(json.result?.resultType).toBe('complete')
    expect(json.result?.ttlMs).toBe(60_000)
    expect(json.result?.cacheScope).toBe('private')
    expect((json.result?._meta as Record<string, unknown>)?.[SERVER_INFO_META]).toEqual(SERVER_INFO)
  })

  it('reads the roster as markdown lines', async () => {
    seed('r1', 'a decision worth recalling at session start')

    const uri = `engram://${NS}/roster`
    const { status, json } = await post({
      jsonrpc: '2.0',
      id: 6,
      method: 'resources/read',
      params: { uri },
    })
    expect(status).toBe(200)
    const text = (json.result?.contents as Array<{ text: string }>)[0].text
    expect(text).toContain(`# roster — ${NS}`)
    expect(text).toContain('a decision worth recalling at session start')
    expect(text).toContain('(id r1)')
  })

  it('names an empty namespace instead of returning an empty body', async () => {
    const { status, json } = await post({
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/read',
      params: { uri: 'engram:///work/nothing-here/roster' },
    })
    expect(status).toBe(200)
    expect((json.result?.contents as Array<{ text: string }>)[0].text).toContain(
      'no memories in /work/nothing-here yet'
    )
  })

  it('rejects an unknown uri with -32602', async () => {
    const { status, json } = await post({
      jsonrpc: '2.0',
      id: 8,
      method: 'resources/read',
      params: { uri: 'engram://protocol/nope' },
    })
    expect(status).toBe(400)
    expect(json.error?.code).toBe(-32602)

    const missing = await post({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: {} })
    expect(missing.json.error?.code).toBe(-32602)
  })

  it('resolves a percent-encoded namespace in a uri', async () => {
    seed('p2', 'encoded namespace memory', { pinned: true })
    await refreshDigest(getDatabase().db, NS)

    const uri = `engram://${encodeURIComponent(NS)}/digest`
    const { status, json } = await post({
      jsonrpc: '2.0',
      id: 10,
      method: 'resources/read',
      params: { uri },
    })
    expect(status).toBe(200)
    expect((json.result?.contents as Array<{ text: string }>)[0].text).toContain(
      'encoded namespace memory'
    )
  })
})

describe('mcp prompts', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('lists the session primer with its optional argument', async () => {
    const { status, json } = await post({ jsonrpc: '2.0', id: 11, method: 'prompts/list' })
    expect(status).toBe(200)
    const prompts = json.result?.prompts as Array<{
      name: string
      description: string
      arguments: Array<{ name: string; required: boolean }>
    }>
    // the assembled-context prompt joined the list; the primer's own output is unchanged
    expect(prompts).toHaveLength(2)
    expect(prompts[0].name).toBe('engram/session-primer')
    expect(prompts[0].description).toBeTruthy()
    expect(prompts[0].arguments).toEqual([
      { name: 'namespace', description: expect.any(String), required: false },
    ])
    expect(prompts[1].name).toBe('engram/context')
    expect(prompts[1].arguments.map((argument) => argument.name)).toEqual([
      'namespace',
      'query',
      'budget_chars',
      'recipe',
    ])
    expect(prompts[1].arguments.every((argument) => argument.required === false)).toBe(true)
    expect(json.result?.resultType).toBeUndefined()
  })

  it('renders the primer as one user message with the rules and the roster', async () => {
    seed('s1', 'a decision worth recalling at session start')

    const params = {
      name: 'engram/session-primer',
      arguments: { namespace: NS },
      _meta: modernMeta(),
    }
    const { status, json } = await post(
      { jsonrpc: '2.0', id: 12, method: 'prompts/get', params },
      modernHeaders('prompts/get', params)
    )
    expect(status).toBe(200)
    expect(json.result?.resultType).toBe('complete')
    expect(json.result?.description as string).toBeTruthy()
    const messages = json.result?.messages as Array<{
      role: string
      content: { type: string; text: string }
    }>
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content.type).toBe('text')
    expect(messages[0].content.text).toContain('engram memory')
    expect(messages[0].content.text).toContain('a decision worth recalling at session start')
  })

  it('rejects an unknown prompt with -32602', async () => {
    const { status, json } = await post({
      jsonrpc: '2.0',
      id: 13,
      method: 'prompts/get',
      params: { name: 'engram/nope', arguments: {} },
    })
    expect(status).toBe(400)
    expect(json.error?.code).toBe(-32602)
  })
})
