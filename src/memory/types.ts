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
}

export interface ListMemoriesFilter {
  project_path?: string
  tags?: string[]
  type?: MemoryType
  limit?: number
  include_superseded?: boolean
}

export type LinkType = 'semantic' | 'temporal' | 'supersedes' | 'reference'

export interface MemoryLink {
  source_id: string
  target_id: string
  similarity: number
  link_type: LinkType
  created_at: number
}
