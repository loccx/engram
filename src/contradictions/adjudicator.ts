import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import { getEmbedding } from '../embeddings/pipeline.js'
import { isLlmConfigured, LlmUnavailableError } from '../llm/client.js'
import { findContradictionCandidates, type Candidate } from './candidates.js'
import { judgeCandidates, PROMPT_VERSION, type Verdict } from './judge.js'

export const SUPERSEDES_THRESHOLD = 0.8

export interface AdjudicationResult {
  memoryId: string
  status: 'ok' | 'no-candidates' | 'llm-unavailable' | 'memory-missing' | 'pinned' | 'error'
  verdicts: Verdict[]
  linksWritten: number
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
  const row = db
    .prepare('SELECT id, content, namespace, project_path, pinned, vec_rowid FROM memories WHERE id = ?')
    .get(memoryId) as MemoryRow | undefined
  if (!row) {
    return { memoryId, status: 'memory-missing', verdicts: [], linksWritten: 0 }
  }
  if (row.pinned === 1) {
    return { memoryId, status: 'pinned', verdicts: [], linksWritten: 0 }
  }
  if (!isLlmConfigured()) {
    return { memoryId, status: 'llm-unavailable', verdicts: [], linksWritten: 0 }
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
    return { memoryId, status: 'no-candidates', verdicts: [], linksWritten: 0 }
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
      return { memoryId, status: 'llm-unavailable', verdicts: [], linksWritten: 0 }
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err, memoryId }, 'adjudicator: judge failed')
    return { memoryId, status: 'error', verdicts: [], linksWritten: 0, error: message }
  }

  const linksWritten = writeSupersedes(db, memoryId, candidates, result.verdicts, result.model)
  return { memoryId, status: 'ok', verdicts: result.verdicts, linksWritten }
}

function writeSupersedes(
  db: Database.Database,
  newMemoryId: string,
  candidates: Candidate[],
  verdicts: Verdict[],
  model: string
): number {
  const candidateById = new Map(candidates.map((c) => [c.memory.id, c]))
  const pinnedStmt = db.prepare('SELECT pinned FROM memories WHERE id = ?')
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO memory_links
       (source_id, target_id, similarity, link_type, created_at, confidence, reason, decider_model, prompt_version, judged_at)
     VALUES (?, ?, ?, 'supersedes', ?, ?, ?, ?, ?, ?)`
  )
  const now = Date.now()
  let written = 0
  const tx = db.transaction((rows: Array<{ candidateId: string; verdict: Verdict }>) => {
    for (const { candidateId, verdict } of rows) {
      const target = pinnedStmt.get(candidateId) as { pinned: number | null } | undefined
      if (!target || target.pinned === 1) continue
      const candidate = candidateById.get(candidateId)
      const similarity = candidate?.vecSimilarity ?? verdict.confidence
      const info = insertStmt.run(
        newMemoryId,
        candidateId,
        similarity,
        now,
        verdict.confidence,
        verdict.reason,
        model,
        PROMPT_VERSION,
        now
      )
      if (info.changes > 0) written++
    }
  })
  const supersedingVerdicts = verdicts
    .filter(
      (v) =>
        (v.relation === 'contradicts' || v.relation === 'updates' || v.relation === 'duplicate') &&
        v.confidence >= SUPERSEDES_THRESHOLD
    )
    .map((v) => ({ candidateId: v.candidateId, verdict: v }))
  tx(supersedingVerdicts)
  return written
}
