import type Database from 'better-sqlite3'

interface LinkRow {
  source_id: string
  target_id: string
}

interface MemorySummaryRow {
  id: string
  content: string
  importance: number
}

export function computeClusters(
  db: Database.Database,
  projectPath: string
): Array<{ memberIds: string[]; representativeContent: string; representativeImportance: number }> {
  const links = db
    .prepare(
      `SELECT ml.source_id, ml.target_id
       FROM memory_links ml
       JOIN memories m ON m.id = ml.source_id
       WHERE COALESCE(m.namespace, m.project_path) = ?
         AND ml.link_type = 'semantic'`
    )
    .all(projectPath) as LinkRow[]

  if (links.length === 0) return []

  const parent = new Map<string, string>()
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x)
    const p = parent.get(x)!
    if (p !== x) parent.set(x, find(p))
    return parent.get(x)!
  }
  const union = (x: string, y: string): void => {
    parent.set(find(x), find(y))
  }

  for (const { source_id, target_id } of links) {
    union(source_id, target_id)
  }

  const groups = new Map<string, Set<string>>()
  for (const { source_id, target_id } of links) {
    const root = find(source_id)
    if (!groups.has(root)) groups.set(root, new Set())
    groups.get(root)!.add(source_id)
    groups.get(root)!.add(target_id)
  }

  const allIds = new Set<string>()
  for (const members of groups.values()) {
    for (const id of members) allIds.add(id)
  }
  if (allIds.size === 0) return []

  const idList = [...allIds]
  const placeholders = idList.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, content, importance FROM memories WHERE id IN (${placeholders})`)
    .all(...idList) as MemorySummaryRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))

  const results: Array<{
    memberIds: string[]
    representativeContent: string
    representativeImportance: number
  }> = []

  for (const members of groups.values()) {
    const existing = [...members].map((id) => byId.get(id)).filter((m): m is MemorySummaryRow => m != null)
    if (existing.length < 2) continue
    const representative = existing.reduce((best, m) =>
      m.importance > best.importance ? m : best
    )
    results.push({
      memberIds: existing.map((m) => m.id),
      representativeContent: representative.content,
      representativeImportance: representative.importance,
    })
  }

  return results
}
