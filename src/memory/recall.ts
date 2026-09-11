/**
 * Progressive recall tool backend (`recall_context`).
 *
 * Composes existing retrieval branches — digest, topics, hybrid search,
 * entity search, and PPR graph walk — behind a strict character budget with
 * deterministic dedupe/diversity and explicit truncation accounting.
 *
 * Contracts:
 * - Read-only: hybrid search runs with touch:false, no digest refresh, no LLM
 *   calls. Same (db state, now, query, opts) => identical payload.
 * - Budget: counts characters of digest text + memory content + topic
 *   summaries (the content an LLM actually reads), allocated in a fixed
 *   per-section order: digest first (hard reserve), then top-ranked memories,
 *   then topics. JSON transport overhead is not charged to the budget.
 * - as_of: forwarded to every branch that supports historical views. The
 *   cached digest and cluster summary text are present state, not
 *   reconstructable as-of, so historical recalls omit them (digest: null,
 *   topic summary: null) and flag the omission via as_of_limitations.
 * - Ordering: min_trust is applied BEFORE near-duplicate suppression so a
 *   passing sibling of a below-threshold representative is never lost.
 */
import type Database from 'better-sqlite3'
import type { MemoryCluster } from './types.js'
import { type SearchOptions } from './search/hybrid.js'
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

export type RecallMode = 'fused' | 'hybrid' | 'graph' | 'entity'
export type RecallSource = 'hybrid' | 'entity' | 'graph'

export interface RecallOptions {
  query: string
  project_path: string
  /** Strict character budget (content characters; see module docstring). */
  budget_chars: number
  mode?: RecallMode
  /** Graph mode only: memory id to walk from. */
  seed_id?: string
  limit?: number
  /** Minimum composite trust score (pinned memories bypass). */
  min_trust?: number
  as_of?: number
  /** Clock injection seam for deterministic scoring. */
  now?: number
}

export interface RecallMemory extends EnrichedMemory {
  source: RecallSource
  score?: number
  signal_breakdown?: Record<RecallSignal, number>
  recall_reason?: RecallSignal
  handles: {
    get_memory: { id: string }
    get_related: { id: string; depth: number }
  }
}

export interface RecallTopic {
  id: number
  /**
   * Cluster summary text. Null in historical (`as_of`) recalls: the summary
   * reflects present state and is not reconstructable as-of, so it is
   * omitted rather than injected as anachronistic knowledge.
   */
  summary: string | null
  /** Recall-related member ids, sampled; drill down via get_memory. */
  member_ids: string[]
  /** Total valid member count (not the sample). */
  member_count: number
}

export interface RecallResult {
  namespace: string
  mode: RecallMode
  as_of?: number
  /**
   * Pinned-fact digest. Null in historical (`as_of`) recalls because the
   * cached digest is present state and must not leak into a past snapshot.
   */
  digest: string | null
  /** Why historical recalls omit present-state sections. */
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
    /** Candidates removed by min_trust before dedupe/budget packing. */
    trust_filtered: number
    /** Candidates dropped as >= 0.95 near-duplicates of a kept sibling. */
    near_duplicates: number
  }
  truncated: { digest: boolean; memories: number; topics: number }
}

const DIGEST_BUDGET_SHARE = 0.4
const NEAR_DUPLICATE_SIMILARITY = 0.95
/** Per-topic member ids exposed in recall payloads. */
const TOPIC_MEMBER_SAMPLE = 5
/** Minimum chars worth keeping for a truncated topic summary. */
const TOPIC_MIN_CHARS = 24

export async function recallContext(
  db: Database.Database,
  store: MemoryStore,
  search: MemorySearch,
  options: RecallOptions
): Promise<RecallResult> {
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
  }
  if (asOf !== undefined) searchOptions.as_of = asOf

  // ---- retrieval branches -------------------------------------------------
  const breakdown = new Map<string, Record<RecallSignal, number>>()
  let candidates: Array<{ memory: SearchResult; source: RecallSource }> = []

  if (mode === 'graph') {
    const seeds = options.seed_id ? [options.seed_id] : []
    const walked =
      seeds.length > 0
        ? search.pprSearch(seeds, limit, { include_superseded: false, as_of: asOf })
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
    const results = await search.hybridSearch(options.query, searchOptions, breakdown)
    candidates = results.map((m) => ({ memory: m, source: 'hybrid' as RecallSource }))
  }

  // ---- deterministic dedupe + diversity ----------------------------------
  const byId = new Map<string, { memory: SearchResult; source: RecallSource }>()
  for (const c of candidates) {
    if (!byId.has(c.memory.id)) byId.set(c.memory.id, c)
  }
  const deduped = [...byId.values()]

  // ---- trust filter + enrichment -----------------------------------------
  // Trust is applied BEFORE near-duplicate suppression so that when the
  // higher-ranked representative of a duplicate pair fails min_trust, the
  // passing sibling is not discarded with it.
  const minTrust = options.min_trust ?? 0
  const baseMemories = deduped.map(({ memory }) => {
    const { score: _score, ...rest } = memory
    void _score
    return rest
  })
  const enrichedAll = enrichMemories(db, baseMemories, now)
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

  // ---- retrieval-extrinsic topic pass ------------------------------------
  const clusters = search.getClusters(options.project_path)
  const topics = buildTopics(db, clusters, asOf, merged)

  // ---- budget packing -----------------------------------------------------
  // Historical reads must not be fed present state: the cached digest is
  // omitted for as_of recalls (explicitly flagged in the payload).
  const digest = asOf === undefined ? getDigest(db, options.project_path) : null
  const packed = packBudget(options, merged, topics, digest)
  return {
    ...packed,
    dropped: { ...packed.dropped, trust_filtered: trustFiltered, near_duplicates: nearDuplicates },
  }
}

