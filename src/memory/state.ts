// state heads: the current value of a slot (subject+attribute, or a caller key), derived
// from the supersession links the write paths already maintain. nothing here is cached:
// a materialised head would have to be repaired by every writer that touches
// memory_links (store.revise, the adjudicator, reversal), and a stale head serves a
// superseded value, which is the failure this module exists to remove.
import type Database from 'better-sqlite3'
import { SUPERSEDES_FILTER_THRESHOLD } from '../contradictions/supersession.js'
import type { MemoryRow } from './row.js'
import type { MemoryType, StateEntry, StateSlot, StateView, GetStateOptions } from './types.js'

export const STATE_KEY_MAX_CHARS = 200
export const CHAIN_KEY_PREFIX = 'chain:'
export const STATE_SLOT_LIMIT_MAX = 100
/** chain walks are bounded: a corrupted link cycle must not hang a read */
const MAX_CHAIN_NODES = 128
export const STATE_PROMPT_VERSION = 'state-key-v1'

/** trim, collapse whitespace, lowercase: the same fact named two ways has to land in one slot */
export function normalizeStateKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const collapsed = raw.trim().replace(/\s+/g, ' ').toLowerCase()
  if (collapsed.length === 0 || collapsed.length > STATE_KEY_MAX_CHARS) return null
  return collapsed
}

interface Retiring {
  at: number
  by: string
  reason: string | null
}

interface SlotMembers {
  rows: MemoryRow[]
  retiring: Map<string, Retiring>
  keyed: Set<string>
}

function chainIds(db: Database.Database, seedIds: string[], asOf?: number): string[] {
  const stmt = db.prepare(
    `SELECT source_id, target_id, COALESCE(judged_at, created_at) AS at
     FROM memory_links
     WHERE link_type = 'supersedes' AND (source_id = ? OR target_id = ?)`
  )
  const visited = new Set<string>()
  const frontier = [...seedIds]
  while (frontier.length > 0 && visited.size < MAX_CHAIN_NODES) {
    const current = frontier.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    const edges = stmt.all(current, current) as Array<{
      source_id: string
      target_id: string
      at: number
    }>
    for (const edge of edges) {
      // an edge judged after asOf did not exist yet
      if (asOf !== undefined && edge.at > asOf) continue
      const other = edge.source_id === current ? edge.target_id : edge.source_id
      if (!visited.has(other)) frontier.push(other)
    }
  }
  return [...visited]
}

function loadRows(db: Database.Database, ids: string[]): MemoryRow[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return db
    .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
    .all(...ids) as MemoryRow[]
}

