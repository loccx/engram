import { z } from 'zod'
import { getDatabase } from '../db/init.js'
import { MemoryStore } from '../memory/store.js'
import { MemorySearch } from '../memory/search.js'
import type { SearchOptions } from '../memory/search.js'
import { recordsAccessOnExplicitFetch } from '../memory/search/scoring.js'
import { SessionManager } from '../session/manager.js'
import { resolveNamespace } from '../namespace/resolver.js'
import { getAdjudicationQueue } from '../contradictions/runtime.js'
import {
  appendTaskEvent,
  closeTask,
  createTask,
  getTask,
  listTaskEvents,
  listTasks,
  taskSummary,
  updateTask,
} from '../tasks/store.js'
import { DEFAULT_HANDOFF_CHARS, handoff } from '../tasks/brief.js'
import { sessionStartPayload } from '../delivery/tasks.js'
import { CLOSED_STATUSES, type TaskDelta, type TaskStartInput, type TaskStatus } from '../tasks/types.js'
import { getImportanceQueue } from '../importance/runtime.js'
import {
  enrichMemories,
  enrichSearchResults,
  type EnrichedSearchResult,
  truncateContent,
  summarizeClusters,
  type RecallSignal,
} from '../memory/enrichment.js'
import { getDigest, refreshDigest } from '../memory/digest.js'
import { parseNamespacePath, ensureNode, ancestors, children } from '../namespace/tree.js'
import { childRoster } from '../memory/nav.js'
import { inferScope } from '../memory/scope-inference.js'
import { packWithinBudget, type RecallMode } from '../memory/recall.js'
import {
  assemble,
  recallViaAssemble,
  DEFAULT_ASSEMBLE_BUDGET_CHARS,
  DEFAULT_RECIPE_NAME,
} from '../memory/assemble.js'
import { currentState, getState, normalizeStateKey } from '../memory/state.js'
import { queryAssertions, type QueryAssertionsInput } from '../memory/assertions/index.js'
import {
  citedEpisodes,
  countMatchingEpisodes,
  deleteEpisodes,
  episodeVectorsAvailable,
  ingestEpisodes,
  linkTaskEpisodes,
  type EpisodeDeleteCounts,
  type EpisodeDeleteSelector,
  type IngestEpisodeItem,
  type IngestEpisodesInput,
} from '../memory/episodes.js'
import {
  recordRetrievalEvent,
  WEAK_RESULT_THRESHOLD,
  type RetrievalBudgetAccounting,
} from '../metrics/retrieval-log.js'
import { buildMemoryHealth, explainMiss } from './health.js'
import type { Session } from '../session/types.js'
import {
  enqueueEndSessionMaintenance,
  enqueueEpisodeReembed,
  getMaintenanceStatus,
  isMaintenanceEnabled,
  runPendingMaintenanceJobs,
} from '../maintenance/jobs.js'
import { getMetricsTracker, type MetricsTracker } from '../metrics/tracker.js'
import { recordColdFaults } from '../metrics/eviction-log.js'
import { unarchiveMemory } from '../memory/cold-tier.js'
import { logger } from '../utils/logger.js'
import { logAudit } from '../brains/audit.js'
import type {
  MemoryType,
  StoreMemoryInput,
  UpdateMemoryPatch,
  ReviseMemoryInput,
} from '../memory/types.js'
import { SCHEMAS } from './schemas.js'
import { listLocalBrains, searchBrain, getBrainMemory, markShareable } from '../brains/mcp.js'
import type { Memory } from '../memory/types.js'
import {
  auditCrossOwnerRead,
  authorizeNamespace,
  coveredAncestors,
  currentCaller,
  currentTool,
  derivedVisible,
  holdsVerb,
  memoryAccess,
  rowVisible,
  toolAccess,
  visibilityOf,
  WITHHELD_DIGEST,
  WITHHELD_GUIDE,
  WITHHELD_TOPICS,
  withRequest,
  type CallerScope,
} from '../memory/access.js'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

/** current-state section: a handful of slots, previews only, fitted to what is left */
const STATE_SECTION_SLOTS = 5
const STATE_SECTION_PREVIEW_CHARS = 160
const STATE_SECTION_CHARS_NO_BUDGET = 2000

interface StateSectionEntry {
  key: string
  current: { id: string; value: string; valid_from: number } | null
  prior: { id: string; value: string; valid_until: number | null } | null
}

function clipStateValue(text: string): string {
  return text.length > STATE_SECTION_PREVIEW_CHARS
    ? `${text.slice(0, STATE_SECTION_PREVIEW_CHARS)}…`
    : text
}

function stateEntryChars(entry: StateSectionEntry): number {
  return (
    entry.key.length +
    (entry.current?.value.length ?? 0) +
    (entry.prior?.value.length ?? 0)
  )
}

/** "what is true now" for the namespace, empty when nothing carries a slot key */
function buildStateSection(
  db: import('better-sqlite3').Database,
  namespace: string,
  options: { asOf?: number; remainingChars: number }
): { slots: StateSectionEntry[]; dropped: number } {
  const slots = currentState(db, namespace, {
    limit: STATE_SECTION_SLOTS,
    asOf: options.asOf,
  })
  const out: StateSectionEntry[] = []
  let used = 0
  for (const slot of slots) {
    const entry: StateSectionEntry = {
      key: slot.key,
      current: slot.current
        ? {
            id: slot.current.memory_id,
            value: clipStateValue(slot.current.content),
            valid_from: slot.current.valid_from,
          }
        : null,
      prior: slot.prior
        ? {
            id: slot.prior.memory_id,
            value: clipStateValue(slot.prior.content),
            valid_until: slot.prior.valid_until ?? slot.prior.superseded_at,
          }
        : null,
    }
    const chars = stateEntryChars(entry)
    if (used + chars > options.remainingChars) continue
    out.push(entry)
    used += chars
  }
  return { slots: out, dropped: slots.length - out.length }
}

function stateSectionFields(section: { slots: StateSectionEntry[]; dropped: number }): Record<string, unknown> {
  if (section.slots.length === 0) return {}
  return {
    state: section.slots,
    ...(section.dropped > 0 ? { state_dropped: section.dropped } : {}),
  }
}

interface Services {
  db: import('better-sqlite3').Database
  store: MemoryStore
  search: MemorySearch
  sessions: SessionManager
  metrics: MetricsTracker
}

export interface RequestContext {
  urlProject?: string
  urlNamespace?: string
  /** the credential the request arrived with; absent is the local owner */
  caller?: CallerScope
}

/** a store-wide tool acts on every namespace, so no grant can cover it */
function assertLocalOwner(tool: string): void {
  const caller = currentCaller()
  if (!caller.localOwner) {
    throw new Error(`${tool} acts on the whole store and is not covered by a namespace grant`)
  }
}

/**
 * a row addressed by id is checked like a namespace, and a refusal answers exactly as a
 * missing id does, so an id cannot be probed for existence
 */
const TASK_TOOLS = new Set(['task_get', 'task_update', 'task_close', 'task_handoff'])

function notFound(tool: string, id: string): string {
  return `${TASK_TOOLS.has(tool) ? 'Task' : 'Memory'} ${id} not found`
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

function err(message: string): ToolResult {
  // isError is how clients tell a failed tool from a payload that has an error
  // field; without it a refusal reads as a normal result
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }
}

/** lean projection: the full row carries fields a caller never reads */
function toLeanContextEntry(m: EnrichedSearchResult) {
  return {
    id: m.id,
    content: m.content,
    type: m.type,
    importance: m.importance,
    tags: m.tags,
    created_at: m.created_at,
    namespace: m.namespace,
    pinned: m.pinned === true,
    score: m.score,
    ...(m.recall_reason ? { recall_reason: m.recall_reason } : {}),
  }
}

const ROSTER_PREVIEW_CHARS = 160

/** the no-query form never serves full content, so an accidental call stays small */
function toRosterEntry(m: Memory) {
  return {
    id: m.id,
    type: m.type,
    importance: m.importance,
    created_at: m.created_at,
    pinned: m.pinned === true,
    tags: m.tags,
    preview:
      m.content.length > ROSTER_PREVIEW_CHARS
        ? `${m.content.slice(0, ROSTER_PREVIEW_CHARS)}…`
        : m.content,
  }
}