/**
 * Greedy near-duplicate suppression: drop a candidate when it has a
 * memory_links similarity >= 0.95 edge to any already-kept (higher-ranked)
 * candidate. Cheaper than MMR and fully deterministic.
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

/**
 * Topic member ids are filtered to facts valid at as_of (as applicable).
 * Cluster summary text reflects present state, so for historical recalls the
 * summary is omitted (null) rather than presented as if it held at as_of.
 */
function buildTopics(
  db: Database.Database,
  clusters: MemoryCluster[],
  asOf: number | undefined,
  recallMemories: RecallMemory[]
): RecallTopic[] {
  const recallIds = new Set(recallMemories.map((m) => m.id))
  const out: RecallTopic[] = []
  for (const c of clusters) {
    let memberIds = c.member_ids
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
      member_ids: memberIds.filter((id) => recallIds.has(id)).slice(0, TOPIC_MEMBER_SAMPLE),
      member_count: memberIds.length,
    })
  }
  return out
}

function packBudget(
  options: RecallOptions,
  memories: RecallMemory[],
  topics: RecallTopic[],
  digestFull: string | null
): RecallResult {
  const budget = options.budget_chars
  const projectPath = options.project_path
  const asOf = options.as_of

  const digestAlloc = Math.floor(budget * DIGEST_BUDGET_SHARE)
  let digestOut = digestFull
  let digestCut = 0
  let digestTruncated = false
  if (digestFull !== null && digestFull.length > digestAlloc) {
    digestOut = `${digestFull.slice(0, digestAlloc)}…`
    // Exact accounting: every character that did not make it into the
    // emitted digest (including the one replaced by '…').
    digestCut = digestFull.length - digestOut.length
    digestTruncated = true
  }

  let remaining = budget - (digestOut === null ? 0 : digestOut.length)
  let memoryChars = 0
  const packedMemories: RecallMemory[] = []
  let droppedMemories = 0
  let truncatedMemories = 0
  for (const m of memories) {
    const contentLen = m.content.length
    if (contentLen <= remaining) {
      packedMemories.push(m)
      remaining -= contentLen
      memoryChars += contentLen
    } else if (remaining > 16) {
      // Reserve one char for the truncation marker so totals never exceed
      // the budget.
      const keep = remaining - 1
      packedMemories.push({ ...m, content: `${m.content.slice(0, keep)}…` })
      remaining = 0
      memoryChars += keep + 1
      truncatedMemories++
    } else {
      droppedMemories++
    }
  }

  const topicBudget = remaining
  const packedTopics: RecallTopic[] = []
  let droppedTopics = 0
  let truncatedTopics = 0
  let topicChars = 0
  for (const t of topics) {
    const summaryLen = t.summary === null ? 0 : t.summary.length
    const room = topicBudget - topicChars
    if (summaryLen <= room) {
      packedTopics.push(t)
      topicChars += summaryLen
    } else if (t.summary !== null) {
      // Reserve one char for the truncation marker (mirrors the memory
      // path) so the emitted summary is exactly `room` chars and the
      // accounting never under-reports actual output.
      const keep = room - 1
      if (keep >= TOPIC_MIN_CHARS) {
        packedTopics.push({ ...t, summary: `${t.summary.slice(0, keep)}…` })
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
    namespace: projectPath,
    mode: options.mode ?? 'fused',
    ...(asOf !== undefined
      ? {
          as_of: asOf,
          as_of_limitations: {
            digest_omitted: digestOut === null,
            topic_summaries_omitted: asOf !== undefined,
          },
        }
      : {}),
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
      // Overridden by recallContext with the real counts.
      trust_filtered: 0,
      near_duplicates: 0,
    },
    truncated: {
      digest: digestTruncated,
      memories: truncatedMemories,
      topics: truncatedTopics,
    },
  }
}
