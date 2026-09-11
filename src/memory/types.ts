export type MemoryType = 'note' | 'decision' | 'bug' | 'pattern' | 'gotcha' | 'todo' | 'procedure'

export interface ExtractedEntity {
  entity_text: string
  entity_type: 'file_path' | 'function' | 'class' | 'symbol' | 'library' | 'url' | 'error'
}

export interface ProcedureMeta {
  preconditions: string[]
  steps: string[]
  postconditions: string[]
}

export type ImportanceSource = 'default' | 'user' | 'llm'

export interface Memory {
  id: string
  session_id: string
  project_path: string
  /** Raw namespace override column; null when the row uses project_path. */
  namespace?: string | null
  content: string
  type: MemoryType
  importance: number
  tags: string[]
  created_at: number
  last_accessed: number | null
  access_count: number
  vec_rowid: number | null
  valid_from: number
  valid_until: number | null
  procedure_meta?: ProcedureMeta | null
  entities?: ExtractedEntity[]
  importance_source?: ImportanceSource
  importance_model?: string | null
  importance_prompt_version?: string | null
  importance_scored_at?: number | null
  /** Internal provenance ('mcp', 'revision', 'import', legacy rows: 'legacy'). */
  origin?: string | null
  pinned?: boolean
  shareable?: boolean
}

export interface SearchResult extends Memory {
  score: number
}

export interface MemoryCluster {
  id: number
  project_path: string
  member_ids: string[]
  summary: string
  is_extractive: boolean
  created_at: number
  updated_at: number
}

export interface StoreMemoryInput {
  content: string
  session_id: string
  project_path: string
  type?: MemoryType
  importance?: number
  tags?: string[]
  adjudicateSync?: boolean
  importanceProvided?: boolean
  procedure_meta?: ProcedureMeta
  origin?: string
}

/**
 * Append-only revision input. `revise_memory` creates a NEW memory row and a
 * deterministic confidence=1 supersedes edge; it never edits content in place.
 */
export interface ReviseMemoryInput {
  /** ID of the memory being revised (the predecessor). */
  id: string
  content: string
  reason?: string
  type?: MemoryType
  tags?: string[]
  /** New session for the revision; defaults to the predecessor's session. */
  session_id?: string
  /**
   * Shareable is NEVER inherited from the predecessor. The revision is
   * non-shareable unless the caller explicitly passes shareable: true.
   */
  shareable?: boolean
  origin?: string
}

export interface RevisionResult {
  id: string
  previous_id: string
  version: number
  memory: Memory
}

export interface HistoryLink {
  source_id: string
  target_id: string
  similarity: number
  link_type: LinkType
  created_at: number
  confidence: number | null
  reason: string | null
  decider_model: string | null
  prompt_version: string | null
  judged_at: number | null
  revision: number
}

export interface MemoryHistory {
  /** The memory the history was requested for. */
  id: string
  /** Chain members ordered by created_at ascending (oldest first). */
  versions: Memory[]
  /** Supersedes links inside the chain, deterministic order (judged_at, id). */
  links: HistoryLink[]
}

export interface UpdateMemoryPatch {
  type?: MemoryType
  importance?: number
  tags?: string[]
  valid_until?: number | null
}

export interface ListMemoriesFilter {
  project_path?: string
  tags?: string[]
  type?: MemoryType
  limit?: number
  include_superseded?: boolean
  /** Historical view: include only facts valid at this time (bi-temporal). */
  as_of?: number
}

export type LinkType = 'semantic' | 'temporal' | 'supersedes' | 'reference'

export interface MemoryLink {
  source_id: string
  target_id: string
  similarity: number
  link_type: LinkType
  created_at: number
}
