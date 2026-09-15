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
import { hybridSearch } from '../src/memory/search/hybrid.js'
import type { SearchResult } from '../src/memory/types.js'
import { parseNamespacePath, ancestorPaths } from '../src/namespace/tree.js'

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

// ── main ─────────────────────────────────────────────────────────────────────
const dbPath = expandHome(process.env.ENGRAM_EVAL_DB ?? '~/Library/Application Support/engram-nodejs/engram.db')
console.log('opening (readonly):', dbPath)
const db = new Database(dbPath, { readonly: true, fileMustExist: true })

run(db)
  .catch((e) => {
    console.error('eval failed:', e)
    process.exitCode = 1
  })
  .finally(() => db.close())
