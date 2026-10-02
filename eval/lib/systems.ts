// memory-system registry: a system owns reset, ingest, retrieval and teardown for one
// retrieval stack, so several systems meet the same questions, budget and top-k. adding
// one is an entry in SYSTEMS plus a test; `mcp:<config-path>` builds one from an adapter
// config instead of in repo. the in-process systems share the run's isolated db, so the
// suite seeds it once and every system reads the same rows.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { createMcpSystem, loadAdapterConfig } from '../adapters/mcp.js'
import { assemble, type AssembleOptions } from '../../src/memory/assemble.js'
import { EvalSetupError } from './errors.js'
import { latencyMsAsync } from './metrics.js'
import { REPO_ROOT } from './report.js'
import {
  deleteEpisodes,
  ingestEpisodes,
  unembeddedEpisodeCount,
} from '../../src/memory/episodes.js'
import { retrieveEpisodeContext } from '../../src/memory/episode-context.js'
import {
  allocationForQuery,
  type AllocationChoice,
  type RecipeAllocation,
} from '../../src/memory/allocation.js'
import {
  assembleTurnContext,
  isAggregationQuery,
  parseTurnMemoryId,
  turnDayTag,
  turnMemoryId,
  turnText,
  turnsOf,
  type TurnHit,
  type TurnSessionMeta,
} from './turns.js'
import type { EvalHarness } from './harness.js'
import type { Corpus, CorpusMemory, CorpusTurn, StoredVectors } from './types.js'

/** one haystack session: the content and the corpus-local id scores are reported in */
export interface SystemSession {
  id: string
  text: string
  createdAt?: number
  tags?: string[]
  /** per-turn structure when the corpus carries it; a session-granularity system ignores it */
  turns?: CorpusTurn[]
}

export function toSystemSessions(memories: CorpusMemory[]): SystemSession[] {
  return memories.map((memory) => ({
    id: memory.id,
    text: memory.content,
    createdAt: memory.created_at,
    tags: memory.tags,
    turns: memory.turns,
  }))
}

export interface RetrievedItem {
  text: string
  /** corpus-local session id this item came from; absent when the system cannot say */
  ref?: string
  /** the system's own id for the item */
  id?: string
  /** 0-based turn index inside the session, when the system retrieved below a session */
  turn?: number
}

export interface RetrievalResult {
  /** the packed context a reader model sees: `blocks.join('\n\n')` */
  context: string
  /** the same context as the numbered prompt blocks */
  blocks: string[]
  /** ranked, best first; recall is scored over this list */
  items: RetrievedItem[]
  retrievalMs: number
  note: string
}

export interface SystemCost {
  /** sessions ingest made durable, one call each */
  writeCalls: number
  /** llm tokens the write path spent; 0 when ingest is local, null when the system cannot see it */
  writeTokens: number | null
}

/**
 * what a system's write path left in the shared db, and how much of it carries a vector.
 * a report that omits this cannot tell a vector run from a lexical-only one.
 */
export type { StoredVectors }

export interface StoredVectorScope {
  /** namespace roots to count in `memories` (each one plus its descendants) */
  memories?: string[]
  /** the same for the evidence table */
  episodes?: string[]
}

/** `ns` or any namespace below it, the way the scope readers match */
function scopePredicate(alias: string): string {
  const column = alias === '' ? 'namespace' : `${alias}.namespace`
  return `(${column} = ? OR ${column} LIKE ? ESCAPE '\\' OR ${column} LIKE ? ESCAPE '\\')`
}

function scopeParams(namespace: string): string[] {
  const escaped = namespace.replace(/[\\%_]/g, '\\$&')
  return [namespace, `${escaped}/%`, `${escaped}//%`]
}

function countInTable(
  harness: EvalHarness,
  table: 'memories' | 'episodes',
  namespaces: string[]
): { rows: number; vectors: number }
{
  let rows = 0
  let vectors = 0
  for (const namespace of namespaces) {
    const predicate = scopePredicate('')
    const params = scopeParams(namespace)
    const row = harness.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`)
      .get(...params) as { n: number }
    const vector = harness.db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate} AND vec_rowid IS NOT NULL`
      )
      .get(...params) as { n: number }
    rows += row.n
    vectors += vector.n
  }
  return { rows, vectors }
}

export function storedVectorsOf(harness: EvalHarness, scope: StoredVectorScope): StoredVectors {
  return {
    memories: countInTable(harness, 'memories', scope.memories ?? []),
    episodes: countInTable(harness, 'episodes', scope.episodes ?? []),
  }
}

export interface SystemAdapter {
  /** 'builtin' for an in-repo system, 'mcp' for a server behind the adapter */
  kind: string
  /** sha256 (16 hex) of the adapter config file, so a comparison can prove a match */
  configHash: string
  /** the config path a system was built from; '' for a builtin */
  source: string
}