/** the threshold-filtered link that retires each id, earliest verdict wins */
function loadRetiring(db: Database.Database, ids: string[], asOf?: number): Map<string, Retiring> {
  const out = new Map<string, Retiring>()
  if (ids.length === 0) return out
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT target_id, source_id, COALESCE(judged_at, created_at) AS at, reason
       FROM memory_links
       WHERE link_type = 'supersedes' AND confidence >= ? AND target_id IN (${placeholders})
         ${asOf === undefined ? '' : 'AND COALESCE(judged_at, created_at) <= ?'}
       ORDER BY at ASC`
    )
    .all(SUPERSEDES_FILTER_THRESHOLD, ...ids, ...(asOf === undefined ? [] : [asOf])) as Array<{
    target_id: string
    source_id: string
    at: number
    reason: string | null
  }>
  for (const row of rows) {
    if (out.has(row.target_id)) continue
    out.set(row.target_id, { at: row.at, by: row.source_id, reason: row.reason })
  }
  return out
}

/** the chain a key reaches, plus every id in it whether or not it carries the key */
export function slotMembers(
  db: Database.Database,
  namespace: string,
  key: string,
  asOf?: number
): SlotMembers | null {
  const keyedRows = db
    .prepare(
      `SELECT id FROM memories WHERE COALESCE(namespace, project_path) = ? AND state_key = ?`
    )
    .all(namespace, key) as Array<{ id: string }>
  if (keyedRows.length === 0) return null
  const keyed = new Set(keyedRows.map((r) => r.id))
  const ids = chainIds(db, [...keyed], asOf)
  return { rows: loadRows(db, ids), retiring: loadRetiring(db, ids, asOf), keyed }
}

function entryOf(row: MemoryRow, retiring: Map<string, Retiring>, keyed: Set<string>, ref: number): StateEntry {
  const retires = retiring.get(row.id) ?? null
  const validFrom = row.valid_from ?? row.created_at
  const validUntil = row.valid_until ?? null
  const archived = row.archived_at != null
  return {
    memory_id: row.id,
    content: row.content,
    type: row.type as MemoryType,
    valid_from: validFrom,
    valid_until: validUntil,
    superseded_at: retires?.at ?? null,
    superseded_by: retires?.by ?? null,
    reason: retires?.reason ?? null,
    archived,
    keyed: keyed.has(row.id),
    current:
      retires === null && !archived && validFrom <= ref && (validUntil === null || validUntil >= ref),
  }
}

/** oldest first along the chain, not by timestamp: two writes in the same millisecond still order */
function orderTrajectory(entries: StateEntry[], retiring: Map<string, Retiring>): StateEntry[] {
  const byId = new Map(entries.map((entry) => [entry.memory_id, entry]))
  const successor = new Map<string, string>()
  const replaced = new Set<string>()
  for (const [targetId, link] of retiring) {
    if (!byId.has(targetId) || !byId.has(link.by)) continue
    successor.set(targetId, link.by)
    replaced.add(link.by)
  }
  const remaining = [...entries].sort(
    (a, b) => a.valid_from - b.valid_from || a.memory_id.localeCompare(b.memory_id)
  )
  const start = remaining.find((entry) => !replaced.has(entry.memory_id))
  const ordered: StateEntry[] = []
  const seen = new Set<string>()
  let current = start
  while (current && !seen.has(current.memory_id)) {
    ordered.push(current)
    seen.add(current.memory_id)
    const nextId = successor.get(current.memory_id)
    current = nextId ? byId.get(nextId) : undefined
  }
  for (const entry of remaining) {
    if (!seen.has(entry.memory_id)) ordered.push(entry)
  }
  return ordered
}

function buildSlot(
  db: Database.Database,
  namespace: string,
  key: string,
  options: { ref: number; asOf?: number; trajectory: boolean }
): StateSlot | null {
  const members = slotMembers(db, namespace, key, options.asOf)
  if (!members) return null
  const valid = members.rows
    .map((row) => entryOf(row, members.retiring, members.keyed, options.ref))
    .filter((entry) => entry.valid_from <= options.ref)
  if (valid.length === 0) return null
  const trajectory = orderTrajectory(valid, members.retiring)

  let currentIdx = -1
  for (let i = trajectory.length - 1; i >= 0; i--) {
    if (trajectory[i].current) {
      currentIdx = i
      break
    }
  }
  const priorIdx = currentIdx >= 0 ? currentIdx - 1 : trajectory.length - 1

  const slot: StateSlot = {
    key,
    namespace,
    current: currentIdx >= 0 ? trajectory[currentIdx] : null,
    prior: priorIdx >= 0 ? trajectory[priorIdx] : null,
    versions: trajectory.length,
  }
  if (options.trajectory) slot.trajectory = trajectory
  return slot
}

/** keys in use in a namespace, most recently updated first */
function slotKeys(db: Database.Database, namespace: string, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT state_key AS key
       FROM memories
       WHERE COALESCE(namespace, project_path) = ? AND state_key IS NOT NULL AND state_key != ''
       GROUP BY state_key
       ORDER BY MAX(COALESCE(valid_from, created_at)) DESC, state_key ASC
       LIMIT ?`
    )
    .all(namespace, limit) as Array<{ key: string }>
  return rows.map((r) => r.key)
}

export function getState(db: Database.Database, options: GetStateOptions): StateView {
  const now = options.now ?? Date.now()
  const ref = options.as_of ?? now
  const limit = Math.min(Math.max(options.limit ?? 20, 1), STATE_SLOT_LIMIT_MAX)
  const keys =
    options.key !== undefined ? [options.key] : slotKeys(db, options.namespace, limit)
  const slots: StateSlot[] = []
  for (const key of keys) {
    const slot = buildSlot(db, options.namespace, key, {
      ref,
      asOf: options.as_of,
      trajectory: options.include_superseded === true,
    })
    if (slot) slots.push(slot)
  }
  return {
    namespace: options.namespace,
    as_of: options.as_of ?? null,
    key: options.key ?? null,
    slots,
  }
}

/** the values true at `ref`, for the current-state section of a read */
export function currentState(
  db: Database.Database,
  namespace: string,
  options: { limit?: number; now?: number; asOf?: number } = {}
): StateSlot[] {
  return getState(db, {
    namespace,
    limit: options.limit ?? 5,
    now: options.now,
    as_of: options.asOf,
  }).slots.filter((slot) => slot.current !== null)
}

