// recall_context: composes digest, topics, hybrid, entity and ppr graph walks
// behind one character budget. read-only (no touch, no digest refresh, no llm),
// so the same inputs give the same payload; the budget charges content, never
// json overhead; an as_of recall omits the cached digest and cluster summaries,
// which are present state and cannot be reconstructed at a past instant.
import type Database from 'better-sqlite3'
import type { MemoryCluster } from './types.js'
import { type SearchOptions, type SearchDiagnostics } from './search/hybrid.js'
import { validityAtClause } from '../contradictions/supersession.js'
import {
  compositeScore,
  enrichMemories,
  type EnrichedMemory,
  type RecallSignal,
} from './enrichment.js'
import type { MemoryStore } from './store.js'
import type { MemorySearch } from './search.js'
import type { SearchResult } from './types.js'
import { getDigest } from './digest.js'
import { namespaceFilter } from './search/scope.js'
import { currentCaller, holdsVerb } from './access.js'

export type RecallMode = 'fused' | 'hybrid' | 'graph' | 'entity'
export type RecallSource = 'hybrid' | 'entity' | 'graph'

export interface RecallOptions {
  query: string
  project_path: string
  /** content characters only; transport overhead is not charged */
  budget_chars: number
  mode?: RecallMode
  /** graph mode: the memory id to walk from */
  seed_id?: string
  limit?: number
  /** composite trust floor; pinned memories bypass it */
  min_trust?: number
  as_of?: number
  /** fixed clock, for deterministic scores in tests */
  now?: number
  /**
   * extra channel knobs for a retrieval recipe: only the fields a recipe may set, so a
   * caller cannot turn access stamping back on or retarget the scope
   */
  search?: Partial<
    Pick<
      SearchOptions,
      | 'ident_channel'
      | 'entity_channel'
      | 'expand'
      | 'use_reranker'
      | 'rerank_top_n'
      | 'rerank_blend_alpha'
      | 'min_score'
    >
  >
}

export interface RecallMemory extends EnrichedMemory {
  source: RecallSource
  score?: number
  /** evidence share of `score`, priors excluded (hybrid source only) */
  relevance?: number
  signal_breakdown?: Record<RecallSignal, number>
  recall_reason?: RecallSignal
  handles: {
    get_memory: { id: string }
    get_related: { id: string; depth: number }
  }
}

export interface RecallTopic {
  id: number
  /** null in an as_of recall: the summary is present state */
  summary: string | null
  /** sampled ids; drill down with get_memory */
  member_ids: string[]
  /** full count, not the sample size */
  member_count: number
}

export interface RecallResult {
  namespace: string
  mode: RecallMode
  as_of?: number
  /** null in an as_of recall: the cached digest is present state */
  digest: string | null
  /** what an as_of recall had to leave out */
  as_of_limitations?: {
    digest_omitted: boolean
    topic_summaries_omitted: boolean
  }
  memories: RecallMemory[]
  topics: RecallTopic[]
  budget: {
    total_chars: number
    used_chars: number
    per_section: { digest: number; memories: number; topics: number }
  }
  dropped: {
    memories: number
    topics: number
    digest_chars_cut: number
    /** removed by min_trust, before dedupe and packing */
    trust_filtered: number
    /** dropped as a near-duplicate of a kept sibling */
    near_duplicates: number
  }
  truncated: { digest: boolean; memories: number; topics: number }
  /** failed retrieval branches: an empty `memories` alone cannot show an outage */
  degraded?: string[]
}

export const DIGEST_BUDGET_SHARE = 0.4
/** the full-budget share starves a small budget, so this one is lower */
export const DIGEST_SMALL_BUDGET_SHARE = 0.1
export const DIGEST_SMALL_BUDGET_CHARS = 1000
export const DIGEST_FULL_SHARE_BUDGET_CHARS = 4000
const NEAR_DUPLICATE_SIMILARITY = 0.95
/** per-topic member ids exposed in recall payloads */
const TOPIC_MEMBER_SAMPLE = 5
/** minimum chars worth keeping for a truncated topic summary */
const TOPIC_MIN_CHARS = 24
const MEMORY_MIN_TRUNCATION_CHARS = 16

