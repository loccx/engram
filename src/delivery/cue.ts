import { basename } from 'node:path'
import type Database from 'better-sqlite3'
import type { MemoryType } from '../memory/types.js'
import { entitySearch } from '../memory/search/entity.js'
import { identSearch } from '../memory/search/lexical.js'

/**
 * cue-anchored recall: what the store already knows about the file a tool is about to
 * touch, matched by the identifier index (path mentions in prose) and the entity index
 * (file_path entities), trimmed to the types worth interrupting an edit for.
 */

const CUE_TYPES: MemoryType[] = ['gotcha', 'bug', 'decision', 'pattern']

export interface CueHit {
  id: string
  type: MemoryType
  content: string
  tags: string[]
  matched: string
}

/**
 * most specific identifier first: absolute path, then the path relative to the
 * namespace, then the basename. a phrase query over the absolute path alone would miss
 * `src/delivery/hook.ts`, whose namespace prefix is not in the memory.
 */
export function cueIdentifiers(filePath: string, namespace: string): string[] {
  const full = filePath.trim()
  if (!full) return []
  const prefix = namespace.replace(/\/+$/, '')
  const candidates = [full]
  if (prefix && full.startsWith(`${prefix}/`)) candidates.push(full.slice(prefix.length + 1))
  candidates.push(basename(full))
  return [...new Set(candidates.filter(Boolean))]
}

export function cueHits(
  db: Database.Database,
  namespace: string,
  filePath: string,
  limit = 3
): CueHit[] {
  const options = { namespace_subtree: namespace }
  const perQuery = Math.max(limit * 4, 12)
  const hits = new Map<string, CueHit>()

  for (const identifier of cueIdentifiers(filePath, namespace)) {
    for (const memory of [
      ...identSearch(db, identifier, options, perQuery),
      ...entitySearch(db, identifier, options, perQuery),
    ]) {
      if (!CUE_TYPES.includes(memory.type)) continue
      if (memory.archived_at != null) continue
      if (!hits.has(memory.id)) {
        hits.set(memory.id, {
          id: memory.id,
          type: memory.type,
          content: memory.content,
          tags: memory.tags,
          matched: identifier,
        })
      }
      if (hits.size >= limit) return [...hits.values()]
    }
  }

  return [...hits.values()]
}
