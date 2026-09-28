import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DIGEST_BUDGET_SHARE,
  digestReserve,
  packWithinBudget,
} from '../src/memory/recall.js'

// a stable unit vector per text stands in for the model, so knn works offline
vi.mock('../src/embeddings/pipeline.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const dim = actual.EMBEDDING_DIM as number
  const vectorFor = (text: string): Float32Array => {
    let seed = 2166136261
    for (const ch of text) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0
    const v = new Float32Array(dim)
    let norm = 0
    for (let i = 0; i < dim; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      v[i] = seed / 2 ** 32 - 0.5
      norm += v[i] * v[i]
    }
    for (let i = 0; i < dim; i++) v[i] /= Math.sqrt(norm)
    return v
  }
  return { ...actual, getEmbedding: vi.fn(async (text: string) => vectorFor(text)) }
})

import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { listRetrievalEvents } from '../src/metrics/retrieval-log.js'
import { configs } from '../eval/configs/surface.js'


const PROJECT = '/home/user/eval-surface'
const CORPUS_MEMORIES = 10
const CORPUS_MEMORY_CHARS = 600
const DIGEST_CHARS = 6000

function corpus() {
  return {
    digest: '- pinned fact\n'.repeat(DIGEST_CHARS / 15).slice(0, DIGEST_CHARS),
    memories: Array.from({ length: CORPUS_MEMORIES }, (_, i) => ({
      content: `memory ${i} ${'m'.repeat(CORPUS_MEMORY_CHARS - 11)}`,
    })),
  }
}

function legacyReserve(budget: number, digestLen: number): number {
  return Math.min(digestLen, Math.floor(budget * DIGEST_BUDGET_SHARE))
}

function parse<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0].text) as T
}

describe('eval: surface configs', () => {
  it('declares only env-gated surface flags, each documented', () => {
    const names = Object.keys(configs).sort()
    expect(names).toEqual(['surface-no-idle-sweep', 'surface-telemetry', 'surface-telemetry-noquery'])
    for (const [name, patch] of Object.entries(configs)) {
      expect(patch.label, name).toMatch(/^surface: /)
      expect(patch.notes, name).toBeTruthy()
      for (const flag of Object.keys(patch.features ?? {})) {
        expect(['ENGRAM_LOG_QUERIES', 'ENGRAM_SESSION_IDLE_MS'], `${name}.${flag}`).toContain(flag)
      }
    }
  })
})

describe('eval: budget starvation (digest reserve)', () => {
  const measured: Array<Record<string, number>> = []

  it('measures the memories section at four budgets, before and after', () => {
    const { digest, memories } = corpus()
    for (const budget of [400, 1000, 4000, 8000]) {
      const packed = packWithinBudget({ budget_chars: budget, digest, memories, topics: [] })
      const legacyDigest = Math.min(digest.length, legacyReserve(budget, digest.length))
      // the old packer emitted the cut char as '…', which still counts
      const legacyEmitted = legacyDigest < digest.length ? legacyDigest + 1 : legacyDigest
      measured.push({
        budget,
        legacy_reserve: legacyDigest,
        new_reserve: digestReserve(budget, digest.length),
        legacy_memory_chars: Math.max(0, budget - legacyEmitted),
        new_memory_chars: packed.budget.per_section.memories,
        dropped_memories: packed.dropped.memories,
        digest_chars_cut: packed.dropped.digest_chars_cut,
      })
    }
    // eslint-disable-next-line no-console
    console.log('eval-surface budget measurements:', JSON.stringify(measured, null, 2))

    const at400 = measured[0]
    expect(at400.legacy_reserve).toBe(160)
    expect(at400.new_reserve).toBe(40)
    expect(at400.legacy_memory_chars).toBe(239)
    expect(at400.new_memory_chars).toBeGreaterThan(239)
    expect(at400.new_memory_chars).toBeLessThanOrEqual(400)

    for (const row of measured.filter((r) => r.budget >= 4000)) {
      expect(row.new_reserve).toBe(row.legacy_reserve)
    }
  })
})

