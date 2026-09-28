import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chat,
  chatJson,
  loadLlmConfig,
  isLlmConfigured,
  resetLlmConfigForTests,
  LlmUnavailableError,
  LlmRequestError,
  type LlmConfig,
} from '../src/llm/client.js'

const TEST_CONFIG: LlmConfig = {
  baseUrl: 'https://llm-gateway.test/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
  userEmail: 'tester@example.com',
  componentId: 'engram-test',
  timeoutMs: 5000,
  maxRetries: 2,
}

const ENV_KEYS = [
  'ENGRAM_LLM_BASE_URL',
  'ENGRAM_LLM_API_KEY',
  'ENGRAM_LLM_MODEL',
  'ENGRAM_LLM_USER_EMAIL',
  'ENGRAM_LLM_COMPONENT_ID',
  'ENGRAM_LLM_TIMEOUT_MS',
  'ENGRAM_LLM_MAX_RETRIES',
]

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k]
}

function chatResponse(content: string, model = 'gpt-test'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

describe('LLM client - configuration', () => {
  beforeEach(() => {
    clearEnv()
    resetLlmConfigForTests()
  })
  afterEach(() => {
    clearEnv()
    resetLlmConfigForTests()
  })

  it('returns null when env not set', () => {
    expect(loadLlmConfig()).toBeNull()
    expect(isLlmConfigured()).toBe(false)
  })

  it('loads config from env with defaults', () => {
    process.env.ENGRAM_LLM_BASE_URL = 'https://gw.test/v1'
    process.env.ENGRAM_LLM_API_KEY = 'k'
    const cfg = loadLlmConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.baseUrl).toBe('https://gw.test/v1')
    expect(cfg!.apiKey).toBe('k')
    expect(cfg!.model).toBe('gpt-5.4-nano')
    expect(cfg!.componentId).toBe('engram')
    expect(cfg!.timeoutMs).toBe(30_000)
    expect(cfg!.maxRetries).toBe(2)
  })

  it('strips trailing slash from baseUrl', () => {
    process.env.ENGRAM_LLM_BASE_URL = 'https://gw.test/v1/////'
    process.env.ENGRAM_LLM_API_KEY = 'k'
    expect(loadLlmConfig()!.baseUrl).toBe('https://gw.test/v1')
  })

  it('caches config across calls', () => {
    process.env.ENGRAM_LLM_BASE_URL = 'https://gw.test/v1'
    process.env.ENGRAM_LLM_API_KEY = 'k'
    const a = loadLlmConfig()
    process.env.ENGRAM_LLM_API_KEY = 'changed'
    const b = loadLlmConfig()
    expect(a).toBe(b)
  })

  it('honors override env values for model, timeout, retries', () => {
    process.env.ENGRAM_LLM_BASE_URL = 'https://gw.test/v1'
    process.env.ENGRAM_LLM_API_KEY = 'k'
    process.env.ENGRAM_LLM_MODEL = 'gpt-other'
    process.env.ENGRAM_LLM_TIMEOUT_MS = '12345'
    process.env.ENGRAM_LLM_MAX_RETRIES = '5'
    const cfg = loadLlmConfig()!
    expect(cfg.model).toBe('gpt-other')
    expect(cfg.timeoutMs).toBe(12345)
    expect(cfg.maxRetries).toBe(5)
  })

  it('falls back to defaults on invalid numeric env', () => {
    process.env.ENGRAM_LLM_BASE_URL = 'https://gw.test/v1'
    process.env.ENGRAM_LLM_API_KEY = 'k'
    process.env.ENGRAM_LLM_TIMEOUT_MS = 'not-a-number'
    process.env.ENGRAM_LLM_MAX_RETRIES = '-3'
    const cfg = loadLlmConfig()!
    expect(cfg.timeoutMs).toBe(30_000)
    expect(cfg.maxRetries).toBe(2)
  })
})

describe('LLM client - chat', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    clearEnv()
    resetLlmConfigForTests()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearEnv()
    resetLlmConfigForTests()
  })

  it('throws LlmUnavailableError when not configured', async () => {
    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(LlmUnavailableError)
  })

  it('sends correct request shape and headers', async () => {
    fetchMock.mockResolvedValueOnce(chatResponse('hello'))
    const result = await chat(
      [{ role: 'user', content: 'hi' }],
      { temperature: 0.2, maxTokens: 50 },
      TEST_CONFIG
    )
    expect(result.content).toBe('hello')
    expect(result.promptTokens).toBe(10)
    expect(result.completionTokens).toBe(20)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://llm-gateway.test/v1/chat/completions')
    const sentBody = JSON.parse((init as RequestInit).body as string)
    expect(sentBody).toMatchObject({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      max_tokens: 50,
    })
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-key')
    expect(headers['x-lgw-or-component-id']).toBe('engram-test')
    expect(headers['x-user-email']).toBe('tester@example.com')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('omits x-user-email header when not configured', async () => {
    fetchMock.mockResolvedValueOnce(chatResponse('hi'))
    await chat([{ role: 'user', content: 'q' }], {}, { ...TEST_CONFIG, userEmail: undefined })
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['x-user-email']).toBeUndefined()
  })

  it('adds response_format when responseFormat=json_object', async () => {
    fetchMock.mockResolvedValueOnce(chatResponse('{}'))
    await chat([{ role: 'user', content: 'q' }], { responseFormat: 'json_object' }, TEST_CONFIG)
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.response_format).toEqual({ type: 'json_object' })
  })

  it('retries on 503 then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(chatResponse('ok'))
    const result = await chat([{ role: 'user', content: 'q' }], {}, TEST_CONFIG)
    expect(result.content).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry on 400 (non-retryable)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }))
    await expect(chat([{ role: 'user', content: 'q' }], {}, TEST_CONFIG)).rejects.toMatchObject({
      name: 'LlmRequestError',
      status: 400,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws LlmRequestError after max retries on persistent 500s', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 500 }))
    await expect(
      chat([{ role: 'user', content: 'q' }], {}, { ...TEST_CONFIG, maxRetries: 1 })
    ).rejects.toBeInstanceOf(LlmRequestError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws when response missing choices content', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ model: 'gpt-test', choices: [] }), { status: 200 })
    )
    await expect(chat([{ role: 'user', content: 'q' }], {}, TEST_CONFIG)).rejects.toBeInstanceOf(
      LlmRequestError
    )
  })
})

describe('LLM client - chatJson', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    clearEnv()
    resetLlmConfigForTests()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearEnv()
    resetLlmConfigForTests()
  })

  it('parses raw JSON content', async () => {
    fetchMock.mockResolvedValueOnce(chatResponse('{"verdict":"yes","confidence":0.9}'))
    const { data } = await chatJson<{ verdict: string; confidence: number }>(
      [{ role: 'user', content: 'q' }],
      {},
      TEST_CONFIG
    )
    expect(data).toEqual({ verdict: 'yes', confidence: 0.9 })
  })

  it('strips ```json fences before parsing', async () => {
    fetchMock.mockResolvedValueOnce(chatResponse('```json\n{"a":1}\n```'))
    const { data } = await chatJson<{ a: number }>([{ role: 'user', content: 'q' }], {}, TEST_CONFIG)
    expect(data).toEqual({ a: 1 })
  })

  it('throws LlmRequestError on invalid JSON', async () => {
    fetchMock.mockResolvedValueOnce(chatResponse('not json'))
    await expect(
      chatJson([{ role: 'user', content: 'q' }], {}, TEST_CONFIG)
    ).rejects.toBeInstanceOf(LlmRequestError)
  })
})
