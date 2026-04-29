import { z } from 'zod'
import { getDatabase } from '../db/init.js'
import { MemoryStore } from '../memory/store.js'
import { MemorySearch } from '../memory/search.js'
import { SessionManager } from '../session/manager.js'
import { resolveNamespace } from '../namespace/resolver.js'
import { getAdjudicationQueue } from '../contradictions/runtime.js'
import { getImportanceQueue } from '../importance/runtime.js'
import { enrichMemories, enrichSearchResults, type RecallSignal } from '../memory/enrichment.js'
import type { MemoryType, StoreMemoryInput } from '../memory/types.js'
import { SCHEMAS } from './schemas.js'

type ToolResult = { content: Array<{ type: 'text'; text: string }> }

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

function getInstances() {
  const dbm = getDatabase()
  const queue = getAdjudicationQueue(dbm.db, dbm.vectorsAvailable)
  const importanceQueue = getImportanceQueue(dbm.db)
  return {
    db: dbm.db,
    store: new MemoryStore(dbm.db, dbm.vectorsAvailable, queue, importanceQueue),
    search: new MemorySearch(dbm.db, dbm.vectorsAvailable),
    sessions: new SessionManager(dbm.db),
  }
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
          .map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')
        return err(`Validation failed: ${issues}`)
      }
    }

    const { db, store, search, sessions } = getInstances()

    switch (name) {
      case 'store_memory': {
        const content = args.content as string
        if (!content) return err('content is required')

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
        }
        const memory = await store.store(input)
        const [enriched] = enrichMemories(db, [memory])
        return ok(enriched)
      }

      case 'search_memories': {
        const query = args.query as string
        if (!query) return err('query is required')

        const project_path = await resolveProjectPath(args, ctx)
        const breakdown = new Map<string, Record<RecallSignal, number>>()
        const results = await search.hybridSearch(
          query,
          {
            project_path,
            limit: typeof args.limit === 'number' ? args.limit : 10,
            type: args.type as MemoryType | undefined,
            include_superseded: args.include_superseded === true,
          },
          breakdown
        )
        return ok({
          namespace: project_path,
          results: enrichSearchResults(db, results, breakdown),
        })
      }

      case 'get_context': {
        const project_path = await resolveProjectPath(args, ctx)
        const limit = typeof args.limit === 'number' ? args.limit : 20
        const memories = search.getContext(project_path, limit, {
          include_superseded: args.include_superseded === true,
        })
        return ok({ namespace: project_path, memories: enrichMemories(db, memories) })
      }

      case 'get_related': {
        const memory_id = args.memory_id as string
        if (!memory_id) return err('memory_id is required')
        const limit = typeof args.limit === 'number' ? args.limit : 10
        const depth = typeof args.depth === 'number' ? Math.min(Math.max(args.depth, 1), 5) : 1
        const include_superseded = args.include_superseded === true
        const memory = store.getById(memory_id)
        if (!memory) return err(`Memory ${memory_id} not found`)
        const [enrichedMemory] = enrichMemories(db, [memory])
        if (depth <= 1) {
          const related = store.getLinked(memory_id, limit, { include_superseded })
          return ok({
            memory: enrichedMemory,
            related: enrichMemories(db, related as unknown as import('../memory/types.js').Memory[]).map(
              (m, i) => ({ ...m, similarity: related[i].similarity, link_type: related[i].link_type })
            ),
          })
        }
        const related = search.traverseGraph(memory_id, depth, limit, { include_superseded })
        return ok({
          memory: enrichedMemory,
          related: enrichMemories(db, related as unknown as import('../memory/types.js').Memory[]).map(
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
        if (!session_id) return err('session_id is required')
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
        if (!id) return err('id is required')
        const deleted = store.delete(id)
        return ok({ success: deleted, id })
      }

      case 'pin_memory': {
        const id = args.id as string
        if (!id) return err('id is required')
        const memory = store.getById(id)
        if (!memory) return err(`Memory ${id} not found`)
        const updated = store.setPinned(id, true)
        const refreshed = store.getById(id)!
        const [enriched] = enrichMemories(db, [refreshed])
        return ok({ success: updated, memory: enriched })
      }

      case 'unpin_memory': {
        const id = args.id as string
        if (!id) return err('id is required')
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