export interface MemorySystem {
  readonly name: string
  readonly describe: string
  readonly adapter: SystemAdapter
  /** true when the system has no vector channel at all, so a 0 must not read as a bug */
  readonly lexicalOnly?: boolean
  /** forget a namespace's local state; a server-side store keeps what it already wrote */
  reset(ns: string): Promise<void>
  ingest(ns: string, sessions: SystemSession[]): Promise<void>
  retrieve(ns: string, query: string, budgetChars: number): Promise<RetrievalResult>
  cost(): SystemCost
  /** rows and vectors this system's last ingest left behind, captured before teardown */
  storedVectors?(): StoredVectors | null
  close(): Promise<void>
}

export interface SystemDeps {
  /** the run's isolated engram instance, shared by every in-process system */
  harness: EvalHarness
  /** candidate cap per retrieval, identical for every system */
  topK: number
  /** corpus seed, recorded by a system that has to seed the harness itself */
  seed: number
}

export interface SystemFactory {
  name: string
  describe: string
  /** true when the system has no vector channel at all, so a 0 must not read as a bug */
  lexicalOnly?: boolean
  create(deps: SystemDeps): MemorySystem
}

const BUILTIN: SystemAdapter = { kind: 'builtin', configHash: '', source: '' }

/** chunk size in characters for naive-rag */
export const NAIVE_CHUNK_CHARS = 600

/** `ns` or `ns//scope`, the same column the harness reads */
function namespaceRows(harness: EvalHarness, ns: string): number {
  const row = harness.db
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE COALESCE(namespace, project_path) = ?')
    .get(ns) as { n: number }
  return row.n
}

export const engramSystem: SystemFactory = {
  name: 'engram',
  describe: 'engram in process: recall_context under the strict character budget',
  create(deps) {
    let writeCalls = 0
    let stored: StoredVectors | null = null
    return {
      name: 'engram',
      describe: engramSystem.describe,
      adapter: BUILTIN,
      async reset() {},
      async ingest(ns, sessions) {
        writeCalls += sessions.length
        // a suite scores its configs on the same harness, so this namespace is usually
        // already written; ingest fills only the one a caller did not seed
        if (namespaceRows(deps.harness, ns) > 0) {
          stored = storedVectorsOf(deps.harness, { memories: [ns] })
          return
        }
        await deps.harness.seedCorpus(
          {
            name: 'system-ingest',
            seed: deps.seed,
            memories: sessions.map((session) => ({
              id: session.id,
              namespace: ns,
              content: session.text,
              type: 'note',
              tags: session.tags ?? [],
              created_at: session.createdAt ?? 0,
            })),
            queries: [],
          },
          { mode: 'raw' }
        )
      },
      async retrieve(ns, query, budgetChars) {
        const { ms, value } = await latencyMsAsync(() =>
          deps.harness.runRecall({
            query,
            project_path: ns,
            budget_chars: budgetChars,
            limit: deps.topK,
            mode: 'fused',
          })
        )
        const blocks = [
          ...(value.digest ? [value.digest] : []),
          ...value.memories.map((m) => m.content),
          ...value.topics.flatMap((t) => (t.summary ? [t.summary] : [])),
        ]
        return {
          context: blocks.join('\n\n'),
          blocks,
          items: value.memories.map((m) => ({
            text: m.content,
            id: m.id,
            ref: deps.harness.localIdOf(m.id),
          })),
          retrievalMs: ms,
          note:
            `used=${value.budget.used_chars}/${value.budget.total_chars} chars, ` +
            `memories=${value.memories.length}, dropped=${value.dropped.memories}`,
        }
      },
      cost: () => ({ writeCalls, writeTokens: 0 }),
      storedVectors: () => stored,
      async close() {},
    }
  },
}

/** turn candidates the recall channel may return; recallContext caps its own limit at 100 */
export const TURN_CANDIDATES = 100
/** adjacent turns rendered on each side of a hit */
export const TURN_RENDER_WINDOW = 1
/** hybrid: snippet recalls run per candidate session */
export const TURN_SNIPPETS_PER_SESSION = 6
/** the candidate stage is not the served budget; the assembly packs to the budget, so
 * the recall call gets headroom to hand it a full candidate list */
const CANDIDATE_BUDGET_MULTIPLE = 8

export interface TurnSystemOptions {
  /** turns per ingested memory; 1 is one memory per turn */
  ingestWindow?: number
  /** adjacent turns rendered on each side of a hit */
  renderWindow?: number
  /** turn memories the recall channel may return per question */
  candidates?: number
  /** hybrid only: snippet recalls run per candidate session */
  snippetsPerSession?: number
  /** session recall picks candidate sessions first, turn recall then picks snippets */
  hybrid?: boolean
  /**
   * an aggregation-shaped question spends the budget on statement turns first, then on
   * the replies that otherwise fill it
   */
  statementsFirst?: boolean
  /** top-hit windows bought before the statements; the question's own best evidence */
  reserveTopHits?: number
}

/** the child namespace a question's turn memories live in */
export function turnsNamespace(ns: string): string {
  return `${ns}//turns`
}

/**
 * turn-granularity retrieval over the same engine: turn memories in a child namespace,
 * the normal recall path as the ranker, then the assembly groups hits by session,
 * oldest first, dated, packed to the same character budget as every other system.
 */