// funnel retrieval (docs/architecture.md): a leaf is rich at >= FUNNEL_K_MIN hits
// with a top score >= FUNNEL_THETA, otherwise retrieval ascends ancestor nav
// layers for guide entries
const FUNNEL_K_MIN = 3
const FUNNEL_THETA = 0.35
const GUIDE_EXCERPT_CHARS = 240

type FunnelScope = 'leaf' | 'funnel'

interface ScopeTraceEntry {
  namespace: string
  depth: number
  hits?: number
  top_score?: number | null
  action: 'searched' | 'skipped' | 'guide_only'
}

interface GuideEntry {
  namespace: string
  kind: 'digest' | 'cluster' | 'child_roster'
  source: string
  excerpt: string
}

/** token match against a parent's nav layer (digest + cluster summaries): at most
 *  two short excerpts, and a guide is navigation metadata, never a memory body */
function navGuideHits(db: import('better-sqlite3').Database, namespace: string, query: string): GuideEntry[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase())
  if (tokens.length === 0) return []

  const digest =
    (
      db
        .prepare('SELECT digest FROM namespace_nodes WHERE path = ?')
        .get(namespace) as { digest: string | null } | undefined
    )?.digest ?? ''
  const clusters = db
    .prepare(
      `SELECT summary FROM memory_clusters
       WHERE project_path = ? AND TRIM(summary) != ''
       ORDER BY updated_at DESC, id ASC`
    )
    .all(namespace) as Array<{ summary: string }>

  const sources: Array<{ kind: 'digest' | 'cluster'; text: string }> = []
  if (digest.trim()) sources.push({ kind: 'digest', text: digest })
  for (const row of clusters) sources.push({ kind: 'cluster', text: row.summary })

  const hits: GuideEntry[] = []
  for (const { kind, text } of sources) {
    if (hits.length >= 2) break
    const excerpt = navExcerpt(text, tokens)
    if (excerpt) hits.push({ namespace, kind, source: kind, excerpt })
  }
  return hits
}

function navExcerpt(text: string, tokens: string[]): string | null {
  const lower = text.toLowerCase()
  let first = -1
  for (const token of tokens) {
    const idx = lower.indexOf(token)
    if (idx >= 0 && (first === -1 || idx < first)) first = idx
  }
  if (first < 0) return null

  const half = Math.floor(GUIDE_EXCERPT_CHARS / 2)
  const start = Math.max(0, first - half)
  const end = Math.min(text.length, start + GUIDE_EXCERPT_CHARS)
  const raw = text.slice(start, end).replace(/\s+/g, ' ').trim()
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${raw}${suffix}`.slice(0, GUIDE_EXCERPT_CHARS)
}

function clipNavExcerpt(text: string): string {
  return text.length > GUIDE_EXCERPT_CHARS
    ? `${text.slice(0, GUIDE_EXCERPT_CHARS - 1)}…`
    : text
}

let _services: Services | null = null

function getServices(): Services {
  if (_services) return _services
  const dbm = getDatabase()
  const queue = getAdjudicationQueue(dbm.db, dbm.vectorsAvailable)
  const importanceQueue = getImportanceQueue(dbm.db)
  _services = {
    db: dbm.db,
    store: new MemoryStore(dbm.db, dbm.vectorsAvailable, queue, importanceQueue),
    search: new MemorySearch(dbm.db, dbm.vectorsAvailable),
    sessions: new SessionManager(dbm.db),
    metrics: getMetricsTracker(dbm.db),
  }
  return _services
}

export function resetServicesForTests(): void {
  _services = null
}

async function resolveProjectPath(
  args: Record<string, unknown>,
  ctx: RequestContext
): Promise<string> {
  const resolved = await resolveNamespace({
    argsNamespace: typeof args.namespace === 'string' ? args.namespace : undefined,
    argsProjectPath: typeof args.project_path === 'string' ? args.project_path : undefined,
    urlNamespace: ctx.urlNamespace,
    urlProject: ctx.urlProject,
  })
  // resolution order is unchanged; the credential decides whether the result is reachable
  return authorizeResolved(resolved.namespace)
}

/**
 * the resolved namespace must fall under a grant prefix carrying the verb the tool
 * needs. the argument may narrow the credential, never widen it, and the refusal names
 * only the namespace the caller supplied.
 */
function authorizeResolved(namespace: string): string {
  const trimmed = trimNamespace(namespace)
  const caller = currentCaller()
  const access = toolAccess(currentTool())
  if (access === 'owner') {
    assertLocalOwner(currentTool())
    return trimmed
  }
  if (!holdsVerb(caller, trimmed, access)) {
    throw new Error(authorizeNamespace(caller, trimmed, access) ?? 'not authorized')
  }
  return trimmed
}

/** the namespace a by-id row lives in, authorized for the verb the tool needs */
interface AccessRow {
  id: string
  namespace: string
  owner_principal?: string | null
  visibility?: string | null
}

/** the row's own namespace needs the verb, and a personal row has to be the caller's */
function mayReach(row: AccessRow, verb: 'read' | 'write' | 'share' | 'delete'): boolean {
  const caller = currentCaller()
  return holdsVerb(caller, trimNamespace(row.namespace), verb) && rowVisible(row, caller)
}

/** the by-id check for a memory, answering a refusal as a missing id */
function authorizeMemory(
  db: import('better-sqlite3').Database,
  id: string,
  verb: 'read' | 'write' | 'share' | 'delete'
): void {
  const row = memoryAccess(db, id)
  if (!row) return
  if (!mayReach(row, verb)) throw new Error(notFound(currentTool(), id))
}

/** a mutation returns canonical prose only within the caller's current read authority. */
function readableMutationMemory(db: import('better-sqlite3').Database, store: MemoryStore, id: string) {
  return db.transaction(() => {
    const row = memoryAccess(db, id)
    if (!row || !mayReach(row, 'read')) return null
    const memory = store.getById(id)
    if (!memory) return null
    const namespace = trimNamespace(row.namespace)
    auditCrossOwnerRead(db, { tool: currentTool(), namespace, ids: [id], channel: 'by-id' })
    const scope = currentCaller().localOwner ? {} : { namespace_subtree: namespace }
    return enrichMemories(db, [memory], Date.now(), scope)[0] ?? null
  }).deferred()
}

/** the same check for a task, whose row carries its own namespace and ownership */
function authorizeTask(task: AccessRow, verb: 'read' | 'write'): void {
  if (!mayReach(task, verb)) throw new Error(notFound(currentTool(), task.id))
}

/** a session belongs to the credential that opened it; the local owner's is the null one */
function sessionOwnedByCaller(session: { owner_principal: string | null }): boolean {
  const caller = currentCaller()
  return caller.localOwner
    ? session.owner_principal === null
    : session.owner_principal === caller.principalId
}

function trimNamespace(value: string): string {
  const trimmed = value.replace(/\/+$/, '')
  // the root is its own namespace: trimming it to '' would authorize nothing
  return trimmed === '' ? '/' : trimmed
}

/**
 * a task id is not a scope: when the call declares its own namespace it must be the
 * task's, or an id copied from another project writes there. an undeclared call is
 * trusted, since the id itself is unguessable.
 */
async function taskNamespaceMismatch(
  args: Record<string, unknown>,
  ctx: RequestContext,
  namespace: string
): Promise<string | null> {
  const declared =
    typeof args.namespace === 'string' && args.namespace.trim()
      ? args.namespace
      : typeof args.project_path === 'string' && args.project_path.trim()
        ? args.project_path
        : ''
  if (!declared) return null
  const resolved = trimNamespace(await resolveProjectPath(args, ctx))
  if (resolved === trimNamespace(namespace)) return null
  return `Task belongs to ${namespace}, not ${resolved}; drop the namespace argument or pass the task's own`
}

/** the session a task event and its close summary are attributed to */
async function sessionFor(sessions: SessionManager, namespace: string): Promise<string> {
  const current = sessions.getCurrentSession(namespace)
  if (current) return current.id
  return (await sessions.start({ project_path: namespace })).id
}

function asOfFromArgs(args: Record<string, unknown>): number | undefined {
  if (typeof args.as_of === 'number') return args.as_of
  return undefined
}

