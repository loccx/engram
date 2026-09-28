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
import {
  getEmbedding,
  LINK_DISTANCE_THRESHOLD,
  MODEL_ID,
  EMBEDDING_DIM,
} from '../embeddings/pipeline.js'
import { refreshDigest } from './digest.js'
import type { AdjudicationQueue } from '../contradictions/queue.js'
import { withTimeout } from '../contradictions/queue.js'
import { findContradictionCandidates } from '../contradictions/candidates.js'
import { admit, isAgentWrite, type AdmissionWarning } from './admission.js'
import {
  notSupersededClause,
  notSupersededAtClause,
  validityAtClause,
} from '../contradictions/supersession.js'
import type { BackgroundJobQueue } from '../queue/background-queue.js'
import { extractEntities } from './entities.js'
import { normalizeIdentifiers } from '../db/lexical-index.js'
import { logger } from '../utils/logger.js'

const ADJUDICATE_SYNC_TIMEOUT_MS = 2000
const CONFLICT_LIMIT = 3
const CONFLICT_PREVIEW_CHARS = 120

/**
 * write-time reconciliation: 'off' inserts every store, 'link' only records a
 * duplicate_of marker, 'merge' (default) returns the existing row for an
 * exact-content duplicate in the same namespace+type and folds in the metadata
 */
export type WriteGateMode = 'off' | 'link' | 'merge'

export const WRITE_GATE_DEFAULT_SIMILARITY = 0.95

export function resolveWriteGateMode(env: NodeJS.ProcessEnv = process.env): WriteGateMode {
  const raw = env.ENGRAM_WRITE_GATE?.trim().toLowerCase()
  return raw === 'off' || raw === 'link' || raw === 'merge' ? raw : 'merge'
}

/** near-duplicate floor: same namespace, same type, neither row pinned */
export function resolveWriteGateSimilarity(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.ENGRAM_WRITE_GATE_SIM ?? '')
  if (!Number.isFinite(n)) return WRITE_GATE_DEFAULT_SIMILARITY
  return Math.min(Math.max(n, 0.5), 0.999)
}

interface KnnNeighbour {
  rowid: number
  distance: number
  id: string
  type: MemoryType
  created_at: number
  content: string
  pinned: number
  archived_at: number | null
  namespace: string
}

export interface PossibleDuplicate {
  id: string
  similarity: number
  type: string
  created_at: number
}

/** extra fields the gate adds to the returned row, never a new column */
export interface WriteGateInfo {
  deduplicated?: boolean
  possible_duplicates?: PossibleDuplicate[]
}

/** one likely contradiction for the row just stored; a candidate, never a verdict */
export interface ConflictCandidate {
  id: string
  preview: string
  /** 'duplicate' is the one relation decidable without the judge */
  relation_hint?: 'duplicate'
}

export interface StoreWriteResult extends Memory {
  status: 'stored' | 'deduplicated'
  deduplicated?: boolean
  possible_duplicates?: PossibleDuplicate[]
  warnings?: AdmissionWarning[]
  conflicts?: ConflictCandidate[]
}

/** a refused write: nothing was inserted */
export interface RefusedWrite {
  status: 'rejected'
  rule: string
  reason: string
  hint: string
  existing_id?: string
}

export type StoreResult = StoreWriteResult | RefusedWrite

/**
 * injectable embedder: the gate needs the vector before the insert, and tests or
 * a caller with its own model must be able to swap it out
 */
export type StoreEmbedder = (content: string) => Promise<Float32Array | null>

let storeEmbedder: StoreEmbedder = (content) => getEmbedding(content)

