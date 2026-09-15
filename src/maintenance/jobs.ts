/**
 * Durable maintenance job queue (see migration 009 for schema).
 *
 * Behavior contract:
 * - Idempotent enqueue: the partial unique index on (job_type, target_key)
 *   for active rows coalesces duplicate enqueues.
 * - Atomic claim: single-statement UPDATE with lease semantics; SQLite's
 *   single-writer makes it race-free. Expired leases are reclaimable.
 * - Retries: attempts are capped by max_attempts; exceeded attempts land in
 *   the terminal 'dead' state.
 * - SHADOW MODE (default, safe by construction): every handler only inspects
 *   state and writes a summary to the job row's result_json. No handler ever
 *   writes/deletes canonical memories, promotes procedures, writes
 *   contradiction links, or mutates digests/clusters/importance.
 * - NAV DIGESTS (the one sanctioned exception): a 'digest' job whose
 *   target_key starts with 'nav:' calls refreshNavDigest, which writes ONLY
 *   namespace_nodes.digest (thin navigation metadata) — never canonical
 *   memories, project_digests, memory_clusters, or memory_links.
 *
 * Existing in-memory BackgroundJobQueues (adjudication/importance) are
 * preserved and independent; this layer runs beside them, not instead of.
 */
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import { ancestors } from '../namespace/tree.js'
import { refreshNavDigest } from '../memory/nav.js'

export type MaintenanceJobType = 'digest' | 'cluster' | 'importance' | 'adjudication'
export type MaintenanceStatus = 'queued' | 'running' | 'done' | 'failed' | 'dead'

export interface MaintenanceJobRow {
  id: number
  job_type: MaintenanceJobType
  target_key: string
  status: MaintenanceStatus
  attempt: number
  max_attempts: number
  lease_expires_at: number | null
  enqueued_at: number
  started_at: number | null
  finished_at: number | null
  last_error: string | null
  result_json: string | null
  source: string | null
}

export interface EnqueueOptions {
  jobType: MaintenanceJobType
  targetKey: string
  source?: string
  now?: number
}

export interface CompleteOptions {
  status: 'done' | 'failed' | 'dead'
  result?: unknown
  error?: string
  now?: number
}

/** Per-process lease owner; startup/shutdown stay within one process. */
export const MAINTENANCE_OWNER = randomUUID()

const DEFAULT_LEASE_MS = 5 * 60 * 1000

export function isMaintenanceEnabled(): boolean {
  return process.env.ENGRAM_MAINTENANCE_DISABLED?.trim() !== '1'
}

function leaseMs(): number {
  const raw = process.env.ENGRAM_MAINTENANCE_LEASE_MS
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEASE_MS
}

function maxAttempts(): number {
  const raw = process.env.ENGRAM_MAINTENANCE_MAX_ATTEMPTS
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n >= 1 ? n : 3
}

function maxJobsPerRun(): number {
  const raw = process.env.ENGRAM_MAINTENANCE_MAX_PER_RUN
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n >= 1 ? n : 20
}

export function enqueueMaintenanceJob(
  db: Database.Database,
  opts: EnqueueOptions
): { id: number; coalesced: boolean } {
  const now = opts.now ?? Date.now()
  const attempts = maxAttempts()
  // Active-row partial unique index makes this idempotent.
  const info = db
    .prepare(
      `INSERT INTO maintenance_jobs
         (job_type, target_key, status, max_attempts, enqueued_at, source)
       VALUES (?, ?, 'queued', ?, ?, ?)
       ON CONFLICT(job_type, target_key) WHERE status IN ('queued', 'running') DO NOTHING`
    )
    .run(opts.jobType, opts.targetKey, attempts, now, opts.source ?? null)
  if (info.changes > 0) {
    return { id: Number(info.lastInsertRowid), coalesced: false }
  }
  const existing = db
    .prepare(
      `SELECT id FROM maintenance_jobs
       WHERE job_type = ? AND target_key = ? AND status IN ('queued', 'running')
       ORDER BY id LIMIT 1`
    )
    .get(opts.jobType, opts.targetKey) as { id: number } | undefined
  return { id: existing?.id ?? 0, coalesced: true }
}

/**
 * Atomically claim the oldest eligible job: queued, failed with attempts
 * remaining (retry), or running with an expired lease. Sets a new lease and
 * bumps attempt. Before claiming, expired running jobs that already reached
 * max_attempts are swept to the terminal 'dead' state so they can never
 * become eternal zombies. Returns null when nothing is claimable.
 */
