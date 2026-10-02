// continuity runner: the fixed controller. it streams the fixture's events through the
// real shipped write paths in chronological order, and answers each probe by reading the
// shipped read surface for the arm under test. it is deliberately not an llm: the same
// script runs for every arm, so what a case measures is whether the memory layer could
// serve the evidence a task needs — the contract — not whether a model used it well.
//
// the controller never receives the scorer's gold: `runContinuityArms` is handed
// `fixture` only. it also never changes history to make a case pass: the corpus clock
// is applied to rows the real write path stamped with wall time, exactly as
// eval/lib/harness.ts does for a seeded corpus.
import type Database from 'better-sqlite3'
import type { EvalHarness } from './harness.js'
import { parseToolResult } from './harness.js'
import { handleTool } from '../../src/mcp/handlers.js'
import { MemoryStore } from '../../src/memory/store.js'
import { recallContext, type RecallOptions } from '../../src/memory/recall.js'
import { getState } from '../../src/memory/state.js'
import { retrieveEpisodeContext } from '../../src/memory/episode-context.js'
import {
  citedEpisodes,
  countEpisodes,
  deleteEpisodes,
  ingestEpisodes,
  linkMemoryEpisode,
  type CitedEpisode,
} from '../../src/memory/episodes.js'
import {
  checkpointTask,
  createTask,
  listOpenTasks,
  updateTask,
} from '../../src/tasks/store.js'
import { handoff } from '../../src/tasks/brief.js'
import { applyDuplicatePrune, planDuplicatePrune } from '../../src/maintenance/prune.js'
import { unarchiveMemory } from '../../src/memory/cold-tier.js'
import { tokenCost, type TokenizerInfo } from './metrics.js'
import type { ContinuityArm, ContinuityEvent, ContinuityFixture, ContinuityProbe } from './continuity-corpus.js'

/** where a served row came from, so a leak can be judged against the checkpoint */
export interface ContinuityProvenance {
  seq: number
  at: number
  source: 'memory' | 'episode' | 'task' | 'task-summary'
}

export interface ContinuityLedger {
  /** db uuid -> the event that wrote it */
  provenance: Map<string, ContinuityProvenance>
  /** corpus-local id -> db uuid */
  localIds: Map<string, string>
  /** db uuid -> corpus-local id */
  corpusIds: Map<string, string>
  /** episode external id -> the row it landed in */
  episodeByExternal: Map<string, { id: string; seq: number; at: number }>
  /** fixture ingest op -> count: what seeding this arm's store cost */
  ingestOps: Record<string, number>
  /**
   * probe-side mutation -> count: an arm's own restore/sweep action, kept apart from
   * the seeding cost so an arm that mutates its store is visible in the report
   */
  probeOps: Record<string, number>
  /** `arm.op` -> count */
  readOps: Record<string, number>
  /** the running task's id, when the fixture has started one */
  taskId: string | null
  /** what the cold-tier event's prune plan archived */
  coldArchivedId: string | null
  coldPlanGroups: number
  /** wall-clock ingest samples per event id */
  ingestMs: Record<string, number>
  /** wall-clock probe samples per `arm.probe` */
  probeMs: Record<string, number>
}

export function createContinuityLedger(): ContinuityLedger {
  return {
    provenance: new Map(),
    localIds: new Map(),
    corpusIds: new Map(),
    episodeByExternal: new Map(),
    ingestOps: {},
    probeOps: {},
    readOps: {},
    taskId: null,
    coldArchivedId: null,
    coldPlanGroups: 0,
    ingestMs: {},
    probeMs: {},
  }
}

export interface ServedItem {
  id: string
  /** the corpus-local id or episode external id, when the fixture named one */
  local_id: string | null
  namespace: string
  content: string
  /** the event clock of the row, 0 when it is not fixture provenance */
  at: number
  /** the event that wrote it; -1 when it is not fixture provenance */
  seq: number
  source: string
}

export interface ContinuityBudgetRecord {
  budget_chars: number
  used_chars: number
  dropped_memories: number
  dropped_topics: number
  digest_chars_cut: number
  truncated_memories: number
  truncated_topics: number
}

export interface ContinuityRead {
  probe_id: string
  arm: ContinuityArm
  /** what the controller actually called */
  action: string
  /** the exact texts a reader would be handed */
  context: string[]
  served: ServedItem[]
  budget: ContinuityBudgetRecord | null
  state: { keys: string[]; current: string[]; prior: string[]; history: string[] } | null
  task: { found: boolean; task_id: string | null; status: string | null; brief: string | null } | null
  summary: { found: boolean; content: string | null; citations: string[] } | null
  citations: Array<{ external_id: string; source: string; occurred_at: number | null }> | null
  archive: {
    plan_groups: number
    archived_ids: string[]
    hidden_from_search: boolean
    by_id_hidden: boolean
    by_id_with_archived: boolean
    restored: boolean
    restored_served: boolean
    keeper_served: boolean
    cold_faults: number
  } | null
  expiry: {
    expired_served_before: boolean
    durable_served_before: boolean
    swept: number
    remaining: number
    expired_gone_after: boolean
    durable_still_served: boolean
  } | null
  degraded: string[]
  latencyMs: number
  /** characters the budgeted producer read delivered on its own */
  primaryChars: number
  /** what one cap did to a composed payload, null for a single-surface read */
  composer: ComposerRecord | null
}

