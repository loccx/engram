// the access boundary: what a request is allowed to read and write. the namespace a
// caller names is not the boundary — the credential is — so the resolved namespace is
// checked against the caller's grants and a namespace argument can only narrow.
//
// the caller travels in async local storage rather than through every signature, so a
// query that builds a scope clause inherits the visibility predicate wherever it is
// called from. the default when nothing set a caller is the local owner, which is the
// single-user install: background workers and a database with no principals read as the
// machine's own writes always did.
import { AsyncLocalStorage } from 'node:async_hooks'
import type Database from 'better-sqlite3'

export type Verb = 'read' | 'write' | 'share' | 'delete'

export const VERBS: Verb[] = ['read', 'write', 'share', 'delete']

export interface Grant {
  prefix: string
  verbs: Verb[]
}

export interface CallerScope {
  /** the principal row this request is served as; null is the local owner */
  principalId: string | null
  name: string
  /** the local owner has every verb on '/'; a named principal has only its grants */
  localOwner: boolean
  grants: Grant[]
}

export const LOCAL_OWNER: CallerScope = {
  principalId: null,
  name: 'local-owner',
  localOwner: true,
  grants: [],
}

export function localOwnerScope(): CallerScope {
  return LOCAL_OWNER
}

interface RequestScope {
  caller: CallerScope
  /** the tool being served, so a resolved namespace can be authorized for its verb */
  tool: string
}

const storage = new AsyncLocalStorage<RequestScope>()

export function currentCaller(): CallerScope {
  return storage.getStore()?.caller ?? LOCAL_OWNER
}

/** empty outside a tool call, which the authorization step treats as store-wide */
export function currentTool(): string {
  return storage.getStore()?.tool ?? ''
}

export function withRequest<T>(caller: CallerScope | undefined, tool: string, fn: () => T): T {
  return storage.run({ caller: caller ?? LOCAL_OWNER, tool }, fn)
}

export function withCaller<T>(caller: CallerScope | undefined, fn: () => T): T {
  return withRequest(caller, '', fn)
}

/** a grant prefix covers the path itself and everything under it; '/' covers all */
export function prefixCovers(prefix: string, namespace: string): boolean {
  const p = prefix.replace(/\/+$/, '')
  if (p === '') return true
  const ns = namespace.replace(/\/+$/, '')
  return ns === p || ns.startsWith(`${p}/`)
}

export function grantedPrefixes(caller: CallerScope, verb: Verb): string[] {
  if (caller.localOwner) return ['/']
  return caller.grants.filter((grant) => grant.verbs.includes(verb)).map((grant) => grant.prefix)
}

export function holdsVerb(caller: CallerScope, namespace: string, verb: Verb): boolean {
  if (caller.localOwner) return true
  return caller.grants.some(
    (grant) => grant.verbs.includes(verb) && prefixCovers(grant.prefix, namespace)
  )
}

/** the sql counterpart of holdsVerb for reads; query scope is intersected separately. */
export function readGrantClause(
  namespaceExpr: string,
  caller: CallerScope = currentCaller()
): { sql: string; params: unknown[] } {
  if (caller.localOwner) return { sql: '', params: [] }
  const prefixes = [...new Set(grantedPrefixes(caller, 'read').map((p) => p.replace(/\/+$/, '')))]
  if (prefixes.includes('')) return { sql: '', params: [] }
  if (prefixes.length === 0) return { sql: '0', params: [] }
  const params: unknown[] = []
  const clauses = prefixes.map((prefix) => {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&')
    params.push(prefix, `${escaped}/%`, `${prefix}/`)
    return `(${namespaceExpr} = ? OR (${namespaceExpr} LIKE ? ESCAPE '\\' AND instr(${namespaceExpr}, ?) = 1))`
  })
  return { sql: `(${clauses.join(' OR ')})`, params }
}

// the refusal names only the namespace the caller supplied, never the rows behind it, so
// it cannot be probed for data
export function authorizeNamespace(
  caller: CallerScope,
  namespace: string,
  verb: Verb
): string | null {
  if (holdsVerb(caller, namespace, verb)) return null
  return `namespace ${namespace} is not covered by this credential for "${verb}"`
}

/**
 * the funnel ascends ancestors of the resolved namespace; those above the deepest grant
 * are dropped, so a narrow grant never exposes a parent's digest or roster
 */
export function coveredAncestors(caller: CallerScope, ancestors: string[]): string[] {
  if (caller.localOwner) return ancestors
  return ancestors.filter((path) =>
    caller.grants.some((grant) => grant.verbs.includes('read') && prefixCovers(grant.prefix, path))
  )
}

// visibility as the one predicate every channel appends next to its namespace clause: a
// personal row belongs to its owner, anything else in a readable namespace is shared, and
// a null visibility (what every row before principals carries) is not personal. a null
// owner is the local owner's row.
//
// the rule in sql is `visibility is null or visibility <> 'personal' or owner is caller`,
// which is what rowVisible mirrors for a row already in hand.
export function visibilityClause(
  alias: string,
  caller: CallerScope = currentCaller()
): { sql: string; params: unknown[] } {
  const col = alias === '' ? '' : `${alias}.`
  // `IS ?` rather than `= ?` or `IS NULL`: one clause shape, one bound parameter, and
  // bind(null) matches the null owner, so a prepared statement can stay prepared
  return {
    sql: `(${col}visibility IS NULL OR ${col}visibility <> 'personal' OR ${col}owner_principal IS ?)`,
    params: [caller.localOwner ? null : caller.principalId],
  }
}

