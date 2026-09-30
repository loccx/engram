// context assembly: the single read path. one call composes the working briefs, the
// current state heads, the fused memory channel and the summary layer into named
// sections under one character budget, and reports what it dropped, truncated or
// deduped. a recipe is data — sections with a share and a limit, plus channel and
// reranker overrides — so contributing one is a registry entry and a test. reads are
// deterministic and side-effect free: nothing here stamps access counts, refreshes a
// digest or generates text, and every channel that fails or cannot run is named in
// `degraded` rather than served as a silent empty section.
import type Database from 'better-sqlite3'
import { brief } from '../tasks/brief.js'
import { allocationForQuery, type RecipeAllocation } from './allocation.js'
import { episodeVectorsAvailable, unembeddedEpisodeCount } from './episodes.js'
import { retrieveEpisodeContext, EPISODE_RENDER_WINDOW } from './episode-context.js'
import { listOpenTasks } from '../tasks/store.js'
import {
  packRecall,
  recallChannel,
  recallSummaries,
  type RecallChannelResult,
  type RecallMode,
  type RecallOptions,
  type RecallResult,
} from './recall.js'
import type { MemorySearch } from './search.js'
import type { MemoryStore } from './store.js'
import { currentState } from './state.js'

export type SectionKind = 'working' | 'state' | 'evidence' | 'memories' | 'summaries'

export interface AssembleItem {
  id: string
  text: string
  score?: number
  /** the fused signal breakdown behind `score` */
  components?: Record<string, number>
  /** ids of the rows this text was built from; the evidence channel fills them */
  evidence?: string[]
  /** one line saying why the item is in this section */
  why: string
  /** true when `text` is a prefix of the item's full text */
  truncated?: boolean
}

export interface AssembleSection {
  kind: SectionKind
  title: string
  items: AssembleItem[]
}

export interface SectionAccounting {
  used: number
  items: number
  dropped: number
  truncated: number
  deduped: number
}

export interface AssembleAccounting {
  budget: number
  used: number
  /** by section title, in assembly order */
  perSection: Record<string, SectionAccounting>
  dropped: number
  truncated: number
  /** duplicates: the channel's by-id and near-duplicate suppression plus cross-section repeats */
  deduped: number
}

export interface AssembleLayer {
  namespace: string
  action: 'searched' | 'skipped'
  hits: number
}

export interface AssembleDegraded {
  signal: string
  reason: string
}

export interface AssembleResult {
  sections: AssembleSection[]
  accounting: AssembleAccounting
  trace: { channels: SectionKind[]; layers: AssembleLayer[] }
  degraded: AssembleDegraded[]
  /**
   * the packed payload recall_context has always returned, present for the `default`
   * recipe: that recipe is the name of the contract, so it carries its bytes unchanged.
   */
  legacy?: RecallResult
}

export interface RecipeSection {
  kind: SectionKind
  title: string
  /** share of the character budget; sections pack in recipe order */
  budgetShare: number
  limit: number
  /** how the evidence section spends its room on turns: a policy per query archetype */
  allocation?: RecipeAllocation
}

/**
 * the search core exposes channel toggles and the reranker blend weight, not
 * per-channel weights, so a recipe overrides what the channel can honor today.
 */
export interface RecipeChannels {
  /** memories_ident_fts as one more fused list */
  ident?: boolean
  /** memory_entity_fts as one more fused list */
  entity?: boolean
  /** deterministic offline query-expansion variants */
  expand?: boolean
}

export interface RecipeReranker {
  mode: 'none' | 'blend'
  /** blend weight for the reranked window */
  alpha?: number
  topN?: number
}

export interface Recipe {
  name: string
  description: string
  sections: RecipeSection[]
  channels?: RecipeChannels
  reranker?: RecipeReranker
  /** absolute floor on the fused score (SearchOptions.min_score) */
  minRelevance?: number
  /** candidate cap handed to the retrieval channel */
  maxCandidates?: number
  /**
   * unused room flows to later sections, then back to any that dropped or clipped, so a
   * store with no episodes or no memories still fills the budget. off by default: the
   * default recipe's bytes are pinned to recall_context
   */
  carryUnused?: boolean
}

