import type Database from 'better-sqlite3'
import { refreshNavDigest } from '../memory/nav.js'
import { children } from '../namespace/tree.js'

/**
 * bottom-up nav-digest consolidation: descend the subtree and refresh children before
 * parents, so a parent condenses the fresh child digests of the same pass. node rows
 * must exist already (children() returns materialized rows only).
 */

const MAX_DEPTH = 64

export interface ConsolidateResult {
  refreshed: number
}

export async function consolidateTree(
  db: Database.Database,
  rootPath: string,
  opts: { maxDepth?: number } = {}
): Promise<ConsolidateResult> {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH
  let refreshed = 0

  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    for (const child of children(db, path)) {
      await visit(child.path, depth + 1)
    }
    await refreshNavDigest(db, path)
    refreshed++
  }

  await visit(rootPath, 0)
  return { refreshed }
}
