// adapter for any mcp memory server, over stdio (newline-delimited json) or streamable http.
// probes server/discover first: a modern (2026-07-28) server then gets per-request _meta and
// no initialize, while a legacy server falls back to initialize, notifications/initialized,
// tools/list and tools/call.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { EvalSetupError } from '../lib/errors.js'
import { REPO_ROOT } from '../lib/report.js'
import type { MemorySystem, RetrievedItem, SystemAdapter, SystemSession } from '../lib/systems.js'

export const PROTOCOL_VERSION = '2024-11-05'
export const MODERN_PROTOCOL_VERSION = '2026-07-28'
export const DEFAULT_TIMEOUT_MS = 30_000

/** a legacy server that ignores the probe must not cost the whole call budget */
export const PROBE_TIMEOUT_MS = 5_000

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'

/** the error codes the modern revision defines, which mean the server is modern, not legacy */
export function isModernErrorCode(code: number | undefined): boolean {
  return code === -32020 || code === -32021 || code === -32022
}

function supportedVersionsOf(payload: unknown): string[] {
  const list = isRecord(payload) && Array.isArray(payload.supported) ? payload.supported : []
  return list.filter((version): version is string => typeof version === 'string')
}

/** modern revisions sort after the legacy ones, so a string compare is a version compare */
export function pickModernVersion(versions: string[]): string | undefined {
  return versions.filter((version) => version >= MODERN_PROTOCOL_VERSION).sort().pop()
}

function isModernVersion(version: string): boolean {
  return version >= MODERN_PROTOCOL_VERSION
}

/** what a modern request carries instead of a session: version, capabilities, identity */
function modernMeta(version: string): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: version,
    [META_CLIENT_INFO]: { name: 'engram-eval', version: '1' },
    [META_CLIENT_CAPABILITIES]: {},
  }
}

/** the body's protocol fields are mirrored into headers; unsafe values travel base64-wrapped */
export function headerValue(value: string): string {
  const plain = /^[\x20-\x7e]*$/.test(value) && !/^=\?base64\?.*\?=$/.test(value)
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

export interface JsonRpcMessage {
  jsonrpc?: '2.0'
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export class McpCallError extends Error {
  readonly method: string
  readonly tool: string
  readonly code: number | undefined
  readonly data: unknown

  constructor(message: string, detail: { method: string; tool?: string; code?: number; data?: unknown }) {
    super(message)
    this.name = 'McpCallError'
    this.method = detail.method
    this.tool = detail.tool ?? ''
    this.code = detail.code
    this.data = detail.data
  }
}

export class McpTimeoutError extends Error {
  readonly method: string
  readonly tool: string

  constructor(method: string, timeoutMs: number, tool?: string) {
    super(`${method}${tool ? ` (tool ${tool})` : ''} did not answer within ${timeoutMs} ms`)
    this.name = 'McpTimeoutError'
    this.method = method
    this.tool = tool ?? ''
  }
}

interface Pending {
  method: string
  tool?: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface Wire {
  /** immediate skips the http request queue, for a probe that may never be answered */
  send(message: JsonRpcMessage, options?: { immediate?: boolean }): void
  close(): Promise<void>
  /** server stderr or transport noise, for a failure message */
  logs(): string
  onMessage(handler: (message: JsonRpcMessage) => void): void
  onFailure(handler: (reason: string) => void): void
}

export interface StdioOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export class StdioWire implements Wire {
  private readonly messageHandlers: Array<(message: JsonRpcMessage) => void> = []
  private readonly failureHandlers: Array<(reason: string) => void> = []
  private buffer = ''
  private stderr = ''
  private noise = ''
  private dead = false

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2000)
    })
    child.on('exit', (code, signal) => this.die(`server exited (${signal ?? code ?? 'unknown'})`))
    child.on('error', (error: Error) => this.die(`server failed to start: ${error.message}`))
  }

  static spawn(options: StdioOptions): StdioWire {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    return new StdioWire(child)
  }

  send(message: JsonRpcMessage, _options?: { immediate?: boolean }): void {
    if (this.dead) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(handler)
  }

  onFailure(handler: (reason: string) => void): void {
    this.failureHandlers.push(handler)
  }

  logs(): string {
    return [this.stderr.trim(), this.noise.trim()].filter((part) => part !== '').join(' | ')
  }

  /** sigterm, then sigkill: a hung server must not outlive the run */
  close(): Promise<void> {
    const child = this.child
    this.dead = true
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return new Promise<void>((done) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        done()
      }, 500)
      child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
      child.kill('SIGTERM')
    })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      const text = line.trim()
      if (text === '') continue
      let message: JsonRpcMessage
      try {
        message = JSON.parse(text) as JsonRpcMessage
      } catch {
        // not a reply: keep it for the failure message instead of killing the run
        this.noise = `${this.noise}\n${text}`.slice(-2000)
        continue
      }
      for (const handler of this.messageHandlers) handler(message)
    }
  }

  private die(reason: string): void {
    if (this.dead) return
    this.dead = true
    for (const handler of this.failureHandlers) handler(reason)
  }
}

