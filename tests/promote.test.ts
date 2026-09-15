import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { resetLlmConfigForTests } from '../src/llm/client.js'
import { ensureNode } from '../src/namespace/tree.js'
import { migrations } from '../src/db/migrations/index.js'
import { promoteScopePatterns, PROMOTE_MIN_MEMORIES } from '../src/maintenance/promote.js'
import {
  enqueueMaintenanceJob,
  runPendingMaintenanceJobs,
} from '../src/maintenance/jobs.js'

const PROJECT = '/p'
const SESSION = 'promo-session'

function seedSession(db: Database.Database): void {
  db.prepare(
    `INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)`
  ).run(SESSION, PROJECT, Date.now())
}

function seedMemory(
  db: Database.Database,
  id: string,
  namespace: string,
  content: string,
  importance = 0.5
): void {
  db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
     VALUES (?, ?, ?, ?, ?, 'note', ?, '[]', ?)`
  ).run(id, SESSION, namespace, namespace, content, importance, Date.now())
}

function seedClusterSummary(db: Database.Database, path: string, summary: string): void {
  db.prepare(
    `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
     VALUES (?, '[]', ?, 1, ?, ?)`
  ).run(path, summary, Date.now(), Date.now())
}

function nodeDigest(db: Database.Database, path: string): string | null {
  const row = db
    .prepare('SELECT digest FROM namespace_nodes WHERE path = ?')
    .get(path) as { digest: string | null } | undefined
  return row?.digest ?? null
}

function configureLlm(): void {
  process.env.ENGRAM_LLM_BASE_URL = 'https://gw.test/v1'
  process.env.ENGRAM_LLM_API_KEY = 'test-key'
  process.env.ENGRAM_LLM_MODEL = 'gpt-test'
  resetLlmConfigForTests()
}

function clearLlm(): void {
  delete process.env.ENGRAM_LLM_BASE_URL
  delete process.env.ENGRAM_LLM_API_KEY
  delete process.env.ENGRAM_LLM_MODEL
  resetLlmConfigForTests()
}

function chatResponse(content: string, model = 'gpt-test'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

describe('promotion + recursive consolidation', () => {
  let db: Database.Database

  beforeEach(() => {
    const created = createTestDb()
    db = created.db
    clearLlm()
    seedSession(db)
    ensureNode(db, PROJECT)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearLlm()
  })

  it('promotes scopes at/over the threshold and skips thin scopes with a reason', async () => {
    ensureNode(db, `${PROJECT}//payments`)
    ensureNode(db, `${PROJECT}//other`)
    for (let i = 0; i < PROMOTE_MIN_MEMORIES; i++) {
      seedMemory(db, `p-${i}`, `${PROJECT}//payments`, `payments fact ${i}`)
    }
    for (let i = 0; i < PROMOTE_MIN_MEMORIES - 1; i++) {
      seedMemory(db, `o-${i}`, `${PROJECT}//other`, `other fact ${i}`)
    }

    const report = await promoteScopePatterns(db, PROJECT)

    expect(report.promoted).toEqual(['payments'])
    expect(report.skipped).toContain('other')
    expect(report.reasons['other']).toBe('below_threshold')
  })

  it('dedupes on the second run (no duplicate pattern in the parent)', async () => {
    ensureNode(db, `${PROJECT}//payments`)
    for (let i = 0; i < PROMOTE_MIN_MEMORIES; i++) {
      seedMemory(db, `p-${i}`, `${PROJECT}//payments`, `payments fact ${i}`)
    }

    await promoteScopePatterns(db, PROJECT)
    const first = await promoteScopePatterns(db, PROJECT)

    expect(first.promoted).toEqual([])
    expect(first.skipped).toContain('payments')
    expect(first.reasons['payments']).toBe('already_promoted')

    const patterns = db
      .prepare(
        `SELECT id FROM memories WHERE COALESCE(namespace, project_path) = ? AND type = 'pattern'`
      )
      .all(PROJECT) as Array<{ id: string }>
    expect(patterns).toHaveLength(1)
  })

  it('writes the pattern into the parent, links every source, and refreshes the parent digest', async () => {
    seedClusterSummary(db, PROJECT, 'payments parent topic')
    ensureNode(db, `${PROJECT}//payments`)
    const ids: string[] = []
    for (let i = 0; i < PROMOTE_MIN_MEMORIES; i++) {
      ids.push(`p-${i}`)
      seedMemory(db, `p-${i}`, `${PROJECT}//payments`, `payments fact ${i}`)
    }

    await promoteScopePatterns(db, PROJECT)

    const patterns = db
      .prepare(
        `SELECT id, namespace, type, tags, content FROM memories
         WHERE COALESCE(namespace, project_path) = ? AND type = 'pattern'`
      )
      .all(PROJECT) as Array<{ id: string; namespace: string; type: string; tags: string; content: string }>
    expect(patterns).toHaveLength(1)
    const pattern = patterns[0]
    expect(pattern.namespace).toBe(PROJECT)
    expect(pattern.type).toBe('pattern')
    expect(JSON.parse(pattern.tags)).toContain('payments')
    expect(pattern.content.startsWith('[payments] ')).toBe(true)

    const links = db
      .prepare(
        `SELECT source_id, target_id, link_type FROM memory_links WHERE link_type = 'promoted_from'`
      )
      .all() as Array<{ source_id: string; target_id: string; link_type: string }>
    expect(links).toHaveLength(ids.length)
    for (const link of links) {
      expect(link.source_id).toBe(pattern.id)
      expect(ids).toContain(link.target_id)
    }

    expect(nodeDigest(db, PROJECT)).toContain('payments parent topic')
  })

  it('falls back to extractive content when the LLM is unconfigured and never throws', async () => {
    ensureNode(db, `${PROJECT}//payments`)
    seedMemory(db, 'hi-1', `${PROJECT}//payments`, 'STRIPE-IDEMPOTENCY-KEYS', 0.9)
    seedMemory(db, 'hi-2', `${PROJECT}//payments`, 'retry on 409', 0.8)
    seedMemory(db, 'hi-3', `${PROJECT}//payments`, 'webhook signature verify', 0.7)
    for (let i = 0; i < PROMOTE_MIN_MEMORIES - 3; i++) {
      seedMemory(db, `lo-${i}`, `${PROJECT}//payments`, `filler ${i}`, 0.1)
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const report = await promoteScopePatterns(db, PROJECT)

    expect(report.promoted).toEqual(['payments'])
    expect(fetchSpy).not.toHaveBeenCalled()

    const pattern = db
      .prepare(
        `SELECT content FROM memories WHERE COALESCE(namespace, project_path) = ? AND type = 'pattern'`
      )
      .get(PROJECT) as { content: string }
    expect(pattern.content).toContain('STRIPE-IDEMPOTENCY-KEYS')
  })

  it('consolidates a 3-level tree post-order via the navtree executor', async () => {
    seedClusterSummary(db, PROJECT, 'P topic')
    seedClusterSummary(db, `${PROJECT}/c`, 'C topic')
    seedClusterSummary(db, `${PROJECT}/c/g`, 'G topic')
    ensureNode(db, `${PROJECT}/c/g`)

    enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: `navtree:${PROJECT}`, source: 'test' })
    await runPendingMaintenanceJobs(db, { maxJobs: 10 })

    // Post-order: children before parents, so the parent digest reflects the
    // freshly-computed child digest (only the child's first line folds upward).
    expect(nodeDigest(db, `${PROJECT}/c/g`)).toContain('G topic')
    expect(nodeDigest(db, `${PROJECT}/c`)).toContain('C topic')
    expect(nodeDigest(db, `${PROJECT}/c`)).toContain('G topic')
    expect(nodeDigest(db, PROJECT)).toContain('P topic')
    expect(nodeDigest(db, PROJECT)).toContain('C topic')
  })
})

