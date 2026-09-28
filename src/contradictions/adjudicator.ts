import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import { getEmbedding } from '../embeddings/pipeline.js'
import { isLlmConfigured, LlmUnavailableError } from '../llm/client.js'
import { findContradictionCandidates, type Candidate } from './candidates.js'
import { judgeCandidates, PROMPT_VERSION, type Verdict } from './judge.js'

export const SUPERSEDES_THRESHOLD = 0.8

/** the cost of a false positive differs per relation: only a supersede hides a row */
export const RELATION_THRESHOLDS: Record<'contradicts' | 'updates' | 'duplicate', number> = {
  contradicts: 0.8,
  updates: 0.9,
  duplicate: 0.95,
}

/** below this a sub-threshold verdict is noise and is dropped entirely */
export const CONFLICTS_MIN_CONFIDENCE = 0.4

export function relationThreshold(relation: string): number | null {
  const raw = process.env[`ENGRAM_${relation.toUpperCase()}_THRESHOLD`]
  const envValue = raw ? Number.parseFloat(raw) : NaN
  if (Number.isFinite(envValue) && envValue >= 0 && envValue <= 1) return envValue
  return relation in RELATION_THRESHOLDS
    ? RELATION_THRESHOLDS[relation as keyof typeof RELATION_THRESHOLDS]
    : null
}

export interface AdjudicationResult {
  memoryId: string
  status: 'ok' | 'no-candidates' | 'llm-unavailable' | 'memory-missing' | 'pinned' | 'error'
  verdicts: Verdict[]
  linksWritten: number
  conflictsWritten: number
  error?: string
}

export interface AdjudicateOptions {
  vectorsAvailable: boolean
  embedder?: (content: string) => Promise<Float32Array | null>
  judge?: typeof judgeCandidates
}

interface MemoryRow {
  id: string
  content: string
  namespace: string | null
  project_path: string
  pinned: number | null
  vec_rowid: number | null
}

export async function adjudicateMemory(
  db: Database.Database,
  memoryId: string,
  options: AdjudicateOptions
): Promise<AdjudicationResult> {
  const result = await adjudicateMemoryInner(db, memoryId, options)
  recordAdjudicationState(db, memoryId, result.status)
  return result
}

function recordAdjudicationState(
  db: Database.Database,
  memoryId: string,
  status: AdjudicationResult['status']
): void {
  // 'skipped' = won't help to retry (pinned / missing / LLM offline at decision time).
  // 'done' = ran to a terminal answer; do not replay even if links were 0.
  const next: 'done' | 'skipped' =
    status === 'pinned' || status === 'memory-missing' || status === 'llm-unavailable'
      ? 'skipped'
      : 'done'
  try {
    db.prepare('UPDATE memories SET adjudication_state = ? WHERE id = ?').run(next, memoryId)
  } catch (err) {
    logger.debug({ err, memoryId }, 'adjudicator: failed to record adjudication_state')
  }
}