export function claimMaintenanceJob(
  db: Database.Database,
  owner: string = MAINTENANCE_OWNER,
  now: number = Date.now()
): MaintenanceJobRow | null {
  const expires = now + leaseMs()
  const claim = db.transaction(() => {
    // Zombie sweep: a running job whose lease expired and whose attempts are
    // exhausted can never be claimed again — move it to 'dead' instead of
    // leaving it 'running' forever.
    db.prepare(
      `UPDATE maintenance_jobs
       SET status = 'dead',
           finished_at = COALESCE(finished_at, ?),
           last_error = COALESCE(last_error, 'lease expired with no attempts remaining'),
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE status = 'running'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < ?
         AND attempt >= max_attempts`
    ).run(now, now)

    const info = db
      .prepare(
        `UPDATE maintenance_jobs
         SET status = 'running',
             lease_owner = ?,
             lease_expires_at = ?,
             attempt = attempt + 1,
             started_at = COALESCE(started_at, ?),
             last_error = NULL
         WHERE id = (
           SELECT id FROM maintenance_jobs
           WHERE (status = 'queued'
                  OR status = 'failed'
                  OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?))
             AND attempt < max_attempts
           ORDER BY id LIMIT 1
         )`
      )
      .run(owner, expires, now, now)
    if (info.changes === 0) return null

    const row = db
      .prepare(
        `SELECT id, job_type, target_key, status, attempt, max_attempts, lease_expires_at,
                enqueued_at, started_at, finished_at, last_error, result_json, source
         FROM maintenance_jobs
         WHERE lease_owner = ? AND status = 'running'
         ORDER BY id DESC LIMIT 1`
      )
      .get(owner) as MaintenanceJobRow | undefined
    return row ?? null
  })
  return claim()
}

export function completeMaintenanceJob(
  db: Database.Database,
  id: number,
  opts: CompleteOptions
): void {
  const now = opts.now ?? Date.now()
  db.prepare(
    `UPDATE maintenance_jobs
     SET status = ?,
         finished_at = ?,
         last_error = ?,
         result_json = ?,
         lease_owner = NULL,
         lease_expires_at = NULL
     WHERE id = ?`
  ).run(
    opts.status,
    now,
    opts.error ?? null,
    opts.result === undefined ? null : JSON.stringify(opts.result),
    id
  )
}

/** Requeue everything this process currently holds (clean shutdown). */
export function releaseOwnedLeases(db: Database.Database, owner: string = MAINTENANCE_OWNER): number {
  const info = db
    .prepare(
      `UPDATE maintenance_jobs
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL
       WHERE status = 'running' AND lease_owner = ?`
    )
    .run(owner)
  return info.changes
}

/**
 * Job handlers. Non-nav jobs remain shadow-only: they inspect state and
 * return a summary without writing memories, project_digests,
 * memory_clusters, or memory_links. The nav: digest branch is the sanctioned
 * exception — it writes only namespace_nodes.digest (see the file header).
 */
