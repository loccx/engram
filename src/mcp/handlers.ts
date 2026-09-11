import { z } from 'zod'
import { getDatabase } from '../db/init.js'
import { MemoryStore } from '../memory/store.js'
import { MemorySearch } from '../memory/search.js'
import { SessionManager } from '../session/manager.js'
import { resolveNamespace } from '../namespace/resolver.js'
import { getAdjudicationQueue } from '../contradictions/runtime.js'
import { getImportanceQueue } from '../importance/runtime.js'
import {
  enrichMemories,
  enrichSearchResults,
  truncateContent,
  summarizeClusters,
  type RecallSignal,
} from '../memory/enrichment.js'
import { getDigest, refreshDigest } from '../memory/digest.js'
import { recallContext, type RecallMode } from '../memory/recall.js'
import {
  enqueueEndSessionMaintenance,
  getMaintenanceStatus,
  isMaintenanceEnabled,
  runPendingMaintenanceJobs,
} from '../maintenance/jobs.js'
import { getMetricsTracker, type MetricsTracker } from '../metrics/tracker.js'
import { logger } from '../utils/logger.js'
import type {
  MemoryType,
  StoreMemoryInput,
  UpdateMemoryPatch,
  ReviseMemoryInput,
} from '../memory/types.js'
import { SCHEMAS } from './schemas.js'
import { listLocalBrains, searchBrain, getBrainMemory, markShareable } from '../brains/mcp.js'

type ToolResult = { content: Array<{ type: 'text'; text: string }> }

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
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] }
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
  return resolved.namespace
}

function asOfFromArgs(args: Record<string, unknown>): number | undefined {
  if (typeof args.as_of === 'number') return args.as_of
  return undefined
}

function beforeFromArgs(args: Record<string, unknown>): number | undefined {
  return typeof args.before === 'number' ? args.before : undefined
}