export function turnSystemFactory(name: string, options: TurnSystemOptions = {}): SystemFactory {
  const ingestWindow = Math.max(1, options.ingestWindow ?? 1)
  const renderWindow = options.renderWindow ?? TURN_RENDER_WINDOW
  const candidates = options.candidates ?? TURN_CANDIDATES
  const snippetsPerSession = options.snippetsPerSession ?? TURN_SNIPPETS_PER_SESSION
  const hybrid = options.hybrid === true
  const statementsFirst = options.statementsFirst === true
  const reserveTopHits = options.reserveTopHits ?? 0
  const describe = hybrid
    ? `session recall picks ${TURN_CANDIDATES} candidate sessions, turn recall picks ` +
      `${snippetsPerSession} snippets inside each, served as dated session groups under the budget`
    : `engram recall over ${ingestWindow === 1 ? 'one memory per turn' : `${ingestWindow}-turn window memories`}, ` +
      `${candidates} candidates, served as dated session groups under the budget` +
      (statementsFirst
        ? '; an aggregation-shaped question spends the budget on statement turns first'
        : '')

  return {
    name,
    describe,
    lexicalOnly: true,
    create(deps) {
      let writeCalls = 0
      // one question is live at a time; turn rows of the previous one are dropped so
      // the db (and the turn text) never holds two haystacks
      let current: string | null = null
      let currentChildren: string[] = []
      let meta = new Map<string, TurnSessionMeta>()
      let stored: StoredVectors | null = null
      const forget = (ns: string): void => {
        for (const child of new Set([turnsNamespace(ns), ...currentChildren])) {
          deps.harness.dropNamespace(child)
        }
      }
      const adopt = (ns: string): void => {
        if (current !== null && current !== ns) forget(current)
        forget(ns)
        current = ns
        currentChildren = []
        meta = new Map()
      }

      return {
        name,
        describe,
        adapter: BUILTIN,
        lexicalOnly: true,
        async reset(ns) {
          adopt(ns)
        },
        async ingest(ns, sessions) {
          adopt(ns)
          const memories: CorpusMemory[] = []
          const children = new Set<string>()
          for (const session of sessions) {
            const turns = turnsOf(session)
            meta.set(session.id, { id: session.id, createdAt: session.createdAt, turns })
            // hybrid keeps one namespace per session so a snippet recall can be run
            // inside a candidate session; the flat system ranks all turns at once
            const namespace = hybrid ? `${turnsNamespace(ns)}//${session.id}` : turnsNamespace(ns)
            children.add(namespace)
            for (let start = 0; start < turns.length; start++) {
              memories.push({
                id: turnMemoryId(session.id, start),
                namespace,
                content: turns
                  .slice(start, start + ingestWindow)
                  .map(turnText)
                  .join('\n'),
                type: 'note',
                tags: [
                  ...(session.tags ?? []),
                  `session:${session.id}`,
                  `turn:${start}`,
                  `date:${turnDayTag(session.createdAt)}`,
                ],
                created_at: session.createdAt ?? 0,
              })
            }
          }
          if (memories.length > 0) {
            const corpus: Corpus = { name: 'turn-ingest', seed: deps.seed, memories, queries: [] }
            await deps.harness.seedCorpus(corpus, { mode: 'raw' })
          }
          writeCalls += memories.length
          currentChildren = [...children]
          stored = storedVectorsOf(deps.harness, { memories: [turnsNamespace(ns)] })
        },
        async retrieve(ns, query, budgetChars) {
          const localId = (id: string): string => deps.harness.localIdOf(id)
          const { ms, value } = await latencyMsAsync(async () => {
            const hits: TurnHit[] = []
            const trace: string[] = []
            const aggregation = !hybrid && statementsFirst && isAggregationQuery(query)
            if (hybrid) {
              const sessionsFound = await deps.harness.runRecall({
                query,
                project_path: ns,
                budget_chars: budgetChars,
                limit: deps.topK,
                mode: 'fused',
              })
              const candidateSessions = sessionsFound.memories
                .map((memory) => localId(memory.id))
                .filter((id) => meta.has(id))
              trace.push(`candidateSessions=${candidateSessions.length}`)
              for (const sessionRef of candidateSessions) {
                const found = await deps.harness.runRecall({
                  query,
                  project_path: `${turnsNamespace(ns)}//${sessionRef}`,
                  budget_chars: budgetChars * CANDIDATE_BUDGET_MULTIPLE,
                  limit: snippetsPerSession,
                  mode: 'fused',
                })
                for (const memory of found.memories) {
                  const hit = parseTurnMemoryId(localId(memory.id))
                  if (hit && hit.sessionRef === sessionRef && meta.has(hit.sessionRef)) hits.push(hit)
                }
              }
            } else {
              const found = await deps.harness.runRecall({
                query,
                project_path: turnsNamespace(ns),
                budget_chars: budgetChars * CANDIDATE_BUDGET_MULTIPLE,
                limit: candidates,
                mode: 'fused',
              })
              for (const memory of found.memories) {
                const hit = parseTurnMemoryId(localId(memory.id))
                if (hit && meta.has(hit.sessionRef)) hits.push(hit)
              }
              trace.push(
                aggregation
                  ? `aggregation=true, turnsFound=${found.memories.length}`
                  : `turnsFound=${found.memories.length}`
              )
            }
            const assembled = assembleTurnContext({
              hits,
              sessions: meta,
              budgetChars,
              ingestWindow,
              renderWindow,
              statementsFirst: aggregation,
              reserveTopHits,
            })
            return { assembled, trace }
          })
          const { assembled, trace } = value
          return {
            context: assembled.context,
            blocks: assembled.blocks,
            items: assembled.items,
            retrievalMs: ms,
            note:
              `hits=${assembled.turnsServed}, sessions=${assembled.sessionsServed}, ` +
              `skipped=${assembled.skippedSessions}, used=${assembled.usedChars}/${budgetChars} chars` +
              (trace.length > 0 ? `, ${trace.join(', ')}` : ''),
          }
        },
        cost: () => ({ writeCalls, writeTokens: 0 }),
        storedVectors: () => stored,
        async close() {
          if (current !== null) forget(current)
          current = null
          currentChildren = []
          meta = new Map()
        },
      }
    },
  }
}