async function shadowRun(db: Database.Database, job: MaintenanceJobRow): Promise<unknown> {
  switch (job.job_type) {
    case 'digest': {
      if (job.target_key.startsWith('nav:')) {
        // Nav-layer digest: writes only namespace_nodes.digest (see header).
        // refreshNavDigest no-ops (returns empty, changed:false) when the
        // node row is missing and never throws.
        const namespace = job.target_key.slice('nav:'.length)
        const result = await refreshNavDigest(db, namespace)
        return {
          shadow: false,
          nav_digest: true,
          namespace,
          digest_chars: result.content.length,
          changed: result.changed,
        }
      }
      const pinned = db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS chars
           FROM memories
           WHERE COALESCE(namespace, project_path) = ? AND pinned = 1`
        )
        .get(job.target_key) as { n: number; chars: number }
      const existing = db
        .prepare('SELECT LENGTH(content) AS chars FROM project_digests WHERE namespace = ?')
        .get(job.target_key) as { chars: number } | undefined
      return {
        shadow: true,
        pinned_count: pinned.n,
        pinned_chars: pinned.chars,
        existing_digest_chars: existing?.chars ?? 0,
        digest_missing: (existing?.chars ?? 0) === 0 && pinned.n > 0,
        note: 'no canonical digest write in shadow mode',
      }
    }
    case 'cluster': {
      const clusters = db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(member_ids)), 0) AS member_json_chars
           FROM memory_clusters WHERE project_path = ?`
        )
        .get(job.target_key) as { n: number; member_json_chars: number }
      return {
        shadow: true,
        cluster_count: clusters.n,
        member_json_chars: clusters.member_json_chars,
        note: 'no cluster rebuild/write in shadow mode',
      }
    }
    case 'importance': {
      const memory = db
        .prepare(
          `SELECT importance_source, importance FROM memories
           WHERE COALESCE(namespace, project_path) = ?
           ORDER BY id LIMIT 1`
        )
        .get(job.target_key) as { importance_source: string; importance: number } | undefined
      const unscored = db
        .prepare(
          `SELECT COUNT(*) AS n FROM memories
           WHERE COALESCE(namespace, project_path) = ? AND importance_source = 'default'`
        )
        .get(job.target_key) as { n: number }
      return {
        shadow: true,
        sample_memory_exists: memory !== undefined,
        sample_importance_source: memory?.importance_source ?? null,
        unscored_count: unscored.n,
        note: 'no importance rewrite in shadow mode',
      }
    }
    case 'adjudication': {
      const pending = db
        .prepare(
          `SELECT COUNT(*) AS n FROM memories
           WHERE COALESCE(namespace, project_path) = ? AND adjudication_state = 'pending'`
        )
        .get(job.target_key) as { n: number }
      const supersedeLinks = db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_links ml
           JOIN memories m ON m.id = ml.source_id
           WHERE COALESCE(m.namespace, m.project_path) = ? AND ml.link_type = 'supersedes'`
        )
        .get(job.target_key) as { n: number }
      return {
        shadow: true,
        pending_adjudications: pending.n,
        supersedes_links: supersedeLinks.n,
        note: 'no contradiction writes in shadow mode',
      }
    }
  }
}

/**
 * Bounded drain loop: claim → shadow-run → complete. Returns counts.
 * Safe in shadow mode even when the same job is claimed twice after a lease
 * expiry, because handlers never mutate canonical state.
 */
export async function runPendingMaintenanceJobs(
  db: Database.Database,
  opts: { owner?: string; maxJobs?: number; now?: number } = {}
): Promise<{ claimed: number; done: number; failed: number }> {
  const owner = opts.owner ?? MAINTENANCE_OWNER
  const maxJobs = opts.maxJobs ?? maxJobsPerRun()
  let claimed = 0
  let done = 0
  let failed = 0
  const nowFn = () => opts.now ?? Date.now()

  for (let i = 0; i < maxJobs; i++) {
    const job = claimMaintenanceJob(db, owner, nowFn())
    if (!job) break
    claimed++
    try {
      const result = await shadowRun(db, job)
      completeMaintenanceJob(db, job.id, { status: 'done', result, now: nowFn() })
      done++
      logger.debug({ jobId: job.id, jobType: job.job_type, targetKey: job.target_key }, 'maintenance: shadow job done')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const attemptExhausted = job.attempt + 1 >= job.max_attempts
      completeMaintenanceJob(db, job.id, {
        status: attemptExhausted ? 'dead' : 'failed',
        error: message,
        now: nowFn(),
      })
      failed++
      logger.warn({ err, jobId: job.id, jobType: job.job_type }, 'maintenance: shadow job failed')
    }
  }
  return { claimed, done, failed }
}

export interface MaintenanceStatusSummary {
  enabled: boolean
  jobs: {
    total: number
    by_status: Record<MaintenanceStatus, number>
    by_type: Record<MaintenanceJobType, number>
  }
  recent: Array<{
    id: number
    job_type: MaintenanceJobType
    target_key: string
    status: MaintenanceStatus
    attempt: number
    max_attempts: number
    enqueued_at: number
    started_at: number | null
    finished_at: number | null
    last_error: string | null
    result_json: unknown
    source: string | null
  }>
}

export function getMaintenanceStatus(
  db: Database.Database,
  limit: number = 20
): MaintenanceStatusSummary {
  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM maintenance_jobs').get() as { n: number }
  ).n
  const byStatus = Object.fromEntries(
    ['queued', 'running', 'done', 'failed', 'dead'].map((s) => [s, 0])
  ) as Record<MaintenanceStatus, number>
  const byType = Object.fromEntries(
    ['digest', 'cluster', 'importance', 'adjudication'].map((t) => [t, 0])
  ) as Record<MaintenanceJobType, number>
  for (const row of db
    .prepare('SELECT status, job_type, COUNT(*) AS n FROM maintenance_jobs GROUP BY status, job_type')
    .all() as Array<{ status: MaintenanceStatus; job_type: MaintenanceJobType; n: number }>) {
    byStatus[row.status] += row.n
    byType[row.job_type] += row.n
  }

  const recent = (
    db
      .prepare(
        `SELECT id, job_type, target_key, status, attempt, max_attempts,
                enqueued_at, started_at, finished_at, last_error, result_json, source
         FROM maintenance_jobs ORDER BY id DESC LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, 200))) as Array<Omit<MaintenanceStatusSummary['recent'][0], 'result_json'> & { result_json: string | null }>
  ).map((r) => {
    let parsed: unknown = null
    if (r.result_json) {
      try {
        parsed = JSON.parse(r.result_json)
      } catch {
        parsed = r.result_json
      }
    }
    const { result_json: _rj, ...rest } = r
    void _rj
    return { ...rest, result_json: parsed }
  })

  return {
    enabled: isMaintenanceEnabled(),
    jobs: { total, by_status: byStatus, by_type: byType },
    recent,
  }
}

