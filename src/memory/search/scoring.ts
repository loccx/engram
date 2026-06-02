import type { Memory } from '../types.js'

/**
 * Ebbinghaus forgetting curve: R = exp(-t / S)
 * S (stability) scales with importance and access frequency.
 * A memory with importance=0.5 and 0 accesses decays to ~37% in 30 days.
 * Frequent access raises S, slowing decay (spacing effect).
 */
export function ebbinghaus(memory: Memory, now: number): number {
  const t = now - (memory.last_accessed ?? memory.created_at)
  const tDays = t / (24 * 60 * 60 * 1000)
  const strength = memory.importance + 0.3 * Math.log(memory.access_count + 1)
  const S = 30 * Math.max(strength, 0.1)
  return Math.exp(-tDays / S)
}

// AttnRes-inspired adaptive scoring (arxiv 2603.15031):
// query archetype determines signal weights instead of fixed multiplication.
export type QueryArchetype = 'temporal' | 'lookup' | 'semantic' | 'frequentist'

export interface WeightProfile {
  fts: number
  vec: number
  recency: number
  access: number
  importance: number
}

// Priority order: temporal > lookup > frequentist > semantic (default)
const TEMPORAL_RE =
  /\b(yesterday|today|recent(?:ly)?|last\s+(?:week|session|time|month|day)|ago|earlier|previous(?:ly)?|this\s+(?:morning|week|month))\b/i
const LOOKUP_RE =
  /\b[a-z]+[A-Z][a-zA-Z]*\b|\b[a-z]+_[a-z]+\b|\b[A-Z][A-Z0-9]+_[A-Z][A-Z0-9]+\b|`[^`]+`|0x[0-9a-fA-F]+/
const FREQUENTIST_RE =
  /\b(common(?:ly)?|frequent(?:ly)?|often|always|usually|pattern|convention|standard|best\s+practice|typical(?:ly)?)\b/i

// Weights sum to 1.0; vec weight is redistributed when vectors unavailable.
export const WEIGHT_PROFILES: Record<QueryArchetype, WeightProfile> = {
  temporal:    { fts: 0.10, vec: 0.15, recency: 0.50, access: 0.10, importance: 0.15 },
  lookup:      { fts: 0.45, vec: 0.15, recency: 0.10, access: 0.15, importance: 0.15 },
  semantic:    { fts: 0.20, vec: 0.35, recency: 0.15, access: 0.10, importance: 0.20 },
  frequentist: { fts: 0.10, vec: 0.15, recency: 0.10, access: 0.45, importance: 0.20 },
}

/** Classify query for adaptive signal weighting. Priority: temporal > lookup > frequentist > semantic. */
export function classifyQuery(query: string): QueryArchetype {
  if (TEMPORAL_RE.test(query)) return 'temporal'
  if (LOOKUP_RE.test(query)) return 'lookup'
  if (FREQUENTIST_RE.test(query)) return 'frequentist'
  return 'semantic'
}

export type SignalKey = 'fts' | 'vec' | 'recency' | 'access' | 'importance' | 'reranker'
