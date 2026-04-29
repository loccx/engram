import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  Memory,
  StoreMemoryInput,
  ListMemoriesFilter,
  MemoryType,
  LinkType,
  ImportanceSource,
} from './types.js'
import { getEmbedding, LINK_DISTANCE_THRESHOLD } from '../embeddings/pipeline.js'
import type { AdjudicationQueue } from '../contradictions/queue.js'
import { withTimeout } from '../contradictions/queue.js'
import { notSupersededClause } from '../contradictions/supersession.js'
import type { BackgroundJobQueue } from '../queue/background-queue.js'

const ADJUDICATE_SYNC_TIMEOUT_MS = 2000

interface MemoryRow {
  id: string
  session_id: string
  project_path: string
  content: string
  type: string
  importance: number
  tags: string
  created_at: number
  last_accessed: number | null
  access_count: number
  vec_rowid: number | null
  importance_source?: string | null
  importance_model?: string | null
  importance_prompt_version?: string | null
  importance_scored_at?: number | null
}

function rowToMemory(row: MemoryRow): Memory {
  const memory: Memory = {
    id: row.id,
    session_id: row.session_id,
    project_path: row.project_path,
    content: row.content,
    type: row.type as MemoryType,
    importance: row.importance,
    tags: JSON.parse(row.tags) as string[],
    created_at: row.created_at,
    last_accessed: row.last_accessed,
    access_count: row.access_count,
    vec_rowid: row.vec_rowid,
  }
  if (row.importance_source != null) {
    memory.importance_source = row.importance_source as ImportanceSource
  }
  if (row.importance_model !== undefined) memory.importance_model = row.importance_model
  if (row.importance_prompt_version !== undefined) {
    memory.importance_prompt_version = row.importance_prompt_version
  }
  if (row.importance_scored_at !== undefined) {
    memory.importance_scored_at = row.importance_scored_at
  }
  return memory
}

export class MemoryStore {
  constructor(
    private readonly db: Database.Database,
    private readonly vectorsAvailable: boolean = false,
    private readonly adjudicationQueue: AdjudicationQueue | null = null,
    private readonly importanceQueue: BackgroundJobQueue<string> | null = null
  ) {}

  async store(input: StoreMemoryInput): Promise<Memory> {
    const id = randomUUID()
    const now = Date.now()
    const tags = JSON.stringify(input.tags ?? [])
    const type = input.type ?? 'note'
    const importance = input.importance ?? 0.5
    const importanceSource: ImportanceSource = input.importanceProvided ? 'user' : 'default'

    this.db
      .prepare(
        `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, importance_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.session_id,
        input.project_path,
        input.project_path,
        input.content,
        type,
        importance,
        tags,
        now,
        importanceSource
      )

    // Compute embedding and link to related memories (non-blocking on failure)
    if (this.vectorsAvailable) {
      try {
        const embedding = await getEmbedding(input.content)
        if (embedding) {
          // Insert into vec0 — capture rowid directly from run() to avoid
          // interference from FTS5 triggers that also issue INSERTs
          const vecInfo = this.db
            .prepare('INSERT INTO memory_vectors(embedding) VALUES (?)')
            .run(JSON.stringify(Array.from(embedding)))
          const vecRowid = Number(vecInfo.lastInsertRowid)
          this.db.prepare('UPDATE memories SET vec_rowid = ? WHERE id = ?').run(vecRowid, id)

          // Auto-link to semantically similar memories (Zettelkasten)
          await this._autoLink(id, vecRowid, embedding)
        }
      } catch {
        // Embeddings are best-effort; FTS5 search still works
      }
    }

    if (this.adjudicationQueue) {
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
  private async _autoLink(newId: string, newVecRowid: number, embedding: Float32Array): Promise<void> {
    const queryVec = JSON.stringify(Array.from(embedding))
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
    const row = this.db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(id) as MemoryRow | undefined
    return row ? rowToMemory(row) : null
  }

  delete(id: string): boolean {
    // Clean up vector index entry before deleting the memory
    const mem = this.getById(id)
    if (mem?.vec_rowid != null) {
      try {
        this.db.prepare('DELETE FROM memory_vectors WHERE rowid = ?').run(mem.vec_rowid)
      } catch {
        // Vec cleanup is best-effort
      }
    }
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return result.changes > 0
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
    this.db
      .prepare('UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?')
      .run(Date.now(), id)
  }

  setPinned(id: string, pinned: boolean): boolean {
    const result = this.db
      .prepare('UPDATE memories SET pinned = ? WHERE id = ?')
      .run(pinned ? 1 : 0, id)
    return result.changes > 0
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
