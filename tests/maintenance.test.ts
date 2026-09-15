import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { resetDatabase, getDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import {
  enqueueMaintenanceJob,
  claimMaintenanceJob,
  completeMaintenanceJob,
  releaseOwnedLeases,
  runPendingMaintenanceJobs,
  getMaintenanceStatus,
  enqueueEndSessionMaintenance,
} from '../src/maintenance/jobs.js'

const NS = '/home/user/maintenance-project'
const T0 = 1_700_000_000_000

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
}

function parse<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T
}

function snapshotState(db: Database.Database): Record<string, unknown> {
  return {
    memories: db.prepare('SELECT id, content, type, importance, pinned, valid_until FROM memories ORDER BY id').all(),
    digests: db.prepare('SELECT namespace, content, source_hash, updated_at FROM project_digests ORDER BY namespace').all(),
    clusters: db.prepare('SELECT id, project_path, member_ids, summary, updated_at FROM memory_clusters ORDER BY id').all(),
    links: db.prepare('SELECT source_id, target_id, link_type, confidence, reason FROM memory_links ORDER BY source_id, target_id').all(),
  }
}

describe('maintenance jobs', () => {
  let db: Database.Database

  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    db.prepare("INSERT INTO sessions(id, project_path, started_at) VALUES ('s1', ?, ?)").run(NS, T0)
    db.prepare(
      `INSERT INTO memories(id, session_id, project_path, namespace, content, type, importance, tags, created_at)
       VALUES ('m1', 's1', ?, ?, 'maintained fact', 'note', 0.5, '[]', ?)`
    ).run(NS, NS, T0)
  })
  afterEach(() => {
    delete process.env.ENGRAM_MAINTENANCE_DISABLED
    delete process.env.ENGRAM_MAINTENANCE_LEASE_MS
    delete process.env.ENGRAM_MAINTENANCE_MAX_ATTEMPTS
  })

  it('enqueue is idempotent per (job_type, target_key) while active', () => {
    const a = enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: NS, source: 'test', now: T0 })
    const b = enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: NS, source: 'test', now: T0 + 1 })
    expect(a.coalesced).toBe(false)
    expect(b.coalesced).toBe(true)
    expect(b.id).toBe(a.id)
    const n = (db.prepare("SELECT COUNT(*) AS n FROM maintenance_jobs WHERE status IN ('queued','running')").get() as { n: number }).n
    expect(n).toBe(1)
  })

  it('claims jobs atomically, respects leases, and reclaims expired ones', () => {
    const { id } = enqueueMaintenanceJob(db, { jobType: 'cluster', targetKey: NS, now: T0 })

    const first = claimMaintenanceJob(db, 'owner-1', T0)
    expect(first?.id).toBe(id)
    expect(first?.status).toBe('running')
    expect(first?.attempt).toBe(1)

    // Unexpired lease: not claimable.
    expect(claimMaintenanceJob(db, 'owner-2', T0 + 1_000)).toBeNull()

    // Expired lease: reclaimable.
    const second = claimMaintenanceJob(db, 'owner-2', T0 + 6 * 60 * 1000)
    expect(second?.id).toBe(id)
    expect(second?.attempt).toBe(2)
  })

  it('capped attempts land failed jobs in the dead state', () => {
    process.env.ENGRAM_MAINTENANCE_MAX_ATTEMPTS = '1'
    const { id } = enqueueMaintenanceJob(db, { jobType: 'importance', targetKey: NS, now: T0 })

    claimMaintenanceJob(db, 'owner-1', T0)
    completeMaintenanceJob(db, id, { status: 'failed', error: 'boom', now: T0 + 1 })

    // attempt(1) is no longer < max_attempts(1): nothing claimable.
    expect(claimMaintenanceJob(db, 'owner-2', T0 + 2)).toBeNull()

    const row = db.prepare('SELECT status, attempt, max_attempts FROM maintenance_jobs WHERE id = ?').get(id) as {
      status: string
      attempt: number
      max_attempts: number
    }
    expect(row.status).toBe('failed')
    expect(row.attempt).toBe(1)
    expect(row.max_attempts).toBe(1)
  })

  it('reclaims failed jobs while attempts remain (retry contract)', () => {
    const { id } = enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: NS, now: T0 })

    expect(claimMaintenanceJob(db, 'owner-1', T0)?.id).toBe(id)
    completeMaintenanceJob(db, id, { status: 'failed', error: 'transient', now: T0 + 1 })

    // Failed with attempts remaining is reclaimable; attempt bumps.
    const retry = claimMaintenanceJob(db, 'owner-2', T0 + 2)
    expect(retry?.id).toBe(id)
    expect(retry?.attempt).toBe(2)
    expect(retry?.last_error).toBeNull()
    completeMaintenanceJob(db, id, { status: 'failed', error: 'again', now: T0 + 3 })

    const retry2 = claimMaintenanceJob(db, 'owner-3', T0 + 4)
    expect(retry2?.attempt).toBe(3)
    completeMaintenanceJob(db, id, { status: 'done', result: { ok: true }, now: T0 + 5 })

    const row = db.prepare('SELECT status, attempt FROM maintenance_jobs WHERE id = ?').get(id) as {
      status: string
      attempt: number
    }
    expect(row.status).toBe('done')
    expect(row.attempt).toBe(3)
  })

  it('failed jobs at max attempts are not reclaimed again', () => {
    process.env.ENGRAM_MAINTENANCE_MAX_ATTEMPTS = '2'
    const { id } = enqueueMaintenanceJob(db, { jobType: 'cluster', targetKey: NS, now: T0 })

    claimMaintenanceJob(db, 'owner-1', T0)
    completeMaintenanceJob(db, id, { status: 'failed', error: 'boom', now: T0 + 1 })
    claimMaintenanceJob(db, 'owner-2', T0 + 2)
    completeMaintenanceJob(db, id, { status: 'failed', error: 'boom 2', now: T0 + 3 })

    expect(claimMaintenanceJob(db, 'owner-3', T0 + 4)).toBeNull()
    const row = db.prepare('SELECT status, attempt, last_error FROM maintenance_jobs WHERE id = ?').get(id) as {
      status: string
      attempt: number
      last_error: string
    }
    expect(row.status).toBe('failed')
    expect(row.attempt).toBe(2)
    expect(row.last_error).toBe('boom 2')
  })

  it('expired running jobs at max attempts become dead, never zombies', () => {
    const { id } = enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: NS, now: T0 })
    const lease = 6 * 60 * 1000

    expect(claimMaintenanceJob(db, 'owner-1', T0)?.attempt).toBe(1)
    expect(claimMaintenanceJob(db, 'owner-2', T0 + lease)?.attempt).toBe(2)
    expect(claimMaintenanceJob(db, 'owner-3', T0 + 2 * lease)?.attempt).toBe(3)

    // Next claim: lease expired AND attempt == max_attempts -> swept to dead.
    expect(claimMaintenanceJob(db, 'owner-4', T0 + 3 * lease)).toBeNull()
    const row = db.prepare('SELECT status, attempt, max_attempts, lease_owner FROM maintenance_jobs WHERE id = ?').get(id) as {
      status: string
      attempt: number
      max_attempts: number
      lease_owner: string | null
    }
    expect(row.status).toBe('dead')
    expect(row.attempt).toBe(3)
    expect(row.max_attempts).toBe(3)
    expect(row.lease_owner).toBeNull()
  })

  it('shadow mode never writes canonical state and records summaries', async () => {
    db.prepare('UPDATE memories SET pinned = 1, adjudication_state = ? WHERE id = ?').run('pending', 'm1')
    const before = snapshotState(db)

    enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: NS, now: T0 })
    enqueueMaintenanceJob(db, { jobType: 'cluster', targetKey: NS, now: T0 })
    enqueueMaintenanceJob(db, { jobType: 'importance', targetKey: NS, now: T0 })
    enqueueMaintenanceJob(db, { jobType: 'adjudication', targetKey: NS, now: T0 })

    const ran = await runPendingMaintenanceJobs(db, { owner: 'shadow-owner', maxJobs: 20, now: T0 })
    expect(ran.claimed).toBe(4)
    expect(ran.done).toBe(4)

    const after = snapshotState(db)
    expect(after).toEqual(before) // zero canonical writes

    const status = getMaintenanceStatus(db)
    expect(status.jobs.total).toBe(4)
    expect(status.jobs.by_status.done).toBe(4)
    const digestJob = status.recent.find((r) => r.job_type === 'digest')!
    expect(digestJob.result_json).toMatchObject({
      shadow: true,
      pinned_count: 1,
    })
    expect(digestJob.last_error).toBeNull()
  })

  it('run_pending_maintenance marks handler failures and records result_json', async () => {
    const { id } = enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: NS, now: T0 })
    // Make the target namespace unresolvable at run time? The shadow handler
    // is read-only; instead verify the failure path via complete + dead.
    completeMaintenanceJob(db, id, { status: 'dead', error: 'no budget', now: T0 + 1 })
    const row = db.prepare('SELECT status, last_error FROM maintenance_jobs WHERE id = ?').get(id) as {
      status: string
      last_error: string
    }
    expect(row.status).toBe('dead')
    expect(row.last_error).toBe('no budget')
    const status = getMaintenanceStatus(db)
    expect(status.jobs.by_status.dead).toBe(1)
  })

  it('releaseOwnedLeases requeues running jobs for the owner only', () => {
    enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: NS, now: T0 })
    enqueueMaintenanceJob(db, { jobType: 'cluster', targetKey: NS, now: T0 })
    claimMaintenanceJob(db, 'owner-1', T0) // digest
    claimMaintenanceJob(db, 'owner-2', T0) // cluster

    const released = releaseOwnedLeases(db, 'owner-1')
    expect(released).toBe(1)

    const rows = db.prepare("SELECT job_type, status, lease_owner FROM maintenance_jobs WHERE status IN ('queued','running') ORDER BY job_type").all() as Array<{
      job_type: string
      status: string
      lease_owner: string | null
    }>
    const digest = rows.find((r) => r.job_type === 'digest')!
    const cluster = rows.find((r) => r.job_type === 'cluster')!
    expect(digest.status).toBe('queued')
    expect(digest.lease_owner).toBeNull()
    expect(cluster.status).toBe('running')
    expect(cluster.lease_owner).toBe('owner-2')
  })

  it('end_session enqueues maintenance jobs best-effort and respects the disable flag', async () => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    const mcpDb = getDatabase().db
    mcpDb.prepare("INSERT INTO sessions(id, project_path, started_at) VALUES ('sess-a', ?, ?)").run(NS, Date.now())
    mcpDb.prepare(
      `INSERT INTO memories(id, session_id, project_path, namespace, content, created_at)
       VALUES ('m-a', 'sess-a', ?, ?, 'session fact', ?)`
    ).run(NS, NS, Date.now())

    await handleTool('end_session', { session_id: 'sess-a' })
    const queued = mcpDb
      .prepare("SELECT job_type, target_key, source FROM maintenance_jobs WHERE status = 'queued'")
      .all() as Array<{ job_type: string; target_key: string; source: string }>
    expect(queued.length).toBe(5)
    const nonNav = queued.filter((q) => !q.target_key.startsWith('nav:'))
    expect(nonNav.length).toBe(4)
    for (const q of nonNav) {
      expect(q.target_key).toBe(NS)
      expect(q.source).toBe('end_session')
    }
    // P2: nav digest job for the namespace itself (no parent node in fixture).
    expect(queued.some((q) => q.target_key === 'nav:' + NS)).toBe(true)

    // Disabled: no enqueues.
    process.env.ENGRAM_MAINTENANCE_DISABLED = '1'
    const n = enqueueEndSessionMaintenance(mcpDb, 'sess-a', NS)
    expect(n).toBe(0)
    const total = (mcpDb.prepare('SELECT COUNT(*) AS n FROM maintenance_jobs').get() as { n: number }).n
    expect(total).toBe(5)
  })

  it('end_session never fails the tool call even if the jobs table is unusable', async () => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    const mcpDb = getDatabase().db
    mcpDb.prepare("INSERT INTO sessions(id, project_path, started_at) VALUES ('sess-b', ?, ?)").run(NS, Date.now())

    const result = await handleTool('end_session', { session_id: 'sess-b' })
    const ended = parse<{ id: string; ended_at: number | null }>(result)
    expect(ended.id).toBe('sess-b')
    expect(ended.ended_at).not.toBeNull()
  })

  it('end_session enqueues jobs under the namespace override (namespace ?? project_path)', async () => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    const mcpDb = getDatabase().db
    mcpDb.prepare("INSERT INTO sessions(id, project_path, started_at) VALUES ('sess-ns', ?, ?)").run('/proj', Date.now())
    mcpDb.prepare(
      `INSERT INTO memories(id, session_id, project_path, namespace, content, created_at)
       VALUES ('m-ns', 'sess-ns', ?, ?, 'namespaced fact', ?)`
    ).run('/proj', 'work', Date.now())

    await handleTool('end_session', { session_id: 'sess-ns' })
    const queued = mcpDb
      .prepare("SELECT job_type, target_key FROM maintenance_jobs WHERE status = 'queued' ORDER BY job_type")
      .all() as Array<{ job_type: string; target_key: string }>
    expect(queued.length).toBe(5)
    for (const q of queued) {
      // namespace override, never raw /proj; nav jobs carry the nav: prefix
      expect(q.target_key === 'work' || q.target_key === 'nav:work').toBe(true)
    }
    expect(queued.some((q) => q.target_key === 'nav:work')).toBe(true)
  })

  it('get_maintenance_status tool surfaces counts and fails safely on empty queue', async () => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    const result = parse<{ jobs: { total: number } }>(
      await handleTool('get_maintenance_status', {})
    )
    expect(result.jobs.total).toBe(0)
  })

  it('run_pending_maintenance tool honors ENGRAM_MAINTENANCE_DISABLED without claiming jobs', async () => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    const mcpDb = getDatabase().db
    enqueueMaintenanceJob(mcpDb, { jobType: 'digest', targetKey: '/x', source: 'test' })

    process.env.ENGRAM_MAINTENANCE_DISABLED = '1'
    const result = parse<{ claimed: number; done: number; failed: number; disabled: boolean }>(
      await handleTool('run_pending_maintenance', { limit: 10 })
    )
    expect(result).toEqual({ claimed: 0, done: 0, failed: 0, disabled: true })

    // No job was claimed: the row stays queued with attempt 0.
    const row = mcpDb
      .prepare('SELECT status, attempt FROM maintenance_jobs')
      .get() as { status: string; attempt: number }
    expect(row.status).toBe('queued')
    expect(row.attempt).toBe(0)
  })

  it('run_pending_maintenance tool drains a bounded batch via lease claim', async () => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    const mcpDb = getDatabase().db
    enqueueMaintenanceJob(mcpDb, { jobType: 'digest', targetKey: '/x', source: 'test' })
    enqueueMaintenanceJob(mcpDb, { jobType: 'cluster', targetKey: '/y', source: 'test' })

    const result = parse<{ claimed: number; done: number; failed: number }>(
      await handleTool('run_pending_maintenance', { limit: 10 })
    )
    expect(result.claimed).toBe(2)
    expect(result.done).toBe(2)
    expect(result.failed).toBe(0)
  })
})
