import { describe, it, expect } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { MemoryStore } from '../src/memory/store.js'
import { ftsSearch } from '../src/memory/search/hybrid.js'
import { identSearch } from '../src/memory/search/lexical.js'
import { entitySearch } from '../src/memory/search/entity.js'
import { pprSearch } from '../src/memory/search/graph.js'
import { configs } from '../eval/configs/index-lexical.js'

const PROJECT = '/work/engram'
const FOREIGN = '/work/other-project'
const SESSION = 'eval-index-session'

const NOTATION_QUERIES: Array<{ stored: string; query: string; kind: string }> = [
  { stored: 'hybridSearch', query: 'hybrid_search', kind: 'camel->snake' },
  { stored: 'hybrid_search', query: 'hybridSearch', kind: 'snake->camel' },
  { stored: 'pprSearch', query: 'ppr search', kind: 'camel->spaced' },
  { stored: 'ppr_search', query: 'pprSearch', kind: 'snake->camel' },
  { stored: 'traverseGraph', query: 'traverse_graph', kind: 'camel->snake' },
  { stored: 'traverse_graph', query: 'traverse graph', kind: 'snake->spaced' },
  { stored: 'autoLink', query: 'auto_link', kind: 'camel->snake' },
  { stored: 'entity_search', query: 'entitySearch', kind: 'snake->camel' },
  { stored: 'memoryEntities', query: 'memory_entities', kind: 'camel->snake' },
  { stored: 'namespace_subtree', query: 'namespaceSubtree', kind: 'snake->camel' },
  { stored: 'backfillNamespaces', query: 'backfill namespaces', kind: 'camel->spaced' },
  { stored: 'reembed_stale_memories', query: 'reembedStaleMemories', kind: 'snake->camel' },
]

const PATH_QUERIES: Array<{ ident: string; path: string }> = [
  { ident: 'hybridSearch', path: 'src/memory/search/hybrid.ts' },
  { ident: 'pprSearch', path: 'src/memory/search/graph.ts' },
  { ident: 'entitySearch', path: 'src/memory/search/entity.ts' },
  { ident: 'backfillNamespaces', path: 'src/db/workers/backfill.ts' },
]

const ENTITY_CASES: Array<{ entity: string; query: string }> = [
  { entity: 'hybridSearch', query: 'how does hybrid_search fuse channels' },
  { entity: 'pprSearch', query: 'what does pprSearch do' },
  { entity: 'traverseGraph', query: 'how does traverse_graph walk edges' },
  { entity: 'autoLink', query: 'when is auto_link called' },
  { entity: 'entitySearch', query: 'how does entity_search rank entities' },
  { entity: 'memoryEntities', query: 'what is memory_entities for' },
  { entity: 'namespaceSubtree', query: 'how does namespace_subtree scope retrieval' },
  { entity: 'backfillNamespaces', query: 'when does backfill_namespaces run' },
  { entity: 'reembedStaleMemories', query: 'how does reembed_stale_memories work' },
  { entity: 'src/memory/search/scope.ts', query: 'what lives in memory search scope' },
]

const DECOYS = [
  'the caching layer keeps a bounded LRU of session payloads',
  'telemetry events are batched and flushed every five seconds',
  'the retry policy uses bounded exponential backoff with jitter',
  'the renderer draws the sidebar with a generation counter guard',
  'the queue drains at most twenty jobs per startup',
  'the logger writes structured lines to stderr',
  'credentials are read from the environment by the client',
  'the digest summarises pinned facts for a namespace',
]

function recallAtK(results: string[], targets: string[], k: number): number {
  if (targets.length === 0) return 0
  const top = new Set(results.slice(0, k))
  return targets.filter((t) => top.has(t)).length / targets.length
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
}

function leakRate(results: string[][], namespace: string): number {
  const total = results.flat().length
  if (total === 0) return 0
  const outside = results.flat().filter((ns) => !(ns === namespace || ns.startsWith(`${namespace}/`))).length
  return outside / total
}

function latencyStats(samples: number[]): { median: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
  return { median, p95 }
}