export interface StateAdvanceResult {
  /** the row the new value retired, null when the slot had no live head */
  superseded_id: string | null
}

/**
 * point the slot at `memoryId`: close the head it replaces and write the supersedes
 * link, so every existing read filter prefers the new value with no new code path.
 */
export function advanceStateHead(
  db: Database.Database,
  options: { namespace: string; key: string; memoryId: string; now?: number; reason?: string }
): StateAdvanceResult {
  const now = options.now ?? Date.now()
  const members = slotMembers(db, options.namespace, options.key)
  if (!members) return { superseded_id: null }
  const live = members.rows
    .filter((row) => row.id !== options.memoryId)
    .map((row) => entryOf(row, members.retiring, members.keyed, now))
    .filter((entry) => entry.current)
    .sort((a, b) => b.valid_from - a.valid_from || a.memory_id.localeCompare(b.memory_id))
  const previous = live[0]
  if (!previous) return { superseded_id: null }

  const tx = db.transaction(() => {
    db.prepare('UPDATE memories SET valid_until = COALESCE(valid_until, ?) WHERE id = ?').run(
      now,
      previous.memory_id
    )
    db.prepare(
      `INSERT OR IGNORE INTO memory_links
         (source_id, target_id, similarity, link_type, created_at, confidence, reason,
          decider_model, prompt_version, judged_at)
       VALUES (?, ?, 1.0, 'supersedes', ?, 1.0, ?, 'state-key', ?, ?)`
    ).run(
      options.memoryId,
      previous.memory_id,
      now,
      options.reason ?? 'state key update',
      STATE_PROMPT_VERSION,
      now
    )
  })
  tx.immediate()
  return { superseded_id: previous.memory_id }
}

export interface ChainBackfillResult {
  chains: number
  rows: number
}

/**
 * name the chains that predate explicit keys: one connected component of supersedes
 * links is one slot, so `chain:<oldest row>` is a key derived from existing data and
 * nothing is invented. a component that already carries a key keeps it.
 */
export function backfillChainKeys(db: Database.Database): ChainBackfillResult {
  const edges = db
    .prepare(
      `SELECT ml.source_id AS source_id, ml.target_id AS target_id,
              s.created_at AS source_created, s.state_key AS source_key,
              t.created_at AS target_created, t.state_key AS target_key
       FROM memory_links ml
       JOIN memories s ON s.id = ml.source_id
       JOIN memories t ON t.id = ml.target_id
       WHERE ml.link_type = 'supersedes'`
    )
    .all() as Array<{
    source_id: string
    target_id: string
    source_created: number
    source_key: string | null
    target_created: number
    target_key: string | null
  }>
  if (edges.length === 0) return { chains: 0, rows: 0 }

  const parent = new Map<string, string>()
  const created = new Map<string, number>()
  const keyOf = new Map<string, string | null>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    let walk = id
    while (parent.get(walk) !== root) {
      const next = parent.get(walk)!
      parent.set(walk, root)
      walk = next
    }
    return root
  }
  const register = (id: string, at: number, key: string | null): void => {
    if (parent.has(id)) return
    parent.set(id, id)
    created.set(id, at)
    keyOf.set(id, key)
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }

  for (const edge of edges) {
    register(edge.source_id, edge.source_created, edge.source_key)
    register(edge.target_id, edge.target_created, edge.target_key)
    union(edge.source_id, edge.target_id)
  }

  const groups = new Map<string, string[]>()
  for (const id of parent.keys()) {
    const root = find(id)
    const list = groups.get(root) ?? []
    list.push(id)
    groups.set(root, list)
  }

  const update = db.prepare('UPDATE memories SET state_key = ? WHERE id = ? AND state_key IS NULL')
  let chains = 0
  let rows = 0
  for (const members of groups.values()) {
    if (members.length < 2) continue
    if (members.some((id) => keyOf.get(id) != null)) continue
    const oldest = members.reduce((best, id) => {
      const bestAt = created.get(best)!
      const at = created.get(id)!
      if (at < bestAt) return id
      if (at > bestAt) return best
      return id < best ? id : best
    })
    const key = `${CHAIN_KEY_PREFIX}${oldest}`
    for (const id of members) {
      rows += update.run(key, id).changes
    }
    chains++
  }
  return { chains, rows }
}
