import type Database from 'better-sqlite3'
import type { Memory } from '../types.js'
import { notSupersededClause } from '../../contradictions/supersession.js'
import { rowToMemory, type MemoryRow } from '../row.js'

export type GraphResult = Memory & { similarity: number; link_type: string; hops: number }

/**
 * Walk the memory graph N hops deep via recursive CTE.
 * Returns memories with hop distance, deduped to shortest path (window function
 * picks rn=1 partition per id, ordered by hops ASC, similarity DESC).
 */
export function traverseGraph(
  db: Database.Database,
  startId: string,
  depth: number = 2,
  limit: number = 20,
  options: { include_superseded?: boolean } = {}
): GraphResult[] {
  const supersededFilter = options.include_superseded
    ? ''
    : ` AND ${notSupersededClause('m.id')}`

  const rows = db
    .prepare(
      `WITH RECURSIVE traverse AS (
         SELECT target_id AS id, similarity, link_type, 1 AS hops,
                ',' || ? || ',' || target_id || ',' AS path
         FROM memory_links WHERE source_id = ?
         UNION ALL
         SELECT ml.target_id, ml.similarity, ml.link_type, t.hops + 1,
                t.path || ml.target_id || ','
         FROM traverse t
         JOIN memory_links ml ON ml.source_id = t.id
         WHERE t.hops < ? AND instr(t.path, ',' || ml.target_id || ',') = 0
       )
       SELECT m.*, sub.similarity, sub.link_type, sub.hops
       FROM (
         SELECT id, similarity, link_type, hops,
                ROW_NUMBER() OVER (PARTITION BY id ORDER BY hops ASC, similarity DESC) AS rn
         FROM traverse WHERE id != ?
       ) sub
       JOIN memories m ON m.id = sub.id
       WHERE sub.rn = 1${supersededFilter}
       ORDER BY sub.hops ASC, sub.similarity DESC
       LIMIT ?`
    )
    .all(startId, startId, depth, startId, limit) as Array<
      MemoryRow & { similarity: number; link_type: string; hops: number }
    >

  return rows.map((row) => ({
    ...rowToMemory(row),
    similarity: row.similarity,
    link_type: row.link_type,
    hops: row.hops,
  }))
}

/**
 * Personalized PageRank over the memory link graph.
 * Seeds get personalization mass; iterates power method 20× with damping=0.85.
 * Falls back to direct graph traversal when reachable subgraph is too small (<3 nodes).
 */
export function pprSearch(
  db: Database.Database,
  seedIds: string[],
  limit: number = 20,
  options: { include_superseded?: boolean } = {}
): GraphResult[] {
  const uniqueSeeds = [...new Set(seedIds.filter((s) => s.length > 0))]
  if (uniqueSeeds.length === 0) return []

  const seedValues = uniqueSeeds.map(() => '(?)').join(',')
  const reachableRows = db
    .prepare(
      `WITH RECURSIVE
         seeds(id) AS (VALUES ${seedValues}),
         traverse(source_id, target_id, hops, path) AS (
           SELECT ml.source_id, ml.target_id, 1,
                  ',' || ml.source_id || ',' || ml.target_id || ','
           FROM memory_links ml
           JOIN seeds s ON s.id = ml.source_id
           UNION ALL
           SELECT t.target_id, ml.target_id, t.hops + 1,
                  t.path || ml.target_id || ','
           FROM traverse t
           JOIN memory_links ml ON ml.source_id = t.target_id
           WHERE t.hops < 3 AND instr(t.path, ',' || ml.target_id || ',') = 0
         )
       SELECT DISTINCT id FROM (
         SELECT id FROM seeds
         UNION
         SELECT source_id AS id FROM traverse
         UNION
         SELECT target_id AS id FROM traverse
       )`
    )
    .all(...uniqueSeeds) as Array<{ id: string }>

  const reachableIds = [...new Set(reachableRows.map((r) => r.id))]
  if (reachableIds.length < 3) {
    const fallback = new Map<string, GraphResult>()
    for (const seed of uniqueSeeds) {
      const walked = traverseGraph(db, seed, 3, limit, options)
      for (const row of walked) {
        const prev = fallback.get(row.id)
        if (!prev || row.similarity > prev.similarity) fallback.set(row.id, row)
      }
    }
    return [...fallback.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
  }

  const nodePlaceholders = reachableIds.map(() => '?').join(',')
  const edgeRows = db
    .prepare(
      `SELECT source_id, target_id
       FROM memory_links
       WHERE source_id IN (${nodePlaceholders})
         AND target_id IN (${nodePlaceholders})`
    )
    .all(...reachableIds, ...reachableIds) as Array<{ source_id: string; target_id: string }>

  const adjacency = new Map<string, { targets: string[]; outDeg: number }>()
  const reverse = new Map<string, string[]>()
  for (const id of reachableIds) {
    adjacency.set(id, { targets: [], outDeg: 0 })
    reverse.set(id, [])
  }
  for (const { source_id, target_id } of edgeRows) {
    const outgoing = adjacency.get(source_id)
    if (outgoing) {
      outgoing.targets.push(target_id)
      outgoing.outDeg = outgoing.targets.length
    }
    const incoming = reverse.get(target_id)
    if (incoming) incoming.push(source_id)
  }

  const damping = 0.85
  const iterations = 20
  const seedWeight = 1 / uniqueSeeds.length
  const p = new Map<string, number>()
  let score = new Map<string, number>()
  for (const id of reachableIds) {
    const v = uniqueSeeds.includes(id) ? seedWeight : 0
    p.set(id, v)
    score.set(id, v)
  }

  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>()
    for (const id of reachableIds) {
      const incoming = reverse.get(id) ?? []
      let sum = 0
      for (const u of incoming) {
        const outDeg = adjacency.get(u)?.outDeg ?? 0
        if (outDeg > 0) sum += (score.get(u) ?? 0) / outDeg
      }
      const personal = p.get(id) ?? 0
      next.set(id, (1 - damping) * personal + damping * sum)
    }
    score = next
  }

  let candidates = reachableIds.filter((id) => !uniqueSeeds.includes(id))
  if (!options.include_superseded && candidates.length > 0) {
    const placeholders = candidates.map(() => '?').join(',')
    const validRows = db
      .prepare(`SELECT id FROM memories WHERE id IN (${placeholders}) AND ${notSupersededClause('id')}`)
      .all(...candidates) as Array<{ id: string }>
    const valid = new Set(validRows.map((r) => r.id))
    candidates = candidates.filter((id) => valid.has(id))
  }

  const rankedIds = candidates
    .sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0))
    .slice(0, limit)
  if (rankedIds.length === 0) return []

  const placeholders = rankedIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
    .all(...rankedIds) as MemoryRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))

  return rankedIds
    .map((id) => byId.get(id))
    .filter((r): r is MemoryRow => r != null)
    .map((row) => ({
      ...rowToMemory(row),
      similarity: score.get(row.id) ?? 0,
      link_type: 'semantic',
      hops: 1,
    }))
}
