import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { createTestDb } from './helpers.js'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { MemoryStore } from '../src/memory/store.js'
import { MemorySearch } from '../src/memory/search.js'
import type { SearchDiagnostics } from '../src/memory/search/hybrid.js'
import { entityChannelEnabled, identChannelEnabled } from '../src/memory/search/scoring.js'

const PROJECT = '/work/wiring'
const FOREIGN = '/work/wiring-other'
const SESSION = 'wiring-session'
const T0 = 1_700_000_000_000

// not a frozen timestamp: a clock before created_at makes the ebbinghaus recency term
// explode and swamp the evidence these tests check
function searchClock(): number {
  return Date.now()
}

// stored and query are two notations of the same identifier, which unicode61
// cannot equate. no dotted-path probes: the plain fts list already finds those.
const NOTATION_PAIRS: Array<{ stored: string; query: string }> = [
  { stored: 'hybridSearch', query: 'hybrid_search' },
  { stored: 'hybrid_search', query: 'hybridSearch' },
  { stored: 'pprSearch', query: 'ppr search' },
  { stored: 'ppr_search', query: 'pprSearch' },
  { stored: 'traverseGraph', query: 'traverse_graph' },
  { stored: 'traverse_graph', query: 'traverse graph' },
  { stored: 'autoLink', query: 'auto_link' },
  { stored: 'entity_search', query: 'entitySearch' },
  { stored: 'memoryEntities', query: 'memory_entities' },
  { stored: 'namespace_subtree', query: 'namespaceSubtree' },
  { stored: 'backfillNamespaces', query: 'backfill namespaces' },
  { stored: 'reembed_stale_memories', query: 'reembedStaleMemories' },
]

const IDENT_QUERY = NOTATION_PAIRS[0].query

// the identifier exists only as a backticked entity and the query names it in
// another notation: no shared word, so the off-run recalls nothing by accident
const ENTITY_PAIRS: Array<{ entity: string; query: string }> = [
  { entity: 'traverseGraph', query: 'walking edges in traverse_graph' },
  { entity: 'autoLink', query: 'silent sweeps from auto_link' },
  { entity: 'entitySearch', query: 'ranking candidates via entity_search' },
  { entity: 'namespaceSubtree', query: 'spacing between namespace_subtree hops' },
]

const ENTITY_QUERY = ENTITY_PAIRS[0].query

// no identifier, no camelCase, no acronym: the plain fts list cannot answer the
// probes, so a hit can only come from the channel under test
const DECOYS = [
  'the caching layer keeps a bounded window of session payloads',
  'telemetry events are batched and flushed every five seconds',
  'the retry policy uses bounded exponential backoff with jitter',
  'the renderer draws the sidebar behind a generation counter',
  'the queue drains at most twenty jobs per startup',
  'the logger writes structured lines to standard error',
  'credentials are read from the environment by the client',
  'the digest summarises pinned facts for a namespace',
]

interface Fixture {
  db: Database.Database
  notationIds: Map<string, string>
  targetId: string
  foreignId: string
  decoyIds: string[]
}

// each probe gets a foreign-namespace twin in the probe's own notation, so a
// scope leak would show up as a hit
async function seedFixture(entityOnly: boolean): Promise<Fixture> {
  const db = createTestDb().db
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    SESSION,
    PROJECT,
    T0
  )
  const store = new MemoryStore(db, false)
  const notationIds = new Map<string, string>()
  let targetId = ''
  let foreignId = ''

  if (entityOnly) {
    for (const [i, pair] of ENTITY_PAIRS.entries()) {
      const stored = await store.store({
        content: `Note ${i}: the \`${pair.entity}\` helper powers lookup pipelines`,
        session_id: SESSION,
        project_path: PROJECT,
      })
      notationIds.set(pair.entity, stored.id)
      // same entity, other namespace: a scoped search must never return it
      await store.store({
        content: `Foreign ${i}: the \`${pair.entity}\` helper powers lookup pipelines`,
        session_id: SESSION,
        project_path: FOREIGN,
      })
    }
    targetId = notationIds.get(ENTITY_PAIRS[0].entity)!
    foreignId = (
      await store.store({
        content: `Foreign twin: the \`${ENTITY_PAIRS[0].entity}\` helper powers lookup pipelines`,
        session_id: SESSION,
        project_path: FOREIGN,
      })
    ).id
  } else {
    for (const [i, pair] of NOTATION_PAIRS.entries()) {
      const stored = await store.store({
        content: `Memory ${i}: the ${pair.stored} entry point handles retrieval for this project`,
        session_id: SESSION,
        project_path: PROJECT,
      })
      notationIds.set(pair.stored, stored.id)
      await store.store({
        content: `Foreign ${i}: the ${pair.query} entry point belongs to another project`,
        session_id: SESSION,
        project_path: FOREIGN,
      })
    }
    targetId = notationIds.get(NOTATION_PAIRS[0].stored)!
    foreignId = (
      await store.store({
        content: `Foreign twin: the ${NOTATION_PAIRS[0].query} entry point belongs to another project`,
        session_id: SESSION,
        project_path: FOREIGN,
      })
    ).id
  }

  const decoyIds: string[] = []
  for (const [i, decoy] of DECOYS.entries()) {
    const stored = await store.store({
      content: `Note ${i}: ${decoy}`,
      session_id: SESSION,
      project_path: PROJECT,
    })
    decoyIds.push(stored.id)
  }
  return { db, notationIds, targetId, foreignId, decoyIds }
}

