import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/** session-scoped dedupe for injected cues; best effort, since a missing or unreadable
 *  file only means nothing is known to be seen yet */

const MAX_SEEN = 200

export function cueStatePath(sessionId: string, tmp: string = tmpdir()): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '') || 'default'
  return join(tmp, 'engram-cue-state', `${safe}.json`)
}

export function readSeen(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { seen?: unknown }
    return Array.isArray(parsed.seen) ? parsed.seen.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function forgetSeen(path: string, ids: string[]): string[] {
  const seen = new Set(readSeen(path))
  return ids.filter((id) => !seen.has(id))
}

export function markSeen(path: string, ids: string[]): void {
  if (ids.length === 0) return
  const seen = readSeen(path)
  for (const id of ids) if (!seen.includes(id)) seen.push(id)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ seen: seen.slice(-MAX_SEEN) }))
  } catch {
    // state is an optimisation; losing it re-injects a memory, never breaks a hook
  }
}
