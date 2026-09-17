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
 * - NAV DIGESTS (sanctioned exception #1): a 'digest' job whose
 *   target_key starts with 'nav:' calls refreshNavDigest, which writes ONLY
 *   namespace_nodes.digest (thin navigation metadata) — never canonical
 *   memories, project_digests, memory_clusters, or memory_links.
 * - NAVTREE CONSOLIDATION (part of #1): a 'digest' job whose target_key
 *   starts with 'navtree:' runs consolidateTree, the bottom-up digest pass
 *   that writes only namespace_nodes.digest.
 * - PROMOTION (sanctioned exception #2): a 'promote' job whose target_key
 *   starts with 'promote:' runs promoteScopePatterns, which distills a leaf
 *   scope's memories into a single pattern memory in the parent namespace
 *   and links the sources. This is the consolidation pipeline, same class as
 *   digest refresh; it writes canonical pattern memories and memory_links.
 * - TREE PRIMING (part of #1): enqueueNamespaceMaintenance backfills
 *   namespace_nodes rows/counts, and enqueueEndSessionMaintenance ensures the
 *   node chain for the namespace it enqueues nav work for. Both write only
 *   tree metadata (namespace_nodes), which the nav layer needs in order to
 *   exist at all; neither touches canonical memories. Tree metadata feeds the
 *   guide/roster/routing inputs and the write-side scope candidates, so
 *   materializing it makes previously-inert scopes visible to those paths.
 *
 * Existing in-memory BackgroundJobQueues (adjudication/importance) are
 * preserved and independent; this layer runs beside them, not instead of.
 */
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import { ancestors, backfillTree, ensureNode, refreshNodeCounts } from '../namespace/tree.js'
import { refreshNavDigest } from '../memory/nav.js'
import { promoteScopePatterns } from './promote.js'
import { consolidateTree } from './consolidate.js'

export type MaintenanceJobType = 'digest' | 'cluster' | 'importance' | 'adjudication' | 'promote'
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
 * Job handlers. Non-nav, non-promote jobs remain shadow-only. The sanctioned
 * canonical-write exceptions (see the file header) are:
 *   - digest nav:      writes namespace_nodes.digest
 *   - digest navtree:  bottom-up digest consolidation (namespace_nodes.digest)
 *   - promote promote:: distills a leaf scope into a parent pattern memory
 */
async function shadowRun(db: Database.Database, job: MaintenanceJobRow): Promise<unknown> {
  switch (job.job_type) {
    case 'digest': {
      if (job.target_key.startsWith('navtree:')) {
        const namespace = job.target_key.slice('navtree:'.length)
        const result = await consolidateTree(db, namespace)
        return {
          shadow: false,
          navtree: true,
          namespace,
          refreshed: result.refreshed,
        }
      }
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
    case 'promote': {
      if (job.target_key.startsWith('promote:')) {
        const projectPath = job.target_key.slice('promote:'.length)
        const report = await promoteScopePatterns(db, projectPath)
        return {
          shadow: false,
          promotion: true,
          project_path: projectPath,
          ...report,
        }
      }
      return {
        shadow: true,
        note: 'malformed promote target_key (missing promote: prefix); no write',
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
    ['digest', 'cluster', 'importance', 'adjudication', 'promote'].map((t) => [t, 0])
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
      // parent node exists, its nearest existing ancestor's digest. The node
      // chain must be materialized first: refreshNavDigest silently no-ops
      // without a node row and ancestors() only returns materialized rows, so
      // before this the first end_session for a namespace enqueued nav jobs
      // that could never write anything. Materializing is idempotent, bounded
      // (a path chain is a handful of rows) and stays inside the never-throws
      // guarantee.
      ensureNode(db, targetKey)
      refreshNodeCounts(db, targetKey)

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

      // Pattern promotion: distills repeated leaf-scope patterns into the
      // parent namespace. Idempotent per (job_type, target_key), so repeated
      // end_session calls for the same namespace coalesce.
      const promote = enqueueMaintenanceJob(db, {
        jobType: 'promote',
        targetKey: `promote:${targetKey}`,
        source: 'end_session',
        now,
      })
      if (!promote.coalesced) enqueued++
    }
    return enqueued
  } catch (err) {
    logger.debug({ err }, 'maintenance: end_session enqueue failed (ignored)')
    return 0
  }
}

/**
 * Startup maintenance for every distinct namespace: shadow digest + cluster
 * jobs, tree priming, and one recursive consolidation job per forest root.
 *
 * Tree priming is the difference between a working nav layer and an empty one:
 * nothing else materializes `namespace_nodes` for memories that already exist
 * (nodes are otherwise created lazily by get_context / scoped store_memory), so
 * live data sat at 11 nodes / 3 digests with every memory_count at 0, and the
 * navtree executor had no enqueuer at all — recursive consolidation could never
 * run. `backfillTree` is idempotent, bounded and cheap (measured ~120ms for 15
 * namespaces) and writes tree metadata only: it cannot change which memories
 * any query returns, only the guide/roster/routing inputs derived from the tree.
 */
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

  // Materialize nodes + counts before enqueueing nav work so the digest jobs
  // have rows to write. Guarded so a priming failure cannot stop the shadow
  // enqueues (or daemon startup).
  try {
    const ensured = backfillTree(db)
    logger.debug({ ensured }, 'maintenance: namespace tree backfilled')
  } catch (err) {
    logger.warn({ err }, 'maintenance: tree backfill failed; nav layer stays unprimed')
  }

  // Forest roots are the nodes without a parent: '/', '~' and non-path roots.
  // consolidateTree walks a subtree bottom-up, so one job per root refreshes
  // every materialized descendant.
  const roots = db
    .prepare('SELECT path FROM namespace_nodes WHERE parent_path IS NULL ORDER BY path')
    .all() as Array<{ path: string }>
  for (const { path } of roots) {
    enqueueMaintenanceJob(db, {
      jobType: 'digest',
      targetKey: `navtree:${path}`,
      source: 'startup',
      now,
    })
  }

  return enqueued
}
