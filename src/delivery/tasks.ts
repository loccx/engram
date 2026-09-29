import type Database from 'better-sqlite3'
import { PROTOCOL_SLIM } from './protocol.js'
import { rosterHits, type RosterHit } from './roster.js'
import { getDigest } from '../memory/digest.js'
import { DEFAULT_BRIEF_CHARS, brief, handoff } from '../tasks/brief.js'
import { checkpointTask, latestOpenTask, listOpenTasks, updateTask } from '../tasks/store.js'
import type { Brief, HandoffAudience, TaskStatus } from '../tasks/types.js'
import { SessionManager } from '../session/manager.js'
import { enqueueEndSessionMaintenance, enqueueMaintenanceJob, isMaintenanceEnabled } from '../maintenance/jobs.js'
import { requestMaintenanceDrain } from '../maintenance/scheduler.js'

/**
 * the daemon side of the working tier: the operations a hook asks for, each one bounded
 * and namespace-scoped so a lifecycle event costs one local call and no host decision.
 */

export const DEFAULT_SESSION_START_CHARS = 2400
export const DEFAULT_SESSION_BRIEFS = 2
export const SUBAGENT_BRIEF_CHARS = 900
export const POST_COMPACT_BRIEF_CHARS = 1500

export interface TaskBriefPayload {
  task_id: string
  title: string
  status: TaskStatus
  for: 'session' | HandoffAudience
  brief: Brief
}

export interface OpenTaskBriefOptions {
  namespace: string
  sessionId?: string
  limit?: number
  /** split across the briefs that come back, so one task gets the whole budget */
  budgetChars?: number
  /** a session brief is the plain rendering; a handoff names its audience */
  for?: 'session' | HandoffAudience
}

export function openTaskBriefs(
  db: Database.Database,
  options: OpenTaskBriefOptions
): TaskBriefPayload[] {
  const audience = options.for ?? 'session'
  const tasks = listOpenTasks(db, options.namespace, {
    limit: options.limit ?? DEFAULT_SESSION_BRIEFS,
    sessionId: options.sessionId,
  })
  const budgetChars = Math.max(
    0,
    Math.floor((options.budgetChars ?? DEFAULT_BRIEF_CHARS) / Math.max(1, tasks.length))
  )
  return tasks.map((task) => ({
    task_id: task.id,
    title: task.title,
    status: task.status,
    for: audience,
    brief: audience === 'session' ? brief(task, budgetChars) : handoff(task, audience, budgetChars),
  }))
}

export interface SessionStartPayload {
  namespace: string
  rules: string
  digest: string | null
  tasks: TaskBriefPayload[]
  roster: RosterHit[]
  budget_chars: number
  used_chars: number
  truncated: string[]
}

function clip(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  return max <= 1 ? text.slice(0, max) : `${text.slice(0, max - 1)}…`
}

/**
 * the composite a host wants at session start or after compaction: rules, the task
 * brief, the pinned digest and the roster, packed into one budget in a fixed order.
 */
export function sessionStartPayload(
  db: Database.Database,
  options: { namespace: string; sessionId?: string; budgetChars?: number }
): SessionStartPayload {
  const budget = Math.max(0, Math.floor(options.budgetChars ?? DEFAULT_SESSION_START_CHARS))
  const truncated: string[] = []

  const rules = clip(PROTOCOL_SLIM, budget)
  if (rules !== PROTOCOL_SLIM) truncated.push('rules')
  if (rules.length >= budget) {
    return {
      namespace: options.namespace,
      rules,
      digest: null,
      tasks: [],
      roster: [],
      budget_chars: budget,
      used_chars: rules.length,
      truncated: [...truncated, 'tasks', 'digest', 'roster'],
    }
  }

  const briefShare = Math.floor((budget - rules.length) * 0.5)
  const tasks = openTaskBriefs(db, {
    namespace: options.namespace,
    sessionId: options.sessionId,
    limit: DEFAULT_SESSION_BRIEFS,
    budgetChars: briefShare,
  })
  const briefChars = tasks.reduce((n, entry) => n + entry.brief.used_chars + 1, 0)
  if (tasks.some((entry) => entry.brief.omitted.length > 0)) truncated.push('tasks')

  const digestShare = Math.floor((budget - rules.length - briefChars) * 0.5)
  const rawDigest = getDigest(db, options.namespace)
  const digest = rawDigest ? clip(rawDigest, Math.max(0, digestShare)) : null
  if (rawDigest && digest !== rawDigest) truncated.push('digest')

  const rosterShare = Math.max(0, budget - rules.length - briefChars - (digest?.length ?? 0))
  const roster = rosterShare > 0 ? rosterHits(db, options.namespace, { budgetChars: rosterShare }) : []

  const used =
    rules.length +
    briefChars +
    (digest?.length ?? 0) +
    roster.reduce((n, entry) => n + entry.preview.length, 0)

  return {
    namespace: options.namespace,
    rules,
    digest,
    tasks,
    roster,
    budget_chars: budget,
    used_chars: used,
    truncated,
  }
}

