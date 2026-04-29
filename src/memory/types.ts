export type MemoryType = 'note' | 'decision' | 'bug' | 'pattern' | 'gotcha' | 'todo'

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
  importance_source?: ImportanceSource
  importance_model?: string | null
  importance_prompt_version?: string | null
  importance_scored_at?: number | null
}

export interface SearchResult extends Memory {
  score: number
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
