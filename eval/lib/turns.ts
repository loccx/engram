// turn granularity: a session is a list of turns, a turn memory is one turn (or a small
// window of adjacent turns), and the served context groups the hits by session, oldest
// first, dated, turns in order, packed to the character budget. this is the assembly
// half; the ingest half lives in the systems that seed turn memories.
import type { CorpusTurn } from './types.js'
import type { RetrievedItem } from './systems.js'

/** one recalled turn memory, in session-local coordinates */
export interface TurnHit {
  sessionRef: string
  /** index of the first turn the hit memory holds */
  turnIndex: number
}

export interface TurnSessionMeta {
  id: string
  createdAt?: number
  turns: CorpusTurn[]
}

export interface AssembleTurnInput {
  hits: TurnHit[]
  sessions: Map<string, TurnSessionMeta>
  budgetChars: number
  /** turns the hit memory itself holds, so its own span is rendered */
  ingestWindow: number
  /** adjacent turns rendered on each side of a hit */
  renderWindow: number
  /**
   * buy every statement turn the hits cover before any assistant reply: a question
   * that aggregates over sessions is answered from what the user stated, and replies
   * are the long turns that otherwise consume the budget
   */
  statementsFirst?: boolean
  /**
   * windows of this many top-ranked hits are bought before the statements, so the
   * question's own best evidence is never crowded out by a cheap statement from a
   * session that only mentions the item
   */
  reserveTopHits?: number
}

/**
 * an aggregation-shaped question asks for a count, a sum or a list assembled from
 * several sessions, so every session that holds an item has to fit in the context
 */
const AGGREGATION_CUE =
  /\b(how many|how much|how often|how long|in total|total|altogether|combined|sum|number of|all the|list)\b/

export function isAggregationQuery(query: string): boolean {
  return AGGREGATION_CUE.test(query.toLowerCase())
}

export interface AssembledTurnContext {
  context: string
  blocks: string[]
  items: RetrievedItem[]
  usedChars: number
  sessionsServed: number
  turnsServed: number
  skippedSessions: number
}

/** explicit turns when the corpus carries them, else a `role: text` line split */
export function turnsOf(session: { text: string; turns?: CorpusTurn[] }): CorpusTurn[] {
  if (session.turns && session.turns.length > 0) return session.turns
  return session.text.split('\n').map((line) => {
    const match = line.match(/^([a-z_]+): (.*)$/)
    return match ? { role: match[1], text: match[2] } : { role: '', text: line }
  })
}

export function turnText(turn: CorpusTurn): string {
  return turn.role === '' ? turn.text : `${turn.role}: ${turn.text}`
}

/** session-local turn memory id: `lme-x-s0-t3` */
export function turnMemoryId(sessionId: string, turnIndex: number): string {
  return `${sessionId}-t${turnIndex}`
}

export function parseTurnMemoryId(id: string): TurnHit | null {
  const match = id.match(/^(.*)-t(\d+)$/)
  if (!match) return null
  return { sessionRef: match[1], turnIndex: Number(match[2]) }
}

