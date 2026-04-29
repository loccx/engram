export interface Session {
  id: string
  project_path: string
  started_at: number
  ended_at: number | null
  summary: string | null
  tool_name: string | null
}

export interface StartSessionInput {
  project_path?: string
  tool_name?: string
}