export const DEFAULT_RECIPE_NAME = 'default'
export const DEFAULT_ASSEMBLE_BUDGET_CHARS = 4000
/** mirror of the recall channel's own clamp */
const CANDIDATE_LIMIT_DEFAULT = 10
const CANDIDATE_LIMIT_MAX = 100
/** episode candidates the evidence section ranks before it packs the timeline */
const EVIDENCE_CANDIDATES = 100
/** same preview rule as the legacy state section: a head is a short present-state value */
const STATE_PREVIEW_CHARS = 160
/** below this room an item is dropped instead of clipped to a stub, as in the recall packer */
const SECTION_MIN_TRUNCATION_CHARS = 16

export const RECIPES: Record<string, Recipe> = {
  default: {
    name: DEFAULT_RECIPE_NAME,
    // the sections are this recipe's view of the channel; `legacy` is the same channel
    // through the recall packer, which reserves the digest share before the memories
    description: 'the recall_context contract: ranked memories plus the digest and topic summaries',
    sections: [
      { kind: 'memories', title: 'memories', budgetShare: 0.6, limit: 10 },
      { kind: 'summaries', title: 'summaries', budgetShare: 0.4, limit: 8 },
    ],
  },
  'session-priming': {
    name: 'session-priming',
    description:
      'what a session needs on the way in: the working brief and current state first, then the summaries and the memories behind them',
    sections: [
      { kind: 'working', title: 'working', budgetShare: 0.3, limit: 2 },
      { kind: 'state', title: 'state', budgetShare: 0.2, limit: 5 },
      { kind: 'summaries', title: 'summaries', budgetShare: 0.25, limit: 6 },
      { kind: 'memories', title: 'memories', budgetShare: 0.25, limit: 6 },
    ],
  },
  qa: {
    name: 'qa',
    description:
      'question answering: the raw turns carry the budget, a few memories ride beside them, and anything left returns to whichever section can use it',
    sections: [
      // turn-level evidence answers the temporal, update and multi-session questions that
      // whole-session memories miss, and it needs breadth across sessions, so it takes
      // nearly all the room; curated memories keep a small share beside it
      {
        kind: 'evidence',
        title: 'evidence',
        budgetShare: 0.9,
        limit: 12,
        allocation: { default: { policy: 'rank-greedy' } },
      },
      { kind: 'memories', title: 'memories', budgetShare: 0.1, limit: 12 },
      { kind: 'summaries', title: 'summaries', budgetShare: 0, limit: 4 },
    ],
    maxCandidates: 25,
    carryUnused: true,
  },
}

export function recipeNames(): string[] {
  return Object.keys(RECIPES)
}

export function recipeOf(name?: string): Recipe {
  const key = name ?? DEFAULT_RECIPE_NAME
  const recipe = RECIPES[key]
  if (!recipe) {
    throw new Error(`engram: unknown recipe "${key}"; known: ${recipeNames().join(', ')}`)
  }
  return recipe
}

export interface AssembleQuota {
  budgetShare?: number
  limit?: number
}

export interface AssembleOptions {
  /** the namespace to read: one scope, no ancestor funnel */
  scope: string
  query?: string
  budgetChars: number
  recipe?: string
  /** per-kind overrides of the recipe's shares and limits */
  quotas?: Partial<Record<SectionKind, AssembleQuota>>
  asOf?: number
  sessionId?: string
  /** pin the working section to one open task */
  taskId?: string
  /** routing knobs the recall_context contract carries through */
  mode?: RecallMode
  seedId?: string
  limit?: number
  minTrust?: number
  now?: number
}

export interface ProducerInput {
  db: Database.Database
  search: MemorySearch
  scope: string
  spec: RecipeSection
  /** the section's room, for a producer that renders to a budget itself */
  sectionChars: number
  channel: RecallChannelResult | null
  options: AssembleOptions
}

