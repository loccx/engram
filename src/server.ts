import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { handleTool, type RequestContext } from './mcp/handlers.js'
import { PROTOCOL_SLIM } from './delivery/protocol.js'
import { tools } from './mcp/tools.js'
import { getDatabase } from './db/init.js'
import { cueHits } from './delivery/cue.js'
import { rosterHits } from './delivery/roster.js'
import { embeddingState } from './embeddings/pipeline.js'
import { getMetricsTracker } from './metrics/tracker.js'
import { logger } from './utils/logger.js'
import { ENGRAM_VERSION } from './version.js'

const startTime = Date.now()

// a bare json-rpc method must never reach handleTool(): that would invoke a tool
// without going through the validated tools/call path

const TOOL_NAMES = new Set(tools.map((t) => t.name))

/**
 * only localhost origins are reflected: anything else gets no cors headers, so a
 * browser cannot read a response even when it can reach the port. non-browser clients
 * send no origin and are unaffected.
 */
export function resolveCorsOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' ? origin : undefined
  } catch {
    return undefined
  }
}

/** a delivery body, or null when it is not a json object */
async function deliveryBody(req: { json: <T>() => Promise<T> }): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json<unknown>()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function createServer(): Hono {
  const app = new Hono()

  app.use('*', cors({ origin: (origin) => resolveCorsOrigin(origin) }))

  app.get('/health', (c) => {
    try {
      const dbm = getDatabase()
      const db = dbm.db
      const row = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }
      const sessionRow = db
        .prepare('SELECT COUNT(*) as count FROM sessions')
        .get() as { count: number }
      // embeddingState() is a filesystem stat — no model load, no network — and
      // reports ready:false on any failure, never a 500
      
      const embeddings = embeddingState()
      return c.json({
        status: 'ok',
        uptime: Date.now() - startTime,
        memoryCount: row.count,
        sessionCount: sessionRow.count,
        version: ENGRAM_VERSION,
        embeddings: {
          model: embeddings.model,
          ready: embeddings.ready,
          loaded: embeddings.loaded,
          vectorsAvailable: dbm.vectorsAvailable,
        },
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return c.json({ status: 'error', error: message }, 500)
    }
  })

  app.get('/metrics', (c) => {
    try {
      const dbm = getDatabase()
      const tracker = getMetricsTracker(dbm.db)
      const namespace = c.req.query('namespace') || undefined
      const sinceStr = c.req.query('since')
      const since = sinceStr ? parseInt(sinceStr, 10) : undefined
      return c.json(tracker.getStats({ namespace, since }))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return c.json({ error: message }, 500)
    }
  })

  // hooks ask for data only; the hook cli owns the text a host sees. both routes are
  // read-only and namespace-scoped.
  app.post('/delivery/roster', async (c) => {
    const body = await deliveryBody(c.req)
    const namespace = body ? stringField(body, 'namespace') : ''
    if (!namespace) return c.json({ error: 'namespace is required' }, 400)
    try {
      return c.json({ entries: rosterHits(getDatabase().db, namespace) })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error({ error: message, namespace }, 'delivery roster failed')
      return c.json({ error: message }, 500)
    }
  })

  app.post('/delivery/cue', async (c) => {
    const body = await deliveryBody(c.req)
    const namespace = body ? stringField(body, 'namespace') : ''
    const path = body ? stringField(body, 'path') : ''
    if (!namespace || !path) return c.json({ error: 'namespace and path are required' }, 400)
    try {
      return c.json({ entries: cueHits(getDatabase().db, namespace, path) })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error({ error: message, namespace, path }, 'delivery cue failed')
      return c.json({ error: message }, 500)
    }
  })

  // mcp endpoint; the ?project= query param pins the namespace
  app.post('/mcp', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json<Record<string, unknown>>()
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
    }

    const { method, params, id } = body as {
      method?: string
      params?: Record<string, unknown>
      id?: unknown
    }

    if (!method) {
      return c.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'method is required' } }, 400)
    }

    const urlProject = c.req.query('project') || undefined
    const urlNamespace = c.req.query('namespace') || undefined
    const ctx: RequestContext = { urlProject, urlNamespace }

    logger.debug({ method, id, urlProject, urlNamespace }, 'MCP request')

    try {
      if (method === 'initialize') {
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'engram', version: ENGRAM_VERSION },
            instructions: PROTOCOL_SLIM,
          },
        })
      }

      if (method === 'tools/list') {
        return c.json({ jsonrpc: '2.0', id, result: { tools } })
      }

      if (method === 'tools/call') {
        const callParams = params as { name?: string; arguments?: Record<string, unknown> }
        const toolName = callParams?.name
        if (!toolName) {
          return c.json({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'params.name is required for tools/call' },
          }, 400)
        }
        if (!TOOL_NAMES.has(toolName)) {
          return c.json({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Unknown tool: ${toolName}` },
          }, 400)
        }
        const result = await handleTool(toolName, callParams?.arguments ?? {}, ctx)
        return c.json({ jsonrpc: '2.0', id, result })
      }

      if (method === 'ping') {
        return c.json({ jsonrpc: '2.0', id, result: {} })
      }

      // a notification carries no id and must not receive a response
      if (method.startsWith('notifications/')) {
        return c.body(null, 202)
      }

      // only the methods above are implemented: reaching here means the client
      // sent an unsupported method; it must not be treated as a tool name.
      return c.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      }, 400)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error({ method, error: message }, 'MCP handler error')
      return c.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'Internal error', data: message },
      }, 500)
    }
  })

  return app
}
