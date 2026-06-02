import type Database from 'better-sqlite3'
import type { Memory } from '../types.js'
import { notSupersededClause } from '../../contradictions/supersession.js'
import { rowToMemory, type MemoryRow } from '../row.js'

export interface DuplicateGroup {
  representative: Memory
  duplicates: Array<{ memory: Memory; similarity: number }>
}

export interface FindDuplicatesOptions {
  threshold?: number
  project_path?: string
  limit?: number
  include_superseded?: boolean
}

interface PairRow {
  source_id: string
  target_id: string
  similarity: number
  imp1: number
  imp2: number
  acc1: number
  acc2: number
}

export function findDuplicates(
  db: Database.Database,
  vectorsAvailable: boolean,
  options: FindDuplicatesOptions = {}
): DuplicateGroup[] {
  if (!vectorsAvailable) return []

  const threshold = options.threshold ?? 0.95
  const limit = options.limit ?? 50

  const conditions: string[] = []
  const values: unknown[] = [threshold]
  if (options.project_path) {
    conditions.push('COALESCE(m1.namespace, m1.project_path) = ?')
    values.push(options.project_path)
  }
  if (!options.include_superseded) {
    conditions.push(notSupersededClause('m1.id'))
    conditions.push(notSupersededClause('m2.id'))
  }
  values.push(limit)

  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : ''

  const pairs = db
    .prepare(
      `SELECT ml.source_id, ml.target_id, ml.similarity,
              m1.importance as imp1, m2.importance as imp2,
              m1.access_count as acc1, m2.access_count as acc2
       FROM memory_links ml
       JOIN memories m1 ON ml.source_id = m1.id
       JOIN memories m2 ON ml.target_id = m2.id
       WHERE ml.similarity > ? ${where}
         AND ml.source_id < ml.target_id
       ORDER BY ml.similarity DESC
       LIMIT ?`
    )
    .all(...values) as PairRow[]

  const parent = new Map<string, string>()
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x)
    const p = parent.get(x)!
    if (p !== x) parent.set(x, find(p))
    return parent.get(x)!
  }
  const union = (x: string, y: string) => parent.set(find(x), find(y))

  for (const { source_id, target_id } of pairs) union(source_id, target_id)

  const groups = new Map<string, string[]>()
  for (const { source_id, target_id } of pairs) {
    const root = find(source_id)
    if (!groups.has(root)) groups.set(root, [])
    const group = groups.get(root)!
    for (const id of [source_id, target_id]) {
      if (!group.includes(id)) group.push(id)
    }
  }

  const allIds = new Set<string>()
  for (const members of groups.values()) {
    for (const id of members) allIds.add(id)
  }

  const memoryMap = new Map<string, Memory>()
  if (allIds.size > 0) {
    const idList = [...allIds]
    const placeholders = idList.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...idList) as MemoryRow[]
    for (const row of rows) memoryMap.set(row.id, rowToMemory(row))
  }

  const simIndex = new Map<string, number>()
  for (const p of pairs) simIndex.set(`${p.source_id}:${p.target_id}`, p.similarity)

  const result: DuplicateGroup[] = []
  for (const members of groups.values()) {
    const memories = members.map((id) => memoryMap.get(id)).filter((m): m is Memory => m != null)
    if (memories.length < 2) continue

    const rep = memories.reduce((best, m) =>
      m.importance * (m.access_count + 1) > best.importance * (best.access_count + 1) ? m : best
    )

    const duplicates = memories
      .filter((m) => m.id !== rep.id)
      .map((m) => ({
        memory: m,
        similarity: simIndex.get(`${rep.id}:${m.id}`) ?? simIndex.get(`${m.id}:${rep.id}`) ?? threshold,
      }))

    result.push({ representative: rep, duplicates })
  }

  return result
}