/** the same rule for a row already in hand, for the by-id tools */
export function rowVisible(
  row: { owner_principal?: string | null; visibility?: string | null },
  caller: CallerScope = currentCaller()
): boolean {
  const visibility = row.visibility ?? null
  if (visibility === null || visibility !== 'personal') return true
  const owner = row.owner_principal ?? null
  return caller.localOwner ? owner === null : owner === caller.principalId
}

export function visibilityOf(
  caller: CallerScope,
  requested: unknown
): 'personal' | 'project' | 'team' | 'org' | null {
  const value = typeof requested === 'string' ? requested.trim() : ''
  if (value === 'personal' || value === 'project' || value === 'team' || value === 'org') {
    return value
  }
  // a named principal's writes are private unless it asks otherwise; the local owner's
  // stay null, which is what a single-user database has always stored
  return caller.localOwner ? null : 'personal'
}

// derived artifacts (digest, cluster and topic summaries, nav lines) merge many rows:
// until they carry the ids behind them, they are served only to a caller that owns every
// row in the namespace, and withheld otherwise
export function derivedOwners(
  db: Database.Database,
  namespace: string
): Array<string | null> {
  const rows = db
    .prepare(
      `SELECT DISTINCT owner_principal AS owner FROM memories
       WHERE COALESCE(namespace, project_path) = ?`
    )
    .all(namespace) as Array<{ owner: string | null }>
  return rows.map((row) => row.owner ?? null)
}

export function derivedVisible(
  db: Database.Database,
  namespace: string,
  caller: CallerScope = currentCaller()
): boolean {
  return holdsVerb(caller, namespace, 'read') && derivedOwners(db, namespace).every((owner) =>
    caller.localOwner ? owner === null : owner === caller.principalId
  )
}

/** what get_context and the delivery surfaces report instead of a withheld section */
export const WITHHELD_DIGEST = 'digest:withheld:not-owned-by-caller'
export const WITHHELD_TOPICS = 'topics:withheld:not-owned-by-caller'
export const WITHHELD_GUIDE = 'guide:withheld:not-owned-by-caller'

/** the ownership facts of one memory, for a by-id check that has only an id in hand */
export interface MemoryAccessRow {
  id: string
  namespace: string
  owner_principal: string | null
  visibility: string | null
}

export function memoryAccess(
  db: Database.Database,
  id: string
): MemoryAccessRow | null {
  const row = db
    .prepare(
      `SELECT id, COALESCE(namespace, project_path) AS namespace, owner_principal, visibility
       FROM memories WHERE id = ?`
    )
    .get(id) as MemoryAccessRow | undefined
  return row ?? null
}

/**
 * one row per read that returned rows belonging to someone else. counts and ids only:
 * the audit says what was read, never what it said.
 */
export function auditCrossOwnerRead(
  db: Database.Database,
  input: {
    tool: string
    namespace: string
    ids: string[]
    channel?: string
    caller?: CallerScope
  }
): void {
  const caller = input.caller ?? currentCaller()
  const callerId = caller.principalId
  const unique = [...new Set(input.ids.filter((id) => typeof id === 'string' && id !== ''))]
  if (unique.length === 0) return
  const placeholders = unique.map(() => '?').join(',')
  let foreign: string[]
  try {
    const rows = db
      .prepare(`SELECT id, owner_principal FROM memories WHERE id IN (${placeholders})`)
      .all(...unique) as Array<{ id: string; owner_principal: string | null }>
    foreign = rows.filter((row) => (row.owner_principal ?? null) !== callerId).map((row) => row.id)
  } catch {
    return
  }
  if (foreign.length === 0) return
  try {
    db.prepare(
      `INSERT INTO read_audit (ts, principal_id, namespace, tool, ids_json, channel)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      Date.now(),
      callerId,
      input.namespace,
      input.tool,
      JSON.stringify(foreign),
      input.channel ?? input.tool
    )
  } catch {
    // an audit failure never fails a read; the row is the record, not the control
  }
}

/**
 * 'owner' marks a store-wide action no grant can cover: only the local owner runs it.
 * every advertised tool has an entry, and an unknown one falls closed to 'owner'.
 */
export type ToolAccess = Verb | 'owner'

const TOOL_VERBS: Record<string, ToolAccess> = {
  store_memory: 'write',
  ingest_episodes: 'write',
  update_memory: 'write',
  revise_memory: 'write',
  set_pin: 'write',
  end_session: 'write',
  task_get: 'read',
  task_start: 'write',
  task_update: 'write',
  task_close: 'write',
  task_handoff: 'write',
  forget_memory: 'delete',
  delete_episodes: 'delete',
  unarchive_memory: 'write',
  mark_shareable: 'share',
  search_memories: 'read',
  get_context: 'read',
  search_by_entity: 'read',
  get_related: 'read',
  get_memory: 'read',
  get_memory_history: 'read',
  get_state: 'read',
  query_assertions: 'read',
  list_memories: 'read',
  list_sessions: 'read',
  recall_context: 'read',
  assemble_context: 'read',
  session_start: 'read',
  consolidate_memories: 'read',
  get_stats: 'read',
  get_maintenance_status: 'owner',
  run_pending_maintenance: 'owner',
  list_brains: 'owner',
  search_brain: 'owner',
  get_brain_memory: 'owner',
}

export function toolAccess(name: string): ToolAccess {
  return TOOL_VERBS[name] ?? 'owner'
}
