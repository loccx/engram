// durable maintenance job queue (schema in migration 009). handlers are
// shadow-only — inspect state, write a summary into the job row — apart from the
// sanctioned writes: nav digests and navtree consolidation (namespace_nodes
// only), promote, prune and retention.
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import { ancestors, backfillTree, ensureNode, refreshNodeCounts } from '../namespace/tree.js'
import { refreshNavDigest } from '../memory/nav.js'
import { promoteScopePatterns } from './promote.js'
import { consolidateTree } from './consolidate.js'
import { runDuplicatePrune } from './prune.js'
import { runRetention } from './retention.js'
import { requestMaintenanceDrain } from './scheduler.js'
import { reembedStaleEpisodes } from '../db/workers/reembed.js'
import { MODEL_ID } from '../embeddings/pipeline.js'

export type MaintenanceJobType =
  | 'digest'
  | 'cluster'
  | 'importance'
  | 'adjudication'
  | 'promote'
  | 'prune'
  | 'retention'
  | 'reembed_episodes'
export type MaintenanceStatus = 'queued' | 'running' | 'done' | 'failed' | 'dead'

/** one job turn embeds at most this many episodes, one call each, so a lease is safe */
export const EPISODE_REEMBED_JOB_LIMIT = 512
/** episodes claimed per iteration inside that turn */
const EPISODE_REEMBED_JOB_BATCH = 64

/** the coalescing key of the first page, and of every continuation after it */
export const EPISODE_REEMBED_TARGET = 'episodes:pending'

/** page N > 0 drains what page N-1 left; a bounded run never loses the backlog */
export function episodeReembedTargetKey(page: number): string {
  return page <= 0 ? EPISODE_REEMBED_TARGET : `${EPISODE_REEMBED_TARGET}:${page}`
}

/** next page for a target key, or 1 when the first page runs */
export function nextEpisodeReembedPage(targetKey: string): number {
  const suffix = targetKey.slice(EPISODE_REEMBED_TARGET.length)
  const page = suffix.startsWith(':') ? Number.parseInt(suffix.slice(1), 10) : 0
  return Number.isFinite(page) && page > 0 ? page + 1 : 1
}

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

/**
 * queue the episode-embed backlog for a deferred ingest. coalesced while a job is
 * active, so a stream of deferred batches keeps one turn's worth of work queued
 */
