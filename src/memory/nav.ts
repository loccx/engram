import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { chat, isLlmConfigured } from '../llm/client.js'
import { getDigest } from './digest.js'
import { logger } from '../utils/logger.js'
import { children } from '../namespace/tree.js'
import { readSourceGeneration } from '../sources/index.js'

// thin navigation layer over the namespace tree (docs/architecture.md): a node
// carries a compact digest — pinned facts, topic summaries, child digests — that
// funnel retrieval ascends when a leaf scope is thin. child rows come from
// namespace/tree.ts, which owns node creation; a missing row is a no-op here,
// never an implicit create.

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
  /** the child's whole digest, not a preview: the hash covers every line */
  childDigests: Array<{ path: string; digest: string }>
}

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

    const sourceGeneration = readSourceGeneration(db)
    const sources = collectSources(db, namespace)
    const lines = buildSourceLines(sources)
    const hash = hashSources(sources, lines)
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

    // never republish a pre-revocation navigation snapshot after an async
    // condensation. The transaction also serializes with external source writers.
    return db.transaction(() => {
      if (readSourceGeneration(db) !== sourceGeneration) {
        return { content: '', changed: false }
      }
      const currentSources = collectSources(db, namespace)
      if (hashSources(currentSources, buildSourceLines(currentSources)) !== hash) {
        return { content: '', changed: false }
      }
      db.prepare(
        `UPDATE namespace_nodes
         SET digest = ?, digest_source_hash = ?, updated_at = ?
         WHERE path = ?`
      ).run(content, hash, Date.now(), namespace)
      return { content, changed: content !== (node.digest ?? '') }
    }).immediate()
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

  // without these, promotion would never reach a guide hit: the nav layer is
  // digest-only
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
    childDigests: childRows.map((n) => ({ path: n.path, digest: n.digest ?? '' })),
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
  for (const child of sources.childDigests) {
    const childLines = child.digest
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (childLines.length === 0) {
      lines.push(`[child ${child.path}] (no digest yet)`)
      continue
    }
    lines.push(`[child ${child.path}] ${childLines[0]}`)
    // the rest of the child digest stays here; the budget bounds the total
    for (const line of childLines.slice(1)) lines.push(`  ${line}`)
  }
  return lines
}

// hashes the sources, not the rendered preview, so a change on line 2 propagates
function hashSources(sources: NavSources, lines: string[]): string {
  const h = createHash('sha1')
  h.update(lines.join('\n'))
  h.update('\u0000pinned\u0000')
  h.update(sources.pinnedDigest)
  h.update('\u0000clusters\u0000')
  for (const summary of sources.clusterSummaries) h.update(summary)
  h.update('\u0000patterns\u0000')
  for (const pattern of sources.promotedPatterns) h.update(pattern)
  h.update('\u0000children\u0000')
  for (const child of sources.childDigests) {
    h.update(child.path)
    h.update('\u0001')
    h.update(child.digest)
    h.update('\u0002')
  }
  return h.digest('hex')
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
    // one line longer than the whole budget: hard truncate
    return lines[0].slice(0, Math.max(budget - 1, 1)) + '…'
  }
  return (kept.join('\n') + `\n…(${lines.length - kept.length} more)`).slice(0, budget)
}
