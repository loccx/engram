import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { chat, isLlmConfigured } from '../llm/client.js'
import { getDigest } from './digest.js'
import { logger } from '../utils/logger.js'
import { children } from '../namespace/tree.js'

/**
 * Thin navigation layer for the namespace tree (see
 * docs/specs/hierarchical-memory-p1.md). Each namespace node carries a compact
 * digest — pinned facts, topic summaries, one-line child digests — that funnel
 * retrieval ascends through when a leaf scope is thin.
 *
 * Child rows come from namespace/tree.ts `children()` — that module owns node
 * creation (ensureNode). Node rows must exist before refreshNavDigest is
 * called; a missing row is a no-op, never an implicit create.
 */

export const NAV_DIGEST_BUDGET_CHARS = 1200

export interface ChildRosterEntry {
  path: string
  digest: string
  memory_count: number
  child_count: number
}

export interface RefreshNavDigestOptions {
  budgetChars?: number
}

interface NodeRow {
  digest: string | null
  digest_source_hash: string | null
}

interface NavSources {
  pinnedDigest: string
  clusterSummaries: string[]
  promotedPatterns: string[]
  childLines: Array<{ path: string; digest: string }>
}
// (children come from namespace/tree.ts — tree rows are its contract)

const SYSTEM_PROMPT = `You condense a project namespace's memory navigation facts into a thin digest used by a parent-directory memory index.

Rules:
- Preserve concrete facts: names, paths, commands, decisions, constraints.
- Drop filler, hedging, and narrative framing.
- Output markdown bullets only. No preamble, no headings, no closing commentary.
- The output MUST be shorter than the character budget you are given.`

export async function refreshNavDigest(
  db: Database.Database,
  namespace: string,
  opts: RefreshNavDigestOptions = {}
): Promise<{ content: string; changed: boolean }> {
  const budget = opts.budgetChars ?? NAV_DIGEST_BUDGET_CHARS
  try {
    const node = db
      .prepare('SELECT digest, digest_source_hash FROM namespace_nodes WHERE path = ?')
      .get(namespace) as NodeRow | undefined
    if (!node) {
      logger.debug(
        { namespace },
        'nav: node row missing; skipping digest write (tree.ensureNode must run first)'
      )
      return { content: '', changed: false }
    }

    const sources = collectSources(db, namespace)
    const lines = buildSourceLines(sources)
    const hash = hashSources(lines)
    if (node.digest_source_hash === hash && node.digest !== null) {
      return { content: node.digest, changed: false }
    }

    const candidate = lines.join('\n')
    let content: string
    if (candidate.length === 0) {
      content = ''
    } else if (candidate.length <= budget) {
      content = candidate
    } else if (isLlmConfigured()) {
      try {
        content = (await condense(candidate, budget)).slice(0, budget)
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), namespace },
          'nav: LLM condense failed; using extractive fallback'
        )
        content = packExtractive(lines, budget)
      }
    } else {
      content = packExtractive(lines, budget)
    }

    db.prepare(
      `UPDATE namespace_nodes
       SET digest = ?, digest_source_hash = ?, updated_at = ?
       WHERE path = ?`
    ).run(content, hash, Date.now(), namespace)

    return { content, changed: content !== (node.digest ?? '') }
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), namespace },
      'nav: digest refresh failed; serving previous digest'
    )
    return { content: '', changed: false }
  }
}

export function childRoster(db: Database.Database, namespace: string): ChildRosterEntry[] {
  return children(db, namespace)
    .sort((a, b) => b.memory_count - a.memory_count || a.path.localeCompare(b.path))
    .slice(0, 12)
    .map((n) => ({
      path: n.path,
      digest: n.digest ?? '',
      memory_count: n.memory_count,
      child_count: n.child_count,
    }))
}

function collectSources(db: Database.Database, namespace: string): NavSources {
  const pinnedDigest = getDigest(db, namespace)

  const clusters = db
    .prepare(
      `SELECT summary FROM memory_clusters
       WHERE project_path = ? AND TRIM(summary) != ''
       ORDER BY updated_at DESC, id ASC
       LIMIT 5`
    )
    .all(namespace) as Array<{ summary: string }>

  const childRows = children(db, namespace).slice(0, 8)

  // Promoted patterns are first-class nav content: without them, promotion
  // would never surface in guide hits (digest-only nav layer).
  const promoted = db
    .prepare(
      `SELECT content FROM memories
       WHERE COALESCE(namespace, project_path) = ? AND origin = 'promotion'
       ORDER BY importance DESC, created_at DESC
       LIMIT 4`
    )
    .all(namespace) as Array<{ content: string }>

  return {
    pinnedDigest,
    clusterSummaries: clusters.map((c) => c.summary),
    promotedPatterns: promoted.map((p) => p.content),
    childLines: childRows.map((n) => ({ path: n.path, digest: n.digest ?? '' })),
  }

}


function buildSourceLines(sources: NavSources): string[] {
  const lines: string[] = []
  for (const raw of sources.pinnedDigest.split('\n')) {
    const line = raw.trim()
    if (line) lines.push(line)
  }
  for (const summary of sources.clusterSummaries) {
    lines.push(`[topic] ${summary.trim()}`)
  }
  for (const pattern of sources.promotedPatterns) {
    lines.push(`[pattern] ${pattern.split('\n')[0].trim().slice(0, 160)}`)
  }
  for (const child of sources.childLines) {
    const firstLine = child.digest.split('\n')[0].trim().slice(0, 100)
    lines.push(`[child ${child.path}] ${firstLine || '(no digest yet)'}`)
  }
  return lines
}

function hashSources(lines: string[]): string {
  return createHash('sha1').update(lines.join('\n')).digest('hex')
}

async function condense(candidate: string, budget: number): Promise<string> {
  const result = await chat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Character budget: ${budget}.\n\nNavigation facts:\n${candidate}`,
      },
    ],
    { temperature: 0, maxTokens: Math.ceil(budget / 3) }
  )
  return result.content.trim()
}

function packExtractive(lines: string[], budget: number): string {
  if (lines.length === 0) return ''
  if (lines.join('\n').length <= budget) return lines.join('\n')

  const reserve = 24 // room for the truncation marker
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = kept.length === 0 ? line.length : line.length + 1
    if (used + cost + reserve > budget) break
    kept.push(line)
    used += cost
  }

  if (kept.length === 0) {
    // Single line longer than the budget: hard-truncate with ellipsis.
    return lines[0].slice(0, Math.max(budget - 1, 1)) + '…'
  }
  return (kept.join('\n') + `\n…(${lines.length - kept.length} more)`).slice(0, budget)
}
