import { z } from 'zod'
import { STATE_KEY_MAX_CHARS, STATE_SLOT_LIMIT_MAX } from '../memory/state.js'
import { EPISODE_BATCH_MAX } from '../memory/episodes.js'

const MemoryType = z.enum(['note', 'decision', 'bug', 'pattern', 'gotcha', 'todo', 'procedure'])
const Visibility = z.enum(['personal', 'project', 'team', 'org'])

const stateKey = z
  .string()
  .trim()
  .min(1)
  .max(STATE_KEY_MAX_CHARS, `state_key must be at most ${STATE_KEY_MAX_CHARS} characters`)
  .optional()

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
  /**
   * pinned in the same call. without it a caller cannot satisfy a rule of the
   * form "write this with importance 1.0 and pinned".
   */
  pinned: z.boolean().optional().default(false),
  session_id: z.string().optional(),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  /** scope suffix: stores into `<project>//<scope>`, one path segment */
  scope: z
    .string()
    .trim()
    .min(1, 'scope must not be empty')
    .max(64, 'scope must be at most 64 characters')
    .refine((s) => !s.includes('/'), {
      message: 'scope must be a single path segment (no "/")',
    })
    .optional(),
  adjudicate_sync: z.boolean().optional().default(false),
  procedure_meta: ProcedureMetaSchema,
  /** the slot this value belongs to; a later write to the same key retires this one */
  state_key: stateKey,
  /** personal|project|team|org; a named principal's write starts personal */
  visibility: Visibility.optional(),
})

export const GetStateSchema = z.object({
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  key: stateKey,
  as_of: z.number().int().optional(),
  include_superseded: z.boolean().optional().default(false),
  limit: z.number().int().positive().max(STATE_SLOT_LIMIT_MAX).optional().default(20),
})

export const SearchMemoriesSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional().default(10),
  type: MemoryType.optional(),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  /** only facts with valid_from <= before, on the present-state view */
  before: z.number().int().optional(),
  /** full historical view at as_of, supersession included; wins over before */
  as_of: z.number().int().optional(),
  include_superseded: z.boolean().optional().default(false),
  /** audit read-back of archived (cold) rows; a served one is a page fault */
  include_archived: z.boolean().optional().default(false),
  use_reranker: z.boolean().optional().default(false),
  rerank_top_n: z.number().int().min(2).max(100).optional(),
  /** content-character budget for the packed result set, opt-in */
  budget_chars: z.number().int().min(50).optional(),
})

export const GetContextSchema = z.object({
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  query: z.string().optional(),
  /** 8 keeps a no-limit call small; pass limit for more */
  limit: z.number().int().positive().optional().default(8),
  before: z.number().int().optional(),
  as_of: z.number().int().optional(),
  include_superseded: z.boolean().optional().default(false),
  /** funnel: search the deepest namespace, then ascend thin ancestors for guide
   * excerpts. leaf: that namespace alone. */
  scope: z.enum(['leaf', 'funnel']).optional(),
  /** false widens the leaf search to descendants (`namespace/*` and `namespace//*`);
   * siblings are never included either way */
  strict_scope: z.boolean().optional(),
  /** kept for compatibility only: truncation is already the query-path default, so
   * this changes nothing */
  compact_content: z.boolean().optional(),
  /** budget over digest + memories + topics */
  budget_chars: z.number().int().min(50).optional(),
  /** legacy alias: on the query path it forces full content, the no-query roster
   * ignores it */
  full_content: z.boolean().optional(),
  /** no-op kept for compatibility; topics are summarized on both paths */
  compact_topics: z.boolean().optional(),
  /** full cluster member_ids on both paths, instead of the summary */
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
 * `id` is preferred; the legacy `memory_id` alias stays accepted so clients
 * written against the old contract keep working
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

/**
 * session_id is optional: without it the current session for the resolved
 * namespace is closed
 */
export const EndSessionSchema = z.object({
  session_id: z.string().min(1).optional(),
  summary: z.string().optional(),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
})

export const ListSessionsSchema = z.object({
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  limit: z.number().int().positive().max(200).optional().default(20),
  active_only: z.boolean().optional().default(false),
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
  /** archived rows answer as missing without it */
  include_archived: z.boolean().optional().default(false),
  as_of: z.number().int().optional(),
})

export const UnarchiveMemorySchema = z.object({
  id: z.string().min(1),
})

export const UpdateMemorySchema = z.object({
  id: z.string().min(1),
  type: MemoryType.optional(),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  valid_until: z.number().int().nullable().optional(),
  /** personal|project|team|org; a named principal's row starts personal */
  visibility: Visibility.optional(),
})

export const ReviseMemorySchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  reason: z.string().optional(),
  type: MemoryType.optional(),
  tags: z.array(z.string()).optional(),
  session_id: z.string().optional(),
  /** explicit opt-in only; shareable is never inherited from the predecessor */
  shareable: z.boolean().optional(),
  /** defaults to the predecessor's key, so a revision stays in its slot */
  state_key: stateKey,
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

export const AssembleContextSchema = z.object({
  query: z.string().optional(),
  budget_chars: z.number().int().min(50).optional(),
  /** a named recipe from the assembly registry; the default reproduces recall_context */
  recipe: z.string().optional(),
  as_of: z.number().int().optional(),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
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

const TaskStatus = z.enum(['open', 'blocked', 'done', 'abandoned'])
const PlanItemStatus = z.enum(['pending', 'active', 'done', 'blocked'])

const PlanItemDelta = z.object({
  /** an existing item, from task_get; omit the id to append a new one */
  id: z.string().optional(),
  text: z.string().optional(),
  status: PlanItemStatus.optional(),
})

export const TaskStartSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  /** personal|project|team|org; a named principal's task starts personal */
  visibility: Visibility.optional(),
  plan: z.array(z.union([z.string(), PlanItemDelta])).optional(),
  artifacts: z.array(z.string()).optional(),
  open_questions: z.array(z.string()).optional(),
  session_id: z.string().optional(),
  /** free-text attribution for the event log, e.g. a subagent name */
  author: z.string().optional(),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
})

export const TaskUpdateSchema = z.object({
  id: z.string().min(1),
  status: TaskStatus.optional(),
  title: z.string().optional(),
  goal: z.string().optional(),
  plan: z.array(PlanItemDelta).optional(),
  /** appended as progress notes, each one dated */
  progress: z.array(z.string()).optional(),
  artifacts: z.array(z.string()).optional(),
  open_questions: z.array(z.string()).optional(),
  resolved_questions: z.array(z.string()).optional(),
  author: z.string().optional(),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
})

export const TaskGetSchema = z.object({
  id: z.string().min(1).optional(),
  status: TaskStatus.optional(),
  limit: z.number().int().positive().max(50).optional().default(5),
  include_events: z.boolean().optional().default(false),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
})

export const TaskCloseSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['done', 'abandoned']).optional().default('done'),
  /** extra line appended to the summary memory */
  summary: z.string().optional(),
  author: z.string().optional(),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
})

