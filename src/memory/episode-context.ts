// episode context: the assembly the turn-granularity experiment settled on, moved
// into the engine. retrieved episodes arrive in hit-rank order, expand to the turns
// they hold plus a neighbour window on each side, group by session, and each group is
// dated. the budget goes to the best hits first (so a weak tail cannot crowd out the
// top), while the groups are presented oldest first: the reader reasons about a
// timeline, and the order it is handed is part of the recipe. every served line keeps
// its provenance (episode id, session, turn, date).
import type Database from 'better-sqlite3'
import {
  orderAllocation,
  packAllocation,
  type AllocationPolicyName,
  type AllocationUnit,
} from './allocation.js'
import { episodeNamespaceFilter, type Episode, type EpisodeNamespaceScope, type EpisodeRow } from './episodes.js'
import { searchEpisodes, type EpisodeHit } from './search/episodes.js'

export type { Episode, EpisodeHit }

export interface ServedTurn {
  episodeId: string
  content: string
  occurredAt: number | null
  /** author role as stored; a role-aware policy reads it, a role-agnostic one ignores it */
  role: string | null
}

export interface EpisodeSessionTurns {
  sessionId: string
  /** the session's own date: its earliest turn */
  occurredAt: number | null
  /** ordered as served; a hit addresses one by its episode id */
  turns: ServedTurn[]
}

export interface EpisodeHitRef {
  episodeId: string
  sessionId: string
}

export interface AssembleEpisodeInput {
  hits: EpisodeHitRef[]
  sessions: Map<string, EpisodeSessionTurns>
  budgetChars: number
  /** turns the hit itself holds, rendered from its own position */
  ingestWindow: number
  /** adjacent turns rendered on each side of a hit */
  renderWindow: number
  /** which turns the budget buys; the shipped order is rank-greedy */
  allocation?: AllocationPolicyName
  /** top-ranked hit windows bought before the rest */
  reserveTopHits?: number
}

export interface EpisodeContextLine {
  episode_id: string
  session_id: string
  /** position inside the session, as served */
  turn_index: number
  occurred_at: number | null
  date: string
  content: string
  /** the group this line was served in */
  block: number
  /** the hit rank that selected it */
  rank: number
}

export interface AssembledEpisodeContext {
  context: string
  blocks: string[]
  lines: EpisodeContextLine[]
  usedChars: number
  sessionsServed: number
  turnsServed: number
  skippedSessions: number
}