describe('ident channel wired into hybridSearch', () => {
  let fixture: Fixture
  let search: MemorySearch

  beforeEach(async () => {
    fixture = await seedFixture(false)
    search = new MemorySearch(fixture.db, false)
  })

  afterEach(() => {
    delete process.env.ENGRAM_IDENT_CHANNEL
    fixture.db.close()
  })

  const run = (explicit?: boolean, diagnostics?: SearchDiagnostics) =>
    search.hybridSearch(IDENT_QUERY, {
      project_path: PROJECT,
      touch: false,
      now: searchClock(),
      limit: 10,
      ...(explicit === undefined ? {} : { ident_channel: explicit }),
      ...(diagnostics ? { diagnostics } : {}),
    })

  const recallAt10 = async (enabled: boolean): Promise<number> => {
    let hits = 0
    for (const pair of NOTATION_PAIRS) {
      const results = await search.hybridSearch(pair.query, {
        project_path: PROJECT,
        touch: false,
        now: searchClock(),
        limit: 10,
        ident_channel: enabled,
      })
      if (results.slice(0, 10).some((r) => r.id === fixture.notationIds.get(pair.stored))) hits++
    }
    return hits / NOTATION_PAIRS.length
  }

  it('finds every differently-notated identifier with the flag on, and almost none with it off', async () => {
    const off = await run(false)
    expect(off.map((r) => r.id)).not.toContain(fixture.targetId)
    // the fused path adds the prior signals, so the off-run ceiling is loose;
    // the gap between the two runs is the point
    const recallOff = await recallAt10(false)
    const recallOn = await recallAt10(true)
    console.log(
      `### ident channel through hybridSearch (${NOTATION_PAIRS.length} cross-notation queries, k=10): ` +
        `recall@10 ${recallOff.toFixed(3)} off -> ${recallOn.toFixed(3)} on`
    )
    expect(recallOff).toBeLessThanOrEqual(0.25)
    expect(recallOn).toBe(1)

    const diagnostics: SearchDiagnostics = { degraded: [] }
    const on = await run(true, diagnostics)

    expect(on.map((r) => r.id)).toContain(fixture.targetId)
    const hit = on.find((r) => r.id === fixture.targetId)!
    // evidence on the fused scale, not a rank-only pass-through
    expect(hit.relevance).toBeGreaterThan(0)
    expect(hit.relevance).toBeLessThanOrEqual(1)
    expect(hit.score).toBeGreaterThan(0)
    expect(on.map((r) => r.id)).not.toContain(fixture.foreignId)
    expect(diagnostics.degraded).toEqual([])
  })

  it('honours ENGRAM_IDENT_CHANNEL (the env the eval registry writes) and lets an explicit option win', async () => {
    process.env.ENGRAM_IDENT_CHANNEL = 'true'
    expect((await run()).map((r) => r.id)).toContain(fixture.targetId)

    process.env.ENGRAM_IDENT_CHANNEL = '0'
    expect((await run()).map((r) => r.id)).not.toContain(fixture.targetId)

    process.env.ENGRAM_IDENT_CHANNEL = 'true'
    expect((await run(false)).map((r) => r.id)).not.toContain(fixture.targetId)
  })

  it('leaves the primary lexical list working (the extra list only adds evidence)', async () => {
    // "bounded" appears in two decoys
    const results = await search.hybridSearch('bounded', {
      project_path: PROJECT,
      touch: false,
      now: searchClock(),
      limit: 10,
      ident_channel: true,
    })
    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results.every((r) => r.score > 0)).toBe(true)
  })
})