export interface ProducerOutput {
  items: AssembleItem[]
  /** candidates the producer left out before packing */
  dropped: number
  /** why this channel could not run */
  skipped?: string
  /** the channel ran, but weaker than intended; the caller must see why (no silent downgrade) */
  degraded?: string[]
}

/** a producer may await (the evidence section ranks episodes with the embedder) */
export type SectionProducer = (input: ProducerInput) => ProducerOutput | Promise<ProducerOutput>

function fusedOutput(channel: RecallChannelResult | null): ProducerOutput {
  // a channel that did not run is already named in degraded, so the section stays empty
  // without repeating the reason under every kind that reads it
  if (!channel) return { items: [], dropped: 0 }
  const items = channel.memories.map((memory, index) => ({
    id: memory.id,
    text: memory.content,
    ...(memory.score !== undefined ? { score: memory.score } : {}),
    ...(memory.signal_breakdown ? { components: memory.signal_breakdown } : {}),
    why: memory.pinned === true ? `fused rank ${index + 1} (pinned)` : `fused rank ${index + 1}`,
  }))
  return { items, dropped: 0 }
}

/**
 * the section producers. evidence reads the episode layer: the hits grouped by session,
 * each group dated, the timeline served oldest first under the section's room, with the
 * episode ids of every served line kept on the item.
 */
