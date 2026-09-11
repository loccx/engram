import { randomUUID, createHash } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  Memory,
  StoreMemoryInput,
  UpdateMemoryPatch,
  ListMemoriesFilter,
  LinkType,
  ImportanceSource,
  ExtractedEntity,
  MemoryType,
  ReviseMemoryInput,
  RevisionResult,
  MemoryHistory,
  HistoryLink,
} from './types.js'
import { rowToMemory, type MemoryRow } from './row.js'
import { getEmbedding, LINK_DISTANCE_THRESHOLD } from '../embeddings/pipeline.js'
import type { AdjudicationQueue } from '../contradictions/queue.js'
import { withTimeout } from '../contradictions/queue.js'
import {
  notSupersededClause,
  notSupersededAtClause,
  validityAtClause,
} from '../contradictions/supersession.js'
import type { BackgroundJobQueue } from '../queue/background-queue.js'
import { extractEntities } from './entities.js'
import { logger } from '../utils/logger.js'

const ADJUDICATE_SYNC_TIMEOUT_MS = 2000

export type MemoryEventType =
  | 'created'
  | 'revised'
  | 'superseded'
  | 'updated'
  | 'pinned'
  | 'valid_until_set'
  | 'deleted'

interface MemoryEventInput {
  memoryId: string
  eventType: MemoryEventType
  origin?: string
  sessionId?: string
  payload?: unknown
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32)
}

function parseTags(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]')
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    // fall through
  }
  return []
}

export class MemoryStore {
  private readonly stmtInsertMemory: Database.Statement
  private readonly stmtInsertEntity: Database.Statement
  private readonly stmtGetById: Database.Statement
  private readonly stmtRecordAccess: Database.Statement
  private readonly stmtSetPinned: Database.Statement
  private readonly stmtSetValidUntil: Database.Statement

