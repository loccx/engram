export type MemoryType = 'note' | 'decision' | 'bug' | 'pattern' | 'gotcha' | 'todo' | 'procedure'
import type { CallerScope } from './access.js'

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
  /** the state slot this row is a value of; null for an ordinary memory */
  state_key?: string | null
}

/** one value a slot has held, with the window it was true for */
export interface StateEntry {
  memory_id: string
  content: string
  type: MemoryType
  valid_from: number
  valid_until: number | null
  /** when the supersedes link that retired this value was judged */
  superseded_at: number | null
  superseded_by: string | null
  reason: string | null
  archived: boolean
  /** the row carries the queried key; a chain member the walk reached does not */
  keyed: boolean
  current: boolean
}

export interface StateSlot {
  key: string
  namespace: string
  /** the value true now (or at as_of); null when every value has been retired */
  current: StateEntry | null
  /** the value the current one replaced, provably older than it */
  prior: StateEntry | null
  /** every value valid at the read time, oldest first */
  versions: number
  /** present only when the caller asked for the superseded values too */
  trajectory?: StateEntry[]
}

export interface StateView {
  namespace: string
  /** null on a present-state read */
  as_of: number | null
  /** null when the whole namespace was asked for */
  key: string | null
  slots: StateSlot[]
}

export interface GetStateOptions {
  namespace: string
  key?: string
  as_of?: number
  include_superseded?: boolean
  limit?: number
  now?: number
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
  /** names the state slot this value belongs to; a second write to the same key retires the first */
  state_key?: string
  /** personal|project|team|org; a named principal defaults to personal, the local owner to null */
  visibility?: string
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
  /** defaults to the predecessor's key, so a revision stays in its slot */
  state_key?: string
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
  /** personal|project|team|org; promotion is how a private row becomes shareable */
  visibility?: 'personal' | 'project' | 'team' | 'org'
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
  /** the identity the listing is served as; defaults to the caller in scope */
  caller?: CallerScope
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
