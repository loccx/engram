import type Database from 'better-sqlite3'
import {
  MEMORIES_IDENT_FTS,
  MEMORY_ENTITY_FTS,
  lexicalIndexReady,
  normalizeIdentifiers,
} from '../lexical-index.js'
import { columnExists } from '../migrations/types.js'
import { clearScopeStatsCache } from '../../memory/search/scoped-stats.js'

export interface LexicalBackfillStats {
  memoryRows: number
  entityRows: number
  memoryIdents: number
  entityIdents: number
  /** bounded units of work (both phases, both tables) */
  batches: number
  durationMs: number
}

export interface LexicalBackfillOptions {
  /** bounded so a cold index never blocks startup for long */
  batchSize?: number
  /** cooperative pause between batches (0 in tests) */
  pauseMs?: number
  log?: (msg: string) => void
}

// fills the identifier index and the ident_text column for rows that predate
// them. idempotent by construction: phase 1 takes only ident_text IS NULL rows,
// 2a only entries that disagree with the column, 2b only rows with no document,
// so a re-run after a crash or a concurrent write is safe. batches are ordered
// by rowid/id, never by memory.id, which the eval harness mints per run.
export async function backfillLexicalIndex(
  db: Database.Database,
  opts: LexicalBackfillOptions = {}
): Promise<LexicalBackfillStats> {
  const batchSize = Math.max(1, opts.batchSize ?? 500)
  const pauseMs = opts.pauseMs ?? 0
  const log = opts.log ?? (() => undefined)
  const t0 = Date.now()
  const stats: LexicalBackfillStats = {
    memoryRows: 0,
    entityRows: 0,
    memoryIdents: 0,
    entityIdents: 0,
    batches: 0,
    durationMs: 0,
  }

  if (!lexicalIndexReady(db)) {
    log('identifier lexical index missing (migration 012 not applied); skipping backfill')
    stats.durationMs = Date.now() - t0
    return stats
  }

  // a schema that predates 015 has no column to fill. this runs at daemon boot,
  // so an unrecognised schema must be a no-op rather than a throw.
  if (!columnExists(db, 'memories', 'ident_text') || !columnExists(db, 'memory_entities', 'ident_text')) {
    log('identifier index predates migration 015 (no ident_text column); nothing to backfill')
    stats.durationMs = Date.now() - t0
    return stats
  }

  const pause = async (): Promise<void> => {
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
  }

  const backfillIdents = async (
    select: Database.Statement,
    update: Database.Statement,
    key: 'memoryIdents' | 'entityIdents',
    label: string
  ): Promise<void> => {
    for (;;) {
      const rows = select.all(batchSize) as Array<{ rid: number; text: string | null }>
      if (rows.length === 0) break
      const write = db.transaction(() => {
        for (const row of rows) update.run(normalizeIdentifiers(row.text), row.rid)
      })
      write()
      stats[key] += rows.length
      stats.batches += 1
      if (rows.length < batchSize) break
      await pause()
    }
    if (stats[key] > 0) {
      log(`identifier index: computed ident_text for ${stats[key]} ${label} row(s)`)
    }
  }

  // `content || ' ' || tags` is what the 012 trigger expression normalised, so
  // the indexed text is unchanged by moving the normalisation here
  await backfillIdents(
    db.prepare(
      `SELECT rowid AS rid, content || ' ' || tags AS text
       FROM memories
       WHERE ident_text IS NULL
       ORDER BY rowid
       LIMIT ?`
    ),
    db.prepare('UPDATE memories SET ident_text = ? WHERE rowid = ?'),
    'memoryIdents',
    'memory'
  )
  await backfillIdents(
    db.prepare(
      `SELECT id AS rid, entity_text AS text
       FROM memory_entities
       WHERE ident_text IS NULL
       ORDER BY id
       LIMIT ?`
    ),
    db.prepare('UPDATE memory_entities SET ident_text = ? WHERE id = ?'),
    'entityIdents',
    'entity'
  )

  // the comparison also proves the two normalisations agree: a db already indexed
  // by 012's triggers matches everywhere, so an upgrade re-indexes nothing
  const dropMemoryBatch = db.prepare(
    `DELETE FROM ${MEMORIES_IDENT_FTS}
     WHERE rowid IN (
       SELECT m.rowid
       FROM memories m
       JOIN ${MEMORIES_IDENT_FTS} f ON f.rowid = m.rowid
       WHERE m.ident_text IS NOT NULL AND f.ident IS NOT m.ident_text
       ORDER BY m.rowid
       LIMIT ?
     )`
  )
  const dropEntityBatch = db.prepare(
    `DELETE FROM ${MEMORY_ENTITY_FTS}
     WHERE rowid IN (
       SELECT e.id
       FROM memory_entities e
       JOIN ${MEMORY_ENTITY_FTS} f ON f.rowid = e.id
       WHERE e.ident_text IS NOT NULL AND f.ident IS NOT e.ident_text
       ORDER BY e.id
       LIMIT ?
     )`
  )

  // every memory row gets a document, empty while ident_text is still NULL, so
  // the fts table stays a row-for-row mirror of memories
  const memoryBatch = db.prepare(
    `INSERT INTO ${MEMORIES_IDENT_FTS}(rowid, ident)
     SELECT m.rowid, ifnull(m.ident_text, '')
     FROM memories m
     LEFT JOIN ${MEMORIES_IDENT_FTS} f ON f.rowid = m.rowid
     WHERE f.rowid IS NULL
     ORDER BY m.rowid
     LIMIT ?`
  )
  const entityBatch = db.prepare(
    `INSERT INTO ${MEMORY_ENTITY_FTS}(rowid, ident, memory_id)
     SELECT e.id, ifnull(e.ident_text, ''), e.memory_id
     FROM memory_entities e
     LEFT JOIN ${MEMORY_ENTITY_FTS} f ON f.rowid = e.id
     WHERE f.rowid IS NULL
     ORDER BY e.id
     LIMIT ?`
  )

  const runBatches = async (
    stmt: Database.Statement,
    key: 'memoryRows' | 'entityRows',
    label: string,
    verb: 'indexed' | 'repaired'
  ): Promise<void> => {
    let total = 0
    for (;;) {
      const info = stmt.run(batchSize)
      stats.batches += 1
      const changes = Number(info.changes)
      total += changes
      if (verb === 'indexed') stats[key] += changes
      if (changes < batchSize) break
      await pause()
    }
    if (total > 0) log(`identifier index: ${verb} ${total} ${label} row(s)`)
  }

  await runBatches(dropMemoryBatch, 'memoryRows', 'memory', 'repaired')
  await runBatches(dropEntityBatch, 'entityRows', 'entity', 'repaired')
  await runBatches(memoryBatch, 'memoryRows', 'memory', 'indexed')
  await runBatches(entityBatch, 'entityRows', 'entity', 'indexed')

  // the four batches above write the fts tables directly: no epoch trigger can sit on a
  // virtual table, and the daemon serves while this runs, so any count warmed meanwhile is
  // now behind the index it described
  clearScopeStatsCache()

  stats.durationMs = Date.now() - t0
  if (stats.batches > 1 || stats.memoryRows + stats.entityRows > 0) {
    log(
      `identifier index backfill complete: ${stats.memoryRows} memory + ${stats.entityRows} entity rows ` +
        `indexed, ${stats.memoryIdents} + ${stats.entityIdents} ident_text filled ` +
        `in ${stats.batches} batch(es), ${stats.durationMs}ms`
    )
  }
  return stats
}
