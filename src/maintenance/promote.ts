import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { chat, isLlmConfigured } from '../llm/client.js'
import { refreshNavDigest } from '../memory/nav.js'
import { children, parseNamespacePath } from '../namespace/tree.js'
import { notSupersededClause } from '../contradictions/supersession.js'
import { logger } from '../utils/logger.js'

/**
 * Pattern promotion: distills a synthetic leaf scope's repeated memories into
 * a single `pattern` memory living in the PARENT namespace (the thin nav
 * layer), then links every source memory to it. This is the P3 consolidation
 * pipeline — a canonical write, like digest refresh, not a shadow-only patch.
 *
 * Deterministic dedupe: a scope is skipped when its parent already holds a
 * `pattern` memory whose tags include the scope token, so re-running the job
 * never produces duplicate patterns.
 */

export const PROMOTE_MIN_MEMORIES = 8

const TOP_MEMORIES = 10
const EXTRACTIVE_SNIPPETS = 3
const EXTRACTIVE_SNIPPET_CHARS = 160
const PATTERN_MAX_CHARS = 480 // leaves room for the "[<scope>] " prefix

export interface PromotionReport {
  promoted: string[]
  skipped: string[]
  reasons: Record<string, string>
}

interface ScopeMemory {
  id: string
  content: string
  importance: number
}

const DISTILL_SYSTEM_PROMPT = `You distill a set of developer memories that all come from a single code scope into one dense, reusable pattern note.

Rules:
- Extract the recurring, durable pattern or pitfall that generalizes across the memories.
- Drop one-off details, timestamps, and restating.
- Output a single plain paragraph. No preamble, no headings, no lists, no markdown.
- The output MUST be at most 480 characters.`

function countMemories(db: Database.Database, scopePath: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM memories
       WHERE COALESCE(namespace, project_path) = ?
         AND ${notSupersededClause('memories.id')}`
    )
    .get(scopePath) as { n: number }
  return row.n
}

function loadTopMemories(db: Database.Database, scopePath: string, limit: number): ScopeMemory[] {
  return db
    .prepare(
      `SELECT id, content, importance FROM memories
       WHERE COALESCE(namespace, project_path) = ?
         AND ${notSupersededClause('memories.id')}
       ORDER BY importance DESC, created_at DESC
       LIMIT ?`
    )
    .all(scopePath, limit) as ScopeMemory[]
}

function alreadyPromoted(db: Database.Database, parentPath: string, token: string): boolean {
  const rows = db
    .prepare(
      `SELECT tags FROM memories
       WHERE COALESCE(namespace, project_path) = ? AND type = 'pattern'`
    )
    .all(parentPath) as Array<{ tags: string }>
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.tags)
      if (Array.isArray(parsed) && parsed.some((t) => t === token)) return true
    } catch {
      // Malformed tags JSON: cannot match, so it doesn't dedupe.
    }
  }
  return false
}

function extractiveContent(memories: ScopeMemory[]): string {
  const snippets = memories
    .slice(0, EXTRACTIVE_SNIPPETS)
    .map((m) => m.content.replace(/\s+/g, ' ').trim().slice(0, EXTRACTIVE_SNIPPET_CHARS))
  return snippets.join(' | ')
}

async function distill(
  scopePath: string,
  memories: ScopeMemory[]
): Promise<string> {
  if (isLlmConfigured()) {
    try {
      const input = memories.map((m) => `- ${m.content}`).join('\n')
      const result = await chat(
        [
          { role: 'system', content: DISTILL_SYSTEM_PROMPT },
          { role: 'user', content: `Scope: ${scopePath}\n\nMemories:\n${input}` },
        ],
        { temperature: 0, maxTokens: Math.ceil(PATTERN_MAX_CHARS / 3) }
      )
      const content = result.content.trim().slice(0, PATTERN_MAX_CHARS)
      if (content) return content
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e), scopePath },
        'promotion: LLM distill failed; using extractive fallback'
      )
    }
  }
  return extractiveContent(memories)
}

function ensurePromotionSession(db: Database.Database, parentPath: string): string {
  // Stable synthetic session per parent, so repeated promotions coalesce onto
  // one audit session instead of minting a session per promotion. It is marked
  // ended immediately so getCurrentSession never mistakes it for a live
  // session that would swallow later store_memory calls into the parent.
  const id = `engram-promotion:${parentPath}`
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, project_path, started_at, ended_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(id, parentPath, now, now)
  return id
}

function insertPattern(
  db: Database.Database,
  parentPath: string,
  token: string,
  distilled: string
): string {
  const id = randomUUID()
  const now = Date.now()
  const sessionId = ensurePromotionSession(db, parentPath)
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, importance_source, origin)
     VALUES (?, ?, ?, ?, ?, 'pattern', 0.7, ?, ?, ?, 'default', 'promotion')`
  ).run(id, sessionId, parentPath, parentPath, `[${token}] ${distilled}`, JSON.stringify([token]), now, now)
  return id
}

function linkSources(db: Database.Database, patternId: string, sources: ScopeMemory[]): void {
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at)
     VALUES (?, ?, 0.0, 'promoted_from', ?)`
  )
  for (const source of sources) stmt.run(patternId, source.id, now)
}

/**
 * Promote repeated patterns from the synthetic leaf scopes directly beneath
 * `projectPath` into `projectPath` itself. See the module header for the
 * dedupe and link conventions.
 */
export async function promoteScopePatterns(
  db: Database.Database,
  projectPath: string
): Promise<PromotionReport> {
  const report: PromotionReport = { promoted: [], skipped: [], reasons: {} }
  const leaves = children(db, projectPath).filter((n) => n.is_synthetic)

  for (const leaf of leaves) {
    const parsed = parseNamespacePath(leaf.path)
    const token = parsed.scope
    const parentPath = parsed.parentPath
    if (!token || !parentPath) {
      report.skipped.push(leaf.path)
      report.reasons[leaf.path] = 'unresolvable_scope'
      continue
    }

    const count = countMemories(db, leaf.path)
    if (count < PROMOTE_MIN_MEMORIES) {
      report.skipped.push(token)
      report.reasons[token] = 'below_threshold'
      continue
    }
    if (alreadyPromoted(db, parentPath, token)) {
      report.skipped.push(token)
      report.reasons[token] = 'already_promoted'
      continue
    }

    const memories = loadTopMemories(db, leaf.path, TOP_MEMORIES)
    const distilled = await distill(leaf.path, memories)
    const patternId = insertPattern(db, parentPath, token, distilled)
    linkSources(db, patternId, memories)
    report.promoted.push(token)
  }

  if (report.promoted.length > 0) {
    await refreshNavDigest(db, projectPath)
  }

  return report
}
