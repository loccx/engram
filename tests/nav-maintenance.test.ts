import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import {
  enqueueMaintenanceJob,
  runPendingMaintenanceJobs,
  enqueueEndSessionMaintenance,
} from '../src/maintenance/jobs.js'
import { ensureNode, getNode } from '../src/namespace/tree.js'

const NS = '/home/user/nav-project'
const T0 = 1_700_000_000_000

function navDigestRows(db: Database.Database): Array<{ target_key: string; status: string; source: string | null }> {
  return db
    .prepare(
      `SELECT target_key, status, source FROM maintenance_jobs
       WHERE job_type = 'digest' AND target_key LIKE 'nav:%'
       ORDER BY id`
    )
    .all() as Array<{ target_key: string; status: string; source: string | null }>
}

describe('nav digest maintenance', () => {
  let db: Database.Database

  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
  })
  afterEach(() => {
    delete process.env.ENGRAM_MAINTENANCE_DISABLED
  })

  it('end_session enqueues nav digest jobs for the namespace and its nearest existing ancestor', () => {
    ensureNode(db, NS) // creates /, /home, /home/user, NS

    enqueueEndSessionMaintenance(db, 's-nav', NS, T0)

    const nav = navDigestRows(db)
    const targets = nav.map((r) => r.target_key)
    expect(targets).toContain(`nav:${NS}`)
    expect(targets).toContain('nav:/home/user') // nearest existing ancestor
    for (const r of nav) {
      expect(r.status).toBe('queued')
      expect(r.source).toBe('end_session')
    }

    // Idempotent: a second call coalesces against active rows, no duplicates.
    enqueueEndSessionMaintenance(db, 's-nav', NS, T0 + 1)
    expect(navDigestRows(db).length).toBe(nav.length)
  })

  it('a claimed nav job refreshes namespace_nodes.digest from fixture data without LLM', async () => {
    ensureNode(db, NS)
    // Pre-consolidated pinned-fact digest: nav reads project_digests for the
    // node's pinned facts, plus topic clusters and child digests.
    db.prepare(
      'INSERT INTO project_digests(namespace, content, source_hash, updated_at) VALUES (?, ?, ?, ?)'
    ).run(NS, 'Pinned: auth uses PBKDF2 rounds=600k', 'h1', T0)
    db.prepare(
      `INSERT INTO memory_clusters(project_path, member_ids, summary, is_extractive, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`
    ).run(NS, '["m-nav"]', 'cluster: login token rotation', T0, T0)

    enqueueEndSessionMaintenance(db, 's-nav', NS, T0)
    const ran = await runPendingMaintenanceJobs(db, { owner: 'nav-owner', maxJobs: 20, now: T0 })
    expect(ran.done).toBeGreaterThanOrEqual(1)

    const node = getNode(db, NS)
    expect(node?.digest).toBeTruthy()
    expect(node?.digest).toContain('PBKDF2')
    expect(node?.digest).toContain('login token rotation')
  })

  it('nav job for a missing node completes as a no-op without creating the node', async () => {
    enqueueMaintenanceJob(db, {
      jobType: 'digest',
      targetKey: 'nav:/no/such/node',
      source: 'test',
      now: T0,
    })

    const ran = await runPendingMaintenanceJobs(db, { owner: 'nav-owner', maxJobs: 10, now: T0 })
    expect(ran.done).toBe(1)
    expect(ran.failed).toBe(0)

    const row = db
      .prepare(
        "SELECT status, result_json FROM maintenance_jobs WHERE job_type='digest' AND target_key='nav:/no/such/node'"
      )
      .get() as { status: string; result_json: string }
    expect(row.status).toBe('done')
    const result = JSON.parse(row.result_json)
    expect(result.nav_digest).toBe(true)
    expect(result.digest_chars).toBe(0)
    expect(result.changed).toBe(false)
    expect(getNode(db, '/no/such/node')).toBeNull() // no implicit node creation
  })

  it('canonical digest jobs stay shadow-only and do not write the nav layer', async () => {
    ensureNode(db, NS)
    db.prepare("INSERT INTO sessions(id, project_path, started_at) VALUES ('s-nav', ?, ?)").run(NS, T0)
    db.prepare(
      `INSERT INTO memories(id, session_id, project_path, namespace, content, type, importance, tags, created_at, pinned)
       VALUES ('m-pin', 's-nav', ?, ?, 'pinned canonical fact', 'note', 0.5, '[]', ?, 1)`
    ).run(NS, NS, T0)

    enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: NS, source: 'test', now: T0 })
    const ran = await runPendingMaintenanceJobs(db, { owner: 'nav-owner', maxJobs: 10, now: T0 })
    expect(ran.done).toBe(1)

    const row = db
      .prepare("SELECT result_json FROM maintenance_jobs WHERE job_type='digest' AND target_key=?")
      .get(NS) as { result_json: string }
    const result = JSON.parse(row.result_json)
    expect(result.shadow).toBe(true)
    expect(result.pinned_count).toBe(1)
    // A canonical digest job must not touch the nav layer.
    expect(getNode(db, NS)?.digest).toBeNull()
  })
})
