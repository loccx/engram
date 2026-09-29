import { logger } from '../utils/logger.js'

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  userEmail?: string
  componentId?: string
  timeoutMs: number
  maxRetries: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  reasoningEffort?: ReasoningEffort
  responseFormat?: 'text' | 'json_object'
  timeoutMs?: number
}

export interface ChatResult {
  content: string
  model: string
  promptTokens?: number
  completionTokens?: number
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmUnavailableError'
  }
}

export class LlmRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly responseBody?: string
  ) {
    super(message)
    this.name = 'LlmRequestError'
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 2
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

let cachedConfig: LlmConfig | null | undefined

export function loadLlmConfig(): LlmConfig | null {
  if (cachedConfig !== undefined) return cachedConfig

  const baseUrl = process.env.ENGRAM_LLM_BASE_URL?.trim()
  const apiKey = process.env.ENGRAM_LLM_API_KEY?.trim()
  const model = process.env.ENGRAM_LLM_MODEL?.trim() || 'gpt-5.4-nano'
  const userEmail = process.env.ENGRAM_LLM_USER_EMAIL?.trim()
  const componentId = process.env.ENGRAM_LLM_COMPONENT_ID?.trim() || 'engram'
  const timeoutMs = parseIntSafe(process.env.ENGRAM_LLM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const maxRetries = parseIntSafe(process.env.ENGRAM_LLM_MAX_RETRIES, DEFAULT_MAX_RETRIES)

  if (!baseUrl || !apiKey) {
    cachedConfig = null
    return null
  }

  cachedConfig = {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    userEmail,
    componentId,
    timeoutMs,
    maxRetries,
  }
  return cachedConfig
}

export function resetLlmConfigForTests(): void {
  cachedConfig = undefined
}

export function isLlmConfigured(): boolean {
  return loadLlmConfig() !== null
}

let warnedUnconfigured = false
function warnUnconfiguredOnce(): void {
  if (warnedUnconfigured) return
  warnedUnconfigured = true
  logger.warn(
    'LLM features disabled: set ENGRAM_LLM_BASE_URL and ENGRAM_LLM_API_KEY to enable contradiction adjudication, importance scoring, and reflection.'
  )
}

// wire quirks per model family, first match wins; a new family is one entry
interface ModelProfile {
  match: RegExp
  reasoning: boolean
}

const MODEL_PROFILES: ModelProfile[] = [
  // openai reasoning families reject max_tokens and any non-default temperature
  { match: /(^|\/)(gpt-5|gpt-6|o[1-9])/i, reasoning: true },
]

// a reasoning model bills its thinking against the output cap, so a cap sized for the
// visible answer comes back empty without room on top; unused budget costs nothing
export const REASONING_HEADROOM_TOKENS = 8192

/** `<model>:high` pins the effort in the model name, so it travels wherever the name is recorded */
export function parseModelSpec(spec: string): { model: string; reasoningEffort?: ReasoningEffort } {
  const at = spec.lastIndexOf(':')
  const suffix = at > 0 ? spec.slice(at + 1) : ''
  if ((REASONING_EFFORTS as readonly string[]).includes(suffix)) {
    return { model: spec.slice(0, at), reasoningEffort: suffix as ReasoningEffort }
  }
  return { model: spec }
}

export function buildChatBody(
  modelSpec: string,
  messages: ChatMessage[],
  options: ChatOptions
): Record<string, unknown> {
  const { model, reasoningEffort } = parseModelSpec(modelSpec)
  const body: Record<string, unknown> = { model, messages }
  const reasoning = MODEL_PROFILES.find((profile) => profile.match.test(model))?.reasoning ?? false
  if (reasoning) {
    if (options.maxTokens !== undefined) body.max_completion_tokens = options.maxTokens + REASONING_HEADROOM_TOKENS
    const effort = options.reasoningEffort ?? reasoningEffort
    if (effort !== undefined) body.reasoning_effort = effort
  } else {
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  }
  if (options.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' }
  }
  return body
}

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {},
  configOverride?: LlmConfig
): Promise<ChatResult> {
  const config = configOverride ?? loadLlmConfig()
  if (!config) {
    warnUnconfiguredOnce()
    throw new LlmUnavailableError('LLM not configured (ENGRAM_LLM_BASE_URL/ENGRAM_LLM_API_KEY missing)')
  }

  const timeoutMs = options.timeoutMs ?? config.timeoutMs
  const url = `${config.baseUrl}/chat/completions`
  const body = buildChatBody(config.model, messages, options)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    'x-lgw-or-component-id': config.componentId ?? 'engram',
  }
  if (config.userEmail) headers['x-user-email'] = config.userEmail

  let lastError: Error | undefined
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (!res.ok) {
        const text = await safeReadBody(res)
        const error = new LlmRequestError(
          `LLM request failed: HTTP ${res.status}`,
          res.status,
          text
        )
        if (RETRYABLE_STATUSES.has(res.status) && attempt < config.maxRetries) {
          lastError = error
          await sleepWithBackoff(attempt)
          continue
        }
        throw error
      }

      const json = (await res.json()) as OpenAIChatResponse
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new LlmRequestError('LLM response missing choices[0].message.content')
      }
      return {
        content,
        model: json.model ?? config.model,
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
      }
    } catch (e) {
      clearTimeout(timer)
      const err = e instanceof Error ? e : new Error(String(e))
      const isAbort = err.name === 'AbortError'
      const isNetwork = !(err instanceof LlmRequestError)
      if ((isAbort || isNetwork) && attempt < config.maxRetries) {
        lastError = err
        await sleepWithBackoff(attempt)
        continue
      }
      throw err
    }
  }
  throw lastError ?? new LlmRequestError('LLM request failed after retries')
}

export async function chatJson<T = unknown>(
  messages: ChatMessage[],
  options: Omit<ChatOptions, 'responseFormat'> = {},
  configOverride?: LlmConfig
): Promise<{ data: T; raw: ChatResult }> {
  const raw = await chat(messages, { ...options, responseFormat: 'json_object' }, configOverride)
  const data = parseJsonStrict<T>(raw.content)
  return { data, raw }
}

interface OpenAIChatResponse {
  model?: string
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 1000)
  } catch {
    return ''
  }
}

function parseIntSafe(input: string | undefined, fallback: number): number {
  if (!input) return fallback
  const n = parseInt(input, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseJsonStrict<T>(content: string): T {
  const trimmed = stripJsonFences(content.trim())
  try {
    return JSON.parse(trimmed) as T
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new LlmRequestError(`LLM returned non-JSON content: ${msg}`, undefined, content.slice(0, 500))
  }
}

function stripJsonFences(s: string): string {
  if (s.startsWith('```')) {
    return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  }
  return s
}

async function sleepWithBackoff(attempt: number): Promise<void> {
  const ms = Math.min(2_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100)
  await new Promise((resolve) => setTimeout(resolve, ms))
}