/** one composed payload's allocation: one cap, the producer's share, and what was cut */
export interface ComposerRecord {
  cap: number
  primaryChars: number
  extrasChars: number
  /** sections the cap did not serve whole */
  dropped: string[]
  truncated: boolean
}

/** one probe's read, priced in served characters and tokens */
export interface PricedRead extends ContinuityRead {
  chars: number
  tokens: number
  tokensPerChar: number
  /** the producer's own claim, null when the read carried no budget record */
  producerUsedChars: number | null
  /** true when the producer's own section is longer than the budget it claimed */
  producerUnderreport: boolean
}

/** delivered characters: the sum of the context entries, the packer's own unit */
function sumChars(texts: string[]): number {
  return texts.reduce((n, text) => n + text.length, 0)
}

/** one provenance entry per row, however many times a composite payload delivered it */
function dedupeServed(items: ServedItem[]): ServedItem[] {
  const seen = new Set<string>()
  const out: ServedItem[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/** the config patch a run applies to its recall reads: shipped recall knobs only */
export interface ContinuityRunnerOptions {
  search?: RecallOptions['search']
  limit?: number
}

export class ContinuityRunner {
  private readonly store: MemoryStore

  constructor(
    readonly harness: EvalHarness,
    readonly fixture: ContinuityFixture,
    readonly ledger: ContinuityLedger,
    private readonly tokenizer: TokenizerInfo,
    private readonly options: ContinuityRunnerOptions = {}
  ) {
    this.store = harness.store
  }

  private get db(): Database.Database {
    return this.harness.db
  }

  /** stream one event's actions, in order, on the corpus clock */
  async applyEvent(event: ContinuityEvent): Promise<void> {
    const startedAt = performance.now()
    for (const action of event.actions) {
      switch (action.kind) {
        case 'memory':
          await this.applyMemory(action, event)
          break
        case 'episodes':
          await this.applyEpisodes(action, event)
          break
        case 'task_start': {
          this.ensureSession(event.session, this.fixture.namespace, event.at)
          const task = createTask(this.db, {
            namespace: this.fixture.namespace,
            title: action.title,
            goal: action.goal,
            plan: action.plan,
            session_id: event.session,
            author: 'continuity-controller',
            now: event.at,
          })
          this.ledger.taskId = task.id
          this.ledger.provenance.set(task.id, { seq: event.seq, at: event.at, source: 'task' })
          this.bumpIngest('task_start')
          break
        }
        case 'task_update': {
          if (!this.ledger.taskId) throw new Error(`continuity: ${event.id} updates before a task started`)
          updateTask(
            this.db,
            this.ledger.taskId,
            {
              ...(action.progress ? { progress: action.progress } : {}),
              ...(action.plan ? { plan: action.plan } : {}),
            },
            { author: 'continuity-controller', now: event.at }
          )
          this.bumpIngest('task_update')
          if (action.checkpoint) {
            checkpointTask(this.db, this.ledger.taskId, {
              author: 'continuity-controller',
              reason: 'session end',
              now: event.at,
            })
            this.bumpIngest('task_checkpoint')
          }
          break
        }
        case 'task_close': {
          if (!this.ledger.taskId) throw new Error(`continuity: ${event.id} closes before a task started`)
          await this.applyTaskClose(action, event)
          break
        }
        case 'cold_store':
          await this.applyColdStore(action, event)
          break
      }
    }
    this.ledger.ingestMs[event.id] = Math.round((performance.now() - startedAt) * 1000) / 1000
  }

  /**
   * the session a write belongs to has to exist first: memories and episodes carry a
   * foreign key to it, and a session id is what a later reader attributes a turn to
   */
  private ensureSession(id: string, namespace: string, at: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)')
      .run(id, namespace, at)
  }

  private async applyMemory(
    action: Extract<ContinuityEvent['actions'][number], { kind: 'memory' }>,
    event: ContinuityEvent
  ): Promise<void> {
    this.ensureSession(event.session, action.namespace, event.at)
    const result = await this.store.store({
      content: action.content,
      session_id: event.session,
      project_path: action.namespace,
      ...(action.type ? { type: action.type } : {}),
      ...(action.importance !== undefined ? { importance: action.importance } : {}),
      ...(action.state_key ? { state_key: action.state_key } : {}),
      origin: 'eval-continuity',
    })
    if (result.status === 'rejected') {
      throw new Error(`continuity: store refused ${action.id}: ${result.reason}`)
    }
    this.bumpIngest('store_memory')
    const dbId = result.id
    this.ledger.localIds.set(action.id, dbId)
    this.ledger.corpusIds.set(dbId, action.id)
    this.ledger.provenance.set(dbId, { seq: event.seq, at: event.at, source: 'memory' })
    this.restampRow(dbId, event.at)
    if (action.state_key) this.restampSuperseded(dbId, event.at)
  }

  private async applyEpisodes(
    action: Extract<ContinuityEvent['actions'][number], { kind: 'episodes' }>,
    event: ContinuityEvent
  ): Promise<void> {
    for (const item of action.items) this.ensureSession(item.session_id, action.namespace, event.at)
    const result = await ingestEpisodes(this.db, {
      namespace: action.namespace,
      source: action.source,
      origin: 'eval-continuity',
      vectorsAvailable: false,
      now: event.at,
      ...(action.ttl_ms !== undefined ? { ttl_ms: action.ttl_ms } : {}),
      items: action.items.map((item) => ({
        external_id: item.external_id,
        content: item.content,
        session_id: item.session_id,
        ...(item.role ? { role: item.role } : {}),
        ...(item.task === true ? { task_id: this.ledger.taskId ?? undefined } : {}),
      })),
    })
    if (result.rejected > 0) {
      const rejection = result.items.find((item) => item.status === 'rejected')
      throw new Error(
        `continuity: episode ingest rejected an item: ${rejection?.status === 'rejected' ? rejection.reason : 'unknown'}`
      )
    }
    this.bumpIngest('episode_items', result.ingested)
    for (const item of action.items) {
      const stored = result.items.find((entry) => entry.external_id === item.external_id)
      if (!stored || stored.status !== 'ingested') continue
      this.ledger.episodeByExternal.set(item.external_id, {
        id: stored.id,
        seq: event.seq,
        at: event.at,
      })
      this.ledger.provenance.set(stored.id, { seq: event.seq, at: event.at, source: 'episode' })
    }
    if (action.link) {
      const memoryId = this.ledger.localIds.get(action.link.memory)
      const episode = this.ledger.episodeByExternal.get(action.link.external_id)
      if (!memoryId || !episode) {
        throw new Error(`continuity: link cites an unknown memory or episode (${event.id})`)
      }
      linkMemoryEpisode(
        this.db,
        { memory_id: memoryId, episode_id: episode.id, span_start: null, span_end: null },
        event.at
      )
      this.bumpIngest('link_memory_episode')
    }
  }

  /**
   * the close path is the tool surface, because the close summary and its episode
   * citations are written by the handler, not by closeTask alone. the handler owns its
   * clock, so the row it writes is restamped to the corpus clock afterwards.
   */
  private async applyTaskClose(
    action: Extract<ContinuityEvent['actions'][number], { kind: 'task_close' }>,
    event: ContinuityEvent
  ): Promise<void> {
    const result = await handleTool('task_close', {
      id: this.ledger.taskId!,
      ...(action.summary ? { summary: action.summary } : {}),
      author: 'continuity-controller',
    })
    const payload = parseToolResult<{
      error?: string
      closed?: boolean
      linked_episodes?: number
      memory?: { id?: string; status?: string }
    }>(result)
    if (result.isError || payload.error) {
      throw new Error(`continuity: task_close failed: ${payload.error ?? 'unknown error'}`)
    }
    this.bumpIngest('task_close')
    const memoryId = payload.memory?.id
    if (!memoryId) throw new Error('continuity: task_close wrote no summary memory')
    this.ledger.localIds.set('task-summary', memoryId)
    this.ledger.corpusIds.set(memoryId, 'task-summary')
    this.ledger.provenance.set(memoryId, { seq: event.seq, at: event.at, source: 'task-summary' })
    this.restampRow(memoryId, event.at)
    this.restampTask(event.at)
  }

  private async applyColdStore(
    action: Extract<ContinuityEvent['actions'][number], { kind: 'cold_store' }>,
    event: ContinuityEvent
  ): Promise<void> {
    this.ensureSession(event.session, action.namespace, event.at)
    for (const content of action.contents) {
      const result = await this.store.store({
        content,
        session_id: event.session,
        project_path: action.namespace,
        type: 'note',
        importance: 0.4,
        origin: 'eval-continuity',
      })
      if (result.status === 'rejected') {
        throw new Error(`continuity: cold-tier store refused a row: ${result.reason}`)
      }
      this.bumpIngest('store_memory')
      this.ledger.provenance.set(result.id, { seq: event.seq, at: event.at, source: 'memory' })
      this.restampRow(result.id, event.at)
    }
    const plan = planDuplicatePrune(this.db, { namespace: action.namespace })
    const applied = applyDuplicatePrune(this.db, plan, { now: event.at })
    this.ledger.coldPlanGroups = plan.groups.length
    this.ledger.coldArchivedId = plan.groups[0]?.redundant_ids[0] ?? null
    this.bumpIngest('prune_apply', applied.archived)
  }

  /** one probe's payload, priced; `arm` decides which surfaces the controller consults */
  async readProbe(probe: ContinuityProbe, arm: ContinuityArm): Promise<PricedRead> {
    const startedAt = performance.now()
    const read =
      arm === 'full'
        ? await this.readLayered(probe)
        : await this.readMemoriesOnly(probe, arm)
    const cost = tokenCost(read.context, this.tokenizer)
    read.latencyMs = Math.round((performance.now() - startedAt) * 1000) / 1000
    this.ledger.probeMs[`${arm}.${probe.id}`] = read.latencyMs
    // the delivered size is the sum of the context entries, recomputed here from the
    // payload itself rather than taken from the producer's accounting; `cost.chars` is
    // the same sum, and the scorer recomputes it again so neither side has to be trusted
    const producerUsed = read.budget?.used_chars ?? null
    return {
      ...read,
      // a row delivered twice (a composite read) is one provenance entry, not two
      served: dedupeServed(read.served),
      chars: cost.chars,
      tokens: cost.tokens,
      tokensPerChar: cost.tokensPerChar,
      producerUsedChars: producerUsed,
      producerUnderreport: producerUsed !== null && read.primaryChars > producerUsed,
    }
  }

  /**
   * pack extra surfaces into what a budgeted read left: one probe is one payload with one
   * cap. lines are added whole, the first that does not fit is clipped with the recall
   * packer's ellipsis, and `kept` is what the structured fields must be built from.
   */
  private packExtras(
    cap: number,
    primaryChars: number,
    sections: Array<{ name: string; lines: string[] }>
  ): ComposerRecord & { lines: string[]; kept: Record<string, string[]> } {
    let room = Math.max(0, cap - primaryChars)
    const lines: string[] = []
    const kept: Record<string, string[]> = {}
    const dropped: string[] = []
    let truncated = false
    for (const section of sections) {
      if (room <= 0) {
        dropped.push(section.name)
        continue
      }
      const served: string[] = []
      let complete = true
      for (const line of section.lines) {
        if (line.length <= room) {
          served.push(line)
          lines.push(line)
          room -= line.length
          continue
        }
        if (room > 2) {
          const clipped = `${line.slice(0, room - 1)}…`
          served.push(clipped)
          lines.push(clipped)
          room = 0
          truncated = true
        }
        complete = false
        break
      }
      if (served.length > 0) kept[section.name] = served
      if (!complete) dropped.push(section.name)
    }
    const extrasChars = lines.reduce((n, line) => n + line.length, 0)
    return {
      cap,
      primaryChars,
      extrasChars,
      dropped,
      truncated,
      lines,
      kept,
    }
  }

  private async readLayered(probe: ContinuityProbe): Promise<ContinuityRead> {
    switch (probe.layer) {
      case 'memories':
        return this.readMemories(probe, 'full', 'recall_context')
      case 'state':
        return this.readState(probe)
      case 'evidence':
        return this.readEvidence(probe)
      case 'task':
        return this.readTask(probe)
      case 'close':
        return this.readClose(probe)
      case 'archive':
        return this.readArchive(probe)
      case 'expiry':
        return this.readExpiry(probe)
    }
  }

  /**
   * the degraded single-layer ablation: every probe is answered from the memories layer
   * alone, under the same character budget the full arm would have given its own read.
   * this is what a caller that only wired recall_context would see.
   */
  private async readMemoriesOnly(
    probe: ContinuityProbe,
    arm: ContinuityArm
  ): Promise<ContinuityRead> {
    return this.readMemories(probe, arm, 'recall_context (single layer)')
  }

  /** the shape every read returns, so a reader only fills in what it actually read */
  private blankRead(
    probe: ContinuityProbe,
    arm: ContinuityArm,
    action: string
  ): ContinuityRead {
    return {
      probe_id: probe.id,
      arm,
      action,
      context: [],
      served: [],
      budget: null,
      state: null,
      task: null,
      summary: null,
      citations: null,
      archive: null,
      expiry: null,
      degraded: [],
      latencyMs: 0,
      primaryChars: 0,
      composer: null,
    }
  }

  private async readMemories(
    probe: ContinuityProbe,
    arm: ContinuityArm,
    action: string
  ): Promise<ContinuityRead> {
    const now = probe.now ?? this.fixture.now
    const started = performance.now()
    const recall = await recallContext(this.db, this.store, this.harness.search, {
      query: probe.query,
      project_path: probe.namespace,
      budget_chars: probe.budget_chars,
      limit: this.options.limit ?? 10,
      mode: 'fused',
      now,
      ...(this.options.search ? { search: this.options.search } : {}),
    })
    this.bumpRead(`${arm}.recall`)
    const served = recall.memories.map((memory) =>
      this.servedMemory(memory.id, memory.content)
    )
    const context = [
      ...(recall.digest ? [recall.digest] : []),
      ...recall.memories.map((memory) => memory.content),
      ...recall.topics.map((topic) => topic.summary ?? ''),
    ]
    return {
      ...this.blankRead(probe, arm, action),
      context,
      // the packer's sections are the whole payload of this read: its own claim and the
      // delivered size have to agree, and the scorer checks that they do
      primaryChars: sumChars(context),
      served,
      budget: {
        budget_chars: recall.budget.total_chars,
        used_chars: recall.budget.used_chars,
        dropped_memories: recall.dropped.memories,
        dropped_topics: recall.dropped.topics,
        digest_chars_cut: recall.dropped.digest_chars_cut,
        truncated_memories: recall.truncated.memories,
        truncated_topics: recall.truncated.topics,
      },
      degraded: recall.degraded ?? [],
      latencyMs: performance.now() - started,
    }
  }

  private async readState(probe: ContinuityProbe): Promise<ContinuityRead> {
    const now = probe.now ?? this.fixture.now
    const historyRead = probe.state_read === 'history'
    const recall = await this.readMemories(
      probe,
      'full',
      historyRead
        ? 'recall_context + get_state + get_memory_history'
        : 'recall_context + get_state'
    )
    const view = getState(this.db, { namespace: probe.namespace, limit: 100, now })
    this.bumpRead('full.get_state')
    const current = view.slots.map((slot) => slot.current?.content ?? '').filter(Boolean)
    // a present-state question never pulls the replaced value into its own payload: the
    // prior value is only read by the probe that asks for the chain
    const prior: string[] = []
    const history: string[] = []
    const historyItems: ServedItem[] = []
    if (historyRead) {
      for (const slot of view.slots) {
        if (slot.prior) prior.push(slot.prior.content)
        if (!slot.current) continue
        const chain = this.store.getHistory(slot.current.memory_id, { limit: 20 })
        this.bumpRead('full.get_memory_history')
        if (!chain) continue
        for (const version of chain.versions) {
          history.push(version.content)
          historyItems.push(this.servedMemory(version.id, version.content))
        }
      }
    }
    const primaryChars = sumChars(recall.context)
    // the slot surfaces are extra to the budgeted recall read, so they are packed into
    // what the recall read left: one probe, one cap, however many surfaces it composes
    const packed = this.packExtras(probe.budget_chars, primaryChars, [
      { name: 'state-current', lines: current },
      { name: 'state-prior', lines: prior },
      { name: 'state-history', lines: history },
    ])
    const deliveredHistory = packed.kept['state-history'] ?? []
    return {
      ...recall,
      action: historyRead
        ? 'recall_context + get_state + get_memory_history'
        : 'recall_context + get_state (current only)',
      context: [...recall.context, ...packed.lines],
      // the history versions are served rows too: a leak or a replaced value in the
      // chain has to be visible to the same checks as a served memory. only the rows the
      // cap delivered are listed, carrying the content it delivered
      served: [
        ...recall.served,
        ...historyItems
          .slice(0, deliveredHistory.length)
          .map((item, index) => ({ ...item, content: deliveredHistory[index] })),
      ],
      // the structured view is the delivered view: a scored field cannot hold a value
      // the payload did not carry
      state: {
        keys: view.slots.map((slot) => slot.key),
        current: packed.kept['state-current'] ?? [],
        prior: packed.kept['state-prior'] ?? [],
        history: deliveredHistory,
      },
      primaryChars,
      composer: packed,
    }
  }

  private async readEvidence(probe: ContinuityProbe): Promise<ContinuityRead> {
    const now = probe.now ?? this.fixture.now
    const result = await retrieveEpisodeContext({
      db: this.db,
      namespace: probe.namespace,
      query: probe.query,
      budget_chars: probe.budget_chars,
      now,
      vectorsAvailable: false,
    })
    this.bumpRead('full.retrieve_episode_context')
    const episodeLines = result.lines.map(
      (line) => `${line.date} [${line.session_id}#${line.turn_index}] ${line.content}`
    )
    const served = result.lines.map((line) => this.servedEpisode(line.episode_id, line.content, line.occurred_at))
    const cited = probe.citations_of ? this.readCitedEpisodes(probe.citations_of) : null
    const citationLines = (cited ?? []).map((citation) => `${citation.source}:${citation.external_id}`)
    const primaryChars = sumChars(episodeLines)
    // a citation line is content the payload delivers, so it is charged against the same
    // cap as the episode evidence rather than appended for free
    const packed = this.packExtras(probe.budget_chars, primaryChars, [
      { name: 'citations', lines: citationLines },
    ])
    const deliveredLines = packed.kept['citations'] ?? []
    // only a citation whose whole line was delivered is claimable, and only those rows
    // are listed as served
    const delivered = (cited ?? [])
      .slice(0, deliveredLines.length)
      .filter((citation, index) => `${citation.source}:${citation.external_id}` === deliveredLines[index])
    return {
      ...this.blankRead(
        probe,
        'full',
        probe.citations_of
          ? 'retrieve_episode_context + cited_episodes'
          : 'retrieve_episode_context'
      ),
      context: [...episodeLines, ...packed.lines],
      served: [
        ...served,
        ...delivered.map((citation) => this.servedEpisode(citation.id, '', citation.occurred_at)),
      ],
      citations: probe.citations_of
        ? delivered.map((citation) => ({
            external_id: citation.external_id,
            source: citation.source,
            occurred_at: citation.occurred_at,
          }))
        : null,
      primaryChars,
      composer: packed,
      degraded: result.degraded,
    }
  }

  private async readTask(probe: ContinuityProbe): Promise<ContinuityRead> {
    const tasks = listOpenTasks(this.db, probe.namespace, { limit: 5 })
    this.bumpRead('full.list_open_tasks')
    const task = tasks[0] ?? null
    let briefText: string | null = null
    if (task) {
      briefText = handoff(task, 'new-session', probe.budget_chars).text
      this.bumpRead('full.task_handoff')
    }
    return {
      ...this.blankRead(probe, 'full', 'list_open_tasks + task_handoff'),
      context: briefText ? [briefText] : [],
      // the handoff packs itself to the probe budget, so the brief is the whole payload
      primaryChars: briefText?.length ?? 0,
      served: task
        ? [
            {
              id: task.id,
              local_id: null,
              namespace: task.namespace,
              content: briefText ?? task.title,
              at: this.provenanceAt(task.id),
              seq: this.provenanceSeq(task.id),
              source: 'task',
            },
          ]
        : [],
      task: {
        found: task !== null,
        task_id: task?.id ?? null,
        status: task?.status ?? null,
        brief: briefText,
      },
    }
  }

  private async readClose(probe: ContinuityProbe): Promise<ContinuityRead> {
    const open = listOpenTasks(this.db, probe.namespace, { limit: 5 })
    this.bumpRead('full.list_open_tasks')
    const summaries = this.store.list({
      project_path: probe.namespace,
      tags: ['task-summary'],
      limit: 5,
    })
    this.bumpRead('full.list_task_summaries')
    const summary = summaries[0] ?? null
    const cited = summary ? this.readCitedEpisodesById(summary.id) : []
    const citationLines = cited.map((citation) => `${citation.source}:${citation.external_id}`)
    const recall = await this.readMemories(probe, 'full', 'task_close summary + recall_context')
    const primaryChars = sumChars(recall.context)
    // the close summary and the citations that prove where it came from are extra to the
    // budgeted recall read, so they share its cap like every other composed surface
    const packed = this.packExtras(probe.budget_chars, primaryChars, [
      { name: 'summary', lines: summary ? [summary.content] : [] },
      { name: 'citations', lines: citationLines },
    ])
    const deliveredSummary = packed.kept['summary']?.[0] ?? null
    const deliveredCitationLines = packed.kept['citations'] ?? []
    const deliveredCitations = cited
      .slice(0, deliveredCitationLines.length)
      .filter((citation, index) => `${citation.source}:${citation.external_id}` === deliveredCitationLines[index])
    return {
      ...recall,
      action: 'list_open_tasks + task summary + cited_episodes + recall_context',
      // the summary is presented first and charged against the same cap as the recall it
      // was composed with
      context: [
        ...(deliveredSummary !== null ? [deliveredSummary] : []),
        ...deliveredCitationLines,
        ...recall.context,
      ],
      summary: summary
        ? {
            found: true,
            content: deliveredSummary,
            citations: deliveredCitations.map((citation) => citation.external_id),
          }
        : { found: false, content: null, citations: [] },
      task: {
        found: open.length > 0,
        task_id: open[0]?.id ?? null,
        status: open[0]?.status ?? null,
        brief: null,
      },
      citations: deliveredCitations.map((citation) => ({
        external_id: citation.external_id,
        source: citation.source,
        occurred_at: citation.occurred_at,
      })),
      served: [
        ...(deliveredSummary !== null && summary
          ? [this.servedMemory(summary.id, deliveredSummary)]
          : []),
        ...deliveredCitations.map((citation) => this.servedEpisode(citation.id, '', citation.occurred_at)),
        ...recall.served,
      ],
      primaryChars,
      composer: packed,
    }
  }

  private async readArchive(probe: ContinuityProbe): Promise<ContinuityRead> {
    const archivedId = this.ledger.coldArchivedId
    const before = await this.harness.runSearch(probe.query, {
      project_path: probe.namespace,
      limit: 10,
    })
    this.bumpRead('full.search')
    const hiddenFromSearch = archivedId !== null && !before.some((row) => row.id === archivedId)
    const keeperServed = before.length > 0

    const withoutFlag = await handleTool('get_memory', { id: archivedId ?? '' })
    this.bumpRead('full.get_memory')
    const withoutPayload = parseToolResult<{ error?: string; id?: string }>(withoutFlag)
    const byIdHidden = withoutFlag.isError === true || typeof withoutPayload.error === 'string'

    const withFlag = await handleTool('get_memory', {
      id: archivedId ?? '',
      include_archived: true,
    })
    this.bumpRead('full.get_memory(include_archived)')
    const withPayload = parseToolResult<{ error?: string; id?: string }>(withFlag)
    const byIdWithArchived = withFlag.isError !== true && typeof withPayload.id === 'string'

    const restored = archivedId ? unarchiveMemory(this.db, archivedId).unarchived : false
    this.bumpProbe('unarchive')
    const after = await this.harness.runSearch(probe.query, {
      project_path: probe.namespace,
      limit: 10,
    })
    this.bumpRead('full.search')
    const restoredServed = archivedId !== null && after.some((row) => row.id === archivedId)
    const coldFaults = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM eviction_events WHERE memory_id = ? AND reason = 'read'")
        .get(archivedId ?? '') as { n: number }
    ).n

    // the cold search has no packer of its own, so its results are charged against the
    // probe cap here: an unbudgeted read is still one delivered payload
    const packed = this.packExtras(probe.budget_chars, 0, [
      { name: 'cold-search', lines: before.map((row) => row.content) },
    ])
    const delivered = packed.kept['cold-search'] ?? []
    return {
      ...this.blankRead(probe, 'full', 'search + get_memory + unarchive_memory + search'),
      context: packed.lines,
      served: before
        .slice(0, delivered.length)
        .map((row, index) => this.servedMemory(row.id, delivered[index])),
      primaryChars: 0,
      composer: packed,
      archive: {
        plan_groups: this.ledger.coldPlanGroups,
        archived_ids: archivedId ? [archivedId] : [],
        hidden_from_search: hiddenFromSearch,
        by_id_hidden: byIdHidden,
        by_id_with_archived: byIdWithArchived,
        restored,
        restored_served: restoredServed,
        keeper_served: keeperServed,
        cold_faults: coldFaults,
      },
    }
  }

  private async readExpiry(probe: ContinuityProbe): Promise<ContinuityRead> {
    const now = probe.now ?? this.fixture.now
    const before = await retrieveEpisodeContext({
      db: this.db,
      namespace: probe.namespace,
      query: probe.query,
      budget_chars: probe.budget_chars,
      now,
      vectorsAvailable: false,
    })
    this.bumpRead('full.retrieve_episode_context')
    const expiredContent = this.expiringContent()
    const durableContent = this.durableContent()
    // the before-read is the primary of this payload, so its lines are delivered whole
    const expiredServedBefore = before.lines.some((line) => line.content === expiredContent)
    const durableServedBefore = before.lines.some((line) => line.content === durableContent)

    const swept = deleteEpisodes(this.db, { namespace: probe.namespace }, { expired: true, now })
    this.bumpProbe('episode_sweep', swept.episodes)
    const remaining = countEpisodes(this.db, { namespace: probe.namespace })
    this.bumpRead('full.count_episodes')

    const after = await retrieveEpisodeContext({
      db: this.db,
      namespace: probe.namespace,
      query: probe.query,
      budget_chars: probe.budget_chars,
      now,
      vectorsAvailable: false,
    })
    this.bumpRead('full.retrieve_episode_context')
    const beforeLines = before.lines.map((line) => line.content)
    const primaryChars = sumChars(beforeLines)
    // the read after the sweep is extra to the read before it, so both share the cap:
    // what the second read found only counts if the payload could carry it
    const packed = this.packExtras(probe.budget_chars, primaryChars, [
      { name: 'after-sweep', lines: after.lines.map((line) => line.content) },
    ])
    const deliveredAfter = packed.kept['after-sweep'] ?? []
    const expiredGoneAfter = !deliveredAfter.includes(expiredContent)
    const durableStillServed = deliveredAfter.includes(durableContent)

    return {
      ...this.blankRead(
        probe,
        'full',
        'retrieve_episode_context + delete_episodes(expired) + retrieve_episode_context'
      ),
      context: [...beforeLines, ...packed.lines],
      served: [
        ...before.lines.map((line) =>
          this.servedEpisode(line.episode_id, line.content, line.occurred_at)
        ),
        ...after.lines
          .slice(0, deliveredAfter.length)
          .map((line) => this.servedEpisode(line.episode_id, line.content, line.occurred_at)),
      ],
      primaryChars,
      composer: packed,
      expiry: {
        expired_served_before: expiredServedBefore,
        durable_served_before: durableServedBefore,
        swept: swept.episodes,
        remaining,
        expired_gone_after: expiredGoneAfter,
        durable_still_served: durableStillServed,
      },
      degraded: [...before.degraded, ...after.degraded],
    }
  }

  /** the cited episodes themselves, so a caller can list them and serve their rows */
  private readCitedEpisodes(localId: string): CitedEpisode[] {
    const dbId = this.ledger.localIds.get(localId)
    if (!dbId) {
      // an unknown corpus id is a fixture/runner bug, not an empty result
      throw new Error(`continuity: citations_of names an unknown memory "${localId}"`)
    }
    return this.readCitedEpisodesById(dbId)
  }

  private readCitedEpisodesById(dbId: string): CitedEpisode[] {
    this.bumpRead('full.cited_episodes')
    return citedEpisodes(this.db, dbId)
  }

  private servedMemory(dbId: string, content: string): ServedItem {
    const provenance = this.ledger.provenance.get(dbId)
    return {
      id: dbId,
      local_id: this.ledger.corpusIds.get(dbId) ?? null,
      namespace: this.namespaceOf(dbId),
      content,
      at: provenance?.at ?? 0,
      seq: provenance?.seq ?? -1,
      source: provenance?.source ?? 'memory',
    }
  }

  private servedEpisode(dbId: string, content: string, occurredAt: number | null): ServedItem {
    const provenance = this.ledger.provenance.get(dbId)
    const external = [...this.ledger.episodeByExternal.entries()].find(([, row]) => row.id === dbId)
    return {
      id: dbId,
      local_id: external ? external[0] : null,
      namespace: this.namespaceOfEpisode(dbId),
      content,
      at: occurredAt ?? provenance?.at ?? 0,
      seq: provenance?.seq ?? -1,
      source: provenance?.source ?? 'episode',
    }
  }

  private namespaceOf(dbId: string): string {
    const row = this.db
      .prepare('SELECT COALESCE(namespace, project_path) AS ns FROM memories WHERE id = ?')
      .get(dbId) as { ns: string } | undefined
    return row?.ns ?? ''
  }

  private namespaceOfEpisode(dbId: string): string {
    const row = this.db.prepare('SELECT namespace AS ns FROM episodes WHERE id = ?').get(dbId) as
      | { ns: string }
      | undefined
    return row?.ns ?? ''
  }

  private provenanceAt(dbId: string): number {
    return this.ledger.provenance.get(dbId)?.at ?? 0
  }

  private provenanceSeq(dbId: string): number {
    return this.ledger.provenance.get(dbId)?.seq ?? -1
  }

  /** the expiring episode's text, looked up by the fixture's external id */
  private expiringContent(): string {
    return this.episodeContentByExternal('ct-s6-expiring')
  }

  private durableContent(): string {
    return this.episodeContentByExternal('ct-s6-durable')
  }

  private episodeContentByExternal(externalId: string): string {
    const stored = this.ledger.episodeByExternal.get(externalId)
    if (!stored) throw new Error(`continuity: episode "${externalId}" was never ingested`)
    const row = this.db.prepare('SELECT content FROM episodes WHERE id = ?').get(stored.id) as
      | { content: string }
      | undefined
    if (!row) throw new Error(`continuity: episode "${externalId}" is missing from the store`)
    return row.content
  }

  /**
   * the corpus clock wins, exactly as the seeded-corpus harness rules it: store_memory
   * stamps wall time, and a run whose recency signal depends on the machine is not
   * reproducible.
   */
  private restampRow(dbId: string, at: number): void {
    this.db
      .prepare('UPDATE memories SET created_at = ?, valid_from = ? WHERE id = ?')
      .run(at, at, dbId)
  }

  /** close the window on whatever this write retired, on the same clock */
  private restampSuperseded(dbId: string, at: number): void {
    const links = this.db
      .prepare("SELECT target_id FROM memory_links WHERE source_id = ? AND link_type = 'supersedes'")
      .all(dbId) as Array<{ target_id: string }>
    const updateRow = this.db.prepare(
      'UPDATE memories SET valid_until = ? WHERE id = ? AND (valid_until IS NULL OR valid_until > ?)'
    )
    const updateLink = this.db.prepare(
      `UPDATE memory_links SET created_at = ?, judged_at = ?
       WHERE source_id = ? AND target_id = ? AND link_type = 'supersedes'`
    )
    for (const link of links) {
      updateRow.run(at, link.target_id, at)
      updateLink.run(at, at, dbId, link.target_id)
    }
  }

  /** the tool surface that closed the task stamped wall time on the row and its events */
  private restampTask(at: number): void {
    if (!this.ledger.taskId) return
    this.db
      .prepare(
        'UPDATE tasks SET created_at = MIN(created_at, ?), updated_at = ?, closed_at = ? WHERE id = ?'
      )
      .run(at, at, at, this.ledger.taskId)
    this.db.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ?').run(at, this.ledger.taskId)
  }

  private bumpIngest(op: string, by = 1): void {
    this.ledger.ingestOps[op] = (this.ledger.ingestOps[op] ?? 0) + by
  }

  /** an action a probe performs, not a seeding cost */
  private bumpProbe(op: string, by = 1): void {
    this.ledger.probeOps[op] = (this.ledger.probeOps[op] ?? 0) + by
  }

  private bumpRead(op: string): void {
    this.ledger.readOps[op] = (this.ledger.readOps[op] ?? 0) + 1
  }
}
