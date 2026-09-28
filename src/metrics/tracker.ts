import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getTokenEstimator, tokenizerLabel } from './tokenizer.js'

export type MetricEvent = 'search' | 'context' | 'store' | 'related' | 'consolidate' | 'recall'

export interface EngineStats {
  install_id: string
  period: { since: number | null; until: number }
  searches: { total: number; hits: number; hit_rate: number }
  context_loads: number
  memories_stored: number
  tokens_served: number
  results_served: number
  /** exact:false means the count is chars/4 */
  tokenizer: { name: string; exact: boolean; chars_per_token?: number }
  /** null on a pre-014 database, or before the ledger has rows */
  retrievals: {
    logged: number
    empty: number
    weak: number
    avg_latency_ms: number
    avg_dropped_memories: number
    queries_logged: number
  } | null
  estimated_context_savings: {
    tokens: number
    /** conservative: tokens served. realistic: 3x, since raw file reads are verbose */
    tokens_realistic: number
    /** reference input price, usd per million tokens */
    estimated_usd_saved: number
    /** estimators, not measurements */
    estimator: string
    assumptions: string
  }
  per_namespace: Array<{
    namespace: string
    tokens_served: number
    searches: number
    search_hit_rate: number
  }>
}

const SAVINGS_ASSUMPTIONS =
  'tokens = tokenizer count of content served; tokens_realistic assumes raw file reads would '
  + 'cost 3x the served tokens; USD at $3 per million input tokens (Sonnet-class pricing). '
  + 'All three are estimates, not measurements of avoided work.'

function estimateTokens(text: string): number {
  return getTokenEstimator().count(text)
}

export class MetricsTracker {
  private readonly insertStmt: Database.Statement
  private readonly installId: string

  constructor(private readonly db: Database.Database) {
    this.installId = this.ensureInstallId()
    this.insertStmt = this.db.prepare(
      `INSERT INTO engram_events (event_type, hit, tokens_served, result_count, namespace, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
  }

  private ensureInstallId(): string {
    const existing = this.db
      .prepare("SELECT value FROM engram_meta WHERE key = 'install_id'")
      .get() as { value: string } | undefined
    if (existing) return existing.value

    const id = randomUUID()
    this.db.prepare("INSERT INTO engram_meta (key, value) VALUES ('install_id', ?)").run(id)
    return id
  }

  getInstallId(): string {
    return this.installId
  }

  recordSearch(results: Array<{ content: string }>, namespace?: string): void {
    const tokens = results.reduce((sum, r) => sum + estimateTokens(r.content), 0)
    this.insertStmt.run('search', results.length > 0 ? 1 : 0, tokens, results.length, namespace ?? null, Date.now())
  }

  recordContextLoad(memories: Array<{ content: string }>, namespace?: string): void {
    const tokens = memories.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    this.insertStmt.run('context', memories.length > 0 ? 1 : 0, tokens, memories.length, namespace ?? null, Date.now())
  }

  recordStore(content: string, namespace?: string): void {
    this.insertStmt.run('store', 1, estimateTokens(content), 1, namespace ?? null, Date.now())
  }

  recordRelated(results: Array<{ content: string }>, namespace?: string): void {
    const tokens = results.reduce((sum, r) => sum + estimateTokens(r.content), 0)
    this.insertStmt.run('related', results.length > 0 ? 1 : 0, tokens, results.length, namespace ?? null, Date.now())
  }

  /** recall_context served memories; without it budget starvation moves no counter */
  recordRecall(memories: Array<{ content: string }>, namespace?: string): void {
    const tokens = memories.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    this.insertStmt.run('recall', memories.length > 0 ? 1 : 0, tokens, memories.length, namespace ?? null, Date.now())
  }

  // a pre-014 database has no table: return null rather than fail the whole call
  private getRetrievalSummary(options?: { namespace?: string; since?: number }): EngineStats['retrievals'] {
    try {
      const conditions: string[] = []
      const values: unknown[] = []
      if (options?.namespace) {
        conditions.push('namespace = ?')
        values.push(options.namespace)
      }
      if (options?.since) {
        conditions.push('created_at >= ?')
        values.push(options.since)
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      const row = this.db
        .prepare(
          `SELECT
             COUNT(*) as logged,
             SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) as empty,
             SUM(CASE WHEN weak = 1 THEN 1 ELSE 0 END) as weak,
             AVG(latency_ms) as avg_latency_ms,
             AVG(dropped_memories) as avg_dropped_memories,
             SUM(CASE WHEN query_logged = 1 AND query IS NOT NULL THEN 1 ELSE 0 END) as queries_logged
           FROM retrieval_events ${where}`
        )
        .get(...values) as {
        logged: number | null
        empty: number | null
        weak: number | null
        avg_latency_ms: number | null
        avg_dropped_memories: number | null
        queries_logged: number | null
      }
      return {
        logged: row.logged ?? 0,
        empty: row.empty ?? 0,
        weak: row.weak ?? 0,
        avg_latency_ms: Math.round((row.avg_latency_ms ?? 0) * 10) / 10,
        avg_dropped_memories: Math.round((row.avg_dropped_memories ?? 0) * 10) / 10,
        queries_logged: row.queries_logged ?? 0,
      }
    } catch {
      return null
    }
  }

  getStats(options?: { namespace?: string; since?: number }): EngineStats {
    const conditions: string[] = []
    const values: unknown[] = []

    if (options?.namespace) {
      conditions.push('namespace = ?')
      values.push(options.namespace)
    }
    if (options?.since) {
      conditions.push('created_at >= ?')
      values.push(options.since)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const row = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN event_type = 'search' THEN 1 ELSE 0 END) as total_searches,
          SUM(CASE WHEN event_type = 'search' AND hit = 1 THEN 1 ELSE 0 END) as search_hits,
          SUM(CASE WHEN event_type = 'context' THEN 1 ELSE 0 END) as context_loads,
          SUM(CASE WHEN event_type = 'store' THEN 1 ELSE 0 END) as memories_stored,
          SUM(CASE WHEN event_type IN ('search', 'context', 'related', 'recall') THEN tokens_served ELSE 0 END) as tokens_served,
          SUM(CASE WHEN event_type IN ('search', 'context', 'related', 'recall') THEN result_count ELSE 0 END) as results_served
        FROM engram_events ${where}`
      )
      .get(...values) as {
        total_searches: number | null
        search_hits: number | null
        context_loads: number | null
        memories_stored: number | null
        tokens_served: number | null
        results_served: number | null
      }

