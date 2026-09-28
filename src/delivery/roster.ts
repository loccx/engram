import type Database from 'better-sqlite3'
import type { Memory } from '../memory/types.js'
import { getContext, prepareContextStatements } from '../memory/search/context.js'

/**
 * session-start roster: the present-state context a no-query get_context returns,
 * clipped to a preview and a budget so it cannot crowd out the first turn
 */

const DEFAULT_LIMIT = 8
const DEFAULT_PREVIEW_CHARS = 200
const DEFAULT_BUDGET_CHARS = 900

export interface RosterHit {
  id: string
  type: Memory['type']
  importance: number
  pinned: boolean
  preview: string
}

export interface RosterOptions {
  limit?: number
  previewChars?: number
  budgetChars?: number
}

export function rosterHits(
  db: Database.Database,
  namespace: string,
  options: RosterOptions = {}
): RosterHit[] {
  const limit = options.limit ?? DEFAULT_LIMIT
  const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS
  const budgetChars = options.budgetChars ?? DEFAULT_BUDGET_CHARS

  const memories = getContext(db, prepareContextStatements(db), namespace, limit)
  const hits: RosterHit[] = []
  let used = 0

  for (const memory of memories) {
    const preview = clip(memory.content, previewChars)
    if (hits.length > 0 && used + preview.length > budgetChars) break
    used += preview.length
    hits.push({
      id: memory.id,
      type: memory.type,
      importance: memory.importance,
      pinned: memory.pinned === true,
      preview,
    })
  }

  return hits
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