/** `2023-04-10 17:50 utc`, from the corpus clock, stable across machines */
export function formatTurnDate(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return 'undated'
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} utc`
  )
}

function formatTurnDay(ms: number | undefined): string {
  return formatTurnDate(ms).split(' ')[0]
}

/** the turn's day, for the ingest tag */
export function turnDayTag(ms: number | undefined): string {
  return formatTurnDay(ms)
}

interface ServedLine extends TurnHit {
  rank: number
}

interface PackedGroups {
  groups: Array<{ sessionRef: string; lines: ServedLine[] }>
  served: ServedLine[]
  skippedSessions: number
}

/** every turn the hits cover: session -> turn index -> best rank that reached it */
function coverageOf(input: AssembleTurnInput): Map<string, Map<number, number>> {
  const covered = new Map<string, Map<number, number>>()
  input.hits.forEach((hit, rank) => {
    const session = input.sessions.get(hit.sessionRef)
    if (!session) return
    if (hit.turnIndex < 0 || hit.turnIndex >= session.turns.length) return
    const from = Math.max(0, hit.turnIndex - input.renderWindow)
    const to = Math.min(
      session.turns.length - 1,
      hit.turnIndex + input.ingestWindow - 1 + input.renderWindow
    )
    const byTurn = covered.get(hit.sessionRef) ?? new Map<number, number>()
    for (let index = from; index <= to; index++) {
      const best = byTurn.get(index)
      if (best === undefined || rank < best) byTurn.set(index, rank)
    }
    covered.set(hit.sessionRef, byTurn)
  })
  return covered
}

function byDateRank(
  input: AssembleTurnInput
): (a: string, b: string) => number {
  return (a, b) => {
    const left = input.sessions.get(a)?.createdAt ?? Number.POSITIVE_INFINITY
    const right = input.sessions.get(b)?.createdAt ?? Number.POSITIVE_INFINITY
    if (left !== right) return left - right
    return a < b ? -1 : 1
  }
}

/** the original allocation: one session at a time, best hit rank first */
function packBySession(
  input: AssembleTurnInput,
  covered: Map<string, Map<number, number>>
): PackedGroups {
  const byDate = byDateRank(input)
  const bestRank = new Map<string, number>()
  for (const [sessionRef, turns] of covered) {
    bestRank.set(sessionRef, Math.min(...turns.values()))
  }
  const selected = [...covered.keys()].sort(
    (a, b) => (bestRank.get(a) ?? 0) - (bestRank.get(b) ?? 0) || byDate(a, b)
  )

  const groups: PackedGroups['groups'] = []
  const served: ServedLine[] = []
  let used = 0
  let skippedSessions = 0
  for (const sessionRef of selected) {
    // the group text is assembled from its lines, so an allocation that skips a turn
    // inside a session still renders what it kept in order
    const session = input.sessions.get(sessionRef)
    if (!session) continue
    const lines = [...(covered.get(sessionRef) ?? new Map<number, number>()).entries()]
      .map(([turnIndex, rank]) => ({ sessionRef, turnIndex, rank }))
      .sort((a, b) => a.turnIndex - b.turnIndex)
    let group = `[${formatTurnDate(session.createdAt)}]`
    const kept: ServedLine[] = []
    for (const line of lines) {
      const next = `${group}\n${turnText(session.turns[line.turnIndex])}`
      const separator = groups.length > 0 ? 2 : 0
      if (used + next.length + separator > input.budgetChars) continue
      group = next
      kept.push(line)
    }
    if (kept.length === 0) {
      skippedSessions++
      continue
    }
    groups.push({ sessionRef, lines: kept })
    served.push(...kept)
    used += group.length + (groups.length > 1 ? 2 : 0)
  }
  return { groups, served, skippedSessions }
}

/**
 * the coverage allocation: statements across every session the hits reached are paid
 * for first, replies only with what the budget has left. a counting question needs
 * one turn per session, not three deep ones
 */
function packStatementsFirst(
  input: AssembleTurnInput,
  covered: Map<string, Map<number, number>>
): PackedGroups {
  interface Attempt extends ServedLine {
    statement: boolean
  }
  const attempts: Attempt[] = []
  for (const [sessionRef, turns] of covered) {
    const session = input.sessions.get(sessionRef)
    if (!session) continue
    for (const [turnIndex, rank] of turns) {
      attempts.push({
        sessionRef,
        turnIndex,
        rank,
        statement: session.turns[turnIndex]?.role === 'user',
      })
    }
  }
  const reserve = Math.max(0, input.reserveTopHits ?? 0)
  attempts.sort(
    (a, b) =>
      Number(b.rank < reserve) - Number(a.rank < reserve) ||
      Number(b.statement) - Number(a.statement) ||
      a.rank - b.rank
  )

  const open = new Map<string, ServedLine[]>()
  const served: ServedLine[] = []
  let used = 0
  for (const attempt of attempts) {
    const session = input.sessions.get(attempt.sessionRef)!
    const current = open.get(attempt.sessionRef)
    const line = turnText(session.turns[attempt.turnIndex])
    const first = current === undefined
    const separator = open.size > 0 && first ? 2 : 0
    const header = first ? formatTurnDate(session.createdAt).length + 2 : 0
    if (used + line.length + 1 + header + separator > input.budgetChars) continue
    if (first) open.set(attempt.sessionRef, [attempt])
    else current.push(attempt)
    used += line.length + 1 + header + separator
    served.push(attempt)
  }

  const byDate = byDateRank(input)
  const groups = [...open.entries()]
    .map(([sessionRef, lines]) => ({
      sessionRef,
      lines: [...lines].sort((a, b) => a.turnIndex - b.turnIndex),
    }))
    .sort((a, b) => byDate(a.sessionRef, b.sessionRef))
  return { groups, served, skippedSessions: covered.size - groups.length }
}

/**
 * hits in, dated session-grouped context out. a hit expands to the turns its memory
 * holds plus `renderWindow` neighbours; sessions enter in hit-rank order so the budget
 * goes to the best hits, and the blocks are presented oldest first for the timeline.
 */
export function assembleTurnContext(input: AssembleTurnInput): AssembledTurnContext {
  const covered = coverageOf(input)
  const packed =
    input.statementsFirst === true
      ? packStatementsFirst(input, covered)
      : packBySession(input, covered)
  // the reader reasons about a timeline, so the selected groups are presented oldest
  // first even though the budget went to the best hits
  const byDate = byDateRank(input)
  const ordered = [...packed.groups].sort((a, b) => byDate(a.sessionRef, b.sessionRef))
  const blocks = ordered.map(
    (group) =>
      `[${formatTurnDate(input.sessions.get(group.sessionRef)?.createdAt)}]\n` +
      group.lines
        .map((line) => turnText(input.sessions.get(line.sessionRef)!.turns[line.turnIndex]))
        .join('\n')
  )
  const context = blocks.join('\n\n')
  const sessionRank = new Map(ordered.map((group, index) => [group.sessionRef, index]))

  const items = [...packed.served]
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (sessionRank.get(a.sessionRef) ?? 0) - (sessionRank.get(b.sessionRef) ?? 0) ||
        a.turnIndex - b.turnIndex
    )
    .map((line) => ({
      text: turnText(input.sessions.get(line.sessionRef)!.turns[line.turnIndex]),
      ref: line.sessionRef,
      id: turnMemoryId(line.sessionRef, line.turnIndex),
      turn: line.turnIndex,
    }))

  return {
    context,
    blocks,
    items,
    usedChars: context.length,
    sessionsServed: blocks.length,
    turnsServed: packed.served.length,
    skippedSessions: packed.skippedSessions,
  }
}