export function setStoreEmbedder(embedder: StoreEmbedder | null): void {
  storeEmbedder = embedder ?? ((content) => getEmbedding(content))
}

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
  private readonly stmtRecordVector: Database.Statement

  constructor(
    private readonly db: Database.Database,
    private readonly vectorsAvailable: boolean = false,
    private readonly adjudicationQueue: AdjudicationQueue | null = null,
    private readonly importanceQueue: BackgroundJobQueue<string> | null = null
  ) {
    // ident_text is content || ' ' || tags normalized here in one pass; the
    // after-insert trigger used a per-character recursive cte and cost far more of
    // an ordinary write. the trigger now only copies the column into memories_ident_fts.
    this.stmtInsertMemory = this.db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, procedure_meta, importance_source, origin, ident_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.stmtInsertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO memory_entities (memory_id, entity_text, entity_type, created_at, ident_text) VALUES (?, ?, ?, ?, ?)'
    )
    this.stmtGetById = this.db.prepare('SELECT * FROM memories WHERE id = ?')
    this.stmtRecordAccess = this.db.prepare(
      'UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'
    )
    this.stmtSetPinned = this.db.prepare('UPDATE memories SET pinned = ? WHERE id = ?')
    this.stmtSetValidUntil = this.db.prepare(
      'UPDATE memories SET valid_until = COALESCE(valid_until, ?) WHERE id = ?'
    )
    this.stmtRecordVector = this.db.prepare(
      `UPDATE memories
       SET vec_rowid = ?, embedding_model = ?, embedding_dim = ?, embed_state = 'fresh'
       WHERE id = ?`
    )
  }

  /**
   * append-only audit. payloads are metadata-only (a delete stores a hash and a
   * length), so the trail never holds more than the row itself — migration 008
   */
  private eventStmt: Database.Statement | null = null
  private eventsUnavailable = false

  private recordEvent(event: MemoryEventInput): void {
    // never skip an attempt: one sqlite_busy would latch audit off for good. the
    // latch only quietens repeated-failure logging, and a successful write clears it
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

  /**
   * admission decides whether the write may become a row, then the gate reconciles
   * it against its neighbours — both before the insert, which is why the embedding
   * is computed here. every branch is best effort: a gate failure never fails a store.
   */
  async store(input: StoreMemoryInput): Promise<StoreResult> {
    const id = randomUUID()
    const now = Date.now()
    const tags = JSON.stringify(input.tags ?? [])
    const type = input.type ?? 'note'
    const importance = input.importance ?? 0.5
    const procedureMeta = input.procedure_meta ? JSON.stringify(input.procedure_meta) : null
    const importanceSource: ImportanceSource = input.importanceProvided ? 'user' : 'default'
    const gateMode = resolveWriteGateMode()

    // before the embedding: a refused write should cost nothing
    const admission = admit(
      { content: input.content, namespace: input.project_path, type, tags: input.tags ?? [] },
      { db: this.db, now, agent: isAgentWrite(input.origin) }
    )
    if (!admission.allowed) {
      logger.debug(
        { rule: admission.rule, namespace: input.project_path },
        'admission refused a write'
      )
      return {
        status: 'rejected',
        rule: admission.rule,
        reason: admission.reason,
        hint: admission.hint,
        existing_id: admission.existing_id,
      }
    }

    // the gate needs the vector to see the neighbourhood
    let embedding: Float32Array | null = null
    if (this.vectorsAvailable) {
      try {
        embedding = await storeEmbedder(input.content)
      } catch (err) {
        logger.warn(
          { err },
          'embedding failed for stored memory; falling back to FTS5-only search for this memory'
        )
      }
    }

    // one knn probe feeds both the gate and auto-linking below, so a store pays for
    // one neighbourhood lookup instead of two
    let neighbours: KnnNeighbour[] | null = null
    if (embedding) {
      try {
        neighbours = this._knnNeighbours(embedding)
      } catch (err) {
        logger.debug({ err }, 'write gate: neighbourhood lookup failed; inserting normally')
      }
    }

    let possibleDuplicates: PossibleDuplicate[] = []
    if (embedding && neighbours && gateMode !== 'off' && input.pinned !== true) {
      try {
        const exact = this.findExactDuplicate(input.content, input.project_path, type)
        if (exact && gateMode === 'merge') {
          return this.mergeIntoExisting(exact, input, importance, now)
        }
        if (exact) {
          possibleDuplicates.push({
            id: exact.id,
            similarity: 1,
            type: exact.type,
            created_at: exact.created_at,
          })
        }
        possibleDuplicates = possibleDuplicates.concat(
          this.nearDuplicatesFrom(neighbours, input.project_path, type, input.content)
        )
      } catch (err) {
        logger.debug({ err }, 'write gate: duplicate reconciliation failed; inserting normally')
      }
    }

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
      input.origin ?? 'mcp',
      // exactly the expression the 012 trigger used, so the indexed text is unchanged
      normalizeIdentifiers(`${input.content} ${tags}`)
    )

    this.recordEvent({
      memoryId: id,
      eventType: 'created',
      origin: input.origin ?? 'mcp',
      sessionId: input.session_id,
      payload: { type },
    })

    // pin before the gate's neighbours see the row, so the digest reflects it
    // without a second tool call
    if (input.pinned === true) {
      this.stmtSetPinned.run(1, id)
      this.recordEvent({
        memoryId: id,
        eventType: 'pinned',
        origin: input.origin ?? 'mcp',
        sessionId: input.session_id,
        payload: { pinned: true },
      })
    }

    try {
      const entities = extractEntities(input.content)
      for (const e of entities) {
        this.stmtInsertEntity.run(
          id,
          e.entity_text,
          e.entity_type,
          now,
          normalizeIdentifiers(e.entity_text)
        )
      }
    } catch {
    }

    if (embedding) {
      try {
        // take the vec0 rowid straight from run(): the fts5 triggers issue inserts
        // too and would confuse lastInsertRowid. a float32 buffer as a blob matches
        // reembed.ts and is much smaller than json
        const vecInfo = this.db
          .prepare('INSERT INTO memory_vectors(embedding) VALUES (?)')
          .run(Buffer.from(embedding.buffer))
        this.recordVectorProvenance(id, Number(vecInfo.lastInsertRowid))

        // zettelkasten auto-linking reuses the neighbourhood the gate already fetched
        await this._autoLink(id, embedding, neighbours)
      } catch (err) {
        logger.warn({ err, memoryId: id }, 'embedding failed for stored memory; falling back to FTS5-only search for this memory')
      }
    }

    // a non-hiding link to each flagged neighbour: best effort, never on a pinned row
    if (possibleDuplicates.length > 0) {
      this._linkDuplicates(id, possibleDuplicates)
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

    if (input.pinned === true) {
      // a pin changes the digest, so refresh before returning; the write is
      // hash-guarded
      try {
        await refreshDigest(this.db, input.project_path)
      } catch (err) {
        logger.debug({ err, memoryId: id }, 'digest: refresh after pinned store failed')
      }
    }

    const stored = this.getById(id)!
    const result: StoreWriteResult = { ...stored, status: 'stored' }
    if (admission.warnings.length > 0) result.warnings = admission.warnings
    if (possibleDuplicates.length > 0) result.possible_duplicates = possibleDuplicates
    const conflicts = this._conflictCandidates({
      id,
      namespace: input.project_path,
      content: input.content,
      embedding,
      duplicateIds: new Set(possibleDuplicates.map((d) => d.id)),
    })
    if (conflicts.length > 0) result.conflicts = conflicts
    return result
  }

  /**
   * candidates for the caller to resolve while it still holds the context that
   * produced them; the judge itself stays asynchronous
   */
  private _conflictCandidates(params: {
    id: string
    namespace: string
    content: string
    embedding: Float32Array | null
    duplicateIds: Set<string>
  }): ConflictCandidate[] {
    try {
      return findContradictionCandidates(
        this.db,
        {
          namespace: params.namespace,
          excludeMemoryId: params.id,
          embedding: params.embedding,
          contentForFts: params.content,
          vectorsAvailable: this.vectorsAvailable,
        },
        { maxCandidates: CONFLICT_LIMIT }
      )
        .filter((c) => c.memory.archived_at == null)
        .map((c) => {
          const conflict: ConflictCandidate = {
            id: c.memory.id,
            preview: c.memory.content.slice(0, CONFLICT_PREVIEW_CHARS),
          }
          if (params.duplicateIds.has(c.memory.id)) conflict.relation_hint = 'duplicate'
          return conflict
        })
    } catch (err) {
      logger.debug({ err, memoryId: params.id }, 'inline conflict candidates failed')
      return []
    }
  }

  /**
   * same namespace, same type, neither superseded nor archived: content equality is
   * the strongest duplicate signal and costs one cached compare
   */
  private findExactDuplicate(
    content: string,
    namespace: string,
    type: MemoryType
  ): MemoryRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE content = ?
           AND COALESCE(namespace, project_path) = ?
           AND type = ?
           AND ${notSupersededClause('memories.id')}
         ORDER BY created_at ASC, id ASC
         LIMIT 1`
      )
      .get(content, namespace, type) as MemoryRow | undefined
    return row ?? null
  }

  /**
   * nearest vector neighbours, unfiltered, so one probe serves both consumers and
   * they can never disagree about what the neighbourhood is
   */
  private _knnNeighbours(embedding: Float32Array): KnnNeighbour[] {
    return this.db
      .prepare(
        `SELECT knn.rowid, knn.distance, m.id, m.type, m.created_at, m.content,
                m.pinned, m.archived_at,
                COALESCE(m.namespace, m.project_path) AS namespace
         FROM (SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? LIMIT 20) knn
         JOIN memories m ON m.vec_rowid = knn.rowid`
      )
      .all(Buffer.from(embedding.buffer)) as KnnNeighbour[]
  }

  /**
   * neighbours at or above the similarity floor with the same namespace and type,
   * neither pinned nor archived, strongest first; exact matches are excluded
   */
  private nearDuplicatesFrom(
    neighbours: KnnNeighbour[],
    namespace: string,
    type: MemoryType,
    content: string
  ): PossibleDuplicate[] {
    const threshold = resolveWriteGateSimilarity()
    const duplicates: PossibleDuplicate[] = []
    for (const row of neighbours) {
      if (row.namespace !== namespace) continue
      if (row.type !== type) continue
      if (row.pinned === 1 || row.archived_at !== null) continue
      if (row.content === content) continue
      const similarity = Math.max(0, 1 - (row.distance * row.distance) / 2)
      if (similarity < threshold) continue
      duplicates.push({
        id: row.id,
        similarity: Number(similarity.toFixed(6)),
        type: row.type,
        created_at: row.created_at,
      })
    }
    return duplicates.sort((a, b) => b.similarity - a.similarity)
  }

  /**
   * merge mode: hand back the existing row and fold in the tags union and the
   * highest requested importance. content is never mutated.
   */
  private mergeIntoExisting(
    existing: MemoryRow,
    input: StoreMemoryInput,
    importance: number,
    now: number
  ): StoreWriteResult {
    const before = rowToMemory(existing)
    const mergedTags = Array.from(new Set([...before.tags, ...(input.tags ?? [])]))
    const mergedImportance = Math.max(before.importance, importance)
    try {
      const tx = this.db.transaction(() => {
        const mergedTagsJson = JSON.stringify(mergedTags)
        this.db
          .prepare(
            'UPDATE memories SET tags = ?, ident_text = ?, importance = ?, importance_source = ? WHERE id = ?'
          )
          .run(
            mergedTagsJson,
            // tags feed the identifier index, so the derived column moves with them
            // or the trigger re-indexes the stale value
            normalizeIdentifiers(`${existing.content} ${mergedTagsJson}`),
            mergedImportance,
            mergedImportance > before.importance ? 'user' : before.importance_source ?? 'default',
            existing.id
          )
        if (input.pinned === true && !before.pinned) {
          this.stmtSetPinned.run(1, existing.id)
        }
      })
      tx()
    } catch (err) {
      logger.debug(
        { err, memoryId: existing.id },
        'write gate: metadata merge into the existing duplicate failed; returning it unchanged'
      )
    }
    logger.debug(
      { memoryId: existing.id, namespace: input.project_path, now },
      'write gate: exact duplicate merged instead of inserting a second row'
    )
    const merged = this.getById(existing.id) ?? before
    return { ...merged, status: 'deduplicated', deduplicated: true }
  }

  /** the non-hiding duplicate_of markers for the flagged neighbours */
  private _linkDuplicates(sourceId: string, duplicates: PossibleDuplicate[]): void {
    try {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO memory_links
           (source_id, target_id, similarity, link_type, created_at, confidence, reason)
         VALUES (?, ?, ?, 'duplicate_of', ?, ?, 'write-gate')`
      )
      const now = Date.now()
      for (const dup of duplicates) {
        insert.run(sourceId, dup.id, dup.similarity, now, dup.similarity)
      }
    } catch (err) {
      logger.debug({ err, memoryId: sourceId }, 'write gate: duplicate_of link write failed')
    }
  }

  /**
   * record where the vector came from: without it a row can carry a vector with
   * embedding_model null while embed_state still claims 'fresh'. snapshot.ts reads
   * the same columns to decide staleness.
   */
  private recordVectorProvenance(id: string, vecRowid: number): void {
    this.stmtRecordVector.run(vecRowid, MODEL_ID, EMBEDDING_DIM, id)
  }

  /** zettelkasten linking, after a-mem (arxiv 2502.12110) */
  private async _autoLink(
    newId: string,
    embedding: Float32Array,
    precomputed?: KnnNeighbour[] | null
  ): Promise<void> {
    try {
      const vecResults = precomputed ?? this._knnNeighbours(embedding)

      const toLink = vecResults.filter(
        (r) => r.id !== newId && r.distance < LINK_DISTANCE_THRESHOLD
      )

      if (toLink.length === 0) return

      const insertLink = this.db.prepare(
        `INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      const now = Date.now()

      // on unit vectors: cos = 1 - l2²/2
      for (const { id: targetId, distance } of toLink) {
        const sim = Math.max(0, 1 - (distance * distance) / 2)
        insertLink.run(newId, targetId, sim, 'semantic', now)
        insertLink.run(targetId, newId, sim, 'semantic', now)
      }
    } catch {
      // best effort: a link failure never fails the write
    }
  }

  getById(id: string): Memory | null {
    const row = this.stmtGetById.get(id) as MemoryRow | undefined
    return row ? rowToMemory(row) : null
  }

  /**
   * the manual revision-chain member current at asOf: only revision > 0 edges count, and
   * only once judged (COALESCE(judged_at, created_at) <= asOf), so an adjudicated
   * supersession never makes a foreign row look like this id's row.
   */
  getByIdAt(id: string, asOf: number): Memory | null {
    if (!this.getById(id)) return null

    // walk manual revision edges in both directions, so any chain member can be the
    // entry point (chainVersion itself walks successor → predecessor)
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
        // an edge judged after asOf did not exist yet
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

    // one transaction, or a throw halfway leaves orphans: links and entities
    // cascade, the fts table is wiped by the after-delete trigger, but memory_vectors
    // (vec0) and memory_clusters.member_ids have no fk and are cleaned by hand
    const tx = this.db.transaction((memoryId: string, vecRowid: number | null) => {
      // the audit row goes in inside the transaction, before the memory disappears;
      // memory_events has no fk, so the trail outlives the row
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
          // best effort: an orphan vec row is harmless, since the join in _autoLink
          // and _vectorSearch needs vec_rowid to reach it
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
          // a cluster with fewer than 2 members carries no community signal; drop it
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
        conditions.push(
          notSupersededAtClause('memories.id', '?', {
            includeArchived: filters.include_archived === true,
          })
        )
        values.push(filters.as_of)
      } else {
        conditions.push(
          notSupersededClause('memories.id', { includeArchived: filters.include_archived === true })
        )
      }
    } else if (!filters.include_archived) {
      // archived is not superseded: asking for superseded rows is an audit request,
      // never a request to resurrect a retired row. include_archived opts in.
      conditions.push('memories.archived_at IS NULL')
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = filters.limit ?? 20
    values.push(limit)

    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values) as MemoryRow[]

    let memories = rows.map(rowToMemory)

    // tags are stored as a json array, so the filter runs in-process
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
    // a no-op guard: identical pin state neither mutates nor fabricates an event
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
      // a pin decides which rows the digest is built from, so refresh here or a
      // store-path pin keeps serving the old set. fire and forget: pinning stays
      // sync-cheap, and refreshDigest is hash-guarded and never throws
      const digestNamespace = before.namespace ?? before.project_path
      void refreshDigest(this.db, digestNamespace).catch((err) => {
        logger.debug({ err, memoryId: id }, 'digest: refresh after pin change failed')
      })
    }
    return result.changes > 0
  }

  setValidUntil(id: string, timestamp: number): void {
    const before = this.getById(id)
    if (!before) return
    // `COALESCE` never moves an earlier close, so a bounded row is a no-op
    // with no event
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
      const tagsJson = JSON.stringify(patch.tags)
      sets.push('tags = ?', 'ident_text = ?')
      // the trigger re-indexes on tags, so ident_text moves in the same statement
      values.push(tagsJson, normalizeIdentifiers(`${before.content} ${tagsJson}`))
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
      // metadata only, never content. an event is written only when a field really
      // changed, and it names the row's provenance
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

  /** linked memories, strongest similarity first */
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

    // a pair can carry several link types (migration 012). rows arrive ordered by
    // similarity, so the first row per target is the strongest edge and no memory
    // shows up twice
    const seen = new Set<string>()
    const related: Array<Memory & { similarity: number; link_type: LinkType }> = []
    for (const row of rows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      related.push({ ...rowToMemory(row), similarity: row.similarity, link_type: row.link_type })
    }
    return related
  }

  /**
   * 1-based depth of the manual revision chain ending at id. an edge points
   * successor → predecessor, so walk backward along revision > 0 edges;
   * adjudicated links (revision = 0) are not part of the chain. cycle-bounded.
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
   * invariant: a statement that writes content or tags on a memories row, or entity_text
   * on a memory_entities row, must set ident_text in the same statement. the after-update
   * trigger re-indexes from new.ident_text, so skipping it indexes the old text.
   */
  /**
   * append-only revision: a new row, a confidence=1 supersedes edge, the predecessor's
   * window closed, the pin moved over, and shareable not inherited. one transaction; null
   * when the predecessor is gone.
   */
  async revise(input: ReviseMemoryInput): Promise<RevisionResult | null> {
    const version = this.chainVersion(input.id)

    // re-read inside the transaction: two interleaved revises must not both see an
    // open row and mint a successor — the second read sees it closed
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
              created_at, valid_from, procedure_meta, importance_source, pinned, shareable, origin,
              ident_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          origin,
          normalizeIdentifiers(`${input.content} ${JSON.stringify(tags)}`)
        )

      // the predecessor keeps its own rows; this is append-only
      this.db
        .prepare(
          `INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at, ident_text)
           SELECT ?, entity_text, entity_type, created_at, ident_text
           FROM memory_entities WHERE memory_id = ?`
        )
        .run(newId, prevRow.id)

      // insert or ignore, so an adjudicated link for the same pair survives
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_links
             (source_id, target_id, similarity, link_type, created_at, confidence, reason,
              decider_model, prompt_version, judged_at, revision)
           VALUES (?, ?, 1.0, 'supersedes', ?, 1.0, ?, 'manual', 'revision-v1', ?, ?)`
        )
        .run(newId, prevRow.id, now, input.reason ?? 'manual revision', now, successorVersion)

      // never move an earlier close
      this.db
        .prepare('UPDATE memories SET valid_until = COALESCE(valid_until, ?) WHERE id = ?')
        .run(now, prevRow.id)

      // the pin moves to the new version, so project_digests refresh from current
      // content, not the retired row
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

    // best effort, as in store()
    if (this.vectorsAvailable) {
      try {
        const embedding = await getEmbedding(input.content)
        if (embedding) {
          const vecInfo = this.db
            .prepare('INSERT INTO memory_vectors(embedding) VALUES (?)')
            .run(Buffer.from(embedding.buffer))
          const vecRowid = Number(vecInfo.lastInsertRowid)
          this.recordVectorProvenance(newId, vecRowid)
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
   * bounded bidirectional bfs over supersedes edges, ignoring confidence: history
   * is audit, not recall. members come back oldest-first, plus the links between
   * them. as_of filters to the historical view.
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