export function digestShare(budgetChars: number): number {
  if (budgetChars >= DIGEST_FULL_SHARE_BUDGET_CHARS) return DIGEST_BUDGET_SHARE
  if (budgetChars <= DIGEST_SMALL_BUDGET_CHARS) return DIGEST_SMALL_BUDGET_SHARE
  const t =
    (budgetChars - DIGEST_SMALL_BUDGET_CHARS) /
    (DIGEST_FULL_SHARE_BUDGET_CHARS - DIGEST_SMALL_BUDGET_CHARS)
  return DIGEST_SMALL_BUDGET_SHARE + t * (DIGEST_BUDGET_SHARE - DIGEST_SMALL_BUDGET_SHARE)
}

// min(digest length, cap): a short digest hands its unused reservation back
export function digestReserve(budgetChars: number, digestLen: number): number {
  const cap = Math.max(0, Math.floor(budgetChars * digestShare(budgetChars)))
  return Math.min(digestLen, cap)
}

export interface RecallChannelResult {
  namespace: string
  mode: RecallMode
  as_of?: number
  /** null in an as_of read: the cached digest is present state */
  digest: string | null
  memories: RecallMemory[]
  topics: RecallTopic[]
  /** candidates the by-id dedupe dropped before enrichment */
  duplicate_ids: number
  /** removed by min_trust, before dedupe and packing */
  trust_filtered: number
  /** dropped as a near-duplicate of a kept sibling */
  near_duplicates: number
  /** failed retrieval branches: an empty `memories` alone cannot show an outage */
  degraded: string[]
}

/**
 * the retrieval channel without the budget: ranked, enriched, deduped candidates plus
 * the summary layer. read-only and repeatable, so a caller that assembles its own
 * sections can pack the same candidates into its own shares.
 */
