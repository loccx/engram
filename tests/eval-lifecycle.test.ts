import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import {
  MemoryStore,
  setStoreEmbedder,
  resolveWriteGateMode,
} from '../src/memory/store.js'
import { EMBEDDING_DIM } from '../src/embeddings/pipeline.js'
import { planDuplicatePrune, runDuplicatePrune } from '../src/maintenance/prune.js'
import { planRetention, applyRetention } from '../src/maintenance/retention.js'
import type { Memory } from '../src/memory/types.js'

// prints a machine-readable LIFECYCLE_EVAL line:
//   npx vitest run tests/eval-lifecycle.test.ts 2>&1 | grep LIFECYCLE_EVAL

const NS = '/eval/lifecycle'
const T0 = 1_700_000_000_000

const NEGATIVE_PREFIX =
  'None of these findings name a specific recurring manual task in the reconciliation service and no durable rule follows from them'

const GROUPS = 240
const MEMBERS_PER_GROUP = 5 // 1,200 near-identical rows
const EXACT_DUPLICATES = 100
const CONTROLS = 200

function fakeEmbedder(text: string): Promise<Float32Array> {
  const v = new Float32Array(EMBEDDING_DIM)
  for (const token of text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)) {
    let h = 2166136261
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    v[Math.abs(h) % EMBEDDING_DIM] += 1
  }
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return Promise.resolve(v)
}

interface CorpusStats {
  rows: number
  near_identical: number
  exact_duplicates: number
  controls: number
}

