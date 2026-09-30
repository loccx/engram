import type Database from 'better-sqlite3'
import { deleteEpisodes, type EpisodeDeleteCounts } from '../memory/episodes.js'

// the evidence tier's eviction. a ttl row past its expires_at and a
// retention='session' row whose session has ended are hidden from reads, so without
// this pass they stay on disk, keep their vectors and keep counting in the namespace
// totals. both rules go through deleteEpisodes, the one delete path. one pass is
// bounded, and a backlog continues in the next page job.

/** rows one pass removes before the page continues in a follow-up job */
export const EPISODE_SWEEP_LIMIT = 5000

/** the coalescing key of the first page, and of every continuation after it */
export const EPISODE_SWEEP_TARGET = 'episodes:expired'

/** page N > 0 drains what page N-1 left; a bounded pass never loses the backlog */
export function episodeSweepTargetKey(page: number): string {
  return page <= 0 ? EPISODE_SWEEP_TARGET : `${EPISODE_SWEEP_TARGET}:${page}`
}

/** next page for a target key, or 1 when the first page runs */
export function nextEpisodeSweepPage(targetKey: string): number {
  const suffix = targetKey.slice(EPISODE_SWEEP_TARGET.length)
  const page = suffix.startsWith(':') ? Number.parseInt(suffix.slice(1), 10) : 0
  return Number.isFinite(page) && page > 0 ? page + 1 : 1
}

/** retention='session' rows one session holds: what its own end just expired */
export function countSessionRetentionEpisodes(
  db: Database.Database,
  sessionId: string
): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM episodes WHERE retention = 'session' AND session_id = ?")
    .get(sessionId) as { n: number }
  return row.n
}

export interface EpisodeSweepReport extends EpisodeDeleteCounts {
  /** the bound was hit, so a continuation page is queued */
  truncated: boolean
  limit: number
}

/**
 * reclaim the evidence whose retention ran out. an episode whose session this store
 * never saw is kept either: nothing recorded that its session ended, so the row stays
 * until a ttl or a caller removes it.
 */
export function sweepExpiredEpisodes(
  db: Database.Database,
  opts: { now?: number; limit?: number } = {}
): EpisodeSweepReport {
  const limit = opts.limit ?? EPISODE_SWEEP_LIMIT
  const counts = deleteEpisodes(db, {}, {
    expired: true,
    session_ended: true,
    now: opts.now,
    limit,
  })
  return { ...counts, truncated: limit > 0 && counts.episodes >= limit, limit }
}