export async function recallChannel(
  db: Database.Database,
  store: MemoryStore,
  search: MemorySearch,
  options: RecallOptions
): Promise<RecallChannelResult> {
  const now = options.now ?? Date.now()
  const mode: RecallMode = options.mode ?? 'fused'
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100)
  const asOf = options.as_of

  const searchOptions: SearchOptions = {
    project_path: options.project_path,
    limit,
    include_superseded: false,
    touch: false, // recall is read-only and repeatable
    now,
    ...options.search,
  }
  if (asOf !== undefined) searchOptions.as_of = asOf

  const breakdown = new Map<string, Record<RecallSignal, number>>()
  const diagnostics: SearchDiagnostics = { degraded: [] }
  let candidates: Array<{ memory: SearchResult; source: RecallSource }> = []

  if (mode === 'graph') {
    const seeds = options.seed_id ? [options.seed_id] : []
    const walked =
      seeds.length > 0
        ? search.pprSearch(seeds, limit, { project_path: options.project_path, include_superseded: false, as_of: asOf })
        : []
    candidates = walked.map((m) => ({
      memory: { ...m, score: m.similarity },
      source: 'graph' as RecallSource,
    }))
  } else if (mode === 'entity') {
    const found = store.searchByEntity(options.query, options.project_path, limit, {
      include_superseded: false,
      as_of: asOf,
    })
    candidates = found.map((m) => ({ memory: m as SearchResult, source: 'entity' as RecallSource }))
  } else {
    searchOptions.diagnostics = diagnostics
    const results = await search.hybridSearch(options.query, searchOptions, breakdown)
    candidates = results.map((m) => ({ memory: m, source: 'hybrid' as RecallSource }))
  }

  // each branch must enforce access before ranking; this final boundary also keeps a
  // stale or substituted channel from leaking a row through enrichment or handles.
  if (candidates.length > 0) {
    const scope = namespaceFilter('m', { project_path: options.project_path })
    const ids = [...new Set(candidates.map((c) => c.memory.id))]
    const allowed = new Set((db.prepare(
      `SELECT m.id FROM memories m WHERE m.id IN (${ids.map(() => '?').join(',')}) AND ${scope.sql}`
    ).all(...ids, ...scope.params) as Array<{ id: string }>).map((row) => row.id))
    candidates = candidates.filter((c) => allowed.has(c.memory.id))
  }

  const byId = new Map<string, { memory: SearchResult; source: RecallSource }>()
  for (const c of candidates) {
    if (!byId.has(c.memory.id)) byId.set(c.memory.id, c)
  }
  const deduped = [...byId.values()]

  // trust first, dedupe second: the passing sibling of a below-threshold
  // representative must survive
  const minTrust = options.min_trust ?? 0
  const baseMemories = deduped.map(({ memory }) => {
    const { score: _score, ...rest } = memory
    void _score
    return rest
  })
  const enrichedAll = enrichMemories(db, baseMemories, now, {
    project_path: options.project_path,
  })
  const trustedIdx: number[] = []
  let trustFiltered = 0
  for (let i = 0; i < enrichedAll.length; i++) {
    const em = enrichedAll[i]
    const pinned = em.pinned === true
    const trust = compositeScore(em, now)
    if (!pinned && minTrust > 0 && trust < minTrust) {
      trustFiltered++
      continue
    }
    trustedIdx.push(i)
  }
  const keepList = suppressNearDuplicates(db, trustedIdx.map((i) => deduped[i].memory.id))
  const keepOrder = new Map<string, number>()
  keepList.forEach((id, i) => keepOrder.set(id, i))
  const merged: RecallMemory[] = []
  let nearDuplicates = 0
  for (const i of trustedIdx) {
    const em = enrichedAll[i]
    const raw = deduped[i]
    if (!keepOrder.has(em.id)) {
      nearDuplicates++
      continue
    }
    const breakdownForId = breakdown.get(em.id)
    const recallReason = breakdownForId
      ? (Object.entries(breakdownForId).reduce((a, b) => (b[1] > a[1] ? b : a))[0] as RecallSignal)
      : undefined
    merged.push({
      ...em,
      source: raw.source,
      ...(raw.memory.score !== undefined ? { score: raw.memory.score } : {}),
      ...(raw.memory.relevance !== undefined ? { relevance: raw.memory.relevance } : {}),
      ...(breakdownForId
        ? { signal_breakdown: breakdownForId, recall_reason: recallReason }
        : {}),
      handles: {
        get_memory: { id: em.id },
        get_related: { id: em.id, depth: 1 },
      },
    })
  }
  merged.sort((a, b) => (keepOrder.get(a.id) ?? 0) - (keepOrder.get(b.id) ?? 0))

  const summaries = recallSummaries(db, options.project_path, search.getClusters(options.project_path), {
    ...(asOf !== undefined ? { asOf } : {}),
    memberIds: new Set(merged.map((memory) => memory.id)),
  })
  return {
    namespace: options.project_path,
    mode,
    ...(asOf !== undefined ? { as_of: asOf } : {}),
    digest: summaries.digest,
    memories: merged,
    topics: summaries.topics,
    duplicate_ids: candidates.length - deduped.length,
    trust_filtered: trustFiltered,
    near_duplicates: nearDuplicates,
    degraded: diagnostics.degraded,
  }
}

/**
 * the recall_context payload: pack a channel into the strict character budget. nothing
 * here reads the clock or the store, so the same channel gives the same bytes.
 */
export function packRecall(channel: RecallChannelResult, options: RecallOptions): RecallResult {
  const asOf = channel.as_of
  const packed = packWithinBudget({
    budget_chars: options.budget_chars,
    digest: channel.digest,
    memories: channel.memories,
    topics: channel.topics,
  })
  return {
    namespace: channel.namespace,
    mode: channel.mode,
    ...(asOf !== undefined
      ? {
          as_of: asOf,
          as_of_limitations: {
            digest_omitted: packed.digest === null,
            topic_summaries_omitted: true,
          },
        }
      : {}),
    ...packed,
    dropped: {
      ...packed.dropped,
      trust_filtered: channel.trust_filtered,
      near_duplicates: channel.near_duplicates,
    },
    ...(channel.degraded.length > 0 ? { degraded: channel.degraded } : {}),
  }
}

/** recall_context: one recipe's worth of the read path, packed to its character budget */
export async function recallContext(
  db: Database.Database,
  store: MemoryStore,
  search: MemorySearch,
  options: RecallOptions
): Promise<RecallResult> {
  return packRecall(await recallChannel(db, store, search, options), options)
}

/**
 * drop a candidate that has a >= 0.95 similarity edge to an already-kept,
 * higher-ranked one; cheaper than mmr and deterministic
 */
