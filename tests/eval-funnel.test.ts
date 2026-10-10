// the funnel suite's contract, in three parts:
//
//  1. the LEAK GATE on a real run — the guide channel must never carry a memory body, and
//     the `poisoned` corpus proves the gate can fire at all. A gate that only ever sees a
//     clean corpus is an assertion that always holds, so the positive control is the point.
//  2. the predicate itself, driven directly, so its sensitivity does not depend on the
//     suite happening to produce a leaking read.
//  3. the operating point: scoping raises recall and removes foreign rows, the ascent is
//     metadata-only and capped, and two runs with the same header are byte-identical.
import { describe, expect, it } from 'vitest'
import { EvalHarness } from '../eval/lib/harness.js'
import {
  buildFunnelCorpus,
  FUNNEL_BASE_SCOPES,
  FUNNEL_BODY_MARKER,
  FUNNEL_QUERY,
  FUNNEL_ROOT,
  FUNNEL_SIBLING,
  FUNNEL_THIN_LEAF,
  funnelLeafPath,
} from '../eval/lib/funnel-corpus.js'
import { buildHeader } from '../eval/lib/report.js'
import { guideLeakViolations, guideOutOfTreeViolations, runFunnelSuite } from '../eval/suites/funnel.js'
import type { SuiteContext } from '../eval/suites/types.js'

function suiteContext(): SuiteContext {
  return {
    seed: 1234,
    vectors: 'fts',
    configs: [['baseline', {}]],
    outDir: '/tmp',
    gitSha: 'inert-fixture',
    log: () => {},
    buildHeader: (input) => buildHeader({ ...input, git: undefined }),
  }
}

interface GuideEntry {
  namespace: string
  kind: string
  source: string
  excerpt: string
}

interface ArmAggregate {
  queries: number
  recall: number
  servedMemories: number
  foreignMemories: number
  servedChars: number
  guideEntries: number
  guideChars: number
  traceGuideOnly: number
  leaks: number
  outOfTree: number
  maxExcerptChars: number
  overExcerptCap: number
}

/** the metrics with the payload byte counts blanked, for a clock-independent compare */
function withoutPayloadBytes(metrics: unknown): string {
  return JSON.stringify(metrics, (key, value) => (key === 'responseBytes' ? 0 : value))
}

describe('funnel guide isolation', () => {
  it('never carries a memory body in the guide, and fires when a body is planted there', async () => {
    const output = await runFunnelSuite(suiteContext())
    const clean = output.result.metrics.clean as { funnel: ArmAggregate; guideLeaks: number }
    const poisoned = output.result.metrics.poisoned as { funnel: ArmAggregate; guideLeaks: number }

    // the gate: on a corpus whose nav layer holds only navigation metadata
    expect(clean.funnel.leaks).toBe(0)
    expect(clean.guideLeaks).toBe(0)
    expect(clean.funnel.outOfTree).toBe(0)

    // the positive control: the same corpus with the root cluster summary replaced by a
    // parent memory body verbatim. the gate MUST report it, or it is not a gate.
    expect(poisoned.guideLeaks).toBeGreaterThan(0)
    expect(poisoned.funnel.outOfTree).toBe(0)
  })

  it('keeps the guide to bounded metadata from ancestors only', async () => {
    const output = await runFunnelSuite(suiteContext())
    const details = output.result.details as Array<{
      variant: string
      scopeCount: number
      arms: Record<string, Array<Record<string, unknown>>>
    }>
    const clean = details.find((entry) => entry.variant === 'clean')!
    for (const row of clean.arms.funnel) {
      const guideChars = Number(row.guideChars)
      const guideEntries = Number(row.guideEntries)
      // a guide excerpt is capped at GUIDE_EXCERPT_CHARS, so N entries cannot exceed N caps
      if (guideEntries > 0) {
        expect(guideChars / guideEntries).toBeLessThanOrEqual(240)
      }
      // an excerpt can only appear where an ancestor was actually consulted
      if (guideEntries > 0) {
        expect(Number(row.traceGuideOnly)).toBeGreaterThan(0)
      }
    }
  })

  it('ascends for the thin leaf, whose hits cannot reach FUNNEL_K_MIN', async () => {
    const output = await runFunnelSuite(suiteContext())
    const details = output.result.details as Array<{
      variant: string
      arms: Record<string, Array<Record<string, unknown>>>
    }>
    const clean = details.find((entry) => entry.variant === 'clean')!
    const thin = clean.arms.funnel.find((row) => row.leaf === FUNNEL_THIN_LEAF)
    expect(thin).toBeDefined()
    expect(Number(thin!.traceGuideOnly)).toBeGreaterThan(0)
  })

  it('scopes the read: recall up, no foreign rows, less served content', async () => {
    const output = await runFunnelSuite(suiteContext())
    const clean = output.result.metrics.clean as {
      flat: ArmAggregate
      funnel: ArmAggregate
      contentSavingPct: number
      recallDelta: number
    }
    // the flat one-bucket read spends its limit across sibling scopes
    expect(clean.flat.foreignMemories).toBeGreaterThan(0)
    // the scoped read never leaves the queried leaf
    expect(clean.funnel.foreignMemories).toBe(0)
    expect(clean.funnel.recall).toBeGreaterThan(clean.flat.recall)
    expect(clean.funnel.servedChars).toBeLessThanOrEqual(clean.flat.servedChars)
  })

  it('is deterministic: two runs with the same header produce identical metrics', async () => {
    const first = await runFunnelSuite(suiteContext())
    const second = await runFunnelSuite(suiteContext())
    // responseBytes counts the shipped payload, and that payload carries a `tier` that
    // enrichment derives from its own wall clock rather than the injected scoring clock.
    // the tier is stable, but its distance to a tier boundary moves with the clock
    // reading, so a few bytes of the count can differ while every behavioural metric
    // holds. compare the set the run actually controls.
    expect(withoutPayloadBytes(second.result.metrics)).toBe(withoutPayloadBytes(first.result.metrics))
    expect(second.result.header.corpusHash.short).toBe(first.result.header.corpusHash.short)
  })

  it('gates nothing on thresholds it did not measure, and reports what it would gate', async () => {
    const output = await runFunnelSuite(suiteContext())
    // the suite returns its thresholds but never writes the committed file; the leak
    // counters it would gate carry no margin because they are faults, not quality scores
    expect(Object.keys(output.thresholds).sort()).toEqual(['clean/funnel', 'poisoned/funnel'])
    expect(output.thresholds['clean/funnel'].guideLeaks).toBe(0)
    expect(output.thresholds['poisoned/funnel'].guideLeaks).toBeGreaterThan(0)
  })
})

