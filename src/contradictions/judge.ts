import { chatJson, isLlmConfigured, loadLlmConfig, LlmUnavailableError } from '../llm/client.js'
import type { Memory } from '../memory/types.js'
import type { Candidate } from './candidates.js'

export const PROMPT_VERSION = 'contradiction-v1'

export type Relation = 'contradicts' | 'supports' | 'unrelated' | 'duplicate' | 'updates'

export interface Verdict {
  candidateId: string
  relation: Relation
  confidence: number
  reason: string
}

export interface JudgeInput {
  newMemory: Pick<Memory, 'id' | 'content' | 'created_at' | 'type'>
  candidates: Candidate[]
}

export interface JudgeResult {
  verdicts: Verdict[]
  model: string
  promptVersion: string
  promptTokens?: number
  completionTokens?: number
}

const SYSTEM_PROMPT = `You are an expert annotator for a developer-facing memory system.
Decide how a NEW memory relates to each existing CANDIDATE memory captured for the same project.

For every candidate, choose ONE relation:
- "contradicts": both claim something about THE SAME subject/entity/decision, but they cannot both be true. The new memory invalidates the candidate.
- "updates": same subject as the candidate, but the new memory refines, clarifies, or restates it without claiming the old is wrong. Treat as a soft replacement.
- "duplicate": same subject and same factual content as the candidate.
- "supports": about the same subject and consistent with the candidate; both should remain.
- "unrelated": different subject/entity, or comparison is not meaningful.

Hard rules:
1. Two memories about DIFFERENT subjects (e.g., "use Postgres" vs "use Redis for cache") are NEVER contradictory. Pick "unrelated".
2. Different scopes/contexts (different files, modules, environments) are NOT contradictions. Pick "unrelated".
3. Only mark "contradicts" when a reasonable engineer would say the candidate is now WRONG given the new memory.
4. Confidence must reflect uncertainty: 0.95+ only when the contradiction/update is unambiguous.
5. Reasons must be 1 short sentence quoting the disagreement.

Respond with strictly valid JSON of shape:
{"verdicts":[{"candidateId":"<id>","relation":"<relation>","confidence":<0..1>,"reason":"<text>"}, ...]}
Include exactly one verdict per candidate, in the same order as provided.`

export async function judgeCandidates(input: JudgeInput): Promise<JudgeResult> {
  if (!isLlmConfigured()) {
    throw new LlmUnavailableError('LLM not configured; cannot adjudicate contradictions')
  }
  if (input.candidates.length === 0) {
    const cfg = loadLlmConfig()!
    return { verdicts: [], model: cfg.model, promptVersion: PROMPT_VERSION }
  }

  const userPrompt = renderJudgePrompt(input)
  const { data, raw } = await chatJson<JudgeResponse>(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0, maxTokens: 1500 }
  )

  const verdicts = normalizeVerdicts(data, input.candidates)
  return {
    verdicts,
    model: raw.model,
    promptVersion: PROMPT_VERSION,
    promptTokens: raw.promptTokens,
    completionTokens: raw.completionTokens,
  }
}

interface JudgeResponse {
  verdicts?: Array<{
    candidateId?: string
    relation?: string
    confidence?: number | string
    reason?: string
  }>
}

function renderJudgePrompt(input: JudgeInput): string {
  const newBlock = [
    `NEW memory:`,
    `id: ${input.newMemory.id}`,
    `type: ${input.newMemory.type}`,
    `created_at: ${new Date(input.newMemory.created_at).toISOString()}`,
    `content: ${truncate(input.newMemory.content, 800)}`,
  ].join('\n')

  const candidateBlocks = input.candidates.map((c, i) =>
    [
      `CANDIDATE ${i + 1}:`,
      `id: ${c.memory.id}`,
      `type: ${c.memory.type}`,
      `created_at: ${new Date(c.memory.created_at).toISOString()}`,
      `tags: ${c.memory.tags.join(', ') || '(none)'}`,
      `content: ${truncate(c.memory.content, 600)}`,
    ].join('\n')
  )

  return [
    newBlock,
    '',
    'Existing candidates from the same project:',
    candidateBlocks.join('\n\n'),
    '',
    `Output one verdict per candidate (${input.candidates.length} total) in the same order.`,
  ].join('\n')
}

function normalizeVerdicts(data: JudgeResponse, candidates: Candidate[]): Verdict[] {
  const byId = new Map<string, Verdict>()
  const allowedRelations: ReadonlySet<Relation> = new Set([
    'contradicts',
    'supports',
    'unrelated',
    'duplicate',
    'updates',
  ])
  if (Array.isArray(data.verdicts)) {
    for (const v of data.verdicts) {
      if (!v.candidateId) continue
      const relation = allowedRelations.has(v.relation as Relation) ? (v.relation as Relation) : 'unrelated'
      const confidence = clamp01(toNumber(v.confidence))
      const reason = typeof v.reason === 'string' ? v.reason.slice(0, 500) : ''
      byId.set(v.candidateId, { candidateId: v.candidateId, relation, confidence, reason })
    }
  }
  return candidates.map((c) =>
    byId.get(c.memory.id) ?? {
      candidateId: c.memory.id,
      relation: 'unrelated',
      confidence: 0,
      reason: 'judge omitted verdict; defaulted to unrelated',
    }
  )
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}