async function adjudicateMemoryInner(
  db: Database.Database,
  memoryId: string,
  options: AdjudicateOptions
): Promise<AdjudicationResult> {
  const row = db
    .prepare('SELECT id, content, namespace, project_path, pinned, vec_rowid FROM memories WHERE id = ?')
    .get(memoryId) as MemoryRow | undefined
  if (!row) {
    return { memoryId, status: 'memory-missing', verdicts: [], linksWritten: 0, conflictsWritten: 0 }
  }
  if (row.pinned === 1) {
    return { memoryId, status: 'pinned', verdicts: [], linksWritten: 0, conflictsWritten: 0 }
  }
  if (!isLlmConfigured()) {
    return { memoryId, status: 'llm-unavailable', verdicts: [], linksWritten: 0, conflictsWritten: 0 }
  }

  const namespace = row.namespace ?? row.project_path
  const embedder = options.embedder ?? getEmbedding
  let embedding: Float32Array | null = null
  if (options.vectorsAvailable) {
    try {
      embedding = await embedder(row.content)
    } catch (err) {
      logger.debug({ err, memoryId }, 'adjudicator: embedding failed, falling back to FTS-only')
    }
  }

  const candidates = findContradictionCandidates(db, {
    namespace,
    excludeMemoryId: memoryId,
    embedding,
    contentForFts: row.content,
    vectorsAvailable: options.vectorsAvailable,
  })
  if (candidates.length === 0) {
    return { memoryId, status: 'no-candidates', verdicts: [], linksWritten: 0, conflictsWritten: 0 }
  }

  const judge = options.judge ?? judgeCandidates
  let result
  try {
    result = await judge({
      newMemory: { id: memoryId, content: row.content, created_at: Date.now(), type: 'note' },
      candidates,
    })
  } catch (err) {
    if (err instanceof LlmUnavailableError) {
      return { memoryId, status: 'llm-unavailable', verdicts: [], linksWritten: 0, conflictsWritten: 0 }
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err, memoryId }, 'adjudicator: judge failed')
    return {
      memoryId,
      status: 'error',
      verdicts: [],
      linksWritten: 0,
      conflictsWritten: 0,
      error: message,
    }
  }

  const { supersedes, conflicts } = writeVerdicts(
    db,
    memoryId,
    candidates,
    result.verdicts,
    result.model
  )
  return {
    memoryId,
    status: 'ok',
    verdicts: result.verdicts,
    linksWritten: supersedes,
    conflictsWritten: conflicts,
  }
}

// above threshold: an append-only supersedes link plus a closed validity window.
// below it: a conflicts link that changes no visibility, so both sides stay readable.
// link identity includes link_type, so the pair's semantic edge does not swallow it.
function writeVerdicts(
  db: Database.Database,
  newMemoryId: string,
  candidates: Candidate[],
  verdicts: Verdict[],
  model: string
): { supersedes: number; conflicts: number } {
  const candidateById = new Map(candidates.map((c) => [c.memory.id, c]))
  const pinnedStmt = db.prepare('SELECT pinned FROM memories WHERE id = ?')
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO memory_links
       (source_id, target_id, similarity, link_type, created_at, confidence, reason, decider_model, prompt_version, judged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const setValidUntilStmt = db.prepare(
    'UPDATE memories SET valid_until = COALESCE(valid_until, ?) WHERE id = ?'
  )
  const now = Date.now()
  let supersedesWritten = 0
  let conflictsWritten = 0

  const rows = verdicts
    .map((verdict) => {
      const threshold = relationThreshold(verdict.relation)
      if (threshold === null) return null
      const hides = verdict.confidence >= threshold
      if (!hides && verdict.confidence < CONFLICTS_MIN_CONFIDENCE) return null
      return { candidateId: verdict.candidateId, verdict, hides }
    })
    .filter((r): r is { candidateId: string; verdict: Verdict; hides: boolean } => r !== null)

  const tx = db.transaction((entries: Array<{ candidateId: string; verdict: Verdict; hides: boolean }>) => {
    for (const { candidateId, verdict, hides } of entries) {
      const target = pinnedStmt.get(candidateId) as { pinned: number | null } | undefined
      if (!target || target.pinned === 1) continue
      const candidate = candidateById.get(candidateId)
      const similarity = candidate?.vecSimilarity ?? verdict.confidence
      const linkType = hides ? 'supersedes' : 'conflicts'
      const info = insertStmt.run(
        newMemoryId,
        candidateId,
        similarity,
        linkType,
        now,
        verdict.confidence,
        verdict.reason,
        model,
        PROMPT_VERSION,
        now
      )
      if (info.changes === 0) continue
      if (hides) {
        supersedesWritten++
        setValidUntilStmt.run(now, candidateId)
      } else {
        conflictsWritten++
      }
    }
  })
  tx(rows)
  return { supersedes: supersedesWritten, conflicts: conflictsWritten }
}