export async function handleTool(
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
        let sessionId = args.session_id as string | undefined

        if (!sessionId) {
          const current = sessions.getCurrentSession(project_path)
          sessionId = current?.id ?? (await sessions.start({ project_path })).id
        }

        const importanceProvided = typeof args.importance === 'number'
        const input: StoreMemoryInput = {
          content,
          session_id: sessionId,
          project_path,
          type: (args.type as MemoryType) || 'note',
          importance: importanceProvided ? (args.importance as number) : 0.5,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
          adjudicateSync: args.adjudicate_sync === true,
          importanceProvided,
          procedure_meta: args.procedure_meta as StoreMemoryInput['procedure_meta'],
          origin: 'mcp',
        }
        const memory = await store.store(input)
        metrics.recordStore(content, project_path)
        const [enriched] = enrichMemories(db, [memory])
        return ok(enriched)
      }

      case 'search_memories': {
        const query = args.query as string

        const project_path = await resolveProjectPath(args, ctx)
        const breakdown = new Map<string, Record<RecallSignal, number>>()
        const results = await search.hybridSearch(
          query,
          {
            project_path,
            limit: typeof args.limit === 'number' ? args.limit : 10,
            type: args.type as MemoryType | undefined,
            before: beforeFromArgs(args),
            as_of: asOfFromArgs(args),
            include_superseded: args.include_superseded === true,
            use_reranker: args.use_reranker === true,
            rerank_top_n: typeof args.rerank_top_n === 'number' ? args.rerank_top_n : undefined,
          },
          breakdown
        )
        metrics.recordSearch(results, project_path)
        return ok({
          namespace: project_path,
          results: enrichSearchResults(db, results, breakdown),
        })
      }

      case 'get_context': {
        const project_path = await resolveProjectPath(args, ctx)
        const limit = typeof args.limit === 'number' ? args.limit : 20
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const asOf = asOfFromArgs(args)
        // Strict legacy compatibility: callers with no flags get FULL content
        // and full cluster member_ids, exactly as before the compact flags
        // existed. Compact payloads are an explicit opt-in; full_content /
        // full_topics are accepted as aliases of the default (they were
        // briefly opt-ins, so honoring them never breaks a caller).
        const compactContent = args.compact_content === true
        const legacyFullRequested = args.full_content === true
        // Cluster summaries are present-state derived views, so historical
        // context omits them rather than leaking knowledge from after as_of.
        const baseClusters = asOf === undefined ? search.getClusters(project_path) : []
        const clusters = args.compact_topics === true && args.full_topics !== true
          ? summarizeClusters(baseClusters)
          : baseClusters
        const historicalLimitations = asOf === undefined
          ? {}
          : { as_of_limitations: { digest_omitted: true, topics_omitted: true } }

        const wrapContent = <T extends { content: string }>(items: T[]): T[] =>
          compactContent && !legacyFullRequested ? truncateContent(items) : items

        if (query) {
          const breakdown = new Map<string, Record<RecallSignal, number>>()
          const results = await search.hybridSearch(
            query,
            {
              project_path,
              limit,
              before: beforeFromArgs(args),
              as_of: asOf,
              include_superseded: args.include_superseded === true,
            },
            breakdown
          )
          metrics.recordSearch(results, project_path)
          return ok({
            namespace: project_path,
            digest: asOf === undefined ? getDigest(db, project_path) : null,
            memories: wrapContent(enrichSearchResults(db, results, breakdown)),
            topics: clusters,
            ...historicalLimitations,
          })
        }

        const memories = search.getContext(project_path, limit, {
          before: beforeFromArgs(args),
          as_of: asOf,
          include_superseded: args.include_superseded === true,
        })
        metrics.recordContextLoad(memories, project_path)
        return ok({
          namespace: project_path,
          digest: asOf === undefined ? getDigest(db, project_path) : null,
          memories: wrapContent(enrichMemories(db, memories)),
          topics: clusters,
          ...historicalLimitations,
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
        return ok({ namespace: project_path, results: enrichMemories(db, results) })
      }

      case 'get_related': {
        // Compatibility: prefer the newer `id` field; accept the legacy
        // `memory_id` alias so pre-rename clients keep working.
        const memory_id = (args.id ?? args.memory_id) as string | undefined
        if (!memory_id) return err('id (or legacy memory_id) is required')
        const limit = typeof args.limit === 'number' ? args.limit : 10
        const depth = typeof args.depth === 'number' ? Math.min(Math.max(args.depth, 1), 5) : 1
        const include_superseded = args.include_superseded === true
        const memory = store.getById(memory_id)
        if (!memory) return err(`Memory ${memory_id} not found`)
        const [enrichedMemory] = enrichMemories(db, [memory])
        if (depth <= 1) {
          const related = store.getLinked(memory_id, limit, { include_superseded })
          metrics.recordRelated(related, memory.project_path)
          return ok({
            memory: enrichedMemory,
            related: enrichMemories(db, related).map(
              (m, i) => ({ ...m, similarity: related[i].similarity, link_type: related[i].link_type })
            ),
          })
        }
        const related = search.pprSearch([memory_id], limit, { include_superseded })
        metrics.recordRelated(related, memory.project_path)
        return ok({
          memory: enrichedMemory,
          related: enrichMemories(db, related).map(
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
        const namespace = typeof args.namespace === 'string' ? args.namespace : undefined
        const since = typeof args.since === 'number' ? args.since : undefined
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
        const session_id = args.session_id as string
        const session = sessions.end(session_id, args.summary as string | undefined)
        if (!session) return err(`Session ${session_id} not found`)
        // Best-effort durable maintenance enqueue; never fails the tool call.
        enqueueEndSessionMaintenance(db, session.id, session.project_path)
        return ok(session)
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
        return ok({ namespace: project_path, memories: enrichMemories(db, memories) })
      }

      case 'forget_memory': {
        const id = args.id as string
        const existing = store.getById(id)
        const deleted = store.delete(id)
        if (deleted && existing) {
          // Digest invalidation: pinned content that was just deleted must
          // never keep being served. Key by namespace (namespace ??
          // project_path) so namespace-overridden memories refresh the right
          // digest row.
          const digestNamespace = existing.namespace ?? existing.project_path
          // Invalidate synchronously so a failed/asynchronous rebuild can never
          // serve deleted pinned content. The background refresh repopulates
          // any remaining pinned facts for the namespace.
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
        // Historical view: the chain member that was current at as_of.
        const memory = asOf !== undefined ? store.getByIdAt(id, asOf) : store.getById(id)
        if (!memory) return err(`Memory ${id} not found`)
        const [enriched] = enrichMemories(db, [memory])
        return ok(enriched)
      }

      case 'update_memory': {
        const id = args.id as string
        const existing = store.getById(id)
        if (!existing) return err(`Memory ${id} not found`)
        // Metadata-only by design: content is never mutated in place; use
        // revise_memory to change content (append-only).
        const patch: UpdateMemoryPatch = {
          type: args.type as MemoryType | undefined,
          importance: typeof args.importance === 'number' ? args.importance : undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          valid_until:
            args.valid_until === null
              ? null
              : typeof args.valid_until === 'number'
                ? args.valid_until
                : undefined,
        }
        const updated = store.update(id, patch)
        const refreshed = store.getById(id)!
        const [enriched] = enrichMemories(db, [refreshed])
        return ok({ success: updated, memory: enriched })
      }

      case 'revise_memory': {
        const id = args.id as string
        const input: ReviseMemoryInput = {
          id,
          content: args.content as string,
          reason: args.reason as string | undefined,
          type: args.type as MemoryType | undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          session_id: args.session_id as string | undefined,
          // Never inherited from the predecessor without explicit opt-in.
          shareable: args.shareable === true ? true : undefined,
          origin: 'mcp',
        }
        const result = await store.revise(input)
        if (!result) return err(`Memory ${id} not found`)
        // Pin transfer moved with the revision; refresh the digest in the
        // background so the retired row's content never lingers in it. Key
        // by namespace (namespace ?? project_path) like every digest read.
        const digestNamespace = result.memory.namespace ?? result.memory.project_path
        void refreshDigest(db, digestNamespace).catch((e) => {
          logger.debug({ err: e, id: result.id }, 'digest: background refresh failed')
        })
        metrics.recordStore(result.memory.content, result.memory.project_path)
        const [enriched] = enrichMemories(db, [result.memory])
        return ok({
          id: result.id,
          previous_id: result.previous_id,
          version: result.version,
          memory: enriched,
        })
      }

      case 'get_memory_history': {
        const id = args.id as string
        const history = store.getHistory(id, {
          as_of: asOfFromArgs(args),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        })
        if (!history) return err(`Memory ${id} not found`)
        return ok({
          id: history.id,
          versions: enrichMemories(db, history.versions),
          links: history.links,
        })
      }

      case 'recall_context': {
        const mode = (args.mode as RecallMode | undefined) ?? 'fused'
        if (mode === 'graph' && typeof args.seed_id !== 'string') {
          return err('recall_context mode=graph requires seed_id')
        }
        const project_path = await resolveProjectPath(args, ctx)
        const result = await recallContext(db, store, search, {
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
        return ok(result)
      }

      case 'get_maintenance_status': {
        return ok(getMaintenanceStatus(db, typeof args.limit === 'number' ? args.limit : 20))
      }

      case 'run_pending_maintenance': {
        // Respect the global opt-out: when maintenance is disabled, report an
        // explicit disabled result WITHOUT claiming or running any job.
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
        if (!memory) return err(`Memory ${id} not found`)
        const updated = store.setPinned(id, pinned)
        // Digest key must match the memory's namespace resolution
        // (namespace ?? project_path) so namespace overrides don't refresh
        // the wrong (or an empty) digest row.
        const digestNamespace = memory.namespace ?? memory.project_path
        void refreshDigest(db, digestNamespace).catch((e) => {
          logger.debug({ err: e, id }, 'digest: background refresh failed')
        })
        const refreshed = store.getById(id)!
        const [enriched] = enrichMemories(db, [refreshed])
        return ok({ success: updated, memory: enriched })
      }

      case 'list_brains': {
        const brains = listLocalBrains()
        return ok({ brains, count: brains.length })
      }

      case 'search_brain': {
        const brain = args.brain as string
        const query = args.query as string
        const limit = typeof args.limit === 'number' ? args.limit : 10
        const results = searchBrain(brain, query, limit)
        return ok({ brain, query, count: results.length, results })
      }

      case 'get_brain_memory': {
        const brain = args.brain as string
        const id = args.id as string
        const memory = getBrainMemory(brain, id)
        if (!memory) return err(`Memory ${id} not found in brain ${brain}`)
        return ok({ brain, memory })
      }

      case 'mark_shareable': {
        const id = args.id as string
        const shareable = args.shareable !== false
        const result = markShareable(db, id, shareable, 'mcp')
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