export interface HttpOptions {
  url: string
  headers?: Record<string, string>
}

export class HttpWire implements Wire {
  private readonly messageHandlers: Array<(message: JsonRpcMessage) => void> = []
  private readonly failureHandlers: Array<(reason: string) => void> = []
  private sessionId = ''
  private dead = false
  /** one request at a time, so the initialized notification cannot overtake a call */
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly options: HttpOptions) {}

  send(message: JsonRpcMessage, options: { immediate?: boolean } = {}): void {
    if (this.dead) return
    const notification = message.id === undefined || message.id === null
    const run = options.immediate ? this.post(message) : this.tail.then(() => this.post(message))
    if (options.immediate) {
      void run.then(
        (parsed) => {
          if (parsed) for (const handler of this.messageHandlers) handler(parsed)
        },
        (error: Error) => this.die(error.message)
      )
      return
    }
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    if (notification) return
    void run
      .then((parsed) => {
        if (parsed) for (const handler of this.messageHandlers) handler(parsed)
      })
      .catch((error: Error) => this.die(error.message))
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(handler)
  }

  onFailure(handler: (reason: string) => void): void {
    this.failureHandlers.push(handler)
  }

  logs(): string {
    return ''
  }

  async close(): Promise<void> {
    this.dead = true
  }

  /** the request metadata a modern server mirrors into headers, derived from the body */
  private protocolHeaders(message: JsonRpcMessage): Record<string, string> {
    const params = message.params
    const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined
    const version = meta?.[META_PROTOCOL_VERSION]
    if (typeof version !== 'string') return {}
    const headers: Record<string, string> = {
      'mcp-protocol-version': version,
      'mcp-method': String(message.method ?? ''),
    }
    const name = isRecord(params) ? params.name ?? params.uri : undefined
    if (typeof name === 'string') headers['mcp-name'] = headerValue(name)
    return headers
  }

  /** null when the reply arrived as sse frames (already emitted) or as an empty body */
  private async post(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.options.headers,
      ...this.protocolHeaders(message),
    }
    if (this.sessionId !== '') headers['mcp-session-id'] = this.sessionId
    const response = await fetch(this.options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    })
    const session = response.headers.get('mcp-session-id')
    if (session) this.sessionId = session
    if (response.ok && (response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      await this.readSse(response)
      return null
    }
    const text = await response.text()
    const status = `http ${response.status} ${response.statusText}`
    if (text.trim() === '') {
      if (!response.ok) throw new Error(status)
      return null
    }
    let parsed: JsonRpcMessage
    try {
      parsed = JSON.parse(text) as JsonRpcMessage
    } catch {
      throw new Error(response.ok ? `http reply was not json: ${text.slice(0, 200)}` : status)
    }
    // a modern server answers an unsupported version or header mismatch with 400 and a
    // json-rpc error, and that error is what tells the client which era it is talking to
    if (!response.ok && !parsed.error) throw new Error(status)
    return parsed
  }

  private async readSse(response: Response): Promise<void> {
    const body = response.body
    if (!body) return
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseFrames(buffer)
      buffer = parsed.rest
      for (const raw of parsed.messages) {
        let message: JsonRpcMessage
        try {
          message = JSON.parse(raw) as JsonRpcMessage
        } catch {
          continue
        }
        for (const handler of this.messageHandlers) handler(message)
      }
    }
  }

  private die(reason: string): void {
    if (this.dead) return
    this.dead = true
    for (const handler of this.failureHandlers) handler(reason)
  }
}

