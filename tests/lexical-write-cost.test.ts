import { describe, it, expect } from 'vitest'
import type Database from 'better-sqlite3'
import { DatabaseManager } from '../src/db/init.js'
import { MemoryStore } from '../src/memory/store.js'
import { MEMORIES_IDENT_FTS, MEMORY_ENTITY_FTS } from '../src/db/lexical-index.js'

// write-cost guard for the identifier index. correctness tests cannot see this:
// the pre-015 triggers charged the writer per character, so this measures a
// ratio to a no-index control instead of a wall-clock number a slow box would
// fail. the absolute bound is only headroom against a "fast machine".
const CONTENT_CHARS = 8_000
const ROUNDS = 3
const WRITES_PER_ROUND = 12
const MAX_MS_PER_WRITE = 20
const MAX_RATIO = 4

const PROJECT = '/perf/engram'

function longContent(chars: number): string {
  const base =
    'The retrieval path calls hybridSearch in src/memory/search/hybrid.ts, which fuses ftsSearch and vectorSearch ' +
    'through assignRrfScores, then applies WEIGHT_PROFILES from scoring.ts before the cross-encoder reranker runs. ' +
    'memory_ident_fts carries identifier-normalised text so camelCase identifiers such as traverseGraph are findable. '
  let out = ''
  while (out.length < chars) out += base
  return out.slice(0, chars)
}

function makeDb(withIdentIndex: boolean): Database.Database {
  const db = new DatabaseManager(':memory:').db
  if (!withIdentIndex) {
    for (const name of [MEMORIES_IDENT_FTS, MEMORY_ENTITY_FTS]) db.exec(`DROP TABLE ${name}`)
    for (const name of [MEMORIES_IDENT_FTS, MEMORY_ENTITY_FTS]) {
      for (const suffix of ['insert', 'update', 'delete']) {
        db.exec(`DROP TRIGGER IF EXISTS ${name}_${suffix}`)
      }
    }
  }
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    'perf',
    PROJECT,
    Date.now()
  )
  return db
}

// best-of-ROUNDS: a timing can only be inflated by load
async function perWriteMs(db: Database.Database): Promise<number> {
  const store = new MemoryStore(db, false)
  const content = longContent(CONTENT_CHARS)
  const write = (i: number): Promise<unknown> =>
    store.store({
      content: `${content} [row ${i}]`,
      session_id: 'perf',
      project_path: PROJECT,
      type: 'note',
      tags: ['perf', 'hybridSearch'],
    })

  await write(0) // warm up the prepared statements

  let best = Number.POSITIVE_INFINITY
  for (let round = 0; round < ROUNDS; round++) {
    const t0 = performance.now()
    for (let i = 0; i < WRITES_PER_ROUND; i++) await write(round * WRITES_PER_ROUND + i)
    best = Math.min(best, (performance.now() - t0) / WRITES_PER_ROUND)
  }
  return best
}

describe('identifier index write cost (8 KB memories)', () => {
  it('adds a small, size-independent cost over a no-ident-index control', async () => {
    const control = makeDb(false)
    const indexed = makeDb(true)
    try {
      const controlMs = await perWriteMs(control)
      const indexedMs = await perWriteMs(indexed)

      // never silent on a failing box
      console.log(
        `identifier index write cost @${CONTENT_CHARS} chars: control ${controlMs.toFixed(2)} ms/write, ` +
          `indexed ${indexedMs.toFixed(2)} ms/write (ratio ${(indexedMs / controlMs).toFixed(2)})`
      )

      expect(indexedMs).toBeLessThan(MAX_MS_PER_WRITE)
      expect(indexedMs).toBeLessThan(controlMs * MAX_RATIO + 1)
    } finally {
      control.close()
      indexed.close()
    }
  })
})
