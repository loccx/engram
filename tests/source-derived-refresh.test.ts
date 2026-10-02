import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { ensureNode } from '../src/namespace/tree.js'
import { refreshDigest } from '../src/memory/digest.js'
import { refreshNavDigest } from '../src/memory/nav.js'
import { runClusterWorker } from '../src/memory/cluster-worker.js'
import { promoteScopePatterns, PROMOTE_MIN_MEMORIES } from '../src/maintenance/promote.js'
import { completeMaintenanceJob, enqueueMaintenanceJob } from '../src/maintenance/jobs.js'

// these tests isolate the post-await fence. Source lifecycle tests independently
// verify that real mutations advance the generation and purge dependent caches.
const control = vi.hoisted(() => ({
  generation: 0,
  excluded: [] as string[],
  calls: 0,
  mutate: null as null | (() => void),
  fail: false,
}))
vi.mock('../src/sources/index.js', () => ({
  readSourceGeneration: () => control.generation,
  sourceDerivedMemoryIds: () => control.excluded,
}))
vi.mock('../src/llm/client.js', () => ({
  isLlmConfigured: () => true,
  chat: async () => {
    control.calls++
    control.mutate?.()
    if (control.fail) throw new Error('synthetic completion failure')
    return { content: 'revoked source summary must not return' }
  },
}))
vi.mock('../src/memory/clustering.js', () => ({
  computeClusters: () => [{ memberIds: ['fact'], representativeContent: 'source observation' }],
}))

const NS = '/synthetic/source-refresh'
let db: Database.Database

function memory(id: string, namespace = NS, pinned = true): void {
  db.prepare(`INSERT INTO memories
    (id, session_id, project_path, namespace, content, type, importance, tags, created_at, pinned)
    VALUES (?, 'source-refresh-session', ?, ?, ?, 'note', 0.5, '[]', 100, ?)`)
    .run(id, namespace, namespace, `synthetic source evidence ${id}`.repeat(8), pinned ? 1 : 0)
}

beforeEach(() => {
  db = createTestDb().db
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)')
    .run('source-refresh-session', NS, 100)
  control.generation = 0
  control.excluded = []
  control.calls = 0
  control.mutate = null
  control.fail = false
})
afterEach(() => db.close())

function revoke(): void {
  control.generation++
  db.prepare('DELETE FROM memories').run()
  db.prepare('DELETE FROM project_digests').run()
  db.prepare('DELETE FROM memory_clusters').run()
  db.prepare('UPDATE namespace_nodes SET digest = NULL, digest_source_hash = NULL').run()
}

describe('source freshness across asynchronous derivation', () => {
  it('does not write or return a pre-revocation pinned digest', async () => {
    memory('fact')
    control.mutate = revoke
    const result = await refreshDigest(db, NS, { budgetChars: 8 })
    expect(control.calls).toBe(1)
    expect(result).toEqual({ content: '', changed: false })
    expect(db.prepare('SELECT * FROM project_digests').all()).toEqual([])
  })

  it('does not return the captured old digest when completion fails after revocation', async () => {
    memory('fact')
    db.prepare('INSERT INTO project_digests (namespace, content, source_hash, updated_at) VALUES (?, ?, ?, ?)')
      .run(NS, 'old revoked cache', 'old', 100)
    control.mutate = revoke
    control.fail = true
    const result = await refreshDigest(db, NS, { budgetChars: 8 })
    expect(control.calls).toBe(1)
    expect(result.content).toBe('')
    expect(db.prepare('SELECT * FROM project_digests').all()).toEqual([])
  })

  it('does not republish a revoked navigation digest', async () => {
    ensureNode(db, NS)
    db.prepare('INSERT INTO project_digests (namespace, content, source_hash, updated_at) VALUES (?, ?, ?, ?)')
      .run(NS, 'synthetic source facts'.repeat(20), 'old', 100)
    control.mutate = revoke
    const result = await refreshNavDigest(db, NS, { budgetChars: 8 })
    expect(control.calls).toBe(1)
    expect(result).toEqual({ content: '', changed: false })
    const node = db.prepare('SELECT digest FROM namespace_nodes WHERE path = ?').get(NS) as { digest: string | null }
    expect(node.digest).toBeNull()
  })

  it('does not restore a revoked cluster after completion', async () => {
    memory('fact')
    control.mutate = revoke
    expect(await runClusterWorker(db, NS)).toBe(0)
    expect(control.calls).toBe(1)
    expect(db.prepare('SELECT * FROM memory_clusters').all()).toEqual([])
  })

  it('does not promote source-backed facts into a broader namespace', async () => {
    const leaf = `${NS}//cloud`
    ensureNode(db, leaf)
    for (let i = 0; i < PROMOTE_MIN_MEMORIES; i++) {
      const id = `source-${i}`
      memory(id, leaf, false)
      control.excluded.push(id)
    }
    const result = await promoteScopePatterns(db, NS)
    expect(result.promoted).toEqual([])
    expect(control.calls).toBe(0)
    expect(db.prepare("SELECT id FROM memories WHERE origin = 'promotion'").all()).toEqual([])
  })

  it('does not publish a parent claim when inputs are revoked during distillation', async () => {
    const leaf = `${NS}//cloud`
    ensureNode(db, leaf)
    for (let i = 0; i < PROMOTE_MIN_MEMORIES; i++) memory(`source-${i}`, leaf, false)
    control.mutate = revoke
    const result = await promoteScopePatterns(db, NS)
    expect(control.calls).toBe(1)
    expect(result.promoted).toEqual([])
    expect(result.reasons.cloud).toBe('source_changed')
    expect(db.prepare("SELECT id FROM memories WHERE origin = 'promotion'").all()).toEqual([])
  })

  it('redacts post-await maintenance results and errors from an older source generation', () => {
    const { id } = enqueueMaintenanceJob(db, { jobType: 'digest', targetKey: NS })
    control.generation++
    completeMaintenanceJob(db, id, {
      status: 'failed', sourceGeneration: 0,
      result: { content: 'revoked source output' }, error: 'revoked source error',
    })
    const row = db.prepare('SELECT status, result_json, last_error FROM maintenance_jobs WHERE id = ?').get(id) as { status: string; result_json: string; last_error: string | null }
    expect(row.status).toBe('failed')
    expect(JSON.parse(row.result_json)).toEqual({ redacted: 'source-lifecycle' })
    expect(row.last_error).toBeNull()
  })
})
