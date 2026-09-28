import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import {
  planDuplicatePrune,
  applyDuplicatePrune,
  runDuplicatePrune,
  prefixSimilarity,
  PRUNE_DEFAULT_SIMILARITY,
} from '../src/maintenance/prune.js'
import {
  enqueueMaintenanceJob,
  enqueueEndSessionMaintenance,
  getMaintenanceStatus,
  runPendingMaintenanceJobs,
} from '../src/maintenance/jobs.js'
import {
  armEagerDrain,
  isEagerDrainArmed,
  maintenanceIntervalMs,
  startMaintenanceScheduler,
  DEFAULT_MAINTENANCE_INTERVAL_MS,
} from '../src/maintenance/scheduler.js'
import { runPruneCli } from '../src/cli/lifecycle.js'
import { MemoryStore } from '../src/memory/store.js'

const NS = '/prune-proj'
const T0 = 1_700_000_000_000


function seed(db: Database.Database, rows: Array<{ id: string; content: string; importance?: number }>): void {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    'sess-1',
    NS,
    T0
  )
  const insert = db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
     VALUES (?, 'sess-1', ?, ?, ?, 'pattern', ?, '[]', ?)`
  )
  let i = 0
  for (const row of rows) {
    insert.run(row.id, NS, NS, row.content, row.importance ?? 0.06, T0 + i)
    i++
  }
}

const NEGATIVE = 'None of these findings name a specific recurring manual task in the reconciliation service'

describe('duplicate prune', () => {
  it('groups near-identical text and keeps the highest-utility member', () => {
    const { db } = createTestDb()
    seed(db, [
      { id: 'keep', content: `${NEGATIVE} — run 1`, importance: 0.5 },
      { id: 'dup-a', content: `${NEGATIVE} — run 2` },
      { id: 'dup-b', content: `${NEGATIVE} — run 3` },
      { id: 'unique', content: 'A completely different finding about the ledger export job' },
    ])

    const plan = planDuplicatePrune(db)
    expect(plan.scanned).toBe(4)
    expect(plan.redundant_rows).toBe(2)
    const redundant = plan.groups.flatMap((g) => g.redundant_ids).sort()
    expect(redundant).toEqual(['dup-a', 'dup-b'])
    expect(plan.groups.every((g) => g.keeper_id === 'keep')).toBe(true)
    expect(plan.groups[0].similarity).toBeGreaterThanOrEqual(PRUNE_DEFAULT_SIMILARITY)
  })

  it('plans without mutating anything (dry run is the default)', () => {
    const { db } = createTestDb()
    seed(db, [
      { id: 'keep', content: `${NEGATIVE} — run 1`, importance: 0.5 },
      { id: 'dup-a', content: `${NEGATIVE} — run 2` },
    ])
    const plan = planDuplicatePrune(db)
    expect(plan.redundant_rows).toBe(1)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived_at IS NOT NULL').get() as {
        n: number
      }).n
    ).toBe(0)
  })

  it('applies: archives redundant rows, keeps the keeper, repoints links', () => {
    const { db } = createTestDb()
    seed(db, [
      { id: 'keep', content: `${NEGATIVE} — run 1`, importance: 0.5 },
      { id: 'dup-a', content: `${NEGATIVE} — run 2` },
      { id: 'other', content: 'A link target that must survive the prune' },
    ])
    // the redundant row's link is repointed at the keeper, not deleted
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at)
       VALUES ('dup-a', 'other', 0.7, 'semantic', ?)`
    ).run(T0)

    const report = runDuplicatePrune(db)
    expect(report.archived).toBe(1)
    expect(report.links_repointed).toBeGreaterThanOrEqual(1)

    const archived = db
      .prepare('SELECT archived_at FROM memories WHERE id = ?')
      .get('dup-a') as { archived_at: number | null }
    expect(archived.archived_at).not.toBeNull()
    const keeper = db
      .prepare('SELECT archived_at FROM memories WHERE id = ?')
      .get('keep') as { archived_at: number | null }
    expect(keeper.archived_at).toBeNull()

    const repointed = db
      .prepare(`SELECT * FROM memory_links WHERE source_id = 'keep' AND target_id = 'other'`)
      .get()
    expect(repointed).toBeDefined()
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM memory_links WHERE source_id = 'dup-a' OR target_id = 'dup-a'")
          .get() as { n: number }
      ).n
    ).toBe(0)
  })

  it('is idempotent: a second run has nothing left to do', () => {
    const { db } = createTestDb()
    seed(db, [
      { id: 'keep', content: `${NEGATIVE} — run 1`, importance: 0.5 },
      { id: 'dup-a', content: `${NEGATIVE} — run 2` },
    ])
    expect(runDuplicatePrune(db).archived).toBe(1)
    const second = runDuplicatePrune(db)
    expect(second.archived).toBe(0)
    expect(second.redundant_rows).toBe(0)
  })

  it('archived duplicates disappear from default reads', () => {
    const { db } = createTestDb()
    seed(db, [
      { id: 'keep', content: `${NEGATIVE} — run 1`, importance: 0.5 },
      { id: 'dup-a', content: `${NEGATIVE} — run 2` },
    ])
    const store = new MemoryStore(db, false)
    expect(store.list({ project_path: NS, limit: 10 }).length).toBe(2)
    runDuplicatePrune(db)
    const visible = store.list({ project_path: NS, limit: 10 })
    expect(visible.map((m) => m.id)).toEqual(['keep'])
    expect(store.list({ project_path: NS, limit: 10, include_archived: true }).length).toBe(2)
  })

  it('never groups across namespaces or types', () => {
    const { db } = createTestDb()
    seed(db, [{ id: 'a', content: `${NEGATIVE} — run 1` }])
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
       VALUES ('b', 'sess-1', '/elsewhere', '/elsewhere', ?, 'pattern', 0.06, '[]', ?)`
    ).run(`${NEGATIVE} — run 2`, T0 + 10)

    const plan = planDuplicatePrune(db)
    expect(plan.redundant_rows).toBe(0)
  })

  it('gate-scope: namespace and threshold options are honoured', () => {
    const { db } = createTestDb()
    seed(db, [
      { id: 'keep', content: `${NEGATIVE} — run 1`, importance: 0.5 },
      { id: 'dup-a', content: `${NEGATIVE} — run 2` },
    ])
    expect(planDuplicatePrune(db, { namespace: '/nothing-here' }).redundant_rows).toBe(0)
    expect(planDuplicatePrune(db, { namespace: NS }).redundant_rows).toBe(1)
    // threshold 1 means fully identical text, which these rows are not
    expect(planDuplicatePrune(db, { threshold: 1 }).redundant_rows).toBe(0)
  })

  it('prefixSimilarity measures the shared share of the longer text', () => {
    expect(prefixSimilarity('abcdef', 'abcdef')).toBe(1)
    expect(prefixSimilarity('abcdef', 'abc')).toBe(0.5)
    expect(prefixSimilarity('abc', 'xyz')).toBe(0)
  })
})

describe('prune CLI', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'engram-prune-cli-'))
    dbPath = join(dir, 'engram.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('dry run reports groups and archives nothing', async () => {
    // built through the real DatabaseManager so the CLI opens the shipped schema
    const { DatabaseManager } = await import('../src/db/init.js')
    const manager = new DatabaseManager(dbPath)
    seed(manager.db, [
      { id: 'keep', content: `${NEGATIVE} — run 1`, importance: 0.5 },
      { id: 'dup-a', content: `${NEGATIVE} — run 2` },
      { id: 'dup-b', content: `${NEGATIVE} — run 3` },
    ])
    manager.close()

    const { DatabaseManager: DM2 } = await import('../src/db/init.js')
    const reopened = new DM2(dbPath)
    const result = await runPruneCli(reopened.db, { apply: false })
    expect(result.applied).toBe(false)
    expect(result.report?.redundant_rows).toBe(2)
    expect(result.report?.archived).toBe(0)
    expect(
      (reopened.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived_at IS NOT NULL').get() as {
        n: number
      }).n
    ).toBe(0)
    reopened.close()
  })

  it('--apply archives through the durable job queue', async () => {
    const { DatabaseManager } = await import('../src/db/init.js')
    const manager = new DatabaseManager(dbPath)
    seed(manager.db, [
      { id: 'keep', content: `${NEGATIVE} — run 1`, importance: 0.5 },
      { id: 'dup-a', content: `${NEGATIVE} — run 2` },
    ])

    const result = await runPruneCli(manager.db, { apply: true, namespace: NS })
    expect(result.applied).toBe(true)
    expect(result.enqueued_job_id).not.toBeNull()
    expect(result.report?.archived).toBe(1)

    const job = manager.db
      .prepare('SELECT job_type, status FROM maintenance_jobs WHERE id = ?')
      .get(result.enqueued_job_id!) as { job_type: string; status: string }
    expect(job.job_type).toBe('prune')
    expect(job.status).toBe('done')
    manager.close()
  })

  it('the real CLI binary prints a dry-run report (no writes) and exits 0', async () => {
    const { DatabaseManager } = await import('../src/db/init.js')
    const manager = new DatabaseManager(dbPath)
    seed(manager.db, [
      { id: 'keep', content: `${NEGATIVE} — run 1`, importance: 0.5 },
      { id: 'dup-a', content: `${NEGATIVE} — run 2` },
    ])
    manager.close()

    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx')
    if (!existsSync(tsx)) {
      // a machine without tsx should fail loudly, not pass
      throw new Error(`tsx not found at ${tsx}`)
    }
    const stdout = execFileSync(
      tsx,
      ['src/index.ts', 'prune-duplicates', '--db', dbPath, '--json'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ENGRAM_MAINTENANCE_DISABLED: '0' } }
    )
    const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
      applied: boolean
      report: { redundant_rows: number; archived: number }
    }
    expect(parsed.applied).toBe(false)
    expect(parsed.report.redundant_rows).toBe(1)
    expect(parsed.report.archived).toBe(0)
  }, 120_000)
})

describe('maintenance scheduler', () => {
  let db: Database.Database

  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    seed(db, [{ id: 'm1', content: 'a fact for digest jobs' }])
  })

  afterEach(() => {
    armEagerDrain(false)
  })

  it('interval contract: default 60000ms, env override, 0 disables', () => {
    expect(maintenanceIntervalMs({})).toBe(DEFAULT_MAINTENANCE_INTERVAL_MS)
    expect(maintenanceIntervalMs({ ENGRAM_MAINTENANCE_INTERVAL_MS: '5000' })).toBe(5000)
    expect(maintenanceIntervalMs({ ENGRAM_MAINTENANCE_INTERVAL_MS: '0' })).toBe(0)
    expect(maintenanceIntervalMs({ ENGRAM_MAINTENANCE_INTERVAL_MS: 'nonsense' })).toBe(
      DEFAULT_MAINTENANCE_INTERVAL_MS
    )
    const disabled = startMaintenanceScheduler(db, { intervalMs: 0 })
    expect(disabled.started).toBe(false)
    disabled.stop()
  })

  it('executes a queued job without a restart', async () => {
    enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: NS, source: 'test', now: T0 })
    const scheduler = startMaintenanceScheduler(db, { intervalMs: 5 })
    try {
      const deadline = Date.now() + 15000
      let status = 'queued'
      while (Date.now() < deadline) {
        const row = db
          .prepare("SELECT status FROM maintenance_jobs WHERE job_type = 'digest' AND target_key = ?")
          .get(NS) as { status: string } | undefined
        status = row?.status ?? 'missing'
        if (status === 'done') break
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(status).toBe('done')
      expect(scheduler.ticks()).toBeGreaterThan(0)
    } finally {
      scheduler.stop()
    }
  })

  it('drains eagerly after an end_session enqueue once armed', async () => {
    expect(isEagerDrainArmed()).toBe(false)
    armEagerDrain(true)
    db.prepare("INSERT INTO sessions (id, project_path, started_at) VALUES ('s-eager', ?, ?)").run(NS, T0)
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
       VALUES ('m-eager', 's-eager', ?, ?, 'eager drain fact', 'note', 0.5, '[]', ?)`
    ).run(NS, NS, T0)

    const enqueued = enqueueEndSessionMaintenance(db, 's-eager', NS, T0)
    expect(enqueued).toBeGreaterThan(0)

    const deadline = Date.now() + 15000
    let done = 0
    while (Date.now() < deadline) {
      done = (
        db.prepare("SELECT COUNT(*) AS n FROM maintenance_jobs WHERE status = 'done'").get() as {
          n: number
        }
      ).n
      if (done > 0) break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(done).toBeGreaterThan(0)
  })

  it('stays deterministic when it is not armed (enqueue only)', async () => {
    db.prepare("INSERT INTO sessions (id, project_path, started_at) VALUES ('s-quiet', ?, ?)").run(NS, T0)
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
       VALUES ('m-quiet', 's-quiet', ?, ?, 'quiet fact', 'note', 0.5, '[]', ?)`
    ).run(NS, NS, T0)
    enqueueEndSessionMaintenance(db, 's-quiet', NS, T0)
    await new Promise((r) => setTimeout(r, 50))
    const queued = (
      db.prepare("SELECT COUNT(*) AS n FROM maintenance_jobs WHERE status = 'queued'").get() as {
        n: number
      }
    ).n
    expect(queued).toBeGreaterThan(0)
  })
})

describe('lifecycle job types', () => {
  it('accepts prune and retention job types end to end', async () => {
    const { db } = createTestDb()
    db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
      'sess-1',
      NS,
      T0
    )
    const insert = db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
       VALUES (?, 'sess-1', ?, ?, ?, 'note', 0.02, '[]', ?)`
    )
    for (let i = 0; i < 600; i++) {
      insert.run(`bulk-${i}`, NS, NS, `cold unique bulk row number ${i} for retention scoring`, T0 + i)
    }
    seed(db, [
      { id: 'keep', content: `${NEGATIVE} — run 1`, importance: 0.5 },
      { id: 'dup-a', content: `${NEGATIVE} — run 2` },
    ])

    const prune = enqueueMaintenanceJob(db, { jobType: 'prune', targetKey: `prune:${NS}`, now: T0 })
    const retention = enqueueMaintenanceJob(db, { jobType: 'retention', targetKey: 'retention:global', now: T0 })
    const ran = await runPendingMaintenanceJobs(db, { maxJobs: 10, now: T0 })
    expect(ran.claimed).toBe(2)

    const status = getMaintenanceStatus(db)
    expect(status.jobs.by_type.prune).toBe(1)
    expect(status.jobs.by_type.retention).toBe(1)
    const pruneRow = status.recent.find((r) => r.id === prune.id)!
    const retentionRow = status.recent.find((r) => r.id === retention.id)!
    expect(pruneRow.status).toBe('done')
    expect(retentionRow.status).toBe('done')
    expect((pruneRow.result_json as { archived: number }).archived).toBe(1)
  })
})

