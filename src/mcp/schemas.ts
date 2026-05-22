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
  before: z.number().int().optional(),
  include_superseded: z.boolean().optional().default(false),
  use_reranker: z.boolean().optional().default(false),
  rerank_top_n: z.number().int().min(2).max(100).optional(),
})

export const GetContextSchema = z.object({
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  limit: z.number().int().positive().optional().default(20),
  before: z.number().int().optional(),
  include_superseded: z.boolean().optional().default(false),
})

export const SearchByEntitySchema = z.object({
  entity: z.string().min(1),
  limit: z.number().int().positive().optional().default(10),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  include_superseded: z.boolean().optional().default(false),
})

export const GetRelatedSchema = z.object({
  memory_id: z.string().min(1),
  limit: z.number().int().positive().optional().default(10),
  depth: z.number().int().min(1).max(5).optional().default(1),
  include_superseded: z.boolean().optional().default(false),
})

export const ConsolidateSchema = z.object({
  threshold: z.number().min(0.8).max(1.0).optional().default(0.95),
  project_path: z.string().optional(),
  namespace: z.string().optional(),
})

export const StartSessionSchema = z.object({
  project_path: z.string().optional(),
  namespace: z.string().optional(),
  tool_name: z.string().optional(),
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
})

export const ForgetMemorySchema = z.object({
  id: z.string().min(1),
})

export const PinMemorySchema = z.object({
  id: z.string().min(1),
})

export const UnpinMemorySchema = z.object({
  id: z.string().min(1),
})

export const GetStatsSchema = z.object({
  namespace: z.string().optional(),
  since: z.number().int().optional(),
})

export const SCHEMAS: Record<string, z.ZodType> = {
  store_memory: StoreMemorySchema,
  search_memories: SearchMemoriesSchema,
  get_context: GetContextSchema,
  get_related: GetRelatedSchema,
  search_by_entity: SearchByEntitySchema,
  consolidate_memories: ConsolidateSchema,
  start_session: StartSessionSchema,
  end_session: EndSessionSchema,
  list_memories: ListMemoriesSchema,
  forget_memory: ForgetMemorySchema,
  pin_memory: PinMemorySchema,
  unpin_memory: UnpinMemorySchema,
  get_stats: GetStatsSchema,
}
