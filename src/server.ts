import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { handleTool, type RequestContext } from './mcp/handlers.js'
import { tools } from './mcp/tools.js'
import { getDatabase } from './db/init.js'
import { getMetricsTracker } from './metrics/tracker.js'
import { logger } from './utils/logger.js'
import { ENGRAM_VERSION } from './version.js'

const startTime = Date.now()

export function createServer(): Hono {
  const app = new Hono()

  app.use('*', cors())

  // Health check
  app.get('/health', (c) => {
    try {
      const db = getDatabase().db
      const row = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }
      const sessionRow = db
        .prepare('SELECT COUNT(*) as count FROM sessions')
        .get() as { count: number }
      return c.json({
        status: 'ok',
        uptime: Date.now() - startTime,
        memoryCount: row.count,
        sessionCount: sessionRow.count,
        version: ENGRAM_VERSION,
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

  // MCP JSON-RPC endpoint — supports ?project= query param for deterministic scoping
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
        const result = await handleTool(toolName, callParams?.arguments ?? {}, ctx)
        return c.json({ jsonrpc: '2.0', id, result })
      }

      const result = await handleTool(method, (params as Record<string, unknown>) ?? {}, ctx)
      return c.json({ jsonrpc: '2.0', id, result })
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
