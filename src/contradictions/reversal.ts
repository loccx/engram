import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import { SUPERSEDES_FILTER_THRESHOLD } from './supersession.js'

// reverses an adjudicated supersession. updating valid_until alone does nothing:
// the supersedes link is what hides the row from every default read, so this
// removes the links, reopens the window, and marks both rows 'skipped' so the
// background adjudicator cannot silently re-create what a human just dropped.

export interface ReverseSupersessionOptions {
  targetId: string
  /** only remove the link this source wrote */
  sourceId?: string
  /** reopen the target window; default true */
  clearValidUntil?: boolean
  /** clear the target's archived_at; default true */
  unarchive?: boolean
  /** the source may have been closed too */
  clearSourceValidUntil?: boolean
  now?: number
}

export interface ReverseSupersessionResult {
  target_id: string
  source_id: string | null
  links_removed: number
  valid_until_cleared: boolean
  unarchived: boolean
  adjudication_state_cleared: number
}

export function reverseSupersession(
  db: Database.Database,
  opts: ReverseSupersessionOptions
): ReverseSupersessionResult {
  const now = opts.now ?? Date.now()
  const clearValidUntil = opts.clearValidUntil !== false
  const unarchive = opts.unarchive !== false

  const linkWhere = opts.sourceId
    ? "link_type = 'supersedes' AND target_id = ? AND source_id = ?"
    : "link_type = 'supersedes' AND target_id = ?"
  const linkParams = opts.sourceId ? [opts.targetId, opts.sourceId] : [opts.targetId]

  const result: ReverseSupersessionResult = {
    target_id: opts.targetId,
    source_id: opts.sourceId ?? null,
    links_removed: 0,
    valid_until_cleared: false,
    unarchived: false,
    adjudication_state_cleared: 0,
  }

  const tx = db.transaction(() => {
    const sources = db
      .prepare(`SELECT DISTINCT source_id FROM memory_links WHERE ${linkWhere}`)
      .all(...linkParams) as Array<{ source_id: string }>

    result.links_removed = db
      .prepare(`DELETE FROM memory_links WHERE ${linkWhere}`)
      .run(...linkParams).changes

    if (clearValidUntil) {
      result.valid_until_cleared =
        db.prepare('UPDATE memories SET valid_until = NULL WHERE id = ?').run(opts.targetId)
          .changes > 0
    }
    if (opts.clearSourceValidUntil) {
      const clearSource = db.prepare('UPDATE memories SET valid_until = NULL WHERE id = ?')
      for (const { source_id } of sources) clearSource.run(source_id)
    }
    if (unarchive) {
      result.unarchived =
        db
          .prepare('UPDATE memories SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL')
          .run(opts.targetId).changes > 0
    }

    // 'skipped' = do not replay: a human decided this pair is settled
    // superseded, so the adjudicator must not re-judge it back.
    const skipState = db.prepare(
      "UPDATE memories SET adjudication_state = 'skipped' WHERE id = ? AND adjudication_state IN ('done', 'pending')"
    )
    result.adjudication_state_cleared += skipState.run(opts.targetId).changes
    for (const { source_id } of sources) {
      result.adjudication_state_cleared += skipState.run(source_id).changes
    }
  })

  try {
    tx()
  } catch (err) {
    logger.warn({ err, targetId: opts.targetId }, 'reversal: supersession reversal failed')
    throw err
  }

  logger.info(
    {
      targetId: opts.targetId,
      sourceId: opts.sourceId ?? null,
      linksRemoved: result.links_removed,
      unarchived: result.unarchived,
      now,
    },
    'reversal: supersedes link removed and target visibility restored'
  )
  return result
}

/** the links that hide `targetId`, for the CLI listing */
export function listSupersessionLinks(
  db: Database.Database,
  targetId: string
): Array<{ source_id: string; target_id: string; confidence: number | null; reason: string | null; judged_at: number | null; revision: number }> {
  return db
    .prepare(
      `SELECT source_id, target_id, confidence, reason, judged_at, revision
       FROM memory_links
       WHERE link_type = 'supersedes' AND target_id = ?
         AND confidence >= ${SUPERSEDES_FILTER_THRESHOLD}
       ORDER BY COALESCE(judged_at, 0) DESC, source_id ASC`
    )
    .all(targetId) as Array<{
    source_id: string
    target_id: string
    confidence: number | null
    reason: string | null
    judged_at: number | null
    revision: number
  }>
}
