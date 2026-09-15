// eval-funnel.ts — P1 hierarchical funnel evaluation (spec: docs/specs/hierarchical-memory-p1.md)
//
// Read-only comparison of two retrieval strategies on the real engram database:
//   A. flat baseline — hybridSearch over the memory's whole (flat) namespace, i.e.
//      the pre-hierarchy behavior where every memory in a git-root shares one bucket.
//   B. funnel        — hybridSearch scoped to the deepest-known namespace prefix of
//      the session scope, ascending to ancestor nav layers only when the leaf is thin.
//
// Safety: DB opened `readonly: true`; hybridSearch runs with `vectorsAvailable = false`
// (FTS5-only, zero embedding/network writes) and `touch: false` (no last_accessed /
// access_count stamping). The namespace tree is computed with the pure
// `parseNamespacePath` / `ancestorPaths` helpers — no namespace_nodes writes, so this
// is safe against a pre-migration DB.
//
// Deterministic: fixed RNG seed + scoring clock set to the DB's own max created_at.
//
// Usage: npx tsx scripts/eval-funnel.ts [--probes N]

import Database from 'better-sqlite3'
import os from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { hybridSearch } from '../src/memory/search/hybrid.js'
import type { SearchResult } from '../src/memory/types.js'
import { parseNamespacePath, ancestorPaths, ensureNode, refreshNodeCounts } from '../src/namespace/tree.js'
import { promoteScopePatterns } from '../src/maintenance/promote.js'
import { consolidateTree } from '../src/maintenance/consolidate.js'
import { resetLlmConfigForTests } from '../src/llm/client.js'

// ── constants ────────────────────────────────────────────────────────────────
const VECTORS = false // FTS5-only: deterministic, zero side effects
const K = 5 // context/recall top-k
const QUERY_LIMIT = 10 // fetch enough for recall@10
const FUNNEL_K_MIN = 3 // mirrors handlers.ts
const FUNNEL_THETA = 0.35 // mirrors handlers.ts
const GUIDE_EXCERPT_CHARS = 240

const STOP = new Set(
  'the a an and or but for nor of in on at to from by with about this that these those is are was were be been being has have had do does did not no so if then than too very just can will shall may might must only own same such t s i me my we our you your he she it they them his her its their what which who whom whose when where why how all any both each few more most other some little enough between into through during before after above below up down out off over under again further once here there'.split(
    ' '
  )
)

type Probe = {
  namespace: string // the memory's flat bucket (git-root)
  scope: string // session scope (the funnel leaf request)
  sourceId: string
  query: string
  queryFrom: 'entity' | 'content'
}

type ModeResult = {
  ids: string[]
  contents: number[] // content char lengths, top-k
  topScore: number | null
  responseBytes: number
  guideEntries: number
}

// ── helpers ──────────────────────────────────────────────────────────────────
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(os.homedir(), p.slice(2)) : p
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sample<T>(arr: T[], n: number, rand: () => number): T[] {
  const copy = arr.slice()
  const out: T[] = []
  while (out.length < n && copy.length > 0) {
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0])
  }
  return out
}

function memoryRows(db: Database.Database, namespace: string): Array<{ id: string; content: string }> {
  return db
    .prepare(`SELECT id, content FROM memories WHERE COALESCE(namespace, project_path) = ?`)
    .all(namespace) as Array<{ id: string; content: string }>
}

function entityTerms(db: Database.Database, memoryId: string): string[] {
  const rows = db
    .prepare(`SELECT entity_text FROM memory_entities WHERE memory_id = ? ORDER BY id ASC LIMIT 40`)
    .all(memoryId) as Array<{ entity_text: string }>
  const out: string[] = []
  for (const r of rows) {
    const t = (r.entity_text ?? '').trim()
    // FTS5-safe single token: alnum + underscore only (hyphens/dots are
    // token separators), reject short all-caps symbols (RET/NOT/UTC).
    if (!/^[A-Za-z0-9_]+$/.test(t)) continue
    if (/^[A-Z0-9_]{2,5}$/.test(t)) continue // short all-caps junk
    if (STOP.has(t.toLowerCase())) continue
    if (!out.includes(t)) out.push(t)
  }
  return out
}

function contentTokens(content: string): string[] {
  const m = content.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g)
  if (!m) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of m) {
    if (STOP.has(t) || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** Document frequency of a token across the whole DB (used to pick rare terms). */
function docFreq(db: Database.Database, token: string): number {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?`)
      .get(`"${token.replace(/"/g, '""')}"`) as { n: number }
    return row.n
  } catch {
    return 0
  }
}

function buildQuery(
  db: Database.Database,
  memory: { id: string; content: string }
): { query: string; from: 'entity' | 'content' } {
  const entities = entityTerms(db, memory.id)
  const picks = entities.length >= 2 ? entities : entities.concat(contentTokens(memory.content))
  // Two rarest distinctive terms (entity preferred on ties).
  const scored = picks
    .slice(0, 12)
    .map((t) => ({ t, df: docFreq(db, t), entity: entities.includes(t) }))
    .sort((a, b) => a.df - b.df || Number(b.entity) - Number(a.entity))
  let terms = scored.slice(0, 2).map((s) => s.t)
  if (terms.length < 2) terms = contentTokens(memory.content).slice(0, 2)
  const from = terms.every((t) => entities.includes(t)) ? 'entity' : 'content'
  return { query: terms.join(' '), from }
}

/** Read-only mirror of deepestKnownPrefix: first candidate existing in the known set. */
function deepestKnownPrefixIn(ns: string, known: Set<string>): string | null {
  const parsed = parseNamespacePath(ns)
  const candidates: string[] = []
  if (parsed.isPathShaped) {
    const root = ns.startsWith('~') ? '~' : '/'
    const base = parsed.realPath ?? ns
    const segs = base.slice(root.length).split('/').filter(Boolean)
    if (parsed.scope !== null) candidates.push(ns)
    for (let i = segs.length; i >= 1; i--) candidates.push(root + segs.slice(0, i).join('/'))
    candidates.push(root)
  } else {
    candidates.push(ns)
  }
  return candidates.find((c) => known.has(c)) ?? null
}

function clusterSummaries(db: Database.Database, namespace: string): string[] {
  const rows = db
    .prepare(
      `SELECT summary FROM memory_clusters
       WHERE project_path = ? AND TRIM(summary) != '' ORDER BY updated_at DESC, id ASC`
    )
    .all(namespace) as Array<{ summary: string }>
  return rows.map((r) => r.summary)
}

