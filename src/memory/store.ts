import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  Memory,
  StoreMemoryInput,
  UpdateMemoryPatch,
  ListMemoriesFilter,
  LinkType,
  ImportanceSource,
  ExtractedEntity,
} from './types.js'
import { rowToMemory, type MemoryRow } from './row.js'
import { getEmbedding, LINK_DISTANCE_THRESHOLD } from '../embeddings/pipeline.js'
import type { AdjudicationQueue } from '../contradictions/queue.js'
import { withTimeout } from '../contradictions/queue.js'
import { notSupersededClause } from '../contradictions/supersession.js'
import type { BackgroundJobQueue } from '../queue/background-queue.js'
import { extractEntities } from './entities.js'

const ADJUDICATE_SYNC_TIMEOUT_MS = 2000

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
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, procedure_meta, importance_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      importanceSource
    )

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
      } catch {
        // Embeddings are best-effort; FTS5 search still works
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
    if (!filters.include_superseded) {
      conditions.push(notSupersededClause('memories.id'))
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
    const result = this.stmtSetPinned.run(pinned ? 1 : 0, id)
    return result.changes > 0
  }

  setValidUntil(id: string, timestamp: number): void {
    this.stmtSetValidUntil.run(timestamp, id)
  }

  update(id: string, patch: UpdateMemoryPatch): boolean {
    const sets: string[] = []
    const values: unknown[] = []
    if (patch.type !== undefined) {
      sets.push('type = ?')
      values.push(patch.type)
    }
    if (patch.importance !== undefined) {
      sets.push('importance = ?', "importance_source = 'user'")
      values.push(patch.importance)
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?')
      values.push(JSON.stringify(patch.tags))
    }
    if (patch.valid_until !== undefined) {
      sets.push('valid_until = ?')
      values.push(patch.valid_until)
    }
    if (sets.length === 0) return false
    values.push(id)
    const result = this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values)
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
    options: { include_superseded?: boolean } = {}
  ): Memory[] {
    const conditions = ['me.entity_text = ? COLLATE NOCASE']
    if (!options.include_superseded) {
      conditions.push(notSupersededClause('m.id'))
    }
    const values: unknown[] = [entityText]
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
    options: { include_superseded?: boolean } = {}
  ): Array<Memory & { similarity: number; link_type: LinkType }> {
    const supersededFilter = options.include_superseded
      ? ''
      : ` AND ${notSupersededClause('m.id')}`

    const rows = this.db
      .prepare(
        `SELECT m.*, ml.similarity, ml.link_type
         FROM memory_links ml
         JOIN memories m ON m.id = ml.target_id
         WHERE ml.source_id = ?${supersededFilter}
         ORDER BY ml.similarity DESC
         LIMIT ?`
      )
      .all(id, limit) as Array<MemoryRow & { similarity: number; link_type: LinkType }>

    return rows.map((row) => ({ ...rowToMemory(row), similarity: row.similarity, link_type: row.link_type }))
  }
}