export const TaskHandoffSchema = z.object({
  id: z.string().min(1),
  for: z.enum(['subagent', 'new-session']).optional().default('subagent'),
  budget_chars: z.number().int().min(80).optional(),
  author: z.string().optional(),
})

export const SessionStartSchema = z.object({
  session_id: z.string().optional(),
  budget_chars: z.number().int().min(200).optional(),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
})

const EpisodeSourceSchema = z.object({
  system: z.string().min(1),
  instance: z.string().optional(),
  version: z.string().optional(),
})

const EpisodePermissionsSchema = z.object({
  visibility: Visibility.optional(),
  retention: z.enum(['durable', 'session', 'ephemeral']).optional(),
  ttl_ms: z.number().int().positive().optional(),
})

const EpisodeItemSchema = z.object({
  external_id: z.string().min(1),
  content: z.string().min(1),
  session_id: z.string().optional(),
  task_id: z.string().optional(),
  author: z.string().optional(),
  role: z.string().optional(),
  occurred_at: z.number().int().optional(),
  content_type: z.string().optional(),
  uri: z.string().optional(),
  turn_index: z.number().int().optional(),
  parent_external_id: z.string().optional(),
  provenance: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  chunk: z
    .object({
      index: z.number().int().optional(),
      of: z.number().int().optional(),
      parent_external_id: z.string().optional(),
    })
    .optional(),
})

export const IngestEpisodesSchema = z.object({
  source: EpisodeSourceSchema,
  episodes: z.array(EpisodeItemSchema).min(1).max(EPISODE_BATCH_MAX),
  namespace: z.string().optional(),
  project_path: z.string().optional(),
  permissions: EpisodePermissionsSchema.optional(),
  defer_vectors: z.boolean().optional().default(false),
  batch_embeddings: z.boolean().optional().default(false),
})

export const DeleteEpisodesSchema = z.object({
  namespace: z
    .string()
    .min(1)
    .describe('the namespace whose episodes go; delete_episodes never matches the whole store'),
  subtree: z.boolean().optional().default(false),
  source: z.string().min(1).optional(),
  external_ids: z.array(z.string().min(1)).min(1).optional(),
  before: z.number().int().optional(),
  dry_run: z.boolean().optional().default(false),
})

export const ListBrainsSchema = z.object({})

export const SearchBrainSchema = z.object({
  brain: z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional().default(10),
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
  get_state: GetStateSchema,
  get_related: GetRelatedSchema,
  search_by_entity: SearchByEntitySchema,
  consolidate_memories: ConsolidateSchema,
  end_session: EndSessionSchema,
  list_sessions: ListSessionsSchema,
  list_memories: ListMemoriesSchema,
  forget_memory: ForgetMemorySchema,
  get_memory: GetMemorySchema,
  unarchive_memory: UnarchiveMemorySchema,
  update_memory: UpdateMemorySchema,
  revise_memory: ReviseMemorySchema,
  get_memory_history: GetMemoryHistorySchema,
  recall_context: RecallContextSchema,
  assemble_context: AssembleContextSchema,
  get_maintenance_status: GetMaintenanceStatusSchema,
  run_pending_maintenance: RunPendingMaintenanceSchema,
  set_pin: SetPinSchema,
  get_stats: GetStatsSchema,
  task_start: TaskStartSchema,
  task_update: TaskUpdateSchema,
  task_get: TaskGetSchema,
  task_close: TaskCloseSchema,
  task_handoff: TaskHandoffSchema,
  session_start: SessionStartSchema,
  ingest_episodes: IngestEpisodesSchema,
  delete_episodes: DeleteEpisodesSchema,
  list_brains: ListBrainsSchema,
  search_brain: SearchBrainSchema,
  get_brain_memory: GetBrainMemorySchema,
  mark_shareable: MarkShareableSchema,
}
