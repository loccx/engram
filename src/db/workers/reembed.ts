import type Database from 'better-sqlite3'
import { getEmbedding, EMBEDDING_DIM } from '../../embeddings/pipeline.js'

export interface ReembedStats {
  totalReembedded: number
  failed: number
  batches: number
  durationMs: number
  /** rows still waiting for a vector when this run stopped (bounded runs leave them) */
  remaining?: number
}

export interface ReembedOptions {
  batchSize?: number
  pauseMs?: number
  log?: (msg: string) => void
  embedder?: (text: string) => Promise<Float32Array | null>
}

interface StaleRow {
  id: string
  content: string
  vec_rowid: number | null
}

/** one call per text, the vector a stored row must carry; injectable for tests */
let defaultEmbedder: (text: string) => Promise<Float32Array | null> = (text) =>
  getEmbedding(text, 'document')

export function setReembedEmbedder(embedder: ((text: string) => Promise<Float32Array | null>) | null): void {
  defaultEmbedder = embedder ?? ((text: string) => getEmbedding(text, 'document'))
}

export interface EpisodeReembedOptions {
  batchSize?: number
  pauseMs?: number
  log?: (msg: string) => void
  /** one call per episode, the default: the stored vector is what getEmbedding returns */
  embedder?: (text: string) => Promise<Float32Array | null>
  /** opt-in throughput path; batched rows are not vector-identical to the default */
  batchEmbedder?: (texts: string[]) => Promise<Array<Float32Array | null>>
  /** rows to embed before returning; the maintenance job bounds its turn with this */
  limit?: number
}

/**
 * the evidence backlog of a deferred ingest: episodes written lexically while
 * embed_state sat at 'stale' get their vectors here, one episode at a time by default.
 * runs on the maintenance pass, so nothing on a write path waits for a model.
 */
export async function reembedStaleEpisodes(
  db: Database.Database,
  modelId: string,
  opts: EpisodeReembedOptions = {}
): Promise<ReembedStats> {
  const batchSize = opts.batchSize ?? 32
  const pauseMs = opts.pauseMs ?? 50
  const limit = opts.limit ?? Number.POSITIVE_INFINITY
  const log = opts.log ?? (() => undefined)
  const embed = opts.embedder ?? defaultEmbedder
  const embedBatch =
    opts.batchEmbedder ?? ((texts: string[]) => Promise.all(texts.map((text) => embed(text))))
  const t0 = Date.now()
  const stats: ReembedStats = { totalReembedded: 0, failed: 0, batches: 0, durationMs: 0 }

  // vec0 exists only where sqlite-vec loaded; without it the rows stay stale on purpose
  const table = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'episode_vectors'")
    .get() as { present: number } | undefined
  if (!table) {
    stats.durationMs = Date.now() - t0
    return stats
  }

  const claim = db.prepare(`
    UPDATE episodes
    SET embed_state = 'pending'
    WHERE id IN (
      SELECT id FROM episodes
      WHERE embed_state = 'stale'
      LIMIT ?
    )
    RETURNING id, content, vec_rowid
  `)

  const insertVec = db.prepare('INSERT INTO episode_vectors (embedding) VALUES (?)')
  const deleteVec = db.prepare('DELETE FROM episode_vectors WHERE rowid = ?')
  const markFresh = db.prepare(`
    UPDATE episodes
    SET embed_state = 'fresh', vec_rowid = ?, embedding_model = ?, embedding_dim = ?
    WHERE id = ?
  `)
  const markError = db.prepare("UPDATE episodes SET embed_state = 'error' WHERE id = ?")

  while (true) {
    const left = limit - (stats.totalReembedded + stats.failed)
    if (left <= 0) break
    const claimed = claim.all(Math.min(batchSize, left)) as StaleRow[]
    if (claimed.length === 0) break
    stats.batches += 1

    let vectors: Array<Float32Array | null> = []
    try {
      vectors = await embedBatch(claimed.map((row) => row.content))
    } catch (err) {
      log(`claiming episodes for re-embed failed: ${(err as Error).message}`)
      for (const row of claimed) {
        markError.run(row.id)
        stats.failed += 1
      }
      if (claimed.length < batchSize) break
      continue
    }

    claimed.forEach((row, position) => {
      const vec = vectors[position]
      if (!vec || vec.length !== EMBEDDING_DIM) {
        markError.run(row.id)
        stats.failed += 1
        return
      }
      if (row.vec_rowid !== null) {
        try { deleteVec.run(row.vec_rowid) } catch { /* orphan cleanup may race */ }
      }
      const info = insertVec.run(Buffer.from(vec.buffer))
      markFresh.run(Number(info.lastInsertRowid), modelId, EMBEDDING_DIM, row.id)
      stats.totalReembedded += 1
    })

    if (claimed.length < Math.min(batchSize, left)) break
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs))
  }

  // a bounded run leaves the rest claimable: the queue re-arms on the next enqueue
  stats.remaining = (
    db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE embed_state IN ('stale', 'pending')")
      .get() as { n: number }
  ).n

  stats.durationMs = Date.now() - t0
  if (stats.totalReembedded > 0 || stats.failed > 0) {
    log(
      `episode re-embed complete: ${stats.totalReembedded} succeeded, ${stats.failed} failed, ${stats.batches} batches, ${stats.durationMs}ms`
    )
  }
  return stats
}

