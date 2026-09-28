import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'

// query-level ledger (retrieval_events, migration 014). engram_events only has
// counters, so which query missed was not recoverable. ENGRAM_LOG_QUERIES=0
// stores the query length only and leaves the text NULL (see the readme).

export type RetrievalTool = 'search_memories' | 'get_context' | 'recall_context'

export interface RetrievalBudgetAccounting {
  budget_chars?: number
  used_chars?: number
  dropped_memories?: number
  dropped_topics?: number
  digest_chars_cut?: number
  truncated_digest?: boolean
  truncated_memories?: number
  truncated_topics?: number
}

export interface RetrievalEventInput {
  tool: RetrievalTool
  /** branch or recall mode, e.g. 'hybrid' | 'fused' | 'roster' */
  mode?: string
  namespace?: string | null
  query?: string | null
  /** ids actually returned, in rank order */
  resultIds: string[]
  latencyMs: number
  budget?: RetrievalBudgetAccounting
  /** the result set is below the healthy threshold */
  weak?: boolean
}

/** result count below which a retrieval is recorded as weak */
export const WEAK_RESULT_THRESHOLD = 3

/** capped so one pathological query cannot bloat the ledger */
export const MAX_LOGGED_QUERY_CHARS = 2000
/** result_count still reports the true size; only the stored ids are capped */
export const MAX_LOGGED_RESULT_IDS = 50

// an unparseable value keeps the default (query text stored: the store is local)
export function queryLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ENGRAM_LOG_QUERIES?.trim().toLowerCase()
  if (raw === undefined || raw === '') return true
  return !['0', 'false', 'off', 'no'].includes(raw)
}

// telemetry must never break a tool call: every failure, including a pre-014
// database, is swallowed after a debug log
export function recordRetrievalEvent(
  db: Database.Database,
  input: RetrievalEventInput,
  env: NodeJS.ProcessEnv = process.env
): void {
  try {
    const logQuery = queryLoggingEnabled(env)
    const query = typeof input.query === 'string' ? input.query : null
    const queryChars = query?.length ?? 0
    const budget = input.budget ?? {}
    db.prepare(
      `INSERT INTO retrieval_events (
         tool, mode, namespace, query, query_chars, query_logged,
         result_count, result_ids, latency_ms,
         budget_chars, used_chars, dropped_memories, dropped_topics, digest_chars_cut,
         truncated_digest, truncated_memories, truncated_topics,
         weak, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.tool,
      input.mode ?? null,
      input.namespace ?? null,
      logQuery && query !== null ? query.slice(0, MAX_LOGGED_QUERY_CHARS) : null,
      queryChars,
      // a roster call has no query, which is not the same as logging switched off
      logQuery && query !== null ? 1 : 0,
      input.resultIds.length,
      JSON.stringify(input.resultIds.slice(0, MAX_LOGGED_RESULT_IDS)),
      Math.max(0, Math.round(input.latencyMs)),
      budget.budget_chars ?? null,
      budget.used_chars ?? null,
      budget.dropped_memories ?? 0,
      budget.dropped_topics ?? 0,
      budget.digest_chars_cut ?? 0,
      budget.truncated_digest ? 1 : 0,
      budget.truncated_memories ?? 0,
      budget.truncated_topics ?? 0,
      input.weak ? 1 : 0,
      Date.now()
    )
  } catch (e) {
    logger.debug({ err: e, tool: input.tool }, 'retrieval_events: record failed (ignored)')
  }
}

export interface RetrievalEventRow {
  id: number
  tool: string
  mode: string | null
  namespace: string | null
  query: string | null
  query_chars: number
  query_logged: number
  result_count: number
  result_ids: string
  latency_ms: number
  budget_chars: number | null
  used_chars: number | null
  dropped_memories: number
  dropped_topics: number
  digest_chars_cut: number
  truncated_digest: number
  truncated_memories: number
  truncated_topics: number
  weak: number
  created_at: number
}

export function listRetrievalEvents(
  db: Database.Database,
  limit = 100
): RetrievalEventRow[] {
  return db
    .prepare('SELECT * FROM retrieval_events ORDER BY id DESC LIMIT ?')
    .all(limit) as RetrievalEventRow[]
}

export function countRetrievalEvents(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM retrieval_events').get() as { n: number }
  return row.n
}