describe('entity channel wired into hybridSearch', () => {
  let fixture: Fixture
  let search: MemorySearch

  beforeEach(async () => {
    fixture = await seedFixture(true)
    search = new MemorySearch(fixture.db, false)
  })

  afterEach(() => {
    delete process.env.ENGRAM_ENTITY_CHANNEL
    fixture.db.close()
  })

  const run = (explicit?: boolean, diagnostics?: SearchDiagnostics) =>
    search.hybridSearch(ENTITY_QUERY, {
      project_path: PROJECT,
      touch: false,
      now: searchClock(),
      limit: 10,
      ...(explicit === undefined ? {} : { entity_channel: explicit }),
      ...(diagnostics ? { diagnostics } : {}),
    })

  const recallAt10 = async (enabled: boolean): Promise<number> => {
    let hits = 0
    for (const pair of ENTITY_PAIRS) {
      const results = await search.hybridSearch(pair.query, {
        project_path: PROJECT,
        touch: false,
        now: searchClock(),
        limit: 10,
        entity_channel: enabled,
      })
      if (results.slice(0, 10).some((r) => r.id === fixture.notationIds.get(pair.entity))) hits++
    }
    return hits / ENTITY_PAIRS.length
  }

  it('reaches an entity-only memory from a prose query with the flag on, and not with it off', async () => {
    const off = await run(false)
    expect(off.map((r) => r.id)).not.toContain(fixture.targetId)
    const recallOff = await recallAt10(false)
    const recallOn = await recallAt10(true)
    console.log(
      `### entity channel through hybridSearch (${ENTITY_PAIRS.length} prose queries, k=10): ` +
        `recall@10 ${recallOff.toFixed(3)} off -> ${recallOn.toFixed(3)} on`
    )
    expect(recallOff).toBe(0)
    expect(recallOn).toBe(1)

    const diagnostics: SearchDiagnostics = { degraded: [] }
    const on = await run(true, diagnostics)

    expect(on.map((r) => r.id)).toContain(fixture.targetId)
    const hit = on.find((r) => r.id === fixture.targetId)!
    expect(hit.relevance).toBeGreaterThan(0)
    expect(hit.relevance).toBeLessThanOrEqual(1)
    expect(on.map((r) => r.id)).not.toContain(fixture.foreignId)
    expect(diagnostics.degraded).toEqual([])
  })

  it('honours ENGRAM_ENTITY_CHANNEL and lets an explicit option win', async () => {
    process.env.ENGRAM_ENTITY_CHANNEL = 'true'
    expect((await run()).map((r) => r.id)).toContain(fixture.targetId)

    process.env.ENGRAM_ENTITY_CHANNEL = 'false'
    expect((await run()).map((r) => r.id)).not.toContain(fixture.targetId)

    process.env.ENGRAM_ENTITY_CHANNEL = 'true'
    expect((await run(false)).map((r) => r.id)).not.toContain(fixture.targetId)
  })
})

describe('channel flag resolution', () => {
  it('is off by default, on for 1/true, and independent per channel', () => {
    expect(identChannelEnabled({}, {})).toBe(false)
    expect(entityChannelEnabled({}, {})).toBe(false)

    expect(identChannelEnabled({}, { ENGRAM_IDENT_CHANNEL: '1' })).toBe(true)
    expect(identChannelEnabled({}, { ENGRAM_IDENT_CHANNEL: 'true' })).toBe(true)
    expect(identChannelEnabled({}, { ENGRAM_IDENT_CHANNEL: ' TRUE ' })).toBe(true)
    expect(identChannelEnabled({}, { ENGRAM_IDENT_CHANNEL: 'on' })).toBe(false)
    expect(identChannelEnabled({}, { ENGRAM_IDENT_CHANNEL: '0' })).toBe(false)
    expect(identChannelEnabled({}, { ENGRAM_IDENT_CHANNEL: '' })).toBe(false)
    expect(identChannelEnabled({}, { ENGRAM_ENTITY_CHANNEL: 'true' })).toBe(false)
    expect(entityChannelEnabled({}, { ENGRAM_IDENT_CHANNEL: 'true' })).toBe(false)

    expect(identChannelEnabled({ ident_channel: true }, {})).toBe(true)
    expect(identChannelEnabled({ ident_channel: false }, { ENGRAM_IDENT_CHANNEL: 'true' })).toBe(
      false
    )
    expect(entityChannelEnabled({ entity_channel: true }, {})).toBe(true)
  })
})

