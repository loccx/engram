import type Database from 'better-sqlite3'
import type { Memory } from '../memory/types.js'
import { rowToMemory, type MemoryRow } from '../memory/row.js'

export interface CandidateFinderOptions {
  vecTopK?: number
  ftsTopK?: number
  minCosineSim?: number
  maxCandidates?: number
}

export interface Candidate {
  memory: Memory
  source: 'vec' | 'fts' | 'both'
  vecSimilarity?: number
  ftsRank?: number
}

const DEFAULTS = {
  vecTopK: 20,
  ftsTopK: 20,
  minCosineSim: 0.75,
  maxCandidates: 10,
}

export function findContradictionCandidates(
  db: Database.Database,
  params: {
    namespace: string
    excludeMemoryId: string
    embedding?: Float32Array | null
    contentForFts: string
    vectorsAvailable: boolean
  },
  options: CandidateFinderOptions = {}
): Candidate[] {
  const opts = { ...DEFAULTS, ...options }
  const candidates = new Map<string, Candidate>()

  if (params.embedding && params.vectorsAvailable) {
    const distThreshold = Math.sqrt(2 * (1 - opts.minCosineSim))
    // Binary blob matches the format used in store.ts and reembed.ts — ~3-4x more
    // compact than JSON and avoids per-search float-array serialization overhead.
    const queryVec = Buffer.from(params.embedding.buffer)
    try {
      const vecRows = db
        .prepare(
          `SELECT m.*, knn.distance
           FROM (SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? LIMIT ?) knn
           JOIN memories m ON m.vec_rowid = knn.rowid
           WHERE COALESCE(m.namespace, m.project_path) = ?
             AND m.id != ?
             AND knn.distance <= ?`
        )
        .all(queryVec, opts.vecTopK, params.namespace, params.excludeMemoryId, distThreshold) as Array<
        MemoryRow & { distance: number }
      >
      for (const row of vecRows) {
        const sim = Math.max(0, 1 - (row.distance * row.distance) / 2)
        candidates.set(row.id, {
          memory: rowToMemory(row),
          source: 'vec',
          vecSimilarity: sim,
        })
      }
    } catch {}
  }

  const ftsRows = ftsCandidateLookup(db, params.contentForFts, params.namespace, params.excludeMemoryId, opts.ftsTopK)
  for (let i = 0; i < ftsRows.length; i++) {
    const row = ftsRows[i]
    const existing = candidates.get(row.id)
    if (existing) {
      existing.source = 'both'
      existing.ftsRank = i
    } else {
      candidates.set(row.id, {
        memory: rowToMemory(row),
        source: 'fts',
        ftsRank: i,
      })
    }
  }

  const ranked = Array.from(candidates.values()).sort(scoreCandidates)
  return ranked.slice(0, opts.maxCandidates)
}

function ftsCandidateLookup(
  db: Database.Database,
  content: string,
  namespace: string,
  excludeId: string,
  topK: number
): MemoryRow[] {
  const tokens = content
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 20)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
  if (tokens.length === 0) return []

  const stmt = (q: string) =>
    db
      .prepare(
        `SELECT m.* FROM memories_fts fts
         JOIN memories m ON fts.rowid = m.rowid
         WHERE memories_fts MATCH ?
           AND COALESCE(m.namespace, m.project_path) = ?
           AND m.id != ?
         ORDER BY bm25(memories_fts, 10.0, 5.0)
         LIMIT ?`
      )
      .all(q, namespace, excludeId, topK) as MemoryRow[]

  try {
    const andRows = stmt(tokens.join(' '))
    if (andRows.length > 0 || tokens.length <= 2) return andRows
    return stmt(tokens.join(' OR '))
  } catch {
    return []
  }
}

function scoreCandidates(a: Candidate, b: Candidate): number {
  return compositeScore(b) - compositeScore(a)
}

function compositeScore(c: Candidate): number {
  const vecScore = c.vecSimilarity ?? 0
  const ftsScore = c.ftsRank !== undefined ? Math.max(0, 1 - c.ftsRank / 20) : 0
  const sourceBonus = c.source === 'both' ? 0.2 : 0
  return vecScore * 0.6 + ftsScore * 0.4 + sourceBonus
}