/**
 * Best-effort maintenance enqueue after a session ends. Coalesced by the
 * active-job partial index, so repeated end_session calls stay cheap. Never
 * throws: the MCP tool must not fail because of maintenance.
 *
 * Target keys follow COALESCE(namespace, project_path) — the same resolution
 * digest reads and the shadow digest handler use — so a session whose
 * memories carry a namespace override enqueues jobs under that namespace,
 * never under a raw project_path that would refresh an empty digest row.
 */
export function enqueueEndSessionMaintenance(
  db: Database.Database,
  sessionId: string,
  projectPath: string,
  now?: number
): number {
  if (!isMaintenanceEnabled()) return 0
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT COALESCE(namespace, project_path) AS ns
         FROM memories WHERE session_id = ?`
      )
      .all(sessionId) as Array<{ ns: string }>
    const keys = rows.length > 0 ? rows.map((r) => r.ns) : [projectPath]
    let enqueued = 0
    for (const targetKey of keys) {
      for (const jobType of ['digest', 'cluster', 'importance', 'adjudication'] as const) {
        const res = enqueueMaintenanceJob(db, {
          jobType,
          targetKey,
          source: 'end_session',
          now,
        })
        if (!res.coalesced) enqueued++
      }

      // Nav-layer digests: refresh this namespace's thin digest and, when a
      // parent node exists, its nearest existing ancestor's digest. Both no-op
      // safely when the node row is absent (refreshNavDigest returns empty),
      // so a fresh namespace never fails an end_session call.
      const navSelf = enqueueMaintenanceJob(db, {
        jobType: 'digest',
        targetKey: `nav:${targetKey}`,
        source: 'end_session',
        now,
      })
      if (!navSelf.coalesced) enqueued++

      const nodeAncestors = ancestors(db, targetKey)
      const nearestAncestor =
        nodeAncestors.length > 0 ? nodeAncestors[nodeAncestors.length - 1] : null
      if (nearestAncestor && nearestAncestor.path !== targetKey) {
        const navParent = enqueueMaintenanceJob(db, {
          jobType: 'digest',
          targetKey: `nav:${nearestAncestor.path}`,
          source: 'end_session',
          now,
        })
        if (!navParent.coalesced) enqueued++
      }
    }
    return enqueued
  } catch (err) {
    logger.debug({ err }, 'maintenance: end_session enqueue failed (ignored)')
    return 0
  }
}

/** Enqueue digest/cluster shadow jobs for every distinct namespace. */
export function enqueueNamespaceMaintenance(db: Database.Database, now?: number): number {
  const namespaces = db
    .prepare('SELECT DISTINCT COALESCE(namespace, project_path) AS ns FROM memories')
    .all() as Array<{ ns: string }>
  let enqueued = 0
  for (const { ns } of namespaces) {
    if (ns) {
      enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: ns, source: 'startup', now })
      enqueueMaintenanceJob(db, { jobType: 'cluster', targetKey: ns, source: 'startup', now })
      enqueued++
    }
  }
  return enqueued
}