interface Corpus {
  db: Database.Database
  store: MemoryStore
  crossNotationQueries: Array<{ query: string; targetId: string; kind: string }>
  pathQueries: Array<{ query: string; targetId: string }>
  entityQueries: Array<{ query: string; targetId: string }>
  namespaceOf: (id: string) => string
}

async function buildCorpus(): Promise<Corpus> {
  const db = createTestDb().db
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    SESSION,
    PROJECT,
    Date.now()
  )
  const store = new MemoryStore(db, false)
  const crossNotationQueries: Corpus['crossNotationQueries'] = []
  const pathQueries: Corpus['pathQueries'] = []
  const entityQueries: Corpus['entityQueries'] = []

  for (let i = 0; i < NOTATION_QUERIES.length; i++) {
    const { stored, query, kind } = NOTATION_QUERIES[i]
    const memory = await store.store({
      content: `Memory ${i}: the ${stored} entry point handles retrieval for this project`,
      session_id: SESSION,
      project_path: PROJECT,
    })
    crossNotationQueries.push({ query, targetId: memory.id, kind })
  }

  for (let i = 0; i < PATH_QUERIES.length; i++) {
    const { ident, path } = PATH_QUERIES[i]
    const memory = await store.store({
      content: `Path note ${i}: ${ident} lives in ${path}`,
      session_id: SESSION,
      project_path: PROJECT,
    })
    pathQueries.push({ query: path, targetId: memory.id })
  }

  for (let i = 0; i < ENTITY_CASES.length; i++) {
    const { entity, query } = ENTITY_CASES[i]
    const memory = await store.store({
      content: `Entity note ${i}: the \`${entity}\` helper is used by the retrieval pipeline`,
      session_id: SESSION,
      project_path: PROJECT,
    })
    entityQueries.push({ query, targetId: memory.id })
  }

  for (let d = 0; d < DECOYS.length; d++) {
    await store.store({ content: `Note ${d}: ${DECOYS[d]}`, session_id: SESSION, project_path: PROJECT })
  }
  for (let i = 0; i < NOTATION_QUERIES.length; i++) {
    await store.store({
      content: `Foreign ${i}: ${NOTATION_QUERIES[i].stored} in another project`,
      session_id: SESSION,
      project_path: FOREIGN,
    })
  }

  const nsRows = db
    .prepare('SELECT id, COALESCE(namespace, project_path) AS ns FROM memories')
    .all() as Array<{ id: string; ns: string }>
  const nsById = new Map(nsRows.map((r) => [r.id, r.ns]))
  return {
    db,
    store,
    crossNotationQueries,
    pathQueries,
    entityQueries,
    namespaceOf: (id: string) => nsById.get(id) ?? '?',
  }
}