    const totalSearches = row.total_searches ?? 0
    const searchHits = row.search_hits ?? 0
    const tokensServed = row.tokens_served ?? 0

    const perNamespace = this.db
      .prepare(
        `SELECT
          namespace,
          SUM(CASE WHEN event_type IN ('search', 'context', 'related', 'recall') THEN tokens_served ELSE 0 END) as tokens_served,
          SUM(CASE WHEN event_type = 'search' THEN 1 ELSE 0 END) as searches,
          SUM(CASE WHEN event_type = 'search' AND hit = 1 THEN 1 ELSE 0 END) as search_hits
        FROM engram_events
        ${where ? where + ' AND' : 'WHERE'} namespace IS NOT NULL
        GROUP BY namespace
        ORDER BY tokens_served DESC
        LIMIT 50`
      )
      .all(...values) as Array<{
        namespace: string
        tokens_served: number
        searches: number
        search_hits: number
      }>

    return {
      install_id: this.installId,
      period: {
        since: options?.since ?? null,
        until: Date.now(),
      },
      searches: {
        total: totalSearches,
        hits: searchHits,
        hit_rate: totalSearches > 0 ? Math.round((searchHits / totalSearches) * 100) / 100 : 0,
      },
      context_loads: row.context_loads ?? 0,
      memories_stored: row.memories_stored ?? 0,
      tokens_served: tokensServed,
      results_served: row.results_served ?? 0,
      tokenizer: tokenizerLabel(),
      retrievals: this.getRetrievalSummary(options),
      estimated_context_savings: {
        tokens: tokensServed,
        tokens_realistic: tokensServed * 3,
        estimated_usd_saved: Math.round(((tokensServed * 3) / 1_000_000) * 300) / 100,
        estimator: `${tokenizerLabel().name} (${tokenizerLabel().exact ? 'exact tokenizer' : 'char heuristic'})`,
        assumptions: SAVINGS_ASSUMPTIONS,
      },
      per_namespace: perNamespace.map((ns) => ({
        namespace: ns.namespace,
        tokens_served: ns.tokens_served,
        searches: ns.searches,
        search_hit_rate: ns.searches > 0 ? Math.round((ns.search_hits / ns.searches) * 100) / 100 : 0,
      })),
    }
  }
}

let _tracker: MetricsTracker | null = null
let _trackerDb: Database.Database | null = null

export function getMetricsTracker(db: Database.Database): MetricsTracker {
  if (_tracker && _trackerDb === db) return _tracker
  _tracker = new MetricsTracker(db)
  _trackerDb = db
  return _tracker
}
