import { PROTOCOL_SLIM } from '../delivery/protocol.js'
import { withRequest } from '../memory/access.js'
import { logger } from '../utils/logger.js'
import { handleTool, type RequestContext } from './handlers.js'
import { getPrompt, listPrompts } from './prompts.js'
import { listResourceTemplates, readResource, resourceList } from './resources.js'
import { tools } from './tools.js'
import {
  decodeHeaderValue,
  ERROR_HEADER_MISMATCH,
  ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  initializeResult,
  isRecord,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  modernResult,
  readRequestMeta,
  SERVER_CAPABILITIES,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CacheHint,
  type InitializeParams,
  type RequestMeta,
} from './revisions.js'

/** the request metadata the streamable http transport mirrors into headers */
export interface HttpRequestHeaders {
  protocolVersion?: string
  method?: string
  name?: string
}

export interface DispatchOptions {
  ctx?: RequestContext
  headers?: HttpRequestHeaders
}

export interface RpcReply {
  status: number
  /** null means no reply at all, which is how a notification is answered */
  body: Record<string, unknown> | null
}

const TOOL_NAMES = new Set(tools.map((t) => t.name))
const NAMED_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get'])

const TOOLS_CACHE: CacheHint = { ttlMs: 300_000, cacheScope: 'public' }
const DISCOVER_CACHE: CacheHint = { ttlMs: 3_600_000, cacheScope: 'public' }

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  }
}

function reply(status: number, id: unknown, result: Record<string, unknown>): RpcReply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, result } }
}

function failure(
  status: number,
  id: unknown,
  code: number,
  message: string,
  data?: unknown
): RpcReply {
  return { status, body: rpcError(id, code, message, data) }
}

function requestName(method: string, params: Record<string, unknown>): string | undefined {
  if (method === 'resources/read') return typeof params.uri === 'string' ? params.uri : undefined
  return typeof params.name === 'string' ? params.name : undefined
}

/** a modern request on http has to carry headers that agree with its body, or it is rejected */
function rejectModernRequest(
  meta: RequestMeta,
  method: string,
  params: Record<string, unknown>,
  id: unknown,
  headers?: HttpRequestHeaders
): RpcReply | null {
  if (meta.protocolVersion === undefined) {
    return failure(400, id, -32602, `params._meta.${META_PROTOCOL_VERSION} is required`)
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(meta.protocolVersion)) {
    return failure(400, id, ERROR_UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: SUPPORTED_PROTOCOL_VERSIONS,
      requested: meta.protocolVersion,
    })
  }
  if (!meta.clientCapabilities) {
    return failure(400, id, -32602, `params._meta.${META_CLIENT_CAPABILITIES} is required`)
  }
  if (!headers) return null

  const mismatch = (header: string, detail: string) =>
    failure(400, id, ERROR_HEADER_MISMATCH, `${header} header ${detail}`)

  if (headers.protocolVersion !== meta.protocolVersion) {
    return mismatch('MCP-Protocol-Version', `must match the version in _meta (${meta.protocolVersion})`)
  }
  if (headers.method !== method) return mismatch('Mcp-Method', `must match the body method (${method})`)
  if (NAMED_METHODS.has(method)) {
    const expected = requestName(method, params)
    if (expected !== undefined && decodeHeaderValue(headers.name ?? '') !== expected) {
      return mismatch('Mcp-Name', 'must match params.name or params.uri')
    }
  }
  return null
}

function scopedNamespace(ctx: RequestContext | undefined): string | undefined {
  return ctx?.urlNamespace ?? ctx?.urlProject
}

/**
 * the era comes from the request body, not the transport: a request carrying per-request
 * protocol fields is answered under 2026-07-28, anything else under the legacy revision
 * negotiated by initialize
 */
