import type Database from 'better-sqlite3'
import { refreshNavDigest } from '../memory/nav.js'
import { children } from '../namespace/tree.js'

/**
 * Recursive (bottom-up) nav-digest consolidation for the namespace tree.
 *
 * Descends the subtree under `rootPath`, refreshing children before parents so
 * a parent's digest condenses the FRESH child digests produced in the same
 * pass. Node rows must already exist (children() only returns materialized
 * rows) — a missing node is skipped by refreshNavDigest, never created here.
 *
 * Depth-bounded as a cycle guard even though the tree is acyclic by
 * construction (parseNamespacePath derived parent links).
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