/** one memory per session; the suite may already have seeded the namespace, then it is left alone */
async function ingestSessionMemories(
  deps: SystemDeps,
  ns: string,
  sessions: SystemSession[]
): Promise<void> {
  if (namespaceRows(deps.harness, ns) > 0) return
  await deps.harness.seedCorpus(
    {
      name: 'system-ingest',
      seed: deps.seed,
      memories: sessions.map((session) => ({
        id: session.id,
        namespace: ns,
        content: session.text,
        type: 'note',
        tags: session.tags ?? [],
        created_at: session.createdAt ?? 0,
      })),
      queries: [],
    },
    { mode: 'raw', embed: deps.harness.vectorsAvailable }
  )
}

/** one episode per turn, keyed so a re-ingest of the same session is a no-op */
async function ingestTurnEpisodes(
  deps: SystemDeps,
  ns: string,
  sessions: SystemSession[],
  vectorsAvailable: boolean
): Promise<number> {
  let ingested = 0
  for (const session of sessions) {
    const turns = turnsOf(session)
    if (turns.length === 0) continue
    const result = await ingestEpisodes(deps.harness.db, {
      namespace: ns,
      source: EPISODE_SOURCE,
      items: turns.map((turn, index) => ({
        external_id: turnMemoryId(session.id, index),
        content: turnText(turn),
        session_id: session.id,
        role: turn.role === '' ? undefined : turn.role,
        turn_index: index,
        occurred_at: session.createdAt ?? 0,
      })),
      origin: 'eval-system',
      vectorsAvailable,
      now: deps.harness.now,
    })
    ingested += result.ingested
  }
  return ingested
}

/**
 * assemble() under the qa recipe. with episodes on, every turn is ingested beside the
 * session memories, which is what a deployed store holds and what the recipe is built for
 */
function assembleSystemFactory(
  name: string,
  options: { episodes: boolean; quotas?: AssembleOptions['quotas']; note?: string }
): SystemFactory {
  const describe =
    (options.episodes
      ? 'engram in process: session memories plus one episode per turn, served by assemble() under the qa recipe'
      : 'engram in process: assemble() under the qa recipe, sections packed to the same budget') +
    (options.note ? `; ${options.note}` : '')
  return {
    name,
    describe,
    create(deps) {
      let writeCalls = 0
      let stored: StoredVectors | null = null
      // the turns this system wrote go when it moves on or closes: a system that shares
      // the namespace must never read them
      let current: string | null = null
      const drop = (ns: string): void => {
        if (options.episodes) deleteEpisodes(deps.harness.db, { namespace: ns })
      }
      const adopt = (ns: string): void => {
        if (current !== null && current !== ns) drop(current)
        current = ns
      }
      return {
        name,
        describe,
        adapter: BUILTIN,
        async reset(ns) {
          adopt(ns)
          drop(ns)
        },
        async ingest(ns, sessions) {
          adopt(ns)
          writeCalls += sessions.length
          await ingestSessionMemories(deps, ns, sessions)
          if (options.episodes) {
            writeCalls += await ingestTurnEpisodes(deps, ns, sessions, deps.harness.vectorsAvailable)
          }
          stored = storedVectorsOf(deps.harness, {
            memories: [ns],
            ...(options.episodes ? { episodes: [ns] } : {}),
          })
        },
        async retrieve(ns, query, budgetChars) {
          const { ms, value } = await latencyMsAsync(() =>
            assemble(deps.harness.db, deps.harness.store, deps.harness.search, {
              scope: ns,
              query,
              budgetChars,
              recipe: 'qa',
              ...(options.quotas ? { quotas: options.quotas } : {}),
            })
          )
          const blocks = value.sections.flatMap((section) =>
            section.items.map((item) => item.text)
          )
          const memories = value.sections.find((section) => section.kind === 'memories')
          return {
            context: blocks.join('\n\n'),
            blocks,
            items: (memories?.items ?? []).map((item) => ({
              text: item.text,
              id: item.id,
              ref: deps.harness.localIdOf(item.id),
            })),
            retrievalMs: ms,
            note:
              `recipe=qa, sections=${value.trace.channels.join('+')}, ` +
              `used=${value.accounting.used}/${value.accounting.budget} chars, ` +
              `dropped=${value.accounting.dropped}, deduped=${value.accounting.deduped}, ` +
              `degraded=${value.degraded.length}`,
          }
        },
        cost: () => ({ writeCalls, writeTokens: 0 }),
        storedVectors: () => stored,
        async close() {
          if (current !== null) drop(current)
          current = null
        },
      }
    },
  }
}