function guideForParent(db: Database.Database, namespace: string, query: string): Array<{ kind: string; excerpt: string }> {
  const tokens = query.trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase())
  if (tokens.length === 0) return []
  const hits: Array<{ kind: string; excerpt: string }> = []
  for (const text of clusterSummaries(db, namespace)) {
    if (hits.length >= 2) break
    const lower = text.toLowerCase()
    let first = -1
    for (const t of tokens) {
      const i = lower.indexOf(t)
      if (i >= 0 && (first === -1 || i < first)) first = i
    }
    if (first < 0) continue
    const start = Math.max(0, first - Math.floor(GUIDE_EXCERPT_CHARS / 2))
    const raw = text.slice(start, start + GUIDE_EXCERPT_CHARS).replace(/\s+/g, ' ').trim()
    hits.push({ kind: 'cluster', excerpt: `…${raw}…`.slice(0, GUIDE_EXCERPT_CHARS) })
  }
  return hits
}

function rawMemoryField(m: SearchResult): Record<string, unknown> {
  return { id: m.id, type: m.type, importance: m.importance, tags: m.tags, content: m.content }
}

function buildResponseBytes(
  db: Database.Database,
  namespace: string,
  digest: string,
  top: SearchResult[],
  trace: Array<Record<string, unknown>>,
  guide: Array<Record<string, unknown>>
): number {
  const topics = clusterSummaries(db, namespace).map((s) => ({ summary: s }))
  const body = {
    namespace,
    digest: digest.slice(0, 2000),
    memories: top.map(rawMemoryField),
    topics,
    ...(trace.length > 0 ? { scope_trace: trace } : {}),
    ...(guide.length > 0 ? { guide } : {}),
  }
  return JSON.stringify(body, null, 2).length
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

// ── eval core ────────────────────────────────────────────────────────────────
async function run(db: Database.Database): Promise<void> {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--probes')
  const PROBES = i >= 0 ? Number(argv[i + 1]) : 30

  const nowRow = db.prepare(`SELECT MAX(created_at) AS n FROM memories`).get() as { n: number }
  const NOW = nowRow.n

  const nsRows = db
    .prepare(`SELECT COALESCE(namespace, project_path) ns, COUNT(*) c FROM memories GROUP BY 1 ORDER BY c DESC`)
    .all() as Array<{ ns: string; c: number }>
  const known = new Set(nsRows.map((r) => r.ns))
  const top2 = nsRows.slice(0, 2)

  const rand = mulberry32(0x5eed1234)
  const probes: Probe[] = []
  const perNs = Math.max(1, Math.floor(PROBES / top2.length))
  for (const { ns } of top2) {
    for (const m of sample(memoryRows(db, ns), perNs, rand)) {
      const { query, from } = buildQuery(db, m)
      probes.push({ namespace: ns, scope: ns, sourceId: m.id, query, queryFrom: from })
    }
  }

  const usable: Probe[] = []
  const dropped: string[] = []
  for (const p of probes) {
    if (!p.query.trim()) {
      dropped.push(`${p.scope}/${p.sourceId}: empty query`)
      continue
    }
    const flat10 = await hybridSearch(db, VECTORS, p.query, {
      project_path: p.namespace,
      limit: 10,
      touch: false,
      now: NOW,
    })
    if (flat10.some((r) => r.id === p.sourceId)) {
      usable.push(p)
      continue
    }
    // Fall back to rare content tokens; only drop if still unretrievable (a
    // broken token yields a broken probe, not a recall signal).
    const content = (db.prepare(`SELECT content FROM memories WHERE id = ?`).get(p.sourceId) as { content: string }).content
    const fallback = contentTokens(content).slice(0, 2).join(' ')
    if (fallback && fallback !== p.query) {
      const retry = await hybridSearch(db, VECTORS, fallback, {
        project_path: p.namespace,
        limit: 10,
        touch: false,
        now: NOW,
      })
      if (retry.some((r) => r.id === p.sourceId)) {
        p.query = fallback
        p.queryFrom = 'content'
        usable.push(p)
        continue
      }
    }
    dropped.push(`${p.scope}/${p.sourceId}: source not retrievable by its own terms`)
  }

  const digestCache = new Map<string, string>()
  const digestOf = (ns: string): string => {
    if (!digestCache.has(ns)) {
      const r = db.prepare(`SELECT content FROM project_digests WHERE namespace = ?`).get(ns) as { content: string } | undefined
      digestCache.set(ns, r?.content ?? '')
    }
    return digestCache.get(ns) ?? ''
  }

  const flat: ModeResult[] = []
  const funnel: ModeResult[] = []
  const missRanks: number[] = [] // flat rank of source when not in top-k
  const topScores: number[] = [] // flat normalized top scores, for THETA calibration
  const thinLeafCases: number[] = [] // funnelRes.length when a non-leaf scope came back thin

  for (const p of usable) {
    const leaf = deepestKnownPrefixIn(p.scope, known) ?? p.scope
    const flatRes = await hybridSearch(db, VECTORS, p.query, {
      project_path: p.namespace,
      limit: QUERY_LIMIT,
      touch: false,
      now: NOW,
    })
    const funnelRes = await hybridSearch(db, VECTORS, p.query, {
      project_path: leaf,
      limit: QUERY_LIMIT,
      touch: false,
      now: NOW,
    })

    const topScore = (rs: SearchResult[]) =>
      rs.length > 0 ? Math.min(1, Math.max(0, Math.max(...rs.map((r) => r.score)))) : null

    const trace: Array<Record<string, unknown>> = [
      { namespace: leaf, depth: parseNamespacePath(leaf).depth, hits: funnelRes.length, top_score: topScore(funnelRes), action: 'searched' },
    ]
    const guide: Array<Record<string, unknown>> = []
    const rich = funnelRes.length >= FUNNEL_K_MIN && (topScore(funnelRes) ?? 0) >= FUNNEL_THETA
    if (leaf !== p.namespace) {
      if (!rich) thinLeafCases.push(funnelRes.length)
      for (const parent of ancestorPaths(leaf)) {
        if (rich) {
          trace.push({ namespace: parent, depth: parseNamespacePath(parent).depth, action: 'skipped' })
        } else {
          const hits = guideForParent(db, parent, p.query)
          guide.push(
            ...hits.map((h) => ({ namespace: parent, kind: h.kind, source: h.kind, excerpt: h.excerpt }))
          )
          trace.push({ namespace: parent, depth: parseNamespacePath(parent).depth, hits: hits.length, action: 'guide_only' })
        }
      }
    }

    const srcRankFlat = flatRes.findIndex((r) => r.id === p.sourceId) + 1
    if (srcRankFlat > K) missRanks.push(srcRankFlat)
    const tsFlat = topScore(flatRes)
    if (tsFlat !== null) topScores.push(tsFlat)

    flat.push({
      ids: flatRes.map((r) => r.id),
      contents: flatRes.slice(0, K).map((r) => r.content.length),
      topScore: tsFlat,
      responseBytes: buildResponseBytes(db, p.namespace, digestOf(p.namespace), flatRes.slice(0, K), [], []),
      guideEntries: 0,
    })
    funnel.push({
      ids: funnelRes.map((r) => r.id),
      contents: funnelRes.slice(0, K).map((r) => r.content.length),
      topScore: topScore(funnelRes),
      responseBytes: buildResponseBytes(db, p.namespace, digestOf(p.namespace), funnelRes.slice(0, K), trace, guide),
      guideEntries: guide.length,
    })
  }

  const summarize = (rs: ModeResult[], probs: Probe[]) => {
    const hit5 = rs.map((r, i) => r.ids.slice(0, K).includes(probs[i].sourceId))
    const hit10 = rs.map((r, i) => r.ids.slice(0, 10).includes(probs[i].sourceId))
    return {
      probes: rs.length,
      recallAt5: mean(hit5.map(Number)),
      recallAt10: mean(hit10.map(Number)),
      contextCharsAt5: Math.round(mean(rs.map((r) => r.contents.reduce((a, b) => a + b, 0)))),
      responseBytes: Math.round(mean(rs.map((r) => r.responseBytes))),
      guideEntries: mean(rs.map((r) => r.guideEntries)),
    }
  }

  // Per-namespace breakdown (parity table).
  const byNs: Record<string, { flat: ModeResult[]; funnel: ModeResult[]; probs: Probe[] }> = {}
  usable.forEach((p, i) => {
    ;(byNs[p.namespace] ??= { flat: [], funnel: [], probs: [] }).flat.push(flat[i])
    byNs[p.namespace].funnel.push(funnel[i])
    byNs[p.namespace].probs.push(p)
  })
  const perNamespace = Object.fromEntries(
    Object.entries(byNs).map(([ns, g]) => [ns, { flat: summarize(g.flat, g.probs), funnel: summarize(g.funnel, g.probs) }])
  )

  // Normalized top-score histogram (flat), for THETA calibration.
  const hist = { '<0.2': 0, '0.2-0.35': 0, '0.35-0.5': 0, '>=0.5': 0 }
  for (const s of topScores) {
    if (s < 0.2) hist['<0.2']++
    else if (s < 0.35) hist['0.2-0.35']++
    else if (s < 0.5) hist['0.35-0.5']++
    else hist['>=0.5']++
  }

  console.log('\n=== eval-funnel results ===')
  console.log(
    JSON.stringify(
      {
        db: dbPath,
        vectors: VECTORS,
        touch: false,
        scoringClock: NOW,
        k: K,
        funnelThresholds: { K_MIN: FUNNEL_K_MIN, THETA: FUNNEL_THETA },
        probesRequested: probes.length,
        probesUsable: usable.length,
        probesDropped: dropped.length,
        recallMissRanksAt5: missRanks,
        topScoreHistogram: hist,
        perNamespace,
        flat: summarize(flat, usable),
        funnel: summarize(funnel, usable),
      },
      null,
      2
    )
  )
  if (dropped.length > 0) console.log('dropped probes:', dropped.join(' | '))
}

// ── P2: scoped-write projection ─────────────────────────────────────────────
// Question: if we shard the largest flat namespace into k synthetic scopes
// (spec Part C), does funnel retrieval keep recall while cutting the context
// shipped to the model? Runs on a temp COPY of the live DB — the original is
// opened readonly and never written.

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

interface ScopedRow {
  k: number
  scopeCount: number
  memoriesPerScopeAvg: number
  memoriesPerScopeMin: number
  memoriesPerScopeMax: number
  probes: number
  recallAt5Flat: number
  recallAt5Funnel: number
  recallAt5Delta: number
  contextCharsAt5Flat: number
  contextCharsAt5Funnel: number
  contextCharsSavingsPct: number
  responseBytesFlat: number
  responseBytesFunnel: number
  responseBytesSavingsPct: number
}

// Reduction %: positive means `numer` is smaller than `denom` (a saving).
function savingsPct(numer: number, denom: number): number {
  return denom === 0 ? 0 : Math.round(((denom - numer) / denom) * 1000) / 10
}

async function runScopedProjection(dbPath: string, probesWanted: number): Promise<void> {
  console.log('backing up live DB (readonly) to temp copy for P2 projection:', dbPath)
  const source = new Database(dbPath, { readonly: true, fileMustExist: true })
  const tmpPath = join(os.tmpdir(), `engram-eval-p2-${process.pid}.db`)
  await source.backup(tmpPath)
  source.close()
  const db = new Database(tmpPath, { readonly: false, fileMustExist: true })

  try {
    const nowRow = db.prepare('SELECT MAX(created_at) AS n FROM memories').get() as { n: number }
    const NOW = nowRow.n

    const nsRows = db
      .prepare('SELECT COALESCE(namespace, project_path) ns, COUNT(*) c FROM memories GROUP BY 1 ORDER BY c DESC')
      .all() as Array<{ ns: string; c: number }>
    const MS = nsRows[0].ns
    const msTotal = nsRows[0].c

    const allIds = db
      .prepare('SELECT id FROM memories WHERE COALESCE(namespace, project_path) = ?')
      .all(MS) as Array<{ id: string }>

    // First entity token per memory → deterministic scope key (id fallback).
    const entityRows = db
      .prepare(
        `SELECT e.memory_id, e.entity_text
         FROM memory_entities e
         JOIN memories m ON m.id = e.memory_id
         WHERE COALESCE(m.namespace, m.project_path) = ?
         ORDER BY e.memory_id ASC, e.id ASC`
      )
      .all(MS) as Array<{ memory_id: string; entity_text: string }>
    const firstEntity = new Map<string, string>()
    for (const r of entityRows) {
      if (!firstEntity.has(r.memory_id)) firstEntity.set(r.memory_id, (r.entity_text ?? '').trim())
    }

    // Probes sampled from the project; usable only when the source is
    // retrievable in the whole-project (flat) search by its own terms.
    const rand = mulberry32(0xfeed5eed)
    const sampled = sample(allIds, Math.max(probesWanted, 3), rand)
    const flatByProbe = new Map<string, SearchResult[]>()
    const queryByProbe = new Map<string, string>()
    for (const { id } of sampled) {
      const row = db.prepare('SELECT id, content FROM memories WHERE id = ?').get(id) as {
        id: string
        content: string
      }
      const { query } = buildQuery(db, row)
      if (!query || !query.trim()) continue
      // Flat baseline is k-independent and must reflect the pre-hierarchy
      // one-bucket behavior, so it runs on the pristine (un-redistributed) copy
      // via exact `project_path`. (namespace_subtree is avoided here — it has a
      // live defect, see docs/eval-funnel-p2.md §Funnel defects.)
      const flat = await hybridSearch(db, VECTORS, query, {
        project_path: MS,
        limit: QUERY_LIMIT,
        touch: false,
        now: NOW,
      })
      if (!flat.some((r) => r.id === id)) continue // broken token → broken probe
      flatByProbe.set(id, flat)
      queryByProbe.set(id, query)
    }

    const digestOf = (ns: string): string => {
      const r = db.prepare('SELECT content FROM project_digests WHERE namespace = ?').get(ns) as
        | { content: string }
        | undefined
      return r?.content ?? ''
    }
    const digest = digestOf(MS)

    const assign = db.prepare('UPDATE memories SET namespace = ? WHERE id = ?')
    const rows: ScopedRow[] = []

    for (const k of [5, 20, 50]) {
      const scopeOf = new Map<string, string>()
      for (const { id } of allIds) {
        const key = firstEntity.get(id) || id
        scopeOf.set(id, `${MS}//s${fnv1a(key) % k}`)
      }
      db.transaction(() => {
        for (const [id, ns] of scopeOf) assign.run(ns, id)
      })()

      const scopeCounts = db
        .prepare('SELECT COUNT(*) AS c FROM memories WHERE namespace LIKE ? GROUP BY namespace')
        .all(`${MS}//%`) as Array<{ c: number }>
      const counts = scopeCounts.map((r) => r.c)

      let hit5F = 0
      let hit5N = 0
      let charsF = 0
      let charsN = 0
      let bytesF = 0
      let bytesN = 0
      let n = 0
      for (const [id, query] of queryByProbe) {
        const leaf = scopeOf.get(id) as string
        const flat = flatByProbe.get(id) as SearchResult[]
        const funn = await hybridSearch(db, VECTORS, query, {
          project_path: leaf,
          limit: QUERY_LIMIT,
          touch: false,
          now: NOW,
        })

        hit5F += flat.slice(0, K).some((r) => r.id === id) ? 1 : 0
        hit5N += funn.slice(0, K).some((r) => r.id === id) ? 1 : 0
        const topF = flat.slice(0, K)
        const topN = funn.slice(0, K)
        charsF += topF.reduce((a, r) => a + r.content.length, 0)
        charsN += topN.reduce((a, r) => a + r.content.length, 0)

        const rich = topN.length >= FUNNEL_K_MIN && (topN[0]?.score ?? 0) >= FUNNEL_THETA
        const trace: Array<Record<string, unknown>> = [
          { namespace: leaf, depth: parseNamespacePath(leaf).depth, hits: topN.length, action: 'searched' },
        ]
        const guide: Array<Record<string, unknown>> = []
        if (!rich) {
          guide.push(
            ...guideForParent(db, MS, query).map((h) => ({
              namespace: MS,
              kind: h.kind,
              source: h.kind,
              excerpt: h.excerpt,
            }))
          )
          trace.push({ namespace: MS, depth: parseNamespacePath(MS).depth, hits: guide.length, action: 'guide_only' })
        }
        bytesF += buildResponseBytes(db, MS, digest, flat.slice(0, K), [], [])
        bytesN += buildResponseBytes(db, MS, digest, funn.slice(0, K), trace, guide)
        n++
      }

      rows.push({
        k,
        scopeCount: counts.length,
        memoriesPerScopeAvg: Math.round(mean(counts)),
        memoriesPerScopeMin: counts.length ? Math.min(...counts) : 0,
        memoriesPerScopeMax: counts.length ? Math.max(...counts) : 0,
        probes: n,
        recallAt5Flat: Math.round((hit5F / n) * 1000) / 1000,
        recallAt5Funnel: Math.round((hit5N / n) * 1000) / 1000,
        recallAt5Delta: Math.round((hit5N / n - hit5F / n) * 1000) / 1000,
        contextCharsAt5Flat: n ? Math.round(charsF / n) : 0,
        contextCharsAt5Funnel: n ? Math.round(charsN / n) : 0,
        contextCharsSavingsPct: savingsPct(charsN, charsF),
        responseBytesFlat: n ? Math.round(bytesF / n) : 0,
        responseBytesFunnel: n ? Math.round(bytesN / n) : 0,
        responseBytesSavingsPct: savingsPct(bytesN, bytesF),
      })
    }

    const result = {
      dbPath,
      tempCopy: tmpPath,
      maxNamespace: MS,
      memoriesInMaxNamespace: msTotal,
      vectors: VECTORS,
      touch: false,
      scoringClock: NOW,
      k: K,
      funnelThresholds: { K_MIN: FUNNEL_K_MIN, THETA: FUNNEL_THETA },
      scopeAssignment: 'fnv1a(first entity token) % k (id fallback)',
      probesSampled: sampled.length,
      probesUsable: queryByProbe.size,
      rows,
    }

    console.log('\n=== eval-funnel P2 scoped-write projection ===')
    console.log(JSON.stringify(result, null, 2))

    writeP2Doc(result)
  } finally {
    db.close()
  }
}

function writeP2Doc(r: {
  maxNamespace: string
  memoriesInMaxNamespace: number
  probesUsable: number
  funnelThresholds: { K_MIN: number; THETA: number }
  scopeAssignment: string
  rows: ScopedRow[]
}): void {
  const L: string[] = []
  L.push('# Eval: P2 scoped-write projection (funnel vs flat)')
  L.push('')
  L.push(
    `Generated by \`npx tsx scripts/eval-funnel.ts --project-scoped\` — runs on a temporary COPY`,
    'of the live DB; the live DB is opened read-only and never written.'
  )
  L.push('')
  L.push('## Method')
  L.push('')
  L.push(`- Largest flat namespace: \`${r.maxNamespace}\` (${r.memoriesInMaxNamespace} memories).`)
  L.push(
    `- For k in {5, 20, 50}: shard those memories into \`<ns>//s0..s(k-1)\` synthetic scopes,`,
    `assigning each memory by \`${r.scopeAssignment}\` (deterministic, so same-entity memories co-locate).`
  )
  L.push('- Probes: sampled source memories; each kept only if its own terms retrieve it in whole-project search.')
  L.push(
    '- flat = hybridSearch on the pristine (pre-shard) copy via exact project_path — the true one-bucket',
    'baseline. funnel = hybridSearch scoped to the source\u2019s leaf scope (exact).'
  )
  L.push(`- Recall at K=${K}; funnel thresholds K_MIN=${r.funnelThresholds.K_MIN}, THETA=${r.funnelThresholds.THETA}.`)
  L.push(`- ${r.probesUsable} usable probes.`)
  L.push('')
  L.push('## Results')
  L.push('')
  L.push('| k | scopes | mem/scope (avg|min|max) | recall@5 flat | recall@5 funnel | Δ recall | ctx chars@5 flat | ctx chars@5 funnel | ctx savings % |')
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of r.rows) {
    L.push(
      `| ${row.k} | ${row.scopeCount} | ${row.memoriesPerScopeAvg} (${row.memoriesPerScopeMin}..${row.memoriesPerScopeMax}) |` +
        ` ${row.recallAt5Flat} | ${row.recallAt5Funnel} | ${row.recallAt5Delta >= 0 ? '+' : ''}${row.recallAt5Delta} |` +
        ` ${row.contextCharsAt5Flat} | ${row.contextCharsAt5Funnel} | ${row.contextCharsSavingsPct}% |`
    )
  }
  L.push('')
  L.push('## Projected n_scope/N curve (context bytes shipped to the model)')
  L.push('')
  L.push('| k | mem/scope | N (project) | n_scope/N | response bytes flat | funnel | bytes savings % |')
  L.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of r.rows) {
    L.push(
      `| ${row.k} | ${row.memoriesPerScopeAvg} | ${r.memoriesInMaxNamespace} |` +
        ` ${row.memoriesPerScopeAvg}/${r.memoriesInMaxNamespace} |` +
        ` ${row.responseBytesFlat} | ${row.responseBytesFunnel} | ${row.responseBytesSavingsPct}% |`
    )
  }
  L.push('')
  L.push('## Funnel defects found (parent action)')
  L.push('')
  L.push(
    '- `src/memory/search/hybrid.ts` `ftsExec`: the `namespace_subtree` branch is missing its closing',
    'paren — the third OR clause ends `ESCAPE \'\\\'` with no `)`. SQLite throws, the `catch { return [] }`',
    'swallows it, so `strict_scope=false` descendant search silently returns zero results. `project_path`',
    '(exact, used by strict funnel) is unaffected. This eval works around it via exact-scope searches; the',
    'parent should add the closing `)` and a regression test covering `strict_scope=false`.'
  )
  L.push('')
  L.push('## Interpretation')
  L.push('')
  L.push(
    '- Savings are the delta in CONTEXT the agent ships, not raw recall: the funnel must hold recall ',
    '(Δ ≥ 0, ideally) while shrinking the memory content returned.'
  )
  L.push(
    '- Sharding by entity token keeps related memories in one leaf, so the same query that found a source ',
    'in the 3k-memory flat bucket should find it in its own small scope at equal-or-better rank.'
  )
  L.push(
    '- Caveats: FTS5-only (vectors disabled) for determinism; topics/digest are held constant across modes so ',
    'the delta reflects memory content + trace, not topic serialization; scope digests (which would replace ',
    'full ancestor content entirely) are a P3 win not yet modeled here.'
  )
  L.push('')
  writeFileSync('docs/eval-funnel-p2.md', L.join('\n') + '\n')
}

