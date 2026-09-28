import type Database from 'better-sqlite3'
import { notSupersededClause, SUPERSEDES_FILTER_THRESHOLD } from '../contradictions/supersession.js'
import { computeTier, type Tier } from '../memory/enrichment.js'
import { logger } from '../utils/logger.js'
import { lexicalFamilyIndex } from './prune.js'

// interference-based archive tier. a row is retired only when it is redundant
// (a duplicate marker, or a non-keeper member of a lexical family), scores below
// the threshold, has gone unused for minAgeDays, and the corpus is big enough.
// pinned, shareable, promoted, adjudication-winner, dedupe-keeper and hot rows
// are never archived, and archiving only sets archived_at, so it is reversible.

export const RETENTION_DEFAULT_MAX_SCORE = 0.35
export const RETENTION_DEFAULT_MIN_CORPUS = 500
export const RETENTION_DEFAULT_MIN_AGE_DAYS = 14
export const RETENTION_DEFAULT_MAX_ARCHIVE = 200

export interface RetentionOptions {
  namespace?: string
  maxScore?: number
  minCorpusSize?: number
  minAgeDays?: number
  maxArchive?: number
  now?: number
  scanLimit?: number
}

export interface RetentionCandidate {
  id: string
  score: number
  tier: Tier
  importance: number
  access_count: number
  age_days: number
  link_degree: number
  duplicate_claims: number
  /** live rows sharing this row's (namespace, type, text-prefix) bucket */
  lexical_siblings: number
  redundant: boolean
}

export interface RetentionPlan {
  namespace: string | null
  corpus_size: number
  scanned: number
  threshold: number
  min_age_days: number
  below_threshold: boolean
  eligible: number
  skipped: Record<string, number>
  candidates: RetentionCandidate[]
  archive_ids: string[]
}



export interface RetentionReport extends RetentionPlan {
  archived: number
  duration_ms: number
}

interface RetentionRow {
  id: string
  content: string
  namespace: string
  type: string
  importance: number
  access_count: number
  last_accessed: number | null
  created_at: number
  pinned: number
  shareable: number | null
  origin: string | null
  link_degree: number
  duplicates_out: number
  supersedes_out: number
  duplicate_target: number
}

export function retentionMaxScore(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.ENGRAM_RETENTION_MAX_SCORE ?? '')
  if (!Number.isFinite(n)) return RETENTION_DEFAULT_MAX_SCORE
  return Math.min(Math.max(n, 0), 1)
}

export function retentionMinCorpusSize(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.ENGRAM_RETENTION_MIN_CORPUS ?? '', 10)
  if (!Number.isFinite(n) || n < 0) return RETENTION_DEFAULT_MIN_CORPUS
  return n
}

export function retentionMaxArchive(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.ENGRAM_RETENTION_MAX_ARCHIVE ?? '', 10)
  if (!Number.isFinite(n) || n < 0) return RETENTION_DEFAULT_MAX_ARCHIVE
  return n
}

export interface RetentionSignals {
  importance: number
  access_count: number
  last_accessed: number | null
  created_at: number
  link_degree: number
  duplicate_claims: number
}

export function retentionScore(signals: RetentionSignals, now: number = Date.now()): number {
  const accessNorm = Math.min(Math.log(signals.access_count + 1) / Math.log(50), 1)
  const ageDays = Math.max(0, now - (signals.last_accessed ?? signals.created_at)) / (24 * 60 * 60 * 1000)
  const recencyNorm = Math.exp(-ageDays / 30)
  const linkDegreeNorm = Math.min(signals.link_degree / 8, 1)
  const uniquenessNorm = signals.duplicate_claims === 0 ? 1 : signals.duplicate_claims === 1 ? 0.5 : 0
  const score =
    0.4 * signals.importance +
    0.2 * accessNorm +
    0.1 * recencyNorm +
    0.15 * linkDegreeNorm +
    0.15 * uniquenessNorm
  return Number(Math.max(0, Math.min(score, 1)).toFixed(6))
}

