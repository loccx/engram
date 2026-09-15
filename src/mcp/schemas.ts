import { z } from 'zod'

const MemoryType = z.enum(['note', 'decision', 'bug', 'pattern', 'gotcha', 'todo', 'procedure'])

const ProcedureMetaSchema = z.object({
  preconditions: z.array(z.string()),
  steps: z.array(z.string()),
  postconditions: z.array(z.string()),
}).optional()

export const StoreMemorySchema = z.object({
  content: z.string().min(1),
  type: MemoryType.optional().default('note'),
  tags: z.array(z.string()).optional().default([]),
  importance: z.number().min(0).max(1).optional().default(0.5),
  session_id: z.string().optional(),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  adjudicate_sync: z.boolean().optional().default(false),
  procedure_meta: ProcedureMetaSchema,
})

export const SearchMemoriesSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional().default(10),
  type: MemoryType.optional(),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  /** Legacy bound: facts with valid_from <= before (present-state supersession). */
  before: z.number().int().optional(),
  /** Historical view: full bi-temporal validity + time-aware supersession. */
  as_of: z.number().int().optional(),
  include_superseded: z.boolean().optional().default(false),
  use_reranker: z.boolean().optional().default(false),
  rerank_top_n: z.number().int().min(2).max(100).optional(),
})

export const GetContextSchema = z.object({
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().optional().default(20),
  before: z.number().int().optional(),
  as_of: z.number().int().optional(),
  include_superseded: z.boolean().optional().default(false),
  /**
   * Retrieval scope. 'funnel' (the default for path-shaped namespaces) searches
   * the deepest namespace first, then ascends thin ancestor nav layers for
   * guide excerpts when the leaf yields few/weak hits. 'leaf' searches the
   * single namespace only.
   */
  scope: z.enum(['leaf', 'funnel']).optional(),
  /**
   * When false, the leaf search expands to descendant namespaces only
   * (`namespace/*` and `namespace//*`). Default (true) restricts to the exact
   * namespace; sibling namespaces are never included.
   */
  strict_scope: z.boolean().optional(),
  /** Query path only: truncate long content (~400 chars + ellipsis). Default (legacy): full content. */
  compact_content: z.boolean().optional(),
  /**
   * Legacy alias accepted for backward compatibility: on the query path this
   * still forces full content. The blanket (no-query) path ignores it — it
   * serves a compact roster regardless.
   */
  full_content: z.boolean().optional(),
  /** No-op: topics are summarized by default on both paths. Accepted for backward compatibility. */
  compact_topics: z.boolean().optional(),
  /**
   * Forces full cluster member_ids on both paths. Topics are summarized by
   * default otherwise.
   */
  full_topics: z.boolean().optional(),
})

export const SearchByEntitySchema = z.object({
  entity: z.string().min(1),
  limit: z.number().int().positive().optional().default(10),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  as_of: z.number().int().optional(),
  include_superseded: z.boolean().optional().default(false),
})

/**
 * Compatibility firewall: `id` is preferred; the legacy `memory_id` alias is
 * still accepted so clients written against the pre-rename contract keep
 * working unchanged.
 */
export const GetRelatedSchema = z
  .object({
    id: z.string().min(1).optional(),
    memory_id: z.string().min(1).optional().describe(
      'Deprecated alias for id; retained for backward compatibility'
    ),
    limit: z.number().int().positive().optional().default(10),
    depth: z.number().int().min(1).max(5).optional().default(1),
    include_superseded: z.boolean().optional().default(false),
  })
  .refine((v) => v.id !== undefined || v.memory_id !== undefined, {
    message: 'id (or legacy memory_id) is required',
  })

export const ConsolidateSchema = z.object({
  threshold: z.number().min(0.8).max(1.0).optional().default(0.95),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
})

export const EndSessionSchema = z.object({
  session_id: z.string().min(1),
  summary: z.string().optional(),
})

export const ListMemoriesSchema = z.object({
  tags: z.array(z.string()).optional(),
  type: MemoryType.optional(),
  limit: z.number().int().positive().optional().default(20),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  include_superseded: z.boolean().optional().default(false),
  as_of: z.number().int().optional(),
})

export const ForgetMemorySchema = z.object({
  id: z.string().min(1),
})

export const GetMemorySchema = z.object({
  id: z.string().min(1),
  as_of: z.number().int().optional(),
})

export const UpdateMemorySchema = z.object({
  id: z.string().min(1),
  type: MemoryType.optional(),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  valid_until: z.number().int().nullable().optional(),
})

export const ReviseMemorySchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  reason: z.string().optional(),
  type: MemoryType.optional(),
  tags: z.array(z.string()).optional(),
  session_id: z.string().optional(),
  /** Explicit opt-in only; shareable is never inherited from the predecessor. */
  shareable: z.boolean().optional(),
})

export const GetMemoryHistorySchema = z.object({
  id: z.string().min(1),
  as_of: z.number().int().optional(),
  limit: z.number().int().positive().max(500).optional().default(50),
})

export const RecallMode = z.enum(['fused', 'hybrid', 'graph', 'entity'])

export const RecallContextSchema = z.object({
  query: z.string().min(1),
  budget_chars: z.number().int().min(50),
  mode: RecallMode.optional().default('fused'),
  seed_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(10),
  min_trust: z.number().min(0).max(1).optional().default(0),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  as_of: z.number().int().optional(),
})

export const GetMaintenanceStatusSchema = z.object({
  limit: z.number().int().positive().max(200).optional().default(20),
})

export const RunPendingMaintenanceSchema = z.object({
  limit: z.number().int().positive().max(100).optional().default(20),
})

export const SetPinSchema = z.object({
  id: z.string().min(1),
  pinned: z.boolean(),
})

export const GetStatsSchema = z.object({
  namespace: z.string().optional(),
  since: z.number().int().optional(),
})

export const ListBrainsSchema = z.object({})

export const SearchBrainSchema = z.object({
  brain: z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().positive().optional().default(10),
})

export const GetBrainMemorySchema = z.object({
  brain: z.string().min(1),
  id: z.string().min(1),
})

export const MarkShareableSchema = z.object({
  id: z.string().min(1),
  shareable: z.boolean().optional().default(true),
})

export const SCHEMAS: Record<string, z.ZodType> = {
  store_memory: StoreMemorySchema,
  search_memories: SearchMemoriesSchema,
  get_context: GetContextSchema,
  get_related: GetRelatedSchema,
  search_by_entity: SearchByEntitySchema,
  consolidate_memories: ConsolidateSchema,
  end_session: EndSessionSchema,
  list_memories: ListMemoriesSchema,
  forget_memory: ForgetMemorySchema,
  get_memory: GetMemorySchema,
  update_memory: UpdateMemorySchema,
  revise_memory: ReviseMemorySchema,
  get_memory_history: GetMemoryHistorySchema,
  recall_context: RecallContextSchema,
  get_maintenance_status: GetMaintenanceStatusSchema,
  run_pending_maintenance: RunPendingMaintenanceSchema,
  set_pin: SetPinSchema,
  get_stats: GetStatsSchema,
  list_brains: ListBrainsSchema,
  search_brain: SearchBrainSchema,
  get_brain_memory: GetBrainMemorySchema,
  mark_shareable: MarkShareableSchema,
}