function suppressNearDuplicates(db: Database.Database, ids: string[]): string[] {
  if (ids.length < 2) return ids
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT source_id, target_id FROM memory_links
       WHERE similarity >= ?
         AND source_id IN (${placeholders})
         AND target_id IN (${placeholders})`
    )
    .all(NEAR_DUPLICATE_SIMILARITY, ...ids, ...ids) as Array<{
      source_id: string
      target_id: string
    }>
  const pairs = new Set<string>()
  for (const r of rows) {
    const a = r.source_id < r.target_id ? r.source_id : r.target_id
    const b = r.source_id < r.target_id ? r.target_id : r.source_id
    pairs.add(`${a}|${b}`)
  }
  const kept: string[] = []
  for (const id of ids) {
    let duplicate = false
    for (const keptId of kept) {
      const a = id < keptId ? id : keptId
      const b = id < keptId ? keptId : id
      if (pairs.has(`${a}|${b}`)) {
        duplicate = true
        break
      }
    }
    if (!duplicate) kept.push(id)
  }
  return kept
}

export interface RecallSummaries {
  /** null in an as_of read: the cached digest is present state */
  digest: string | null
  topics: RecallTopic[]
}

/**
 * the present-state summary layer: the namespace digest plus its cluster summaries.
 * pass `memberIds` to keep only recalled members in a topic's sample.
 */
export function recallSummaries(
  db: Database.Database,
  namespace: string,
  clusters: MemoryCluster[],
  options: { asOf?: number; memberIds?: Set<string> } = {}
): RecallSummaries {
  const asOf = options.asOf
  if (!holdsVerb(currentCaller(), namespace, 'read')) return { digest: null, topics: [] }
  return {
    digest: asOf === undefined ? getDigest(db, namespace) : null,
    topics: buildTopics(db, namespace, clusters, asOf, options.memberIds),
  }
}

/**
 * as_of recalls keep only members valid then, and drop the summary — cluster
 * text is present state, not something that held at as_of
 */
function buildTopics(
  db: Database.Database,
  namespace: string,
  clusters: MemoryCluster[],
  asOf: number | undefined,
  recallIds: Set<string> | undefined
): RecallTopic[] {
  const out: RecallTopic[] = []
  const scope = namespaceFilter('memories', { project_path: namespace })
  for (const c of clusters) {
    if (c.project_path !== namespace) continue
    let memberIds = c.member_ids
    if (memberIds.length > 0) {
      const placeholders = memberIds.map(() => '?').join(',')
      const readable = new Set((db.prepare(
        `SELECT id FROM memories WHERE id IN (${placeholders}) AND ${scope.sql}`
      ).all(...memberIds, ...scope.params) as Array<{ id: string }>).map((row) => row.id))
      // a summary is derived text, not a filterable list of facts; a forged foreign
      // member withholds the topic instead of exposing its id, text, or full count.
      if (memberIds.some((id) => !readable.has(id))) continue
    }
    if (asOf !== undefined && memberIds.length > 0) {
      const placeholders = memberIds.map(() => '?').join(',')
      const validRows = db
        .prepare(
          `SELECT id FROM memories WHERE id IN (${placeholders}) AND ${validityAtClause('memories', '?')}`
        )
        .all(...memberIds, asOf, asOf) as Array<{ id: string }>
      const valid = new Set(validRows.map((r) => r.id))
      memberIds = memberIds.filter((id) => valid.has(id))
    }
    out.push({
      id: c.id,
      summary: asOf === undefined ? c.summary : null,
      member_ids: memberIds
        .filter((id) => recallIds === undefined || recallIds.has(id))
        .slice(0, TOPIC_MEMBER_SAMPLE),
      member_count: memberIds.length,
    })
  }
  return out
}

export interface RecallBudget {
  total_chars: number
  used_chars: number
  per_section: { digest: number; memories: number; topics: number }
}

export interface BudgetPacking<TMem, TTopic> {
  digest: string | null
  memories: TMem[]
  topics: TTopic[]
  budget: RecallBudget
  dropped: { memories: number; topics: number; digest_chars_cut: number }
  truncated: { digest: boolean; memories: number; topics: number }
}

export interface BudgetPackingInput<TMem, TTopic> {
  budget_chars: number
  digest: string | null
  memories: TMem[]
  topics: TTopic[]
  /** memories charge content length and truncate content by default */
  memorySize?: (memory: TMem) => number
  truncateMemory?: (memory: TMem, keep: number) => TMem
  /** topics charge summary length and truncate summary by default */
  topicSize?: (topic: TTopic) => number
  truncateTopic?: (topic: TTopic, keep: number) => TTopic
}

function defaultMemorySize<TMem>(memory: TMem): number {
  return (memory as { content?: string }).content?.length ?? 0
}

function defaultTruncateMemory<TMem>(memory: TMem, keep: number): TMem {
  const content = (memory as { content: string }).content
  return { ...(memory as object), content: `${content.slice(0, keep)}…` } as TMem
}

function defaultTopicSize<TTopic>(topic: TTopic): number {
  const summary = (topic as { summary?: string | null }).summary
  return summary === null || summary === undefined ? 0 : summary.length
}

function defaultTruncateTopic<TTopic>(topic: TTopic, keep: number): TTopic {
  const summary = ((topic as { summary: string }).summary ?? '').slice(0, keep)
  return { ...(topic as object), summary: `${summary}…` } as TTopic
}

/** digest, then memories, then topics; emitted characters are the budget unit */
export function packWithinBudget<TMem, TTopic>(
  input: BudgetPackingInput<TMem, TTopic>
): BudgetPacking<TMem, TTopic> {
  const budget = input.budget_chars
  const memorySize = input.memorySize ?? defaultMemorySize
  const truncateMemory = input.truncateMemory ?? defaultTruncateMemory
  const topicSize = input.topicSize ?? defaultTopicSize
  const truncateTopic = input.truncateTopic ?? defaultTruncateTopic

  let digestOut = input.digest
  let digestCut = 0
  let digestTruncated = false
  if (input.digest !== null) {
    const digestAlloc = digestReserve(budget, input.digest.length)
    if (input.digest.length > digestAlloc) {
      digestOut = `${input.digest.slice(0, digestAlloc)}…`
      // includes the char the ellipsis replaced, so the cut is not under-reported
      digestCut = input.digest.length - digestOut.length
      digestTruncated = true
    }
  }

  let remaining = budget - (digestOut === null ? 0 : digestOut.length)
  let memoryChars = 0
  const packedMemories: TMem[] = []
  let droppedMemories = 0
  let truncatedMemories = 0
  for (const m of input.memories) {
    const contentLen = memorySize(m)
    if (contentLen <= remaining) {
      packedMemories.push(m)
      remaining -= contentLen
      memoryChars += contentLen
    } else if (remaining > MEMORY_MIN_TRUNCATION_CHARS) {
      // one char is held back for the ellipsis so the total stays inside the budget
      const keep = remaining - 1
      packedMemories.push(truncateMemory(m, keep))
      remaining = 0
      memoryChars += keep + 1
      truncatedMemories++
    } else {
      droppedMemories++
    }
  }

  const topicBudget = remaining
  const packedTopics: TTopic[] = []
  let droppedTopics = 0
  let truncatedTopics = 0
  let topicChars = 0
  for (const t of input.topics) {
    const summaryLen = topicSize(t)
    const room = topicBudget - topicChars
    if (summaryLen <= room) {
      packedTopics.push(t)
      topicChars += summaryLen
    } else if (summaryLen > 0) {
      // same one-char reservation as the memory path, so the emitted summary is
      // exactly `room` characters
      const keep = room - 1
      if (keep >= TOPIC_MIN_CHARS) {
        packedTopics.push(truncateTopic(t, keep))
        topicChars += keep + 1
        truncatedTopics++
      } else {
        droppedTopics++
      }
    } else {
      droppedTopics++
    }
  }

  const digestLen = digestOut === null ? 0 : digestOut.length
  return {
    digest: digestOut,
    memories: packedMemories,
    topics: packedTopics,
    budget: {
      total_chars: budget,
      used_chars: digestLen + memoryChars + topicChars,
      per_section: { digest: digestLen, memories: memoryChars, topics: topicChars },
    },
    dropped: {
      memories: droppedMemories,
      topics: droppedTopics,
      digest_chars_cut: digestCut,
    },
    truncated: {
      digest: digestTruncated,
      memories: truncatedMemories,
      topics: truncatedTopics,
    },
  }
}