export interface CheckpointResult {
  task_ids: string[]
  events: number
  enqueued: number
}

/** pre-compact: one checkpoint event per open task, then queue consolidation. never blocks. */
export function checkpointOpenTasks(
  db: Database.Database,
  namespace: string,
  options: { sessionId?: string; reason?: string; now?: number } = {}
): CheckpointResult {
  const tasks = listOpenTasks(db, namespace, { limit: 50, sessionId: options.sessionId })
  let events = 0
  for (const task of tasks) {
    if (checkpointTask(db, task.id, { reason: options.reason, now: options.now })) events++
  }

  let enqueued = 0
  if (isMaintenanceEnabled()) {
    for (const jobType of ['digest', 'cluster', 'importance', 'adjudication'] as const) {
      const result = enqueueMaintenanceJob(db, {
        jobType,
        targetKey: namespace,
        source: 'pre_compact',
        now: options.now,
      })
      if (!result.coalesced) enqueued++
    }
    const nav = enqueueMaintenanceJob(db, {
      jobType: 'digest',
      targetKey: `nav:${namespace}`,
      source: 'pre_compact',
      now: options.now,
    })
    if (!nav.coalesced) enqueued++
    requestMaintenanceDrain(db)
  }

  return { task_ids: tasks.map((task) => task.id), events, enqueued }
}

export interface ProgressResult {
  recorded: boolean
  task_id: string | null
  reason?: string
}

/** subagent-stop: the returned summary becomes a progress note on the parent task */
export function recordTaskProgress(
  db: Database.Database,
  options: {
    namespace: string
    taskId?: string
    sessionId?: string
    text: string
    author?: string | null
    now?: number
  }
): ProgressResult {
  const text = options.text.replace(/\s+/g, ' ').trim()
  if (!text) return { recorded: false, task_id: null, reason: 'nothing to record' }

  const task = options.taskId
    ? listOpenTasks(db, options.namespace, { limit: 50 }).find((row) => row.id === options.taskId)
    : latestOpenTask(db, options.namespace, options.sessionId)
  if (!task) {
    return { recorded: false, task_id: null, reason: `no open task in ${options.namespace}` }
  }

  const updated = updateTask(db, task.id, { progress: [text] }, { author: options.author, now: options.now })
  return { recorded: updated !== null, task_id: task.id }
}

export interface SessionEndResult {
  ended: boolean
  session_id: string | null
  reason?: string
}

/** session-end: close the workspace session and queue its consolidation, fire and forget */
export function endWorkspaceSession(
  db: Database.Database,
  options: { namespace: string; sessionId?: string; summary?: string }
): SessionEndResult {
  const sessions = new SessionManager(db)
  const session = options.sessionId
    ? sessions.getById(options.sessionId)
    : sessions.getCurrentSession(options.namespace)
  if (!session) {
    return { ended: false, session_id: null, reason: `no session for ${options.namespace}` }
  }
  if (session.ended_at != null) {
    return { ended: false, session_id: session.id, reason: 'session already ended' }
  }

  const closed = sessions.end(session.id, options.summary)
  if (!closed) return { ended: false, session_id: session.id, reason: 'session disappeared' }
  enqueueEndSessionMaintenance(db, closed.id, closed.project_path)
  return { ended: true, session_id: closed.id }
}
