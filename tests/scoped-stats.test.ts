import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { MemorySearch, type SearchOptions } from '../src/memory/search.js'
import {
  MEMORIES_IDENT_FTS,
  MEMORY_ENTITY_FTS,
  normalizeIdentifiers,
} from '../src/db/lexical-index.js'
import { backfillLexicalIndex } from '../src/db/workers/lexical-backfill.js'
import { ingestEpisodes } from '../src/memory/episodes.js'
import { searchEpisodes, type EpisodeSearchOptions } from '../src/memory/search/episodes.js'
import { retrieveEpisodeContext } from '../src/memory/episode-context.js'
import { namespaceFilter } from '../src/memory/search/scope.js'
import { notSupersededClause } from '../src/contradictions/supersession.js'
import {
  combineFilters,
  quotedTerms,
  scoreTokens,
  scopeNarrowing,
  scopeStats,
  scopedBm25,
  type ChannelSpec,
} from '../src/memory/search/scoped-stats.js'
import { createTestDb } from './helpers.js'

// scope-local lexical statistics: a scoped query's ids, order and scores have to be a
// function of the rows inside the scope alone. fts5's bm25 derives idf (and avgdl) from
// the whole index, so rows in an unrelated namespace reshuffle another namespace's hits.
const PROBE = '/probe/q1'
const OTHER = '/other//turns'
const SESSION = 'scope-session'
const NOW = 1_800_000_000_000
const QUERY = 'deploy window golden fixture'

interface Hit {
  id: string
  order: number
  score: number
  relevance: number
}

let db: Database.Database
let search: MemorySearch

