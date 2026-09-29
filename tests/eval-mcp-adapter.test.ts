// mcp adapter tests: the wire is exercised against a scripted server (sse, errors,
// timeouts) and against engram's own server in an isolated data dir over both
// transports. no external network, and the shipped adapter config is the stdio case.
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createServer } from '../src/server.js'
import { resetDatabase } from '../src/db/init.js'
import { EvalHarness } from '../eval/lib/harness.js'
import { closeAll, createSystems, type MemorySystem, type SystemSession } from '../eval/lib/systems.js'
import {
  createMcpSystem,
  HttpWire,
  loadAdapterConfig,
  McpCallError,
  McpClient,
  McpTimeoutError,
  parseSseFrames,
  type McpAdapterConfig,
} from '../eval/adapters/mcp.js'
import { resetGatewayForTests, setLlmTransport, type LlmCall } from '../eval/lib/llm.js'
import { buildHeader } from '../eval/lib/report.js'
import { resolveConfigs } from '../eval/lib/registry.js'
import { runLongMemEvalSuite } from '../eval/suites/longmemeval.js'
import type { SuiteContext } from '../eval/suites/types.js'
import type { ChatResult } from '../src/llm/client.js'

const NS = '/longmemeval/mcp-fixture'
const EVIDENCE = 'the deploy window for the mcp fixture is 09:00-11:30 utc'
const QUESTION = 'when is the deploy window for the mcp fixture?'

const FIXTURE: SystemSession[] = [
  { id: 's1', text: EVIDENCE, createdAt: 1_700_000_000_000, tags: ['longmemeval'] },
  {
    id: 's2',
    text: 'the mcp fixture rollback drill runs right after the deploy window',
    createdAt: 1_700_000_100_000,
    tags: ['longmemeval'],
  },
  {
    id: 's3',
    text: 'the pricing table for the mcp fixture lives in a spreadsheet',
    createdAt: 1_700_000_200_000,
    tags: ['longmemeval'],
  },
]

const tempDirs: string[] = []
const harnesses: EvalHarness[] = []
const closers: Array<() => Promise<void>> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-mcp-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  setLlmTransport(null)
  resetGatewayForTests()
  for (const key of ['ENGRAM_LLM_BASE_URL', 'ENGRAM_LLM_API_KEY', 'ENGRAM_LLM_MODEL']) {
    delete process.env[key]
  }
  while (closers.length > 0) await closers.pop()!()
  while (harnesses.length > 0) harnesses.pop()!.dispose()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

interface ScriptedReply {
  status?: number
  contentType?: string
  sessionId?: string
  /** frames written to an event-stream response, in order */
  frames?: unknown[]
  body?: unknown
  /** never answer, so the caller's timeout fires */
  silent?: boolean
}

interface SeenRequest {
  method: string
  session: string
  protocol: string
  name: string
}

