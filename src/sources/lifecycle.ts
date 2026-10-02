import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { authorizeNamespace, currentCaller, type Verb } from '../memory/access.js'
import { admit, ADMISSION_RULES } from '../memory/admission.js'
import { purgeSourceEvidence, sourcePurgePlan, type SourceAuthority } from './purge.js'
import { advanceSourceGeneration } from './derivation.js'
import {
  SOURCE_PAGE_MAX, SOURCE_PAGE_BYTES_MAX, SourceBindingSchema, SourceConnectionSchema,
  SourcePositionSchema, SourcePageSchema, sourceHash,
  type SourceConnector, type SourcePage, type SourcePosition,
} from './schema.js'

export interface SourceConnection extends SourceAuthority, SourcePosition {
  provider: string
  account_hash: string
  scope_hash: string
  created_at: number
  revoked_at: number | null
}
export interface SourcePageReceipt {
  id: string
  connection_id: string
  from_cursor: string | null
  from_generation: number
  next_cursor: string | null
  page_hash: string
  change_count: number
  state: 'staged' | 'applied'
}
export interface SourceApplyResult {
  page_id: string
  upserted: number
  deleted: number
  skipped: number
  purged_memories: number
  replay: boolean
}

function requireVerb(connection: SourceAuthority, verb: Verb): void {
  const caller = currentCaller()
  const owner = caller.localOwner ? null : caller.principalId
  if ((!caller.localOwner && !owner) || owner !== connection.owner_principal) {
    throw new Error('source connection is not owned by the current caller')
  }
  const denied = authorizeNamespace(caller, connection.namespace, verb)
  if (denied) throw new Error(denied)
}
function connectionFor(db: Database.Database, id: string, verb: Verb, active = true): SourceConnection {
  const connection = db.prepare('SELECT * FROM source_connections WHERE id = ?').get(id) as SourceConnection | undefined
  if (!connection) throw new Error('source connection unavailable')
  requireVerb(connection, verb)
  if (active && connection.revoked_at !== null) throw new Error('source connection revoked')
  return connection
}

// the lifecycle boundary always rejects credential-shaped metadata, including cursors.
// existing generic ingest admission defaults remain unchanged.
function rejectSecrets(db: Database.Database, value: unknown, namespace: string): void {
  for (const rule of ADMISSION_RULES.filter((rule) => rule.alwaysReject)) {
    const verdict = rule.check({ content: JSON.stringify(value), namespace, type: 'note', tags: [] }, { db, now: Date.now(), agent: true })
    if (verdict.action === 'reject') throw new Error(`source content rejected: ${rule.name}`)
  }
}
function validatePage(db: Database.Database, connection: SourceConnection, value: unknown, limit: number): SourcePage {
  if (!Number.isInteger(limit) || limit < 1 || limit > SOURCE_PAGE_MAX) throw new Error('invalid source page limit')
  // bound serialized input before validation or hashing. Connector output is untrusted.
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > SOURCE_PAGE_BYTES_MAX) throw new Error('source page too large')
  const page = SourcePageSchema.parse(value)
  if (page.changes.length > limit) throw new Error('connector exceeded requested page limit')
  rejectSecrets(db, page, connection.namespace)
  for (const change of page.changes) {
    if (change.kind !== 'upsert') continue
    const decision = admit({ content: change.content, namespace: connection.namespace, type: 'note', tags: [] },
      { db, now: Date.now(), agent: true }, 'enforce')
    if (!decision.allowed) throw new Error(`source content rejected: ${decision.rule}`)
  }
  return page
}
function checkPosition(connection: SourceConnection, position: SourcePosition): void {
  if (connection.cursor !== position.cursor || connection.generation !== position.generation) throw new Error('source cursor conflict')
}
function validateCursorTransition(position: SourcePosition, page: SourcePage): void {
  if (page.next_cursor === position.cursor && page.changes.length > 0) throw new Error('nonempty source page must advance its cursor')
  if (position.cursor !== null && page.next_cursor === null) throw new Error('source cursor reset requires explicit rebootstrap')
}
function pageHash(connectionId: string, position: SourcePosition, page: SourcePage): string {
  return sourceHash({ schema: 'source-page-v1', connection_id: connectionId, position, page })
}
function event(db: Database.Database, connectionId: string, kind: string, externalId: string | null, now: number): void {
  db.prepare('INSERT INTO source_events(connection_id, kind, external_id, created_at) VALUES (?, ?, ?, ?)')
    .run(connectionId, kind, externalId, now)
}

