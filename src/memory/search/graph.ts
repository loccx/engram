import type Database from 'better-sqlite3'
import type { Memory } from '../types.js'
import {
  notSupersededClause,
  notSupersededAtClause,
  validityAtClause,
} from '../../contradictions/supersession.js'
import { rowToMemory, type MemoryRow } from '../row.js'
import { namespaceFilter } from './scope.js'

export type GraphResult = Memory & { similarity: number; link_type: string; hops: number }

// _autoLink edges are global, so scoping has to filter the walked edges, not
// just the result rows: `mode: 'graph'` must never surface another project
// scope is optional, so an existing caller keeps its exact behaviour.
export interface GraphWalkOptions {
  include_superseded?: boolean
  as_of?: number
  /** the node itself plus anything under it; wins over project_path */
  namespace_subtree?: string
  project_path?: string
}

/** null (or non-positive) similarity means the edge carries no weight */
function edgeWeight(similarity: number | null): number | null {
  return similarity != null && Number.isFinite(similarity) && similarity > 0 ? similarity : null
}

// an out-of-scope startId yields no walk at all, and every hop target is filtered,
// so the walk can neither return nor route through an unscoped memory
export function traverseGraph(
  db: Database.Database,
  startId: string,
  depth: number = 2,
  limit: number = 20,
  options: GraphWalkOptions = {}
): GraphResult[] {
  const scope = namespaceFilter('m', options)
  const scopeClause = scope.sql ? ` AND ${scope.sql}` : ''
  if (scope.sql) {
    const seed = db
      .prepare(`SELECT 1 AS ok FROM memories m WHERE m.id = ? AND ${scope.sql}`)
      .get(startId, ...scope.params)
    if (!seed) return []
  }

  const params: unknown[] = [startId, startId, ...scope.params, depth, ...scope.params, startId]
  let timeFilter = ''
  if (options.as_of !== undefined) {
    timeFilter = ` AND ${validityAtClause('m', '?')}`
    params.push(options.as_of, options.as_of)
  }
  let supersededFilter = ''
  if (!options.include_superseded) {
    if (options.as_of !== undefined) {
      supersededFilter = ` AND ${notSupersededAtClause('m.id', '?')}`
      params.push(options.as_of)
    } else {
      supersededFilter = ` AND ${notSupersededClause('m.id')}`
    }
  }
  params.push(limit)

  const rows = db
    .prepare(
      `WITH RECURSIVE traverse AS (
         SELECT ml.target_id AS id, ml.similarity, ml.link_type, 1 AS hops,
                ',' || ? || ',' || ml.target_id || ',' AS path
         FROM memory_links ml
         JOIN memories m ON m.id = ml.target_id
         WHERE ml.source_id = ?${scopeClause}
         UNION ALL
         SELECT ml.target_id, ml.similarity, ml.link_type, t.hops + 1,
                t.path || ml.target_id || ','
         FROM traverse t
         JOIN memory_links ml ON ml.source_id = t.id
         JOIN memories m ON m.id = ml.target_id
         WHERE t.hops < ? AND instr(t.path, ',' || ml.target_id || ',') = 0${scopeClause}
       )
       SELECT m.*, sub.similarity, sub.link_type, sub.hops
       FROM (
         SELECT id, similarity, link_type, hops,
                ROW_NUMBER() OVER (PARTITION BY id ORDER BY hops ASC, similarity DESC) AS rn
         FROM traverse WHERE id != ?
       ) sub
       JOIN memories m ON m.id = sub.id
       WHERE sub.rn = 1${timeFilter}${supersededFilter}
       ORDER BY sub.hops ASC, sub.similarity DESC, m.id ASC
       LIMIT ?`
    )
    .all(...params) as Array<
      MemoryRow & { similarity: number; link_type: string; hops: number }
    >

  return rows.map((row) => ({
    ...rowToMemory(row),
    similarity: row.similarity,
    link_type: row.link_type,
    hops: row.hops,
  }))
}

interface NodeReach {
  hops: number
  link_type: string
}

