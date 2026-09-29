// state suite: does the memory layer answer with the value that is true now?
//
// the same changing facts are ingested three ways (see lib/state-corpus.ts): keyed (an
// explicit state_key on the write), chained (the supersession an adjudicator writes,
// named afterwards by the chain backfill) and unlinked (nothing recorded about the
// change). two families of measurement per arm:
//
//   retrieval  recall@k / mrr / staleRate over current, as-of and trajectory questions.
//              staleRate is the number this suite exists for: a served value that has
//              been replaced. recalls alone cannot see it, because every version is a
//              near-duplicate of the last.
//   state      what get_state answers: the current value, the one it replaced, the value
//              current at an as-of instant. read straight from the slot layer, not
//              through ranking, so a ranking change cannot move it.
import { EvalHarness } from '../lib/harness.js'
import { corpusHash, mean, resolveTokenizer, round3, summarizeLatencies } from '../lib/metrics.js'
import { configSearchOptions, applyFeatureFlags } from '../lib/registry.js'
import { markdownTable } from '../lib/report.js'
import { MEASUREMENT_DEFAULTS, scoreQueries, type MetricBlock, type QueryDetail } from '../lib/score.js'
import { topLineFromBlock } from '../lib/thresholds.js'
import { getState } from '../../src/memory/state.js'
import { backfillChainKeys } from '../../src/memory/state.js'
import {
  buildStateArms,
  stateValueContent,
  valueIndexAt,
  STATE_NOW,
  type StateArm,
} from '../lib/state-corpus.js'
import type { SuiteContext, SuiteOutput } from './types.js'
import type { TimingSummary } from '../lib/types.js'

export interface StateReadMetrics {
  /** the slot layer reports the newest value for this share of facts */
  currentAccuracy: number
  /** it also reports the value the current one replaced */
  priorAccuracy: number
  /** the value true at the as-of instant is the one it reports */
  asOfAccuracy: number
  /** share of as-of reads that served a value that did not exist yet at that instant */
  asOfLeakRate: number
  /** share of facts with any slot at all */
  slotCoverage: number
  /** mean values per slot, present-state reads */
  meanVersions: number
  facts: number
}

export interface StateArmMetrics {
  retrieval: MetricBlock
  byKind: Record<string, MetricBlock>
  state: StateReadMetrics
  /** share of current probes whose newest evidence session was ranked first */
  latestAt1: number
  /** families whose slot asked for and read: probes, not a rate */
  probes: number
}

