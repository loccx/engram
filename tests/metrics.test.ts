import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { MetricsTracker, getMetricsTracker } from '../src/metrics/tracker.js'
import { createTestDb } from './helpers.js'

const NS = 'test/project'

describe('MetricsTracker', () => {
  let db: Database.Database
  let tracker: MetricsTracker

  beforeEach(() => {
    db = createTestDb().db
    tracker = new MetricsTracker(db)
  })

  describe('install_id', () => {
    it('creates a uuid on first instantiation', () => {
      const id = tracker.getInstallId()
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    it('reuses the same install_id across tracker instances on the same db', () => {
      const id1 = tracker.getInstallId()
      const id2 = new MetricsTracker(db).getInstallId()
      expect(id2).toBe(id1)
    })

    it('persists install_id to engram_meta', () => {
      const id = tracker.getInstallId()
      const row = db
        .prepare("SELECT value FROM engram_meta WHERE key = 'install_id'")
        .get() as { value: string }
      expect(row.value).toBe(id)
    })
  })

  describe('recordSearch', () => {
    it('records a row marked hit=1 when results are returned', () => {
      tracker.recordSearch([{ content: 'aaaa' }, { content: 'bbbb' }], NS)
      const row = db
        .prepare("SELECT hit, tokens_served, result_count, namespace FROM engram_events WHERE event_type = 'search'")
        .get() as { hit: number; tokens_served: number; result_count: number; namespace: string }
      expect(row.hit).toBe(1)
      expect(row.result_count).toBe(2)
      expect(row.namespace).toBe(NS)
      expect(row.tokens_served).toBeGreaterThan(0)
    })

    it('marks hit=0 for empty result sets', () => {
      tracker.recordSearch([], NS)
      const row = db
        .prepare("SELECT hit, result_count FROM engram_events WHERE event_type = 'search'")
        .get() as { hit: number; result_count: number }
      expect(row.hit).toBe(0)
      expect(row.result_count).toBe(0)
    })

    it('stores a NULL namespace when none is given', () => {
      tracker.recordSearch([{ content: 'x' }])
      const row = db
        .prepare("SELECT namespace FROM engram_events WHERE event_type = 'search'")
        .get() as { namespace: string | null }
      expect(row.namespace).toBeNull()
    })
  })

  describe('recordContextLoad / recordStore / recordRelated', () => {
    it('writes separate event_type rows for each kind', () => {
      tracker.recordContextLoad([{ content: 'hello world' }], NS)
      tracker.recordStore('stored content here', NS)
      tracker.recordRelated([{ content: 'a' }, { content: 'b' }], NS)

      const counts = db
        .prepare(
          `SELECT event_type, COUNT(*) as n FROM engram_events GROUP BY event_type ORDER BY event_type`
        )
        .all() as Array<{ event_type: string; n: number }>
      expect(counts).toEqual([
        { event_type: 'context', n: 1 },
        { event_type: 'related', n: 1 },
        { event_type: 'store', n: 1 },
      ])
    })
  })

  describe('getStats', () => {
    it('returns zeros when no events have been recorded', () => {
      const stats = tracker.getStats()
      expect(stats.searches.total).toBe(0)
      expect(stats.searches.hit_rate).toBe(0)
      expect(stats.context_loads).toBe(0)
      expect(stats.memories_stored).toBe(0)
      expect(stats.tokens_served).toBe(0)
      expect(stats.per_namespace).toEqual([])
    })

    it('computes hit_rate from search hits over total searches', () => {
      tracker.recordSearch([{ content: 'x' }], NS)
      tracker.recordSearch([{ content: 'y' }], NS)
      tracker.recordSearch([], NS)
      tracker.recordSearch([], NS)

      const stats = tracker.getStats()
      expect(stats.searches.total).toBe(4)
      expect(stats.searches.hits).toBe(2)
      expect(stats.searches.hit_rate).toBe(0.5)
    })

    it('sums tokens_served across search, context, and related events only', () => {
      tracker.recordSearch([{ content: 'aaaa' }], NS)
      tracker.recordContextLoad([{ content: 'bbbb' }], NS)
      tracker.recordRelated([{ content: 'cccc' }], NS)
      tracker.recordStore('not counted in token total', NS)

      const stats = tracker.getStats()
      expect(stats.tokens_served).toBe(3)
      expect(stats.memories_stored).toBe(1)
    })

    it('reports the 3x realistic-savings multiplier and Sonnet pricing rollup', () => {
      tracker.recordSearch([{ content: 'a'.repeat(40) }], NS)
      const stats = tracker.getStats()
      expect(stats.estimated_context_savings.tokens).toBe(10)
      expect(stats.estimated_context_savings.tokens_realistic).toBe(30)
      expect(stats.estimated_context_savings.estimated_usd_saved).toBeCloseTo(
        Math.round(((30) / 1_000_000) * 300) / 100,
        5
      )
    })

    it('groups per_namespace and orders by tokens_served DESC', () => {
      tracker.recordSearch([{ content: 'aaaaaaaa' }], 'project/big')
      tracker.recordSearch([{ content: 'bb' }], 'project/small')
      tracker.recordSearch([{ content: 'x' }], 'project/big')

      const stats = tracker.getStats()
      expect(stats.per_namespace).toHaveLength(2)
      expect(stats.per_namespace[0].namespace).toBe('project/big')
      expect(stats.per_namespace[0].searches).toBe(2)
      expect(stats.per_namespace[1].namespace).toBe('project/small')
    })

    it('filters by namespace when provided', () => {
      tracker.recordSearch([{ content: 'a' }], 'ns/one')
      tracker.recordSearch([{ content: 'b' }], 'ns/two')

      const stats = tracker.getStats({ namespace: 'ns/one' })
      expect(stats.searches.total).toBe(1)
    })

    it('filters by since timestamp when provided', () => {
      const cutoff = Date.now() + 1000
      tracker.recordSearch([{ content: 'past' }], NS)
      db.prepare("UPDATE engram_events SET created_at = ? WHERE event_type = 'search'").run(cutoff - 5000)
      tracker.recordSearch([{ content: 'future' }], NS)
      db.prepare("UPDATE engram_events SET created_at = ? WHERE rowid = last_insert_rowid()").run(cutoff + 100)

      const stats = tracker.getStats({ since: cutoff })
      expect(stats.searches.total).toBe(1)
    })

    it('includes install_id in the snapshot', () => {
      const stats = tracker.getStats()
      expect(stats.install_id).toBe(tracker.getInstallId())
    })
  })

  describe('getMetricsTracker singleton', () => {
    it('returns the same instance for repeated calls with the same db', () => {
      const a = getMetricsTracker(db)
      const b = getMetricsTracker(db)
      expect(a).toBe(b)
    })

    it('rebuilds when the db handle changes', () => {
      const a = getMetricsTracker(db)
      const otherDb = createTestDb().db
      const b = getMetricsTracker(otherDb)
      expect(a).not.toBe(b)
    })
  })
})
