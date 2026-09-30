import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { dispatchRpc, type HttpRequestHeaders } from './mcp/dispatch.js'
import { authorizeRequest } from './mcp/auth.js'
import { livePrincipalForToken, resolveCredential } from './mcp/principals.js'
import { authorizeNamespace, withRequest, type CallerScope } from './memory/access.js'
import { getDatabase } from './db/init.js'
import { cueHits } from './delivery/cue.js'
import { rosterHits } from './delivery/roster.js'
import {
  POST_COMPACT_BRIEF_CHARS,
  SUBAGENT_BRIEF_CHARS,
  checkpointOpenTasks,
  endWorkspaceSession,
  openTaskBriefs,
  recordTaskProgress,
} from './delivery/tasks.js'
import { DEFAULT_BRIEF_CHARS } from './tasks/brief.js'
import { HANDOFF_AUDIENCES, type HandoffAudience } from './tasks/types.js'
import { embeddingState } from './embeddings/pipeline.js'
import { getMetricsTracker } from './metrics/tracker.js'
import { logger } from './utils/logger.js'
import { ENGRAM_VERSION } from './version.js'

const startTime = Date.now()

export interface ServerOptions {
  /** a non-loopback bind must present a bearer token, so the whole surface is behind one */
  requireAuth?: boolean
}

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