function seedCorpus(db: Database.Database): CorpusStats {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    'eval-session',
    NS,
    T0
  )
  const insert = db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at)
     VALUES (?, 'eval-session', ?, ?, ?, 'pattern', 0.06, '[]', ?)`
  )
  const many = db.transaction((rows: Array<{ id: string; content: string; at: number }>) => {
    for (const row of rows) insert.run(row.id, NS, NS, row.content, row.at)
  })

  const rows: Array<{ id: string; content: string; at: number }> = []
  let at = T0
  for (let g = 0; g < GROUPS; g++) {
    for (let m = 0; m < MEMBERS_PER_GROUP; m++) {
      rows.push({
        id: `near-${g}-${m}`,
        content: `${NEGATIVE_PREFIX} (reconciliation sweep ${g}, pass ${m})`,
        at: at++,
      })
    }
  }
  const exactBase = 'the reconciliation sweep must be re-run after the ledger import completes'
  for (let d = 0; d < EXACT_DUPLICATES; d++) {
    rows.push({ id: `exact-${d}`, content: exactBase, at: at++ })
  }
  for (let c = 0; c < CONTROLS; c++) {
    rows.push({
      id: `control-${c}`,
      content: `unique control finding ${c}: the ledger export job retries with jitter on transient failures`,
      at: at++,
    })
  }
  many(rows)

  return {
    rows: rows.length,
    near_identical: GROUPS * MEMBERS_PER_GROUP,
    exact_duplicates: EXACT_DUPLICATES,
    controls: CONTROLS,
  }
}

function visibleCount(db: Database.Database): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE archived_at IS NULL')
      .get() as { n: number }
  ).n
}

describe('lifecycle eval: duplicate prune on a seeded burst corpus', () => {
  it('removes the redundant burst and keeps every distinct memory', () => {
    const { db } = createTestDb()
    const stats = seedCorpus(db)

    const before = planDuplicatePrune(db)
    const exactBefore = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memories
           WHERE archived_at IS NULL
             AND content IN (SELECT content FROM memories GROUP BY content HAVING COUNT(*) > 1)`
        )
        .get() as { n: number }
    ).n
    // only a minority of a burst is byte-identical, which is why the plan is
    // prefix-based
    expect(before.redundant_rows).toBeGreaterThanOrEqual(stats.near_identical - GROUPS)
    expect(before.keepers).toBeGreaterThanOrEqual(GROUPS)

    const report = runDuplicatePrune(db)
    const after = planDuplicatePrune(db)
    const survivingNear = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memories
           WHERE archived_at IS NULL AND content LIKE ?`
        )
        .get(`${NEGATIVE_PREFIX}%`) as { n: number }
    ).n
    const survivingControls = (
      db
        .prepare("SELECT COUNT(*) AS n FROM memories WHERE archived_at IS NULL AND id LIKE 'control-%'")
        .get() as { n: number }
    ).n
    const survivingExact = (
      db
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE archived_at IS NULL AND id LIKE ?')
        .get('exact-%') as { n: number }
    ).n

    expect(survivingNear).toBe(GROUPS)
    expect(survivingControls).toBe(CONTROLS)
    expect(survivingExact).toBe(1)
    expect(after.redundant_rows).toBe(0)
    expect(visibleCount(db)).toBe(GROUPS + CONTROLS + 1)

    const summary = {
      suite: 'lifecycle',
      corpus: stats,
      prune: {
        scanned: before.scanned,
        duplicate_groups_before: before.group_count,
        redundant_rows_before: before.redundant_rows,
        exact_duplicate_rows_before: exactBefore,
        archived: report.archived,
        keepers: before.keepers,
        duplicate_groups_after: after.group_count,
        redundant_rows_after: after.redundant_rows,
        visible_after: visibleCount(db),
        links_repointed: report.links_repointed,
        links_removed: report.links_removed,
        duration_ms: report.duration_ms,
      },
    }
    console.log('LIFECYCLE_EVAL ' + JSON.stringify(summary))
  }, 60_000)
})

describe('lifecycle eval: retention on the same corpus', () => {
  it('archives only redundant/cold rows and never a guarded one', () => {
    const { db } = createTestDb()
    seedCorpus(db)
    const old = T0 - 200 * 24 * 60 * 60 * 1000
    // pinned and cold by age: retention must leave it alone
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, pinned, last_accessed)
       VALUES ('pinned-keeper', 'eval-session', ?, ?, 'a pinned durable rule', 'pattern', 1.0, '[]', ?, 1, ?)`
    ).run(NS, NS, old, old)

    const plan = planRetention(db, { now: Date.now(), minCorpusSize: 500, minAgeDays: 0, maxArchive: 10000 })
    expect(plan.corpus_size).toBeGreaterThan(500)
    expect(plan.archive_ids).not.toContain('pinned-keeper')
    // controls are unique, so no score may retire one, however cold
    expect(plan.archive_ids.filter((id) => id.startsWith('control-'))).toEqual([])
    expect(plan.skipped.non_redundant).toBe(CONTROLS + GROUPS + 1)
    expect(plan.archive_ids).not.toContain('near-0-0')
    expect(plan.archive_ids).not.toContain('exact-0')
    const applied = applyRetention(db, plan, Date.now())
    expect(applied.archived).toBe(plan.archive_ids.length)
    expect(
      (
        db
          .prepare('SELECT archived_at FROM memories WHERE id = ?')
          .get('pinned-keeper') as { archived_at: number | null }
      ).archived_at
    ).toBeNull()

    console.log(
      'LIFECYCLE_EVAL ' +
        JSON.stringify({
          suite: 'lifecycle',
          retention: {
            corpus: plan.corpus_size,
            eligible: plan.eligible,
            archived: applied.archived,
            threshold: plan.threshold,
            skipped: plan.skipped,
          },
        })
    )
  }, 60_000)
})

