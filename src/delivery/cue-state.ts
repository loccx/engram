import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/** session-scoped dedupe for injected cues; best effort, since a missing or unreadable
 *  file only means nothing is known to be seen yet */

const MAX_SEEN = 200

/** a host can report one compaction as a pair of boundaries, so a window stays open this
 *  long for the second boundary of that pair to join it */
export const WINDOW_COALESCE_MS = 30_000

/** what was shown inside one context, and which context it was */
interface CueState {
  seen: string[]
  /** bumped every time the host rebuilds the model's context */
  generation: number
  /** when that generation was opened, in epoch milliseconds */
  generationAt: number
  /** the boundary kinds this window has already absorbed, which is how a pair of
   *  notifications for one rebuild is told apart from a second rebuild */
  boundaries: string[]
}

/** the window a boundary just opened: `fresh` is false when it joined an open one */
export interface CueWindow {
  generation: number
  fresh: boolean
}

export function cueStatePath(sessionId: string, tmp: string = tmpdir()): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '') || 'default'
  return join(tmp, 'engram-cue-state', `${safe}.json`)
}

/** a file written before generations existed reads as generation zero with nothing seen
 *  in it, which is exactly how an absent file reads */
function readState(path: string): CueState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      seen?: unknown
      generation?: unknown
      generation_at?: unknown
      boundaries?: unknown
    }
    return {
      seen: Array.isArray(parsed.seen)
        ? parsed.seen.filter((v): v is string => typeof v === 'string')
        : [],
      generation: typeof parsed.generation === 'number' && Number.isFinite(parsed.generation) ? parsed.generation : 0,
      generationAt:
        typeof parsed.generation_at === 'number' && Number.isFinite(parsed.generation_at)
          ? parsed.generation_at
          : 0,
      boundaries: Array.isArray(parsed.boundaries)
        ? parsed.boundaries.filter((v): v is string => typeof v === 'string')
        : [],
    }
  } catch {
    return { seen: [], generation: 0, generationAt: 0, boundaries: [] }
  }
}

function writeState(path: string, state: CueState): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        seen: state.seen.slice(-MAX_SEEN),
        generation: state.generation,
        generation_at: state.generationAt,
        boundaries: state.boundaries,
      })
    )
  } catch {
    // state is an optimisation; losing it re-injects a memory, never breaks a hook
  }
}

export function readSeen(path: string): string[] {
  return readState(path).seen
}

export function forgetSeen(path: string, ids: string[]): string[] {
  const seen = new Set(readSeen(path))
  return ids.filter((id) => !seen.has(id))
}

export function markSeen(path: string, ids: string[]): void {
  if (ids.length === 0) return
  const state = readState(path)
  for (const id of ids) if (!state.seen.includes(id)) state.seen.push(id)
  writeState(path, state)
}

/** start the window the next cues are delivered in. a boundary of a kind this window has
 *  already absorbed is a second rebuild and opens a new window, while the other kind of
 *  the pair joins the open one instead of clearing what it just delivered */
export function beginWindow(
  path: string,
  kind: string,
  now: number = Date.now(),
  coalesceMs: number = WINDOW_COALESCE_MS
): CueWindow {
  const state = readState(path)
  const elapsed = now - state.generationAt
  const joinsPair =
    state.generationAt > 0 &&
    state.boundaries.length > 0 &&
    !state.boundaries.includes(kind) &&
    elapsed >= 0 &&
    elapsed < coalesceMs
  if (joinsPair) {
    writeState(path, { ...state, boundaries: [...state.boundaries, kind] })
    return { generation: state.generation, fresh: false }
  }
  const generation = state.generation + 1
  writeState(path, { seen: [], generation, generationAt: now, boundaries: [kind] })
  return { generation, fresh: true }
}
