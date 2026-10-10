// funnel suite: does scoping a read to a leaf scope, and ascending to ancestor NAV
// metadata when that leaf is thin, hold recall while serving less content — and does the
// guide channel ever carry a memory body?
//
// the funnel lives in the `get_context` handler (src/mcp/handlers.ts): a leaf is "rich" at
// >= FUNNEL_K_MIN hits with a top score >= FUNNEL_THETA, and only a thin leaf ascends,
// where each reachable ancestor contributes at most two excerpts of at most
// at most GUIDE_EXCERPT_CHARS from its digest and cluster summaries. those are navigation
// metadata by construction, and the whole point of this suite is to pin that with a corpus
// rather than with a handler-level unit test: eval/README.md records that the guide channel
// is not scored by any other suite, so "a digest that echoes parent content into a child's
// context" has no corpus-level gate anywhere else.
//
// the ascent is driven through the shipped `get_context` tool, not a re-implementation, so
// the suite scores the code that ships.
//
// two things are scored: the base comparison (flat vs funnel, on `clean` and `poisoned`,
// where the second is the leak gate's positive control), and a scope-count sweep, because
// the saving is not a constant — it depends on how much of the tree a leaf is.
import { EvalHarness } from '../lib/harness.js'
import {
  buildFunnelCorpus,
  FUNNEL_BASE_SCOPES,
  FUNNEL_SWEEP_SCOPES,
  FUNNEL_BODY_MARKER,
  FUNNEL_QUERY,
  FUNNEL_ROOT,
  FUNNEL_SIBLING,
  FUNNEL_THIN_LEAF,
  funnelLeafPath,
  type FunnelVariant,
} from '../lib/funnel-corpus.js'
import { corpusHash, recallAtK, resolveTokenizer, round3 } from '../lib/metrics.js'
import { markdownTable } from '../lib/report.js'

import type { SuiteContext, SuiteOutput } from './types.js'
import type { TokenizerInfo } from '../lib/metrics.js'

export const FUNNEL_ARMS = ['flat', 'funnel'] as const
export type FunnelArm = (typeof FUNNEL_ARMS)[number]

/** read limit per arm; the flat arm ranks across every sibling scope, the funnel arm inside one */
export const FUNNEL_READ_LIMIT = 8

interface GuideEntryShape {
  namespace: string
  kind: string
  source: string
  excerpt: string
}

interface ScopeTraceShape {
  namespace: string
  depth: number
  hits?: number
  top_score?: number | null
  action: string
}

/**
 * the leak predicate, kept pure and exported so a test can drive it directly: given the
 * guide entries a read returned, name the excerpts that carry the body marker. an excerpt
 * carrying it means the nav layer served memory content instead of navigation metadata.
 */
export function guideLeakViolations(
  guide: readonly GuideEntryShape[],
  marker: string
): Array<{ namespace: string; source: string; excerpt: string }> {
  return guide
    .filter((entry) => entry.excerpt.includes(marker))
    .map((entry) => ({ namespace: entry.namespace, source: entry.source, excerpt: entry.excerpt }))
}

/** a guide entry may only name the queried node's ancestors — never a sibling subtree */
export function guideOutOfTreeViolations(
  guide: readonly GuideEntryShape[],
  root: string
): Array<{ namespace: string }> {
  return guide
    .filter((entry) => !(entry.namespace === root || entry.namespace.startsWith(`${root}//`)))
    .map((entry) => ({ namespace: entry.namespace }))
}

interface ArmAggregate extends Record<string, number> {
  leaks: number
  outOfTree: number
  maxExcerptChars: number
  overExcerptCap: number
}

interface ScaleMeasurement {
  scopeCount: number
  corpusHash: string
  memories: number
  seedViaTool: number
  clusters: number
  arms: Record<FunnelArm, ArmAggregate>
  details: Record<string, unknown[]>
  contentSavingPct: number
  recallDelta: number
  vectorsAvailable: boolean
  vectorMode: string
}