function numberField(body: Record<string, unknown> | null, key: string): number | undefined {
  const value = body?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** a brief is either the plain session rendering or one of the handoff audiences */
function briefAudience(body: Record<string, unknown> | null): 'session' | HandoffAudience {
  const value = body ? stringField(body, 'for') : ''
  if (value === 'session') return 'session'
  return (HANDOFF_AUDIENCES as readonly string[]).includes(value)
    ? (value as HandoffAudience)
    : 'session'
}

export function createServer(options: ServerOptions = {}): Hono {
  const app = new Hono()

  app.use('*', cors({ origin: (origin) => resolveCorsOrigin(origin) }))

  app.use('*', async (c, next) => {
    const db = getDatabase().db
    const header = c.req.header('authorization')
    const decision = options.requireAuth
      ? authorizeRequest(header, process.env, (presented) =>
          livePrincipalForToken(db, presented) !== null
        )
      : { allowed: true, status: 401 as const, message: '' }
    if (!decision.allowed) {
      c.header('www-authenticate', 'Bearer realm="engram"')
      return c.json({ error: decision.message }, decision.status)
    }
    // no route runs without a resolved caller: once a principal exists, a request that
    // presents nothing is refused even on a loopback bind rather than served as the owner
    if (!resolveCredential(db, header)) {
      return c.json(
        {
          error:
            header === undefined
              ? 'unauthorized: a bearer token is required'
              : 'unauthorized: bearer token rejected',
        },
        401
      )
    }
    return next()
  })

  /**
   * the credential on the request decides which principal a route runs as. there is no
   * fallback here: the middleware refuses before a route body runs, and a null means the
   * route refuses rather than acting as an owner nobody authenticated as.
   */
  const callerOf = (header: string | undefined): CallerScope | null =>
    resolveCredential(getDatabase().db, header)?.caller ?? null

  const refuseNamespace = (
    caller: CallerScope,
    namespace: string,
    verb: 'read' | 'write'
  ): string | null => authorizeNamespace(caller, namespace, verb)

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
      const caller = callerOf(c.req.header('authorization'))
      if (!caller) return c.json({ error: 'unauthorized' }, 401)
      // store-wide counters are the local owner's; a granted caller reads its own namespace
      if (!namespace) {
        if (!caller.localOwner) {
          return c.json({ error: 'metrics without a namespace are the local owner’s' }, 403)
        }
      } else {
        const refusal = refuseNamespace(caller, namespace, 'read')
        if (refusal) return c.json({ error: refusal }, 403)
      }
      return c.json(withRequest(caller, 'metrics', () => tracker.getStats({ namespace, since })))
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
    const caller = callerOf(c.req.header('authorization'))
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    const refusal = refuseNamespace(caller, namespace, 'read')
    if (refusal) return c.json({ error: refusal }, 403)
    try {
      return c.json({
        entries: withRequest(caller, 'delivery/roster', () => rosterHits(getDatabase().db, namespace)),
      })
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
    const caller = callerOf(c.req.header('authorization'))
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    const refusal = refuseNamespace(caller, namespace, 'read')
    if (refusal) return c.json({ error: refusal }, 403)
    try {
      return c.json({
        entries: withRequest(caller, 'delivery/cue', () => cueHits(getDatabase().db, namespace, path)),
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error({ error: message, namespace, path }, 'delivery cue failed')
      return c.json({ error: message }, 500)
    }
  })

  // the working-tier routes: hooks own the text a host sees, these routes own the writes
  app.post('/delivery/task-brief', async (c) => {
    const body = await deliveryBody(c.req)
    const namespace = body ? stringField(body, 'namespace') : ''
    if (!namespace) return c.json({ error: 'namespace is required' }, 400)
    const caller = callerOf(c.req.header('authorization'))
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    const refusal = refuseNamespace(caller, namespace, 'read')
    if (refusal) return c.json({ error: refusal }, 403)
    try {
      const audience = briefAudience(body)
      const fallback =
        audience === 'subagent'
          ? SUBAGENT_BRIEF_CHARS
          : audience === 'new-session'
            ? POST_COMPACT_BRIEF_CHARS
            : DEFAULT_BRIEF_CHARS
      return c.json({
        briefs: withRequest(caller, 'delivery/task-brief', () =>
          openTaskBriefs(getDatabase().db, {
            namespace,
            sessionId: body ? stringField(body, 'session_id') || undefined : undefined,
            limit: numberField(body, 'limit'),
            budgetChars: numberField(body, 'budget_chars') ?? fallback,
            for: audience,
          })
        ),
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error({ error: message, namespace }, 'delivery task-brief failed')
      return c.json({ error: message }, 500)
    }
  })

  app.post('/delivery/task-checkpoint', async (c) => {
    const body = await deliveryBody(c.req)
    const namespace = body ? stringField(body, 'namespace') : ''
    if (!namespace) return c.json({ error: 'namespace is required' }, 400)
    const caller = callerOf(c.req.header('authorization'))
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    const refusal = refuseNamespace(caller, namespace, 'write')
    if (refusal) return c.json({ error: refusal }, 403)
    try {
      return c.json(
        withRequest(caller, 'delivery/task-checkpoint', () =>
          checkpointOpenTasks(getDatabase().db, namespace, {
            sessionId: body ? stringField(body, 'session_id') || undefined : undefined,
            reason: body ? stringField(body, 'reason') || undefined : undefined,
          })
        )
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error({ error: message, namespace }, 'delivery task-checkpoint failed')
      return c.json({ error: message }, 500)
    }
  })

  app.post('/delivery/task-progress', async (c) => {
    const body = await deliveryBody(c.req)
    const namespace = body ? stringField(body, 'namespace') : ''
    const text = body ? stringField(body, 'text') : ''
    if (!namespace || !text) return c.json({ error: 'namespace and text are required' }, 400)
    const caller = callerOf(c.req.header('authorization'))
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    const refusal = refuseNamespace(caller, namespace, 'write')
    if (refusal) return c.json({ error: refusal }, 403)
    try {
      return c.json(
        withRequest(caller, 'delivery/task-progress', () =>
          recordTaskProgress(getDatabase().db, {
            namespace,
            taskId: body ? stringField(body, 'task_id') || undefined : undefined,
            sessionId: body ? stringField(body, 'session_id') || undefined : undefined,
            text,
            author: body ? stringField(body, 'author') || undefined : undefined,
          })
        )
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error({ error: message, namespace }, 'delivery task-progress failed')
      return c.json({ error: message }, 500)
    }
  })

  app.post('/delivery/session-end', async (c) => {
    const body = await deliveryBody(c.req)
    const namespace = body ? stringField(body, 'namespace') : ''
    if (!namespace) return c.json({ error: 'namespace is required' }, 400)
    const caller = callerOf(c.req.header('authorization'))
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    const refusal = refuseNamespace(caller, namespace, 'write')
    if (refusal) return c.json({ error: refusal }, 403)
    try {
      return c.json(
        withRequest(caller, 'delivery/session-end', () =>
          endWorkspaceSession(getDatabase().db, {
            namespace,
            sessionId: body ? stringField(body, 'session_id') || undefined : undefined,
            summary: body ? stringField(body, 'summary') || undefined : undefined,
          })
        )
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error({ error: message, namespace }, 'delivery session-end failed')
      return c.json({ error: message }, 500)
    }
  })

  // the protocol dropped the standalone sse stream and the session delete; a client on an
  // older revision probing for them gets the status the revision names
  app.get('/mcp', (c) => c.body(null, 405))
  app.delete('/mcp', (c) => c.body(null, 405))

  // mcp endpoint; the ?project= query param pins the namespace
  app.post('/mcp', async (c) => {
    let body: unknown
    try {
      body = await c.req.json<unknown>()
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
    }

    const headers: HttpRequestHeaders = {
      protocolVersion: c.req.header('mcp-protocol-version'),
      method: c.req.header('mcp-method'),
      name: c.req.header('mcp-name'),
    }
    // the middleware already resolved (or refused) the credential, so the caller bound
    // here is the one the request authenticated as
    const caller = callerOf(c.req.header('authorization'))
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    const ctx = {
      urlProject: c.req.query('project') || undefined,
      urlNamespace: c.req.query('namespace') || undefined,
      caller,
    }

    try {
      const outcome = await dispatchRpc(body, { ctx, headers })
      if (outcome.body === null) return c.body(null, 202)
      return c.json(outcome.body, outcome.status as 200)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const id = body && typeof body === 'object' ? (body as { id?: unknown }).id : null
      logger.error({ error: message }, 'MCP handler error')
      return c.json({
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32603, message: 'Internal error', data: message },
      }, 500)
    }
  })

  return app
}
