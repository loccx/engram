import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { currentCaller, visibilityClause, visibilityOf, type CallerScope } from '../memory/access.js'
import {
  CLOSED_STATUSES,
  PLAN_ITEM_STATUSES,
  TASK_STATUSES,
  type PlanItem,
  type PlanItemDelta,
  type PlanItemStatus,
  type ProgressNote,
  type Task,
  type TaskDelta,
  type TaskEvent,
  type TaskEventKind,
  type TaskStartInput,
  type TaskStatus,
  type TaskWriteOptions,
} from './types.js'

/**
 * the working-state store. every mutation is a delta, and every delta lands in the
 * append-only task_events log in the same transaction, so a progress claim can always
 * be traced back to who wrote it and when.
 */

interface TaskRow {
  id: string
  namespace: string
  session_id: string | null
  title: string
  goal: string
  status: string
  plan_json: string
  progress_json: string
  artifacts_json: string
  open_questions_json: string
  created_at: number
  updated_at: number
  closed_at: number | null
  owner_principal?: string | null
  visibility?: string | null
}

interface EventRow {
  id: number
  task_id: string
  kind: string
  payload_json: string
  author: string | null
  created_at: number
}

const DEFAULT_OPEN_TASKS = 2
const EVENT_TAIL = 50

function parseColumn<T>(raw: string, taskId: string, column: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(
      `Engram: task ${taskId} has an unreadable ${column}; the row was not written by task_start/task_update`
    )
  }
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    namespace: row.namespace,
    owner_principal: row.owner_principal ?? null,
    visibility: row.visibility ?? null,
    session_id: row.session_id,
    title: row.title,
    goal: row.goal,
    status: row.status as TaskStatus,
    plan: parseColumn<PlanItem[]>(row.plan_json, row.id, 'plan_json'),
    progress: parseColumn<ProgressNote[]>(row.progress_json, row.id, 'progress_json'),
    artifacts: parseColumn<string[]>(row.artifacts_json, row.id, 'artifacts_json'),
    open_questions: parseColumn<string[]>(row.open_questions_json, row.id, 'open_questions_json'),
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
  }
}

function rowToEvent(row: EventRow): TaskEvent {
  return {
    id: row.id,
    task_id: row.task_id,
    kind: row.kind as TaskEventKind,
    payload: parseColumn<Record<string, unknown>>(row.payload_json, row.task_id, 'payload_json'),
    author: row.author,
    created_at: row.created_at,
  }
}

export function assertTaskStatus(value: string): asserts value is TaskStatus {
  if (!(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Engram: status "${value}" is not one of ${TASK_STATUSES.join('|')}`)
  }
}

function assertPlanStatus(value: string): asserts value is PlanItemStatus {
  if (!(PLAN_ITEM_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Engram: plan item status "${value}" is not one of ${PLAN_ITEM_STATUSES.join('|')}`)
  }
}