describe('lifecycle eval: write-gate latency and store shape', () => {
  const originalMode = process.env.ENGRAM_WRITE_GATE

  afterEach(() => {
    setStoreEmbedder(null)
    if (originalMode === undefined) delete process.env.ENGRAM_WRITE_GATE
    else process.env.ENGRAM_WRITE_GATE = originalMode
  })

  interface Latency {
    mode: string
    distinct_stores: { n: number; mean_ms: number; median_ms: number; p95_ms: number }
    repeat_stores: { n: number; mean_ms: number; median_ms: number; p95_ms: number }
    rows_after: number
  }

  async function measure(db: Database.Database, mode: 'off' | 'merge'): Promise<Latency> {
    process.env.ENGRAM_WRITE_GATE = mode
    expect(resolveWriteGateMode()).toBe(mode)
    setStoreEmbedder(fakeEmbedder)
    const store = new MemoryStore(db, true)
    const distinct: number[] = []
    const repeats: number[] = []

    const distinctCount = 200
    for (let i = 0; i < distinctCount; i++) {
      const t0 = performance.now()
      await store.store({
        content: `distinct latency probe number ${i} about the reconciliation sweep`,
        session_id: 'lat-session',
        project_path: `${NS}/latency`,
        type: 'pattern',
        importance: 0.06,
      })
      distinct.push(performance.now() - t0)
    }

    const repeatContent = `${NEGATIVE_PREFIX} (latency repeat)`
    const repeatCount = 200
    for (let i = 0; i < repeatCount; i++) {
      const t0 = performance.now()
      await store.store({
        content: repeatContent,
        session_id: 'lat-session',
        project_path: `${NS}/latency`,
        type: 'pattern',
        importance: 0.06,
      })
      repeats.push(performance.now() - t0)
    }

    const stat = (samples: number[]): { n: number; mean_ms: number; median_ms: number; p95_ms: number } => {
      const sorted = [...samples].sort((a, b) => a - b)
      return {
        n: samples.length,
        mean_ms: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(3)),
        median_ms: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
        p95_ms: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(3)),
      }
    }

    return {
      mode,
      distinct_stores: stat(distinct),
      repeat_stores: stat(repeats),
      rows_after: (
        db.prepare('SELECT COUNT(*) AS n FROM memories WHERE project_path = ?').get(`${NS}/latency`) as {
          n: number
        }
      ).n,
    }
  }

  it('measures the marginal cost of the gate and its effect on row count', async () => {
    const { db: offDb } = createTestDb()
    const { db: mergeDb } = createTestDb()
    for (const db of [offDb, mergeDb]) {
      db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
        'lat-session',
        `${NS}/latency`,
        T0
      )
    }
    const off = await measure(offDb, 'off')
    const merge = await measure(mergeDb, 'merge')

    expect(off.rows_after).toBe(400)
    expect(merge.rows_after).toBe(201)
    // the gate adds one exact-content lookup on the hot path and skips the
    // insert, vector write and auto-link on a duplicate
    expect(merge.distinct_stores.median_ms).toBeLessThan(off.distinct_stores.median_ms * 3 + 5)
    expect(merge.repeat_stores.median_ms).toBeLessThanOrEqual(off.repeat_stores.median_ms * 1.5 + 1)

    console.log(
      'LIFECYCLE_EVAL ' +
        JSON.stringify({
          suite: 'lifecycle',
          write_gate_latency: { off, merge },
        })
    )
  }, 120_000)
})

describe('lifecycle eval: write gate on a burst', () => {
  const originalMode = process.env.ENGRAM_WRITE_GATE

  afterEach(() => {
    setStoreEmbedder(null)
    if (originalMode === undefined) delete process.env.ENGRAM_WRITE_GATE
    else process.env.ENGRAM_WRITE_GATE = originalMode
  })

  it('a 200-store burst of one repeated finding yields 1 row in merge mode', async () => {
    process.env.ENGRAM_WRITE_GATE = 'merge'
    setStoreEmbedder(fakeEmbedder)
    const { db } = createTestDb()
    const store = new MemoryStore(db, true)
    db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
      'burst-session',
      `${NS}/burst`,
      T0
    )
    const content = `${NEGATIVE_PREFIX} (burst)`
    const results: Array<Memory & { deduplicated?: boolean }> = []
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) {
      results.push(
        await store.store({
          content,
          session_id: 'burst-session',
          project_path: `${NS}/burst`,
          type: 'pattern',
          importance: 0.06,
        })
      )
    }
    const elapsed = performance.now() - t0
    const rows = (
      db.prepare('SELECT COUNT(*) AS n FROM memories WHERE content = ?').get(content) as { n: number }
    ).n
    const deduplicated = results.filter((r) => r.deduplicated === true).length

    expect(rows).toBe(1)
    expect(deduplicated).toBe(199)

    console.log(
      'LIFECYCLE_EVAL ' +
        JSON.stringify({
          suite: 'lifecycle',
          write_gate_burst: {
            stores: 200,
            rows: rows,
            deduplicated: deduplicated,
            elapsed_ms: Number(elapsed.toFixed(1)),
            per_store_ms: Number((elapsed / 200).toFixed(3)),
          },
        })
    )
  }, 120_000)
})
