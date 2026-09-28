import type Database from 'better-sqlite3'
import { computeClusters } from './clustering.js'
import { chat, isLlmConfigured } from '../llm/client.js'

interface StoredClusterRow {
  id: number
  member_ids: string
}

function extractiveSummary(content: string): string {
  return content
    .split(/[.!?]/)[0]
    .trim()
    .slice(0, 120)
}

async function summarizeCluster(
  representativeContent: string
): Promise<{ summary: string; isExtractive: boolean }> {
  const fallback = extractiveSummary(representativeContent)
  if (!isLlmConfigured()) return { summary: fallback, isExtractive: true }

  try {
    const result = await chat(
      [
        {
          role: 'user',
          content: `Summarize in one sentence: ${representativeContent.slice(0, 2000)}`,
        },
      ],
      { maxTokens: 60 }
    )
    const text = result.content.trim()
    if (!text) return { summary: fallback, isExtractive: true }
    return { summary: text.slice(0, 240), isExtractive: false }
  } catch {
    return { summary: fallback, isExtractive: true }
  }
}

function hasOverlap(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a)
  return b.some((id) => setA.has(id))
}

export async function runClusterWorker(
  db: Database.Database,
  projectPath: string,
  _llmBaseUrl?: string
): Promise<number> {
  const lastCluster = db
    .prepare('SELECT MAX(updated_at) as last FROM memory_clusters WHERE project_path = ?')
    .get(projectPath) as { last: number | null }
  if (lastCluster?.last) {
    const newLinks = db
      .prepare(
        'SELECT COUNT(*) as n FROM memory_links ml JOIN memories m ON m.id = ml.source_id WHERE COALESCE(m.namespace, m.project_path) = ? AND ml.created_at > ?'
      )
      .get(projectPath, lastCluster.last) as { n: number }
    if (newLinks.n === 0) return 0
  }

  const clusters = computeClusters(db, projectPath)
  if (clusters.length === 0) return 0

  const existingRows = db
    .prepare('SELECT id, member_ids FROM memory_clusters WHERE project_path = ?')
    .all(projectPath) as StoredClusterRow[]

  const existing = new Map<number, string[]>()
  for (const row of existingRows) {
    try {
      const parsed = JSON.parse(row.member_ids)
      if (Array.isArray(parsed)) {
        existing.set(
          row.id,
          parsed.filter((v): v is string => typeof v === 'string')
        )
      }
    } catch {
    }
  }

  const insertStmt = db.prepare(
    `INSERT INTO memory_clusters
      (project_path, member_ids, summary, is_extractive, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const updateStmt = db.prepare(
    `UPDATE memory_clusters
     SET member_ids = ?, summary = ?, is_extractive = ?, updated_at = ?
     WHERE id = ?`
  )

  let written = 0
  for (const cluster of clusters) {
    const { summary, isExtractive } = await summarizeCluster(cluster.representativeContent)
    const memberIds = cluster.memberIds
    const now = Date.now()

    const overlap = [...existing.entries()].find(([, ids]) => hasOverlap(ids, memberIds))
    if (overlap) {
      const [clusterId] = overlap
      updateStmt.run(JSON.stringify(memberIds), summary, isExtractive ? 1 : 0, now, clusterId)
      existing.set(clusterId, memberIds)
      written++
      continue
    }

    const info = insertStmt.run(
      projectPath,
      JSON.stringify(memberIds),
      summary,
      isExtractive ? 1 : 0,
      now,
      now
    )
    const newId = Number(info.lastInsertRowid)
    existing.set(newId, memberIds)
    written++
  }

  return written
}