function insertMemory(
  id: string,
  namespace: string,
  content: string,
  tags: string[] = [],
  store: Database.Database = db
): void {
  const tagJson = JSON.stringify(tags)
  store.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, ident_text)
     VALUES (?, ?, ?, ?, ?, 'note', 0.5, ?, ?, ?, ?)`
  ).run(
    id,
    SESSION,
    namespace,
    namespace,
    content,
    tagJson,
    NOW,
    NOW,
    normalizeIdentifiers(`${content} ${tagJson}`)
  )
}

function insertEntity(memoryId: string, entityText: string, store: Database.Database = db): void {
  store
    .prepare(
      'INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at, ident_text) VALUES (?, ?, ?, ?, ?)'
    )
    .run(memoryId, entityText, 'identifier', NOW, normalizeIdentifiers(entityText))
}

/**
 * the four golden rows the scope query ranks, plus filler that shares no query term:
 * without the filler every query term's scope df already exceeds half the index, so
 * the clamped regime hides the leak behind the coverage fallback.
 */
function golden(store: Database.Database = db): void {
  insertMemory('g1', PROBE, 'the deploy window for the golden fixture is 09:00-11:30 utc', ['deploy'], store)
  insertMemory('g2', PROBE, 'the rollback drill for the golden fixture follows the deploy window', ['deploy'], store)
  insertMemory('g3', PROBE, 'the pricing table for the golden fixture lives in a spreadsheet', ['pricing'], store)
  insertMemory('g4', PROBE, 'the deploy window rota for the golden fixture is posted weekly', ['deploy'], store)
  insertEntity('g1', 'deployWindow', store)
  insertEntity('g2', 'deployWindow', store)
  insertEntity('g3', 'goldenFixture', store)
  insertEntity('g4', 'deployWindow', store)
  for (let i = 0; i < 24; i++) {
    insertMemory(`filler-${i}`, PROBE, `scope note ${i} about the caching layer and its eviction policy`, [], store)
  }
}

/** rows another team's namespace grew into; they share the query's terms */
function otherNamespaceRows(
  count: number,
  tag: string,
  terms: string = 'deploy window golden fixture',
  store: Database.Database = db
): void {
  for (let i = 0; i < count; i++) {
    insertMemory(`other-${tag}-${i}`, OTHER, `turn ${i}: the ${terms} was discussed again`, ['deploy'], store)
    insertEntity(`other-${tag}-${i}`, 'deployWindow', store)
  }
}

/** a second store with the same rows, and therefore a statistics cache that has counted nothing */
function mirror(): Database.Database {
  const twin = createTestDb().db
  twin
    .prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)')
    .run(SESSION, PROBE, NOW)
  golden(twin)
  return twin
}

async function snapshotOn(
  instance: MemorySearch,
  options: SearchOptions,
  query: string = QUERY
): Promise<Hit[]> {
  const results = await instance.hybridSearch(query, {
    namespace_subtree: PROBE,
    limit: 10,
    now: NOW,
    touch: false,
    ...options,
  })
  return results.map((r, order) => ({
    id: r.id,
    order,
    score: Number(r.score.toFixed(9)),
    relevance: Number(r.relevance.toFixed(9)),
  }))
}

async function snapshot(options: SearchOptions, query: string = QUERY): Promise<Hit[]> {
  return snapshotOn(search, options, query)
}

function ids(hits: Hit[]): string[] {
  return hits.map((h) => h.id)
}

function report(label: string, before: Hit[], after: Hit[]): void {
  console.log(`${label}\n  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(after)}`)
}

const CHANNELS: Array<[string, SearchOptions]> = [
  ['fts', {}],
  ['ident', { ident_channel: true }],
  ['entity', { entity_channel: true }],
  ['every channel, expanded', { ident_channel: true, entity_channel: true, expand: true }],
]

beforeEach(() => {
  db = createTestDb().db
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    SESSION,
    PROBE,
    NOW
  )
  search = new MemorySearch(db, false)
  golden()
})

describe('scoped lexical statistics', () => {
  it('the probe namespace ranks the same four rows before any other namespace grows', async () => {
    for (const [label, options] of CHANNELS) {
      const hits = await snapshot(options)
      expect(ids(hits), label).toContain('g1')
      expect(ids(hits), label).toContain('g4')
    }
  })

  for (const [label, options] of CHANNELS) {
    it(`${label}: ids, order and scores ignore rows added to another namespace`, async () => {
      const before = await snapshot(options)
      otherNamespaceRows(400, 'seed')
      const after = await snapshot(options)
      report(`${label} — 400 rows in ${OTHER}`, before, after)
      expect(after).toEqual(before)
    })

    it(`${label}: ignore a small growth in another namespace that only shifts idf`, async () => {
      const before = await snapshot(options)
      otherNamespaceRows(40, 'thin', 'deploy')
      const after = await snapshot(options)
      report(`${label} — 40 rows sharing one term in ${OTHER}`, before, after)
      expect(after).toEqual(before)
    })

    it(`${label}: ids, order and scores ignore rows deleted from another namespace`, async () => {
      otherNamespaceRows(400, 'gone')
      const before = await snapshot(options)
      db.prepare('DELETE FROM memories WHERE namespace = ?').run(OTHER)
      const after = await snapshot(options)
      expect(after).toEqual(before)
    })

    it(`${label}: ids, order and scores ignore rows archived in another namespace`, async () => {
      otherNamespaceRows(400, 'archived')
      const before = await snapshot(options)
      db.prepare('UPDATE memories SET archived_at = ? WHERE namespace = ?').run(NOW, OTHER)
      const after = await snapshot(options)
      expect(after).toEqual(before)
    })
  }

  it('ranks a scope with fts5\u2019s own bm25 when the scope is the whole index', () => {
    // the point of keeping k1, b, the column weights and fts5's own idf: inside one
    // namespace the scope-local score has to reproduce what fts5 scored, or the tuning
    // that came from fts5 stops applying. the residual is the length being characters
    const terms = quotedTerms('"deploy"')
    const spec: ChannelSpec = {
      table: 'memories_fts',
      from: 'memories_fts f JOIN memories m ON f.rowid = m.rowid',
      dfExpr: 'COUNT(*)',
      weights: [10, 5],
      prefix: false,
    }
    const spec2 = spec
    const predicates = combineFilters([
      { sql: 'COALESCE(m.namespace, m.project_path) = ?', params: [PROBE] },
    ])
    const stats = scopeStats(db, { project_path: PROBE }, { predicates, narrowing: scopeNarrowing({ project_path: PROBE }) }, spec2, terms)
    for (const id of ['g1', 'g2', 'g4']) {
      const row = db.prepare('SELECT content, tags, ' + 'length(COALESCE(content, \'\')) + length(COALESCE(tags, \'\')) AS dl FROM memories WHERE id = ?').get(id) as { content: string; tags: string; dl: number }
      const scoped = scopedBm25({
        terms,
        tokens: [scoreTokens(row.content), scoreTokens(row.tags)],
        dl: row.dl,
        weights: spec2.weights,
        stats,
        prefix: false,
      })
      const fts = db
        .prepare(
          `SELECT bm25(memories_fts, 10.0, 5.0) AS r FROM memories_fts f JOIN memories m ON f.rowid = m.rowid
           WHERE memories_fts MATCH ? AND m.id = ?`
        )
        .get('"deploy"', id) as { r: number }
      const ratio = scoped / -fts.r
      expect(ratio, `${id} scoped=${scoped} fts5=${-fts.r}`).toBeGreaterThan(0.5)
      expect(ratio, `${id} scoped=${scoped} fts5=${-fts.r}`).toBeLessThan(2)
    }
  })

  it('growth in the scope itself is still allowed to move the scope', async () => {
    const before = await snapshot({})
    insertMemory('g5', PROBE, 'the deploy window for the golden fixture moved to 08:00', ['deploy'])
    const after = await snapshot({})
    expect(after).not.toEqual(before)
    expect(ids(after)).toContain('g5')
  })

  it('a namespace below the scope is in scope, so it may move the scope', async () => {
    const before = await snapshot({})
    for (let i = 0; i < 200; i++) {
      insertMemory(`child-${i}`, `${PROBE}//turns`, `turn ${i}: the deploy window for the golden fixture`)
    }
    const after = await snapshot({})
    expect(after).not.toEqual(before)
  })

  it('does not answer one database from another database\u2019s counts', async () => {
    const here = await snapshot({})
    // the same namespace in a second store, with no filler rows: its scope counts differ
    // from the first store's while its epoch signature over the same namespaces matches,
    // so only a per-connection token keeps the cached counts apart
    const other = createTestDb().db
    other
      .prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)')
      .run(SESSION, PROBE, NOW)
    const stmt = other.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, ident_text)
       VALUES (?, ?, ?, ?, ?, 'note', 0.5, ?, ?, ?, ?)`
    )
    const rows: Array<[string, string, string]> = [
      ['g1', 'the deploy window for the golden fixture is 09:00-11:30 utc', '["deploy"]'],
      ['g2', 'the rollback drill for the golden fixture follows the deploy window', '["deploy"]'],
      ['g3', 'the pricing table for the golden fixture lives in a spreadsheet', '["pricing"]'],
      ['g4', 'the deploy window rota for the golden fixture is posted weekly', '["deploy"]'],
    ]
    // same number of rows, much longer text, none of the query's tokens: the epoch
    // signature over these namespaces is the first store's exactly and the candidate set
    // is the same, so only the scope's own counts can separate the two stores' scores
    for (let i = 0; i < 24; i++) {
      rows.push([`filler-${i}`, `unrelated reference note ${i} ${'padding '.repeat(80)}`, '[]'])
    }
    for (const [id, content, tags] of rows) {
      stmt.run(id, SESSION, PROBE, PROBE, content, tags, NOW, NOW, normalizeIdentifiers(`${content} ${tags}`))
    }
    const there = await new MemorySearch(other, false).hybridSearch(QUERY, {
      namespace_subtree: PROBE,
      limit: 10,
      now: NOW,
      touch: false,
    })
    // four rows and no filler against twenty-eight rows: the scope counts differ, so the
    // scores must come from this store's own counts
    expect(there.map((r) => Number(r.score.toFixed(9)))).not.toEqual(here.map((h) => h.score))
    expect(await snapshot({})).toEqual(here)
    other.close()
  })

  it('a sibling namespace is not in scope, so it neither leaks in nor moves the probe', async () => {
    insertMemory('s1', '/probe/q2', 'the deploy window for the golden fixture is 10:00')
    const before = await snapshot({})
    expect(ids(before)).not.toContain('s1')
    otherNamespaceRows(50, 'sibling')
    const after = await snapshot({})
    expect(after).toEqual(before)
  })
})

// the corpus a statistic counts has to be the row set the predicate serves. LIKE folds ascii
// case and a range does not, so the two disagreed on a child named a case away from the key.
const CASE_NS = '/PROBE/Q1//turns'

function scopedScope(options: { namespace_subtree?: string; project_path?: string }): {
  predicates: { sql: string; params: unknown[] }
  narrowing: { sql: string; params: unknown[] } | null
} {
  const clause = namespaceFilter('m', options)
  return {
    predicates: { sql: clause.sql, params: clause.params },
    narrowing: scopeNarrowing(options),
  }
}

const FTS_CORPUS: ChannelSpec = {
  table: 'memories_fts',
  from: 'memories_fts f JOIN memories m ON f.rowid = m.rowid',
  dfExpr: 'COUNT(*)',
  weights: [10, 5],
  prefix: false,
}

const IDENT_CORPUS: ChannelSpec = {
  table: MEMORIES_IDENT_FTS,
  from: `${MEMORIES_IDENT_FTS} f JOIN memories m ON f.rowid = m.rowid`,
  dfExpr: 'COUNT(*)',
  weights: [1],
  prefix: false,
}

const ENTITY_CORPUS: ChannelSpec = {
  table: MEMORY_ENTITY_FTS,
  from: `${MEMORY_ENTITY_FTS} f JOIN memories m ON m.id = f.memory_id`,
  dfExpr: 'COUNT(DISTINCT f.memory_id)',
  weights: [1],
  prefix: true,
}

describe('the corpus agrees with the scope predicate', () => {
  it('serves a row whose namespace differs from the scope key only in ascii case', async () => {
    insertMemory('c1', CASE_NS, 'the deploy window for the golden fixture is 08:00', ['deploy'])
    const hits = await snapshot({ namespace_subtree: PROBE })
    expect(ids(hits)).toContain('c1')
  })

  it('counts that row, in both the scope count and its term count', () => {
    insertMemory('c1', CASE_NS, 'the deploy window for the golden fixture is 08:00', ['deploy'])
    const clause = namespaceFilter('m', { namespace_subtree: PROBE })
    const stats = scopeStats(
      db,
      { namespace_subtree: PROBE },
      scopedScope({ namespace_subtree: PROBE }),
      FTS_CORPUS,
      quotedTerms('"deploy"')
    )
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${clause.sql}`)
      .get(...clause.params) as { n: number }
    const matches = db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories_fts f JOIN memories m ON f.rowid = m.rowid
         WHERE memories_fts MATCH '"deploy"' AND ${clause.sql}`
      )
      .get(...clause.params) as { n: number }
    expect(stats.docs).toBe(rows.n)
    expect(stats.df.get('deploy')).toBe(matches.n)
  })

  it('moves the scope when a case-only sibling of it grows, after the counts are cached', async () => {
    const before = await snapshot({ namespace_subtree: PROBE })
    for (let i = 0; i < 24; i++) {
      insertMemory(`cv-${i}`, CASE_NS, `unrelated reference note ${i} ${'padding '.repeat(40)}`)
    }
    const after = await snapshot({ namespace_subtree: PROBE })
    expect(after).not.toEqual(before)
  })

  it('does not move the scope when a sibling namespace outside it grows', async () => {
    const before = await snapshot({ namespace_subtree: PROBE })
    for (let i = 0; i < 24; i++) {
      insertMemory(`sb-${i}`, '/probe/q2', `unrelated reference note ${i} ${'padding '.repeat(40)}`)
    }
    const after = await snapshot({ namespace_subtree: PROBE })
    expect(after).toEqual(before)
  })
})

// a statistic is recomputed only when the scope's epoch moves, so every write that can change
// which rows the scope serves has to move it, not just the ones that land in the memories table.
describe('writes that move a scope invalidate its counts', () => {
  function supersede(store: Database.Database, source: string, target: string, confidence = 0.9): void {
    store
      .prepare(
        `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at, confidence)
         VALUES (?, ?, 1.0, 'supersedes', ?, ?)`
      )
      .run(source, target, NOW, confidence)
  }

  it('recounts the corpus a supersedes link hides a row from', () => {
    // the filters a memory query builds, supersession included: the link is what hides g3,
    // and hiding it is what has to move the scope's signature
    const clause = namespaceFilter('m', { namespace_subtree: PROBE })
    const scope = {
      predicates: combineFilters([
        { sql: clause.sql, params: clause.params },
        { sql: notSupersededClause('m.id'), params: [] },
      ]),
      narrowing: null,
    }
    const options = { namespace_subtree: PROBE }
    const counted = () => scopeStats(db, options, scope, FTS_CORPUS, ['golden'])
    const before = counted()
    supersede(db, 'g1', 'g3')
    const after = counted()
    expect(after.docs).toBe(before.docs - 1)
    expect(after.df.get('golden')).toBe((before.df.get('golden') ?? 0) - 1)
  })

  it('ranks a scope the way a store that counted the link answers, and again after it is lifted', async () => {
    const before = await snapshot({})
    supersede(db, 'g1', 'g3')
    const hidden = await snapshot({})
    expect(ids(hidden)).not.toContain('g3')

    // the twin counted the same rows for the first time after the link landed: the answer
    // a stale cache cannot give
    const twin = mirror()
    supersede(twin, 'g1', 'g3')
    const fresh = await snapshotOn(new MemorySearch(twin, false), {})
    expect(hidden).toEqual(fresh)
    twin.close()

    db.prepare("DELETE FROM memory_links WHERE link_type = 'supersedes'").run()
    expect(await snapshot({})).toEqual(before)
  })

  it('recounts the entity index when an entity is written for a memory already there', () => {
    const scope = scopedScope({ namespace_subtree: PROBE })
    const options = { namespace_subtree: PROBE }
    const before = scopeStats(db, options, scope, ENTITY_CORPUS, ['deploywindow'])
    expect(before.df.get('deploywindow')).toBe(3)
    insertEntity('g3', 'deployWindow')
    const after = scopeStats(db, options, scope, ENTITY_CORPUS, ['deploywindow'])
    expect(after.df.get('deploywindow')).toBe(4)
  })

  it('recounts the identifier index after the boot backfill repairs it', async () => {
    const scope = scopedScope({ namespace_subtree: PROBE })
    const options = { namespace_subtree: PROBE }
    // the empty document a connection that knows nothing about ident_text leaves behind
    db.prepare(
      `UPDATE ${MEMORIES_IDENT_FTS} SET ident = ''
       WHERE rowid = (SELECT rowid FROM memories WHERE id = 'g1')`
    ).run()
    const before = scopeStats(db, options, scope, IDENT_CORPUS, ['window'])
    const repaired = await backfillLexicalIndex(db, { batchSize: 10, pauseMs: 0, log: () => undefined })
    const after = scopeStats(db, options, scope, IDENT_CORPUS, ['window'])
    expect(repaired.memoryRows).toBeGreaterThan(0)
    expect(after.df.get('window')).toBe((before.df.get('window') ?? 0) + 1)
  })
})

// the evidence layer is its own corpus: an episode's ranking may not depend on what other
// namespaces ingested, any more than a memory's may.
const EPISODE_SOURCE = 'scope-episodes'
const EPISODE_SESSION = 'scope-evidence'

interface EvidenceSpec {
  id: string
  content: string
  turn: number
}

async function ingestEvidence(
  namespace: string,
  items: EvidenceSpec[],
  store: Database.Database = db
): Promise<void> {
  const result = await ingestEpisodes(store, {
    namespace,
    source: EPISODE_SOURCE,
    vectorsAvailable: false,
    now: NOW,
    items: items.map((entry) => ({
      external_id: entry.id,
      content: entry.content,
      session_id: EPISODE_SESSION,
      turn_index: entry.turn,
      occurred_at: NOW,
    })),
  })
  expect(result.rejected, JSON.stringify(result.items)).toBe(0)
}

async function episodeGolden(): Promise<void> {
  await ingestEvidence(PROBE, [
    { id: 'e1', turn: 0, content: 'user: the deploy window for the golden fixture is 09:00-11:30 utc' },
    { id: 'e2', turn: 1, content: 'assistant: the rollback drill for the golden fixture follows the deploy window' },
    { id: 'e3', turn: 2, content: 'user: the pricing table for the golden fixture lives in a spreadsheet' },
    { id: 'e4', turn: 3, content: 'assistant: the deploy window rota for the golden fixture is posted weekly' },
  ])
  await ingestEvidence(
    PROBE,
    Array.from({ length: 24 }, (_, i) => ({
      id: `ef-${i}`,
      turn: 10 + i,
      content: `user: scope note ${i} about the caching layer and its eviction policy`,
    }))
  )
}

async function otherEpisodes(count: number, tag: string, terms = 'deploy window golden fixture'): Promise<void> {
  await ingestEvidence(
    OTHER,
    Array.from({ length: count }, (_, i) => ({
      id: `other-${tag}-${i}`,
      turn: i,
      content: `user: turn ${i} on the ${terms} was discussed again`,
    }))
  )
}

interface EvidenceHit {
  id: string
  order: number
  score: number
  relevance: number
  bm25: number | null
}

async function episodeSnapshot(
  scope: EpisodeSearchOptions,
  query: string = QUERY
): Promise<EvidenceHit[]> {
  const found = await searchEpisodes(db, false, query, { limit: 10, now: NOW, ...scope })
  return found.hits.map((hit, order) => ({
    id: hit.episode.external_id,
    order,
    score: Number(hit.score.toFixed(9)),
    relevance: Number(hit.relevance.toFixed(9)),
    bm25: hit.bm25 === undefined ? null : Number(hit.bm25.toFixed(9)),
  }))
}

interface FusedContext {
  context: string
  lines: Array<{ id: string; ref: string; turn: number; rank: number; block: number; text: string }>
  hits: Array<{ id: string; score: number; bm25: number | null }>
  note: string
}

async function fusedContext(budgetChars = 600): Promise<FusedContext> {
  const result = await retrieveEpisodeContext({
    db,
    vectorsAvailable: false,
    query: QUERY,
    namespace: PROBE,
    budget_chars: budgetChars,
    now: NOW,
  })
  return {
    context: result.context,
    lines: result.lines.map((line) => ({
      id: line.episode_id,
      ref: line.session_id,
      turn: line.turn_index,
      rank: line.rank,
      block: line.block,
      text: line.content,
    })),
    hits: result.hits.map((hit) => ({
      id: hit.episode.id,
      score: Number(hit.score.toFixed(9)),
      bm25: hit.bm25 === undefined ? null : Number(hit.bm25.toFixed(9)),
    })),
    note: result.note,
  }
}

describe('scoped lexical statistics on the evidence layer', () => {
  const SCOPES: Array<[string, EpisodeSearchOptions]> = [
    ['namespace', { namespace: PROBE }],
    ['namespace_subtree', { namespace_subtree: PROBE }],
  ]

  beforeEach(async () => {
    await episodeGolden()
  })

  for (const [label, scope] of SCOPES) {
    it(`${label}: ids, order and scores ignore episodes added to another namespace`, async () => {
      const before = await episodeSnapshot(scope)
      await otherEpisodes(400, `seed-${label}`)
      const after = await episodeSnapshot(scope)
      expect(after).toEqual(before)
    })

    it(`${label}: ids, order and scores ignore a small growth in another namespace`, async () => {
      const before = await episodeSnapshot(scope)
      await otherEpisodes(40, `thin-${label}`, 'deploy')
      const after = await episodeSnapshot(scope)
      expect(after).toEqual(before)
    })

    it(`${label}: ids, order and scores ignore episodes deleted from another namespace`, async () => {
      await otherEpisodes(400, `gone-${label}`)
      const before = await episodeSnapshot(scope)
      db.prepare('DELETE FROM episodes WHERE namespace = ?').run(OTHER)
      const after = await episodeSnapshot(scope)
      expect(after).toEqual(before)
    })
  }

  it('recounts the scope when the scope itself grows', async () => {
    const before = await episodeSnapshot({ namespace: PROBE })
    await ingestEvidence(
      PROBE,
      Array.from({ length: 24 }, (_, i) => ({
        id: `grown-${i}`,
        turn: 40 + i,
        content: `assistant: unrelated reference note ${i} ${'padding '.repeat(40)}`,
      }))
    )
    const after = await episodeSnapshot({ namespace: PROBE })
    expect(after).not.toEqual(before)
  })

  it('serves the same fused context with and without unrelated episodes elsewhere', async () => {
    const before = await fusedContext()
    expect(before.hits.length).toBeGreaterThan(1)
    expect(before.lines.length).toBeGreaterThan(1)
    await otherEpisodes(400, 'context')
    const after = await fusedContext()
    expect(after).toEqual(before)
  })

  it('serves the same fused context after unrelated episodes elsewhere are deleted', async () => {
    await otherEpisodes(400, 'context-gone')
    const before = await fusedContext()
    db.prepare('DELETE FROM episodes WHERE namespace = ?').run(OTHER)
    const after = await fusedContext()
    expect(after).toEqual(before)
  })
})