export const engramAssembleSystem = assembleSystemFactory('engram-assemble', { episodes: false })
export const engramQaSystem = assembleSystemFactory('engram-qa', { episodes: true })

const NO_ROOM = { budgetShare: 0, limit: 0 }

/** the qa recipe with only its evidence section left: the episodes arm, served through assemble */
export const engramQaEvidenceSystem = assembleSystemFactory('engram-qa-evidence', {
  episodes: true,
  quotas: { memories: NO_ROOM, summaries: NO_ROOM },
  note: 'memories and summaries sections zeroed',
})

/** the same with the session-group cap lifted, to tell the cap from the section mix */
export const engramQaEvidenceWideSystem = assembleSystemFactory('engram-qa-evidence-wide', {
  episodes: true,
  quotas: { memories: NO_ROOM, summaries: NO_ROOM, evidence: { limit: 100 } },
  note: 'memories and summaries zeroed, evidence group cap 100',
})

export interface EpisodeSystemOptions {
  /** how the episode assembly spends the budget, resolved per question the way a recipe resolves it */
  allocation: RecipeAllocation
  /** false: ingest and rank with no vectors at all, the lexical-only counterpart */
  vectors?: boolean
}

/**
 * the engine's own evidence layer: every turn goes in through ingestEpisodes and out
 * through the engine's episode assembly — the same granularity, recipe and budget as
 * engram-turns, with the evidence in its own table instead of one memory per turn.
 */
export function episodeSystemFactory(name: string, options: EpisodeSystemOptions): SystemFactory {
  const vectors = options.vectors !== false
  const describe =
    'episodes ingested through ingestEpisodes, ranked by the episodes channel and served ' +
    'as dated session groups under the budget' +
    `; allocation ${describeAllocation(options.allocation)}` +
    (vectors ? '' : '; no vectors are stored or read (the lexical-only counterpart)')
  return {
    name,
    describe,
    lexicalOnly: !vectors,
    create(deps) {
      const vectorsAvailable = deps.harness.vectorsAvailable && vectors
      let writeCalls = 0
      let current: string | null = null
      let stored: StoredVectors | null = null
      const drop = (ns: string): void => {
        deleteEpisodes(deps.harness.db, { namespace: ns })
      }
      const adopt = (ns: string): void => {
        if (current !== null && current !== ns) drop(current)
        current = ns
      }
      return {
        name,
        describe,
        adapter: BUILTIN,
        lexicalOnly: !vectors,
        async reset(ns) {
          adopt(ns)
          drop(ns)
        },
        async ingest(ns, sessions) {
          adopt(ns)
          writeCalls += await ingestTurnEpisodes(deps, ns, sessions, vectorsAvailable)
          stored = storedVectorsOf(deps.harness, { episodes: [ns] })
        },
        async retrieve(ns, query, budgetChars) {
          const allocation = allocationForQuery(options.allocation, query)
          const { ms, value } = await latencyMsAsync(() =>
            retrieveEpisodeContext({
              db: deps.harness.db,
              vectorsAvailable,
              query,
              namespace: ns,
              budget_chars: budgetChars,
              candidates: TURN_CANDIDATES,
              ingest_window: 1,
              render_window: TURN_RENDER_WINDOW,
              now: deps.harness.now,
              allocation: allocation.policy,
              reserve_top_hits: allocation.reserveTopHits,
            })
          )
          // a deferred ingest leaves rows without vectors; the served context is then
          // lexical, and the note says so instead of looking like a full vector run
          const unembedded = unembeddedEpisodeCount(deps.harness.db, { namespace: ns })
          const policy =
            `allocation=${allocation.policy}` +
            (allocation.reserveTopHits > 0 ? `+reserve${allocation.reserveTopHits}` : '')
          return {
            context: value.context,
            blocks: value.blocks,
            items: value.lines.map((line) => ({
              text: line.content,
              ref: line.session_id,
              id: line.episode_id,
              turn: line.turn_index,
            })),
            retrievalMs: ms,
            note: `${value.note}, ${policy}` + (unembedded > 0 ? `; unembedded=${unembedded}` : ''),
          }
        },
        cost: () => ({ writeCalls, writeTokens: 0 }),
        storedVectors: () => stored,
        async close() {
          if (current !== null) drop(current)
          current = null
        },
      }
    },
  }
}

