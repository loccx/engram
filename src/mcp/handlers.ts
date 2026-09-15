import { z } from 'zod'
import { getDatabase } from '../db/init.js'
import { MemoryStore } from '../memory/store.js'
import { MemorySearch } from '../memory/search.js'
import type { SearchOptions } from '../memory/search.js'
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
import { parseNamespacePath, ensureNode, ancestors, children } from '../namespace/tree.js'
import { childRoster } from '../memory/nav.js'
import { inferScope } from '../memory/scope-inference.js'
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
import type { Memory } from '../memory/types.js'

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
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] }
}

const ROSTER_PREVIEW_CHARS = 160

/**
 * Roster entry for the blanket (no-query) get_context form. The blanket form
 * never serves full content — that requires a query (hybrid search) or
 * get_memory — so accidental no-query calls stay small.
 */
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

// Hierarchical funnel retrieval (docs/specs/hierarchical-memory-p1.md).
// A leaf is "rich" with >= FUNNEL_K_MIN hits and a top score >= FUNNEL_THETA;
// otherwise retrieval ascends ancestor nav layers for thin-layer guide entries.
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

/** Match query tokens against a parent node's thin nav layer (digest + cluster
 *  summaries) and return <=2 short excerpts. Guide is navigation metadata, never
 *  a memory body. */
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
  return resolved.namespace
}

function asOfFromArgs(args: Record<string, unknown>): number | undefined {
  if (typeof args.as_of === 'number') return args.as_of
  return undefined
}

function beforeFromArgs(args: Record<string, unknown>): number | undefined {
  return typeof args.before === 'number' ? args.before : undefined
}

/**
 * Word-boundary match for scope auto-routing: the scope token must appear as a
 * standalone word in the content (case-insensitive), never as a substring of a
 * longer identifier ('payment' must not match scope 'payments').
 */
function contentMentionsScope(content: string, token: string): boolean {
  if (!token) return false
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-zA-Z0-9])${escaped}(?:[^a-zA-Z0-9]|$)`, 'i').test(content)
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

        // Scope routing: explicit `scope` wins; then a deterministic word-boundary
        // mention of an existing sibling scope; then LLM inference over existing
        // scopes (P3); otherwise the project root.
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
        }
        const memory = await store.store(input)
        metrics.recordStore(content, effectiveNamespace)
        const [enriched] = enrichMemories(db, [memory])
        const response: Record<string, unknown> = {
          ...enriched,
          namespace: effectiveNamespace,
          routed_via: routedVia,
        }
        if (routedScope) response.routed_scope = routedScope
        return ok(response)
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
        const limit = typeof args.limit === 'number' ? args.limit : 8
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const asOf = asOfFromArgs(args)
        // Query path: full content by default; compact_content truncates and
        // full_content is honored as an alias for backward compatibility.
        // The blanket (no-query) path ignores both — it serves a compact
        // roster regardless.
        const compactContent = args.compact_content === true
        const legacyFullRequested = args.full_content === true
        // Cluster summaries are present-state derived views, so historical
        // context omits them rather than leaking knowledge from after as_of.
        const baseClusters = asOf === undefined ? search.getClusters(project_path) : []
        // Topics are summarized (5-id sample + member_count) on both paths by
        // default — a project-wide cluster can carry thousands of member_ids.
        // full_topics: true is the explicit opt-out that forces full membership.
        const clusters =
          args.full_topics === true ? baseClusters : summarizeClusters(baseClusters)
        const historicalLimitations = asOf === undefined
          ? {}
          : { as_of_limitations: { digest_omitted: true, topics_omitted: true } }

        const wrapContent = <T extends { content: string }>(items: T[]): T[] =>
          compactContent && !legacyFullRequested ? truncateContent(items) : items

        // Hierarchical funnel scoping. Path-shaped namespaces resolve into the
        // materialized tree; non-path namespaces remain leaf-only (invariant 3).
        const parsed = parseNamespacePath(project_path)
        const pathShaped = parsed.isPathShaped
        const scopeArg = (args.scope as FunnelScope | undefined) ?? 'funnel'
        const strictScope = args.strict_scope !== false
        // ensureNode materializes the node + full ancestor chain (idempotent),
        // which also guarantees the depth-0 root appears in scope_trace.
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
              // Invariant 4: strict_scope=false expands to descendants only.
              searchOptions.namespace_subtree = node.path
            }
          } else {
            searchOptions.project_path = project_path
          }

          const results = await search.hybridSearch(query, searchOptions, breakdown)
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
              // Ancestors come back root-first; reverse for deepest-first trace
              // that ends at the depth-0 root (invariant 5).
              const parents = ancestors(db, node.path).reverse()
              const rich =
                results.length >= FUNNEL_K_MIN && (topScoreNorm ?? 0) >= FUNNEL_THETA
              for (const parent of parents) {
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

          return ok({
            namespace: project_path,
            digest: asOf === undefined ? getDigest(db, project_path) : null,
            memories: wrapContent(enrichSearchResults(db, results, breakdown)),
            topics: clusters,
            ...(node ? { scope_trace } : {}),
            ...(guide.length > 0 ? { guide } : {}),
            ...historicalLimitations,
          })
        }

        const memories = search.getContext(project_path, limit, {
          before: beforeFromArgs(args),
          as_of: asOf,
          include_superseded: args.include_superseded === true,
        })
        // Contract change ("require query always"): the blanket form is a
        // compact roster, not a content dump. Full content requires a query
        // or get_memory, so accidental no-query calls stay small. Topics are
        // always summarized here to keep cluster membership out of the dump.
        metrics.recordContextLoad(memories, project_path)

        // Blanket scope trace (single node) + child-roster nav guide. Both are
        // navigation metadata; the roster never carries memory bodies.
        const scope_trace: ScopeTraceEntry[] = node
          ? [{ namespace: node.path, depth: node.depth, hits: memories.length, action: 'searched' }]
          : []
        const guide: GuideEntry[] = node
          ? childRoster(db, node.path).map((c) => ({
              namespace: node.path,
              kind: 'child_roster' as const,
              source: c.path,
              excerpt: clipNavExcerpt(c.digest),
            }))
          : []

        return ok({
          namespace: project_path,
          digest: asOf === undefined ? getDigest(db, project_path) : null,
          memories: memories.map(toRosterEntry),
          topics: clusters,
          ...(node ? { scope_trace } : {}),
          ...(guide.length > 0 ? { guide } : {}),
          hint:
            'Blanket context (no query) returns a compact roster only; preview is capped at 160 chars. Pass query to scope retrieval via hybrid search and receive full content, or fetch a single memory with get_memory.',
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