/** completed sse frames as json payloads, plus whatever is left of a partial frame */
export function parseSseFrames(buffer: string): { messages: string[]; rest: string } {
  const messages: string[] = []
  const normalized = buffer.replace(/\r\n/g, '\n')
  const frames = normalized.split('\n\n')
  const rest = frames.pop() ?? ''
  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).replace(/^ /, ''))
      .join('\n')
    if (data.trim() !== '') messages.push(data)
  }
  return { messages, rest }
}

export class McpClient {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false
  private negotiated = ''
  private era: 'modern' | 'legacy' = 'legacy'
  private modernVersion = MODERN_PROTOCOL_VERSION

  private constructor(
    private readonly wire: Wire,
    private readonly timeoutMs: number
  ) {
    wire.onMessage((message) => this.onMessage(message))
    wire.onFailure((reason) => this.fail(reason))
  }

  static async start(wire: Wire, options: { timeoutMs?: number } = {}): Promise<McpClient> {
    const client = new McpClient(wire, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    await client.probe()
    return client
  }

  /** the version the server answers with: the modern revision, or the negotiated legacy one */
  get protocolVersion(): string {
    return this.negotiated
  }

  get protocolEra(): 'modern' | 'legacy' {
    return this.era
  }

  /**
   * a dual-era server is detected from how it answers the probe: a DiscoverResult or a
   * modern error code means 2026-07-28, any other error or a silence means the legacy
   * initialize handshake
   */
  async probe(): Promise<string> {
    try {
      const discovered = await this.request(
        'server/discover',
        { _meta: modernMeta(MODERN_PROTOCOL_VERSION) },
        undefined,
        {
          timeoutMs: Math.min(this.timeoutMs, PROBE_TIMEOUT_MS),
          fatalOnTimeout: false,
          immediate: true,
        }
      )
      const advertised = supportedVersionsOf(discovered)
      this.modernVersion = pickModernVersion(advertised) ?? MODERN_PROTOCOL_VERSION
      this.era = 'modern'
      this.negotiated = this.modernVersion
      return this.negotiated
    } catch (error) {
      const failure = error instanceof McpCallError ? error : null
      if (failure && isModernErrorCode(failure.code)) {
        // modern, but it rejects this version: use one it advertises, or fall back to initialize
        const supported = pickModernVersion(supportedVersionsOf(failure.data).filter(isModernVersion))
        if (supported) {
          this.modernVersion = supported
          this.era = 'modern'
          this.negotiated = supported
          return this.negotiated
        }
      }
      return this.initialize()
    }
  }

  async initialize(): Promise<string> {
    const result = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'engram-eval', version: '1' },
    })) as { protocolVersion?: unknown } | null
    this.era = 'legacy'
    this.negotiated =
      typeof result?.protocolVersion === 'string' ? result.protocolVersion : PROTOCOL_VERSION
    this.notify('notifications/initialized')
    return this.negotiated
  }

  async listTools(): Promise<string[]> {
    const result = (await this.request('tools/list', {})) as
      | { tools?: Array<{ name?: unknown }> }
      | null
    return (result?.tools ?? [])
      .map((tool) => (typeof tool?.name === 'string' ? tool.name : ''))
      .filter((name) => name !== '')
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request('tools/call', { name, arguments: args }, name)
    return unwrapToolResult(name, result)
  }

  notify(method: string, params?: unknown): void {
    this.wire.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  async close(): Promise<void> {
    this.closed = true
    for (const [id, entry] of [...this.pending]) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(new McpCallError('transport closed', { method: entry.method, tool: entry.tool }))
    }
    await this.wire.close()
  }

  /** every modern request carries the per-request protocol fields in params._meta */
  private withMeta(params: unknown): unknown {
    if (this.era !== 'modern') return params
    return { ...(isRecord(params) ? params : {}), _meta: modernMeta(this.modernVersion) }
  }

  private request(
    method: string,
    params: unknown,
    tool?: string,
    options: { timeoutMs?: number; fatalOnTimeout?: boolean; immediate?: boolean } = {}
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new McpCallError(`transport is closed, cannot send ${method}`, { method, tool })
      )
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const fatal = options.fatalOnTimeout ?? true
    const id = this.nextId++
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new McpTimeoutError(method, timeoutMs, tool))
        // a server that stopped answering mid-call cannot be trusted with the next one,
        // while a probe that timed out only says this server has no server/discover
        if (fatal) {
          this.closed = true
          void this.wire.close()
        }
      }, timeoutMs)
      this.pending.set(id, { method, tool, resolve: resolveRequest, reject: rejectRequest, timer })
      this.wire.send(
        { jsonrpc: '2.0', id, method, params: this.withMeta(params) },
        { immediate: options.immediate === true }
      )
    })
  }

  private onMessage(message: JsonRpcMessage): void {
    const id = message.id
    if (id === undefined || id === null) return
    const entry = this.pending.get(Number(id))
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(Number(id))
    if (message.error) {
      entry.reject(
        new McpCallError(
          `${entry.method} failed: ${message.error.message ?? 'no message'}`,
          { method: entry.method, tool: entry.tool, code: message.error.code, data: message.error.data }
        )
      )
      return
    }
    entry.resolve(message.result)
  }

  private fail(reason: string): void {
    const logs = this.wire.logs()
    const detail = logs === '' ? reason : `${reason} | server output: ${logs}`
    for (const [id, entry] of [...this.pending]) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(new McpCallError(detail, { method: entry.method, tool: entry.tool }))
    }
    this.closed = true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(result: Record<string, unknown>): string {
  const content = result.content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

/** a tool reply is structured content, or json in its first text part */
function unwrapToolResult(tool: string, result: unknown): unknown {
  if (!isRecord(result)) return result
  if (result.isError === true) {
    throw new McpCallError(`tool ${tool} returned an error: ${textOf(result) || 'no message'}`, {
      method: 'tools/call',
      tool,
    })
  }
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = textOf(result)
  if (text === '') return result
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { text }
  }
}

