import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { chat, isLlmConfigured } from '../llm/client.js'
import { logger } from '../utils/logger.js'

export const DEFAULT_DIGEST_BUDGET_CHARS = 2000

export interface RefreshDigestOptions {
  budgetChars?: number
}

export interface RefreshDigestResult {
  content: string
  changed: boolean
}

interface PinnedRow {
  id: string
  content: string
  type: string
}

interface DigestRow {
  content: string
  source_hash: string | null
}

const SYSTEM_PROMPT = `You condense a developer's pinned project facts into a dense markdown digest that is injected into every session's context.

Rules:
- Preserve every concrete fact: names, paths, versions, commands, decisions, constraints.
- Drop filler, hedging, restatements, and narrative framing.
- Merge overlapping facts into a single line.
- Output markdown bullets only. No preamble, no headings, no closing commentary.
- The output MUST be shorter than the character budget you are given.`

export function getDigest(db: Database.Database, namespace: string): string {
  const row = db
    .prepare('SELECT content FROM project_digests WHERE namespace = ?')
    .get(namespace) as { content: string } | undefined
  return row?.content ?? ''
}

export async function refreshDigest(
  db: Database.Database,
  namespace: string,
  opts: RefreshDigestOptions = {}
): Promise<RefreshDigestResult> {
  let cached = ''
  try {
    const budget = opts.budgetChars ?? budgetFromEnv()
    const existing = db
      .prepare('SELECT content, source_hash FROM project_digests WHERE namespace = ?')
      .get(namespace) as DigestRow | undefined
    cached = existing?.content ?? ''

    const pinned = db
      .prepare(
        `SELECT id, content, type FROM memories
         WHERE COALESCE(namespace, project_path) = ? AND pinned = 1
         ORDER BY created_at ASC, id ASC`
      )
      .all(namespace) as PinnedRow[]

    const hash = hashPinned(pinned)
    if (existing && existing.source_hash === hash) {
      return { content: cached, changed: false }
    }

    const lines = pinned.map((p) => `- [${p.type}] ${p.content}`)
    const candidate = lines.join('\n')

    let content: string
    if (candidate.length <= budget) {
      content = candidate
    } else if (isLlmConfigured()) {
      content = await consolidate(candidate, budget)
    } else {
      content = truncateWithMarker(lines, budget)
    }

    db.prepare(
      `INSERT INTO project_digests (namespace, content, source_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace) DO UPDATE SET
         content = excluded.content,
         source_hash = excluded.source_hash,
         updated_at = excluded.updated_at`
    ).run(namespace, content, hash, Math.floor(Date.now() / 1000))

    return { content, changed: content !== cached }
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), namespace },
      'digest: refresh failed; serving previous digest'
    )
    return { content: cached, changed: false }
  }
}

function budgetFromEnv(): number {
  return parseIntSafe(process.env.ENGRAM_DIGEST_BUDGET_CHARS, DEFAULT_DIGEST_BUDGET_CHARS)
}

function parseIntSafe(input: string | undefined, fallback: number): number {
  if (!input) return fallback
  const n = parseInt(input, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function hashPinned(rows: PinnedRow[]): string {
  const h = createHash('sha256')
  for (const r of rows) {
    h.update(r.id)
    h.update('\0')
    h.update(r.content)
    h.update('\0')
  }
  return h.digest('hex')
}

async function consolidate(candidate: string, budget: number): Promise<string> {
  const result = await chat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Character budget: ${budget}.\n\nPinned facts:\n${candidate}`,
      },
    ],
    { temperature: 0, maxTokens: Math.ceil(budget / 3) }
  )
  return result.content.trim().slice(0, budget)
}

function truncateWithMarker(lines: string[], budget: number): string {
  const marker = (n: number): string =>
    `\n…(${n} more pinned, set ENGRAM_LLM_BASE_URL to auto-consolidate)`
  const reserve = marker(lines.length).length

  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = kept.length === 0 ? line.length : line.length + 1
    if (used + cost + reserve > budget) break
    kept.push(line)
    used += cost
  }

  return (kept.join('\n') + marker(lines.length - kept.length)).slice(0, budget)
}