export async function dispatchRpc(body: unknown, options: DispatchOptions = {}): Promise<RpcReply> {
  if (!isRecord(body) || typeof body.method !== 'string') {
    return failure(400, isRecord(body) ? body.id : null, -32600, 'method is required')
  }
  const method = body.method
  const id = body.id
  const params = isRecord(body.params) ? body.params : {}
  logger.debug({ method, id }, 'MCP request')

  if (method.startsWith('notifications/')) return { status: 202, body: null }
  if (method === 'initialize') return reply(200, id, initializeResult(params as InitializeParams))

  const meta = readRequestMeta(params)
  if (meta.modern) {
    const rejected = rejectModernRequest(meta, method, params, id, options.headers)
    if (rejected) return rejected
  }

  // the credential rides the whole dispatch, so resources and prompts read as the same
  // caller a tools/call does
  return withRequest(options.ctx?.caller, method, () => serve(method, params, id, meta.modern, options))
}

async function serve(
  method: string,
  params: Record<string, unknown>,
  id: unknown,
  modern: boolean,
  options: DispatchOptions
): Promise<RpcReply> {
  const envelope = (result: Record<string, unknown>, cache?: CacheHint) =>
    modern ? modernResult(result, cache) : result

  switch (method) {
    case 'server/discover': {
      // discover is a modern method: without the per-request fields the probe is a legacy
      // server's method-not-found, which is what a client's fallback is keyed to
      if (!modern) return failure(400, id, -32601, `Method not found: ${method}`)
      return reply(
        200,
        id,
        envelope(
          {
            supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
            capabilities: SERVER_CAPABILITIES,
            instructions: PROTOCOL_SLIM,
          },
          DISCOVER_CACHE
        )
      )
    }

    case 'tools/list':
      return reply(200, id, envelope({ tools }, TOOLS_CACHE))

    case 'tools/call': {
      const toolName = params.name
      if (typeof toolName !== 'string') {
        return failure(400, id, -32602, 'params.name is required for tools/call')
      }
      if (!TOOL_NAMES.has(toolName)) {
        return failure(400, id, -32602, `Unknown tool: ${toolName}`)
      }
      const args = isRecord(params.arguments) ? params.arguments : {}
      const result = await handleTool(toolName, args, options.ctx ?? {})
      return reply(200, id, envelope(result as unknown as Record<string, unknown>))
    }

    case 'resources/list':
      return reply(
        200,
        id,
        envelope(
          { resources: resourceList(scopedNamespace(options.ctx)) },
          { ttlMs: 300_000, cacheScope: 'private' }
        )
      )

    case 'resources/templates/list':
      return reply(
        200,
        id,
        envelope({ resourceTemplates: listResourceTemplates() }, TOOLS_CACHE)
      )

    case 'resources/read': {
      const uri = params.uri
      if (typeof uri !== 'string') {
        return failure(400, id, -32602, 'params.uri is required for resources/read')
      }
      const read = readResource(uri)
      if ('error' in read) return failure(400, id, -32602, read.error)
      return reply(
        200,
        id,
        envelope(
          { contents: read.contents },
          read.ttlMs === undefined ? undefined : { ttlMs: read.ttlMs, cacheScope: read.cacheScope ?? 'private' }
        )
      )
    }

    case 'prompts/list':
      return reply(200, id, envelope({ prompts: listPrompts() }, DISCOVER_CACHE))

    case 'prompts/get': {
      const name = params.name
      if (typeof name !== 'string') {
        return failure(400, id, -32602, 'params.name is required for prompts/get')
      }
      const args = isRecord(params.arguments) ? params.arguments : {}
      const prompt = await getPrompt(name, args, options.ctx ?? {})
      if ('error' in prompt) return failure(400, id, -32602, prompt.error)
      return reply(200, id, envelope({ description: prompt.description, messages: prompt.messages }))
    }

    case 'ping':
      return reply(200, id, envelope({}))

    default:
      // the modern transport answers an unknown method with 404 so a client can tell this
      // apart from an endpoint that does not host the protocol at all
      return failure(
        modern ? 404 : 400,
        id,
        -32601,
        `Method not found: ${method}`
      )
  }
}