export async function runStateSuite(ctx: SuiteContext): Promise<SuiteOutput> {
  const arms = buildStateArms()
  const tokenizer = await resolveTokenizer()
  const hash = corpusHash(arms.map((arm) => arm.corpus))
  const configNames = ctx.configs.map(([name]) => name)
  const limit = ctx.limit ?? MEASUREMENT_DEFAULTS.limit ?? 10
  const ks = [1, 5, 10].filter((k) => k <= limit)
  const notes: string[] = []
  const metrics: Record<string, unknown> = {}
  const timings: Record<string, TimingSummary> = {}
  const details: unknown[] = []
  const thresholds: Record<string, Record<string, number>> = {}
  const featureFlags: Record<string, string> = {}

  const harness = await EvalHarness.create({ seed: ctx.seed, vectors: ctx.vectors, now: STATE_NOW })
  try {
    for (const arm of arms) {
      // the real write path on purpose: the keyed arm's supersession is written by
      // store_memory, not by the seeding helper
      const seeded = await harness.seedCorpus(arm.corpus, { mode: 'tool' })
      if (arm.name === 'chained') {
        const named = backfillChainKeys(harness.db)
        notes.push(
          `${arm.name}: ${named.chains} existing chains named by the backfill (${named.rows} rows)`
        )
      }
      notes.push(
        `${arm.name}: ${arm.corpus.memories.length} memories (${seeded.viaTool} via store_memory), ` +
          `${arm.corpus.queries.length} probes, placement verified=${seeded.placementVerified}`
      )
      if (!seeded.placementVerified) {
        notes.push(
          `PLACEMENT MISMATCHES: ${seeded.placementMismatches.slice(0, 5).join(' | ')}`
        )
      }
    }

    for (const [configName, patch] of ctx.configs) {
      const { options: configOptions, warnings } = configSearchOptions(patch, {
        ...MEASUREMENT_DEFAULTS,
        limit,
      })
      for (const warning of warnings) notes.push(warning)
      const flags = applyFeatureFlags(patch.features)
      featureFlags[configName] = JSON.stringify(patch.features ?? {})
      const armMetrics: Record<string, StateArmMetrics> = {}
      const latencies: number[] = []

      try {
        for (const arm of arms) {
          const scored = await scoreQueries({
            harness,
            corpus: arm.corpus,
            configOptions,
            ks,
            limit,
            tokenizer,
          })
          const state = readSlots(harness, arm)
          latencies.push(...scored.latencies)
          armMetrics[arm.name] = {
            retrieval: scored.metrics,
            byKind: scored.byKind,
            state,
            latestAt1: round3(
              mean(
                scored.details
                  .filter((detail: QueryDetail) => detail.kind === 'current')
                  .map((detail: QueryDetail) => (detail.latestTargetRank === 1 ? 1 : 0))
              )
            ),
            probes: state.facts,
          }
          metrics[`${configName}/${arm.name}`] = armMetrics[arm.name]
          details.push({
            config: configName,
            arm: arm.name,
            queries: scored.details.map((d: QueryDetail) => ({
              id: d.id,
              kind: d.kind,
              recall: d.recall,
              mrr: d.mrr,
              staleRate: d.staleRate,
              latestTargetRank: d.latestTargetRank,
            })),
            state,
          })
          thresholds[`${configName}/${arm.name}`] = {
            ...topLineFromBlock(scored.metrics, ks),
            latestAt1: armMetrics[arm.name].latestAt1,
            currentAccuracy: state.currentAccuracy,
            priorAccuracy: state.priorAccuracy,
            asOfAccuracy: state.asOfAccuracy,
            asOfLeakRate: state.asOfLeakRate,
            slotCoverage: state.slotCoverage,
          }
        }
      } finally {
        flags.restore()
      }

      timings[`${configName}/all-queries`] = summarizeLatencies(latencies)
    }

    const markdown = renderStateMarkdown({ arms, metrics, configNames })

    return {
      result: {
        suite: 'state',
        header: ctx.buildHeader({
          suite: 'state',
          configs: configNames,
          seed: ctx.seed,
          corpusHash: hash,
          vectorsAvailable: harness.vectorsAvailable,
          vectorMode: harness.vectorMode,
          now: harness.now,
          tokenizer,
          featureFlags,
        }),
        metrics,
        timings,
        details,
        notes,
      },
      markdown,
      thresholds,
    }
  } finally {
    harness.dispose()
  }
}

/**
 * what get_state answers for the namespace, against the corpus ground truth. slots are
 * matched by the content they carry, so the same probe covers an explicit key and a
 * chain-derived key without the runner having to know which is which.
 */