/** `2023-04-10 17:50 utc`, from the episode clock */
export function formatEpisodeDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'undated'
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} utc`
  )
}

/**
 * hits in, dated session-grouped context out. a hit expands to the turns its window
 * holds; the allocation policy decides which of those turns the budget buys, and the
 * served blocks are ordered oldest first.
 */
export function assembleEpisodeContext(input: AssembleEpisodeInput): AssembledEpisodeContext {
  const positions = new Map<string, Map<string, number>>()
  for (const [sessionId, session] of input.sessions) {
    positions.set(sessionId, new Map(session.turns.map((turn, index) => [turn.episodeId, index])))
  }

  const covered = new Map<string, Map<number, number>>()
  input.hits.forEach((hit, rank) => {
    const session = input.sessions.get(hit.sessionId)
    if (!session) return
    const position = positions.get(hit.sessionId)?.get(hit.episodeId)
    if (position === undefined) return
    const from = Math.max(0, position - input.renderWindow)
    const to = Math.min(
      session.turns.length - 1,
      position + input.ingestWindow - 1 + input.renderWindow
    )
    const byTurn = covered.get(hit.sessionId) ?? new Map<number, number>()
    for (let index = from; index <= to; index++) {
      const best = byTurn.get(index)
      if (best === undefined || rank < best) byTurn.set(index, rank)
    }
    covered.set(hit.sessionId, byTurn)
  })

  interface ServedLine {
    sessionId: string
    position: number
    rank: number
  }
  const byDate = (a: string, b: string): number => {
    const left = input.sessions.get(a)?.occurredAt ?? Number.POSITIVE_INFINITY
    const right = input.sessions.get(b)?.occurredAt ?? Number.POSITIVE_INFINITY
    if (left !== right) return left - right
    return a < b ? -1 : 1
  }
  const headerOf = (sessionId: string): string =>
    `[${formatEpisodeDate(input.sessions.get(sessionId)?.occurredAt)}]`

  const units: AllocationUnit[] = []
  for (const [sessionId, turns] of covered) {
    const session = input.sessions.get(sessionId)
    if (!session) continue
    for (const [position, rank] of turns) {
      const turn = session.turns[position]
      units.push({
        sessionId,
        position,
        rank,
        chars: turn.content.length,
        role: turn.role,
      })
    }
  }
  const packed = packAllocation({
    units: orderAllocation(input.allocation, units, {
      reserveTopHits: input.reserveTopHits ?? 0,
      sessionOrder: byDate,
    }),
    headerOf,
    budgetChars: input.budgetChars,
  })

  const groups = packed.groups.map((group) => ({
    sessionId: group.sessionId,
    text: [
      headerOf(group.sessionId),
      ...group.units
        .sort((a, b) => a.position - b.position)
        .map((unit) => input.sessions.get(unit.sessionId)!.turns[unit.position].content),
    ].join('\n'),
    lines: group.units.map((unit) => ({
      sessionId: unit.sessionId,
      position: unit.position,
      rank: unit.rank,
    })),
  }))
  const served: ServedLine[] = packed.kept.map((unit) => ({
    sessionId: unit.sessionId,
    position: unit.position,
    rank: unit.rank,
  }))
  const skippedSessions = packed.skippedSessions

  groups.sort((a, b) => byDate(a.sessionId, b.sessionId))
  const blocks = groups.map((group) => group.text)
  const context = blocks.join('\n\n')
  const blockOf = new Map(groups.map((group, index) => [group.sessionId, index]))

  const lines: EpisodeContextLine[] = [...served]
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (blockOf.get(a.sessionId) ?? 0) - (blockOf.get(b.sessionId) ?? 0) ||
        a.position - b.position
    )
    .map((line) => {
      const session = input.sessions.get(line.sessionId)!
      const turn = session.turns[line.position]
      return {
        episode_id: turn.episodeId,
        session_id: line.sessionId,
        turn_index: line.position,
        occurred_at: turn.occurredAt,
        date: formatEpisodeDate(turn.occurredAt ?? session.occurredAt),
        content: turn.content,
        block: blockOf.get(line.sessionId) ?? 0,
        rank: line.rank,
      }
    })

  return {
    context,
    blocks,
    lines,
    usedChars: context.length,
    sessionsServed: blocks.length,
    turnsServed: served.length,
    skippedSessions,
  }
}

/** one query per batch of hit sessions; the IN list stays bounded by the candidate cap */
function loadSessions(
  db: Database.Database,
  sessionIds: string[],
  scope: EpisodeNamespaceScope,
  now: number,
  includeExpired: boolean
): Map<string, EpisodeSessionTurns> {
  const sessions = new Map<string, EpisodeSessionTurns>()
  if (sessionIds.length === 0) return sessions
  const placeholders = sessionIds.map(() => '?').join(', ')
  const filter = episodeNamespaceFilter(scope, 'e')
  const conditions = [`e.session_id IN (${placeholders})`]
  const params: unknown[] = [...sessionIds]
  if (filter.sql) {
    conditions.push(filter.sql)
    params.push(...filter.params)
  }
  if (!includeExpired) {
    conditions.push('(e.expires_at IS NULL OR e.expires_at > ?)')
    params.push(now)
  }
  // a session without turn indices (a chunk layer) falls back to its own clock
  const rows = db
    .prepare(
      `SELECT e.* FROM episodes e
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.session_id ASC, COALESCE(e.turn_index, 2147483647) ASC,
                e.occurred_at ASC, e.id ASC`
    )
    .all(...params) as EpisodeRow[]
  for (const row of rows) {
    const session = sessions.get(row.session_id) ?? {
      sessionId: row.session_id,
      occurredAt: null,
      turns: [],
    }
    if (row.occurred_at !== null) {
      session.occurredAt =
        session.occurredAt === null ? row.occurred_at : Math.min(session.occurredAt, row.occurred_at)
    }
    session.turns.push({
      episodeId: row.id,
      content: row.content,
      occurredAt: row.occurred_at,
      role: row.role ?? null,
    })
    sessions.set(row.session_id, session)
  }
  return sessions
}

export interface RetrieveEpisodeContextInput extends EpisodeNamespaceScope {
  db: Database.Database
  query: string
  /** content characters only */
  budget_chars: number
  /** episodes the ranker may return */
  candidates?: number
  /** turns a hit holds, rendered from its own position */
  ingest_window?: number
  /** adjacent turns rendered on each side of a hit */
  render_window?: number
  /** fixed clock, for a deterministic recency prior and expiry */
  now?: number
  vectorsAvailable?: boolean
  include_expired?: boolean
  /** which turns the budget buys; the shipped order is rank-greedy */
  allocation?: AllocationPolicyName
  /** top-ranked hit windows bought before the rest */
  reserve_top_hits?: number
}

export interface EpisodeContextResult extends AssembledEpisodeContext {
  query: string
  hits: EpisodeHit[]
  retrievalMs: number
  degraded: string[]
  note: string
}

export const EPISODE_CANDIDATES = 100
export const EPISODE_RENDER_WINDOW = 1

/**
 * the evidence read: rank episodes (lexical + vector, namespace-scoped), pull the
 * turns of the sessions they belong to, and assemble the dated timeline under the
 * character budget. this is what an evidence section or an eval system calls.
 */
export async function retrieveEpisodeContext(
  input: RetrieveEpisodeContextInput
): Promise<EpisodeContextResult> {
  const startedAt = Date.now()
  const now = input.now ?? startedAt
  const candidates = input.candidates ?? EPISODE_CANDIDATES
  const ingestWindow = Math.max(1, input.ingest_window ?? 1)
  const renderWindow = input.render_window ?? EPISODE_RENDER_WINDOW
  const scope: EpisodeNamespaceScope = {
    namespace: input.namespace,
    namespace_subtree: input.namespace_subtree,
    exclude_namespace: input.exclude_namespace,
    caller: input.caller,
    // evidence assembly is always current; raw history is a separate explicit read.
    include_source_history: false,
  }

  const found = await searchEpisodes(input.db, input.vectorsAvailable === true, input.query, {
    ...scope,
    limit: candidates,
    now,
    include_expired: input.include_expired,
  })
  const sessionIds = [...new Set(found.hits.map((hit) => hit.episode.session_id))]
  const sessions = loadSessions(
    input.db,
    sessionIds,
    scope,
    now,
    input.include_expired === true
  )
  // search may have buffered lexical hits before an async embedding/host await.
  // return only hits still present in the freshly authorized/current session rows.
  const liveIds = new Set([...sessions.values()].flatMap((session) => session.turns.map((turn) => turn.episodeId)))
  const currentHits = found.hits.filter((hit) => liveIds.has(hit.episode.id))
  const hits: EpisodeHitRef[] = currentHits.map((hit) => ({
    episodeId: hit.episode.id,
    sessionId: hit.episode.session_id,
  }))
  const assembled = assembleEpisodeContext({
    hits,
    sessions,
    budgetChars: input.budget_chars,
    ingestWindow,
    renderWindow,
    ...(input.allocation !== undefined ? { allocation: input.allocation } : {}),
    ...(input.reserve_top_hits !== undefined ? { reserveTopHits: input.reserve_top_hits } : {}),
  })
  return {
    ...assembled,
    query: input.query,
    hits: currentHits,
    retrievalMs: Date.now() - startedAt,
    degraded: found.degraded,
    note:
      `hits=${assembled.turnsServed}, sessions=${assembled.sessionsServed}, ` +
      `skipped=${assembled.skippedSessions}, used=${assembled.usedChars}/${input.budget_chars} chars`,
  }
}