  constructor(
    private readonly db: Database.Database,
    private readonly vectorsAvailable: boolean = false,
    private readonly adjudicationQueue: AdjudicationQueue | null = null,
    private readonly importanceQueue: BackgroundJobQueue<string> | null = null
  ) {
    this.stmtInsertMemory = this.db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, procedure_meta, importance_source, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.stmtInsertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO memory_entities (memory_id, entity_text, entity_type, created_at) VALUES (?, ?, ?, ?)'
    )
    this.stmtGetById = this.db.prepare('SELECT * FROM memories WHERE id = ?')
    this.stmtRecordAccess = this.db.prepare(
      'UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'
    )
    this.stmtSetPinned = this.db.prepare('UPDATE memories SET pinned = ? WHERE id = ?')
    this.stmtSetValidUntil = this.db.prepare(
      'UPDATE memories SET valid_until = COALESCE(valid_until, ?) WHERE id = ?'
    )
  }

  /**
   * Append-only mutation audit. Payloads are metadata-only; the deleted
   * event stores a content hash + length, never the raw content, so the audit
   * trail cannot retain more sensitive material than existing memory storage
   * (see migration 008 docstring).
   */
  private eventStmt: Database.Statement | null = null
  private eventsUnavailable = false

  private recordEvent(event: MemoryEventInput): void {
    // Always attempt the write: a skipped attempt after a transient failure
    // (e.g. SQLITE_BUSY) would latch audit off permanently. The latch only
    // downgrades repeated-failure logging and tracks the recovered state; a
    // successful write clears it so the daemon resumes auditing.
    try {
      if (!this.eventStmt) {
        this.eventStmt = this.db.prepare(
          `INSERT INTO memory_events (memory_id, event_type, origin, session_id, occurred_at, payload)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
      }
      this.eventStmt.run(
        event.memoryId,
        event.eventType,
        event.origin ?? null,
        event.sessionId ?? null,
        Date.now(),
        event.payload === undefined ? null : JSON.stringify(event.payload)
      )
      if (this.eventsUnavailable) {
        logger.warn(
          { memoryId: event.memoryId },
          'memory_events recovered; audit writes resumed'
        )
      }
      this.eventsUnavailable = false
    } catch (err) {
      this.eventsUnavailable = true
      logger.debug({ err, memoryId: event.memoryId }, 'memory_events unavailable; skipping audit write')
    }
  }

  async store(input: StoreMemoryInput): Promise<Memory> {
    const id = randomUUID()
    const now = Date.now()
    const tags = JSON.stringify(input.tags ?? [])
    const type = input.type ?? 'note'
    const importance = input.importance ?? 0.5
    const procedureMeta = input.procedure_meta ? JSON.stringify(input.procedure_meta) : null
    const importanceSource: ImportanceSource = input.importanceProvided ? 'user' : 'default'

    this.stmtInsertMemory.run(
      id,
      input.session_id,
      input.project_path,
      input.project_path,
      input.content,
      type,
      importance,
      tags,
      now,
      now,
      procedureMeta,
      importanceSource,
      input.origin ?? 'mcp'
    )

    this.recordEvent({
      memoryId: id,
      eventType: 'created',
      origin: input.origin ?? 'mcp',
      sessionId: input.session_id,
      payload: { type },
    })

    try {
      const entities = extractEntities(input.content)
      for (const e of entities) {
        this.stmtInsertEntity.run(id, e.entity_text, e.entity_type, now)
      }
    } catch {
    }

    // Compute embedding and link to related memories (non-blocking on failure)
    if (this.vectorsAvailable) {
      try {
        const embedding = await getEmbedding(input.content)
        if (embedding) {
          // Insert into vec0 — capture rowid directly from run() to avoid
          // interference from FTS5 triggers that also issue INSERTs.
          // Binary blob format (Buffer over Float32Array buffer) matches
          // db/workers/reembed.ts and is ~3-4x more compact than JSON.
          const vecInfo = this.db
            .prepare('INSERT INTO memory_vectors(embedding) VALUES (?)')
            .run(Buffer.from(embedding.buffer))
          const vecRowid = Number(vecInfo.lastInsertRowid)
          this.db.prepare('UPDATE memories SET vec_rowid = ? WHERE id = ?').run(vecRowid, id)

          // Auto-link to semantically similar memories (Zettelkasten)
          await this._autoLink(id, embedding)
        }
      } catch (err) {
        logger.warn({ err, memoryId: id }, 'embedding failed for stored memory; falling back to FTS5-only search for this memory')
      }
    }

    if (this.adjudicationQueue) {
      this.db.prepare("UPDATE memories SET adjudication_state = 'pending' WHERE id = ?").run(id)
      const job = this.adjudicationQueue.enqueue(id)
      if (input.adjudicateSync) {
        await withTimeout(job.promise, ADJUDICATE_SYNC_TIMEOUT_MS, `adjudicate:${id}`)
      }
    }

    if (this.importanceQueue && !input.importanceProvided) {
      this.importanceQueue.enqueue(id)
    }

    return this.getById(id)!
  }

  /**
   * Find existing memories similar to the new one and create bidirectional links.
   * Implements the Zettelkasten note-linking pattern from A-MEM (arxiv 2502.12110).
   */
  private async _autoLink(newId: string, embedding: Float32Array): Promise<void> {
    const queryVec = Buffer.from(embedding.buffer)
    try {
      const vecResults = this.db
        .prepare(
          `SELECT knn.rowid, knn.distance, m.id
           FROM (SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? LIMIT 20) knn
           JOIN memories m ON m.vec_rowid = knn.rowid`
        )
        .all(queryVec) as Array<{ rowid: number; distance: number; id: string }>

      const toLink = vecResults.filter(
        (r) => r.id !== newId && r.distance < LINK_DISTANCE_THRESHOLD
      )

      if (toLink.length === 0) return

      const insertLink = this.db.prepare(
        `INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      const now = Date.now()

      // For normalized unit vectors: cosine_sim = 1 - L2²/2
      for (const { id: targetId, distance } of toLink) {
        const sim = Math.max(0, 1 - (distance * distance) / 2)
        insertLink.run(newId, targetId, sim, 'semantic', now)
        insertLink.run(targetId, newId, sim, 'semantic', now)
      }
    } catch {
      // Auto-linking is best-effort
    }
  }

  getById(id: string): Memory | null {
    const row = this.stmtGetById.get(id) as MemoryRow | undefined
    return row ? rowToMemory(row) : null
  }

  /**
   * Historical view: the MANUAL revision-chain member that was current at
   * `asOf` (max valid_from among members valid at that time).
   *
   * Only explicit manual revision edges enter resolution: `supersedes` links
   * with `revision > 0` (successor → predecessor). Adjudicated supersession
   * edges (revision = 0) are a contradiction signal, not a revision, and must
   * never make a foreign memory appear as this id's point-in-time row. Each
   * edge is also respected in time: it is only followed when it was already
   * judged at `asOf` (COALESCE(judged_at, created_at) <= asOf), so a revision
   * made later cannot leak into an earlier snapshot. Returns null when no
   * chain member was valid at `asOf`. See getHistory for the broader,
   * confidence-agnostic audit view.
   */
  getByIdAt(id: string, asOf: number): Memory | null {
    if (!this.getById(id)) return null

    // Bidirectional walk over manual revision edges only, bounded like
    // getHistory. `chainVersion` walks successor → predecessor; walking both
    // directions makes any chain member a valid entry point.
    const visited = new Set<string>()
    const frontier: string[] = [id]
    const neighborStmt = this.db.prepare(
      `SELECT source_id, target_id, judged_at, created_at FROM memory_links
       WHERE link_type = 'supersedes' AND revision > 0 AND (source_id = ? OR target_id = ?)`
    )
    const MAX_NODES = 500
    while (frontier.length > 0 && visited.size < MAX_NODES) {
      const cur = frontier.shift()!
      if (visited.has(cur)) continue
      visited.add(cur)
      const neighbors = neighborStmt.all(cur, cur) as Array<{
        source_id: string
        target_id: string
        judged_at: number | null
        created_at: number
      }>
      for (const n of neighbors) {
        // Respect link time: edges judged after asOf did not exist yet.
        if ((n.judged_at ?? n.created_at) > asOf) continue
        const other = n.source_id === cur ? n.target_id : n.source_id
        if (!visited.has(other)) frontier.push(other)
      }
    }

    const ids = [...visited]
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE id IN (${placeholders}) AND ${validityAtClause('memories', '?')}
         ORDER BY valid_from DESC, created_at DESC, id DESC LIMIT 1`
      )
      .all(...ids, asOf, asOf) as MemoryRow[]
    return rows.length > 0 ? rowToMemory(rows[0]) : null
  }

  delete(id: string): boolean {
    const mem = this.getById(id)
    if (!mem) return false

    // Atomic cleanup across all tables that reference this memory:
    //   memory_links + memory_entities cascade via FK (set in baseline schema)
    //   memories_fts is wiped by the AFTER DELETE trigger
    //   memory_vectors (vec0) and memory_clusters.member_ids have no FK and
    //   must be cleaned manually. Wrapping in a transaction ensures we don't
    //   leave orphan rows if any single step throws.
    const tx = this.db.transaction((memoryId: string, vecRowid: number | null) => {
      // Append the audit event INSIDE the transaction, before the row
      // disappears, so a failed delete never leaves a misleading audit row.
      // memory_events has no FK to memories, so forgetting a memory
      // preserves its own audit trail.
      const deletedPayload = {
        content_sha256: hashContent(mem.content),
        content_chars: mem.content.length,
        type: mem.type,
        tags_count: mem.tags.length,
        importance: mem.importance,
      }
      try {
        if (!this.eventStmt) {
          this.eventStmt = this.db.prepare(
            `INSERT INTO memory_events (memory_id, event_type, origin, session_id, occurred_at, payload)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
        }
        this.eventStmt.run(
          memoryId,
          'deleted',
          mem.origin ?? 'legacy',
          mem.session_id,
          Date.now(),
          JSON.stringify(deletedPayload)
        )
      } catch (err) {
        this.eventsUnavailable = true
        logger.debug({ err, memoryId }, 'memory_events unavailable; skipping audit write')
      }

      if (vecRowid != null) {
        try {
          this.db.prepare('DELETE FROM memory_vectors WHERE rowid = ?').run(vecRowid)
        } catch {
          // vec0 cleanup is best-effort; orphan vec rows are harmless (vec_rowid
          // is required to surface them via the JOIN in _autoLink / _vectorSearch)
        }
      }

      const clusterRows = this.db
        .prepare(
          "SELECT id, member_ids FROM memory_clusters WHERE member_ids LIKE '%' || ? || '%'"
        )
        .all(memoryId) as Array<{ id: number; member_ids: string }>
      const updateCluster = this.db.prepare(
        'UPDATE memory_clusters SET member_ids = ?, updated_at = ? WHERE id = ?'
      )
      const deleteCluster = this.db.prepare('DELETE FROM memory_clusters WHERE id = ?')
      const now = Date.now()
      for (const row of clusterRows) {
        let members: unknown
        try {
          members = JSON.parse(row.member_ids)
        } catch {
          continue
        }
        if (!Array.isArray(members)) continue
        const pruned = members.filter((m): m is string => typeof m === 'string' && m !== memoryId)
        if (pruned.length === members.length) continue
        if (pruned.length < 2) {
          // A cluster with <2 members carries no community signal; drop it
          deleteCluster.run(row.id)
        } else {
          updateCluster.run(JSON.stringify(pruned), now, row.id)
        }
      }

      const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId)
      return result.changes > 0
    })

    return tx(id, mem.vec_rowid) as boolean
  }

  list(filters: ListMemoriesFilter = {}): Memory[] {
    const conditions: string[] = []
    const values: unknown[] = []

    if (filters.project_path) {
      conditions.push('COALESCE(namespace, project_path) = ?')
      values.push(filters.project_path)
    }
    if (filters.type) {
      conditions.push('type = ?')
      values.push(filters.type)
    }
    if (filters.as_of !== undefined) {
      conditions.push(validityAtClause('memories', '?'))
      values.push(filters.as_of, filters.as_of)
    }
    if (!filters.include_superseded) {
      if (filters.as_of !== undefined) {
        conditions.push(notSupersededAtClause('memories.id', '?'))
        values.push(filters.as_of)
      } else {
        conditions.push(notSupersededClause('memories.id'))
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = filters.limit ?? 20
    values.push(limit)

    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values) as MemoryRow[]

    let memories = rows.map(rowToMemory)

    // Tag filtering in-process (JSON array)
    if (filters.tags && filters.tags.length > 0) {
      const filterTags = new Set(filters.tags.map((t) => t.toLowerCase()))
      memories = memories.filter((m) => m.tags.some((t) => filterTags.has(t.toLowerCase())))
    }

    return memories
  }

  recordAccess(id: string): void {
    this.stmtRecordAccess.run(Date.now(), id)
  }

  setPinned(id: string, pinned: boolean): boolean {
    const before = this.getById(id)
    if (!before) return false
    // No-op guard: identical pin state neither mutates nor fabricates events.
    if ((before.pinned ?? false) === pinned) return false
    const result = this.stmtSetPinned.run(pinned ? 1 : 0, id)
    if (result.changes > 0) {
      this.recordEvent({
        memoryId: id,
        eventType: 'pinned',
        origin: before.origin ?? 'legacy',
        sessionId: before.session_id,
        payload: { pinned },
      })
    }
    return result.changes > 0
  }

  setValidUntil(id: string, timestamp: number): void {
    const before = this.getById(id)
    if (!before) return
    // COALESCE(valid_until, ?) never moves an earlier close: when the row
    // already has a boundary, this is a no-op and no event is recorded.
    if (before.valid_until !== null) return
    this.stmtSetValidUntil.run(timestamp, id)
    this.recordEvent({
      memoryId: id,
      eventType: 'valid_until_set',
      origin: before.origin ?? 'legacy',
      sessionId: before.session_id,
      payload: { valid_until: timestamp },
    })
  }

  update(id: string, patch: UpdateMemoryPatch): boolean {
    const before = this.getById(id)
    if (!before) return false
    const sets: string[] = []
    const values: unknown[] = []
    const fieldKeys: string[] = []
    if (patch.type !== undefined && patch.type !== before.type) {
      sets.push('type = ?')
      values.push(patch.type)
      fieldKeys.push('type')
    }
    if (patch.importance !== undefined && patch.importance !== before.importance) {
      sets.push('importance = ?', "importance_source = 'user'")
      values.push(patch.importance)
      fieldKeys.push('importance')
    }
    if (
      patch.tags !== undefined &&
      JSON.stringify(patch.tags) !== JSON.stringify(before.tags)
    ) {
      sets.push('tags = ?')
      values.push(JSON.stringify(patch.tags))
      fieldKeys.push('tags')
    }
    if (
      patch.valid_until !== undefined &&
      patch.valid_until !== (before.valid_until ?? null)
    ) {
      sets.push('valid_until = ?')
      values.push(patch.valid_until)
      fieldKeys.push('valid_until')
    }
    if (sets.length === 0) return false
    values.push(id)
    const result = this.db
      .prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values)
    if (result.changes > 0) {
      // update_memory remains metadata-only: never content. An event is
      // written only when the patch actually changed a field, and always
      // carries the row's provenance (no fabricated no-op / no-id events).
      this.recordEvent({
        memoryId: id,
        eventType: 'updated',
        origin: before.origin ?? 'mcp',
        sessionId: before.session_id,
        payload: { updated_fields: fieldKeys },
      })
    }
    return result.changes > 0
  }

  getEntities(memoryId: string): ExtractedEntity[] {
    return this.db
      .prepare(
        'SELECT entity_text, entity_type FROM memory_entities WHERE memory_id = ? ORDER BY id ASC LIMIT 30'
      )
      .all(memoryId) as ExtractedEntity[]
  }

  searchByEntity(
    entityText: string,
    projectPath?: string,
    limit: number = 10,
    options: { include_superseded?: boolean; as_of?: number } = {}
  ): Memory[] {
    const conditions = ['me.entity_text = ? COLLATE NOCASE']
    const values: unknown[] = [entityText]
    if (options.as_of !== undefined) {
      conditions.push(validityAtClause('m', '?'))
      values.push(options.as_of, options.as_of)
    }
    if (!options.include_superseded) {
      if (options.as_of !== undefined) {
        conditions.push(notSupersededAtClause('m.id', '?'))
        values.push(options.as_of)
      } else {
        conditions.push(notSupersededClause('m.id'))
      }
    }
    if (projectPath) {
      conditions.push('COALESCE(m.namespace, m.project_path) = ?')
      values.push(projectPath)
    }
    values.push(limit)
    const rows = this.db
      .prepare(
        `SELECT DISTINCT m.*
         FROM memory_entities me
         JOIN memories m ON m.id = me.memory_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY m.created_at DESC
         LIMIT ?`
      )
      .all(...values) as MemoryRow[]
    return rows.map(rowToMemory)
  }

  /**
   * Get memories linked to a given memory (Zettelkasten graph traversal).
   * Returns related memories sorted by similarity descending.
   */
  getLinked(
    id: string,
    limit: number = 10,
    options: { include_superseded?: boolean; as_of?: number } = {}
  ): Array<Memory & { similarity: number; link_type: LinkType }> {
    const params: unknown[] = [id]
    const timeFilter =
      options.as_of !== undefined ? ` AND ${validityAtClause('m', '?')}` : ''
    if (options.as_of !== undefined) params.push(options.as_of, options.as_of)

    const supersededFilter = options.include_superseded
      ? ''
      : options.as_of !== undefined
        ? ` AND ${notSupersededAtClause('m.id', '?')}`
        : ` AND ${notSupersededClause('m.id')}`
    if (options.as_of !== undefined && !options.include_superseded) {
      params.push(options.as_of)
    }
    params.push(limit)

    const rows = this.db
      .prepare(
        `SELECT m.*, ml.similarity, ml.link_type
         FROM memory_links ml
         JOIN memories m ON m.id = ml.target_id
         WHERE ml.source_id = ?${timeFilter}${supersededFilter}
         ORDER BY ml.similarity DESC
         LIMIT ?`
      )
      .all(...params) as Array<
        MemoryRow & { similarity: number; link_type: LinkType }
      >

    return rows.map((row) => ({ ...rowToMemory(row), similarity: row.similarity, link_type: row.link_type }))
  }

  /**
   * Depth of the manual revision chain ending at `id` (1-based). A manual
   * revision edge points successor → predecessor (source supersedes target),
   * so walk BACKWARD along outgoing `revision > 0` edges: the predecessor is
   * the edge's target. Adjudicated links (revision = 0) are not part of the
   * manual chain. Bounded against cycles.
   */
  private chainVersion(id: string): number {
    const stmt = this.db.prepare(
      "SELECT target_id FROM memory_links WHERE source_id = ? AND link_type = 'supersedes' AND revision > 0"
    )
    let depth = 1
    let cur = id
    const visited = new Set<string>([id])
    for (let guard = 0; guard < 100; guard++) {
      const targets = stmt.all(cur) as Array<{ target_id: string }>
      const next = targets.find((t) => !visited.has(t.target_id))
      if (!next) break
      visited.add(next.target_id)
      cur = next.target_id
      depth++
    }
    return depth
  }

  /**
   * Append-only revision: creates a NEW memory row, links it to the
   * predecessor with a deterministic confidence=1 supersedes edge, closes the
   * predecessor's validity window, and transfers the pin so the digest tracks
   * current content. Shareable is never inherited without explicit opt-in.
   * Whole operation is atomic (single transaction); returns null when the
   * predecessor does not exist.
   */
  async revise(input: ReviseMemoryInput): Promise<RevisionResult | null> {
    const version = this.chainVersion(input.id)

    // The predecessor row is re-read INSIDE the transaction: two interleaved
    // revises of the same id cannot both observe the same open row and mint
    // two successors (the second read sees the closed validity/pin state).
    const tx = this.db.transaction(() => {
      const prevRow = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(input.id) as
        | MemoryRow
        | undefined
      if (!prevRow) return null

      const now = Date.now()
      const newId = randomUUID()
      const successorVersion = version + 1
      const type = input.type ?? (prevRow.type as MemoryType)
      const tags = input.tags ?? parseTags(prevRow.tags)
      const importanceSource: ImportanceSource =
        (prevRow.importance_source as ImportanceSource | undefined) ?? 'default'
      const namespace = prevRow.namespace ?? prevRow.project_path
      const sessionId = input.session_id ?? prevRow.session_id
      const wasPinned = prevRow.pinned === 1
      const origin = input.origin ?? 'revision'

      this.db
        .prepare(
          `INSERT INTO memories
             (id, session_id, project_path, namespace, content, type, importance, tags,
              created_at, valid_from, procedure_meta, importance_source, pinned, shareable, origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          newId,
          sessionId,
          prevRow.project_path,
          namespace,
          input.content,
          type,
          prevRow.importance,
          JSON.stringify(tags),
          now,
          now,
          prevRow.procedure_meta ?? null,
          importanceSource,
          wasPinned ? 1 : 0,
          input.shareable === true ? 1 : 0,
          origin
        )

      // Copy entities; predecessor keeps its own copies (append-only).
      this.db
        .prepare(
          `INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at)
           SELECT ?, entity_text, entity_type, created_at
           FROM memory_entities WHERE memory_id = ?`
        )
        .run(newId, prevRow.id)

      // Deterministic manual supersedes edge; INSERT OR IGNORE can never
      // clobber an adjudicated link for the same pair.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_links
             (source_id, target_id, similarity, link_type, created_at, confidence, reason,
              decider_model, prompt_version, judged_at, revision)
           VALUES (?, ?, 1.0, 'supersedes', ?, 1.0, ?, 'manual', 'revision-v1', ?, ?)`
        )
        .run(newId, prevRow.id, now, input.reason ?? 'manual revision', now, successorVersion)

      // Close the predecessor's validity window (never move an earlier close).
      this.db
        .prepare('UPDATE memories SET valid_until = COALESCE(valid_until, ?) WHERE id = ?')
        .run(now, prevRow.id)

      // The pin transfers to the new version so project_digests refresh from
      // current content, not the retired row.
      if (wasPinned) {
        this.db.prepare('UPDATE memories SET pinned = 0 WHERE id = ?').run(prevRow.id)
      }

      this.recordEvent({
        memoryId: newId,
        eventType: 'created',
        origin,
        sessionId,
        payload: { revision: successorVersion, previous_id: prevRow.id },
      })
      this.recordEvent({
        memoryId: newId,
        eventType: 'revised',
        origin,
        sessionId,
        payload: { previous_id: prevRow.id, revision: successorVersion },
      })
      this.recordEvent({
        memoryId: prevRow.id,
        eventType: 'superseded',
        origin,
        sessionId,
        payload: { superseded_by: newId, revision: successorVersion },
      })

      return { newId, prevRowId: prevRow.id, successorVersion, importanceSource }
    })
    const committed = tx.immediate() as
      | { newId: string; prevRowId: string; successorVersion: number; importanceSource: ImportanceSource }
      | null
    if (!committed) return null
    const { newId, prevRowId, successorVersion, importanceSource } = committed

    // Embedding + auto-linking best-effort, mirroring store().
    if (this.vectorsAvailable) {
      try {
        const embedding = await getEmbedding(input.content)
        if (embedding) {
          const vecInfo = this.db
            .prepare('INSERT INTO memory_vectors(embedding) VALUES (?)')
            .run(Buffer.from(embedding.buffer))
          const vecRowid = Number(vecInfo.lastInsertRowid)
          this.db.prepare('UPDATE memories SET vec_rowid = ? WHERE id = ?').run(vecRowid, newId)
          await this._autoLink(newId, embedding)
        }
      } catch (err) {
        logger.warn(
          { err, memoryId: newId },
          'embedding failed for revised memory; falling back to FTS5-only search'
        )
      }
    }

    if (this.adjudicationQueue) {
      this.db.prepare("UPDATE memories SET adjudication_state = 'pending' WHERE id = ?").run(newId)
      this.adjudicationQueue.enqueue(newId)
    }
    if (this.importanceQueue && importanceSource === 'default') {
      this.importanceQueue.enqueue(newId)
    }

    const memory = this.getById(newId)
    if (!memory) return null
    return { id: newId, previous_id: prevRowId, version: successorVersion, memory }
  }

  /**
   * Bounded bidirectional BFS over supersedes edges (confidence-agnostic:
   * history is audit, not recall). Returns chain members oldest-first plus the
   * links between them. `as_of` filters versions to the historical view.
   */
  getHistory(id: string, options: { as_of?: number; limit?: number } = {}): MemoryHistory | null {
    if (!this.getById(id)) return null
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500))

    const visited = new Set<string>()
    const frontier: string[] = [id]
    const neighborStmt = this.db.prepare(
      "SELECT source_id, target_id FROM memory_links WHERE link_type = 'supersedes' AND (source_id = ? OR target_id = ?)"
    )
    const MAX_NODES = 500
    while (frontier.length > 0 && visited.size < MAX_NODES) {
      const cur = frontier.shift()!
      if (visited.has(cur)) continue
      visited.add(cur)
      const neighbors = neighborStmt.all(cur, cur) as Array<{
        source_id: string
        target_id: string
      }>
      for (const n of neighbors) {
        const other = n.source_id === cur ? n.target_id : n.source_id
        if (!visited.has(other)) frontier.push(other)
      }
    }

    const ids = [...visited]
    const placeholders = ids.map(() => '?').join(',')
    let rows: MemoryRow[]
    if (options.as_of !== undefined) {
      rows = this.db
        .prepare(
          `SELECT * FROM memories
           WHERE id IN (${placeholders}) AND ${validityAtClause('memories', '?')}
           ORDER BY created_at ASC, id ASC`
        )
        .all(...ids, options.as_of, options.as_of) as MemoryRow[]
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM memories WHERE id IN (${placeholders}) ORDER BY created_at ASC, id ASC`
        )
        .all(...ids) as MemoryRow[]
    }

    const linkRows = this.db
      .prepare(
        `SELECT * FROM memory_links
         WHERE link_type = 'supersedes'
           AND source_id IN (${placeholders})
           AND target_id IN (${placeholders})
         ORDER BY COALESCE(judged_at, created_at) ASC, source_id ASC, target_id ASC`
      )
      .all(...ids, ...ids) as Array<Record<string, unknown>>

    const links: HistoryLink[] = linkRows.map((l) => ({
      source_id: l.source_id as string,
      target_id: l.target_id as string,
      similarity: l.similarity as number,
      link_type: l.link_type as LinkType,
      created_at: l.created_at as number,
      confidence: (l.confidence as number | null) ?? null,
      reason: (l.reason as string | null) ?? null,
      decider_model: (l.decider_model as string | null) ?? null,
      prompt_version: (l.prompt_version as string | null) ?? null,
      judged_at: (l.judged_at as number | null) ?? null,
      revision: (l.revision as number | undefined) ?? 0,
    }))

    return { id, versions: rows.map(rowToMemory).slice(0, limit), links }
  }
}