export async function runFunnelSuite(ctx: SuiteContext): Promise<SuiteOutput> {
  const tokenizer = await resolveTokenizer()
  const notes: string[] = []
  const metrics: Record<string, unknown> = {}
  const details: unknown[] = []
  const thresholds: Record<string, Record<string, number>> = {}
  const timings: Record<string, never> = {}
  const featureFlags: Record<string, string> = {}
  const hashes: string[] = []
  const baseRows: Array<Array<string | number>> = []
  let vectorsAvailable = false
  let vectorMode = 'fts'

  // base comparison: both variants, for the leak gate and the headline
  for (const variant of ['clean', 'poisoned'] as FunnelVariant[]) {
    const m = await measureScale(ctx, variant, FUNNEL_BASE_SCOPES)
    vectorsAvailable = m.vectorsAvailable
    vectorMode = m.vectorMode
    hashes.push(`${variant}-${m.scopeCount}:${m.corpusHash}`)
    notes.push(
      `${variant} @ ${m.scopeCount} scopes: ${m.memories} memories ` +
        `(${m.seedViaTool} via store_memory), clusters=${m.clusters}`
    )

    const flat = m.arms.flat
    const funnel = m.arms.funnel
    for (const arm of FUNNEL_ARMS) {
      const a = m.arms[arm]
      baseRows.push([
        variant,
        arm,
        a.queries,
        a.recall,
        a.servedMemories,
        a.foreignMemories,
        a.servedChars,
        a.responseBytes,
        a.guideEntries,
        a.guideChars,
        a.traceGuideOnly,
        a.leaks,
      ])
    }

    metrics[variant] = {
      flat: volatileArmFields(flat),
      funnel: volatileArmFields(funnel),
      contentSavingPct: m.contentSavingPct,
      recallDelta: m.recallDelta,
      // the gate: a body must never reach the guide on `clean`, and must on `poisoned`
      guideLeaks: funnel.leaks,
      guideOutOfTree: funnel.outOfTree,
      excerptCapViolations: funnel.overExcerptCap,
      maxExcerptChars: funnel.maxExcerptChars,
    }
    thresholds[`${variant}/funnel`] = {
      // lower-is-better counters carry no margin: these are faults, not noisy quality
      guideLeaks: funnel.leaks,
      guideOutOfTree: funnel.outOfTree,
      excerptCapViolations: funnel.overExcerptCap,
      // the quality pair: recall must not fall, content should fall
      recall: funnel.recall,
      servedChars: funnel.servedChars,
      foreignMemories: funnel.foreignMemories,
    }
    notes.push(
      `${variant}: flat recall ${flat.recall} serving ${flat.servedChars} chars ` +
        `(${flat.foreignMemories} of ${flat.servedMemories} rows from a sibling scope); ` +
        `funnel recall ${funnel.recall} serving ${funnel.servedChars} chars ` +
        `(${funnel.foreignMemories} foreign) — ${m.contentSavingPct}% content delta, ` +
        `recall delta ${m.recallDelta >= 0 ? '+' : ''}${m.recallDelta}; ` +
        `guide entries ${funnel.guideEntries}, body-marker leaks ${funnel.leaks}, ` +
        `out-of-tree guide entries ${funnel.outOfTree}`
    )
    details.push({ variant, scopeCount: m.scopeCount, arms: m.details })
  }

  // the scaling curve: the same probed leaf at growing tree sizes. `clean` only, because
  // the leak gate is already carried by the base pair and the sweep is about dilution.
  const sweepRows: Array<Array<string | number>> = []
  const sweepMetrics: Array<Record<string, number>> = []
  for (const scopeCount of FUNNEL_SWEEP_SCOPES) {
    const m = await measureScale(ctx, 'clean', scopeCount)
    hashes.push(`sweep-${scopeCount}:${m.corpusHash}`)
    const flat = m.arms.flat
    const funnel = m.arms.funnel
    sweepRows.push([
      scopeCount,
      m.memories,
      flat.recall,
      funnel.recall,
      flat.servedMemories,
      flat.foreignMemories,
      flat.servedChars,
      funnel.servedChars,
      funnel.leaks,
    ])
    sweepMetrics.push({
      scopes: scopeCount,
      memories: m.memories,
      flatRecall: flat.recall,
      funnelRecall: funnel.recall,
      flatForeignMemories: flat.foreignMemories,
      flatServedChars: flat.servedChars,
      funnelServedChars: funnel.servedChars,
      contentSavingPct: m.contentSavingPct,
      guideLeaks: funnel.leaks,
    })
  }
  metrics.sweep = sweepMetrics
  const firstSweep = sweepMetrics[0]
  const lastSweep = sweepMetrics[sweepMetrics.length - 1]
  notes.push(
    `scaling: ${firstSweep.scopes} -> ${lastSweep.scopes} scopes, flat recall ` +
      `${firstSweep.flatRecall} -> ${lastSweep.flatRecall}, funnel recall ` +
      `${firstSweep.funnelRecall} -> ${lastSweep.funnelRecall}, flat foreign rows ` +
      `${firstSweep.flatForeignMemories} -> ${lastSweep.flatForeignMemories}; ` +
      `body-marker leaks ${sweepMetrics.map((s) => s.guideLeaks).join('/')} across the sweep`
  )

  const markdown = renderFunnelMarkdown(baseRows, sweepRows)

  return {
    result: {
      suite: 'funnel',
      header: ctx.buildHeader({
        suite: 'funnel',
        configs: ['baseline'],
        seed: ctx.seed,
        corpusHash: { short: hashes.join('+'), full: hashes.join('+') },
        vectorsAvailable,
        vectorMode: vectorMode as never,
        now: 0,
        tokenizer: tokenizer as TokenizerInfo,
        featureFlags,
      }),
      metrics,
      timings,
      details,
      notes: [...notes, harnessNote(), funnelColumnNote()],
    },
    markdown,
    thresholds,
  }
}

