import type Database from 'better-sqlite3'
import { SUPERSEDES_FILTER_THRESHOLD } from '../../contradictions/supersession.js'
import { holdsVerb, VERBS, visibilityClause } from '../../memory/access.js'
import type { CallerScope, Verb } from '../../memory/access.js'
import { canonicalJson, normalizeSnapshot, sha256, snapshotProjection } from '../policy.js'
import type { BridgeRequester, SourceEvidence, SourceLocator, SourcePort, SourceReadResult, SourceRef } from '../types.js'

export const ENGRAM_SOURCE_PROVIDER = 'engram'
const EPISODE_PROVIDER = 'engram:episode'
const EXCERPT_LIMIT = 512

export interface EngramSourceOptions {
  /** already authenticated by the trusted host; never supplied by bridge request arguments. */
  readonly caller: CallerScope
  readonly now?: () => number
}

interface MemoryProjectionRow {
  content: string
  type: string
  tags: string
  created_at: number
  valid_from: number | null
  valid_until: number | null
  archived_at: number | null
  state_key: string | null
  origin: string | null
  owner_principal: string | null
  visibility: string | null
  shareable: number
}
interface EpisodeProjectionRow {
  id: string
  uri: string | null
  excerpt: string
  span_start: number | null
  span_end: number | null
  owner_principal: string | null
  visibility: string
  expires_at: number | null
  retention: string
}

function boundCaller(caller: CallerScope): CallerScope {
  if (!caller || typeof caller.localOwner !== 'boolean'
    || (caller.localOwner ? caller.principalId !== null : typeof caller.principalId !== 'string' || !caller.principalId.trim())
    || !Array.isArray(caller.grants)) throw new TypeError('explicit trusted CallerScope required')
  const grants = caller.grants.map((grant) => {
    if (!grant || typeof grant.prefix !== 'string' || !grant.prefix.startsWith('/') || !Array.isArray(grant.verbs)
      || grant.verbs.some((verb) => !VERBS.includes(verb))) throw new TypeError('invalid CallerScope grant')
    const copy = { prefix: grant.prefix, verbs: [...grant.verbs] }
    Object.freeze(copy.verbs)
    return Object.freeze(copy)
  })
  Object.freeze(grants)
  return Object.freeze({ principalId: caller.principalId, name: caller.name, localOwner: caller.localOwner, grants })
}

/**
 * read-only concrete-memory source. construction is a trusted host boundary, not authentication
 * or human approval. the explicit local owner maps to `engram:local-owner`; named identities map
 * to `engram:principal:<JSON string id>`, never their mutable/display name.
 */
/**
 * no ambient caller, credential client, token table, raw store/history getter, cold restore
 * or read audit is used.
 */
/**
 * both the original caller and current active principal grants must cover read AND share. a row
 * must also be visible and explicitly shareable. these are source eligibility, not bridge approval:
 * the coordinator's default-deny authority is unchanged.
 */
/**
 * credential/session revocation remains the host's responsibility; this port refreshes safe
 * principal/grant metadata on every read.
 */
/**
 * resolveCurrent addresses exactly namespace + memory id, NOT a state key/chain head. archived,
 * expired, future or superseded ids are refused. any qualifying incoming supersedes edge retires
 * the authorized id conservatively, without reading or following its possibly foreign successor.
 */
/**
 * revisions are content-addressed over curated text/tags, selected lifecycle/ownership/type/state
 * metadata and represented evidence. access counts, embeddings, pin/importance and unrelated
 * history are not represented.
 */
/**
 * evidence is only same-namespace visible, unexpired episode metadata and a bounded linked excerpt;
 * URI is inert metadata, never fetched. hidden/missing evidence is omitted; removal or change of
 * evidence represented in a snapshot therefore changes the revision.
 */
/** restoring an identical projection restores its revision; this is not a monotonic event counter. */
export class EngramSourcePort implements SourcePort {
  readonly provider = ENGRAM_SOURCE_PROVIDER
  readonly requester: BridgeRequester
  private readonly caller: CallerScope
  private readonly now: () => number

  constructor(private readonly db: Database.Database, options: EngramSourceOptions) {
    this.caller = boundCaller(options?.caller)
    this.now = options.now ?? Date.now
    this.requester = Object.freeze({ principalId: this.caller.localOwner ? 'engram:local-owner'
      : `engram:principal:${JSON.stringify(this.caller.principalId)}` })
  }

  async resolveCurrent(locator: SourceLocator): Promise<SourceReadResult> { return this.read(locator) }
  async readExact(ref: SourceRef): Promise<SourceReadResult> {
    if (!ref || typeof ref.revision !== 'string' || !ref.revision.trim()) return { status: 'forbidden' }
    return this.read(ref, ref.revision)
  }

  private currentScope(): CallerScope | null {
    if (this.caller.localOwner) return this.caller
    // deliberately no principal_tokens lookup or credential retrieval/issuance.
    const principal = this.db.prepare('SELECT id FROM principals WHERE id = ? AND disabled_at IS NULL')
      .get(this.caller.principalId) as { id: string } | undefined
    if (!principal) return null
    const grants = this.db.prepare('SELECT namespace_prefix, verbs FROM grants WHERE principal_id = ?')
      .all(principal.id) as Array<{ namespace_prefix: string; verbs: string }>
    return { principalId: principal.id, name: this.caller.name, localOwner: false,
      grants: grants.filter((grant) => grant.namespace_prefix.startsWith('/')).map((grant) => ({ prefix: grant.namespace_prefix,
        verbs: grant.verbs.split(',').map((verb) => verb.trim()).filter((verb): verb is Verb => VERBS.includes(verb as Verb)) })) }
  }