function describeAllocation(allocation: RecipeAllocation): string {
  const describe = (choice: AllocationChoice): string =>
    `${choice.policy}${choice.reserveTopHits ? `+reserve${choice.reserveTopHits}` : ''}`
  const rules = Object.entries(allocation.archetypes ?? {}).map(
    ([archetype, choice]) => `${archetype}=${describe(choice)}`
  )
  return [
    ...(rules.length > 0 ? [`${describe(allocation.default)} by default`, rules.join(', ')] : [
      describe(allocation.default),
    ]),
  ].join('; ')
}

/** one source per system, so a re-ingest of the same id cannot collide across systems */
const EPISODE_SOURCE = 'eval-turns'

const RANK_GREEDY: RecipeAllocation = { default: { policy: 'rank-greedy' } }

/** the shipped order: one session at a time, best hit rank first */
export const engramEpisodesSystem = episodeSystemFactory('engram-episodes', { allocation: RANK_GREEDY })

/** the episodes layer with vectors off: what the lexical-only 0.734 turn run actually was */
export const engramEpisodesFtsSystem = episodeSystemFactory('engram-episodes-fts', {
  allocation: RANK_GREEDY,
  vectors: false,
})

/** role-agnostic: every reached session's densest turn before any session's second */
export const engramEpisodesBreadthSystem = episodeSystemFactory('engram-episodes-breadth', {
  allocation: { default: { policy: 'breadth-first' } },
})

/** the same, with the top hit's window bought first */
export const engramEpisodesBreadthReserveSystem = episodeSystemFactory(
  'engram-episodes-breadth-reserve',
  { allocation: { default: { policy: 'breadth-first', reserveTopHits: 1 } } }
)

/** the eval rule: an aggregation-shaped question pays for statements, others keep the shipped order */
export const engramEpisodesStatementsSystem = episodeSystemFactory('engram-episodes-statements', {
  allocation: {
    default: { policy: 'rank-greedy' },
    archetypes: { aggregation: { policy: 'statements-first', reserveTopHits: 1 } },
  },
})

/** role-agnostic, only where the query reads as an aggregation: the shipped candidate */
export const engramEpisodesRoutedSystem = episodeSystemFactory('engram-episodes-routed', {
  allocation: {
    default: { policy: 'rank-greedy' },
    archetypes: { aggregation: { policy: 'breadth-first', reserveTopHits: 1 } },
  },
})

export const engramTurnsSystem: SystemFactory = turnSystemFactory('engram-turns', { ingestWindow: 1 })
export const engramTurnsWindowSystem: SystemFactory = turnSystemFactory('engram-turns-w3', {
  ingestWindow: 3,
})
export const engramHybridSystem: SystemFactory = turnSystemFactory('engram-hybrid', { hybrid: true })

/** top-hit windows an aggregation question buys before its statements */
export const AGGREGATION_RESERVED_HITS = 1

/** an aggregation-shaped question (count, sum, list) spends the budget on statements */
export const engramTurnsAggregateSystem: SystemFactory = turnSystemFactory('engram-turns-agg', {
  ingestWindow: 1,
  statementsFirst: true,
  reserveTopHits: AGGREGATION_RESERVED_HITS,
})

/** query-only negative control: the reader gets no history, even when the shared db is seeded */
export const noMemorySystem: SystemFactory = {
  name: 'no-memory',
  describe: 'no history or retrieved memory; the query-only negative control',
  lexicalOnly: true,
  create() {
    return {
      name: 'no-memory',
      describe: noMemorySystem.describe,
      adapter: BUILTIN,
      lexicalOnly: true,
      async reset() {},
      async ingest() {},
      async retrieve() {
        return {
          context: '',
          blocks: [],
          items: [],
          retrievalMs: 0,
          note: 'memory disabled; no history supplied',
        }
      },
      cost: () => ({ writeCalls: 0, writeTokens: 0 }),
      async close() {},
    }
  },
}

export const fullContextSystem: SystemFactory = {
  name: 'full-context',
  describe: 'every session in the haystack, no retrieval and no budget (the ceiling)',
  create() {
    const byNamespace = new Map<string, SystemSession[]>()
    return {
      name: 'full-context',
      describe: fullContextSystem.describe,
      adapter: BUILTIN,
      async reset(ns) {
        byNamespace.delete(ns)
      },
      async ingest(ns, sessions) {
        byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), ...sessions])
      },
      async retrieve(ns) {
        const sessions = byNamespace.get(ns) ?? []
        const blocks = sessions.map((session) => session.text)
        return {
          context: blocks.join('\n\n'),
          blocks,
          items: sessions.map((session) => ({ text: session.text, ref: session.id })),
          retrievalMs: 0,
          note: `${sessions.length} sessions, no budget`,
        }
      },
      cost: () => ({ writeCalls: 0, writeTokens: 0 }),
      async close() {},
    }
  },
}