describe('eval: retrieval ledger', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    delete process.env.ENGRAM_LOG_QUERIES
  })

  afterEach(() => {
    delete process.env.ENGRAM_LOG_QUERIES
  })

  it('records a consolation hit that the coarse hit counter cannot distinguish', async () => {
    await handleTool('store_memory', {
      content: 'Redis is a cache used for session data',
      project_path: PROJECT,
    })
    const payload = parse<{ results: unknown[] }>(
      await handleTool('search_memories', {
        project_path: PROJECT,
        query: 'kubernetes pod autoscaling strategy',
      })
    )
    const db = getDatabase().db
    const coarse = db
      .prepare("SELECT hit, result_count FROM engram_events WHERE event_type = 'search'")
      .get() as { hit: number; result_count: number }
    const [event] = listRetrievalEvents(db)

    // a vector neighbour always comes back: "something came back" is not quality
    expect(payload.results.length).toBeGreaterThan(0)
    expect(coarse.hit).toBe(1)
    expect(event.query).toBe('kubernetes pod autoscaling strategy')
    expect(JSON.parse(event.result_ids).length).toBe(payload.results.length)
    // eslint-disable-next-line no-console
    console.log(
      'eval-surface ledger:',
      JSON.stringify({ coarse_hit: coarse.hit, logged_query: event.query, latency_ms: event.latency_ms })
    )
  })

  it('keeps the ledger row but drops the text in ENGRAM_LOG_QUERIES=0 mode', async () => {
    await handleTool('store_memory', { content: 'a fact', project_path: PROJECT })
    process.env.ENGRAM_LOG_QUERIES = '0'
    await handleTool('search_memories', { project_path: PROJECT, query: 'a fact' })

    const [event] = listRetrievalEvents(getDatabase().db)
    expect(event.query).toBeNull()
    expect(event.query_logged).toBe(0)
    expect(event.query_chars).toBe('a fact'.length)
    expect(JSON.stringify(event)).not.toContain('a fact')
  })
})

describe('eval: session lifecycle', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    delete process.env.ENGRAM_SESSION_IDLE_MS
  })

  afterEach(() => {
    delete process.env.ENGRAM_SESSION_IDLE_MS
  })

  it('rotates sessions under the default sweep and holds them with the sweep off', async () => {
    const db = getDatabase().db
    process.env.ENGRAM_SESSION_IDLE_MS = '1'
    const first = parse<{ session_id: string }>(
      await handleTool('store_memory', { content: 'first', project_path: PROJECT })
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = parse<{ session_id: string }>(
      await handleTool('store_memory', { content: 'second', project_path: PROJECT })
    )
    expect(second.session_id).not.toBe(first.session_id)
    const jobs = db
      .prepare("SELECT COUNT(*) AS n FROM maintenance_jobs WHERE source = 'end_session'")
      .get() as { n: number }

    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    process.env.ENGRAM_SESSION_IDLE_MS = '0'
    const db2 = getDatabase().db
    const a = parse<{ session_id: string }>(
      await handleTool('store_memory', { content: 'first', project_path: PROJECT })
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    const b = parse<{ session_id: string }>(
      await handleTool('store_memory', { content: 'second', project_path: PROJECT })
    )
    expect(b.session_id).toBe(a.session_id)
    const jobs2 = db2
      .prepare("SELECT COUNT(*) AS n FROM maintenance_jobs WHERE source = 'end_session'")
      .get() as { n: number }

    // eslint-disable-next-line no-console
    console.log(
      'eval-surface sessions:',
      JSON.stringify({ sweep_on_jobs: jobs.n, sweep_off_jobs: jobs2.n })
    )
    expect(jobs.n).toBeGreaterThan(0)
    expect(jobs2.n).toBe(0)
  })
})
