import { PROTOCOL_SLIM } from '../delivery/protocol.js'
import { ENGRAM_VERSION } from '../version.js'

/** the stateless revision: server/discover plus per-request _meta, no initialize (spec 2026-07-28) */
export const MODERN_PROTOCOL_VERSION = '2026-07-28'

/** revisions that still open with an initialize handshake, newest first */
export const LEGACY_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const

export const SUPPORTED_PROTOCOL_VERSIONS: string[] = [
  MODERN_PROTOCOL_VERSION,
  ...LEGACY_PROTOCOL_VERSIONS,
]

export const SERVER_INFO = { name: 'engram', version: ENGRAM_VERSION }

export const SERVER_CAPABILITIES = {
  tools: {},
  resources: { listChanged: false, subscribe: false },
  prompts: { listChanged: false },
}

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

export const ERROR_HEADER_MISMATCH = -32020
export const ERROR_MISSING_CLIENT_CAPABILITY = -32021
export const ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022

/** the error codes 2026-07-28 defines; anything else is a legacy server answering a probe */
export const MODERN_ERROR_CODES: number[] = [
  ERROR_HEADER_MISMATCH,
  ERROR_MISSING_CLIENT_CAPABILITY,
  ERROR_UNSUPPORTED_PROTOCOL_VERSION,
]

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface RequestMeta {
  /** the request carries per-request protocol fields, so it is served under 2026-07-28 */
  modern: boolean
  protocolVersion?: string
  clientCapabilities: boolean
}

export function readRequestMeta(params: unknown): RequestMeta {
  const meta = isRecord(params) ? params._meta : undefined
  const fields = isRecord(meta) ? meta : {}
  const version = fields[META_PROTOCOL_VERSION]
  const capabilities = fields[META_CLIENT_CAPABILITIES]
  return {
    modern: typeof version === 'string' || capabilities !== undefined,
    protocolVersion: typeof version === 'string' ? version : undefined,
    clientCapabilities: capabilities !== undefined,
  }
}

/**
 * legacy clients declare one version and have no fall-forward, so the answer is the newest
 * server revision at or below it; with nothing declared, the oldest one still spoken
 */
export function negotiateLegacyVersion(requested: string | undefined): string {
  const known = LEGACY_PROTOCOL_VERSIONS.find((version) => version === requested)
  if (known) return known
  const atOrBelow = requested
    ? LEGACY_PROTOCOL_VERSIONS.find((version) => version <= requested)
    : undefined
  return atOrBelow ?? LEGACY_PROTOCOL_VERSIONS[LEGACY_PROTOCOL_VERSIONS.length - 1]
}

export interface InitializeParams {
  protocolVersion?: unknown
  capabilities?: unknown
  clientInfo?: unknown
}

export function initializeResult(params: InitializeParams): Record<string, unknown> {
  const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
  return {
    protocolVersion: negotiateLegacyVersion(requested),
    capabilities: SERVER_CAPABILITIES,
    serverInfo: SERVER_INFO,
    instructions: PROTOCOL_SLIM,
  }
}

export interface CacheHint {
  ttlMs: number
  cacheScope: 'public' | 'private'
}

/** every modern result identifies the server and says whether it is a complete answer */
export function modernResult(
  result: Record<string, unknown>,
  cache?: CacheHint
): Record<string, unknown> {
  return {
    resultType: 'complete',
    ...result,
    ...(cache ? { ttlMs: cache.ttlMs, cacheScope: cache.cacheScope } : {}),
    _meta: { [META_SERVER_INFO]: SERVER_INFO },
  }
}

const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/

export function decodeHeaderValue(value: string): string {
  const match = BASE64_SENTINEL.exec(value)
  if (!match) return value
  return Buffer.from(match[1], 'base64').toString('utf8')
}

export function encodeHeaderValue(value: string): string {
  const plain = /^[\x20-\x7e]*$/.test(value) && !BASE64_SENTINEL.test(value)
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}