export interface McpToolCall {
  tool: string
  args?: Record<string, unknown>
}

export interface McpContextConfig {
  /** dot paths into the tool payload, each expanded into one context block per value */
  sections?: string[]
  /** where the ranked items live, and which fields carry their text and id */
  items?: { path: string; text: string; id?: string }
}

export interface McpAdapterConfig {
  /** the system name this config reports as; unique within a run */
  name: string
  describe?: string
  transport: ({ kind: 'stdio' } & StdioOptions) | { kind: 'http'; url: string; headers?: Record<string, string> }
  write: McpToolCall & { idPath?: string }
  search: McpToolCall
  context: McpContextConfig
  reset?: McpToolCall
  timeoutMs?: number
}

const ITEM_VARS = ['namespace', 'tmp'] as const
const WRITE_VARS = ['session.id', 'session.text', 'session.createdAt', 'session.tags', ...ITEM_VARS]
const SEARCH_VARS = ['query', 'budgetChars', 'topK', ...ITEM_VARS]

function placeholdersIn(value: unknown, allowed: readonly string[], where: string): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{([^}]+)\}/g)) {
      const name = match[1].trim()
      if (!allowed.includes(name)) {
        throw new EvalSetupError(
          `${where} uses \${${name}}, which is not available here — allowed: ${allowed.join(', ')}`
        )
      }
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => placeholdersIn(entry, allowed, `${where}[${index}]`))
    return
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) placeholdersIn(entry, allowed, `${where}.${key}`)
  }
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EvalSetupError(`mcp adapter config: ${where} must be a non-empty string`)
  }
  return value
}