export function appendTaskEvent(
  db: Database.Database,
  taskId: string,
  kind: TaskEventKind,
  payload: Record<string, unknown>,
  author: string | null = null,
  now: number = Date.now()
): TaskEvent {
  const result = db
    .prepare(
      `INSERT INTO task_events (task_id, kind, payload_json, author, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(taskId, kind, JSON.stringify(payload), author, now)
  return {
    id: Number(result.lastInsertRowid),
    task_id: taskId,
    kind,
    payload,
    author,
    created_at: now,
  }
}

function planItem(entry: string | PlanItemDelta, index: number): PlanItem {
  const text = typeof entry === 'string' ? entry : entry.text
  if (!text || !text.trim()) {
    throw new Error(`Engram: plan item ${index} needs text`)
  }
  const status = typeof entry === 'string' ? undefined : entry.status
  if (status) assertPlanStatus(status)
  return { id: `p${index}`, text: text.trim(), status: status ?? 'pending' }
}

function cleanList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean)
}

export function createTask(db: Database.Database, input: TaskStartInput): Task {
  const now = input.now ?? Date.now()
  const id = randomUUID()
  const plan = (input.plan ?? []).map((entry, index) => planItem(entry, index + 1))
  const artifacts = [...new Set(cleanList(input.artifacts))]
  const questions = [...new Set(cleanList(input.open_questions))]

  const caller = currentCaller()
  db.prepare(
    `INSERT INTO tasks (id, namespace, session_id, title, goal, status, plan_json, progress_json, artifacts_json, open_questions_json, created_at, updated_at, owner_principal, visibility)
     VALUES (?, ?, ?, ?, ?, 'open', ?, '[]', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.namespace,
    input.session_id ?? null,
    input.title.trim(),
    input.goal.trim(),
    JSON.stringify(plan),
    JSON.stringify(artifacts),
    JSON.stringify(questions),
    now,
    now,
    caller.localOwner ? null : caller.principalId,
    visibilityOf(caller, input.visibility)
  )

  appendTaskEvent(db, id, 'update', { created: true }, input.author ?? null, now)
  return getTask(db, id)!
}

export function getTask(db: Database.Database, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  return row ? rowToTask(row) : null
}

export interface ListTasksOptions {
  namespace: string
  /** absent means every status */
  status?: TaskStatus
  limit?: number
  /** the identity the listing is served as; defaults to the caller in scope */
  caller?: CallerScope
}

export function listTasks(db: Database.Database, options: ListTasksOptions): Task[] {
  const limit = options.limit ?? DEFAULT_OPEN_TASKS
  const visibility = visibilityClause('tasks', options.caller)
  const rows = options.status
    ? (db
        .prepare(
          `SELECT * FROM tasks WHERE namespace = ? AND status = ? AND ${visibility.sql}
           ORDER BY updated_at DESC, id ASC LIMIT ?`
        )
        .all(options.namespace, options.status, ...visibility.params, limit) as TaskRow[])
    : (db
        .prepare(
          `SELECT * FROM tasks WHERE namespace = ? AND ${visibility.sql}
           ORDER BY updated_at DESC, id ASC LIMIT ?`
        )
        .all(options.namespace, ...visibility.params, limit) as TaskRow[])
  return rows.map(rowToTask)
}

export function listOpenTasks(
  db: Database.Database,
  namespace: string,
  options: { limit?: number; sessionId?: string } = {}
): Task[] {
  const limit = options.limit ?? DEFAULT_OPEN_TASKS
  const open = "status IN ('open', 'blocked')"
  const visibility = visibilityClause('tasks')
  const rows = options.sessionId
    ? (db
        .prepare(
          `SELECT * FROM tasks WHERE namespace = ? AND ${open} AND ${visibility.sql}
           ORDER BY CASE WHEN session_id = ? THEN 0 ELSE 1 END, updated_at DESC, id ASC LIMIT ?`
        )
        .all(namespace, ...visibility.params, options.sessionId, limit) as TaskRow[])
    : (db
        .prepare(
          `SELECT * FROM tasks WHERE namespace = ? AND ${open} AND ${visibility.sql}
           ORDER BY updated_at DESC, id ASC LIMIT ?`
        )
        .all(namespace, ...visibility.params, limit) as TaskRow[])
  return rows.map(rowToTask)
}

/** the newest open task in a namespace: what a hook with no task id should write to */
export function latestOpenTask(
  db: Database.Database,
  namespace: string,
  sessionId?: string
): Task | null {
  return listOpenTasks(db, namespace, { limit: 1, sessionId })[0] ?? null
}

export function listTaskEvents(db: Database.Database, taskId: string, limit = EVENT_TAIL): TaskEvent[] {
  const rows = db
    .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?')
    .all(taskId, limit) as EventRow[]
  return rows.map(rowToEvent).reverse()
}

export interface UpdateResult {
  task: Task
  /** only the keys that changed; empty means the delta was a no-op and nothing was logged */
  applied: TaskDelta
}

export function updateTask(
  db: Database.Database,
  id: string,
  delta: TaskDelta,
  options: TaskWriteOptions = {}
): UpdateResult | null {
  const task = getTask(db, id)
  if (!task) return null
  const now = options.now ?? Date.now()
  const author = options.author ?? null

  let status = task.status
  let title = task.title
  let goal = task.goal
  let plan = task.plan
  let progress = task.progress
  let artifacts = task.artifacts
  let questions = task.open_questions
  let closedAt = task.closed_at
  const applied: TaskDelta = {}

  if (delta.status !== undefined && delta.status !== status) {
    assertTaskStatus(delta.status)
    status = delta.status
    closedAt = CLOSED_STATUSES.includes(status) ? (task.closed_at ?? now) : null
    applied.status = status
  }
  if (delta.title !== undefined && delta.title.trim() && delta.title.trim() !== title) {
    title = delta.title.trim()
    applied.title = title
  }
  if (delta.goal !== undefined && delta.goal.trim() && delta.goal.trim() !== goal) {
    goal = delta.goal.trim()
    applied.goal = goal
  }

  if (delta.plan && delta.plan.length > 0) {
    const next = [...plan]
    const appliedPlan: PlanItemDelta[] = []
    for (const entry of delta.plan) {
      if (entry.id) {
        const index = next.findIndex((item) => item.id === entry.id)
        if (index < 0) {
          throw new Error(
            `Engram: plan item ${entry.id} is not in task ${id}; call task_get for the current plan`
          )
        }
        const item = { ...next[index] }
        const appliedEntry: PlanItemDelta = { id: item.id }
        if (entry.text !== undefined && entry.text.trim()) {
          item.text = entry.text.trim()
          appliedEntry.text = item.text
        }
        if (entry.status !== undefined) {
          assertPlanStatus(entry.status)
          item.status = entry.status
          appliedEntry.status = item.status
        }
        next[index] = item
        appliedPlan.push(appliedEntry)
      } else {
        if (!entry.text || !entry.text.trim()) {
          throw new Error('Engram: a plan item without an id needs text')
        }
        const item: PlanItem = {
          id: `p${next.length + 1}`,
          text: entry.text.trim(),
          status: entry.status ?? 'pending',
        }
        assertPlanStatus(item.status)
        next.push(item)
        appliedPlan.push({ id: item.id, text: item.text, status: item.status })
      }
    }
    plan = next
    applied.plan = appliedPlan
  }

  const notes = cleanList(delta.progress)
  if (notes.length > 0) {
    progress = [...progress, ...notes.map((text) => ({ text, author, created_at: now }))]
    applied.progress = notes
  }

  const addedArtifacts = cleanList(delta.artifacts).filter((value) => !artifacts.includes(value))
  if (addedArtifacts.length > 0) {
    artifacts = [...artifacts, ...addedArtifacts]
    applied.artifacts = addedArtifacts
  }

  const addedQuestions = cleanList(delta.open_questions).filter((value) => !questions.includes(value))
  if (addedQuestions.length > 0) {
    questions = [...questions, ...addedQuestions]
    applied.open_questions = addedQuestions
  }

  const resolved = cleanList(delta.resolved_questions)
  if (resolved.length > 0) {
    const wanted = new Set(resolved)
    const kept = questions.filter((question) => !wanted.has(question))
    if (kept.length !== questions.length) {
      questions = kept
      applied.resolved_questions = [...wanted]
    }
  }

  if (Object.keys(applied).length === 0) return { task, applied }

  db.prepare(
    `UPDATE tasks
     SET title = ?, goal = ?, status = ?, plan_json = ?, progress_json = ?, artifacts_json = ?, open_questions_json = ?, updated_at = ?, closed_at = ?
     WHERE id = ?`
  ).run(
    title,
    goal,
    status,
    JSON.stringify(plan),
    JSON.stringify(progress),
    JSON.stringify(artifacts),
    JSON.stringify(questions),
    now,
    closedAt,
    id
  )

  appendTaskEvent(db, id, 'update', { ...applied }, author, now)
  return { task: getTask(db, id)!, applied }
}

export function checkpointTask(db: Database.Database, id: string, options: TaskWriteOptions & { reason?: string } = {}): TaskEvent | null {
  const task = getTask(db, id)
  if (!task) return null
  return appendTaskEvent(
    db,
    id,
    'checkpoint',
    {
      reason: options.reason ?? null,
      status: task.status,
      plan_active: task.plan.filter((item) => item.status === 'active').length,
      progress_notes: task.progress.length,
      open_questions: task.open_questions.length,
    },
    options.author ?? null,
    options.now ?? Date.now()
  )
}

export interface CloseOptions extends TaskWriteOptions {
  status?: TaskStatus
  /** the summary memory the caller wrote for this close, when the write was accepted */
  summaryMemoryId?: string | null
}

/** idempotent: a task already done or abandoned is returned unchanged, with no new event */
export function closeTask(db: Database.Database, id: string, options: CloseOptions = {}): Task | null {
  const task = getTask(db, id)
  if (!task) return null
  if (CLOSED_STATUSES.includes(task.status)) return task

  const status = options.status ?? 'done'
  assertTaskStatus(status)
  if (!CLOSED_STATUSES.includes(status)) {
    throw new Error(`Engram: close status "${status}" is not one of ${CLOSED_STATUSES.join('|')}`)
  }

  const now = options.now ?? Date.now()
  db.prepare('UPDATE tasks SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?').run(
    status,
    now,
    now,
    id
  )
  appendTaskEvent(
    db,
    id,
    'close',
    { status, ...(options.summaryMemoryId ? { summary_memory_id: options.summaryMemoryId } : {}) },
    options.author ?? null,
    now
  )
  return getTask(db, id)!
}

/** one durable memory for a finished task: the why it existed, what it got done, what is left */
export function taskSummary(task: Task, extra?: string): string {
  const lines = [`task "${task.title}" (${task.status}): ${task.goal}`]
  const done = task.plan.filter((item) => item.status === 'done').length
  if (task.plan.length > 0) lines.push(`plan ${done}/${task.plan.length} done`)
  const unfinished = task.plan.filter((item) => item.status !== 'done').map((item) => item.text)
  if (unfinished.length > 0) lines.push(`unfinished: ${unfinished.join('; ')}`)
  const last = task.progress[task.progress.length - 1]
  if (last) lines.push(`last progress: ${last.text}`)
  if (task.open_questions.length > 0) lines.push(`open questions: ${task.open_questions.join('; ')}`)
  if (task.artifacts.length > 0) lines.push(`artifacts: ${task.artifacts.join(', ')}`)
  if (extra && extra.trim()) lines.push(extra.trim())
  return lines.join('\n')
}
