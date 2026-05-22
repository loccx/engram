import { z } from 'zod'
import { getDatabase } from '../db/init.js'
import { MemoryStore } from '../memory/store.js'
import { MemorySearch } from '../memory/search.js'
import { SessionManager } from '../session/manager.js'
import { resolveNamespace } from '../namespace/resolver.js'
import { getAdjudicationQueue } from '../contradictions/runtime.js'
import { getImportanceQueue } from '../importance/runtime.js'
import { enrichMemories, enrichSearchResults, type RecallSignal } from '../memory/enrichment.js'
import { getMetricsTracker, type MetricsTracker } from '../metrics/tracker.js'
import type { MemoryType, StoreMemoryInput } from '../memory/types.js'
import { SCHEMAS } from './schemas.js'

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
            before: typeof args.before === 'number' ? args.before : undefined,
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
        const memories = search.getContext(project_path, limit, {
          before: typeof args.before === 'number' ? args.before : undefined,
          include_superseded: args.include_superseded === true,
        })
        const clusters = search.getClusters(project_path)
        metrics.recordContextLoad(memories, project_path)
        return ok({ namespace: project_path, memories: enrichMemories(db, memories), topics: clusters })
      }

      case 'search_by_entity': {
        const entity = args.entity as string
        const project_path = await resolveProjectPath(args, ctx)
        const results = store.searchByEntity(
          entity,
          project_path,
          typeof args.limit === 'number' ? args.limit : 10,
          { include_superseded: args.include_superseded === true }
        )
        return ok({ namespace: project_path, results: enrichMemories(db, results) })
      }

      case 'get_related': {
        const memory_id = args.memory_id as string
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

      case 'start_session': {
        const project_path = await resolveProjectPath(args, ctx)
        const session = await sessions.start({
          project_path,
          tool_name: args.tool_name as string | undefined,
        })
        return ok(session)
      }

      case 'end_session': {
        const session_id = args.session_id as string
        const session = sessions.end(session_id, args.summary as string | undefined)
        if (!session) return err(`Session ${session_id} not found`)
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
        })
        return ok({ namespace: project_path, memories: enrichMemories(db, memories) })
      }

      case 'forget_memory': {
        const id = args.id as string
        const deleted = store.delete(id)
        return ok({ success: deleted, id })
      }

      case 'pin_memory': {
        const id = args.id as string
        const memory = store.getById(id)
        if (!memory) return err(`Memory ${id} not found`)
        const updated = store.setPinned(id, true)
        const refreshed = store.getById(id)!
        const [enriched] = enrichMemories(db, [refreshed])
        return ok({ success: updated, memory: enriched })
      }

      case 'unpin_memory': {
        const id = args.id as string
        const memory = store.getById(id)
        if (!memory) return err(`Memory ${id} not found`)
        const updated = store.setPinned(id, false)
        const refreshed = store.getById(id)!
        const [enriched] = enrichMemories(db, [refreshed])
        return ok({ success: updated, memory: enriched })
      }

      default:
        return err(`Unknown tool: ${name}`)
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(message)
  }
}