// the reply's byte size is NOT part of `metrics`.
//
// `get_context` enriches each served memory with `tier: computeTier(memory, now)`, and the
// roster is filtered against a 30-day boundary. both read a clock that is now injectable
// and pinned by this harness, so those sources are reproducible. the byte count still
// moves by about a byte between runs from a source not yet identified, so it stays an
// informational column until that is found. a latency figure would belong outside
// `metrics` for a different reason: pinning it would report a fake duration.
function volatileArmFields(arm: ArmAggregate): ArmAggregate {
  const { responseBytes: _volatile, ...stable } = arm
  return stable as ArmAggregate
}

/** one (variant, scope count) measurement: its own isolated harness, both arms over the same corpus */
async function measureScale(
  ctx: SuiteContext,
  variant: FunnelVariant,
  scopeCount: number
): Promise<ScaleMeasurement> {
  const corpus = buildFunnelCorpus(ctx.seed, variant, scopeCount)
  const hash = corpusHash(corpus)
  const harness = await EvalHarness.create({ seed: ctx.seed, vectors: ctx.vectors })
  try {
    const seedStats = await harness.seedCorpus(corpus)
    const namespaceOf = new Map(corpus.memories.map((m) => [m.id, m.namespace]))
    const arms = {} as Record<FunnelArm, ArmAggregate>
    const details: Record<string, unknown[]> = { flat: [], funnel: [] }

    for (const arm of FUNNEL_ARMS) {
      const rows: Array<Record<string, number>> = []
      let leaked = 0
      let outOfTree = 0
      let maxExcerpt = 0
      let overCap = 0

      for (const query of corpus.queries) {
        const leaf = leafOf(query.namespace)
        const args =
          arm === 'flat'
            ? {
                // the one-bucket read: the whole subtree, no ascent
                project_path: FUNNEL_ROOT,
                query: query.query,
                limit: FUNNEL_READ_LIMIT,
                strict_scope: false,
                scope: 'leaf',
              }
            : {
                // the scoped read: this leaf only, ascending for nav metadata when thin
                project_path: funnelLeafPath(leaf),
                query: query.query,
                limit: FUNNEL_READ_LIMIT,
                strict_scope: true,
                scope: 'funnel',
              }

        const result = await harness.toolCall('get_context', args)
        const guide = (result.guide as GuideEntryShape[] | undefined) ?? []
        const trace = (result.scope_trace as ScopeTraceShape[] | undefined) ?? []
        const memories = (result.memories as Array<{ id: string; content?: string }>) ?? []
        const digest = typeof result.digest === 'string' ? result.digest : ''
        const topics = Array.isArray(result.topics) ? result.topics : []

        const leaks = guideLeakViolations(guide, FUNNEL_BODY_MARKER)
        const stray = guideOutOfTreeViolations(guide, FUNNEL_ROOT)
        leaked += leaks.length
        outOfTree += stray.length
        for (const entry of guide) {
          maxExcerpt = Math.max(maxExcerpt, entry.excerpt.length)
          if (entry.excerpt.length > 240) overCap++
        }

        const servedIds = memories.map((m) => harness.localIdOf(m.id))
        // the dilution the funnel removes: served rows that belong to a SIBLING scope
        const ownLeaf = funnelLeafPath(leaf)
        const foreign = servedIds.filter((id) => {
          const ns = namespaceOf.get(id)
          return ns !== undefined && ns !== ownLeaf
        }).length
        const recall = recallAtK(
          servedIds.map((id) => ({ id })),
          query.target_ids,
          servedIds.length
        )
        const servedChars =
          digest.length +
          memories.reduce((sum, m) => sum + (m.content ?? '').length, 0) +
          topics.reduce(
            (sum: number, t) =>
              sum +
              (typeof (t as { summary?: string }).summary === 'string'
                ? ((t as { summary?: string }).summary as string).length
                : 0),
            0
          )
        const guideChars = guide.reduce((sum, entry) => sum + entry.excerpt.length, 0)

        const row = {
          recall: round3(recall),
          servedMemories: memories.length,
          foreignMemories: foreign,
          servedChars,
          responseBytes: JSON.stringify(result).length,
          guideEntries: guide.length,
          guideChars,
          traceEntries: trace.length,
          traceSearched: trace.filter((t) => t.action === 'searched').length,
          traceSkipped: trace.filter((t) => t.action === 'skipped').length,
          traceGuideOnly: trace.filter((t) => t.action === 'guide_only').length,
          leaks: leaks.length,
        }
        rows.push(row)
        details[arm].push({ query_id: query.id, kind: query.kind, leaf, ...row })
      }

      const agg = aggregate(rows) as ArmAggregate
      agg.leaks = leaked
      agg.outOfTree = outOfTree
      agg.maxExcerptChars = maxExcerpt
      agg.overExcerptCap = overCap
      arms[arm] = agg
    }

    const flat = arms.flat
    const funnel = arms.funnel
    return {
      scopeCount,
      corpusHash: hash.short,
      memories: corpus.memories.length,
      seedViaTool: seedStats.viaTool,
      clusters: harness.stats().clusters,
      arms,
      details,
      contentSavingPct: round3(
        flat.servedChars === 0
          ? 0
          : ((flat.servedChars - funnel.servedChars) / flat.servedChars) * 100
      ),
      recallDelta: round3(funnel.recall - flat.recall),
      vectorsAvailable: harness.vectorsAvailable,
      vectorMode: harness.vectorMode,
    }
  } finally {
    harness.dispose()
  }
}

