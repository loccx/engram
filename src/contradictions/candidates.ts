import type Database from 'better-sqlite3'
import type { Memory } from '../memory/types.js'
import { rowToMemory, type MemoryRow } from '../memory/row.js'
import { namespaceFilter } from '../memory/search/scope.js'
import type { CallerScope } from '../memory/access.js'
import { vectorSearchScored } from '../memory/search/hybrid.js'

export interface CandidateFinderOptions {
  vecTopK?: number
  ftsTopK?: number
  minCosineSim?: number
  maxCandidates?: number
  caller?: CallerScope
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
  const scope = namespaceFilter('m', { project_path: params.namespace, caller: options.caller })

  if (params.embedding && params.vectorsAvailable) {
    const distThreshold = Math.sqrt(2 * (1 - opts.minCosineSim))
    // a binary blob, as in store.ts and reembed.ts, which is much smaller than
    // compact than JSON and avoids per-search float-array serialization overhead.
    const vecRows = vectorSearchScored(db, params.embedding, {
      project_path: params.namespace, caller: options.caller,
      include_superseded: true, include_archived: true,
    }, opts.vecTopK + 1).filter((row) => row.memory.id !== params.excludeMemoryId).slice(0, opts.vecTopK)
    for (const { memory, distance } of vecRows) {
      if (distance > distThreshold) continue
      const sim = Math.max(0, 1 - (distance * distance) / 2)
      candidates.set(memory.id, { memory, source: 'vec', vecSimilarity: sim })
    }
  }

  const ftsRows = ftsCandidateLookup(db, params.contentForFts, scope, params.excludeMemoryId, opts.ftsTopK)
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
  scope: { sql: string; params: unknown[] },
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
           AND ${scope.sql}
           AND m.id != ?
         ORDER BY bm25(memories_fts, 10.0, 5.0)
         LIMIT ?`
      )
      .all(q, ...scope.params, excludeId, topK) as MemoryRow[]

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