function validateToolCall(value: unknown, where: string, allowed: readonly string[]): McpToolCall {
  if (!isRecord(value)) throw new EvalSetupError(`mcp adapter config: ${where} must be an object`)
  const tool = requiredString(value.tool, `${where}.tool`)
  if (value.args !== undefined) placeholdersIn(value.args, allowed, `${where}.args`)
  return { tool, args: isRecord(value.args) ? value.args : {} }
}

export function validateAdapterConfig(raw: unknown, source: string): McpAdapterConfig {
  if (!isRecord(raw)) throw new EvalSetupError(`mcp adapter config ${source} must be a json object`)
  const name = requiredString(raw.name, 'name')
  const transport = raw.transport
  if (!isRecord(transport)) {
    throw new EvalSetupError(`mcp adapter config ${source}: transport must be an object`)
  }
  let parsedTransport: McpAdapterConfig['transport']
  if (transport.kind === 'stdio') {
    const command = requiredString(transport.command, 'transport.command')
    const args = Array.isArray(transport.args) ? transport.args.map((a) => String(a)) : []
    placeholdersIn(args, ['tmp'], 'transport.args')
    const env = isRecord(transport.env)
      ? Object.fromEntries(Object.entries(transport.env).map(([k, v]) => [k, String(v)]))
      : undefined
    placeholdersIn(env, ['tmp'], 'transport.env')
    parsedTransport = { kind: 'stdio', command, args, env, cwd: transport.cwd as string | undefined }
  } else if (transport.kind === 'http') {
    parsedTransport = {
      kind: 'http',
      url: requiredString(transport.url, 'transport.url'),
      headers: isRecord(transport.headers)
        ? Object.fromEntries(Object.entries(transport.headers).map(([k, v]) => [k, String(v)]))
        : undefined,
    }
  } else {
    throw new EvalSetupError(
      `mcp adapter config ${source}: transport.kind must be "stdio" or "http" (got ${String(transport.kind)})`
    )
  }
  const write = validateToolCall(raw.write, 'write', WRITE_VARS)
  const idPath =
    isRecord(raw.write) && typeof raw.write.idPath === 'string' ? raw.write.idPath : undefined
  const search = validateToolCall(raw.search, 'search', SEARCH_VARS)
  if (raw.reset !== undefined) validateToolCall(raw.reset, 'reset', ITEM_VARS)
  if (!isRecord(raw.context)) {
    throw new EvalSetupError(`mcp adapter config ${source}: context must be an object`)
  }
  const sections = Array.isArray(raw.context.sections)
    ? raw.context.sections.map((path) => String(path))
    : []
  let items: McpContextConfig['items']
  if (raw.context.items !== undefined) {
    if (!isRecord(raw.context.items)) {
      throw new EvalSetupError(`mcp adapter config ${source}: context.items must be an object`)
    }
    items = {
      path: requiredString(raw.context.items.path, 'context.items.path'),
      text: requiredString(raw.context.items.text, 'context.items.text'),
      id: raw.context.items.id === undefined ? undefined : String(raw.context.items.id),
    }
  }
  if (sections.length === 0 && !items) {
    throw new EvalSetupError(
      `mcp adapter config ${source}: context needs sections and/or items, or the search reply yields no context`
    )
  }
  const timeoutMs = raw.timeoutMs === undefined ? undefined : Number(raw.timeoutMs)
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new EvalSetupError(`mcp adapter config ${source}: timeoutMs must be a positive number`)
  }
  return {
    name,
    describe: typeof raw.describe === 'string' ? raw.describe : undefined,
    transport: parsedTransport,
    write: { ...write, idPath },
    search,
    context: { sections, items },
    reset: raw.reset === undefined ? undefined : validateToolCall(raw.reset, 'reset', ITEM_VARS),
    timeoutMs,
  }
}