describe('migration 011: maintenance_jobs promote CHECK rebuild', () => {
  it('preserves existing rows, admits promote jobs, and keeps the unique index', () => {
    const raw = new Database(':memory:')
    const m009 = migrations.find((m) => m.version === 9)!
    const m011 = migrations.find((m) => m.version === 11)!
    m009.up(raw)

    raw
      .prepare(
        `INSERT INTO maintenance_jobs (job_type, target_key, status, enqueued_at, max_attempts)
         VALUES ('digest', '/x', 'queued', 1, 3)`
      )
      .run()

    m011.up(raw)

    const survived = raw
      .prepare('SELECT job_type, target_key, status FROM maintenance_jobs')
      .all() as Array<{ job_type: string; target_key: string; status: string }>
    expect(survived).toHaveLength(1)
    expect(survived[0]).toMatchObject({ job_type: 'digest', target_key: '/x', status: 'queued' })

    // promote is now a legal job_type.
    raw
      .prepare(
        `INSERT INTO maintenance_jobs (job_type, target_key, status, enqueued_at, max_attempts)
         VALUES ('promote', 'promote:/x', 'queued', 2, 3)`
      )
      .run()

    // The active partial-unique index survived the rebuild: a duplicate active
    // (job_type, target_key) row must be rejected.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO maintenance_jobs (job_type, target_key, status, enqueued_at, max_attempts)
           VALUES ('digest', '/x', 'queued', 3, 3)`
        )
        .run()
    ).toThrow(/UNIQUE/)

    raw.close()
  })

  it('is idempotent (skips when the CHECK already contains promote)', () => {
    const raw = new Database(':memory:')
    const m009 = migrations.find((m) => m.version === 9)!
    const m011 = migrations.find((m) => m.version === 11)!
    m009.up(raw)
    m011.up(raw)
    const before = raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_jobs'")
      .get() as { sql: string }
    m011.up(raw)
    const after = raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_jobs'")
      .get() as { sql: string }
    expect(after.sql).toBe(before.sql)
    raw.close()
  })
})