export function readSlots(harness: EvalHarness, arm: StateArm): StateReadMetrics {
  const present = getState(harness.db, { namespace: arm.namespace, limit: 100, now: STATE_NOW })
  const asOf = getState(harness.db, {
    namespace: arm.namespace,
    limit: 100,
    as_of: arm.asOf,
    now: STATE_NOW,
  })

  // a slot is matched by a value it carries, so an explicit key and a chain-named key
  // are probed the same way
  const slotOfValue = new Map<string, (typeof present.slots)[number]>()
  for (const slot of present.slots) {
    for (const entry of [slot.current, slot.prior]) {
      if (entry) slotOfValue.set(entry.content, slot)
    }
  }
  const asOfValues = new Set(
    asOf.slots
      .map((slot) => slot.current?.content)
      .filter((content): content is string => typeof content === 'string')
  )

  let currentHits = 0
  let priorHits = 0
  let asOfHits = 0
  let asOfLeaks = 0
  let asOfLeakProbes = 0
  let covered = 0
  let versions = 0

  arm.facts.forEach((fact, factIndex) => {
    const newest = stateValueContent(fact, fact.values[fact.values.length - 1])
    const previous = stateValueContent(fact, fact.values[fact.values.length - 2])
    const slot = slotOfValue.get(newest)
    if (slot) {
      covered++
      versions += slot.versions
      if (slot.current?.content === newest) currentHits++
      if (slot.prior?.content === previous) priorHits++
    }

    const asOfIndex = valueIndexAt(factIndex, arm.asOf)
    // a fact that had not started yet must report no current value at all
    if (asOfIndex < 0) {
      const anyValue = fact.values.some((value) => asOfValues.has(stateValueContent(fact, value)))
      if (!anyValue) asOfHits++
      return
    }
    const asOfWanted = stateValueContent(fact, fact.values[asOfIndex])
    if (asOfValues.has(asOfWanted)) asOfHits++
    if (asOfIndex < fact.values.length - 1) {
      // the update had not happened yet at the as-of instant
      asOfLeakProbes++
      if (asOfValues.has(newest)) asOfLeaks++
    }
  })

  const n = Math.max(1, arm.facts.length)
  return {
    currentAccuracy: round3(currentHits / n),
    priorAccuracy: round3(priorHits / n),
    asOfAccuracy: round3(asOfHits / n),
    asOfLeakRate: round3(asOfLeaks / Math.max(1, asOfLeakProbes)),
    slotCoverage: round3(covered / n),
    meanVersions: round3(versions / n),
    facts: arm.facts.length,
  }
}

export function renderStateMarkdown(input: {
  arms: StateArm[]
  metrics: Record<string, unknown>
  configNames: string[]
}): string {
  const sections: string[] = []
  sections.push(
    'Three arms over the same changing facts: `keyed` writes an explicit state_key, `chained` ' +
      'records the supersession an adjudicator writes and names the chains afterwards, ' +
      '`unlinked` records nothing about the change. `staleRate` is the share of served rows that ' +
      'have been replaced — the failure this suite exists for — and `latestAt1` asks whether the ' +
      'newest evidence session is ranked first. Every version of a fact is a near-duplicate of ' +
      'the previous one, so recall cannot separate them and only state tracking can.'
  )

  const rows: Array<Array<string | number>> = []
  for (const config of input.configNames) {
    for (const arm of input.arms) {
      const entry = input.metrics[`${config}/${arm.name}`] as StateArmMetrics | undefined
      if (!entry) continue
      rows.push([
        `${config} / ${arm.name}`,
        entry.retrieval.queries,
        entry.retrieval['recall@1'] ?? 0,
        entry.retrieval['recall@5'] ?? 0,
        entry.retrieval.mrr,
        entry.retrieval.staleRate,
        entry.latestAt1,
        entry.state.currentAccuracy,
        entry.state.priorAccuracy,
        entry.state.asOfAccuracy,
        entry.state.asOfLeakRate,
        entry.state.slotCoverage,
      ])
    }
  }
  sections.push(
    `### retrieval and state reads\n\n${markdownTable({
      columns: [
        'config / arm',
        'probes',
        'recall@1',
        'recall@5',
        'mrr',
        'staleRate',
        'latestAt1',
        'currentAcc',
        'priorAcc',
        'asOfAcc',
        'asOfLeak',
        'slotCoverage',
      ],
      rows,
    })}`
  )

  const kindRows: Array<Array<string | number>> = []
  for (const config of input.configNames) {
    for (const arm of input.arms) {
      const entry = input.metrics[`${config}/${arm.name}`] as StateArmMetrics | undefined
      if (!entry) continue
      for (const [kind, block] of Object.entries(entry.byKind).sort()) {
        kindRows.push([
          `${config} / ${arm.name} / ${kind}`,
          block.queries,
          block['recall@1'] ?? 0,
          block['recall@5'] ?? 0,
          block.staleRate,
        ])
      }
    }
  }
  if (kindRows.length > 0) {
    sections.push(
      `### by probe kind\n\n\`current\` asks for the value now, \`as-of\` for the one that was true at an instant inside the corpus, \`trajectory\` for every value with include_superseded.\n\n${markdownTable(
        {
          columns: ['config / arm / kind', 'probes', 'recall@1', 'recall@5', 'staleRate'],
          rows: kindRows,
        }
      )}`
    )
  }
  return sections.join('\n\n')
}