export async function reembedStaleMemories(
  db: Database.Database,
  modelId: string,
  opts: ReembedOptions = {}
): Promise<ReembedStats> {
  const batchSize = opts.batchSize ?? 32
  const pauseMs = opts.pauseMs ?? 50
  const log = opts.log ?? (() => undefined)
  const embed = opts.embedder ?? ((text: string) => getEmbedding(text, 'document'))
  const t0 = Date.now()
  const stats: ReembedStats = { totalReembedded: 0, failed: 0, batches: 0, durationMs: 0 }

  const claim = db.prepare(`
    UPDATE memories
    SET embed_state = 'pending'
    WHERE id IN (
      SELECT id FROM memories
      WHERE embed_state = 'stale'
      LIMIT ?
    )
    RETURNING id, content, vec_rowid
  `)

  const insertVec = db.prepare('INSERT INTO memory_vectors (embedding) VALUES (?)')
  const deleteVec = db.prepare('DELETE FROM memory_vectors WHERE rowid = ?')
  const markFresh = db.prepare(`
    UPDATE memories
    SET embed_state = 'fresh', vec_rowid = ?, embedding_model = ?, embedding_dim = ?
    WHERE id = ?
  `)
  const markError = db.prepare("UPDATE memories SET embed_state = 'error' WHERE id = ?")

  while (true) {
    const claimed = claim.all(batchSize) as StaleRow[]
    if (claimed.length === 0) break
    stats.batches += 1

    for (const row of claimed) {
      try {
        const vec = await embed(row.content)
        if (!vec || vec.length !== EMBEDDING_DIM) {
          markError.run(row.id)
          stats.failed += 1
          continue
        }
        if (row.vec_rowid !== null) {
          try { deleteVec.run(row.vec_rowid) } catch { /* orphan cleanup may race */ }
        }
        const info = insertVec.run(Buffer.from(vec.buffer))
        markFresh.run(Number(info.lastInsertRowid), modelId, EMBEDDING_DIM, row.id)
        stats.totalReembedded += 1
      } catch (err) {
        log(`re-embed failed for memory ${row.id}: ${(err as Error).message}`)
        markError.run(row.id)
        stats.failed += 1
      }
    }

    if (claimed.length < batchSize) break
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs))
  }

  stats.durationMs = Date.now() - t0
  if (stats.totalReembedded > 0 || stats.failed > 0) {
    log(
      `re-embed complete: ${stats.totalReembedded} succeeded, ${stats.failed} failed, ${stats.batches} batches, ${stats.durationMs}ms`
    )
  }
  return stats
}
