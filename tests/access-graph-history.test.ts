import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { MemoryStore } from '../src/memory/store.js'
import { MemorySearch } from '../src/memory/search.js'
import { recallContext, recallSummaries } from '../src/memory/recall.js'
import { enrichMemories } from '../src/memory/enrichment.js'
import { namespaceClause, namespaceFilter } from '../src/memory/search/scope.js'
import { findContradictionCandidates } from '../src/contradictions/candidates.js'
import { withCaller, type CallerScope } from '../src/memory/access.js'
import { EMBEDDING_DIM } from '../src/embeddings/pipeline.js'

const NS = '/scope/alpha'
const OTHER = '/scope/beta'
const CHILD = `${NS}/child`
const caller: CallerScope = {
  principalId: 'reader', name: 'reader', localOwner: false,
  grants: [{ prefix: NS, verbs: ['read', 'write'] }],
}
const broad: CallerScope = { ...caller, grants: [{ prefix: '/scope', verbs: ['read'] }] }

function seed(
  db: Database.Database,
  id: string,
  namespace = NS,
  owner: string | null = 'reader',
  visibility: string | null = 'personal',
  createdAt = 10
): void {
  db.prepare(`INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES ('synthetic', ?, 1)`).run(NS)
  db.prepare(
    `INSERT INTO memories
     (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, owner_principal, visibility)
     VALUES (?, 'synthetic', ?, ?, ?, 'note', 0.8, '[]', ?, ?, ?, ?)`
  ).run(id, namespace, namespace, `synthpostgres evidence ${id}`, createdAt, createdAt, owner, visibility)
}

function link(
  db: Database.Database, source: string, target: string, type = 'semantic', time = 10, revision = 0
): void {
  db.prepare(
    `INSERT INTO memory_links
     (source_id, target_id, similarity, link_type, created_at, confidence, judged_at, reason, revision)
     VALUES (?, ?, 0.8, ?, ?, 1, ?, ?, ?)`
  ).run(source, target, type, time, time, `${source} -> ${target}`, revision)
}

function graphFixture(db: Database.Database): void {
  seed(db, 'seed')
  seed(db, 'own')
  seed(db, 'shared', NS, 'writer', 'project')
  seed(db, 'private-secret', NS, 'writer')
  seed(db, 'outside-secret', OTHER, 'writer', 'team')
  seed(db, 'via-private')
  seed(db, 'via-outside')
  seed(db, 'child', CHILD, 'writer', 'org')
  link(db, 'seed', 'own')
  link(db, 'own', 'shared')
  link(db, 'seed', 'private-secret')
  link(db, 'private-secret', 'via-private')
  link(db, 'seed', 'outside-secret')
  link(db, 'outside-secret', 'via-outside')
  link(db, 'seed', 'child')
}

function historyFixture(db: Database.Database): void {
  seed(db, 'old')
  seed(db, 'new', NS, 'reader', 'personal', 30)
  seed(db, 'private-secret', NS, 'writer', 'personal', 40)
  seed(db, 'outside-secret', OTHER, 'writer', 'project', 40)
  seed(db, 'via-private', NS, 'reader', 'personal', 45)
  seed(db, 'via-outside', NS, 'reader', 'personal', 45)
  db.prepare("UPDATE memories SET valid_until = 29 WHERE id = 'old'").run()
  link(db, 'new', 'old', 'supersedes', 30, 2)
  link(db, 'private-secret', 'new', 'supersedes', 40, 3)
  link(db, 'via-private', 'private-secret', 'supersedes', 45, 4)
  link(db, 'outside-secret', 'new', 'supersedes', 40, 3)
  link(db, 'via-outside', 'outside-secret', 'supersedes', 45, 4)
}

function expectNoHidden(payload: unknown): void {
  const text = JSON.stringify(payload)
  for (const marker of ['private-secret', 'outside-secret', 'via-private', 'via-outside']) {
    expect(text).not.toContain(marker)
  }
}