export const SECTION_PRODUCERS = {
  working: ({ db, scope, spec, sectionChars, options }: ProducerInput): ProducerOutput => {
    if (options.asOf !== undefined) {
      return { items: [], dropped: 0, skipped: 'as_of read: task briefs are present state' }
    }
    const tasks = listOpenTasks(db, scope, {
      limit: options.taskId ? 50 : Math.max(spec.limit, 1),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    })
    const selected = options.taskId ? tasks.filter((task) => task.id === options.taskId) : tasks
    if (options.taskId && selected.length === 0) {
      return { items: [], dropped: 0, skipped: `no open task ${options.taskId} in ${scope}` }
    }
    const perTask = Math.max(0, Math.floor(sectionChars / Math.max(1, selected.length)))
    const items: AssembleItem[] = []
    let dropped = tasks.length - selected.length
    for (const task of selected) {
      const text = brief(task, perTask).text
      if (text === '') {
        dropped++
        continue
      }
      items.push({ id: task.id, text, why: 'open task brief' })
    }
    return { items, dropped }
  },
  state: ({ db, scope, spec, options }: ProducerInput): ProducerOutput => {
    const slots = currentState(db, scope, {
      limit: Math.max(spec.limit, 1),
      ...(options.asOf !== undefined ? { asOf: options.asOf } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    })
    const items: AssembleItem[] = []
    let dropped = 0
    for (const slot of slots) {
      const head = slot.current
      if (!head) {
        dropped++
        continue
      }
      const clipped = head.content.length > STATE_PREVIEW_CHARS
      items.push({
        id: head.memory_id,
        text: `${slot.key}: ${clipped ? `${head.content.slice(0, STATE_PREVIEW_CHARS - 1)}…` : head.content}`,
        why: 'current state head',
        ...(clipped ? { truncated: true } : {}),
      })
    }
    return { items, dropped }
  },
  memories: ({ channel }: ProducerInput): ProducerOutput => fusedOutput(channel),
  evidence: async ({ db, scope, spec, sectionChars, options }: ProducerInput): Promise<ProducerOutput> => {
    const query = (options.query ?? '').trim()
    if (query === '') {
      return { items: [], dropped: 0, skipped: 'no query: the episode channel did not run' }
    }
    if (options.asOf !== undefined) {
      // an episode is evidence of what was said, not of what is true at an instant
      return { items: [], dropped: 0, skipped: 'as_of read: episodes carry no validity window' }
    }
    const allocation =
      spec.allocation === undefined ? undefined : allocationForQuery(spec.allocation, query)
    const found = await retrieveEpisodeContext({
      db,
      query,
      namespace: scope,
      budget_chars: sectionChars,
      candidates: EVIDENCE_CANDIDATES,
      ingest_window: 1,
      render_window: EPISODE_RENDER_WINDOW,
      now: options.now ?? Date.now(),
      vectorsAvailable: episodeVectorsAvailable(db),
      ...(allocation !== undefined ? { allocation: allocation.policy } : {}),
      ...(allocation !== undefined ? { reserve_top_hits: allocation.reserveTopHits } : {}),
    })
    const items: AssembleItem[] = found.blocks.map((text, block) => {
      const lines = found.lines.filter((line) => line.block === block)
      const session = lines[0]?.session_id ?? `block-${block}`
      return {
        id: `episode-session:${session}`,
        text,
        evidence: lines.map((line) => line.episode_id),
        why: `dated session group of ${lines.length} turn(s), ${lines[0]?.date ?? 'undated'}`,
      }
    })
    const dropped = spec.limit > 0 && items.length > spec.limit ? items.length - spec.limit : 0
    // a deferred ingest leaves episodes without vectors; the section still serves them
    // lexically, and naming that here is what keeps the result from looking complete
    const unembedded = unembeddedEpisodeCount(db, { namespace: scope })
    return {
      items,
      dropped: found.skippedSessions + dropped,
      ...(unembedded > 0
        ? {
            degraded: [
              `${unembedded} episode(s) in scope have no vector yet (deferred ingest or a pending re-embed): the evidence section ranked them lexically`,
            ],
          }
        : {}),
    }
  },
  summaries: ({ db, search, scope, options }: ProducerInput): ProducerOutput => {
    const summaries = recallSummaries(db, scope, search.getClusters(scope), {
      ...(options.asOf !== undefined ? { asOf: options.asOf } : {}),
    })
    const items: AssembleItem[] = []
    let dropped = 0
    if (summaries.digest !== null && summaries.digest !== '') {
      items.push({ id: 'digest', text: summaries.digest, why: 'namespace digest of pinned facts' })
    }
    for (const topic of summaries.topics) {
      if (topic.summary === null || topic.summary === '') {
        dropped++
        continue
      }
      items.push({
        id: `topic:${topic.id}`,
        text: topic.summary,
        why: `cluster summary over ${topic.member_count} memories`,
      })
    }
    return { items, dropped }
  },
} satisfies Record<SectionKind, SectionProducer>

interface PackedSection {
  items: AssembleItem[]
  used: number
  dropped: number
  truncated: number
  deduped: number
}

/**
 * pack one section into its room: an item is served whole, or clipped once with the
 * ellipsis charged to the budget and marked truncated, or dropped. an id already
 * served by an earlier section is deduped instead of repeated.
 */
function packSection(
  items: AssembleItem[],
  limit: number,
  budgetChars: number,
  served: Set<string>
): PackedSection {
  const kept: AssembleItem[] = []
  let used = 0
  let dropped = 0
  let truncated = 0
  let deduped = 0
  let remaining = Math.max(0, budgetChars)
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (index >= limit) {
      dropped++
      continue
    }
    if (served.has(item.id)) {
      deduped++
      continue
    }
    const length = item.text.length
    if (length <= remaining) {
      kept.push(item)
      served.add(item.id)
      remaining -= length
      used += length
      if (item.truncated === true) truncated++
      continue
    }
    if (remaining > SECTION_MIN_TRUNCATION_CHARS) {
      kept.push({ ...item, text: `${item.text.slice(0, remaining - 1)}…`, truncated: true })
      served.add(item.id)
      used += remaining
      truncated++
      remaining = 0
      continue
    }
    dropped++
  }
  return { items: kept, used, dropped, truncated, deduped }
}

/**
 * sections whose producer packs to the room it is handed, so a larger room means asking
 * the producer again rather than re-packing what it already returned
 */
const SELF_PACKING: ReadonlySet<SectionKind> = new Set<SectionKind>(['evidence'])

/** a caller quota replaces the recipe's share and limit for that kind */
function sectionsFor(recipe: Recipe, quotas?: AssembleOptions['quotas']): RecipeSection[] {
  return recipe.sections.map((section) => {
    const quota = quotas?.[section.kind]
    if (!quota) return section
    return {
      ...section,
      ...(quota.budgetShare !== undefined ? { budgetShare: quota.budgetShare } : {}),
      ...(quota.limit !== undefined ? { limit: quota.limit } : {}),
    }
  })
}