describe('migration 013 (lifecycle schema)', () => {
  it('is idempotent, leaves a contiguous user_version, and applies every lifecycle shape', async () => {
    const { db } = createTestDb()
    const { migration013 } = await import('../src/db/migrations/013_lifecycle_archive_tier.js')
    const { migrations } = await import('../src/db/migrations/index.js')

    const versions = migrations.map((m) => m.version).sort((a, b) => a - b)
    expect(versions).toEqual(versions.map((_, i) => i + 1))
    const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(userVersion).toBe(versions[versions.length - 1])

    const schemaBefore = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('memories','memory_links','maintenance_jobs')")
      .all()
    migration013.up(db)
    migration013.up(db)
    const schemaAfter = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('memories','memory_links','maintenance_jobs')")
      .all()
    expect(schemaAfter).toEqual(schemaBefore)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(userVersion)

    const columns = db.prepare("PRAGMA table_info('memories')").all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('archived_at')

    // per-link-type identity: two types can coexist for one pair
    db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run('s', NS, T0)
    seed(db, [
      { id: 'a', content: 'first side' },
      { id: 'b', content: 'second side' },
    ])
    const link = db.prepare(
      `INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at)
       VALUES (?, ?, 0.9, ?, ?)`
    )
    link.run('a', 'b', 'semantic', T0)
    link.run('a', 'b', 'supersedes', T0)
    link.run('a', 'b', 'duplicate_of', T0)
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM memory_links WHERE source_id = ? AND target_id = ?')
          .get('a', 'b') as { n: number }
      ).n
    ).toBe(3)

    // the job types the migration added
    enqueueMaintenanceJob(db, { jobType: 'prune', targetKey: `prune:${NS}`, now: T0 })
    enqueueMaintenanceJob(db, { jobType: 'retention', targetKey: 'retention:global', now: T0 })
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM maintenance_jobs WHERE job_type IN ('prune','retention')")
          .get() as { n: number }
      ).n
    ).toBe(2)
  })
})

describe('applyDuplicatePrune guard rails', () => {
  it('never archives the keeper even when the plan names it twice', () => {
    const { db } = createTestDb()
    seed(db, [{ id: 'keep', content: `${NEGATIVE} — run 1`, importance: 0.5 }])
    const applied = applyDuplicatePrune(db, {
      namespace: NS,
      threshold: 0.95,
      prefix_chars: 48,
      scanned: 1,
      truncated: false,
      redundant_rows: 1,
      keepers: 0,
      groups: [
        {
          key: 'k',
          namespace: NS,
          type: 'pattern',
          keeper_id: 'keep',
          redundant_ids: ['keep'],
          member_ids: ['keep'],
          similarity: 1,
        },
      ],
    })
    expect(applied.archived).toBe(0)
    expect(
      (db.prepare('SELECT archived_at FROM memories WHERE id = ?').get('keep') as {
        archived_at: number | null
      }).archived_at
    ).toBeNull()
  })
})