export const naiveRagSystem: SystemFactory = {
  name: 'naive-rag',
  describe: 'lexical top-k chunks over the sessions, packed to the budget (the floor)',
  create(deps) {
    const byNamespace = new Map<string, SystemSession[]>()
    return {
      name: 'naive-rag',
      describe: naiveRagSystem.describe,
      adapter: BUILTIN,
      async reset(ns) {
        byNamespace.delete(ns)
      },
      async ingest(ns, sessions) {
        byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), ...sessions])
      },
      async retrieve(ns, query, budgetChars) {
        const chunks = chunkSessions(byNamespace.get(ns) ?? [], NAIVE_CHUNK_CHARS)
        const { ms, value: ranked } = await latencyMsAsync(async () =>
          rankChunks(chunks, query, deps.topK)
        )
        const blocks: string[] = []
        const items: RetrievedItem[] = []
        let used = 0
        for (const rank of ranked) {
          const chunk = chunks[rank.index]
          if (used + chunk.text.length > budgetChars) break
          blocks.push(chunk.text)
          items.push({ text: chunk.text, ref: chunk.ref })
          used += chunk.text.length
        }
        return {
          context: blocks.join('\n\n'),
          blocks,
          items,
          retrievalMs: ms,
          note: `chunks=${chunks.length}, kept=${blocks.length}, used=${used}/${budgetChars} chars`,
        }
      },
      cost: () => ({ writeCalls: 0, writeTokens: 0 }),
      async close() {},
    }
  },
}

export const SYSTEMS: SystemFactory[] = [
  engramSystem,
  engramAssembleSystem,
  engramQaSystem,
  engramQaEvidenceSystem,
  engramQaEvidenceWideSystem,
  engramTurnsSystem,
  engramTurnsWindowSystem,
  engramHybridSystem,
  engramTurnsAggregateSystem,
  engramEpisodesSystem,
  engramEpisodesFtsSystem,
  engramEpisodesBreadthSystem,
  engramEpisodesBreadthReserveSystem,
  engramEpisodesStatementsSystem,
  engramEpisodesRoutedSystem,
  noMemorySystem,
  fullContextSystem,
  naiveRagSystem,
]

/**
 * the systems a bare `--qa` run enters: the turn-granularity systems are opt-in, so an
 * existing command line keeps its cost and its checkpoint
 */
export const DEFAULT_SYSTEM_NAMES = ['engram', 'full-context', 'naive-rag']

export function systemNames(): string[] {
  return SYSTEMS.map((system) => system.name)
}

export function defaultSystemNames(): string[] {
  return [...DEFAULT_SYSTEM_NAMES]
}

export interface SessionChunk {
  ref: string
  text: string
}

/** chunks of at most `size` characters, cut at line breaks, each keeping its session id */
export function chunkSessions(sessions: SystemSession[], size: number): SessionChunk[] {
  const chunks: SessionChunk[] = []
  let current = ''
  let ref = ''
  const flush = (): void => {
    if (current.length > 0) chunks.push({ ref, text: current })
    current = ''
  }
  for (const session of sessions) {
    for (const line of session.text.split('\n')) {
      if (line.length > size) {
        flush()
        for (let i = 0; i < line.length; i += size) chunks.push({ ref: session.id, text: line.slice(i, i + size) })
        continue
      }
      if (current.length > 0 && current.length + line.length + 1 > size) flush()
      current = current.length === 0 ? line : `${current}\n${line}`
      if (current !== '') ref = session.id
    }
    flush()
  }
  flush()
  return chunks
}

/** query terms: lowercase alphanumeric words of two characters or more */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2)
}

export interface ChunkRank {
  index: number
  score: number
}

/**
 * plain lexical ranking: term frequency in the chunk, ties by file order. no idf, no
 * fusion, no reranking — this is the naive comparison.
 */
export function rankChunks(chunks: SessionChunk[], query: string, topK: number): ChunkRank[] {
  const terms = queryTerms(query)
  const scored = chunks.map((chunk, index) => {
    const lower = chunk.text.toLowerCase()
    let score = 0
    for (const term of terms) {
      let at = lower.indexOf(term)
      while (at !== -1) {
        score++
        at = lower.indexOf(term, at + term.length)
      }
    }
    return { index, score }
  })
  scored.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
  return scored.slice(0, Math.max(0, topK))
}

/** a spec is a builtin name, or `mcp:<config-path>` for a server behind the adapter */
export function isMcpSpec(spec: string): boolean {
  return spec.startsWith('mcp:')
}

export function specConfigPath(spec: string): string {
  const path = spec.slice('mcp:'.length).trim()
  if (path === '') throw new EvalSetupError('mcp: needs an adapter config path, e.g. mcp:eval/adapters/engram-mcp.json')
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path)
}

/** a report-file slug for a spec: the adapter config's own name when it has one */
export function systemSpecSlug(spec: string): string {
  if (!isMcpSpec(spec)) return spec
  const path = specConfigPath(spec)
  let name = basename(path, extname(path))
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown }
    if (typeof parsed.name === 'string' && parsed.name.trim() !== '') name = parsed.name.trim()
  } catch {
    // unreadable or invalid: the file's basename still names the run
  }
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

/**
 * `specs` in caller order; an empty list means every builtin, in registry order. every
 * spec is named and validated before a server is started, so a typo costs nothing.
 */