describe('honest degradation without the index', () => {
  it('contributes nothing, reports nothing, and ranks exactly like the channel-off run', async () => {
    const fixture = await seedFixture(false)
    const search = new MemorySearch(fixture.db, false)
    try {
      const options = {
        project_path: PROJECT,
        touch: false,
        now: searchClock(),
        limit: 10,
      } as const
      // a query the primary list answers, so the assertion below covers more
      // than "nothing was retrieved either way"
      const FTS_QUERY = 'bounded'
      const off = await search.hybridSearch(FTS_QUERY, { ...options, ident_channel: false })
      expect(off.length).toBeGreaterThanOrEqual(2)

      // no index (pre-012 or not backfilled): the channel degrades to no evidence
      fixture.db.exec('DROP TABLE memories_ident_fts')
      const absent: SearchDiagnostics = { degraded: [] }
      const withAbsentIndex = await search.hybridSearch(FTS_QUERY, {
        ...options,
        ident_channel: true,
        diagnostics: absent,
      })
      expect(absent.degraded).toEqual([])
      // scores, not just ids: an empty channel must not re-weight the list that did
      // answer either, or the flag would change rankings on a db without the index
      expect(withAbsentIndex.map((r) => [r.id, r.score])).toEqual(off.map((r) => [r.id, r.score]))

      fixture.db.exec('DROP TABLE memory_entity_fts')
      const absentEntity: SearchDiagnostics = { degraded: [] }
      const entityOff = await search.hybridSearch(FTS_QUERY, {
        ...options,
        entity_channel: false,
      })
      const withAbsentEntityIndex = await search.hybridSearch(FTS_QUERY, {
        ...options,
        entity_channel: true,
        diagnostics: absentEntity,
      })
      expect(absentEntity.degraded).toEqual([])
      expect(withAbsentEntityIndex.map((r) => [r.id, r.score])).toEqual(
        entityOff.map((r) => [r.id, r.score])
      )

      // the other half of the distinction: a query that fails with the index
      // present is reported, so "empty index" is distinguishable from "broken"
      fixture.db.exec('CREATE TABLE memories_ident_fts (ident)')
      const broken: SearchDiagnostics = { degraded: [] }
      const withBrokenIndex = await search.hybridSearch(FTS_QUERY, {
        ...options,
        ident_channel: true,
        diagnostics: broken,
      })
      expect(broken.degraded).toContain('ident')
      expect(withBrokenIndex.map((r) => r.id)).toEqual(off.map((r) => r.id))
      expect(withBrokenIndex.every((r) => r.degraded === true)).toBe(true)
    } finally {
      fixture.db.close()
    }
  })
})

describe('explicit access signal from the get_memory path', () => {
  const NS = '/home/user/wiring-access'

  beforeEach(() => {
    delete process.env.ENGRAM_ACCESS_SIGNAL
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  afterEach(() => {
    delete process.env.ENGRAM_ACCESS_SIGNAL
    resetDatabase()
    resetServicesForTests()
  })

  function parse<T>(result: { content: Array<{ type: 'text'; text: string }> }): T {
    return JSON.parse(result.content[0].text) as T
  }

  function accessCount(db: Database.Database, id: string): number {
    const row = db.prepare('SELECT access_count FROM memories WHERE id = ?').get(id) as
      | { access_count: number }
      | undefined
    return row?.access_count ?? 0
  }

  it('records access on an id fetch, never on a search, under the recommended default', async () => {
    const stored = parse<{ id: string }>(
      await handleTool('store_memory', {
        content: 'redis caching notes for the session store',
        project_path: NS,
      })
    )
    const db = getDatabase().db

    expect(accessCount(db, stored.id)).toBe(0)
    await handleTool('get_memory', { id: stored.id })
    expect(accessCount(db, stored.id)).toBe(1)
    await handleTool('get_memory', { id: stored.id })
    expect(accessCount(db, stored.id)).toBe(2)

    // a search is not a use: the top-k appearance is the ranker's own output
    await handleTool('get_context', { project_path: NS, query: 'redis caching' })
    expect(accessCount(db, stored.id)).toBe(2)
  })

  it('records access for the row actually served by an as_of fetch', async () => {
    const db = getDatabase().db
    const older = randomUUID()
    const newer = randomUUID()
    db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
      SESSION,
      NS,
      T0
    )
    const insert = db.prepare(
      `INSERT INTO memories
         (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, 'note', 0.5, '[]', ?, ?, ?)`
    )
    insert.run(older, SESSION, NS, NS, 'the default is A', T0, T0, T0 + 10_000)
    insert.run(newer, SESSION, NS, NS, 'the default is B', T0 + 10_000, T0 + 10_000, null)
    db.prepare(
      `INSERT OR IGNORE INTO memory_links
         (source_id, target_id, similarity, link_type, created_at, confidence, reason, judged_at, revision)
       VALUES (?, ?, 1.0, 'supersedes', ?, 1.0, 'test', ?, 2)`
    ).run(newer, older, T0 + 10_000, T0 + 10_000)

    await handleTool('get_memory', { id: older, as_of: T0 + 20_000 })
    expect(accessCount(db, newer)).toBe(1)
    expect(accessCount(db, older)).toBe(0)
  })

  it('ENGRAM_ACCESS_SIGNAL=off forbids recording on the id fetch too', async () => {
    process.env.ENGRAM_ACCESS_SIGNAL = 'off'
    const stored = parse<{ id: string }>(
      await handleTool('store_memory', {
        content: 'redis caching notes for the session store',
        project_path: NS,
      })
    )
    const db = getDatabase().db
    await handleTool('get_memory', { id: stored.id })
    expect(accessCount(db, stored.id)).toBe(0)
  })
})