export function enqueueEpisodeReembed(
  db: Database.Database,
  opts: { source?: string; now?: number } = {}
): number {
  if (!isMaintenanceEnabled()) return 0
  try {
    const res = enqueueMaintenanceJob(db, {
      jobType: 'reembed_episodes',
      targetKey: EPISODE_REEMBED_TARGET,
      source: opts.source ?? 'deferred_ingest',
      now: opts.now,
    })
    if (!res.coalesced) requestMaintenanceDrain(db)
    return res.coalesced ? 0 : 1
  } catch (err) {
    logger.debug({ err }, 'maintenance: episode re-embed enqueue failed (ignored)')
    return 0
  }
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

/** lease owner for this process: startup and shutdown stay inside one process */
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
  // the active-row partial unique index is what makes this idempotent
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
 * claims the oldest eligible job — queued, failed with attempts left, or running
 * with an expired lease — and takes a new lease. null when nothing is claimable.
 */
export function claimMaintenanceJob(
  db: Database.Database,
  owner: string = MAINTENANCE_OWNER,
  now: number = Date.now()
): MaintenanceJobRow | null {
  const expires = now + leaseMs()
  const claim = db.transaction(() => {
    // expired lease with no attempts left: nothing can claim it again, so bury it
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

/** hand back everything this process still holds, on a clean shutdown */
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

// shadow-only handlers, plus the four sanctioned writers listed in the header
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
        // writes only namespace_nodes.digest; a missing node row is an empty no-op,
        // never a throw
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
    case 'reembed_episodes': {
      // a sanctioned writer (see the header): the vectors of evidence a deferred ingest
      // wrote lexically. off the write path, one episode per call, bounded so one job
      // turn stays short; a continuation page is enqueued when the bound is hit
      const stats = await reembedStaleEpisodes(db, MODEL_ID, {
        limit: EPISODE_REEMBED_JOB_LIMIT,
        batchSize: EPISODE_REEMBED_JOB_BATCH,
        pauseMs: 0,
      })
      if ((stats.remaining ?? 0) > 0) {
        enqueueMaintenanceJob(db, {
          jobType: 'reembed_episodes',
          targetKey: episodeReembedTargetKey(nextEpisodeReembedPage(job.target_key)),
          source: 'reembed_episodes',
        })
      }
      logger.debug(
        { target: job.target_key, embedded: stats.totalReembedded, remaining: stats.remaining ?? 0 },
        'maintenance: episode re-embed page done'
      )
      return {
        shadow: false,
        reembed_episodes: true,
        target: job.target_key,
        embedded: stats.totalReembedded,
        failed: stats.failed,
        remaining: stats.remaining ?? 0,
        duration_ms: stats.durationMs,
      }
    }
    case 'prune': {
      // idempotent: an archived row leaves the scan, so a retry finishes the work
      const target = job.target_key.startsWith('prune:')
        ? job.target_key.slice('prune:'.length)
        : job.target_key
      const namespace = target === '*' || target === '' ? undefined : target
      const report = runDuplicatePrune(db, namespace ? { namespace } : {})
      return {
        shadow: false,
        prune: true,
        namespace: namespace ?? null,
        scanned: report.scanned,
        truncated: report.truncated,
        groups: report.groups.length,
        redundant_rows: report.redundant_rows,
        keepers: report.keepers,
        archived: report.archived,
        links_repointed: report.links_repointed,
        links_removed: report.links_removed,
        threshold: report.threshold,
        prefix_chars: report.prefix_chars,
        duration_ms: report.duration_ms,
        // result_json is a status row, not a data dump, so the sample stays small
        sample: report.groups.slice(0, 50).map((g) => ({
          keeper_id: g.keeper_id,
          redundant_ids: g.redundant_ids,
          type: g.type,
          similarity: g.similarity,
        })),
      }
    }
    case 'retention': {
      // every guard lives in runRetention
      const target = job.target_key.startsWith('retention:')
        ? job.target_key.slice('retention:'.length)
        : job.target_key
      const namespace = target === '*' || target === 'global' || target === '' ? undefined : target
      const report = runRetention(db, namespace ? { namespace } : {})
      if (report.archived > 0) {
        logger.info(
          { archived: report.archived, corpus: report.corpus_size, namespace: namespace ?? null },
          'maintenance: retention archived redundant/cold memories'
        )
      }
      return {
        shadow: false,
        retention: true,
        namespace: namespace ?? null,
        corpus_size: report.corpus_size,
        scanned: report.scanned,
        below_threshold: report.below_threshold,
        eligible: report.eligible,
        archived: report.archived,
        threshold: report.threshold,
        min_age_days: report.min_age_days,
        skipped: report.skipped,
        sample: report.candidates.slice(0, 25),
        duration_ms: report.duration_ms,
      }
    }
  }
}

/**
 * claim → run → complete until maxJobs; re-claiming after a lease expiry is safe
 * because handlers do not mutate canonical state
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
    [
      'digest',
      'cluster',
      'importance',
      'adjudication',
      'promote',
      'prune',
      'retention',
      'reembed_episodes',
    ].map((t) => [t, 0])
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
 * best-effort enqueue after a session ends; coalesced by the active-job index and
 * never throwing (the tool must not fail on maintenance). keys use
 * COALESCE(namespace, project_path) so jobs land where the digest reads.
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

      // materialize the node chain first: refreshNavDigest no-ops without a row and
      // ancestors() only returns materialized rows, so the nav jobs below could
      // never write anything
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

      // distills repeated leaf patterns into the parent; coalesces per
      // (job_type, target_key)
      const promote = enqueueMaintenanceJob(db, {
        jobType: 'promote',
        targetKey: `promote:${targetKey}`,
        source: 'end_session',
        now,
      })
      if (!promote.coalesced) enqueued++
    }
    // fire and forget, and armed by the daemon only, so a library/test caller
    // keeps enqueue deterministic
    if (enqueued > 0) requestMaintenanceDrain(db)
    return enqueued
  } catch (err) {
    logger.debug({ err }, 'maintenance: end_session enqueue failed (ignored)')
    return 0
  }
}

// startup pass over every known namespace. this is the only thing that
// materializes namespace_nodes for existing memories, and only tree metadata —
// it cannot change which memories a query returns, only the nav layer's inputs
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

  // before the nav enqueues, or those jobs have no rows to write; a priming
  // failure must not stop startup
  try {
    const ensured = backfillTree(db)
    logger.debug({ ensured }, 'maintenance: namespace tree backfilled')
  } catch (err) {
    logger.warn({ err }, 'maintenance: tree backfill failed; nav layer stays unprimed')
  }

  // parentless roots ('/', '~', non-path): one job per root covers every
  // materialized descendant, since the walk is bottom-up
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

  // one coalesced global job per boot; the size guard lives in the handler
  enqueueMaintenanceJob(db, {
    jobType: 'retention',
    targetKey: 'retention:global',
    source: 'startup',
    now,
  })

  return enqueued
}