function beforeFromArgs(args: Record<string, unknown>): number | undefined {
  return typeof args.before === 'number' ? args.before : undefined
}

/** the token must be a standalone word, so 'payment' never matches scope 'payments' */
function contentMentionsScope(content: string, token: string): boolean {
  if (!token) return false
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-zA-Z0-9])${escaped}(?:[^a-zA-Z0-9]|$)`, 'i').test(content)
}

/**
 * close sessions idle past ENGRAM_SESSION_IDLE_MS and enqueue their end-of-session
 * work; without this a session opened by store_memory stays open forever, and
 * every job gated on end-of-session never runs
 */
function sweepIdleSessions(db: import('better-sqlite3').Database, sessions: SessionManager): Session[] {
  const swept = sessions.sweepIdle()
  for (const session of swept) {
    enqueueEndSessionMaintenance(db, session.id, session.project_path)
  }
  return swept
}

function asBudgetAccounting(packed: {
  budget: { total_chars: number; used_chars: number }
  dropped: { memories: number; topics: number; digest_chars_cut: number }
  truncated: { digest: boolean; memories: number; topics: number }
}): RetrievalBudgetAccounting {
  return {
    budget_chars: packed.budget.total_chars,
    used_chars: packed.budget.used_chars,
    dropped_memories: packed.dropped.memories,
    dropped_topics: packed.dropped.topics,
    digest_chars_cut: packed.dropped.digest_chars_cut,
    truncated_digest: packed.truncated.digest,
    truncated_memories: packed.truncated.memories,
    truncated_topics: packed.truncated.topics,
  }
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: RequestContext = {}
): Promise<ToolResult> {
  // every read below runs inside this scope, so a query that builds the shared namespace
  // clause inherits the caller's visibility predicate without being handed the caller
  return withRequest(ctx.caller ?? currentCaller(), name, () => runTool(name, args, ctx))
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: RequestContext = {}
): Promise<ToolResult> {
  try {
    const schema = SCHEMAS[name]
    if (schema) {
      const result = schema.safeParse(args)
        if (!result.success) {
          const issues = (result.error as z.ZodError).issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')
        return err(`Validation failed: ${issues}`)
      }
    }

    const { db, store, search, sessions, metrics } = getServices()

    switch (name) {
      case 'store_memory': {
        const content = args.content as string

        const project_path = await resolveProjectPath(args, ctx)

        // scope routing: explicit scope, else a word-boundary mention of a sibling
        // scope, else inference, else the project root
        let routedScope: string | null = null
        let routedVia: 'explicit' | 'mention' | 'inferred' | 'root' = 'root'
        let effectiveNamespace = project_path
        const explicitScope = typeof args.scope === 'string' ? (args.scope as string).trim() : ''
        if (explicitScope) {
          effectiveNamespace = `${project_path}//${explicitScope}`
          ensureNode(db, effectiveNamespace)
          routedVia = 'explicit'
        } else {
          const siblings = children(db, project_path).filter(
            (n) => n.is_synthetic && n.real_path === project_path
          )
          let best: { token: string; count: number } | null = null
          for (const node of siblings) {
            const token = parseNamespacePath(node.path).scope ?? ''
            if (token && contentMentionsScope(content, token)) {
              if (!best || node.memory_count > best.count) {
                best = { token, count: node.memory_count }
              }
            }
          }
          if (best) {
            routedScope = best.token
            effectiveNamespace = `${project_path}//${best.token}`
            ensureNode(db, effectiveNamespace)
            routedVia = 'mention'
          } else {
            const inferred = await inferScope(db, project_path, content)
            if (inferred.scope) {
              routedScope = inferred.scope
              effectiveNamespace = `${project_path}//${inferred.scope}`
              ensureNode(db, effectiveNamespace)
              routedVia = 'inferred'
            }
          }
        }

        // sweep first: a write after an idle window must open a new session, or
        // end-of-session maintenance never fires
        const sweptSessions = sweepIdleSessions(db, sessions)
        let sessionId = args.session_id as string | undefined

        if (!sessionId) {
          const current = sessions.getCurrentSession(project_path)
          sessionId = current?.id ?? (await sessions.start({ project_path })).id
        }

        const importanceProvided = typeof args.importance === 'number'
        const input: StoreMemoryInput = {
          content,
          session_id: sessionId,
          project_path: effectiveNamespace,
          type: (args.type as MemoryType) || 'note',
          importance: importanceProvided ? (args.importance as number) : 0.5,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
          adjudicateSync: args.adjudicate_sync === true,
          importanceProvided,
          procedure_meta: args.procedure_meta as StoreMemoryInput['procedure_meta'],
          origin: 'mcp',
          state_key: typeof args.state_key === 'string' ? args.state_key : undefined,
          visibility: visibilityOf(currentCaller(), args.visibility) ?? undefined,
        }
        const result = await store.store(input)
        // a refusal is an answer, not a broken tool: isError would hide the reason
        // and the corrective hint
        if (result.status === 'rejected') {
          return ok({
            status: 'rejected',
            rule: result.rule,
            reason: result.reason,
            hint: result.hint,
            ...(result.existing_id ? { existing_id: result.existing_id } : {}),
            namespace: effectiveNamespace,
          })
        }
        const memory = result
        // both before enriching, or the response reports the pre-write pinned value
        if (args.pinned === true) {
          store.setPinned(memory.id, true)
          Object.assign(memory, { pinned: true })
        }
        metrics.recordStore(content, effectiveNamespace)
        const [enriched] = enrichMemories(db, [memory])
        const response: Record<string, unknown> = {
          ...enriched,
          namespace: effectiveNamespace,
          routed_via: routedVia,
          status: memory.status,
        }
        if (routedScope) response.routed_scope = routedScope
        if (memory.warnings && memory.warnings.length > 0) {
          response.warnings = memory.warnings
        }
        if (memory.conflicts && memory.conflicts.length > 0) {
          response.conflicts = memory.conflicts
        }
        if (memory.possible_duplicates && memory.possible_duplicates.length > 0) {
          response.possible_duplicates = memory.possible_duplicates
        }
        if (sweptSessions.length > 0) {
          response.auto_ended_sessions = sweptSessions.map((s) => s.id)
        }
        return ok(response)
      }

      case 'ingest_episodes': {
        const namespace = await resolveProjectPath(args, ctx)
        const source = args.source as { system: string; instance?: string; version?: string }
        const permissions = (args.permissions ?? {}) as {
          visibility?: IngestEpisodesInput['visibility']
          retention?: IngestEpisodesInput['retention']
          ttl_ms?: number
        }
        const rawItems = args.episodes as Array<Record<string, unknown>>
        const items: IngestEpisodeItem[] = rawItems.map((item) => {
          const chunk = (item.chunk ?? {}) as {
            index?: number
            of?: number
            parent_external_id?: string
          }
          return {
            external_id: item.external_id as string,
            content: item.content as string,
            session_id: item.session_id as string | undefined,
            task_id: item.task_id as string | undefined,
            author: item.author as string | undefined,
            role: item.role as string | undefined,
            occurred_at: item.occurred_at as number | undefined,
            content_type: item.content_type as string | undefined,
            uri: item.uri as string | undefined,
            turn_index: item.turn_index as number | undefined,
            parent_external_id:
              (item.parent_external_id as string | undefined) ?? chunk.parent_external_id,
            chunk_index: chunk.index,
            chunk_of: chunk.of,
            provenance: item.provenance as Record<string, unknown> | undefined,
          }
        })
        const result = await ingestEpisodes(db, {
          namespace,
          source: source.system,
          source_instance: source.instance,
          source_version: source.version,
          visibility: permissions.visibility,
          retention: permissions.retention,
          ttl_ms: permissions.ttl_ms,
          items,
          origin: 'mcp',
          vectorsAvailable: episodeVectorsAvailable(db),
          deferVectors: args.defer_vectors === true,
          batchEmbeddings: args.batch_embeddings === true,
        })
        // deferred rows are lexically live but vectorless: queue the backlog turn so a
        // daemon that stays up does not wait for its next boot to embed them
        if (args.defer_vectors === true && result.ingested > 0) {
          enqueueEpisodeReembed(db, { source: 'ingest_episodes' })
        }
        return ok(result)
      }

      case 'delete_episodes': {
        const requested = typeof args.namespace === 'string' ? args.namespace.trim() : ''
        if (requested === '') {
          return err('namespace is required: delete_episodes never sweeps the whole store')
        }
        // the namespace comes straight from the arguments, so it is authorized here for
        // the delete verb rather than through resolveProjectPath
        const namespace = authorizeResolved(requested)
        const subtree = args.subtree === true
        const source = typeof args.source === 'string' ? args.source : undefined
        const externalIds = Array.isArray(args.external_ids)
          ? (args.external_ids as string[])
          : undefined
        const before = typeof args.before === 'number' ? args.before : undefined
        const narrowed = source !== undefined || (externalIds?.length ?? 0) > 0 || before !== undefined
        // a root subtree with nothing else to narrow it is a whole-store delete wearing
        // a namespace, and the spec is that such a call is refused
        if (subtree && (namespace === '/' || namespace === '~' || namespace === '.') && !narrowed) {
          return err(
            'refusing to delete every episode in the store: pass a deeper namespace, source, external_ids or before'
          )
        }
        const scope = subtree ? { namespace_subtree: namespace } : { namespace }
        const selector: EpisodeDeleteSelector = { source, external_ids: externalIds, before }
        const dryRun = args.dry_run === true
        const counts: EpisodeDeleteCounts = dryRun
          ? countMatchingEpisodes(db, scope, selector)
          : deleteEpisodes(db, scope, selector)
        return ok({ namespace, subtree, dry_run: dryRun, ...counts })
      }

      case 'search_memories': {
        const query = args.query as string

        const project_path = await resolveProjectPath(args, ctx)
        const breakdown = new Map<string, Record<RecallSignal, number>>()
        const startedAt = Date.now()
        const results = await search.hybridSearch(
          query,
          {
            project_path,
            limit: typeof args.limit === 'number' ? args.limit : 10,
            type: args.type as MemoryType | undefined,
            before: beforeFromArgs(args),
            as_of: asOfFromArgs(args),
            include_superseded: args.include_superseded === true,
            include_archived: args.include_archived === true,
            use_reranker: args.use_reranker === true,
            rerank_top_n: typeof args.rerank_top_n === 'number' ? args.rerank_top_n : undefined,
          },
          breakdown
        )
        const latencyMs = Date.now() - startedAt
        metrics.recordSearch(results, project_path)

        const budgetChars = typeof args.budget_chars === 'number' ? args.budget_chars : undefined
        const response: Record<string, unknown> = { namespace: project_path }
        let budgetAccounting: RetrievalBudgetAccounting | undefined
        if (budgetChars !== undefined) {
          const packed = packWithinBudget({
            budget_chars: budgetChars,
            digest: null,
            memories: enrichSearchResults(db, results, breakdown, Date.now(), { project_path }),
            topics: [],
          })
          response.results = packed.memories
          response.budget = packed.budget
          response.dropped = packed.dropped
          response.truncated = packed.truncated
          budgetAccounting = asBudgetAccounting(packed)
        } else {
          response.results = enrichSearchResults(db, results, breakdown, Date.now(), { project_path })
        }

        // cold rows in the served set are faults: the caller reached into the archive.
        // only what the response carries counts, so a budget that drops them is not one
        if (args.include_archived === true) {
          recordColdFaults(db, response.results as Memory[], 'search')
        }

        const miss = explainMiss(db, project_path, results.length, { materialize: false })
        if (miss) response.miss = miss

        auditCrossOwnerRead(db, {
          tool: 'search_memories',
          namespace: project_path,
          ids: results.map((r) => r.id),
          channel: 'hybrid',
        })
        recordRetrievalEvent(db, {
          tool: 'search_memories',
          mode: 'hybrid',
          namespace: project_path,
          query,
          resultIds: results.map((r) => r.id),
          latencyMs,
          budget: budgetAccounting,
          weak: results.length < WEAK_RESULT_THRESHOLD,
        })
        return ok(response)
      }

      case 'get_context': {
        const project_path = await resolveProjectPath(args, ctx)
        const limit = typeof args.limit === 'number' ? args.limit : 8
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const asOf = asOfFromArgs(args)
        const budgetChars = typeof args.budget_chars === 'number' ? args.budget_chars : undefined
        // the query path truncates content by default; full_content=true opts out and
        // compact_content is a compatibility no-op. the no-query roster ignores both,
        // and with budget_chars the packer decides truncation.
        const legacyFullRequested = args.full_content === true
        const wrapContent = <T extends { content: string }>(items: T[]): T[] =>
          legacyFullRequested ? items : truncateContent(items)
        // a digest, a topic summary or a nav line merges many rows, so it is served only
        // to a caller that owns every row behind it; otherwise the section is withheld
        const derivedOk = derivedVisible(db, project_path)
        const withheld: string[] = []
        if (!derivedOk) withheld.push(WITHHELD_DIGEST, WITHHELD_TOPICS)
        // cluster summaries are present state, so an as_of read omits them
        const baseClusters = asOf === undefined ? search.getClusters(project_path) : []
        // topics are sampled on both paths by default (a project-wide cluster can
        // carry thousands of ids); full_topics=true forces full membership
        const clusters =
          args.full_topics === true ? baseClusters : summarizeClusters(baseClusters)
        const historicalLimitations = asOf === undefined
          ? {}
          : { as_of_limitations: { digest_omitted: true, topics_omitted: true } }


        // path-shaped namespaces resolve into the materialized tree; any other name
        // stays leaf-only
        const parsed = parseNamespacePath(project_path)
        const pathShaped = parsed.isPathShaped
        const scopeArg = (args.scope as FunnelScope | undefined) ?? 'funnel'
        const strictScope = args.strict_scope !== false
        // materializes the node and its whole ancestor chain, so the depth-0 root
        // shows up in scope_trace
        const node = pathShaped ? ensureNode(db, project_path) : null

        if (query) {
          const breakdown = new Map<string, Record<RecallSignal, number>>()
          const searchOptions: SearchOptions = {
            limit,
            before: beforeFromArgs(args),
            as_of: asOf,
            include_superseded: args.include_superseded === true,
          }
          if (node) {
            if (strictScope) {
              searchOptions.project_path = node.path
            } else {
              // strict_scope=false widens to descendants
              searchOptions.namespace_subtree = node.path
            }
          } else {
            searchOptions.project_path = project_path
          }

          const startedAt = Date.now()
          const results = await search.hybridSearch(query, searchOptions, breakdown)
          const latencyMs = Date.now() - startedAt
          metrics.recordSearch(results, project_path)

          const topScore = results.length > 0 ? Math.max(...results.map((r) => r.score)) : null
          const topScoreNorm =
            topScore === null ? null : Math.min(1, Math.max(0, topScore))

          const scope_trace: ScopeTraceEntry[] = []
          const guide: GuideEntry[] = []

          if (node) {
            const useFunnel = scopeArg !== 'leaf'
            scope_trace.push({
              namespace: node.path,
              depth: node.depth,
              hits: results.length,
              top_score: topScoreNorm,
              action: 'searched',
            })

            if (useFunnel) {
              // ancestors() is root-first; reverse so the trace runs deepest first
              // and ends at the root
              const parents = ancestors(db, node.path).reverse()
              // the funnel never ascends above a grant, and a parent whose own rows are
              // not the caller's is not navigated either
              const reachable = new Set(
                coveredAncestors(
                  currentCaller(),
                  parents.map((parent) => parent.path)
                )
              )
              const rich =
                results.length >= FUNNEL_K_MIN && (topScoreNorm ?? 0) >= FUNNEL_THETA
              for (const parent of parents) {
                if (!reachable.has(parent.path) || !derivedVisible(db, parent.path)) {
                  if (!rich) withheld.push(`${WITHHELD_GUIDE}:${parent.path}`)
                  continue
                }
                if (rich) {
                  scope_trace.push({
                    namespace: parent.path,
                    depth: parent.depth,
                    action: 'skipped',
                  })
                } else {
                  const hits = navGuideHits(db, parent.path, query)
                  guide.push(...hits)
                  scope_trace.push({
                    namespace: parent.path,
                    depth: parent.depth,
                    hits: hits.length,
                    action: 'guide_only',
                  })
                }
              }
            }
          }

          const enrichedResults = enrichSearchResults(db, results, breakdown, Date.now(), searchOptions)
          // the same packer as recall_context (digest → memories → topics), so a
          // small budget starves nothing silently; without budget_chars the shape is
          // unchanged
          let memoriesOut = wrapContent(enrichedResults).map(toLeanContextEntry)
          let digestOut = asOf === undefined ? getDigest(db, project_path) : null
          let topicsOut: unknown = clusters
          let budgetExtras: Record<string, unknown> = {}
          let budgetAccounting: RetrievalBudgetAccounting | undefined
          let packedUsedChars = 0
          if (budgetChars !== undefined) {
            const packed = packWithinBudget({
              budget_chars: budgetChars,
              digest: digestOut,
              memories: enrichedResults,
              topics: clusters,
            })
            memoriesOut = packed.memories.map(toLeanContextEntry)
            digestOut = packed.digest
            topicsOut = packed.topics
            packedUsedChars = packed.budget.used_chars
            budgetExtras = {
              budget: packed.budget,
              dropped: packed.dropped,
              truncated: packed.truncated,
            }
            budgetAccounting = asBudgetAccounting(packed)
          }

          // what is true now, next to what was said: charged against whatever the
          // packer left, so a budgeted read never exceeds its budget
          const queryStateBudget =
            budgetChars === undefined
              ? STATE_SECTION_CHARS_NO_BUDGET
              : Math.max(0, budgetChars - packedUsedChars)
          const stateSection = buildStateSection(db, project_path, {
            asOf,
            remainingChars: queryStateBudget,
          })

          const miss = explainMiss(db, project_path, results.length, { materialize: true })
          recordRetrievalEvent(db, {
            tool: 'get_context',
            mode: node ? 'hybrid-funnel' : 'hybrid',
            namespace: project_path,
            query,
            resultIds: results.map((r) => r.id),
            latencyMs,
            budget: budgetAccounting,
            weak: results.length < WEAK_RESULT_THRESHOLD,
          })

          auditCrossOwnerRead(db, {
            tool: 'get_context',
            namespace: project_path,
            ids: results.map((r) => r.id),
            channel: 'hybrid',
          })
          return ok({
            namespace: project_path,
            digest: digestOut,
            memories: memoriesOut,
            topics: topicsOut,
            ...(node ? { scope_trace } : {}),
            ...(guide.length > 0 ? { guide } : {}),
            ...(miss ? { miss } : {}),
            ...budgetExtras,
            ...stateSectionFields(stateSection),
            ...historicalLimitations,
            ...(withheld.length > 0 ? { degraded: withheld } : {}),
          })
        }

        const rosterStartedAt = Date.now()
        const memories = search.getContext(project_path, limit, {
          before: beforeFromArgs(args),
          as_of: asOf,
          include_superseded: args.include_superseded === true,
        })
        const rosterLatencyMs = Date.now() - rosterStartedAt
        // a compact roster, never a content dump: full content needs a query or
        // get_memory, and cluster membership stays out of it
        metrics.recordContextLoad(memories, project_path)

        // single-node trace plus child-roster guide: navigation metadata only, no
        // memory bodies
        const scope_trace: ScopeTraceEntry[] = node
          ? [{ namespace: node.path, depth: node.depth, hits: memories.length, action: 'searched' }]
          : []
        // a child's digest is derived from that child's rows, so it is served only when
        // the caller owns them; the roster line is dropped otherwise, not emptied
        const guide: GuideEntry[] = node
          ? childRoster(db, node.path)
              .filter((c) => derivedVisible(db, c.path))
              .map((c) => ({
                namespace: node.path,
                kind: 'child_roster' as const,
                source: c.path,
                excerpt: clipNavExcerpt(c.digest),
              }))
          : []

        let digestOut = asOf === undefined ? getDigest(db, project_path) : null
        let rosterOut = memories.map(toRosterEntry)
        let topicsOut: unknown = clusters
        let budgetExtras: Record<string, unknown> = {}
        let budgetAccounting: RetrievalBudgetAccounting | undefined
        let packedUsedChars = 0
        if (budgetChars !== undefined) {
          const packed = packWithinBudget({
            budget_chars: budgetChars,
            digest: digestOut,
            memories: rosterOut,
            topics: clusters,
            // entries carry a preview: charge and truncate exactly what is emitted
            memorySize: (entry) => entry.preview.length,
            truncateMemory: (entry, keep) => ({
              ...entry,
              preview: `${entry.preview.slice(0, keep)}…`,
            }),
          })
          rosterOut = packed.memories
          digestOut = packed.digest
          topicsOut = packed.topics
          packedUsedChars = packed.budget.used_chars
          budgetExtras = {
            budget: packed.budget,
            dropped: packed.dropped,
            truncated: packed.truncated,
          }
          budgetAccounting = asBudgetAccounting(packed)
        }

        const stateSection = buildStateSection(db, project_path, {
          asOf,
          remainingChars:
            budgetChars === undefined
              ? STATE_SECTION_CHARS_NO_BUDGET
              : Math.max(0, budgetChars - packedUsedChars),
        })

        const miss = explainMiss(db, project_path, memories.length, { materialize: true })
        recordRetrievalEvent(db, {
          tool: 'get_context',
          mode: 'roster',
          namespace: project_path,
          query: null,
          resultIds: memories.map((m) => m.id),
          latencyMs: rosterLatencyMs,
          budget: budgetAccounting,
          weak: memories.length < WEAK_RESULT_THRESHOLD,
        })

        auditCrossOwnerRead(db, {
          tool: 'get_context',
          namespace: project_path,
          ids: memories.map((m) => m.id),
          channel: 'roster',
        })
        return ok({
          namespace: project_path,
          digest: digestOut,
          memories: rosterOut,
          topics: topicsOut,
          memory_health: buildMemoryHealth(db, project_path),
          ...(node ? { scope_trace } : {}),
          ...(guide.length > 0 ? { guide } : {}),
          ...(miss ? { miss } : {}),
          hint:
            'Blanket context (no query) returns a compact roster only; preview is capped at 160 chars. Pass query to scope retrieval via hybrid search and receive full content, or fetch a single memory with get_memory.',
          ...budgetExtras,
          ...stateSectionFields(stateSection),
          ...historicalLimitations,
          ...(withheld.length > 0 ? { degraded: withheld } : {}),
        })
      }

      case 'search_by_entity': {
        const entity = args.entity as string
        const project_path = await resolveProjectPath(args, ctx)
        const results = store.searchByEntity(
          entity,
          project_path,
          typeof args.limit === 'number' ? args.limit : 10,
          {
            include_superseded: args.include_superseded === true,
            as_of: asOfFromArgs(args),
          }
        )
        auditCrossOwnerRead(db, {
          tool: 'search_by_entity',
          namespace: project_path,
          ids: results.map((r) => r.id),
          channel: 'entity',
        })
        return ok({ namespace: project_path, results: enrichMemories(db, results, Date.now(), { project_path }) })
      }

      case 'get_related': {
        // `id` first, `memory_id` accepted for pre-rename clients
        const memory_id = (args.id ?? args.memory_id) as string | undefined
        if (!memory_id) return err('id (or legacy memory_id) is required')
        const limit = typeof args.limit === 'number' ? args.limit : 10
        const depth = typeof args.depth === 'number' ? Math.min(Math.max(args.depth, 1), 5) : 1
        const include_superseded = args.include_superseded === true
        const memory = store.getById(memory_id)
        if (!memory) return err(notFound(name, memory_id))
        authorizeMemory(db, memory_id, 'read')
        // the anchor is read by id like get_memory, and this tool has no cold-tier flag,
        // so an archived anchor answers as missing instead of leaking a retired payload
        if (memory.archived_at != null) return err(notFound(name, memory_id))
        // a walk from one row keeps to that row's namespace for a granted caller, so a
        // hop cannot leave the grant even when the far row is shared
        const walkScope = currentCaller().localOwner
          ? {}
          : { namespace_subtree: trimNamespace(memory.namespace ?? memory.project_path) }
        const [enrichedMemory] = enrichMemories(db, [memory], Date.now(), walkScope)
        if (depth <= 1) {
          const related = store.getLinked(memory_id, limit, { include_superseded, ...walkScope })
          metrics.recordRelated(related, memory.project_path)
          return ok({
            memory: enrichedMemory,
            related: enrichMemories(db, related, Date.now(), walkScope).map(
              (m, i) => ({ ...m, similarity: related[i].similarity, link_type: related[i].link_type })
            ),
          })
        }
        const related = search.pprSearch([memory_id], limit, { include_superseded, ...walkScope })
        metrics.recordRelated(related, memory.project_path)
        return ok({
          memory: enrichedMemory,
          related: enrichMemories(db, related, Date.now(), walkScope).map(
            (m, i) => ({
              ...m,
              similarity: related[i].similarity,
              link_type: related[i].link_type,
              hops: related[i].hops,
            })
          ),
          depth,
        })
      }

      case 'get_stats': {
        const namespace =
          typeof args.namespace === 'string' ? authorizeResolved(args.namespace) : undefined
        const since = typeof args.since === 'number' ? args.since : undefined
        // without a namespace the counters span the store, which only the owner reaches
        if (!namespace) assertLocalOwner('get_stats')
        return ok(metrics.getStats({ namespace, since }))
      }

      case 'consolidate_memories': {
        const threshold = typeof args.threshold === 'number' ? args.threshold : 0.95
        const project_path = await resolveProjectPath(args, ctx)
        const groups = search.findDuplicates({
          threshold,
          project_path,
        })
        return ok({
          groups,
          total: groups.length,
          suggestion:
            groups.length > 0
              ? 'Review each group and use forget_memory to remove redundant entries'
              : 'No near-duplicates found above the similarity threshold',
        })
      }

      case 'end_session': {
        const summary = args.summary as string | undefined
        const session_id = typeof args.session_id === 'string' ? args.session_id : undefined

        // no id: close the current session for the resolved namespace. ending
        // nothing is a success, not an error, and the call stays idempotent
        if (!session_id) {
          const project_path = await resolveProjectPath(args, ctx)
          const current = sessions.getCurrentSession(project_path)
          if (!current) {
            return ok({
              ended: false,
              session_id: null,
              namespace: project_path,
              reason: `no active session for ${project_path}`,
            })
          }
          const closed = sessions.end(current.id, summary)
          if (!closed) return err(`Session ${current.id} not found`)
          // best effort: maintenance never fails the tool call
          enqueueEndSessionMaintenance(db, closed.id, closed.project_path)
          return ok({ ...closed, ended: true })
        }

        // the id goes through the same ownership rule as the listing: a session carries
        // the caller's own summary, so ending someone else's answers as a missing one
        const owned = sessions.getById(session_id)
        if (!owned || !sessionOwnedByCaller(owned)) return err(`Session ${session_id} not found`)
        const session = sessions.end(session_id, summary)
        if (!session) return err(`Session ${session_id} not found`)
        // best effort: maintenance never fails the tool call
        enqueueEndSessionMaintenance(db, session.id, session.project_path)
        return ok({ ...session, ended: true })
      }

      case 'list_sessions': {
        const project_path = await resolveProjectPath(args, ctx)
        const limit = typeof args.limit === 'number' ? args.limit : 20
        const activeOnly = args.active_only === true
        // sweep here too, or a caller that never writes again keeps its idle
        // sessions open; the sweep spans every namespace, not just the resolved one
        const swept = sweepIdleSessions(db, sessions)
        const all = sessions.list(project_path)
        const active = all.filter((s) => s.ended_at === null)
        const filtered = activeOnly ? active : all
        const current = sessions.getCurrentSession(project_path)
        return ok({
          namespace: project_path,
          current_session_id: current?.id ?? null,
          count: Math.min(filtered.length, limit),
          total: all.length,
          active: active.length,
          auto_ended: swept.map((s) => ({ id: s.id, ended_at: s.ended_at })),
          sessions: filtered.slice(0, limit),
        })
      }

      case 'list_memories': {
        const project_path = await resolveProjectPath(args, ctx)
        const memories = store.list({
          project_path,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          type: args.type as MemoryType | undefined,
          limit: typeof args.limit === 'number' ? args.limit : 20,
          include_superseded: args.include_superseded === true,
          as_of: asOfFromArgs(args),
        })
        auditCrossOwnerRead(db, {
          tool: 'list_memories',
          namespace: project_path,
          ids: memories.map((m) => m.id),
          channel: 'list',
        })
        return ok({ namespace: project_path, memories: enrichMemories(db, memories, Date.now(), { project_path }) })
      }

      case 'forget_memory': {
        const id = args.id as string
        const existing = store.getById(id)
        const reachable = memoryAccess(db, id)
        // a refusal answers exactly as a missing id does, so no delete is attempted
        if (reachable && !mayReach(reachable, 'delete')) return ok({ success: false, id })
        const deleted = store.delete(id)
        if (deleted && existing) {
          // a deleted pin must stop being served: key the digest like the reads do
          // (namespace ?? project_path)
          const digestNamespace = existing.namespace ?? existing.project_path
          // synchronous, so an async rebuild cannot serve the deleted pin in the
          // meantime
          db.prepare('DELETE FROM project_digests WHERE namespace = ?').run(digestNamespace)
          void refreshDigest(db, digestNamespace).catch((e) => {
            logger.debug({ err: e, id }, 'digest: background refresh after forget failed')
          })
        }
        return ok({ success: deleted, id })
      }

      case 'get_memory': {
        const id = args.id as string
        const asOf = asOfFromArgs(args)
        const includeArchived = args.include_archived === true
        // the chain member that was current at as_of
        const memory = asOf !== undefined ? store.getByIdAt(id, asOf) : store.getById(id)
        if (!memory) return err(notFound(name, id))
        authorizeMemory(db, id, 'read')
        // archived is hidden by id too, and the caller that asks for it anyway pays a
        // fault. the same not-found answer as a missing row, so cold rows stay cold
        if (memory.archived_at != null) {
          if (!includeArchived) return err(notFound(name, id))
          recordColdFaults(db, [memory], 'read')
        }
        auditCrossOwnerRead(db, {
          tool: 'get_memory',
          namespace: trimNamespace(memory.namespace ?? memory.project_path),
          ids: [memory.id],
          channel: 'by-id',
        })
        // the one genuine use signal: naming an id (rather than taking what a search
        // ranked first) means the row was actually read. under
        // under ENGRAM_ACCESS_SIGNAL=explicit nothing else feeds access_count at all, and
        // served row is stamped, not the requested one — an as_of read serves one
        // revision. search paths deliberately do not stamp: that would feed the
        // ranker its own output.
        if (recordsAccessOnExplicitFetch()) store.recordAccess(memory.id)
        const [enriched] = enrichMemories(db, [memory], Date.now(), currentCaller().localOwner
          ? {} : { namespace_subtree: trimNamespace(memory.namespace ?? memory.project_path) })
        // the evidence this fact was distilled from, when a distillation path cited it
        return ok({ ...enriched, episodes: citedEpisodes(db, memory.id) })
      }

      case 'unarchive_memory': {
        const id = args.id as string
        // an unreachable row answers exactly like a missing one, before anything changes
        const reachable = memoryAccess(db, id)
        if (reachable && !mayReach(reachable, 'write')) {
          return ok({ success: false, id, reason: 'not found' })
        }
        const result = unarchiveMemory(db, id)
        if (!result.unarchived) {
          return ok({
            success: false,
            id,
            reason: store.getById(id) ? 'not archived' : 'not found',
          })
        }
        const memory = readableMutationMemory(db, store, id)
        return ok(memory ? { success: true, id, memory } : { success: true, id })
      }

      case 'update_memory': {
        const id = args.id as string
        const existing = store.getById(id)
        if (!existing) return err(notFound(name, id))
        authorizeMemory(db, id, 'write')
        // metadata only: content changes go through revise_memory (append-only)
        const patch: UpdateMemoryPatch = {
          type: args.type as MemoryType | undefined,
          importance: typeof args.importance === 'number' ? args.importance : undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          visibility: args.visibility as UpdateMemoryPatch['visibility'],
          valid_until:
            args.valid_until === null
              ? null
              : typeof args.valid_until === 'number'
                ? args.valid_until
                : undefined,
        }
        const updated = store.update(id, patch)
        const memory = readableMutationMemory(db, store, id)
        return ok(memory ? { success: updated, memory } : { success: updated, id })
      }

      case 'revise_memory': {
        const id = args.id as string
        const predecessor = store.getById(id)
        if (!predecessor) return err(notFound(name, id))
        authorizeMemory(db, id, 'write')
        const input: ReviseMemoryInput = {
          id,
          content: args.content as string,
          reason: args.reason as string | undefined,
          type: args.type as MemoryType | undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          session_id: args.session_id as string | undefined,
          // never inherited from the predecessor without an explicit opt-in
          shareable: args.shareable === true ? true : undefined,
          origin: 'mcp',
          state_key: typeof args.state_key === 'string' ? args.state_key : undefined,
        }
        const result = await store.revise(input)
        if (!result) return err(notFound(name, id))
        // revise can widen the export gate without mark_shareable, which would leave
        // the audit trail empty; mirror that event here
        if (input.shareable === true) {
          logAudit({
            type: 'mark_shareable',
            namespace: result.memory.namespace ?? result.memory.project_path,
            memory_id: result.id,
            actor: 'mcp',
          })
        }
        // the revision moves the pin with it, so refresh the digest keyed like every
        // read; the retired row's content must not linger in it
        const digestNamespace = result.memory.namespace ?? result.memory.project_path
        void refreshDigest(db, digestNamespace).catch((e) => {
          logger.debug({ err: e, id: result.id }, 'digest: background refresh failed')
        })
        metrics.recordStore(result.memory.content, result.memory.project_path)
        const memory = readableMutationMemory(db, store, result.id)
        if (!memory) return ok({ id: result.id, previous_id: result.previous_id })
        return ok({
          id: result.id,
          previous_id: result.previous_id,
          version: result.version,
          memory,
        })
      }

      case 'query_assertions': {
        const namespace = await resolveProjectPath(args, ctx)
        const input: QueryAssertionsInput = {
          namespace,
          subject: args.subject as string | undefined,
          predicate: args.predicate as string | undefined,
          schema_id: args.schema_id as string | undefined,
          as_of: args.as_of as number | undefined,
          valid_at: args.valid_at as number | undefined,
          observed_before: args.observed_before as number | undefined,
          include_superseded: args.include_superseded as boolean | undefined,
          include_archived: args.include_archived as boolean | undefined,
          limit: args.limit as number | undefined,
        }
        if (Object.prototype.hasOwnProperty.call(args, 'value')) {
          input.value = args.value as QueryAssertionsInput['value']
        }
        return ok(queryAssertions(db, input))
      }

      case 'get_state': {
        const project_path = await resolveProjectPath(args, ctx)
        const slotIds = (view: { slots: Array<{ current: { memory_id: string } | null }> }): string[] =>
          view.slots.flatMap((slot) => (slot.current ? [slot.current.memory_id] : []))
        // one normalizer, so a key read back is the key a write landed on
        const normalizedKey = typeof args.key === 'string' ? normalizeStateKey(args.key) : null
        if (args.key !== undefined && normalizedKey === null) {
          return err('key must be 1-200 characters of non-whitespace text')
        }
        const key = normalizedKey ?? undefined
        const startedAt = Date.now()
        const view = getState(db, {
          namespace: project_path,
          key,
          as_of: asOfFromArgs(args),
          include_superseded: args.include_superseded === true,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        })
        const latencyMs = Date.now() - startedAt
        const servedIds = slotIds(view)
        recordRetrievalEvent(db, {
          tool: 'get_state',
          mode: key === undefined ? 'slots' : 'slot',
          namespace: project_path,
          query: null,
          resultIds: servedIds,
          latencyMs,
          weak: view.slots.length === 0,
        })
        auditCrossOwnerRead(db, {
          tool: 'get_state',
          namespace: project_path,
          ids: servedIds,
          channel: 'state',
        })
        return ok(view)
      }

      case 'get_memory_history': {
        const id = args.id as string
        const authored = store.getById(id)
        if (!authored) return err(notFound(name, id))
        authorizeMemory(db, id, 'read')
        const historyScope = currentCaller().localOwner
          ? {} : { namespace_subtree: trimNamespace(authored.namespace ?? authored.project_path) }
        const history = store.getHistory(id, {
          as_of: asOfFromArgs(args),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          ...historyScope,
        })
        if (!history) return err(notFound(name, id))
        return ok({
          id: history.id,
          // each version carries the episodes it cites, so a revision chain shows
          // where every step of it came from
          versions: enrichMemories(db, history.versions, Date.now(), historyScope).map((version) => ({
            ...version,
            episodes: citedEpisodes(db, version.id),
          })),
          links: history.links,
        })
      }

      case 'recall_context': {
        const mode = (args.mode as RecallMode | undefined) ?? 'fused'
        if (mode === 'graph' && typeof args.seed_id !== 'string') {
          return err('recall_context mode=graph requires seed_id')
        }
        const project_path = await resolveProjectPath(args, ctx)
        const startedAt = Date.now()
        // one recipe over the assembly read path: the default recipe carries the payload
        // this tool has always returned, byte for byte
        const result = await recallViaAssemble(db, store, search, {
          query: args.query as string,
          project_path,
          budget_chars: args.budget_chars as number,
          mode,
          seed_id: typeof args.seed_id === 'string' ? args.seed_id : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          min_trust: typeof args.min_trust === 'number' ? args.min_trust : undefined,
          as_of: asOfFromArgs(args),
          now: Date.now(),
        })
        const latencyMs = Date.now() - startedAt
        // record the served memories and the dropped/truncated counts, or budget
        // starvation stays invisible in every surface
        metrics.recordRecall(result.memories, project_path)
        auditCrossOwnerRead(db, {
          tool: 'recall_context',
          namespace: project_path,
          ids: result.memories.map((m) => m.id),
          channel: 'recall',
        })
        recordRetrievalEvent(db, {
          tool: 'recall_context',
          mode: result.mode,
          namespace: project_path,
          query: args.query as string,
          resultIds: result.memories.map((m) => m.id),
          latencyMs,
          budget: {
            budget_chars: result.budget.total_chars,
            used_chars: result.budget.used_chars,
            dropped_memories: result.dropped.memories,
            dropped_topics: result.dropped.topics,
            digest_chars_cut: result.dropped.digest_chars_cut,
            truncated_digest: result.truncated.digest,
            truncated_memories: result.truncated.memories,
            truncated_topics: result.truncated.topics,
          },
          weak: result.memories.length < WEAK_RESULT_THRESHOLD,
        })
        return ok(result)
      }

      case 'assemble_context': {
        const project_path = await resolveProjectPath(args, ctx)
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const recipe = typeof args.recipe === 'string' ? args.recipe : DEFAULT_RECIPE_NAME
        const asOf = asOfFromArgs(args)
        const startedAt = Date.now()
        const result = await assemble(db, store, search, {
          scope: project_path,
          ...(query !== '' ? { query } : {}),
          budgetChars:
            typeof args.budget_chars === 'number'
              ? args.budget_chars
              : DEFAULT_ASSEMBLE_BUDGET_CHARS,
          recipe,
          ...(asOf !== undefined ? { asOf } : {}),
          now: Date.now(),
        })
        const memories = result.sections.find((section) => section.kind === 'memories')
        auditCrossOwnerRead(db, {
          tool: 'assemble_context',
          namespace: project_path,
          ids: (memories?.items ?? []).map((item) => item.id),
          channel: `assemble:${recipe}`,
        })
        recordRetrievalEvent(db, {
          tool: 'assemble_context',
          mode: recipe,
          namespace: project_path,
          query,
          resultIds: memories?.items.map((item) => item.id) ?? [],
          latencyMs: Date.now() - startedAt,
          budget: {
            budget_chars: result.accounting.budget,
            used_chars: result.accounting.used,
            dropped_memories: result.accounting.dropped,
            truncated_memories: result.accounting.truncated,
          },
          weak: (memories?.items.length ?? 0) < WEAK_RESULT_THRESHOLD,
        })
        return ok(result)
      }

      case 'get_maintenance_status': {
        assertLocalOwner(name)
        return ok(getMaintenanceStatus(db, typeof args.limit === 'number' ? args.limit : 20))
      }

      case 'run_pending_maintenance': {
        assertLocalOwner(name)
        // global opt-out: report disabled without claiming or running a job
        if (!isMaintenanceEnabled()) {
          return ok({ claimed: 0, done: 0, failed: 0, disabled: true })
        }
        const result = await runPendingMaintenanceJobs(db, {
          maxJobs: typeof args.limit === 'number' ? args.limit : undefined,
        })
        return ok(result)
      }

      case 'set_pin': {
        const id = args.id as string
        const pinned = args.pinned === true
        const memory = store.getById(id)
        if (!memory) return err(notFound(name, id))
        authorizeMemory(db, id, 'write')
        const updated = store.setPinned(id, pinned)
        // key the digest like the reads do (namespace ?? project_path), or an override
        // refreshes the wrong row
        const digestNamespace = memory.namespace ?? memory.project_path
        void refreshDigest(db, digestNamespace).catch((e) => {
          logger.debug({ err: e, id }, 'digest: background refresh failed')
        })
        const refreshed = readableMutationMemory(db, store, id)
        return ok(refreshed ? { success: updated, memory: refreshed } : { success: updated, id })
      }

      case 'list_brains': {
        // a brain is a file in the owner's home directory, so it sits outside every
        // namespace tree and no grant can cover it
        assertLocalOwner(name)
        const brains = listLocalBrains()
        return ok({ brains, count: brains.length })
      }

      case 'search_brain': {
        assertLocalOwner(name)
        const brain = args.brain as string
        const query = args.query as string
        const limit = typeof args.limit === 'number' ? args.limit : 10
        const results = await searchBrain(brain, query, limit)
        return ok({ brain, query, count: results.length, results })
      }

      case 'get_brain_memory': {
        assertLocalOwner(name)
        const brain = args.brain as string
        const id = args.id as string
        const memory = getBrainMemory(brain, id)
        if (!memory) return err(`Memory ${id} not found in brain ${brain}`)
        return ok({ brain, memory })
      }

      case 'task_start': {
        const namespace = await resolveProjectPath(args, ctx)
        const task = createTask(db, {
          namespace,
          visibility: visibilityOf(currentCaller(), args.visibility) ?? undefined,
          title: args.title as string,
          goal: args.goal as string,
          session_id: typeof args.session_id === 'string' ? args.session_id : null,
          plan: args.plan as TaskStartInput['plan'],
          artifacts: args.artifacts as string[] | undefined,
          open_questions: args.open_questions as string[] | undefined,
          author: typeof args.author === 'string' ? args.author : null,
        })
        return ok({ task, namespace })
      }

      case 'task_update': {
        const id = args.id as string
        const task = getTask(db, id)
        if (!task) return err(notFound(name, id))
        authorizeTask(task, 'write')
        const mismatch = await taskNamespaceMismatch(args, ctx, task.namespace)
        if (mismatch) return err(mismatch)

        const delta: TaskDelta = {
          status: args.status as TaskStatus,
          title: args.title as string | undefined,
          goal: args.goal as string | undefined,
          plan: args.plan as TaskDelta['plan'],
          progress: args.progress as string[] | undefined,
          artifacts: args.artifacts as string[] | undefined,
          open_questions: args.open_questions as string[] | undefined,
          resolved_questions: args.resolved_questions as string[] | undefined,
        }
        const updated = updateTask(db, id, delta, {
          author: typeof args.author === 'string' ? args.author : null,
        })
        if (!updated) return err(notFound(name, id))
        return ok({ task: updated.task, applied: updated.applied })
      }

      case 'task_get': {
        const id = typeof args.id === 'string' ? args.id : ''
        if (id) {
          const task = getTask(db, id)
          if (!task) return err(notFound(name, id))
          authorizeTask(task, 'read')
          const mismatch = await taskNamespaceMismatch(args, ctx, task.namespace)
          if (mismatch) return err(mismatch)
          return ok({
            task,
            ...(args.include_events === true ? { events: listTaskEvents(db, id) } : {}),
          })
        }

        const namespace = await resolveProjectPath(args, ctx)
        const tasks = listTasks(db, {
          namespace,
          status: args.status as TaskStatus,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        })
        return ok({ namespace, tasks })
      }

      case 'task_close': {
        const id = args.id as string
        const task = getTask(db, id)
        if (!task) return err(notFound(name, id))
        authorizeTask(task, 'write')
        const mismatch = await taskNamespaceMismatch(args, ctx, task.namespace)
        if (mismatch) return err(mismatch)

        const status = (args.status as TaskStatus) ?? 'done'
        const author = typeof args.author === 'string' ? args.author : null
        if (CLOSED_STATUSES.includes(task.status)) {
          return ok({ task, closed: false, reason: `task is already ${task.status}` })
        }

        // the only route from working state into durable memory: one summary, written
        // through the store so admission, embedding and linking all still apply
        const content = taskSummary(task, args.summary as string | undefined)
        const written = await store.store({
          content,
          session_id: await sessionFor(sessions, task.namespace),
          project_path: task.namespace,
          type: 'note',
          importance: 0.6,
          importanceProvided: true,
          tags: ['task-summary', task.id],
          origin: 'mcp',
        })
        const memoryId = written.status === 'rejected' ? null : written.id
        // the summary condenses the evidence ingested under this task id, so it cites
        // it: get_memory on the summary then leads back to the raw turns
        const linkedEpisodes = memoryId ? linkTaskEpisodes(db, memoryId, id) : 0
        const closed = closeTask(db, id, { status, summaryMemoryId: memoryId, author })
        return ok({
          task: closed,
          closed: true,
          linked_episodes: linkedEpisodes,
          memory:
            written.status === 'rejected'
              ? { status: 'rejected', rule: written.rule, reason: written.reason, hint: written.hint }
              : { status: written.status, id: written.id },
        })
      }

      case 'task_handoff': {
        const id = args.id as string
        const task = getTask(db, id)
        if (!task) return err(notFound(name, id))
        authorizeTask(task, 'write')
        const mismatch = await taskNamespaceMismatch(args, ctx, task.namespace)
        if (mismatch) return err(mismatch)

        const audience = (args.for as 'subagent' | 'new-session') ?? 'subagent'
        const brief = handoff(
          task,
          audience,
          typeof args.budget_chars === 'number' ? args.budget_chars : DEFAULT_HANDOFF_CHARS
        )
        appendTaskEvent(
          db,
          id,
          'handoff',
          { for: audience, used_chars: brief.used_chars, omitted: brief.omitted },
          typeof args.author === 'string' ? args.author : null
        )
        return ok(brief)
      }

      case 'session_start': {
        const namespace = await resolveProjectPath(args, ctx)
        return ok(
          sessionStartPayload(db, {
            namespace,
            sessionId: typeof args.session_id === 'string' ? args.session_id : undefined,
            budgetChars: typeof args.budget_chars === 'number' ? args.budget_chars : undefined,
          })
        )
      }

      case 'mark_shareable': {
        const id = args.id as string
        const shareable = args.shareable !== false
        const owned = store.getById(id)
        if (!owned) return err(notFound(name, id))
        authorizeMemory(db, id, 'share')
        // scope the write to the namespace this session is connected to and attribute
        // it to the session, so a prompt-injected call cannot flag another project's
        // memories and the audit trail stays traceable; a caller that declares no
        // namespace has no scope to enforce
        const declaredNamespace =
          (typeof args.namespace === 'string' && args.namespace.trim()) ||
          (typeof args.project_path === 'string' && args.project_path.trim()) ||
          ctx.urlNamespace ||
          ctx.urlProject
        const project_path = await resolveProjectPath(args, ctx)
        const current = sessions.getCurrentSession(project_path)
        const result = markShareable(db, id, shareable, current ? `mcp:${current.id}` : 'mcp',
          declaredNamespace ? { allowedNamespace: project_path } : {}
        )
        return ok(result)
      }

      default:
        return err(`Unknown tool: ${name}`)
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(message)
  }
}
