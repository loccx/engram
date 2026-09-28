import type Database from 'better-sqlite3'

export interface BackfillStats {
  totalUpdated: number
  batches: number
  durationMs: number
}

export interface BackfillOptions {
  batchSize?: number
  pauseMs?: number
  log?: (msg: string) => void
}

export async function backfillNamespaces(
  db: Database.Database,
  opts: BackfillOptions = {}
): Promise<BackfillStats> {
  const batchSize = opts.batchSize ?? 200
  const pauseMs = opts.pauseMs ?? 100
  const log = opts.log ?? (() => undefined)
  const t0 = Date.now()
  const stats: BackfillStats = { totalUpdated: 0, batches: 0, durationMs: 0 }

  const update = db.prepare(`
    UPDATE memories
    SET namespace = project_path
    WHERE rowid IN (
      SELECT rowid FROM memories
      WHERE namespace IS NULL
      LIMIT ?
    )
  `)

  while (true) {
    const info = update.run(batchSize)
    if (info.changes === 0) break
    stats.totalUpdated += info.changes
    stats.batches += 1
    if (info.changes < batchSize) break
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs))
  }

  stats.durationMs = Date.now() - t0
  if (stats.totalUpdated > 0) {
    log(
      `namespace backfill complete: ${stats.totalUpdated} rows in ${stats.batches} batch(es), ${stats.durationMs}ms`
    )
  }
  return stats
}