describe('eval: identifier lexical channel (ident-lexical)', () => {
  it('measures cross-notation and path-query recall for memories_fts (baseline) vs the ident channel', async () => {
    const { db, crossNotationQueries, pathQueries, namespaceOf } = await buildCorpus()

    const run = (search: (query: string) => string[], queries: Array<{ query: string; targetId: string }>) => {
      const hits: number[] = []
      const latencies: number[] = []
      const namespaces: string[][] = []
      for (const { query, targetId } of queries) {
        const t0 = performance.now()
        const ids = search(query)
        latencies.push(performance.now() - t0)
        hits.push(recallAtK(ids, [targetId], 10))
        namespaces.push(ids.map(namespaceOf))
      }
      return { recall: mean(hits), latencies: latencyStats(latencies), leak: leakRate(namespaces, PROJECT) }
    }

    const baseline = run((q) => ftsSearch(db, q, { project_path: PROJECT }, 10).map((m) => m.id), crossNotationQueries)
    const ident = run((q) => identSearch(db, q, { project_path: PROJECT }, 10).map((m) => m.id), crossNotationQueries)
    const baselinePath = run((q) => ftsSearch(db, q, { project_path: PROJECT }, 10).map((m) => m.id), pathQueries)
    const identPath = run((q) => identSearch(db, q, { project_path: PROJECT }, 10).map((m) => m.id), pathQueries)

    console.log(
      [
        `### ident-lexical (k=10, k=10; ${crossNotationQueries.length} cross-notation + ${pathQueries.length} path queries)`, '',
        '| query set | channel | recall@10 | precision@10 | leakRate | median latency | p95 latency |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        `| cross-notation | memories_fts (baseline) | ${baseline.recall.toFixed(3)} | ${(baseline.recall / 10).toFixed(3)} | ${baseline.leak.toFixed(3)} | ${baseline.latencies.median.toFixed(2)}ms | ${baseline.latencies.p95.toFixed(2)}ms |`,
        `| cross-notation | memories_ident_fts (ident-lexical) | ${ident.recall.toFixed(3)} | ${(ident.recall / 10).toFixed(3)} | ${ident.leak.toFixed(3)} | ${ident.latencies.median.toFixed(2)}ms | ${ident.latencies.p95.toFixed(2)}ms |`,
        `| dotted path | memories_fts (baseline) | ${baselinePath.recall.toFixed(3)} | ${(baselinePath.recall / 10).toFixed(3)} | ${baselinePath.leak.toFixed(3)} | ${baselinePath.latencies.median.toFixed(2)}ms | ${baselinePath.latencies.p95.toFixed(2)}ms |`,
        `| dotted path | memories_ident_fts (ident-lexical) | ${identPath.recall.toFixed(3)} | ${(identPath.recall / 10).toFixed(3)} | ${identPath.leak.toFixed(3)} | ${identPath.latencies.median.toFixed(2)}ms | ${identPath.latencies.p95.toFixed(2)}ms |`,
      ].join('\n')
    )

    expect(baseline.recall).toBeLessThanOrEqual(0.25)
    expect(ident.recall).toBe(1)
    expect(identPath.recall).toBe(1)
    expect(ident.leak).toBe(0)
    expect(baselinePath.recall).toBe(1)
    // the channel is a small FTS query, not a scan
    expect(ident.latencies.p95).toBeLessThan(50)
    db.close()
  })

  it('is reproducible: identical queries give identical rankings', async () => {
    const { db, crossNotationQueries } = await buildCorpus()
    for (const { query } of crossNotationQueries.slice(0, 4)) {
      const first = identSearch(db, query, { project_path: PROJECT }, 10).map((m) => [m.id, m.content])
      const second = identSearch(db, query, { project_path: PROJECT }, 10).map((m) => [m.id, m.content])
      expect(second).toEqual(first)
    }
    db.close()
  })
})

describe('eval: entity channel (entity-channel)', () => {
  it('measures prose-query recall for searchByEntity (baseline) vs entitySearch', async () => {
    const { db, store, entityQueries } = await buildCorpus()

    const baselineHits: number[] = []
    const entityHits: number[] = []
    const reciprocalRanks: number[] = []
    const latency: number[] = []

    for (const { query, targetId } of entityQueries) {
      baselineHits.push(recallAtK(store.searchByEntity(query, PROJECT, 10).map((m) => m.id), [targetId], 10))

      const t0 = performance.now()
      const ids = entitySearch(db, query, { project_path: PROJECT }, 10).map((m) => m.id)
      latency.push(performance.now() - t0)
      entityHits.push(recallAtK(ids, [targetId], 10))
      const rank = ids.indexOf(targetId)
      reciprocalRanks.push(rank >= 0 ? 1 / (rank + 1) : 0)
    }

    const entityRecall = mean(entityHits)
    const mrr = mean(reciprocalRanks)
    const lat = latencyStats(latency)

    console.log(
      [
        `### entity-channel (mean of ${entityQueries.length} prose queries, k=10)`, '',
        '| channel | recall@10 | precision@10 | MRR | median latency | p95 latency |',
        '| --- | --- | --- | --- | --- | --- |',
        `| searchByEntity (exact NOCASE) | ${mean(baselineHits).toFixed(3)} | 0.000 | 0.000 | n/a | n/a |`,
        `| memory_entity_fts (entity-channel) | ${entityRecall.toFixed(3)} | ${(entityRecall / 10).toFixed(3)} | ${mrr.toFixed(3)} | ${lat.median.toFixed(2)}ms | ${lat.p95.toFixed(2)}ms |`,
      ].join('\n')
    )

    expect(mean(baselineHits)).toBe(0)
    expect(entityRecall).toBeGreaterThanOrEqual(0.9)
    expect(mrr).toBeGreaterThan(0.5)
    expect(lat.p95).toBeLessThan(50)
    db.close()
  })
})

