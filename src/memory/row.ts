import type { ImportanceSource, Memory, MemoryType, ProcedureMeta } from './types.js'

export interface MemoryRow {
  id: string
  session_id: string
  project_path: string
  namespace?: string | null
  content: string
  type: string
  importance: number
  tags: string
  created_at: number
  last_accessed: number | null
  access_count: number
  vec_rowid: number | null
  valid_from?: number | null
  valid_until?: number | null
  procedure_meta?: string | null
  pinned?: number | null
  importance_source?: string | null
  importance_model?: string | null
  importance_prompt_version?: string | null
  importance_scored_at?: number | null
  embed_state?: string | null
  superseded_by?: string | null
  namespace_backfilled?: number | null
  origin?: string | null
  shareable?: number | null
}

export function rowToMemory(row: MemoryRow): Memory {
  let procedureMeta: ProcedureMeta | null = null
  if (row.procedure_meta) {
    try {
      procedureMeta = JSON.parse(row.procedure_meta) as ProcedureMeta
    } catch {
      procedureMeta = null
    }
  }

  let tags: string[] = []
  try {
    const parsed = JSON.parse(row.tags)
    if (Array.isArray(parsed)) {
      tags = parsed.filter((tag): tag is string => typeof tag === 'string')
    }
  } catch {
    tags = []
  }

  const memory: Memory = {
    id: row.id,
    session_id: row.session_id,
    project_path: row.project_path,
    namespace: row.namespace ?? null,
    content: row.content,
    type: row.type as MemoryType,
    importance: row.importance,
    tags,
    created_at: row.created_at,
    valid_from: row.valid_from ?? row.created_at,
    valid_until: row.valid_until ?? null,
    procedure_meta: procedureMeta,
    last_accessed: row.last_accessed,
    access_count: row.access_count,
    vec_rowid: row.vec_rowid,
  }

  if (row.importance_source != null) {
    memory.importance_source = row.importance_source as ImportanceSource
  }
  if (row.importance_model != null) {
    memory.importance_model = row.importance_model
  }
  if (row.importance_prompt_version != null) {
    memory.importance_prompt_version = row.importance_prompt_version
  }
  if (row.importance_scored_at != null) {
    memory.importance_scored_at = row.importance_scored_at
  }
  if (row.pinned != null) {
    ;(memory as Memory & { pinned?: boolean }).pinned = row.pinned === 1
  }
  if (row.origin != null) {
    memory.origin = row.origin
  }
  if (row.shareable != null) {
    ;(memory as Memory & { shareable?: boolean }).shareable = row.shareable === 1
  }

  return memory
}
