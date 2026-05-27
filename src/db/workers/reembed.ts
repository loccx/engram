import type Database from 'better-sqlite3'
import { getEmbedding, EMBEDDING_DIM } from '../../embeddings/pipeline.js'

export interface ReembedStats {
  totalReembedded: number
  failed: number
  batches: number
  durationMs: number
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