describe('eval: graph channel scoping and weighting (graph-fused)', () => {
  it('measures namespace leak rate before/after scoping and similarity weighting', async () => {
    const db = createTestDb().db
    db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run('g', PROJECT, 1)
    const seed = (id: string, ns: string): void => {
      db.prepare(
        `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from)
         VALUES (?, 'g', ?, ?, ?, 'note', 0.5, '[]', 100, 100)`
      ).run(id, ns, ns, id)
    }
    const link = (s: string, t: string, sim: number): void => {
      db.prepare(
        `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at) VALUES (?, ?, ?, 'semantic', 1)`
      ).run(s, t, sim)
    }

    const SEEDS = 8
    for (let i = 0; i < SEEDS; i++) {
      seed(`a-seed-${i}`, PROJECT)
      seed(`a-hub-${i}`, PROJECT)
      seed(`a-leaf-${i}`, `${PROJECT}/packages/api`)
      seed(`b-${i}`, FOREIGN)
      link(`a-seed-${i}`, `a-hub-${i}`, 0.9)
      link(`a-hub-${i}`, `a-leaf-${i}`, 0.6)
      link(`a-seed-${i}`, `b-${i}`, 0.9) // global _autoLink edge across projects
    }

    const namespaces = new Map(
      (db.prepare('SELECT id, COALESCE(namespace, project_path) AS ns FROM memories').all() as Array<{
        id: string
        ns: string
      }>).map((r) => [r.id, r.ns])
    )
    const nsOf = (ids: string[]) => ids.map((id) => namespaces.get(id) ?? '?')

    const unscoped: string[][] = []
    const scoped: string[][] = []
    let weightedTop = 0
    for (let i = 0; i < SEEDS; i++) {
      const seeds = [`a-seed-${i}`]
      unscoped.push(nsOf(pprSearch(db, seeds, 20).map((r) => r.id)))
      const rows = pprSearch(db, seeds, 20, { namespace_subtree: PROJECT })
      scoped.push(nsOf(rows.map((r) => r.id)))
      const hub = rows.findIndex((r) => r.id === `a-hub-${i}`)
      const leaf = rows.findIndex((r) => r.id === `a-leaf-${i}`)
      if (hub >= 0 && leaf >= 0 && hub < leaf) weightedTop++
    }

    const unscopedLeak = leakRate(unscoped, PROJECT)
    const scopedLeak = leakRate(scoped, PROJECT)
    console.log(
      [
        '### graph-fused (8 seeds with cross-project _autoLink edges)',
        '',
        '| variant | leakRate | seeds with hub ranked above leaf |',
        '| --- | --- | --- |',
        `| pprSearch (unscoped) | ${unscopedLeak.toFixed(3)} | n/a |`,
        `| pprSearch + namespace_subtree | ${scopedLeak.toFixed(3)} | ${weightedTop}/${SEEDS} |`,
      ].join('\n')
    )

    expect(unscopedLeak).toBeGreaterThan(0)
    expect(scopedLeak).toBe(0)
    expect(weightedTop).toBe(SEEDS)
    db.close()
  })
})

describe('eval: config registry', () => {
  it('ships the three named configs as stable identifiers', () => {
    expect(Object.keys(configs).sort()).toEqual(['entity-channel', 'graph-fused', 'ident-lexical'])
    for (const [name, patch] of Object.entries(configs)) {
      expect(patch.label, name).toBe(name)
      expect(patch.notes, name).toBeTruthy()
      expect(patch.features, name).toBeTruthy()
    }
    expect(configs['ident-lexical'].features).toMatchObject({ ident_channel: true })
    expect(configs['entity-channel'].features).toMatchObject({ entity_channel: true })
    expect(configs['graph-fused'].features).toMatchObject({ graph_namespace_scope: true })
  })
})