function channelOptionsFor(
  recipe: Recipe,
  options: AssembleOptions,
  budget: number,
  limit: number,
  query: string
): RecallOptions {
  const search: NonNullable<RecallOptions['search']> = {}
  if (recipe.channels?.ident === true) search.ident_channel = true
  if (recipe.channels?.entity === true) search.entity_channel = true
  if (recipe.channels?.expand === true) search.expand = true
  if (recipe.reranker?.mode === 'blend') {
    search.use_reranker = true
    if (recipe.reranker.topN !== undefined) search.rerank_top_n = recipe.reranker.topN
    if (recipe.reranker.alpha !== undefined) search.rerank_blend_alpha = recipe.reranker.alpha
  }
  if (recipe.minRelevance !== undefined) search.min_score = recipe.minRelevance
  return {
    query,
    project_path: options.scope,
    budget_chars: budget,
    mode: options.mode ?? 'fused',
    limit,
    min_trust: options.minTrust,
    ...(options.seedId !== undefined ? { seed_id: options.seedId } : {}),
    ...(options.asOf !== undefined ? { as_of: options.asOf } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(Object.keys(search).length > 0 ? { search } : {}),
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * assemble one scope: run the channels a recipe asks for, pack each section in recipe
 * order, and account for what the budget did.
 */
export async function assemble(
  db: Database.Database,
  store: MemoryStore,
  search: MemorySearch,
  options: AssembleOptions
): Promise<AssembleResult> {
  const recipe = recipeOf(options.recipe)
  const sections = sectionsFor(recipe, options.quotas)
  const budget = Math.max(0, Math.floor(options.budgetChars))
  const query = (options.query ?? '').trim()
  const channelLimit = Math.min(
    Math.max(options.limit ?? recipe.maxCandidates ?? CANDIDATE_LIMIT_DEFAULT, 1),
    CANDIDATE_LIMIT_MAX
  )
  const needsChannel = sections.some(
    (section) => section.kind === 'memories' || section.kind === 'evidence'
  )
  const channelOptions = channelOptionsFor(recipe, options, budget, channelLimit, query)

  const degraded: AssembleDegraded[] = []
  const channels: SectionKind[] = []
  let channel: RecallChannelResult | null = null
  if (needsChannel) {
    if (query === '') {
      degraded.push({ signal: 'memories', reason: 'no query: the fused memory channel did not run' })
    } else {
      try {
        channel = await recallChannel(db, store, search, channelOptions)
        for (const reason of channel.degraded) degraded.push({ signal: 'memories', reason })
      } catch (error) {
        degraded.push({ signal: 'memories', reason: reasonOf(error) })
      }
    }
  }
  const legacy =
    recipe.name === DEFAULT_RECIPE_NAME && channel !== null
      ? packRecall(channel, channelOptions)
      : undefined

  const assembled: AssembleSection[] = []
  const perSection: Record<string, SectionAccounting> = {}
  const served = new Set<string>()
  let remaining = budget
  let used = 0
  let dropped = 0
  let truncated = 0
  let deduped = channel ? channel.duplicate_ids + channel.near_duplicates : 0

  let allotted = 0
  const produced: Array<{ spec: RecipeSection; items: AssembleItem[]; producerDropped: number }> = []
  for (const spec of sections) {
    const share = Math.max(0, Math.floor(budget * spec.budgetShare))
    const carried = recipe.carryUnused ? Math.max(0, allotted - used) : 0
    allotted += share
    const sectionChars = Math.min(share + carried, Math.max(0, remaining))
    let output: ProducerOutput
    let failed = false
    try {
      output = await SECTION_PRODUCERS[spec.kind]({
        db,
        search,
        scope: options.scope,
        spec,
        sectionChars,
        channel,
        options,
      })
    } catch (error) {
      output = { items: [], dropped: 0 }
      failed = true
      degraded.push({ signal: spec.kind, reason: reasonOf(error) })
    }
    if (output.skipped) degraded.push({ signal: spec.kind, reason: output.skipped })
    for (const reason of output.degraded ?? []) degraded.push({ signal: spec.kind, reason })
    if (!failed && !output.skipped) channels.push(spec.kind)

    const packed = packSection(output.items, Math.max(spec.limit, 0), sectionChars, served)
    const sectionDropped = output.dropped + packed.dropped
    produced.push({ spec, items: output.items, producerDropped: output.dropped })
    assembled.push({ kind: spec.kind, title: spec.title, items: packed.items })
    perSection[spec.title] = {
      used: packed.used,
      items: packed.items.length,
      dropped: sectionDropped,
      truncated: packed.truncated,
      deduped: packed.deduped,
    }
    used += packed.used
    remaining -= packed.used
    dropped += sectionDropped
    truncated += packed.truncated
    deduped += packed.deduped
  }

  // the forward pass only carries room to later sections, so what is still left goes back
  // to any section that had to drop or clip, or that packs itself, in recipe order and
  // deduped against the others
  if (recipe.carryUnused && remaining > 0) {
    for (let index = 0; index < produced.length && remaining > 0; index++) {
      const entry = produced[index]
      const before = perSection[entry.spec.title]
      const selfPacked = SELF_PACKING.has(entry.spec.kind)
      if (!selfPacked && before.dropped === entry.producerDropped && before.truncated === 0) continue
      const room = before.used + remaining
      const others = new Set(
        assembled.flatMap((section, at) => (at === index ? [] : section.items.map((item) => item.id)))
      )
      let items = entry.items
      let producerDropped = entry.producerDropped
      if (selfPacked) {
        try {
          const again = await SECTION_PRODUCERS[entry.spec.kind]({
            db,
            search,
            scope: options.scope,
            spec: entry.spec,
            sectionChars: room,
            channel,
            options,
          })
          items = again.items
          producerDropped = again.dropped
        } catch {
          continue
        }
      }
      const repacked = packSection(items, Math.max(entry.spec.limit, 0), room, others)
      if (repacked.used <= before.used) continue
      const sectionDropped = producerDropped + repacked.dropped
      remaining -= repacked.used - before.used
      used += repacked.used - before.used
      dropped += sectionDropped - before.dropped
      truncated += repacked.truncated - before.truncated
      deduped += repacked.deduped - before.deduped
      assembled[index] = { ...assembled[index], items: repacked.items }
      perSection[entry.spec.title] = {
        used: repacked.used,
        items: repacked.items.length,
        dropped: sectionDropped,
        truncated: repacked.truncated,
        deduped: repacked.deduped,
      }
    }
  }

  return {
    sections: assembled,
    accounting: { budget, used, perSection, dropped, truncated, deduped },
    trace: {
      channels,
      layers: needsChannel
        ? [
            {
              namespace: options.scope,
              action: channel === null ? 'skipped' : 'searched',
              hits: channel?.memories.length ?? 0,
            },
          ]
        : [],
    },
    degraded,
    ...(legacy ? { legacy } : {}),
  }
}

/** recall_context's contract: assemble under the default recipe and return its legacy view */
export async function recallViaAssemble(
  db: Database.Database,
  store: MemoryStore,
  search: MemorySearch,
  options: RecallOptions
): Promise<RecallResult> {
  const assembled = await assemble(db, store, search, {
    scope: options.project_path,
    query: options.query,
    budgetChars: options.budget_chars,
    recipe: DEFAULT_RECIPE_NAME,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.seed_id !== undefined ? { seedId: options.seed_id } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.min_trust !== undefined ? { minTrust: options.min_trust } : {}),
    ...(options.as_of !== undefined ? { asOf: options.as_of } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
  if (!assembled.legacy) {
    // the channel failed: keep the reason the old direct call would have thrown
    const failure = assembled.degraded.find((entry) => entry.signal === 'memories')
    throw new Error(failure?.reason ?? 'engram: the default recipe must carry the legacy recall payload')
  }
  return assembled.legacy
}
