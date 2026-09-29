import { describe, it, expect } from 'vitest'
import { REASONING_HEADROOM_TOKENS, buildChatBody, parseModelSpec } from '../src/llm/client.js'

const messages = [{ role: 'user' as const, content: 'q' }]

describe('chat request body per model family', () => {
  it('sends a classic model temperature and max_tokens as given', () => {
    expect(buildChatBody('gpt-4o', messages, { temperature: 0, maxTokens: 10 })).toEqual({
      model: 'gpt-4o',
      messages,
      temperature: 0,
      max_tokens: 10,
    })
  })

  it('sends a reasoning model max_completion_tokens with headroom and no temperature', () => {
    expect(buildChatBody('gpt-6-luna', messages, { temperature: 0, maxTokens: 64 })).toEqual({
      model: 'gpt-6-luna',
      messages,
      max_completion_tokens: 64 + REASONING_HEADROOM_TOKENS,
    })
  })

  it('takes the effort from the model suffix and strips it from the wire model', () => {
    expect(buildChatBody('gpt-6-luna:xhigh', messages, { maxTokens: 64 })).toEqual({
      model: 'gpt-6-luna',
      messages,
      max_completion_tokens: 64 + REASONING_HEADROOM_TOKENS,
      reasoning_effort: 'xhigh',
    })
  })

  it('matches a provider-prefixed id and the o-series', () => {
    expect(buildChatBody('openai/gpt-6-sol', messages, { maxTokens: 1 })).toHaveProperty('max_completion_tokens')
    expect(buildChatBody('o3', messages, { maxTokens: 1 })).toHaveProperty('max_completion_tokens')
    expect(buildChatBody('gpt-4.1', messages, { maxTokens: 1 })).toHaveProperty('max_tokens')
  })

  it('leaves a colon that is not an effort level inside the model name', () => {
    expect(parseModelSpec('vendor/model:2026')).toEqual({ model: 'vendor/model:2026' })
    expect(parseModelSpec('gpt-6-luna:low')).toEqual({ model: 'gpt-6-luna', reasoningEffort: 'low' })
  })
})
