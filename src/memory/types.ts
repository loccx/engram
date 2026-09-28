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
  /** namespace override; null when the row uses project_path */
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
  /** where the row came from: mcp, revision, import, or legacy */
  origin?: string | null
  pinned?: boolean
  shareable?: boolean
  /** set by a retention/prune job; hidden from every default read */
  archived_at?: number | null
}

export interface SearchResult extends Memory {
  score: number
  /** evidence share of `score`, priors excluded; absolute, never normalised */
  relevance?: number
  /** a branch failed for this search; SearchDiagnostics.degraded names it */
  degraded?: boolean
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
  /** the write gate needs the pin intent while the row is still being written */
  pinned?: boolean
}

/** a revision inserts a new row plus a confidence=1 supersedes edge; content is never edited in place */
export interface ReviseMemoryInput {
  /** the predecessor */
  id: string
  content: string
  reason?: string
  type?: MemoryType
  tags?: string[]
  /** defaults to the predecessor's session */
  session_id?: string
  /** never inherited from the predecessor: non-shareable unless the caller opts in */
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
  id: string
  /** oldest first */
  versions: Memory[]
  /** supersedes links inside the chain, ordered by (judged_at, id) */
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
  /** audit opt-in: archived rows stay hidden even when include_superseded is set */
  include_archived?: boolean
  /** only facts valid at this time */
  as_of?: number
}

export type LinkType =
  | 'semantic'
  | 'temporal'
  | 'supersedes'
  | 'reference'
  | 'duplicate_of'
  /** sub-threshold contradiction: a disputed marker that hides nothing */
  | 'conflicts'

export interface MemoryLink {
  source_id: string
  target_id: string
  similarity: number
  link_type: LinkType
  created_at: number
}
