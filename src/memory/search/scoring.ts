import type { Memory } from '../types.js'

/**
 * ebbinghaus forgetting curve R = exp(-t / S), with S scaled by importance and
 * access: repeated use slows decay (spacing effect)
 */
export function ebbinghaus(memory: Memory, now: number): number {
  const t = now - (memory.last_accessed ?? memory.created_at)
  const tDays = t / (24 * 60 * 60 * 1000)
  const strength = memory.importance + 0.3 * Math.log(memory.access_count + 1)
  const S = 30 * Math.max(strength, 0.1)
  return Math.exp(-tDays / S)
}

// attnres-inspired adaptive scoring (arxiv 2603.15031): the query archetype picks
// the signal weights instead of one fixed multiplication
export type QueryArchetype = 'temporal' | 'lookup' | 'semantic' | 'frequentist' | 'aggregation'

export interface WeightProfile {
  fts: number
  vec: number
  recency: number
  access: number
  importance: number
}

// temporal > lookup > frequentist > aggregation > semantic (the fallback)
const TEMPORAL_RE =
  /\b(yesterday|today|recent(?:ly)?|last\s+(?:week|session|time|month|day)|ago|earlier|previous(?:ly)?|this\s+(?:morning|week|month))\b/i
const LOOKUP_RE =
  /\b[a-z]+[A-Z][a-zA-Z]*\b|\b[a-z]+_[a-z]+\b|\b[A-Z][A-Z0-9]+_[A-Z][A-Z0-9]+\b|`[^`]+`|0x[0-9a-fA-F]+/
const FREQUENTIST_RE =
  /\b(common(?:ly)?|frequent(?:ly)?|often|always|usually|pattern|convention|standard|best\s+practice|typical(?:ly)?)\b/i
// a question that totals or lists what several sessions said, so the answer needs one
// turn from each session it touched rather than the deepest turns of the best few
// (arxiv 2609.25913: budgeted evidence completion)
const AGGREGATION_RE =
  /\b(how many|how much|how often|how long|in total|total|altogether|combined|sum|number of|all the|list)\b/i

/**
 * the cue lists, in precedence order: the first pattern that fires names the archetype,
 * and a query that matches none is `semantic`. one place to add a cue class.
 */
export const QUERY_ARCHETYPES: ReadonlyArray<{ name: QueryArchetype; pattern: RegExp }> = [
  { name: 'temporal', pattern: TEMPORAL_RE },
  { name: 'lookup', pattern: LOOKUP_RE },
  { name: 'frequentist', pattern: FREQUENTIST_RE },
  { name: 'aggregation', pattern: AGGREGATION_RE },
]

const SEMANTIC_WEIGHTS: WeightProfile = {
  fts: 0.20, vec: 0.35, recency: 0.15, access: 0.10, importance: 0.20,
}

// the weights sum to 1.0, and the vec weight is shared out when vectors are off.
// aggregation shares semantic's weights: it routes assembly (see memory/allocation.ts),
// so joining the archetype list cannot move a ranking
export const WEIGHT_PROFILES: Record<QueryArchetype, WeightProfile> = {
  temporal:    { fts: 0.10, vec: 0.15, recency: 0.50, access: 0.10, importance: 0.15 },
  lookup:      { fts: 0.45, vec: 0.15, recency: 0.10, access: 0.15, importance: 0.15 },
  semantic:    SEMANTIC_WEIGHTS,
  frequentist: { fts: 0.10, vec: 0.15, recency: 0.10, access: 0.45, importance: 0.20 },
  aggregation: SEMANTIC_WEIGHTS,
}

/** the archetype's data-driven cue list decides: temporal > lookup > frequentist > aggregation > semantic */
export function classifyQuery(query: string): QueryArchetype {
  for (const rule of QUERY_ARCHETYPES) {
    if (rule.pattern.test(query)) return rule.name
  }
  return 'semantic'
}

export type SignalKey = 'fts' | 'vec' | 'recency' | 'access' | 'importance' | 'reranker'

// both maps are absolute and corpus-independent, so a weak match stays weak
// whatever else was retrieved and min_score can gate on evidence

/** fts5 bm25, negative and more is better, scaled per query term and saturated at p/(1+p) */
export function bm25Relevance(bm25: number, tokenCount: number): number {
  const perTerm = -bm25 / Math.max(1, tokenCount)
  // the NaN-safe reading: a missing score is absence of evidence, not weak evidence
  if (!(perTerm > 0)) return 0
  return perTerm / (perTerm + 1)
}

/** vec0 l2 distance → cosine: embeddings are l2-normalised, so cos = 1 - d²/2 (clamped for legacy rows) */
export function distanceRelevance(distance: number): number {
  if (!Number.isFinite(distance)) return 0
  const cos = 1 - (distance * distance) / 2
  return cos < 0 ? 0 : cos > 1 ? 1 : cos
}

export const DEFAULT_RERANK_BLEND_ALPHA = 0.5
/** the sigmoid is compressed near 0.5, so stretch it before blending */
export const RERANK_NORM_GAIN = 2
export const RERANK_NORM_NEUTRAL = 0.5

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

// affine around 0.5, not min-max over the window: min-max would make min_score
// mean something different for every query
export function normalizeRerankScore(sigmoid: number): number {
  if (!Number.isFinite(sigmoid)) return RERANK_NORM_NEUTRAL
  return clamp01(RERANK_NORM_NEUTRAL + (sigmoid - RERANK_NORM_NEUTRAL) * RERANK_NORM_GAIN)
}

export const RERANK_BLEND_ALPHA_ENV = 'ENGRAM_RERANK_BLEND_ALPHA'

export function rerankBlendAlpha(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RERANK_BLEND_ALPHA_ENV]?.trim()
  if (!raw) return DEFAULT_RERANK_BLEND_ALPHA
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_RERANK_BLEND_ALPHA
  return clamp01(n)
}

export function blendRerankScore(fused: number, rerankNormalized: number, alpha: number): number {
  return alpha * rerankNormalized + (1 - alpha) * fused
}

// access_count feeds back into the score, so which reads count as a use is policy

export type AccessSignalMode = 'retrieval' | 'explicit' | 'off'

export const ACCESS_SIGNAL_ENV = 'ENGRAM_ACCESS_SIGNAL'
/** a top-k appearance is an effect of ranking, not evidence of use */
export const DEFAULT_ACCESS_SIGNAL: AccessSignalMode = 'explicit'

export function resolveAccessSignalMode(env: NodeJS.ProcessEnv = process.env): AccessSignalMode {
  const raw = env[ACCESS_SIGNAL_ENV]?.trim().toLowerCase()
  if (raw === 'retrieval' || raw === 'explicit' || raw === 'off') return raw
  return DEFAULT_ACCESS_SIGNAL
}

export function recordsAccessOnRetrieval(mode: AccessSignalMode = resolveAccessSignalMode()): boolean {
  return mode === 'retrieval'
}

export function recordsAccessOnExplicitFetch(
  mode: AccessSignalMode = resolveAccessSignalMode()
): boolean {
  return mode !== 'off'
}

// both channels are off by default: adding one dilutes every other list by 1/n, so
// a channel ships only once a corpus says it helps

export const IDENT_CHANNEL_ENV = 'ENGRAM_IDENT_CHANNEL'
export const ENTITY_CHANNEL_ENV = 'ENGRAM_ENTITY_CHANNEL'

// anything but '1'/'true' is off, so an unset variable keeps the ranking as shipped
export function channelFlagOn(
  envKey: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env[envKey]?.trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

// undefined means "ask the environment", not off: pass false to force a channel off
export function resolveChannelFlag(
  explicit: boolean | undefined,
  envKey: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return explicit !== undefined ? explicit : channelFlagOn(envKey, env)
}

export function identChannelEnabled(
  options: { ident_channel?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveChannelFlag(options.ident_channel, IDENT_CHANNEL_ENV, env)
}

export function entityChannelEnabled(
  options: { entity_channel?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveChannelFlag(options.entity_channel, ENTITY_CHANNEL_ENV, env)
}