  private read(locator: SourceLocator, expectedRevision?: string): SourceReadResult {
    // routing and authorization failures are refused before resource/content lookup.
    if (!locator || locator.provider !== this.provider || typeof locator.namespace !== 'string'
      || !locator.namespace.startsWith('/') || typeof locator.sourceId !== 'string' || !locator.sourceId.trim()) return { status: 'forbidden' }
    try {
      return this.db.transaction((): SourceReadResult => {
        const caller = this.currentScope()
        if (!caller || ![this.caller, caller].every((scope) => holdsVerb(scope, locator.namespace, 'read')
          && holdsVerb(scope, locator.namespace, 'share'))) return { status: 'forbidden' }
        const visible = visibilityClause('m', caller)
        const address = `m.id = ? AND COALESCE(m.namespace, m.project_path) = ? AND ${visible.sql}`
        const params = [locator.sourceId, locator.namespace, ...visible.params]
        // missing, wrong-namespace and invisible rows are indistinguishable, even if retired.
        const access = this.db.prepare(`SELECT m.id, m.shareable FROM memories m WHERE ${address}`)
          .get(...params) as { id: string; shareable: number } | undefined
        if (!access) return { status: 'not_found' }
        if (access.shareable !== 1) return { status: 'forbidden' }
        const now = this.now()
        if (!Number.isSafeInteger(now) || now < 0) return { status: 'degraded' }
        const row = this.db.prepare(`SELECT m.content, m.type, m.tags, m.created_at, m.valid_from, m.valid_until,
          m.archived_at, m.state_key, m.origin, m.owner_principal, m.visibility, m.shareable
          FROM memories m WHERE ${address}`).get(...params) as MemoryProjectionRow
        const retired = this.db.prepare(`SELECT 1 FROM memory_links WHERE target_id = ?
          AND link_type = 'supersedes' AND confidence >= ? LIMIT 1`).get(access.id, SUPERSEDES_FILTER_THRESHOLD)
        if (row.archived_at !== null || (row.valid_until !== null && now >= row.valid_until)
          || now < (row.valid_from ?? row.created_at) || retired) return { status: 'retired' }
        const tags: unknown = JSON.parse(row.tags)
        if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) return { status: 'degraded' }
        const provenance = this.evidence(locator, caller, now)
        const projection = { ref: { provider: this.provider, namespace: locator.namespace, sourceId: access.id, revision: 'revision-input/v1' },
          content: row.content, contentType: 'text/plain', tags: tags as string[], provenance }
        // a fixed sentinel excludes the final revision from its own preimage. capture time and
        // derived hashes are absent too; normalizeSnapshot separately verifies the final hashes.
        const revision = `engram-memory/v1:${sha256(canonicalJson({ projection: snapshotProjection(projection),
          lifecycle: { type: row.type, createdAt: row.created_at, validFrom: row.valid_from, validUntil: row.valid_until,
            archivedAt: row.archived_at, stateKey: row.state_key, origin: row.origin,
            owner: row.owner_principal, visibility: row.visibility, shareable: row.shareable } }))}`
        if (expectedRevision !== undefined && expectedRevision !== revision) return { status: 'changed' }
        const represented = { ...projection, ref: { ...projection.ref, revision } }
        return { status: 'available', snapshot: normalizeSnapshot({ ...represented, capturedAt: now,
          contentSha256: sha256(row.content), projectionSha256: sha256(snapshotProjection(represented)) }) }
      }).deferred()
    } catch {
      // no query/error details or source bytes escape schema/parse/DB failures.
      return { status: 'degraded' }
    }
  }

  private evidence(locator: SourceLocator, caller: CallerScope, now: number): SourceEvidence[] {
    const visible = visibilityClause('e', caller)
    // spans are zero-based, half-open SQLite character offsets; null means start zero/end remainder.
    // an endpoint at content length is valid, including an empty excerpt or empty content.
    // integer affinity permits real/text/blob values, so validate stored types and bounds before substr.
    const rows = this.db.prepare(`SELECT e.id, e.uri, e.owner_principal, e.visibility, e.expires_at, e.retention,
      me.span_start, me.span_end,
      substr(e.content, COALESCE(me.span_start, 0) + 1,
        min(?, CASE WHEN me.span_end IS NULL THEN ? ELSE me.span_end - COALESCE(me.span_start, 0) END)) AS excerpt
      FROM memory_episodes me JOIN episodes e ON e.id = me.episode_id
      WHERE me.memory_id = ? AND e.namespace = ? AND ${visible.sql}
        AND (e.expires_at IS NULL OR e.expires_at > ?)
        AND typeof(me.span_start) IN ('integer', 'null')
        AND typeof(me.span_end) IN ('integer', 'null')
        AND (me.span_start IS NULL OR (me.span_start >= 0 AND me.span_start <= length(e.content)))
        AND (me.span_end IS NULL OR (me.span_end >= COALESCE(me.span_start, 0) AND me.span_end <= length(e.content)))
      ORDER BY e.id, COALESCE(me.span_start, -1), COALESCE(me.span_end, -1)`)
      .all(EXCERPT_LIMIT, EXCERPT_LIMIT, locator.sourceId, locator.namespace, ...visible.params, now) as EpisodeProjectionRow[]
    return rows.map((row) => ({ provider: EPISODE_PROVIDER, evidenceId: row.id,
      revision: `engram-episode/v1:${sha256(canonicalJson({ namespace: locator.namespace, ...row }))}`,
      uri: row.uri, excerpt: row.excerpt }))
  }
}