// the scope covers the seeds and both ends of every walked edge, so a
// cross-namespace _autoLink edge cannot inject mass into a scoped result
export function pprSearch(
  db: Database.Database,
  seedIds: string[],
  limit: number = 20,
  options: GraphWalkOptions = {}
): GraphResult[] {
  const uniqueSeeds = [...new Set(seedIds.filter((s) => s.length > 0))]
  if (uniqueSeeds.length === 0) return []

  const scope = namespaceFilter('m', options)
  let scopedSeeds = uniqueSeeds
  if (scope.sql) {
    const seedPlaceholders = uniqueSeeds.map(() => '?').join(',')
    const seedRows = db
      .prepare(`SELECT m.id FROM memories m WHERE m.id IN (${seedPlaceholders}) AND ${scope.sql}`)
      .all(...uniqueSeeds, ...scope.params) as Array<{ id: string }>
    scopedSeeds = seedRows.map((r) => r.id)
    if (scopedSeeds.length === 0) return []
  }

  const seedValues = scopedSeeds.map(() => '(?)').join(',')
  const scopeClause = scope.sql ? ` AND ${scope.sql}` : ''
  const nodeRows = db
    .prepare(
      `WITH RECURSIVE
         seeds(id) AS (VALUES ${seedValues}),
         traverse(source_id, target_id, link_type, hops, path) AS (
           SELECT ml.source_id, ml.target_id, ml.link_type, 1,
                  ',' || ml.source_id || ',' || ml.target_id || ','
           FROM memory_links ml
           JOIN seeds s ON s.id = ml.source_id
           JOIN memories m ON m.id = ml.target_id
           WHERE 1 = 1${scopeClause}
           UNION ALL
           SELECT t.target_id, ml.target_id, ml.link_type, t.hops + 1,
                  t.path || ml.target_id || ','
           FROM traverse t
           JOIN memory_links ml ON ml.source_id = t.target_id
           JOIN memories m ON m.id = ml.target_id
           WHERE t.hops < 3 AND instr(t.path, ',' || ml.target_id || ',') = 0${scopeClause}
         ),
         node(id, hops, link_type) AS (
           SELECT id, hops, link_type FROM (
             SELECT id, hops, link_type,
                    ROW_NUMBER() OVER (
                      PARTITION BY id ORDER BY hops ASC, link_type ASC, source_id ASC
                    ) AS rn
             FROM (
               SELECT id, 0 AS hops, NULL AS link_type, NULL AS source_id FROM seeds
               UNION ALL
               SELECT target_id AS id, hops, link_type, source_id FROM traverse
             )
           ) WHERE rn = 1
         )
       SELECT id, hops, link_type FROM node`
    )
    .all(...scopedSeeds, ...scope.params, ...scope.params) as Array<{
    id: string
    hops: number
    link_type: string | null
  }>

  const nodeInfo = new Map<string, NodeReach>()
  for (const row of nodeRows) {
    nodeInfo.set(row.id, { hops: row.hops, link_type: row.link_type ?? 'semantic' })
  }
  // float accumulation must not depend on CTE row order
  const reachableIds = [...nodeInfo.keys()].sort()

  if (reachableIds.length < 3) {
    const fallback = new Map<string, GraphResult>()
    for (const seed of scopedSeeds) {
      const walked = traverseGraph(db, seed, 3, limit, options)
      for (const row of walked) {
        const prev = fallback.get(row.id)
        if (!prev || row.similarity > prev.similarity) fallback.set(row.id, row)
      }
    }
    return [...fallback.values()]
      .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
  }

  const nodePlaceholders = reachableIds.map(() => '?').join(',')
  const edgeRows = db
    .prepare(
      `SELECT source_id, target_id, similarity
       FROM memory_links
       WHERE source_id IN (${nodePlaceholders})
         AND target_id IN (${nodePlaceholders})`
    )
    .all(...reachableIds, ...reachableIds) as Array<{
    source_id: string
    target_id: string
    similarity: number | null
  }>

  const outgoing = new Map<string, Array<{ target: string; weight: number | null }>>()
  const incoming = new Map<string, string[]>()
  for (const id of reachableIds) {
    outgoing.set(id, [])
    incoming.set(id, [])
  }
  for (const { source_id, target_id, similarity } of edgeRows) {
    outgoing.get(source_id)?.push({ target: target_id, weight: edgeWeight(similarity) })
    incoming.get(target_id)?.push(source_id)
  }
  for (const sources of incoming.values()) sources.sort()

  // uniform out-degree when no outgoing edge carries a positive weight
  const transition = new Map<string, Map<string, number>>()
  for (const id of reachableIds) {
    const edges = outgoing.get(id) ?? []
    const totalWeight = edges.reduce((sum, e) => sum + (e.weight ?? 0), 0)
    const probs = new Map<string, number>()
    if (edges.length > 0) {
      for (const edge of edges) {
        const p = totalWeight > 0 ? (edge.weight ?? 0) / totalWeight : 1 / edges.length
        probs.set(edge.target, (probs.get(edge.target) ?? 0) + p)
      }
    }
    transition.set(id, probs)
  }

  const damping = 0.85
  const iterations = 20
  const seedWeight = 1 / scopedSeeds.length
  const seedSet = new Set(scopedSeeds)
  const personal = new Map<string, number>()
  for (const id of reachableIds) personal.set(id, seedSet.has(id) ? seedWeight : 0)

  let score = new Map(personal)
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>()
    for (const id of reachableIds) {
      const sources = incoming.get(id) ?? []
      let sum = 0
      for (const source of sources) {
        sum += (score.get(source) ?? 0) * (transition.get(source)?.get(id) ?? 0)
      }
      next.set(id, (1 - damping) * (personal.get(id) ?? 0) + damping * sum)
    }
    score = next
  }

  let candidates = reachableIds.filter((id) => !seedSet.has(id))
  if (candidates.length > 0) {
    const placeholders = candidates.map(() => '?').join(',')
    const filterParams: unknown[] = [...candidates]
    let validityFilter =
      options.as_of !== undefined ? ` AND ${validityAtClause('memories', '?')}` : ''
    if (options.as_of !== undefined) filterParams.push(options.as_of, options.as_of)
    let supersededFilter = ''
    if (!options.include_superseded) {
      if (options.as_of !== undefined) {
        supersededFilter = ` AND ${notSupersededAtClause('memories.id', '?')}`
        filterParams.push(options.as_of)
      } else {
        supersededFilter = ` AND ${notSupersededClause('memories.id')}`
      }
    }
    const validRows = db
      .prepare(
        `SELECT id FROM memories WHERE id IN (${placeholders})${validityFilter}${supersededFilter}`
      )
      .all(...filterParams) as Array<{ id: string }>
    const valid = new Set(validRows.map((r) => r.id))
    candidates = candidates.filter((id) => valid.has(id))
  }

  const rankedIds = candidates
    .sort(
      (a, b) =>
        (score.get(b) ?? 0) - (score.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
    )
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
      link_type: nodeInfo.get(row.id)?.link_type ?? 'semantic',
      hops: nodeInfo.get(row.id)?.hops ?? 1,
    }))
}