/** the config file's bytes, so two runs can prove they used the same adapter */
export function loadAdapterConfig(source: string): {
  config: McpAdapterConfig
  hash: string
  source: string
} {
  const path = isAbsolute(source) ? source : resolve(REPO_ROOT, source)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new EvalSetupError(
      `mcp adapter config not readable: ${path} (${error instanceof Error ? error.message : String(error)})`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new EvalSetupError(
      `${path} is not valid json: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return {
    config: validateAdapterConfig(parsed, path),
    hash: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    source: path,
  }
}

interface Vars {
  namespace?: string
  query?: string
  budgetChars?: number
  topK?: number
  tmp?: string
  session?: SystemSession
}

function resolveVar(name: string, vars: Vars): unknown {
  switch (name) {
    case 'namespace':
      return vars.namespace
    case 'query':
      return vars.query
    case 'budgetChars':
      return vars.budgetChars
    case 'topK':
      return vars.topK
    case 'tmp':
      return vars.tmp
    case 'session.id':
      return vars.session?.id
    case 'session.text':
      return vars.session?.text
    case 'session.createdAt':
      return vars.session?.createdAt
    case 'session.tags':
      return vars.session?.tags ?? []
    default:
      throw new EvalSetupError(`unknown placeholder \${${name}}`)
  }
}

/** an arg that is exactly one placeholder keeps the raw value (numbers, arrays) */
export function fillTemplates<T>(value: T, vars: Vars): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\$\{([^}]+)\}$/)
    if (exact) return resolveVar(exact[1].trim(), vars)
    return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) =>
      String(resolveVar(name.trim(), vars) ?? '')
    )
  }
  if (Array.isArray(value)) return value.map((entry) => fillTemplates(entry, vars))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, fillTemplates(entry, vars)])
    )
  }
  return value
}

/** dot path walking into arrays: `memories[].content` yields one value per memory */
export function pluckValues(payload: unknown, path: string): unknown[] {
  const [head, ...rest] = path.split('.')
  const many = head.endsWith('[]')
  const key = many ? head.slice(0, -2) : head
  const current = key === '' ? payload : isRecord(payload) ? payload[key] : undefined
  const entries = many ? (Array.isArray(current) ? current : []) : [current]
  const out: unknown[] = []
  for (const entry of entries) {
    if (rest.length === 0) out.push(entry)
    else out.push(...pluckValues(entry, rest.join('.')))
  }
  return out
}

function pluckStrings(payload: unknown, path: string): string[] {
  return pluckValues(payload, path)
    .filter((value) => value !== null && value !== undefined)
    .map((value) => (typeof value === 'string' ? value : isRecord(value) ? '' : String(value)))
    .filter((value) => value !== '')
}

function pluckOne(payload: unknown, path: string): unknown {
  return pluckValues(payload, path)[0]
}

function slug(text: string): string {
  return text.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'mcp'
}

export interface CreateMcpSystemInput {
  config: McpAdapterConfig
  adapter: SystemAdapter
  topK: number
}

export async function createMcpSystem(input: CreateMcpSystemInput): Promise<MemorySystem> {
  const { config, adapter, topK } = input
  const tmpDir = mkdtempSync(join(tmpdir(), `engram-eval-mcp-${slug(config.name)}-`))
  const wire: Wire =
    config.transport.kind === 'stdio'
      ? StdioWire.spawn({
          command: config.transport.command,
          args: fillTemplates(config.transport.args ?? [], { tmp: tmpDir }) as string[],
          cwd: config.transport.cwd,
          env: fillTemplates(config.transport.env ?? {}, { tmp: tmpDir }) as Record<string, string>,
        })
      : new HttpWire({ url: config.transport.url, headers: config.transport.headers })

  const cleanup = async (): Promise<void> => {
    await wire.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  let client: McpClient
  try {
    client = await McpClient.start(wire, { timeoutMs: config.timeoutMs })
  } catch (error) {
    await cleanup()
    throw error
  }

  try {
    // a config that names a tool the server does not have must fail here, not mid-run
    const available = await client.listTools()
    const needed = [config.write.tool, config.search.tool, config.reset?.tool].filter(
      (name): name is string => typeof name === 'string'
    )
    const missing = needed.filter((name) => !available.includes(name))
    if (missing.length > 0) {
      throw new EvalSetupError(
        `mcp system "${config.name}" needs tool(s) ${missing.join(', ')}; the server exposes: ` +
          `${available.join(', ') || '(none)'}`
      )
    }
  } catch (error) {
    await cleanup()
    throw error
  }

  const refs = new Map<string, Map<string, string>>()
  let writeCalls = 0
  let closed = false

  const itemsOf = (payload: unknown, byId: Map<string, string> | undefined): RetrievedItem[] => {
    const spec = config.context.items
    if (!spec) return []
    const entries = pluckValues(payload, spec.path)
    return entries
      .map((entry) => {
        if (typeof entry === 'string') return { text: entry }
        if (!isRecord(entry)) return null
        const text = pluckOne(entry, spec.text)
        const id = spec.id ? pluckOne(entry, spec.id) : undefined
        const item: RetrievedItem = { text: typeof text === 'string' ? text : String(text ?? '') }
        if (typeof id === 'string' && id !== '') {
          item.id = id
          const ref = byId?.get(id)
          if (ref) item.ref = ref
        }
        return item
      })
      .filter((item): item is RetrievedItem => item !== null && item.text !== '')
  }

  return {
    name: config.name,
    describe: config.describe ?? `mcp ${config.transport.kind} server ${config.name}`,
    adapter,

    async reset(ns) {
      refs.delete(ns)
      if (config.reset) {
        const args = fillTemplates(config.reset.args ?? {}, { namespace: ns, tmp: tmpDir })
        await client.callTool(config.reset.tool, args as Record<string, unknown>)
      }
    },

    async ingest(ns, sessions) {
      const byId = refs.get(ns) ?? new Map<string, string>()
      refs.set(ns, byId)
      for (const session of sessions) {
        const args = fillTemplates(config.write.args ?? {}, { namespace: ns, tmp: tmpDir, session })
        const payload = await client.callTool(config.write.tool, args as Record<string, unknown>)
        writeCalls++
        const id = config.write.idPath ? pluckOne(payload, config.write.idPath) : undefined
        if (typeof id === 'string' && id !== '') byId.set(id, session.id)
      }
    },

    async retrieve(ns, query, budgetChars) {
      const args = fillTemplates(config.search.args ?? {}, {
        namespace: ns,
        tmp: tmpDir,
        query,
        budgetChars,
        topK,
      })
      const started = performance.now()
      const payload = await client.callTool(config.search.tool, args as Record<string, unknown>)
      const retrievalMs = performance.now() - started
      const blocks = (config.context.sections ?? []).flatMap((path) => pluckStrings(payload, path))
      const items = itemsOf(payload, refs.get(ns))
      return {
        context: blocks.join('\n\n'),
        blocks,
        items,
        retrievalMs,
        note: `tool=${config.search.tool}, items=${items.length}, refs=${items.filter((item) => item.ref).length}`,
      }
    },

    // an mcp server does not report its own llm spend, so only calls are countable
    // a remote server's own model calls are invisible over mcp, so unknown beats a false zero
    cost: () => ({ writeCalls, writeTokens: null }),

    async close() {
      if (closed) return
      closed = true
      await cleanup()
    },
  }
}