function leafOf(namespace: string): string {
  const parts = namespace.split('//')
  return parts.length > 1 ? parts[parts.length - 1] : ''
}

function aggregate(rows: Array<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = { queries: rows.length }
  if (rows.length === 0) return out
  for (const key of Object.keys(rows[0])) {
    const values = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number')
    if (values.length === 0) continue
    out[key] = round3(values.reduce((a, b) => a + b, 0) / values.length)
  }
  out.queries = rows.length
  return out
}

function harnessNote(): string {
  return (
    'driven through the shipped `get_context` tool; ' +
    `${FUNNEL_BASE_SCOPES} sibling scopes, ${FUNNEL_THIN_LEAF} is the thin leaf, ` +
    `sibling root ${FUNNEL_SIBLING} carries the same marker`
  )
}

export function funnelColumnNote(): string {
  return (
    'Columns: flat = `get_context` on the root with `strict_scope=false` and `scope=leaf` (the ' +
    'one-bucket pre-hierarchy read); funnel = `get_context` on the leaf with `strict_scope=true` ' +
    'and `scope=funnel` (the scoped read plus ancestor ascent). recall is the share of the ' +
    "queried leaf's own memory ids present in the served list. foreignMem counts served rows that " +
    'belong to a SIBLING scope — the dilution scoping removes. servedChars counts digest + memory ' +
    'contents + topic summaries as served. guideChars counts the navigation excerpts the ascent ' +
    'added; leaks counts guide excerpts carrying the body marker, which must be 0 on `clean` and ' +
    'non-zero on `poisoned` — that pair is what makes the gate a control.'
  )
}

