import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { MemoryStore } from '../src/memory/store.js'
import { entitySearch, entityQueryTokens } from '../src/memory/search/entity.js'
import { MEMORY_ENTITY_FTS } from '../src/db/lexical-index.js'
import { createTestDb } from './helpers.js'
import type { CallerScope } from '../src/memory/access.js'

const PROJECT = '/work/engram'
const FOREIGN = '/work/other'

describe('entity channel', () => {
  let db: Database.Database
  let store: MemoryStore

  beforeEach(() => {
    db = createTestDb().db
    db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
      'ent-session',
      PROJECT,
      Date.now()
    )
    store = new MemoryStore(db, false)
  })

  async function add(
    id: string,
    content: string,
    namespace: string = PROJECT,
    type: 'note' | 'bug' = 'note'
  ): Promise<string> {
    const memory = await store.store({
      content,
      session_id: 'ent-session',
      project_path: namespace,
      type,
    })
    return memory.id
  }

  it('extracts entities through the real write path (triggers index them)', async () => {
    const id = await add('m', 'The `traverseGraph` function walks links in src/memory/search/graph.ts')
    const entities = store.getEntities(id).map((e) => e.entity_text)
    expect(entities).toContain('traverseGraph')
    expect(entities).toContain('src/memory/search/graph.ts')
    const indexed = db
      .prepare(`SELECT memory_id FROM ${MEMORY_ENTITY_FTS} WHERE ${MEMORY_ENTITY_FTS} MATCH 'traverse*'`)
      .all() as Array<{ memory_id: string }>
    expect(indexed.map((r) => r.memory_id)).toEqual([id])
  })

  it('matches identifier, camelCase, snake_case and dotted-path queries', async () => {
    const graph = await add('graph', 'The `traverseGraph` function walks links in src/memory/search/graph.ts')
    const hybrid = await add(
      'hybrid',
      'hybridSearch(db, vectorsAvailable) fuses ftsSearch and vectorSearch in src/memory/search/hybrid.ts'
    )
    await add('other', 'unrelated note about caching')

    const ids = (query: string, options: Record<string, unknown> = {}) =>
      entitySearch(db, query, { project_path: PROJECT, ...options }, 20)
        .map((r) => r.id)
        .sort()

    expect(ids('traverseGraph')).toEqual([graph])
    expect(ids('traverse graph')).toEqual([graph])
    expect(ids('traverse_graph')).toEqual([graph])
    expect(ids('graphTraversal')).toEqual([graph])
    expect(ids('graph')).toEqual([graph])
    expect(ids('src/memory/search/graph.ts')).toEqual([graph])
    expect(ids('hybridSearch')).toEqual([hybrid])
    expect(ids('hybrid search')).toEqual([hybrid])
    expect(ids('hybrid_search')).toEqual([hybrid])
    expect(ids('src/memory/search/hybrid.ts')).toEqual([hybrid])
  })

  it('answers natural-language queries that the exact-match searchByEntity path cannot', async () => {
    const graph = await add('graph', 'The `traverseGraph` function walks links in src/memory/search/graph.ts')
    await add('other', 'unrelated note about caching')

    expect(store.searchByEntity('how does traverseGraph walk the graph', PROJECT, 10)).toEqual([])
    expect(store.searchByEntity('traverseGraph', PROJECT, 10).map((m) => m.id)).toEqual([graph])

    const rows = entitySearch(db, 'how does traverseGraph walk the graph', { project_path: PROJECT }, 10)
    expect(rows.map((r) => r.id)).toEqual([graph])
  })

  it('falls back to OR when no memory has every term', async () => {
    const graph = await add('graph', 'The `traverseGraph` function walks links in src/memory/search/graph.ts')
    const hybrid = await add('hybrid', 'hybridSearch(db) fuses ftsSearch in src/memory/search/hybrid.ts')

    const rows = entitySearch(db, 'graph traversal hybrid', { project_path: PROJECT }, 10)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(graph)
    expect(ids).toContain(hybrid)
    expect(ids.length).toBeLessThanOrEqual(10)
  })

  it('isolates namespaces and honours validity, supersession and type', async () => {
    const graph = await add('graph', 'The `traverseGraph` function walks links in src/memory/search/graph.ts')
    const foreign = await add('foreign', '`traverseGraph` in another project', FOREIGN)
    const child = await add('child', '`traverseGraph` in a child scope', `${PROJECT}/packages/api`)

    expect(entitySearch(db, 'traverseGraph', { project_path: PROJECT }, 10).map((r) => r.id)).toEqual([graph])
    expect(entitySearch(db, 'traverseGraph', {}, 10).map((r) => r.id).sort()).toEqual(
      [child, foreign, graph].sort()
    )
    expect(
      entitySearch(db, 'traverseGraph', { namespace_subtree: PROJECT }, 10).map((r) => r.id).sort()
    ).toEqual([child, graph].sort())
    expect(entitySearch(db, 'traverseGraph', { project_path: PROJECT }, 1)).toHaveLength(1)

    db.prepare("UPDATE memories SET valid_from = 10, valid_until = 20 WHERE id = ?").run(graph)
    expect(entitySearch(db, 'traverseGraph', { project_path: PROJECT, as_of: 15 }, 10).map((r) => r.id)).toEqual([
      graph,
    ])
    expect(entitySearch(db, 'traverseGraph', { project_path: PROJECT, as_of: 500 }, 10)).toEqual([])
    expect(entitySearch(db, 'traverseGraph', { project_path: PROJECT, before: 5 }, 10)).toEqual([])

    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at, confidence, judged_at)
       VALUES (?, ?, 1, 'supersedes', 1, 1, 1)`
    ).run(foreign, graph)
    // a successor outside the query cannot suppress a row inside it.
    expect(entitySearch(db, 'traverseGraph', { project_path: PROJECT }, 10).map((r) => r.id)).toEqual([graph])
    expect(
      entitySearch(db, 'traverseGraph', { project_path: PROJECT, include_superseded: true }, 10).map((r) => r.id)
    ).toEqual([graph])

    db.prepare('UPDATE memories SET type = ? WHERE id = ?').run('bug', child)
    expect(
      entitySearch(db, 'traverseGraph', { namespace_subtree: PROJECT, type: 'bug' }, 10).map((r) => r.id)
    ).toEqual([child])
  })

  it('ignores hidden-owner successors but honours same-scope shared successors', async () => {
    const graph = await add('graph', 'The `traverseGraph` function walks links')
    const successor = await add('successor', 'a synthetic replacement fact')
    db.prepare("UPDATE memories SET owner_principal = 'writer', visibility = 'personal' WHERE id = ?").run(successor)
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at, confidence, judged_at)
       VALUES (?, ?, 1, 'supersedes', 20, 1, 20)`
    ).run(successor, graph)
    db.prepare('UPDATE memories SET valid_from = 10 WHERE id IN (?, ?)').run(graph, successor)
    const caller: CallerScope = {
      principalId: 'reader', name: 'reader', localOwner: false,
      grants: [{ prefix: PROJECT, verbs: ['read'] }],
    }
    for (const as_of of [undefined, 30]) {
      expect(entitySearch(db, 'traverseGraph', { project_path: PROJECT, caller, as_of }, 10).map((r) => r.id)).toEqual([graph])
    }
    db.prepare("UPDATE memories SET visibility = 'project' WHERE id = ?").run(successor)
    expect(entitySearch(db, 'traverseGraph', { project_path: PROJECT, caller }, 10)).toEqual([])
    expect(entitySearch(db, 'traverseGraph', { project_path: PROJECT, caller, as_of: 15 }, 10).map((r) => r.id)).toEqual([graph])
    expect(entitySearch(db, 'traverseGraph', { project_path: PROJECT, caller, as_of: 30 }, 10)).toEqual([])
    expect(entitySearch(db, 'traverseGraph', { project_path: PROJECT, caller, include_superseded: true }, 10).map((r) => r.id)).toEqual([graph])
  })

  it('is deterministic and returns nothing for an empty query or a missing index', async () => {
    const graph = await add('graph', 'The `traverseGraph` function walks links in src/memory/search/graph.ts')
    const first = entitySearch(db, 'traverse graph', { project_path: PROJECT }, 10).map((r) => r.id)
    const second = entitySearch(db, 'traverse graph', { project_path: PROJECT }, 10).map((r) => r.id)
    expect(first).toEqual(second)
    expect(first).toEqual([graph])

    expect(entitySearch(db, '   ', { project_path: PROJECT }, 10)).toEqual([])
    expect(entitySearch(db, '!!!', { project_path: PROJECT }, 10)).toEqual([])

    // no index (pre-012): no rows, no throw
    const bare = createTestDb().db
    for (const name of ['memories_ident_fts', 'memory_entity_fts']) {
      bare.exec(`DROP TABLE ${name}`)
    }
    for (const suffix of ['insert', 'update', 'delete']) {
      bare.exec(`DROP TRIGGER IF EXISTS memories_ident_fts_${suffix}`)
      bare.exec(`DROP TRIGGER IF EXISTS memory_entity_fts_${suffix}`)
    }
    bare.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run('s', PROJECT, 1)
    bare
      .prepare(
        `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from)
         VALUES ('bare', 's', ?, ?, 'call traverseGraph here', 'note', 0.5, '[]', 1, 1)`
      )
      .run(PROJECT, PROJECT)
    bare
      .prepare(
        "INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at) VALUES ('bare', 'traverseGraph', 'symbol', 1)"
      )
      .run()
    expect(entitySearch(bare, 'traverseGraph', { project_path: PROJECT }, 10)).toEqual([])
  })

  it('tokenises queries into FTS-safe terms only', () => {
    expect(entityQueryTokens('traverseGraph')).toEqual(['traverse', 'graph'])
    expect(entityQueryTokens('graph_traversal')).toEqual(['graph', 'traversal'])
    expect(entityQueryTokens('HTTPServer')).toEqual(['http', 'server'])
    expect(entityQueryTokens('how does the hybridSearch work')).toEqual(['hybrid', 'search', 'work'])
    expect(entityQueryTokens('db')).toEqual(['db'])
    expect(entityQueryTokens('use the db')).toEqual(['db'])
    expect(entityQueryTokens('"memory_entities" OR *')).toEqual(['memory', 'entities'])
    for (const query of ['a*b', 'x" OR y', 'NEAR(a b)']) {
      for (const token of entityQueryTokens(query)) {
        expect(token, query).toMatch(/^[a-z0-9]+$/)
      }
    }
  })
})
