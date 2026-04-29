import { chatJson, LlmUnavailableError, isLlmConfigured, loadLlmConfig } from '../llm/client.js'
import type { ChatMessage } from '../llm/client.js'
import { logger } from '../utils/logger.js'

export const IMPORTANCE_PROMPT_VERSION = 'importance-v1'

export interface ImportanceScore {
  importance: number
  reason: string
  model: string
  promptVersion: string
}

export type ScoreInput = {
  content: string
  type?: string
  tags?: readonly string[]
}

const SYSTEM_PROMPT = `You score the long-term retention value of a single memory written by an AI coding assistant about a codebase or project.

Return ONLY a JSON object: {"importance": <0.0..1.0>, "reason": "<one sentence>"}

Rubric (anchor your score to the closest band):
  0.0  trivial / debug noise / restated obvious / single-use chatter
  0.3  routine note (file location, simple naming, common-knowledge fact)
  0.5  useful project context (a pattern, a config value, a non-obvious behavior)
  0.7  valuable knowledge (architectural insight, hard-won bug fix, key invariant)
  0.9  critical decision / cross-cutting design / load-bearing constraint
  1.0  irreversible commitment, security boundary, or contract that, if forgotten, breaks the system

Heuristics:
  - Decisions and "we chose X over Y because Z" content score >= 0.7
  - Bug root causes and gotchas score >= 0.6 if non-obvious
  - Code snippets without explanation score <= 0.4
  - "TODO: investigate" with no resolution scores <= 0.3
  - Be conservative: most memories are 0.3-0.6. Reserve >=0.8 for content that genuinely changes future architectural choices.`

export class ImportanceScoreError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'ImportanceScoreError'
  }
}

interface RawResponse {
  importance?: unknown
  reason?: unknown
}

export async function scoreImportance(input: ScoreInput): Promise<ImportanceScore> {
  if (!isLlmConfigured()) {
    throw new LlmUnavailableError('LLM not configured for importance scoring')
  }

  const userMessage = buildUserMessage(input)
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ]

  let parsed: RawResponse
  let model: string
  try {
    const result = await chatJson<RawResponse>(messages, { temperature: 0, maxTokens: 200 })
    parsed = result.data
    model = result.raw.model
  } catch (err) {
    if (err instanceof LlmUnavailableError) throw err
    throw new ImportanceScoreError('LLM call failed during importance scoring', err)
  }

  const importance = clampImportance(parsed.importance)
  if (importance === null) {
    throw new ImportanceScoreError(
      `LLM returned invalid importance: ${JSON.stringify(parsed.importance)}`
    )
  }

  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : ''
  logger.debug({ importance, reason, model }, 'importance scored')

  return {
    importance,
    reason,
    model,
    promptVersion: IMPORTANCE_PROMPT_VERSION,
  }
}

function buildUserMessage(input: ScoreInput): string {
  const parts: string[] = []
  if (input.type) parts.push(`type: ${input.type}`)
  if (input.tags && input.tags.length > 0) {
    parts.push(`tags: ${input.tags.slice(0, 8).join(', ')}`)
  }
  parts.push('---')
  parts.push(input.content.slice(0, 4000))
  return parts.join('\n')
}

function clampImportance(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  if (raw < 0) return 0
  if (raw > 1) return 1
  return raw
}

export function getImportanceModel(): string | null {
  const cfg = loadLlmConfig()
  return cfg?.model ?? null
}