export function renderFunnelMarkdown(
  baseRows: Array<Array<string | number>>,
  sweepRows: Array<Array<string | number>> = []
): string {
  const query = FUNNEL_QUERY
  return [
    `Scoped (funnel) reads against the one-bucket (flat) read over the same corpus, driven ` +
      `through the shipped \`get_context\` tool. Every query asks the same question (\`${query}\`) ` +
      `in a different scope, so the two arms differ only in where it is asked. The headline is ` +
      `recall held while served content falls; the gate is that the guide channel never carries a ` +
      `memory body.`,
    markdownTable({
      columns: [
        'variant',
        'arm',
        'queries',
        'recall',
        'servedMem',
        'foreignMem',
        'servedChars',
        'responseBytes',
        'guide',
        'guideChars',
        'traceGuideOnly',
        'leaks',
      ],
      rows: baseRows,
    }),
    'The `poisoned` variant replaces the root cluster summary with a parent memory body ' +
      'verbatim. It is the failure mode, not a bug in the corpus: the suite must report `leaks > 0` ' +
      'there, which is the proof that the `clean` zero is a real reading rather than a gate that ' +
      'can never fire.',
    sweepRows.length > 0
      ? 'Scaling curve: the same probed leaf, in the same tree, at growing scope counts. `flat` ' +
        'reads the whole subtree and must fit its top-k around every sibling scope, so its recall ' +
        'should fall as the tree grows; `funnel` reads only its own leaf, so its recall should ' +
        'hold. That separation is the funnel claim, and the curve is the test of it.'
      : '',
    sweepRows.length > 0
      ? markdownTable({
          columns: [
            'scopes',
            'memories',
            'flatRecall',
            'funnelRecall',
            'flatServedMem',
            'flatForeignMem',
            'flatChars',
            'funnelChars',
            'leaks',
          ],
          rows: sweepRows,
        })
      : '',
    'What this suite does not measure: real-world scope granularity. The sweep varies the number ' +
      'of sibling scopes, not how a real project distributes its memories across them, and the ' +
      'sharding here is uniform by construction. A curve says the dilution mechanism exists and ' +
      'grows with tree size; it does not predict a saving on any particular repository. The ' +
      'absolute figures are a lower bound, because vectors are off and recall is lexical only.',
  ].join('\n\n')
}