describe('access boundary for graph, history, and contradiction reads', () => {
  let db: Database.Database
  let store: MemoryStore
  let search: MemorySearch
  let vectorsAvailable: boolean
  let fetchGuard: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchGuard = vi.fn(() => { throw new Error('network forbidden in access regressions') })
    vi.stubGlobal('fetch', fetchGuard)
    const fixture = createTestDb()
    db = fixture.db
    vectorsAvailable = fixture.vectorsAvailable
    store = new MemoryStore(db, false)
    search = new MemorySearch(db, false)
  })
  afterEach(() => {
    expect(fetchGuard).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (db?.open) db.close()
  })

  it('checks every graph seed and hop, not only returned rows (including as_of)', () => {
    graphFixture(db)
    withCaller(caller, () => {
      for (const as_of of [undefined, 50]) {
        const options = { project_path: NS, as_of }
        const traversed = search.traverseGraph('seed', 5, 50, options)
        const ranked = search.pprSearch(['seed', 'private-secret', 'outside-secret'], 50, options)
        expect(traversed.map((row) => row.id)).toEqual(['own', 'shared'])
        expect(ranked.map((row) => row.id).sort()).toEqual(['own', 'shared'])
        expectNoHidden({ traversed, ranked })
        expect(search.traverseGraph('private-secret', 5, 50, options)).toEqual([])
        expect(search.pprSearch(['outside-secret'], 50, options)).toEqual([])
      }
    })
  })

  it('intersects broad grants with exact/subtree query scope and preserves shared children', () => {
    graphFixture(db)
    const exact = search.pprSearch(['seed'], 50, { project_path: NS, caller: broad })
    expect(exact.map((row) => row.id).sort()).toEqual(['own', 'shared'])
    const subtree = search.traverseGraph('seed', 5, 50, { namespace_subtree: NS, caller: broad })
    expect(subtree.map((row) => row.id).sort()).toEqual(['child', 'own', 'shared'])
    expectNoHidden({ exact, subtree })
  })

  it('does not let inaccessible edges change PPR scores or form reentry bridges', () => {
    graphFixture(db)
    const options = { project_path: NS, caller }
    const first = search.pprSearch(['seed'], 50, options)
    db.prepare("DELETE FROM memory_links WHERE source_id IN ('private-secret', 'outside-secret') OR target_id IN ('private-secret', 'outside-secret')").run()
    expect(search.pprSearch(['seed'], 50, options)).toEqual(first)
  })

  it('checks the source and target of one-hop related reads, including fallback-sized graphs', () => {
    seed(db, 'seed')
    seed(db, 'shared', NS, 'writer', 'team')
    seed(db, 'private-secret', NS, 'writer')
    seed(db, 'outside-secret', OTHER, 'writer', 'org')
    for (const id of ['shared', 'private-secret', 'outside-secret']) link(db, 'seed', id)
    for (const as_of of [undefined, 50]) {
      const related = store.getLinked('seed', 50, { caller, as_of })
      expect(related.map((row) => row.id)).toEqual(['shared'])
      expectNoHidden(related)
      expect(store.getLinked('private-secret', 50, { caller, as_of })).toEqual([])
      expect(search.pprSearch(['seed'], 50, { caller, project_path: NS, as_of }).map((row) => row.id)).toEqual(['shared'])
    }
    expect(store.getLinked('seed', 50, { caller: broad, project_path: NS }).map((row) => row.id)).toEqual(['shared'])
    expect(store.getLinked('seed', 50, { caller: broad, project_path: OTHER })).toEqual([])
  })

  it('denies reads with no read grants and does not treat shared visibility as a grant', async () => {
    graphFixture(db)
    const writeOnly: CallerScope = { ...caller, grants: [{ prefix: NS, verbs: ['write'] }] }
    const denied: CallerScope = { ...caller, grants: [] }
    for (const identity of [denied, writeOnly]) {
      expect(search.pprSearch(['seed'], 50, { caller: identity })).toEqual([])
      expect(search.traverseGraph('seed', 5, 50, { caller: identity })).toEqual([])
      expect(store.getLinked('seed', 50, { caller: identity })).toEqual([])
      expect(store.getHistory('seed', { caller: identity })).toBeNull()
      expect(store.getByIdAt('seed', 50, { caller: identity })).toBeNull()
      const recalled = await withCaller(identity, () => recallContext(db, store, search, {
        query: 'synthpostgres', mode: 'graph', seed_id: 'seed', project_path: NS, budget_chars: 10000,
      }))
      expect(recalled.memories).toEqual([])
    }
    expect(store.getLinked('outside-secret', 50, { caller })).toEqual([])
  })

  it('applies caller and namespace scope to graph recall, returned handles and edge fields', async () => {
    graphFixture(db)
    link(db, 'own', 'private-secret', 'conflicts')
    link(db, 'outside-secret', 'own', 'supersedes')
    const result = await withCaller(broad, () => recallContext(db, store, search, {
      query: '', mode: 'graph', seed_id: 'seed', project_path: NS, budget_chars: 10000, as_of: 50,
    }))
    expect(result.memories.map((row) => row.id).sort()).toEqual(['own', 'shared'])
    expectNoHidden(result)
    expect(result.memories.find((row) => row.id === 'own')).toMatchObject({
      supersedes_counts: { supersedes: 0, superseded_by: 0 }, disputed: false, conflict_count: 0,
      handles: { get_memory: { id: 'own' }, get_related: { id: 'own', depth: 1 } },
    })
    const hiddenSeed = await withCaller(caller, () => recallContext(db, store, search, {
      query: '', mode: 'graph', seed_id: 'private-secret', project_path: NS, budget_chars: 10000,
    }))
    expect(hiddenSeed.memories).toEqual([])
    expectNoHidden(hiddenSeed)
  })

  it('rejects stale substituted recall candidates before enrichment or handles', async () => {
    graphFixture(db)
    vi.spyOn(search, 'hybridSearch').mockResolvedValue([
      { ...store.getById('private-secret')!, score: 1 },
      { ...store.getById('outside-secret')!, score: 1 },
      { ...store.getById('shared')!, score: 1 },
    ])
    const result = await withCaller(broad, () => recallContext(db, store, search, {
      query: 'synthpostgres', project_path: NS, budget_chars: 10000,
    }))
    expect(result.memories.map((row) => row.id)).toEqual(['shared'])
    expectNoHidden(result)
  })

  it('cannot route history or as_of manual revisions through hidden or foreign nodes', () => {
    historyFixture(db)
    for (const identity of [caller, broad]) {
      const history = store.getHistory('new', { caller: identity, project_path: NS })!
      expect(history.versions.map((row) => row.id)).toEqual(['old', 'new'])
      expect(history.links.map((edge) => [edge.source_id, edge.target_id])).toEqual([['new', 'old']])
      expectNoHidden(history)
      expect(store.getByIdAt('old', 50, { caller: identity, project_path: NS })?.id).toBe('new')
      expect(store.getHistory('private-secret', { caller: identity })).toBeNull()
      expect(store.getByIdAt('private-secret', 50, { caller: identity })).toBeNull()
    }
    expect(withCaller(broad, () => store.getHistory('new'))!.versions.map((row) => row.id)).toEqual(['old', 'new'])
    expect(withCaller(broad, () => store.getByIdAt('old', 50))?.id).toBe('new')
  })

  it('only emits history edges whose endpoints survived as_of and the version limit', () => {
    historyFixture(db)
    const past = store.getHistory('new', { caller, as_of: 20 })!
    expect(past.versions.map((row) => row.id)).toEqual(['old'])
    expect(past.links).toEqual([])
    expectNoHidden(past)
    const limited = store.getHistory('new', { caller, limit: 1 })!
    expect(limited.versions.map((row) => row.id)).toEqual(['old'])
    expect(limited.links).toEqual([])
    db.prepare("UPDATE memories SET valid_until = NULL WHERE id = 'old'").run()
    db.prepare("UPDATE memory_links SET judged_at = 100 WHERE source_id = 'new' AND target_id = 'old'").run()
    expect(store.getHistory('new', { caller, as_of: 50 })!.links).toEqual([])
  })

  it('ignores hidden/out-of-query successors in real hybrid, context, entity and related reads', async () => {
    seed(db, 'seed')
    seed(db, 'visible')
    seed(db, 'private-secret', NS, 'writer')
    seed(db, 'outside-secret', OTHER, 'writer', 'project')
    link(db, 'seed', 'visible')
    link(db, 'private-secret', 'visible', 'supersedes')
    link(db, 'outside-secret', 'visible', 'supersedes')
    db.prepare("INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at) VALUES ('visible', 'synthpostgres', 'symbol', 10)").run()
    for (const as_of of [undefined, 50]) {
      const options = { caller: broad, project_path: NS, as_of, touch: false }
      expect((await search.hybridSearch('synthpostgres', options)).map((row) => row.id)).toContain('visible')
      expect(search.getContext(NS, 50, { caller: broad, as_of }).map((row) => row.id)).toContain('visible')
      expect(store.searchByEntity('synthpostgres', NS, 50, { caller: broad, as_of }).map((row) => row.id)).toEqual(['visible'])
      expect(store.getLinked('seed', 50, options).map((row) => row.id)).toEqual(['visible'])
      expect(store.list(options).map((row) => row.id)).toContain('visible')
    }
    seed(db, 'shared-successor', NS, 'writer', 'project')
    link(db, 'shared-successor', 'visible', 'supersedes', 40)
    expect((await search.hybridSearch('synthpostgres', { caller, project_path: NS, touch: false })).map((row) => row.id)).not.toContain('visible')
    expect(search.getContext(NS, 50, { caller, as_of: 30 }).map((row) => row.id)).toContain('visible')
    expect(search.getContext(NS, 50, { caller, as_of: 50 }).map((row) => row.id)).not.toContain('visible')
    expect((await search.hybridSearch('synthpostgres', { caller, project_path: NS, as_of: 30, touch: false })).map((row) => row.id)).toContain('visible')
    expect((await search.hybridSearch('synthpostgres', { caller, project_path: NS, as_of: 50, touch: false })).map((row) => row.id)).not.toContain('visible')
    expect(search.getContext(OTHER, 50, { caller })).toEqual([])
  })

  it('counts only readable same-query edges, but keeps legitimate shared-edge signals', () => {
    graphFixture(db)
    link(db, 'own', 'private-secret', 'conflicts')
    link(db, 'outside-secret', 'own', 'supersedes')
    link(db, 'own', 'shared', 'supersedes')
    link(db, 'shared', 'own', 'conflicts', 40)
    const [now] = enrichMemories(db, [store.getById('own')!], 50, { caller: broad, project_path: NS })
    expect(now).toMatchObject({ supersedes_counts: { supersedes: 1, superseded_by: 0 }, conflict_count: 1, disputed: true })
    // the scoring clock does not turn these counts into a historical edge snapshot.
    const [past] = enrichMemories(db, [store.getById('own')!], 30, { caller: broad, project_path: NS })
    expect(past).toMatchObject({ supersedes_counts: { supersedes: 1, superseded_by: 0 }, conflict_count: 1, disputed: true })
  })

  it('withholds topics containing forged foreign or private members', () => {
    graphFixture(db)
    const topic = {
      id: 1, project_path: NS, member_ids: ['own', 'outside-secret'],
      summary: 'outside-secret leaked summary', is_extractive: false, created_at: 1, updated_at: 1,
    }
    expect(withCaller(broad, () => recallSummaries(db, NS, [topic])).topics).toEqual([])
    expect(withCaller(caller, () => recallSummaries(db, NS, [{ ...topic, member_ids: ['own', 'private-secret'] }], { asOf: 50 })).topics).toEqual([])
    const shared = { ...topic, member_ids: ['own', 'shared'], summary: 'safe shared summary' }
    expect(withCaller(caller, () => recallSummaries(db, NS, [shared])).topics).toEqual([
      { id: 1, summary: 'safe shared summary', member_ids: ['own', 'shared'], member_count: 2 },
    ])
  })

  it('does not trust stored cluster memberships as cross-namespace read authority', () => {
    seed(db, 'own')
    seed(db, 'outside-secret', OTHER, 'writer', 'project')
    db.prepare(
      `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
       VALUES (?, ?, 'outside-secret contributed to this summary', 0, 1, 1)`
    ).run(NS, JSON.stringify(['own', 'outside-secret']))
    expect(search.getClusters(NS, broad)).toEqual([])
  })

  it('filters contradiction FTS candidates by grants and visibility before limiting', async () => {
    seed(db, 'own')
    seed(db, 'shared', NS, 'writer', 'project')
    seed(db, 'private-secret', NS, 'writer')
    seed(db, 'outside-secret', OTHER, 'writer', 'team')
    seed(db, 'child', CHILD, 'writer', 'org')
    for (let n = 0; n < 25; n++) seed(db, `private-secret-${n}`, NS, 'writer')
    const params = { namespace: NS, excludeMemoryId: 'new-id', contentForFts: 'synthpostgres', vectorsAvailable: false }
    const found = findContradictionCandidates(db, params, { caller, ftsTopK: 2 })
    expect(found.length).toBe(2)
    expect(found.every((row) => !row.memory.id.includes('secret'))).toBe(true)
    expectNoHidden(found)
    expect(findContradictionCandidates(db, { ...params, namespace: OTHER }, { caller })).toEqual([])
    const all = withCaller(broad, () => findContradictionCandidates(db, params, { maxCandidates: 50, ftsTopK: 50 }))
    expect(all.map((row) => row.memory.id)).toContain('shared')
    expect(all.map((row) => row.memory.id)).not.toContain('child')
    expectNoHidden(all)
    const stored = await withCaller(caller, () => store.store({
      session_id: 'synthetic', project_path: NS, content: 'synthpostgres contrasting synthetic evidence', origin: 'mcp',
    }))
    expect(stored.status).toBe('stored')
    expectNoHidden(stored)
  })

  it('filters vector contradiction candidates with only synthetic, locally inserted vectors', () => {
    expect(vectorsAvailable).toBe(true)
    graphFixture(db)
    const vector = new Float32Array(EMBEDDING_DIM)
    vector[0] = 1
    for (const id of ['own', 'shared', 'private-secret', 'outside-secret', 'child']) {
      const row = db.prepare('INSERT INTO memory_vectors (embedding) VALUES (?)').run(Buffer.from(vector.buffer))
      db.prepare('UPDATE memories SET vec_rowid = ? WHERE id = ?').run(Number(row.lastInsertRowid), id)
    }
    const found = findContradictionCandidates(db, {
      namespace: NS, excludeMemoryId: 'new-id', contentForFts: '', vectorsAvailable: true, embedding: vector,
    }, { caller: broad })
    expect(found.map((row) => row.memory.id).sort()).toEqual(['own', 'shared'])
    expect(found.every((row) => row.source === 'vec')).toBe(true)
    expectNoHidden(found)
  })

  it('escapes grant wildcard characters, respects boundaries, and uses the namespace fallback', () => {
    const odd = '/scope/literal_%\\path'
    seed(db, 'literal', odd, 'writer', 'project')
    seed(db, 'descendant', `${odd}/child`, 'writer', 'org')
    seed(db, 'wildcard-sibling', '/scope/literalXYZpath', 'writer', 'team')
    seed(db, 'prefix-sibling', `${odd}-other`, 'writer', 'project')
    seed(db, 'case-sibling', `${odd.toUpperCase()}/child`, 'writer', 'project')
    db.prepare("UPDATE memories SET namespace = NULL WHERE id = 'literal'").run()
    const oddCaller: CallerScope = { ...caller, grants: [{ prefix: `${odd}/`, verbs: ['read'] }] }
    const scope = namespaceFilter('m', { caller: oddCaller })
    expect((db.prepare(`SELECT m.id FROM memories m WHERE ${scope.sql} ORDER BY m.id`).all(...scope.params) as Array<{ id: string }>).map((row) => row.id)).toEqual(['descendant', 'literal'])
    const subtree = namespaceFilter('m', { caller: broad, namespace_subtree: odd })
    expect((db.prepare(`SELECT m.id FROM memories m WHERE ${subtree.sql} ORDER BY m.id`).all(...subtree.params) as Array<{ id: string }>).map((row) => row.id)).toEqual(['descendant', 'literal'])
    const narrowed = namespaceFilter('m', { caller: oddCaller, project_path: `${odd}/child` })
    expect((db.prepare(`SELECT m.id FROM memories m WHERE ${narrowed.sql}`).all(...narrowed.params) as Array<{ id: string }>).map((row) => row.id)).toEqual(['descendant'])
    const root = namespaceClause('namespace', { caller: { ...caller, grants: [{ prefix: '/', verbs: ['read'] }] } })
    expect(root).toEqual({ sql: '', params: [] })
  })

  it('retains no-caller local unscoped graph, related, history and as_of compatibility', () => {
    seed(db, 'local', NS, null, null)
    seed(db, 'foreign-local', OTHER, null, null)
    seed(db, 'new-local', OTHER, null, null, 30)
    link(db, 'local', 'foreign-local')
    link(db, 'new-local', 'local', 'supersedes', 30, 2)
    expect(search.traverseGraph('local').map((row) => row.id)).toContain('foreign-local')
    expect(search.pprSearch(['local']).map((row) => row.id)).toContain('foreign-local')
    expect(store.getLinked('local').map((row) => row.id)).toContain('foreign-local')
    expect(store.getHistory('local')!.versions.map((row) => row.id)).toEqual(['local', 'new-local'])
    expect(store.getByIdAt('local', 50)?.id).toBe('new-local')
    expect(store.getHistory('local', { project_path: NS })!.versions.map((row) => row.id)).toEqual(['local'])
    expect(store.getByIdAt('local', 50, { project_path: NS })?.id).toBe('local')
    expect(store.getLinked('local', 50, { project_path: NS })).toEqual([])
  })
})