export async function createSystems(
  specs: string[] | undefined,
  deps: SystemDeps
): Promise<MemorySystem[]> {
  const requested = specs && specs.length > 0 ? specs : systemNames()
  const names = requested.map((spec) =>
    isMcpSpec(spec) ? loadAdapterConfig(specConfigPath(spec)).config.name : builtinFactory(spec).name
  )
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate) {
    throw new EvalSetupError(
      `two systems are both named "${duplicate}" — an mcp config's "name" must be unique in a run`
    )
  }
  const systems: MemorySystem[] = []
  try {
    for (const spec of requested) {
      systems.push(
        isMcpSpec(spec)
          ? await createMcpSystemFrom(spec, deps)
          : builtinFactory(spec).create(deps)
      )
    }
  } catch (error) {
    await closeAll(systems)
    throw error
  }
  return systems
}

/** --systems wins, then the --readers alias; --qa alone means the default set, retrieval-only means none */
export function requestedSystemSpecs(ctx: { systems?: string[]; readers?: string[]; qa?: boolean }): string[] {
  if (ctx.systems?.length) return ctx.systems
  if (ctx.readers?.length) return ctx.readers
  return ctx.qa === true ? defaultSystemNames() : []
}

// the code that decides what a builtin serves: an edit here must not resume old rows
const BUILTIN_CODE_ROOTS = ['src', 'eval/lib', 'eval/adapters']

let builtinHash: string | null = null

export function builtinCodeHash(): string {
  if (builtinHash !== null) return builtinHash
  const hash = createHash('sha256')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|mjs|json)$/.test(entry.name)) files.push(path)
    }
  }
  for (const root of BUILTIN_CODE_ROOTS) walk(join(REPO_ROOT, root))
  for (const file of files.sort()) {
    hash.update(relative(REPO_ROOT, file)).update('\0').update(readFileSync(file)).update('\0')
  }
  builtinHash = hash.digest('hex').slice(0, 12)
  return builtinHash
}

// a system enters a checkpoint key as name@hash: an edited adapter config or builtin code
// makes the rows it produced unusable instead of silently comparable
export function systemKey(system: MemorySystem): string {
  const id = system.adapter.configHash === '' ? `builtin-${builtinCodeHash()}` : system.adapter.configHash
  return `${system.name}@${id}`
}

/** pre-flight: a typo in a name fails before a dataset or a server is touched */
export function checkSystemSpecs(specs: string[]): void {
  for (const spec of specs) {
    if (isMcpSpec(spec)) specConfigPath(spec)
    else builtinFactory(spec)
  }
}

function builtinFactory(spec: string): SystemFactory {
  const factory = SYSTEMS.find((system) => system.name === spec)
  if (!factory) {
    throw new EvalSetupError(
      `unknown system "${spec}" — known: ${systemNames().join(', ')}, mcp:<config-path>`
    )
  }
  return factory
}

async function createMcpSystemFrom(spec: string, deps: SystemDeps): Promise<MemorySystem> {
  const loaded = loadAdapterConfig(specConfigPath(spec))
  return createMcpSystem({
    config: loaded.config,
    adapter: { kind: 'mcp', configHash: loaded.hash, source: loaded.source },
    topK: deps.topK,
  })
}

export interface SystemQuestionInput {
  harness: EvalHarness
  system: MemorySystem
  /** the question's namespace; the system's own rows belong below it */
  namespace: string
  sessions: SystemSession[]
  query: string
  budgetChars: number
}

/**
 * one system's turn on one question: what the last system wrote (children below the
 * question, episodes in it) goes before this one ingests, and this one's once it has
 * answered, so a system's numbers never move when the set changes.
 */
export async function runSystemQuestion(input: SystemQuestionInput): Promise<RetrievalResult> {
  const { harness, system, namespace, sessions, query, budgetChars } = input
  harness.dropSystemRows(namespace)
  try {
    await system.reset(namespace)
    await system.ingest(namespace, sessions)
    return await system.retrieve(namespace, query, budgetChars)
  } finally {
    harness.dropSystemRows(namespace)
  }
}

/**
 * many queries over one shared corpus, one system at a time: each ingests once, answers
 * every query and is torn down before the next, so no system ranks against another's rows.
 * returns [queryIndex][systemIndex]
 */
export async function retrieveEachSystem(input: {
  harness: EvalHarness
  systems: MemorySystem[]
  namespace: string
  sessions: SystemSession[]
  queries: string[]
  budgetChars: number
}): Promise<RetrievalResult[][]> {
  const { harness, systems, namespace, sessions, queries, budgetChars } = input
  const out: RetrievalResult[][] = queries.map(() => [])
  for (const system of systems) {
    harness.dropSystemRows(namespace)
    try {
      await system.reset(namespace)
      await system.ingest(namespace, sessions)
      for (let q = 0; q < queries.length; q++) {
        out[q].push(await system.retrieve(namespace, queries[q], budgetChars))
      }
    } finally {
      harness.dropSystemRows(namespace)
    }
  }
  return out
}

export async function closeAll(systems: MemorySystem[]): Promise<void> {
  for (const system of systems) {
    try {
      await system.close()
    } catch {
      // a failed teardown must not hide the run's own outcome
    }
  }
}
