import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { listRetrievalEvents } from '../src/metrics/retrieval-log.js'
import { getMetricsTracker } from '../src/metrics/tracker.js'
import { getTokenEstimator, tokenizerLabel } from '../src/metrics/tokenizer.js'


const TEST_PROJECT = '/home/user/telemetry-project'

interface RetrievalPayload {
  budget?: { total_chars: number; used_chars: number }
  dropped?: { memories: number; digest_chars_cut: number }
  truncated?: { digest: boolean; memories: number }
  memories?: unknown[]
  results?: unknown[]
  miss?: { reason: string }
}

function parse<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0].text) as T
}

async function seed(count = 4, size = 500): Promise<void> {
  for (let i = 0; i < count; i++) {
    await handleTool('store_memory', {
      content: `telemetry fact ${i} ${'t'.repeat(size)}`,
      project_path: TEST_PROJECT,
    })
  }
}

describe('retrieval telemetry', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    delete process.env.ENGRAM_LOG_QUERIES
  })

  afterEach(() => {
    delete process.env.ENGRAM_LOG_QUERIES
  })

  it('records recall_context budget pressure in engram_events and retrieval_events', async () => {
    await seed(10, 900)
    const db = getDatabase().db
    db.prepare("UPDATE memories SET pinned = 1 WHERE id IN ('x')").run()

    const payload = parse<RetrievalPayload>(
      await handleTool('recall_context', {
        project_path: TEST_PROJECT,
        query: 'telemetry fact',
        budget_chars: 400,
      })
    )
    expect(payload.budget?.total_chars).toBe(400)
    expect(payload.dropped!.memories).toBeGreaterThan(0)

    const recallRow = db
      .prepare("SELECT hit, result_count FROM engram_events WHERE event_type = 'recall'")
      .get() as { hit: number; result_count: number } | undefined
    expect(recallRow).toBeDefined()
    expect(recallRow!.result_count).toBe(payload.memories!.length)
    expect(recallRow!.hit).toBe(payload.memories!.length > 0 ? 1 : 0)

    const [event] = listRetrievalEvents(db)
    expect(event.tool).toBe('recall_context')
    expect(event.mode).toBe('fused')
    expect(event.namespace).toBe(TEST_PROJECT)
    expect(event.query).toBe('telemetry fact')
    expect(event.query_logged).toBe(1)
    expect(event.budget_chars).toBe(400)
    expect(event.used_chars).toBe(payload.budget!.used_chars)
    expect(event.dropped_memories).toBe(payload.dropped!.memories)
    expect(JSON.parse(event.result_ids)).toEqual(
      (payload.memories as Array<{ id: string }>).map((m) => m.id)
    )
    expect(event.latency_ms).toBeGreaterThanOrEqual(0)
  })

  it('records a search miss with its query text so misses become queryable', async () => {
    await seed(1, 50)
    const db = getDatabase().db

    await handleTool('search_memories', {
      project_path: '/home/user/telemetry-empty',
      query: 'zzz-no-such-topic-zzz',
    })

    const [event] = listRetrievalEvents(db)
    expect(event.tool).toBe('search_memories')
    expect(event.query).toBe('zzz-no-such-topic-zzz')
    expect(event.result_count).toBe(0)
    expect(event.weak).toBe(1)
    expect(JSON.parse(event.result_ids)).toEqual([])

    const legacy = db
      .prepare("SELECT hit FROM engram_events WHERE event_type = 'search'")
      .get() as { hit: number }
    expect(legacy.hit).toBe(0)
  })

  it('records both get_context branches, distinguishing roster from query', async () => {
    await seed(2, 60)
    const db = getDatabase().db

    await handleTool('get_context', { project_path: TEST_PROJECT, query: 'telemetry' })
    await handleTool('get_context', { project_path: TEST_PROJECT })

    const events = listRetrievalEvents(db)
    expect(events).toHaveLength(2)
    const [roster, query] = events // newest first
    expect(roster.mode).toBe('roster')
    expect(roster.query).toBeNull()
    expect(roster.query_logged).toBe(0)
    expect(roster.weak).toBe(1) // 2 memories < the 3-hit healthy floor
    expect(query.mode).toMatch(/^hybrid/)
    expect(query.query).toBe('telemetry')
    expect(query.query_logged).toBe(1)
  })

  it('honours ENGRAM_LOG_QUERIES=0 by storing the query length only', async () => {
    await seed(1, 50)
    const db = getDatabase().db
    process.env.ENGRAM_LOG_QUERIES = '0'

    await handleTool('search_memories', { project_path: TEST_PROJECT, query: 'private topic' })

    const [event] = listRetrievalEvents(db)
    expect(event.query).toBeNull()
    expect(event.query_logged).toBe(0)
    expect(event.query_chars).toBe('private topic'.length)
    expect(JSON.stringify(event)).not.toContain('private topic')
  })

  it('records no query text but no rows either when nothing is called', () => {
    expect(listRetrievalEvents(getDatabase().db)).toEqual([])
  })
})

describe('get_stats honesty', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('labels the tokenizer instead of presenting chars/4 as a measurement', () => {
    const estimator = getTokenEstimator()
    const label = tokenizerLabel()
    expect(label.name).toBe(estimator.name)
    expect(label.exact).toBe(estimator.exact)
    if (estimator.exact) {
      // the eval harness ships a real tokenizer, so counts must be token-like
      expect(estimator.count('a'.repeat(400))).toBeLessThan(400)
      expect(estimator.count('a'.repeat(400))).toBeGreaterThan(0)
    } else {
      expect(estimator.name).toBe('chars/4')
      expect(label.chars_per_token).toBe(4)
      expect(estimator.count('a'.repeat(9))).toBe(3)
    }
  })

  it('reports the estimator and the savings assumptions in the stats payload', async () => {
    await seed(1, 400)
    await handleTool('search_memories', { project_path: TEST_PROJECT, query: 'telemetry' })

    const stats = getMetricsTracker(getDatabase().db).getStats()
    expect(['chars/4', 'gpt-tokenizer', 'js-tiktoken/o200k_base', '@dqbd/tiktoken/cl100k_base']).toContain(
      stats.tokenizer.name
    )
    expect(stats.estimated_context_savings.estimator).toContain(stats.tokenizer.name)
    expect(stats.estimated_context_savings.assumptions).toMatch(/3x/)
    expect(stats.estimated_context_savings.assumptions).toMatch(/estimates, not measurements/)
    expect(stats.retrievals?.logged).toBe(1)
    expect(stats.retrievals?.queries_logged).toBe(1)
  })
})