export function planRetention(db: Database.Database, opts: RetentionOptions = {}): RetentionPlan {
  const now = opts.now ?? Date.now()
  const maxScore = opts.maxScore ?? retentionMaxScore()
  const minCorpusSize = opts.minCorpusSize ?? retentionMinCorpusSize()
  const minAgeDays = opts.minAgeDays ?? RETENTION_DEFAULT_MIN_AGE_DAYS
  const maxArchive = opts.maxArchive ?? retentionMaxArchive()
  const scanLimit = opts.scanLimit ?? 20000

  const namespaceFilter = opts.namespace ? ' AND COALESCE(namespace, project_path) = ?' : ''
  const scopeParams = opts.namespace ? [opts.namespace] : []
  const corpusSize = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories
         WHERE ${notSupersededClause('memories.id')}${namespaceFilter}`
      )
      .get(...scopeParams) as { n: number }
  ).n

  const skipped: Record<string, number> = {
    corpus_too_small: 0,
    pinned: 0,
    shareable: 0,
    promotion: 0,
    adjudication_winner: 0,
    dedupe_keeper: 0,
    hot_tier: 0,
    recently_used: 0,
    non_redundant: 0,
    above_threshold: 0,
  }

  const rows = db
    .prepare(
      `SELECT id, content, COALESCE(namespace, project_path) AS namespace, type,
              importance, access_count, last_accessed, created_at, pinned, shareable, origin,
              (SELECT COUNT(*) FROM memory_links ml
                WHERE ml.source_id = memories.id OR ml.target_id = memories.id) AS link_degree,
              (SELECT COUNT(*) FROM memory_links ml
                WHERE ml.source_id = memories.id AND ml.link_type = 'duplicate_of') AS duplicates_out,
              (SELECT COUNT(*) FROM memory_links ml
                WHERE ml.source_id = memories.id AND ml.link_type = 'supersedes'
                  AND ml.confidence >= ${SUPERSEDES_FILTER_THRESHOLD}) AS supersedes_out,
              (SELECT COUNT(*) FROM memory_links ml
                WHERE ml.target_id = memories.id AND ml.link_type = 'duplicate_of') AS duplicate_target
       FROM memories
       WHERE ${notSupersededClause('memories.id')}${namespaceFilter}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .all(...scopeParams, scanLimit) as RetentionRow[]

  const families =
    corpusSize < minCorpusSize
      ? { siblings: new Map<string, number>(), keepers: new Set<string>() }
      : lexicalFamilyIndex(rows)

  const candidates: RetentionCandidate[] = []
  for (const row of rows) {
    if (corpusSize < minCorpusSize) {
      skipped.corpus_too_small++
      continue
    }
    if (row.pinned === 1) {
      skipped.pinned++
      continue
    }
    if (row.shareable === 1) {
      skipped.shareable++
      continue
    }
    if (row.origin === 'promotion') {
      skipped.promotion++
      continue
    }
    if (row.supersedes_out > 0) {
      // it won an adjudication: the surviving side of a contradiction
      skipped.adjudication_winner++
      continue
    }
    if (row.duplicate_target > 0) {
      skipped.dedupe_keeper++
      continue
    }

    const score = retentionScore(
      {
        importance: row.importance,
        access_count: row.access_count,
        last_accessed: row.last_accessed,
        created_at: row.created_at,
        link_degree: row.link_degree,
        duplicate_claims: row.duplicates_out,
      },
      now
    )
    const tier = computeTier(
      {
        importance: row.importance,
        access_count: row.access_count,
        last_accessed: row.last_accessed,
        created_at: row.created_at,
        pinned: false,
      },
      now
    )
    if (tier === 'hot') {
      skipped.hot_tier++
      continue
    }
    const ageDays = Math.max(0, now - (row.last_accessed ?? row.created_at)) / (24 * 60 * 60 * 1000)
    const lexicalSiblings = families.siblings.get(row.id) ?? 0
    const familyKeeper = families.keepers.has(row.id)
    // a unique row carries no interference, so no score can justify retiring it;
    // a family keeper is never redundant, something has to survive the family
    const redundant =
      row.duplicates_out > 0 || row.duplicate_target > 0 || (lexicalSiblings > 0 && !familyKeeper)
    if (!redundant) {
      skipped.non_redundant++
      continue
    }
    if (ageDays < minAgeDays) {
      skipped.recently_used++
      continue
    }
    if (score >= maxScore) {
      skipped.above_threshold++
      continue
    }
    candidates.push({
      id: row.id,
      score,
      tier,
      importance: row.importance,
      access_count: row.access_count,
      age_days: Number(ageDays.toFixed(1)),
      link_degree: row.link_degree,
      duplicate_claims: row.duplicates_out,
      lexical_siblings: lexicalSiblings,
      redundant,
    })
  }

  candidates.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const archiveIds = candidates.slice(0, Math.max(0, maxArchive)).map((c) => c.id)

  return {
    namespace: opts.namespace ?? null,
    corpus_size: corpusSize,
    scanned: rows.length,
    threshold: maxScore,
    min_age_days: minAgeDays,
    below_threshold: corpusSize < minCorpusSize,
    eligible: candidates.length,
    skipped,
    candidates,
    archive_ids: archiveIds,
  }
}

/** idempotent: only rows still un-archived change */
export function applyRetention(
  db: Database.Database,
  plan: RetentionPlan,
  now: number = Date.now()
): { archived: number } {
  const archive = db.prepare('UPDATE memories SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
  let archived = 0
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      try {
        archived += archive.run(now, id).changes
      } catch (err) {
        logger.warn({ err, memoryId: id }, 'retention: archiving a row failed; continuing')
      }
    }
  })
  tx(plan.archive_ids)
  return { archived }
}

export function runRetention(db: Database.Database, opts: RetentionOptions = {}): RetentionReport {
  const t0 = Date.now()
  const plan = planRetention(db, opts)
  const { archived } = applyRetention(db, plan, opts.now ?? Date.now())
  return { ...plan, archived, duration_ms: Date.now() - t0 }
}