/** host library only. The connector authority is never accepted from an agent page. */
export function createSourceConnection(db: Database.Database, connector: SourceConnector, input: unknown): SourceConnection {
  const binding = SourceBindingSchema.parse({ provider: connector.provider, account_hash: connector.account_hash, scope_hash: connector.scope_hash })
  const { namespace } = SourceConnectionSchema.parse(input)
  const caller = currentCaller()
  const owner = caller.localOwner ? null : caller.principalId
  requireVerb({ id: '', namespace, owner_principal: owner }, 'write')
  rejectSecrets(db, { ...binding, namespace }, namespace)
  return db.transaction(() => {
    const existing = db.prepare(`SELECT * FROM source_connections WHERE namespace = ? AND owner_principal IS ? AND provider = ? AND account_hash = ? AND scope_hash = ?`)
      .get(namespace, owner, binding.provider, binding.account_hash, binding.scope_hash) as SourceConnection | undefined
    if (existing) {
      if (existing.revoked_at !== null) throw new Error('source connection revoked; binding cannot be silently recreated')
      return existing
    }
    const id = randomUUID()
    db.prepare(`INSERT INTO source_connections(id, namespace, owner_principal, provider, account_hash, scope_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, namespace, owner, binding.provider, binding.account_hash, binding.scope_hash, Date.now())
    return connectionFor(db, id, 'write')
  }).immediate()
}

export function getSourceConnection(db: Database.Database, id: string): SourceConnection {
  return connectionFor(db, id, 'read', false)
}

/** persist only hashes. A crashed host re-presents the same validated page to resume. */
export function stageSourcePage(
  db: Database.Database, connectionId: string, expected: unknown, value: unknown, limit = 100
): SourcePageReceipt {
  const position = SourcePositionSchema.parse(expected)
  const connection = connectionFor(db, connectionId, 'write')
  rejectSecrets(db, position, connection.namespace)
  const page = validatePage(db, connection, value, limit)
  validateCursorTransition(position, page)
  if (page.changes.some((change) => change.kind === 'delete')) requireVerb(connection, 'delete')
  const hash = pageHash(connectionId, position, page)
  const id = sourceHash({ connectionId, hash })
  return db.transaction(() => {
    const current = connectionFor(db, connectionId, 'write')
    const receipt = db.prepare('SELECT * FROM source_pages WHERE id = ?').get(id) as SourcePageReceipt | undefined
    if (receipt) return receipt
    checkPosition(current, position)
    db.prepare(`INSERT INTO source_pages(id, connection_id, from_cursor, from_generation, next_cursor, page_hash, change_count, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, connectionId, position.cursor, position.generation, page.next_cursor, hash, page.changes.length, Date.now())
    return db.prepare('SELECT * FROM source_pages WHERE id = ?').get(id) as SourcePageReceipt
  }).immediate()
}

function accountForgetIdentity(connection: SourceConnection, externalId: string): Record<string, unknown> {
  return { namespace: connection.namespace, owner_principal: connection.owner_principal,
    provider: connection.provider, account_hash: connection.account_hash, external_id: externalId }
}
function isAccountForgotten(db: Database.Database, connection: SourceConnection, externalId: string): boolean {
  return db.prepare('SELECT 1 FROM source_forget_barriers WHERE id = ?')
    .get(sourceHash(accountForgetIdentity(connection, externalId))) !== undefined
}
function accountConnections(db: Database.Database, connection: SourceConnection): SourceConnection[] {
  return db.prepare(`SELECT * FROM source_connections WHERE namespace = ? AND owner_principal IS ?
    AND provider = ? AND account_hash = ?`).all(connection.namespace, connection.owner_principal,
      connection.provider, connection.account_hash) as SourceConnection[]
}
function episodesOfItem(db: Database.Database, connectionId: string, externalId: string): string[] {
  return (db.prepare('SELECT episode_id FROM source_revisions WHERE connection_id = ? AND external_id = ?')
    .all(connectionId, externalId) as Array<{ episode_id: string }>).map((row) => row.episode_id)
}
function tombstoneItem(db: Database.Database, connection: SourceConnection, externalId: string, reason: 'deleted' | 'forgotten', now: number): number {
  if (!db.prepare('SELECT 1 FROM source_tombstones WHERE connection_id = ? AND external_id = ? AND reason = ?')
    .get(connection.id, externalId, reason)) {
    db.prepare('INSERT INTO source_tombstones(connection_id, external_id, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(connection.id, externalId, reason, now)
    event(db, connection.id, reason, externalId, now)
  }
  if (!db.prepare('SELECT 1 FROM source_items WHERE connection_id = ? AND external_id = ?').get(connection.id, externalId)) {
    db.prepare('INSERT INTO source_items(connection_id, external_id) VALUES (?, ?)').run(connection.id, externalId)
  }
  db.prepare('UPDATE source_items SET current_revision_id = NULL WHERE connection_id = ? AND external_id = ?').run(connection.id, externalId)
  return purgeSourceEvidence(db, connection, episodesOfItem(db, connection.id, externalId), true, now)
}

/** materialization, purges, journal acknowledgement and cursor CAS are one synchronous transaction. */
export function applySourcePage(db: Database.Database, receiptId: string, value: unknown): SourceApplyResult {
  return db.transaction(() => {
    const receipt = db.prepare('SELECT * FROM source_pages WHERE id = ?').get(receiptId) as (SourcePageReceipt & { result_json: string | null }) | undefined
    if (!receipt) throw new Error('source page unavailable')
    const connection = connectionFor(db, receipt.connection_id, 'write')
    const page = validatePage(db, connection, value, SOURCE_PAGE_MAX)
    const position = { cursor: receipt.from_cursor, generation: receipt.from_generation }
    validateCursorTransition(position, page)
    if (receipt.page_hash !== pageHash(connection.id, position, page)) throw new Error('source page replay hash conflict')
    requireVerb(connection, 'write')
    if (page.changes.some((change) => change.kind === 'delete')) requireVerb(connection, 'delete')
    if (receipt.state === 'applied') return { ...JSON.parse(receipt.result_json!), replay: true } as SourceApplyResult
    checkPosition(connection, position)
    const now = Date.now()
    const result: SourceApplyResult = { page_id: receipt.id, upserted: 0, deleted: 0, skipped: 0, purged_memories: 0, replay: false }
    for (const change of page.changes) {
      if (change.kind === 'delete') {
        result.purged_memories += tombstoneItem(db, connection, change.external_id, 'deleted', now)
        result.deleted++
        continue
      }
      // this barrier is identity-wide, not revision-wide. A newer revision cannot
      // silently undo a user forget, upstream deletion, or connection revocation.
      if (db.prepare('SELECT 1 FROM source_tombstones WHERE connection_id = ? AND external_id = ?')
        .get(connection.id, change.external_id) || isAccountForgotten(db, connection, change.external_id)) { result.skipped++; continue }
      const contentHash = sourceHash({ schema: 'source-content-v1', content: change.content, occurred_at: change.occurred_at ?? null })
      const known = db.prepare('SELECT id, content_hash FROM source_revisions WHERE connection_id = ? AND external_id = ? AND revision = ?')
        .get(connection.id, change.external_id, change.revision) as { id: string; content_hash: string } | undefined
      if (known) {
        if (known.content_hash !== contentHash) throw new Error('immutable source revision conflict')
        result.skipped++ // a seen revision never becomes current again
        continue
      }
      const previous = db.prepare('SELECT current_revision_id FROM source_items WHERE connection_id = ? AND external_id = ?')
        .get(connection.id, change.external_id) as { current_revision_id: string | null } | undefined
      if (previous?.current_revision_id) {
        requireVerb(connection, 'delete')
        const previousRow = db.prepare('SELECT episode_id FROM source_revisions WHERE id = ?').get(previous.current_revision_id) as { episode_id: string }
        result.purged_memories += purgeSourceEvidence(db, connection, [previousRow.episode_id], false, now)
        event(db, connection.id, 'replaced', change.external_id, now)
      }
      const revisionId = sourceHash({ schema: 'source-revision-v1', connection_id: connection.id, external_id: change.external_id, revision: change.revision })
      const episodeId = `source:${revisionId}`
      db.prepare(`INSERT INTO source_revisions(id, connection_id, external_id, revision, content_hash, episode_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(revisionId, connection.id, change.external_id, change.revision, contentHash, episodeId, now)
      db.prepare(`INSERT INTO episodes(id, namespace, session_id, source, source_instance, source_version, external_id,
        occurred_at, ingested_at, content, provenance_json, owner_principal, source_revision_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(episodeId, connection.namespace, `source:${connection.id}:${sourceHash(change.external_id)}`, `connector:${connection.provider}`,
          connection.id, change.revision, revisionId, change.occurred_at ?? null, now, change.content,
          JSON.stringify({ connection_id: connection.id, external_id: change.external_id, revision: change.revision, content_hash: contentHash }),
          connection.owner_principal, revisionId)
      if (!previous) {
        db.prepare('INSERT INTO source_items(connection_id, external_id, current_revision_id) VALUES (?, ?, ?)')
          .run(connection.id, change.external_id, revisionId)
      } else {
        db.prepare('UPDATE source_items SET current_revision_id = ? WHERE connection_id = ? AND external_id = ?')
          .run(revisionId, connection.id, change.external_id)
      }
      result.upserted++
    }
    if (page.changes.length > 0) advanceSourceGeneration(db)
    const advanced = db.prepare(`UPDATE source_connections SET cursor = ?, generation = generation + 1
      WHERE id = ? AND cursor IS ? AND generation = ? AND revoked_at IS NULL`)
      .run(receipt.next_cursor, connection.id, position.cursor, position.generation)
    if (advanced.changes !== 1) throw new Error('source cursor conflict')
    db.prepare("UPDATE source_pages SET state = 'applied', applied_at = ?, result_json = ? WHERE id = ? AND state = 'staged'")
      .run(now, JSON.stringify(result), receipt.id)
    return result
  }).immediate()
}

/** recheck host authority after the asynchronous connector returns, not just before it. */
export async function syncSourcePage(db: Database.Database, connectionId: string, connector: SourceConnector, limit = 100): Promise<SourceApplyResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > SOURCE_PAGE_MAX) throw new Error('invalid source page limit')
  const connection = connectionFor(db, connectionId, 'write')
  const binding = SourceBindingSchema.parse({ provider: connector.provider, account_hash: connector.account_hash, scope_hash: connector.scope_hash })
  if (binding.provider !== connection.provider || binding.account_hash !== connection.account_hash || binding.scope_hash !== connection.scope_hash) throw new Error('connector authority binding mismatch')
  const value = await connector.changes(connection.cursor, limit)
  const returnedBinding = SourceBindingSchema.parse({ provider: connector.provider, account_hash: connector.account_hash, scope_hash: connector.scope_hash })
  if (returnedBinding.provider !== connection.provider || returnedBinding.account_hash !== connection.account_hash || returnedBinding.scope_hash !== connection.scope_hash) throw new Error('connector authority binding changed during fetch')
  const receipt = stageSourcePage(db, connectionId, { cursor: connection.cursor, generation: connection.generation }, value, limit)
  return applySourcePage(db, receipt.id, value)
}

/** permanent first-slice revocation; reconnect requires an explicit future recovery policy. */
export function revokeSourceConnection(db: Database.Database, connectionId: string): number {
  return db.transaction(() => {
    const connection = connectionFor(db, connectionId, 'delete', false)
    const now = Date.now()
    if (connection.revoked_at === null) {
      db.prepare('UPDATE source_connections SET revoked_at = ?, generation = generation + 1 WHERE id = ?').run(now, connection.id)
      event(db, connection.id, 'revoked', null, now)
    }
    const episodes = (db.prepare('SELECT episode_id FROM source_revisions WHERE connection_id = ?').all(connection.id) as Array<{ episode_id: string }>).map((row) => row.episode_id)
    db.prepare('UPDATE source_items SET current_revision_id = NULL WHERE connection_id = ?').run(connection.id)
    const purged = purgeSourceEvidence(db, connection, episodes, true, now)
    advanceSourceGeneration(db)
    return purged
  }).immediate()
}

// the source-aware delete preview accounts for identity-wide revision removal and
// all citation links that disappear with legitimately derived canonical claims.
export function previewSourceForget(db: Database.Database, episodeIds: string[]): {
  episodeIds: Set<string>; memoryIds: Set<string>
} {
  const episodes = new Set<string>()
  const memories = new Set<string>()
  const seen = new Set<string>()
  for (const id of episodeIds) {
    const item = db.prepare('SELECT connection_id, external_id FROM source_revisions WHERE episode_id = ?').get(id) as
      { connection_id: string; external_id: string } | undefined
    if (!item) continue
    const key = sourceHash(item)
    if (seen.has(key)) continue
    seen.add(key)
    const connection = connectionFor(db, item.connection_id, 'delete', false)
    for (const related of accountConnections(db, connection)) {
      requireVerb(related, 'delete')
      const plan = sourcePurgePlan(db, related, episodesOfItem(db, related.id, item.external_id))
      for (const row of plan.episodeRows) episodes.add(row.id)
      for (const memory of plan.memoryIds) memories.add(memory)
    }
  }
  return { episodeIds: episodes, memoryIds: memories }
}

/** call inside the host's forget/delete transaction BEFORE it removes provenance links. */
export function forgetSourceEpisodes(db: Database.Database, episodeIds: string[]): number {
  return db.transaction(() => {
    const items = new Map<string, { connection_id: string; external_id: string }>()
    for (const id of episodeIds) {
      const item = db.prepare('SELECT connection_id, external_id FROM source_revisions WHERE episode_id = ?').get(id) as
        { connection_id: string; external_id: string } | undefined
      if (item) items.set(sourceHash(item), item)
    }
    // authorize everything first: a mixed-owner request never partially forgets.
    const authorized = [...items.values()].map((item) => ({ item, connection: connectionFor(db, item.connection_id, 'delete', false) }))
    let purged = 0
    const barriers = new Set<string>()
    for (const { item, connection } of authorized) {
      const barrierId = sourceHash(accountForgetIdentity(connection, item.external_id))
      if (barriers.has(barrierId)) continue
      barriers.add(barrierId)
      const now = Date.now()
      if (!isAccountForgotten(db, connection, item.external_id)) {
        db.prepare(`INSERT INTO source_forget_barriers(id, namespace, owner_principal, provider, account_hash, external_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(barrierId, connection.namespace, connection.owner_principal,
            connection.provider, connection.account_hash, item.external_id, now)
      }
      for (const related of accountConnections(db, connection)) {
        requireVerb(related, 'delete')
        purged += tombstoneItem(db, related, item.external_id, 'forgotten', now)
      }
    }
    if (barriers.size > 0) advanceSourceGeneration(db)
    return purged
  }).immediate()
}

/** includes same-owner/scope predecessors when the current manual revision lost citations. */
export function forgetSourcesForMemory(db: Database.Database, memoryId: string): number {
  return db.transaction(() => {
    const memory = db.prepare('SELECT COALESCE(namespace, project_path) AS namespace, owner_principal FROM memories WHERE id = ?').get(memoryId) as
      { namespace: string; owner_principal: string | null } | undefined
    if (!memory) return 0
    const episodeIds = db.prepare(`WITH RECURSIVE chain(id) AS (
      SELECT id FROM memories WHERE id = ? UNION
      SELECT ml.target_id FROM chain c JOIN memory_links ml ON ml.source_id = c.id JOIN memories m ON m.id = ml.target_id
      WHERE ml.link_type = 'supersedes' AND ml.revision > 0
        AND COALESCE(m.namespace, m.project_path) = ? AND m.owner_principal IS ?
    ) SELECT DISTINCT me.episode_id FROM chain c JOIN memory_episodes me ON me.memory_id = c.id
      JOIN source_revisions sr ON sr.episode_id = me.episode_id
      JOIN episodes e ON e.id = me.episode_id WHERE e.namespace = ? AND e.owner_principal IS ?`)
      .all(memoryId, memory.namespace, memory.owner_principal, memory.namespace, memory.owner_principal) as Array<{ episode_id: string }>
    return forgetSourceEpisodes(db, episodeIds.map((row) => row.episode_id))
  }).immediate()
}