async function scriptedServer(
  reply: (message: Record<string, unknown>) => ScriptedReply
): Promise<{ url: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = []
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      seen.push({
        method: String(message.method ?? ''),
        session: String(req.headers['mcp-session-id'] ?? ''),
        protocol: String(req.headers['mcp-protocol-version'] ?? ''),
        name: String(req.headers['mcp-name'] ?? ''),
      })
      const scripted = reply(message)
      if (scripted.silent) return
      if (scripted.frames) {
        res.writeHead(scripted.status ?? 200, {
          'content-type': scripted.contentType ?? 'text/event-stream',
          ...(scripted.sessionId ? { 'mcp-session-id': scripted.sessionId } : {}),
        })
        for (const frame of scripted.frames) {
          res.write(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
        }
        res.end()
        return
      }
      res.writeHead(scripted.status ?? 200, {
        'content-type': scripted.contentType ?? 'application/json',
        ...(scripted.sessionId ? { 'mcp-session-id': scripted.sessionId } : {}),
      })
      res.end(JSON.stringify(scripted.body ?? {}))
    })
  })
  closers.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/mcp`, seen }
}

function answer(message: Record<string, unknown>, result: unknown): ScriptedReply {
  return { body: { jsonrpc: '2.0', id: message.id, result }, sessionId: 'sess-1' }
}

describe('mcp sse', () => {
  it('parses complete frames and keeps the partial one', () => {
    expect(parseSseFrames('data: {"a":1}\n\ndata: {"b":')).toEqual({
      messages: ['{"a":1}'],
      rest: 'data: {"b":',
    })
  })

  it('joins multi-line data and ignores comment and event fields', () => {
    const parsed = parseSseFrames(': keepalive\nevent: message\ndata: {"a":\ndata: 1}\n\n')
    expect(parsed.messages).toEqual(['{"a":\n1}'])
    expect(parsed.rest).toBe('')
  })
})

describe('mcp client', () => {
  it('falls back to initialize when the probe is not a modern reply, and carries the session id', async () => {
    const { url, seen } = await scriptedServer((message) => {
      if (message.method === 'server/discover') {
        return { body: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } } }
      }
      if (message.method === 'initialize') {
        return answer(message, { protocolVersion: '2025-06-18', capabilities: {} })
      }
      return {
        sessionId: 'sess-1',
        frames: [
          { jsonrpc: '2.0', method: 'notifications/message' },
          { jsonrpc: '2.0', id: message.id, result: { ok: true } },
        ],
      }
    })
    const client = await McpClient.start(new HttpWire({ url }), { timeoutMs: 5000 })
    try {
      expect(client.protocolEra).toBe('legacy')
      expect(client.protocolVersion).toBe('2025-06-18')
      expect(await client.callTool('search_memories', { query: 'x' })).toEqual({ ok: true })
      expect(seen.map((entry) => entry.method)).toEqual([
        'server/discover',
        'initialize',
        'notifications/initialized',
        'tools/call',
      ])
      expect(seen[2].session).toBe('sess-1')
      expect(seen[3].session).toBe('sess-1')
      expect(seen[3].protocol).toBe('')
    } finally {
      await client.close()
    }
  }, 30_000)

  it('probes server/discover first and stays modern: per-request _meta, no initialize, mirrored headers', async () => {
    const { url, seen } = await scriptedServer((message) => {
      if (message.method === 'server/discover') {
        return {
          body: {
            jsonrpc: '2.0',
            id: message.id,
            result: { supportedVersions: ['2026-07-28', '2025-11-25'], capabilities: { tools: {} } },
          },
        }
      }
      return { body: { jsonrpc: '2.0', id: message.id, result: { content: [] } } }
    })
    const client = await McpClient.start(new HttpWire({ url }), { timeoutMs: 5000 })
    try {
      expect(client.protocolEra).toBe('modern')
      expect(client.protocolVersion).toBe('2026-07-28')
      await client.callTool('search_memories', { query: 'x' })
      expect(seen.map((entry) => entry.method)).toEqual(['server/discover', 'tools/call'])
      expect(seen[1].protocol).toBe('2026-07-28')
      expect(seen[1].name).toBe('search_memories')
      expect(seen[1].session).toBe('')
    } finally {
      await client.close()
    }
  }, 30_000)

  it('keeps a refused probe out of the legacy path when a modern version is advertised', async () => {
    const { url, seen } = await scriptedServer((message) =>
      message.method === 'server/discover'
        ? {
            status: 400,
            body: {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32022,
                message: 'Unsupported protocol version',
                data: { supported: ['2026-07-28', '2025-11-25'], requested: '2027-01-01' },
              },
            },
          }
        : { body: { jsonrpc: '2.0', id: message.id, result: { content: [] } } }
    )
    const client = await McpClient.start(new HttpWire({ url }), { timeoutMs: 5000 })
    try {
      expect(client.protocolEra).toBe('modern')
      expect(client.protocolVersion).toBe('2026-07-28')
      await client.callTool('search_memories', { query: 'x' })
      expect(seen.map((entry) => entry.method)).toEqual(['server/discover', 'tools/call'])
    } finally {
      await client.close()
    }
  }, 30_000)

  it('surfaces a json-rpc error with the tool that failed', async () => {
    const { url } = await scriptedServer((message) =>
      message.method === 'tools/call'
        ? {
            body: {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32602, message: 'Unknown tool: nope' },
            },
          }
        : answer(message, {})
    )
    const client = await McpClient.start(new HttpWire({ url }), { timeoutMs: 5000 })
    try {
      const failure = await client.callTool('nope', {}).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(McpCallError)
      expect((failure as McpCallError).tool).toBe('nope')
      expect((failure as McpCallError).code).toBe(-32602)
      expect((failure as McpCallError).message).toContain('Unknown tool: nope')
    } finally {
      await client.close()
    }
  }, 30_000)

  it('surfaces a tool-level error result as a call error', async () => {
    const { url } = await scriptedServer((message) =>
      message.method === 'tools/call'
        ? answer(message, { content: [{ type: 'text', text: 'content rejected' }], isError: true })
        : answer(message, {})
    )
    const client = await McpClient.start(new HttpWire({ url }), { timeoutMs: 5000 })
    try {
      const failure = await client.callTool('store_memory', {}).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(McpCallError)
      expect((failure as McpCallError).tool).toBe('store_memory')
      expect((failure as McpCallError).message).toContain('content rejected')
    } finally {
      await client.close()
    }
  }, 30_000)

  it('times out instead of hanging on a server that never answers', async () => {
    const { url } = await scriptedServer((message) =>
      message.method === 'initialize' ? answer(message, {}) : { silent: true }
    )
    const client = await McpClient.start(new HttpWire({ url }), { timeoutMs: 150 })
    try {
      const failure = await client.callTool('search_memories', {}).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(McpTimeoutError)
      expect((failure as McpTimeoutError).tool).toBe('search_memories')
    } finally {
      await client.close()
    }
  }, 30_000)
})

function engramMcpConfig(url: string, name: string): McpAdapterConfig {
  return {
    name,
    describe: 'engram through the http mcp endpoint',
    transport: { kind: 'http', url },
    write: {
      tool: 'store_memory',
      args: { content: '${session.text}', project_path: '${namespace}', type: 'note' },
      idPath: 'id',
    },
    search: {
      tool: 'recall_context',
      args: {
        query: '${query}',
        project_path: '${namespace}',
        budget_chars: '${budgetChars}',
        limit: '${topK}',
        mode: 'fused',
      },
    },
    context: {
      sections: ['digest', 'memories[].content', 'topics[].summary'],
      items: { path: 'memories[]', text: 'content', id: 'id' },
    },
    timeoutMs: 20_000,
  }
}

describe('mcp system in a suite run', () => {
  it('records the system name and the adapter config hash on every checkpoint row', async () => {
    const dir = tempDir()
    const adapterPath = join(dir, 'scripted.json')
    const byNamespace = new Map<string, Array<{ id: string; content: string }>>()
    let stored = 0
    const { url } = await scriptedServer((message) => {
      const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
      if (message.method === 'tools/list') {
        return answer(message, { tools: [{ name: 'store_memory' }, { name: 'recall_context' }] })
      }
      const namespace = String(params.arguments?.project_path ?? '')
      const list = byNamespace.get(namespace) ?? []
      if (params.name === 'store_memory') {
        const id = `db-${++stored}`
        list.push({ id, content: String(params.arguments?.content ?? '') })
        byNamespace.set(namespace, list)
        return answer(message, { id })
      }
      return answer(message, { digest: '', memories: list, topics: [] })
    })
    writeFileSync(
      adapterPath,
      JSON.stringify({
        name: 'scripted',
        transport: { kind: 'http', url },
        write: {
          tool: 'store_memory',
          args: { content: '${session.text}', project_path: '${namespace}' },
          idPath: 'id',
        },
        search: {
          tool: 'recall_context',
          args: { query: '${query}', project_path: '${namespace}' },
        },
        context: {
          sections: ['digest', 'memories[].content'],
          items: { path: 'memories[]', text: 'content', id: 'id' },
        },
      }),
      'utf8'
    )
    const hash = createHash('sha256')
      .update(readFileSync(adapterPath, 'utf8'))
      .digest('hex')
      .slice(0, 16)

    process.env.ENGRAM_LLM_BASE_URL = 'https://gateway.example.invalid/v1'
    process.env.ENGRAM_LLM_API_KEY = 'sk-test-not-a-real-key'
    process.env.ENGRAM_LLM_MODEL = 'test-model'
    resetGatewayForTests()
    setLlmTransport(
      async (call: LlmCall): Promise<ChatResult> => ({
        // one message is the judge, the rest is the reader
        content: call.messages.length === 1 ? 'yes' : 'ANSWER-OK',
        model: call.model,
      })
    )

    const datasetPath = join(dir, 'fixture.json')
    writeFileSync(
      datasetPath,
      JSON.stringify([
        {
          question_id: 'q-mcp',
          question: QUESTION,
          answer: EVIDENCE,
          question_type: 'single-session-user',
          question_date: '2023/04/10 (Mon) 17:50',
          haystack_session_ids: ['sess-0'],
          haystack_dates: ['2023/04/10 (Mon) 17:50'],
          haystack_sessions: [
            [
              { role: 'user', content: 'what is the deploy window?' },
              { role: 'assistant', content: EVIDENCE, has_answer: true },
            ],
          ],
          answer_session_ids: ['sess-0'],
        },
      ]),
      'utf8'
    )
    const checkpointPath = join(dir, 'run.jsonl')
    const ctx: SuiteContext = {
      seed: 11,
      configs: resolveConfigs(['baseline']),
      vectors: 'fts',
      qa: true,
      dataset: 'fixture-split',
      datasetPath,
      limit: 1,
      systems: [`mcp:${adapterPath}`],
      readerModel: 'stub-reader',
      judgeModel: 'stub-judge',
      checkpointPath,
      concurrency: 1,
      yes: true,
      envFile: join(dir, 'no-such-env-file'),
      outDir: dir,
      gitSha: 'testsha',
      buildHeader: (input) => buildHeader({ ...input, git: undefined }),
      log: () => {},
    }

    const output = await runLongMemEvalSuite(ctx)
    const rows = readFileSync(checkpointPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows).toHaveLength(1)
    expect(rows[0].reader).toBe('scripted')
    expect(rows[0].system).toBe('scripted')
    expect(rows[0].adapter_kind).toBe('mcp')
    expect(rows[0].adapter_config_hash).toBe(hash)
    // a changed adapter config cannot resume into rows produced by the old one
    expect(String(rows[0].key)).toContain(`scripted@${hash}`)

    const metrics = output.result.metrics as {
      systems?: Record<string, { coverage: number; write_calls: number }>
    }
    expect(metrics.systems?.scripted.coverage).toBe(1)
    expect(metrics.systems?.scripted.write_calls).toBe(1)
  }, 120_000)
})

describe('adapter against engram', () => {
  it('retrieves the evidence through engram own http server in a temp data dir', async () => {
    const dir = tempDir()
    const saved = [process.env.ENGRAM_DB_PATH, process.env.ENGRAM_DATA_DIR]
    process.env.ENGRAM_DB_PATH = join(dir, 'engram.db')
    process.env.ENGRAM_DATA_DIR = dir
    resetDatabase()
    const server = serve({ fetch: createServer().fetch, port: 0 })
    closers.push(async () => {
      await new Promise<void>((done) => server.close(() => done()))
    })
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port

    const system = await createMcpSystem({
      config: engramMcpConfig(`http://127.0.0.1:${port}/mcp`, 'engram-http'),
      adapter: { kind: 'mcp', configHash: 'inline', source: 'inline' },
      topK: 10,
    })
    try {
      await system.ingest(NS, FIXTURE)
      expect(system.cost()).toEqual({ writeCalls: 3, writeTokens: null })
      const retrieved = await system.retrieve(NS, QUESTION, 2000)
      expect(retrieved.context).toContain(EVIDENCE)
      expect(retrieved.items.map((item) => item.ref)).toContain('s1')
      resetDatabase()
    } finally {
      await system.close()
      resetDatabase()
      process.env.ENGRAM_DB_PATH = saved[0]
      process.env.ENGRAM_DATA_DIR = saved[1]
    }
  }, 120_000)

  it('retrieves the same evidence as the in-process system, over stdio', async () => {
    const loaded = loadAdapterConfig('eval/adapters/engram-mcp.json')
    const mcp = await createMcpSystem({
      config: loaded.config,
      adapter: { kind: 'mcp', configHash: loaded.hash, source: loaded.source },
      topK: 10,
    })
    const harness = await EvalHarness.create({ seed: 7, vectors: 'fts' })
    harnesses.push(harness)
    let inProcess: MemorySystem[] = []
    try {
      await mcp.reset(NS)
      await mcp.ingest(NS, FIXTURE)
      const viaMcp = await mcp.retrieve(NS, QUESTION, 2000)

      await harness.seedCorpus(
        {
          name: 'mcp-equivalence',
          seed: 7,
          memories: FIXTURE.map((session) => ({
            id: session.id,
            namespace: NS,
            content: session.text,
            type: 'note',
            tags: session.tags ?? [],
            created_at: session.createdAt ?? 0,
          })),
          queries: [],
        },
        { mode: 'raw' }
      )
      inProcess = await createSystems(['engram'], { harness, topK: 10, seed: 7 })
      await inProcess[0].ingest(NS, FIXTURE)
      const viaInProcess = await inProcess[0].retrieve(NS, QUESTION, 2000)

      expect(viaMcp.context).toContain(EVIDENCE)
      expect(viaInProcess.context).toContain(EVIDENCE)
      const mcpRefs = viaMcp.items.map((item) => item.ref).sort()
      const inProcessRefs = viaInProcess.items.map((item) => item.ref).sort()
      expect(mcpRefs.length).toBeGreaterThan(0)
      expect(mcpRefs).toEqual(inProcessRefs)
      expect(viaMcp.items[0].text).toBe(viaInProcess.items[0].text)
      expect(loaded.hash).toHaveLength(16)
    } finally {
      await closeAll(inProcess)
      await mcp.close()
    }
  }, 180_000)
})