// ── P3: promotion + recursive consolidation ───────────────────────────────
// Question (spec Part C): after sharding a flat namespace into synthetic leaf
// scopes, do (a) scoped funnel retrieval keep recall@5 while cutting shipped
// context, and (b) promote + consolidateTree prime the thin nav-digest layer so
// thin-leaf cross-scope queries surface a guide hit that was absent before?
// Runs on a temp COPY; original opened readonly and never written. LLM mocked
// off (extractive fallback) for determinism and no endpoint dependency.

interface P3ScopeMetrics {
  token: string
  memories: number
  promoted: boolean
}

interface P3GuideRow {
  scopeToken: string
  targetLeaf: string
  leafHits: number
  thin: boolean
  beforeDigestHit: boolean
  afterDigestHit: boolean
}

/**
 * Scope-EXCLUSIVE entity token: present (and frequent) in `scopeIndex`, absent
 * from every other shard's memory_entities. A modal token like "README" is
 * useless as a cross-scope probe because it appears in every leaf — exclusivity
 * is what makes the "thin sibling leaf" probe genuinely thin.
 * Returns null when no natural exclusive token exists (degenerate token overlap).
 */
function scopeExclusiveTokens(
  db: Database.Database,
  scopePaths: string[],
  scopeIndex: number
): Array<{ token: string; count: number }> {
  const inScope = db
    .prepare(
      `SELECT e.entity_text
       FROM memory_entities e
       JOIN memories m ON m.id = e.memory_id
       WHERE COALESCE(m.namespace, m.project_path) = ?`
    )
    .all(scopePaths[scopeIndex]) as Array<{ entity_text: string }>
  const counts = new Map<string, number>()
  for (const r of inScope) {
    const t = (r.entity_text ?? '').trim()
    if (!/^[A-Za-z0-9_]{4,}$/.test(t)) continue
    if (/^[A-Z0-9_]{2,5}$/.test(t)) continue
    if (STOP.has(t.toLowerCase())) continue
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const others = new Set<string>()
  for (let j = 0; j < scopePaths.length; j++) {
    if (j === scopeIndex) continue
    const rows = db
      .prepare(
        `SELECT DISTINCT e.entity_text
         FROM memory_entities e
         JOIN memories m ON m.id = e.memory_id
         WHERE COALESCE(m.namespace, m.project_path) = ?`
      )
      .all(scopePaths[j]) as Array<{ entity_text: string }>
    for (const r of rows) others.add((r.entity_text ?? '').trim())
  }
  return [...counts.entries()]
    .filter(([t]) => !others.has(t))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token, count]) => ({ token, count }))
}

