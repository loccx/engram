export const TASK_STATUSES = ['open', 'blocked', 'done', 'abandoned'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const PLAN_ITEM_STATUSES = ['pending', 'active', 'done', 'blocked'] as const
export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number]

export type TaskEventKind = 'update' | 'checkpoint' | 'handoff' | 'close'

/** a task is finished when it reaches one of these */
export const CLOSED_STATUSES: TaskStatus[] = ['done', 'abandoned']

export interface PlanItem {
  id: string
  text: string
  status: PlanItemStatus
}

export interface ProgressNote {
  text: string
  author: string | null
  created_at: number
}

export interface Task {
  id: string
  namespace: string
  /** null is the local owner's task; a named principal's task carries its id */
  owner_principal: string | null
  /** null (the local owner's default) is not personal */
  visibility: string | null
  session_id: string | null
  title: string
  goal: string
  status: TaskStatus
  plan: PlanItem[]
  progress: ProgressNote[]
  artifacts: string[]
  open_questions: string[]
  created_at: number
  updated_at: number
  closed_at: number | null
}

export interface TaskEvent {
  id: number
  task_id: string
  kind: TaskEventKind
  payload: Record<string, unknown>
  author: string | null
  created_at: number
}

/** plan entries address an existing item by id, or append one when the id is absent */
export interface PlanItemDelta {
  id?: string
  text?: string
  status?: PlanItemStatus
}

/** every field is a delta: progress and artifacts append, resolved_questions removes */
export interface TaskDelta {
  status?: TaskStatus
  title?: string
  goal?: string
  plan?: PlanItemDelta[]
  progress?: string[]
  artifacts?: string[]
  open_questions?: string[]
  resolved_questions?: string[]
}

export interface TaskStartInput {
  namespace: string
  title: string
  goal: string
  /** personal|project|team|org; a named principal defaults to personal */
  visibility?: string
  session_id?: string | null
  plan?: Array<string | PlanItemDelta>
  artifacts?: string[]
  open_questions?: string[]
  author?: string | null
  now?: number
}

export interface TaskWriteOptions {
  author?: string | null
  now?: number
}

export interface Brief {
  text: string
  budget_chars: number
  used_chars: number
  omitted: string[]
}

export type HandoffAudience = 'subagent' | 'new-session'

export const HANDOFF_AUDIENCES: HandoffAudience[] = ['subagent', 'new-session']

export interface HandoffBrief extends Brief {
  task_id: string
  for: HandoffAudience
}
