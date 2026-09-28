// llm gateway access for the harness: env vars first, `~/.engram-eval.env` as the
// fallback (KEY=VALUE, one per line, a leading `export ` tolerated).
// hard rule: credential values never leave this module. gatewayStatus() reports
// presence, host and model only, and every string headed for a report goes through
// redactSecrets() first, so a stray log line or prompt echo cannot leak the key.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  chat,
  isLlmConfigured,
  loadLlmConfig,
  resetLlmConfigForTests,
  LlmUnavailableError,
} from '../../src/llm/client.js'
import type { ChatMessage, ChatOptions, ChatResult } from '../../src/llm/client.js'

export const ENV_FILE = join(homedir(), '.engram-eval.env')

export interface GatewayStatus {
  configured: boolean
  /** host only, never the full url and never the key */
  host: string
  model: string
  /** where the values came from, not the values */
  source: 'env' | 'env-file' | 'env+env-file' | 'none'
  envFile: string
  envFilePresent: boolean
}

let loadedFileKeys: string[] = []

/**
 * parse KEY=VALUE lines: blank lines and comments are skipped, one matching pair of
 * quotes is stripped, and a trailing CR goes, so a windows-edited file still parses
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    let value = withoutExport.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out[key] = value
  }
  return out
}

/**
 * fill missing ENGRAM_LLM_* values from ~/.engram-eval.env and return which keys
 * came from the file (names only)
 */
export function loadGatewayEnv(envFile: string = ENV_FILE): string[] {
  // the cache in src/llm/client.ts is invalidated before and after: before, so
  // a caller that deleted the env vars sees the deletion rather than a stale
  // `configured: true`, and after, so the
  // values read here take effect.
  resetLlmConfigForTests()
  let text: string
  try {
    text = readFileSync(envFile, 'utf8')
  } catch {
    loadedFileKeys = []
    return []
  }
  const parsed = parseEnvFile(text)
  const applied: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith('ENGRAM_')) continue
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value
      applied.push(key)
    }
  }
  loadedFileKeys = applied
  // the client caches its config on first read; clear it so the file values take
  resetLlmConfigForTests()
  return applied
}

/** presence, host and model; never the key or the full url */
export function gatewayStatus(envFile: string = ENV_FILE): GatewayStatus {
  const applied = loadGatewayEnv(envFile)
  const config = loadLlmConfig()
  const fromEnv = process.env.ENGRAM_LLM_BASE_URL !== undefined && process.env.ENGRAM_LLM_BASE_URL !== ''
  const source: GatewayStatus['source'] = !config
    ? 'none'
    : applied.length > 0 && fromEnv
      ? 'env+env-file'
      : applied.length > 0
        ? 'env-file'
        : 'env'
  return {
    configured: config !== null,
    host: config ? safeHost(config.baseUrl) : '',
    model: config ? config.model : '',
    source,
    envFile,
    envFilePresent: fileExists(envFile),
  }
}

/** true when a gateway is reachable for --qa and adjudication */
export function qaAvailable(): boolean {
  loadGatewayEnv()
  return isLlmConfigured()
}

export interface RedactionResult {
  text: string
  redactions: number
}

/**
 * replace the live key (and any url userinfo) with a marker before a string is
 * written to a report or printed
 */
export function redactSecrets(input: string): RedactionResult {
  let text = input
  let redactions = 0
  const secrets = [process.env.ENGRAM_LLM_API_KEY, process.env.ENGRAM_LLM_BASE_URL]
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue
    if (text.includes(secret)) {
      text = text.split(secret).join('[redacted]')
      redactions++
    }
  }
  // a stringified fetch error can carry an authorization header
  const headerPattern = /(authorization["']?\s*[:=]\s*["']?)[^\s"',}]+/gi
  if (headerPattern.test(text)) {
    text = text.replace(headerPattern, '$1[redacted]')
    redactions++
  }
  return { text, redactions }
}

/**
 * hostname only: `new URL` wants a protocol, so a bare host is upgraded for parsing
 */
export function safeHost(baseUrl: string): string {
  try {
    const url = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`)
    return url.host
  } catch {
    return '<unparseable>'
  }
}

export interface LlmCall {
  messages: ChatMessage[]
  options: ChatOptions
  /** the model this call is pinned to; never taken from the environment implicitly */
  model: string
}

export type LlmTransport = (call: LlmCall) => Promise<ChatResult>

let transport: LlmTransport | null = null

/** replace the network call with a deterministic stub */
export function setLlmTransport(next: LlmTransport | null): void {
  transport = next
}

/**
 * one completion on the pinned model. the model is an argument rather than an
 * environment lookup: a report that grades answers has to name the judge that
 * produced the verdict. the gateway config still supplies base url, key and timeouts.
 */
export async function callChat(call: LlmCall): Promise<ChatResult> {
  if (!call.model) throw new Error('callChat: model is required (pinned per run, never implicit)')
  if (transport) return transport(call)
  const config = loadLlmConfig()
  if (!config) {
    throw new LlmUnavailableError(
      'LLM not configured (ENGRAM_LLM_BASE_URL/ENGRAM_LLM_API_KEY missing)'
    )
  }
  return chat(call.messages, call.options, { ...config, model: call.model })
}

/** why qa is unavailable, phrased for a report (no credential values) */
export function qaUnavailableReason(envFile: string = ENV_FILE): string {
  loadGatewayEnv(envFile)
  if (isLlmConfigured()) return ''
  return (
    'qa: unavailable — set ENGRAM_LLM_BASE_URL / ENGRAM_LLM_API_KEY / ENGRAM_LLM_MODEL in the ' +
    `environment or in ${envFile} (never in chat). Retrieval-only metrics still ran.`
  )
}

/**
 * `--qa` without a gateway is a hard failure: a paid run must not start, and the
 * message names the fix rather than becoming a footnote
 */
export function qaMissingGateway(envFile: string = ENV_FILE): string {
  loadGatewayEnv(envFile)
  return (
    'qa: no gateway configured — set ENGRAM_LLM_BASE_URL / ENGRAM_LLM_API_KEY / ' +
    `ENGRAM_LLM_MODEL in the environment or in ${envFile}, then re-run with --qa. ` +
    'Retrieval-only metrics (no --qa) need no credentials.'
  )
}

/** replaces the live client in tests */
export function resetGatewayForTests(): void {
  loadedFileKeys = []
  transport = null
  resetLlmConfigForTests()
}

export function loadedGatewayFileKeys(): string[] {
  return [...loadedFileKeys]
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path, 'utf8')
    return true
  } catch {
    return false
  }
}