describe('funnel leak predicate', () => {
  it('names the leaking excerpt when the guide carries a body', () => {
    const leaking: GuideEntry[] = [
      {
        namespace: FUNNEL_ROOT,
        kind: 'cluster',
        source: 'cluster',
        excerpt: `the ${FUNNEL_BODY_MARKER} is recorded only in this parent memory body`,
      },
    ]
    const violations = guideLeakViolations(leaking, FUNNEL_BODY_MARKER)
    expect(violations).toHaveLength(1)
    expect(violations[0].namespace).toBe(FUNNEL_ROOT)
  })

  it('is silent on navigation metadata that merely names the scopes', () => {
    const clean: GuideEntry[] = [
      {
        namespace: FUNNEL_ROOT,
        kind: 'digest',
        source: 'digest',
        excerpt: 'Scope index for the deploy pipeline tree: alpha, beta, gamma.',
      },
    ]
    expect(guideLeakViolations(clean, FUNNEL_BODY_MARKER)).toEqual([])
  })

  it('flags a guide entry from outside the queried tree', () => {
    const stray: GuideEntry[] = [
      { namespace: FUNNEL_SIBLING, kind: 'cluster', source: 'cluster', excerpt: 'sibling scope' },
    ]
    expect(guideOutOfTreeViolations(stray, FUNNEL_ROOT)).toHaveLength(1)
    expect(
      guideOutOfTreeViolations(
        [{ namespace: funnelLeafPath('alpha'), kind: 'digest', source: 'digest', excerpt: 'x' }],
        FUNNEL_ROOT
      )
    ).toEqual([])
  })
})

describe('funnel corpus trap', () => {
  it('plants a parent body that the shared query genuinely matches', async () => {
    // if the trap were unmatchable, a clean guide result would prove nothing: the gate
    // must be able to fire because the body it watches for is really retrievable.
    const corpus = buildFunnelCorpus(1234, 'clean', FUNNEL_BASE_SCOPES)
    const harness = await EvalHarness.create({ seed: 1234, vectors: 'fts' })
    try {
      await harness.seedCorpus(corpus)
      const found = await harness.toolCall('get_context', {
        project_path: FUNNEL_ROOT,
        query: FUNNEL_QUERY,
        limit: 50,
        strict_scope: false,
        scope: 'leaf',
      })
      const served = (found.memories as Array<{ id: string; content?: string }>) ?? []
      const bodies = served.map((m) => m.content ?? '')
      expect(bodies.some((body) => body.includes(FUNNEL_BODY_MARKER))).toBe(true)
    } finally {
      harness.dispose()
    }
  })
})