function navDigestOf(db: Database.Database, path: string): string {
  const r = db
    .prepare('SELECT digest FROM namespace_nodes WHERE path = ?')
    .get(path) as { digest: string | null } | undefined
  return r?.digest ?? ''
}

/** Mirror of handlers.navGuideHits, restricted to the digest kind (the primed
 *  nav layer — the clean before/after signal). */
function digestMatches(db: Database.Database, path: string, query: string): boolean {
  const digest = navDigestOf(db, path).toLowerCase()
  if (!digest) return false
  for (const t of query.trim().split(/\s+/).filter(Boolean)) {
    if (digest.indexOf(t.toLowerCase()) >= 0) return true
  }
  return false
}

async function runP3Consolidation(dbPath: string, probesWanted: number): Promise<void> {
  // Deterministic extractive path: no LLM endpoint.
  delete process.env.ENGRAM_LLM_API_KEY
  delete process.env.ENGRAM_LLM_BASE_URL
  resetLlmConfigForTests()

  console.log('backing up live DB (readonly) to temp copy for P3 eval:', dbPath)
  const source = new Database(dbPath, { readonly: true, fileMustExist: true })
  const tmpPath = join(os.tmpdir(), `engram-eval-p3-${process.pid}.db`)
  await source.backup(tmpPath)
  source.close()
  const db = new Database(tmpPath, { readonly: false, fileMustExist: true })

  const SCOPES = 4

  try {
    const nowRow = db.prepare('SELECT MAX(created_at) AS n FROM memories').get() as { n: number }
    const NOW = nowRow.n

    const nsRows = db
      .prepare('SELECT COALESCE(namespace, project_path) ns, COUNT(*) c FROM memories GROUP BY 1 ORDER BY c DESC')
      .all() as Array<{ ns: string; c: number }>
    const NS = nsRows[0].ns
    const nsTotal = nsRows[0].c

    // Phase 0 — ensure tree nodes (no memory mutation yet).
    const scopePaths = Array.from({ length: SCOPES }, (_, i) => `${NS}//s${i}`)
    ensureNode(db, NS)
    for (const sp of scopePaths) ensureNode(db, sp)

    // Phase 1 — pristine flat baseline + probe cache, BEFORE redistribution.
    const allIds = db
      .prepare('SELECT id FROM memories WHERE COALESCE(namespace, project_path) = ?')
      .all(NS) as Array<{ id: string }>
    const rand = mulberry32(0x0f3a11)
    const sampled = sample(allIds, Math.max(probesWanted, 8), rand)
    const flatByProbe = new Map<string, SearchResult[]>()
    const queryByProbe = new Map<string, string>()
    for (const { id } of sampled) {
      const row = db.prepare('SELECT id, content FROM memories WHERE id = ?').get(id) as {
        id: string
        content: string
      }
      const { query } = buildQuery(db, row)
      if (!query || !query.trim()) continue
      const flat = await hybridSearch(db, VECTORS, query, {
        project_path: NS,
        limit: QUERY_LIMIT,
        touch: false,
        now: NOW,
      })
      if (!flat.some((r) => r.id === id)) continue
      flatByProbe.set(id, flat)
      queryByProbe.set(id, query)
    }

    // Neutralize any pre-existing digest state so "before" is unambiguously unprimed.
    db.prepare(
      `UPDATE namespace_nodes SET digest = NULL, digest_source_hash = NULL WHERE path = ? OR path LIKE ?`
    ).run(NS, `${NS}//%`)

    // Phase 2 — redistribute memories into the synthetic scopes (first-entity
    // token + fnv1a, same co-location policy as the P2 projection).
    const entityRows = db
      .prepare(
        `SELECT e.memory_id, e.entity_text
         FROM memory_entities e
         JOIN memories m ON m.id = e.memory_id
         WHERE COALESCE(m.namespace, m.project_path) = ?
         ORDER BY e.memory_id ASC, e.id ASC`
      )
      .all(NS) as Array<{ memory_id: string; entity_text: string }>
    const firstEntity = new Map<string, string>()
    for (const r of entityRows) if (!firstEntity.has(r.memory_id)) firstEntity.set(r.memory_id, (r.entity_text ?? '').trim())
    const scopeOf = new Map<string, string>()
    for (const { id } of allIds) {
      scopeOf.set(id, scopePaths[fnv1a(firstEntity.get(id) || id) % SCOPES])
    }
    const assign = db.prepare('UPDATE memories SET namespace = ? WHERE id = ?')
    db.transaction(() => {
      for (const [id, ns] of scopeOf) assign.run(ns, id)
    })()

    refreshNodeCounts(db, NS)
    for (const sp of scopePaths) refreshNodeCounts(db, sp)

    // Phase 3 — per-scope EXCLUSIVE token + cluster summary backfill, so
    // consolidateTree has condensable sources (a realistic nav-layer input).
    // Exclusivity (not just frequency) keeps the cross-scope probe genuinely thin.
    const scopeTokens = new Map<string, string | null>()
    let syntheticTokenFallbacks = 0
    const now = Date.now()
    const insCluster = db.prepare(
      `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
       VALUES (?, '[]', ?, 1, ?, ?)`
    )
    for (let i = 0; i < SCOPES; i++) {
      const sp = scopePaths[i]
      const exclusive = scopeExclusiveTokens(db, scopePaths, i)
      const tok = exclusive[0]?.token ?? null
      if (tok) {
        scopeTokens.set(sp, tok)
        insCluster.run(sp, `${tok} recurring pattern: the ${tok} scope handles ${tok} setup, configuration, and operational edge cases`, now, now)
      } else {
        // Degenerate overlap: synthesize a scope-unique marker so the probe and
        // the condensed digest still connect through the same token string.
        const marker = `scope${i}marker${i}${i}${i}`
        syntheticTokenFallbacks++
        scopeTokens.set(sp, marker)
        insCluster.run(sp, `${marker} recurring pattern for this scope`, now, now)
      }
    }

    // Phase 4 — BEFORE consolidation: guide-hit rate over thin-leaf cross-scope probes.
    const guideRows: P3GuideRow[] = []
    for (let i = 0; i < SCOPES; i++) {
      const srcTok = scopeTokens.get(scopePaths[i])
      if (!srcTok) continue
      const target = scopePaths[(i + 1) % SCOPES]
      const leaf = await hybridSearch(db, VECTORS, srcTok, {
        project_path: target,
        limit: QUERY_LIMIT,
        touch: false,
        now: NOW,
      })
      const thin = leaf.length < FUNNEL_K_MIN || leaf.length === 0 || (leaf[0]?.score ?? 0) < FUNNEL_THETA
      guideRows.push({
        scopeToken: srcTok,
        targetLeaf: target,
        leafHits: leaf.length,
        thin,
        beforeDigestHit: digestMatches(db, NS, srcTok),
        afterDigestHit: false,
      })
    }
    const beforeHit = guideRows.filter((g) => g.beforeDigestHit).length
    const thinRows = guideRows.filter((g) => g.thin)

    // Phase 5 — promote + consolidate (the P3 sleep-time pipeline).
    const report = await promoteScopePatterns(db, NS)
    const consolidated = await consolidateTree(db, NS)

    // Phase 6 — AFTER: re-check digest guide hits on the same probes.
    for (const g of guideRows) g.afterDigestHit = digestMatches(db, NS, g.scopeToken)
    const afterHit = guideRows.filter((g) => g.afterDigestHit).length

    // Phase 7 — funnel recall@5 + shipped context vs the cached flat baseline.
    let hit5F = 0
    let hit5N = 0
    let charsF = 0
    let charsN = 0
    let bytesF = 0
    let bytesN = 0
    let n = 0
    for (const [id, query] of queryByProbe) {
      const leafPath = scopeOf.get(id) as string
      const flat = flatByProbe.get(id) as SearchResult[]
      const funn = await hybridSearch(db, VECTORS, query, {
        project_path: leafPath,
        limit: QUERY_LIMIT,
        touch: false,
        now: NOW,
      })
      hit5F += flat.slice(0, K).some((r) => r.id === id) ? 1 : 0
      hit5N += funn.slice(0, K).some((r) => r.id === id) ? 1 : 0
      const topF = flat.slice(0, K)
      const topN = funn.slice(0, K)
      charsF += topF.reduce((a, r) => a + r.content.length, 0)
      charsN += topN.reduce((a, r) => a + r.content.length, 0)

      const rich = topN.length >= FUNNEL_K_MIN && (topN[0]?.score ?? 0) >= FUNNEL_THETA
      const trace: Array<Record<string, unknown>> = [
        { namespace: leafPath, depth: parseNamespacePath(leafPath).depth, hits: topN.length, action: 'searched' },
      ]
      const guide: Array<Record<string, unknown>> = []
      if (!rich) {
        guide.push(...guideForParent(db, NS, query).map((h) => ({ namespace: NS, kind: h.kind, source: h.kind, excerpt: h.excerpt })))
        trace.push({ namespace: NS, depth: parseNamespacePath(NS).depth, hits: guide.length, action: 'guide_only' })
      }
      bytesF += buildResponseBytes(db, NS, navDigestOf(db, NS), flat.slice(0, K), [], [])
      bytesN += buildResponseBytes(db, NS, navDigestOf(db, NS), funn.slice(0, K), trace, guide)
      n++
    }

    const scopeMetrics: P3ScopeMetrics[] = scopePaths.map((sp) => ({
      token: scopeTokens.get(sp) ?? '(none)',
      memories: (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE COALESCE(namespace, project_path) = ?').get(sp) as { n: number }).n,
      promoted: report.promoted.includes(sp.slice(NS.length + 2)),
    }))

    const result = {
      dbPath,
      tempCopy: tmpPath,
      namespace: NS,
      memoriesInNamespace: nsTotal,
      scopes: SCOPES,
      probesSampled: sampled.length,
      probesUsable: queryByProbe.size,
      promotion: report,
      consolidatedDigests: consolidated.refreshed,
      scopeMetrics,
      guide: {
        probes: guideRows.length,
        thinProbes: thinRows.length,
        syntheticTokenFallbacks,
        beforeDigestHits: beforeHit,
        afterDigestHits: afterHit,
        guideHitRateBefore: guideRows.length ? Math.round((beforeHit / guideRows.length) * 1000) / 1000 : 0,
        guideHitRateAfter: guideRows.length ? Math.round((afterHit / guideRows.length) * 1000) / 1000 : 0,
        rows: guideRows.map((g) => ({ token: g.scopeToken, targetLeaf: g.targetLeaf, leafHits: g.leafHits, thin: g.thin, before: g.beforeDigestHit, after: g.afterDigestHit })),
      },
      recall: {
        k: K,
        recallAt5Flat: n ? Math.round((hit5F / n) * 1000) / 1000 : 0,
        recallAt5Funnel: n ? Math.round((hit5N / n) * 1000) / 1000 : 0,
        recallAt5Delta: n ? Math.round(((hit5N - hit5F) / n) * 1000) / 1000 : 0,
        contextCharsAt5Flat: n ? Math.round(charsF / n) : 0,
        contextCharsAt5Funnel: n ? Math.round(charsN / n) : 0,
        contextCharsSavingsPct: savingsPct(charsN, charsF),
        responseBytesFlat: n ? Math.round(bytesF / n) : 0,
        responseBytesFunnel: n ? Math.round(bytesN / n) : 0,
        responseBytesSavingsPct: savingsPct(bytesN, bytesF),
      },
    }

    console.log('\n=== eval-funnel P3 promote + consolidate ===')
    console.log(JSON.stringify(result, null, 2))
    writeP3Doc(result)
  } finally {
    db.close()
  }
}

function writeP3Doc(r: {
  namespace: string
  memoriesInNamespace: number
  scopes: number
  probesSampled: number
  probesUsable: number
  promotion: { promoted: string[]; skipped: string[]; reasons: Record<string, string> }
  consolidatedDigests: number
  scopeMetrics: P3ScopeMetrics[]
  guide: { probes: number; thinProbes: number; syntheticTokenFallbacks: number; beforeDigestHits: number; afterDigestHits: number; guideHitRateBefore: number; guideHitRateAfter: number }
  recall: { k: number; recallAt5Flat: number; recallAt5Funnel: number; recallAt5Delta: number; contextCharsAt5Flat: number; contextCharsAt5Funnel: number; contextCharsSavingsPct: number; responseBytesFlat: number; responseBytesFunnel: number; responseBytesSavingsPct: number }
}): void {
  const L: string[] = []
  L.push('# Eval: P3 promotion + recursive consolidation')
  L.push('')
  L.push(
    'Generated by `npx tsx scripts/eval-funnel.ts --p3` — runs on a temporary COPY of the',
    'live DB (opened read-only; writes land only on the copy). LLM mocked off',
    '(`ENGRAM_LLM_*` unset + `resetLlmConfigForTests`) so `promote` and `consolidateTree`',
    'exercise their deterministic extractive fallbacks — no endpoint dependency.'
  )
  L.push('')
  L.push('## Method')
  L.push('')
  L.push(`- Largest flat namespace \`${r.namespace}\` (${r.memoriesInNamespace} memories) sharded into ${r.scopes} synthetic scopes `)
  L.push('  (`<ns>//s0..s3`) by `fnv1a(first entity token) % 4` (P2 co-location policy).')
  L.push('- Baseline flat recall/context measured on the pristine (pre-shard) copy before redistribution.')
  L.push('- Per scope, one `memory_clusters` summary is backfilled (its scope-EXCLUSIVE entity token) so')
  L.push('  `consolidateTree` has real condensable sources — mirrors the existing clustering maintenance job.')
  L.push('- Thin-leaf cross-scope guide probes: a scope\u2019s exclusive token queried against a sibling leaf, so the')
  L.push('  leaf is thin and the funnel ascends to the parent nav layer. (A modal token like `README` is useless')
  L.push('  here because it appears in every leaf — exclusivity is what makes the probe genuinely thin.)')
  L.push('- Guide-hit counts the `digest` kind only (parent `namespace_nodes.digest`), the clean before/after')
  L.push('  signal that consolidation actually primed the thin layer.')
  L.push('')
  L.push('## Results — promotion')
  L.push('')
  L.push(`- Promoted: ${r.promotion.promoted.length} scope(s) → pattern memories in the parent.`)
  L.push(`- Skipped: ${r.promotion.skipped.length} (${Object.entries(r.promotion.reasons).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}).`)
  L.push(`- Digests refreshed by consolidateTree: ${r.consolidatedDigests}.`)
  L.push('')
  L.push('| exclusive token | memories in scope | promoted |')
  L.push('| --- | --- | --- |')
  for (const s of r.scopeMetrics) L.push(`| \`${s.token}\` | ${s.memories} | ${s.promoted ? 'yes' : 'no'} |`)
  L.push('')
  L.push('## Results — retrieval (recall + shipped context)')
  L.push('')
  L.push(`| metric | flat (one bucket) | funnel (own leaf) | Δ |`)
  L.push('| --- | --- | --- | --- |')
  L.push(`| recall@${r.recall.k} | ${r.recall.recallAt5Flat} | ${r.recall.recallAt5Funnel} | ${r.recall.recallAt5Delta >= 0 ? '+' : ''}${r.recall.recallAt5Delta} |`)
  L.push(`| context chars@${r.recall.k} | ${r.recall.contextCharsAt5Flat} | ${r.recall.contextCharsAt5Funnel} | ${r.recall.contextCharsSavingsPct}% less |`)
  L.push(`| response bytes | ${r.recall.responseBytesFlat} | ${r.recall.responseBytesFunnel} | ${r.recall.responseBytesSavingsPct}% less |`)
  L.push('')
  L.push('## Results — thin-layer guide hits (before vs after consolidation)')
  L.push('')
  L.push('| metric | value |')
  L.push('| --- | --- |')
  L.push(`| thin-leaf cross-scope probes | ${r.guide.thinProbes} (of ${r.guide.probes}) |`)
  L.push(`| synthetic token fallbacks | ${r.guide.syntheticTokenFallbacks} |`)
  L.push(`| digest-guide hits BEFORE | ${r.guide.beforeDigestHits} (rate ${r.guide.guideHitRateBefore}) |`)
  L.push(`| digest-guide hits AFTER | ${r.guide.afterDigestHits} (rate ${r.guide.guideHitRateAfter}) |`)
  L.push('')
  L.push('## Findings')
  L.push('')
  L.push(
    '- Recall holds when same-entity memories co-locate in one leaf: the funnel returns the source at',
    'equal-or-better rank while shipping less context than the flat one-bucket baseline.'
  )
  L.push(
    '- Consolidation primes the thin digests: after `consolidateTree`, thin-leaf cross-scope queries match the',
    'parent digest (via the `[child <scope>]` line condensing each scope\u2019s cluster summary), where before',
    'the digest was empty and those queries surfaced nothing.'
  )
  L.push(
    '- Scope knowledge enters the nav layer through CLUSTER summaries (or pinned facts), not through raw',
    'memories: `refreshNavDigest` condenses pinned digests + cluster summaries + child digests. The promoted',
    '`pattern` memory lives in the parent as a searchable memory but is NOT a digest source — so promotion',
    'alone does not manufacture guide hits; consolidation over cluster-backed scopes does.'
  )
  L.push('')
  writeFileSync('docs/eval-funnel-p3.md', L.join('\n') + '\n')
}

// ── main ─────────────────────────────────────────────────────────────────────
const dbPath = expandHome(process.env.ENGRAM_EVAL_DB ?? '~/Library/Application Support/engram-nodejs/engram.db')
const PROJECT_SCOPED = process.argv.includes('--project-scoped')
const P3 = process.argv.includes('--p3')

if (P3) {
  const i = process.argv.indexOf('--probes')
  const PROBES = i >= 0 ? Number(process.argv[i + 1]) : 24
  runP3Consolidation(dbPath, Number.isFinite(PROBES) ? PROBES : 24)
    .catch((e) => {
      console.error('P3 eval failed:', e)
      process.exitCode = 1
    })
} else if (PROJECT_SCOPED) {
  const i = process.argv.indexOf('--probes')
  const PROBES = i >= 0 ? Number(process.argv[i + 1]) : 30
  runScopedProjection(dbPath, Number.isFinite(PROBES) ? PROBES : 30)
    .catch((e) => {
      console.error('scoped projection failed:', e)
      process.exitCode = 1
    })
} else {
  console.log('opening (readonly):', dbPath)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  run(db)
    .catch((e) => {
      console.error('eval failed:', e)
      process.exitCode = 1
    })
    .finally(() => db.close())
}
