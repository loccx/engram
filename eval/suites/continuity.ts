// continuity suite: does the memory layer carry one agent's work across a sequence of
// sessions, in order, under a budget?
//
// the other suites each ask one question of one corpus: is the right row ranked, does a
// slot track a change, does a packer stay inside a budget. none of them asks whether a
// lifecycle holds together — a task started in session 1 and resumed after a restart, a
// value corrected in session 4 and still readable as history, evidence that exists only
// as episodes and is cited from the memory distilled out of it, a distractor namespace
// holding a twin of the same fact, an archived row that has to come back, an episode
// that has to expire.
//
// the fixture is streamed chronologically (eval/lib/continuity-corpus.ts) and probed at
// checkpoints, so a served row written after the checkpoint is a leak the scorer can see.
// the controller is fixed and scripted (eval/lib/continuity-runner.ts): these are
// contract results — whether the shipped surfaces served the evidence a task needs — not
// task success by an llm agent, which needs a reader and a judge and is not run offline.
// the arm block records that separation explicitly.
//
// three arms answer the same probes under the same character budgets: `full` reads the
// state, memories, episode and task surfaces; `single-layer` is the degraded ablation
// that reads the memories layer alone; `memory-off` runs the same controller over an
// empty isolated store as a negative control. nothing is tuned: whichever arm wins on a
// family is what the table says.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvalHarness } from '../lib/harness.js'
import { corpusHash, resolveTokenizer, summarizeLatencies } from '../lib/metrics.js'
import { applyFeatureFlags, type RetrievalConfigPatch } from '../lib/registry.js'
import { markdownTable, renderTimings } from '../lib/report.js'
import {
  buildContinuityFixture,
  type ContinuityArm,
  type ContinuityFixture,
  type ContinuityGold,
} from '../lib/continuity-corpus.js'
import {
  ContinuityRunner,
  createContinuityLedger,
  type ContinuityLedger,
  type ContinuityRunnerOptions,
} from '../lib/continuity-runner.js'
import {
  ARM_READS,
  continuityFlatMetrics,
  renderContinuityArmsTable,
  renderContinuityFamilyTable,
  scoreContinuityCase,
  summarizeContinuityArm,
  type ContinuityArmMetrics,
  type ContinuityCaseResult,
} from '../lib/continuity-score.js'
import type { RecallOptions } from '../../src/memory/recall.js'
import type { SuiteContext, SuiteOutput } from './types.js'
import type { TimingSummary, VectorMode } from '../lib/types.js'

export const CONTINUITY_AGENT_STATUS = 'not_run'
export const CONTINUITY_AGENT_REASON =
  'offline suite: no gateway, no pinned reader or judge model, so no llm-agent run is claimed'

/** shipped recall knobs a config may set; anything else is not a recall option */
const RECALL_PATCH_KEYS = [
  'ident_channel',
  'entity_channel',
  'expand',
  'use_reranker',
  'rerank_top_n',
  'rerank_blend_alpha',
  'min_score',
] as const

export interface ContinuityRun {
  cases: ContinuityCaseResult[]
  arms: ContinuityArmMetrics[]
  /** one ledger per arm: each arm replays the fixture into its own database */
  ledgers: Array<[ContinuityArm, ContinuityLedger]>
  notes: string[]
  vectorsAvailable: boolean
  vectorMode: VectorMode
}

export interface ContinuityRunOptions {
  /**
   * arm execution order. the suite runs the shipped order; a test flips it to prove the
   * arms do not observe each other, because a mutating probe (restore, sweep) in one arm
   * must not change what another arm reads.
   */
  armOrder?: ContinuityArm[]
}

/** the shipped arm order: the full read path, the ablation, then the control */
export const CONTINUITY_ARM_ORDER: ContinuityArm[] = ['full', 'single-layer', 'memory-off']

export async function runContinuitySuite(ctx: SuiteContext): Promise<SuiteOutput> {
  const { fixture, gold } = buildContinuityFixture(ctx.seed)
  const tokenizer = await resolveTokenizer()
  const hash = corpusHash(fixture)
  const notes: string[] = []
  const metrics: Record<string, unknown> = {}
  const timings: Record<string, TimingSummary> = {}
  const thresholds: Record<string, Record<string, number>> = {}
  const details: unknown[] = []
  const featureFlags: Record<string, string> = {}
  const goldByProbe = new Map(gold.map((entry) => [entry.probe_id, entry]))
  const runs: Array<[string, ContinuityRun]> = []

  for (const [configName, patch] of ctx.configs) {
    const flags = applyFeatureFlags(patch.features)
    featureFlags[configName] = JSON.stringify(patch.features ?? {})
    let run: ContinuityRun
    try {
      run = await runContinuityConfig(ctx, fixture, goldByProbe, patch, tokenizer)
    } finally {
      flags.restore()
    }
    runs.push([configName, run])
    for (const arm of run.arms) {
      metrics[`${configName}/${arm.arm}`] = arm
      thresholds[`${configName}/${arm.arm}`] = continuityFlatMetrics(arm)
    }
    details.push({ config: configName, cases: run.cases })
    notes.push(...run.notes)
    // ingest is replayed per arm, so its samples are pooled across the arms that seeded
    // a store; a probe's latency is reported per arm
    timings[`${configName}/ingest-per-event`] = summarizeLatencies(
      run.ledgers
        .filter(([arm]) => arm !== 'memory-off')
        .flatMap(([, ledger]) => Object.values(ledger.ingestMs))
    )
    for (const [arm, ledger] of run.ledgers) {
      timings[`${configName}/probe/${arm}`] = summarizeLatencies(Object.values(ledger.probeMs))
    }
  }

  const [primaryName, primary] = runs[0] ?? []
  if (!primaryName || !primary) throw new Error('continuity: no config ran')
  const arms = primary.arms
  const insufficient = arms[0]?.denominators.insufficientCases ?? 0
  notes.unshift(
    `fixture: ${fixture.events.length} events streamed in order, ${fixture.probes.length} probes at ` +
      `${new Set(fixture.probes.map((probe) => probe.checkpoint)).size} checkpoints, seed ${ctx.seed}, ` +
      `families ${Object.entries(fixture.counts.by_family)
        .map(([family, count]) => `${family}=${count}`)
        .join(' ')}`
  )
  notes.push(
    `arms: ${arms.map((arm) => `${arm.arm} reads ${ARM_READS[arm.arm]}`).join('; ')}`
  )
  notes.push(
    `budget: ${insufficient} of ${fixture.probes.length} probes declare a budget below the answer ` +
      'offset; they are reported as insufficient-budget and are not counted as a pass or a failure'
  )
  notes.push(
    'task success: these are fixed-controller contract results. true llm-agent task success is ' +
      `NOT measured here (${CONTINUITY_AGENT_REASON}); eval/README.md documents the integration ` +
      'protocol for a reader/judge run and for MemoryArena/DolphinBench-style task suites'
  )
  notes.push(
    'ground truth: answers, evidence ids and forbidden values live in the scorer only; the controller ' +
      'receives the events and the probe questions, never a label'
  )

  const markdown = renderContinuityMarkdown({
    fixture,
    arms,
    cases: primary.cases,
    timings,
  })

  return {
    result: {
      suite: 'continuity',
      header: ctx.buildHeader({
        suite: 'continuity',
        configs: ctx.configs.map(([name]) => name),
        seed: ctx.seed,
        corpusHash: hash,
        vectorsAvailable: primary.vectorsAvailable,
        vectorMode: primary.vectorMode,
        now: fixture.now,
        tokenizer,
        featureFlags,
      }),
      metrics: {
        fixture: {
          seed: fixture.seed,
          events: fixture.events.length,
          probes: fixture.probes.length,
          checkpoints: [...new Set(fixture.probes.map((probe) => probe.checkpoint))],
          by_family: fixture.counts.by_family,
          restart_after_seq: fixture.restart_after_seq,
          corpus_hash: hash.short,
        },
        arms: ARM_READS,
        task_success: {
          contract:
            'fixed controller: the shipped surfaces are scored on whether they served the evidence',
          agent: {
            status: CONTINUITY_AGENT_STATUS,
            reason: CONTINUITY_AGENT_REASON,
            protocol: 'eval/README.md#continuity',
          },
        },
        ...Object.fromEntries(arms.map((arm) => [arm.arm, arm])),
      },
      timings,
      details,
      notes,
    },
    markdown,
    thresholds,
  }
}

/**
 * one config over the whole fixture. each arm replays the fixture into its own isolated
 * database, so a probe that mutates its store cannot change what another arm reads, and
 * harnesses are created one at a time because each owns a process-wide database singleton.
 */
export async function runContinuityConfig(
  ctx: SuiteContext,
  fixture: ContinuityFixture,
  goldByProbe: Map<string, ContinuityGold>,
  patch: RetrievalConfigPatch,
  tokenizer: Awaited<ReturnType<typeof resolveTokenizer>>,
  options: ContinuityRunOptions = {}
): Promise<ContinuityRun> {
  const armOrder = options.armOrder ?? CONTINUITY_ARM_ORDER
  const notes: string[] = []
  const cases: ContinuityCaseResult[] = []
  const ledgers: Array<[ContinuityArm, ContinuityLedger]> = []
  const runnerOptions: ContinuityRunnerOptions = {
    search: recallSearchPatch(patch),
    limit: ctx.limit ?? 10,
  }
  let vectorsAvailable = false
  let vectorMode: VectorMode = 'fts'
  let restartOpenTasks = 0

  for (const arm of armOrder) {
    const ledger = createContinuityLedger()
    ledgers.push([arm, ledger])
    const dir = mkdtempSync(join(tmpdir(), `engram-eval-continuity-${arm}-${ctx.seed}-`))
    let harness = await EvalHarness.create({
      seed: ctx.seed,
      vectors: ctx.vectors,
      now: fixture.now,
      tmpDir: dir,
      keep: true,
    })
    vectorsAvailable = harness.vectorsAvailable
    vectorMode = harness.vectorMode
    try {
      if (arm === 'memory-off') {
        // the negative control: the same controller, the same probes, an empty store
        for (const probe of fixture.probes) {
          const gold = goldByProbe.get(probe.id)
          if (!gold) throw new Error(`continuity: no gold for probe ${probe.id}`)
          const reader = new ContinuityRunner(harness, fixture, ledger, tokenizer, runnerOptions)
          const read = await reader.readProbe(probe, 'memory-off')
          cases.push(scoreContinuityCase(read, probe, gold))
        }
        continue
      }

      for (const event of fixture.events) {
        const runner = new ContinuityRunner(harness, fixture, ledger, tokenizer, runnerOptions)
        await runner.applyEvent(event)

        if (event.seq === fixture.restart_after_seq) {
          // the restart: the process-level services and the open database handle go
          // away, and the next session reopens the same file. rows written before the
          // restart are the only reason the resumed task can be found at all.
          harness.dispose()
          harness = await EvalHarness.create({
            seed: ctx.seed,
            vectors: ctx.vectors,
            now: fixture.now,
            tmpDir: dir,
            keep: true,
          })
          const open = harness.db
            .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('open','blocked')")
            .get() as { n: number }
          restartOpenTasks = open.n
        }

        for (const probe of fixture.probes.filter((entry) => entry.after_seq === event.seq)) {
          const gold = goldByProbe.get(probe.id)
          if (!gold) throw new Error(`continuity: no gold for probe ${probe.id}`)
          const reader = new ContinuityRunner(harness, fixture, ledger, tokenizer, runnerOptions)
          const read = await reader.readProbe(probe, arm)
          cases.push(scoreContinuityCase(read, probe, gold))
        }
      }
    } finally {
      harness.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  notes.push(
    `restart: each arm replays the fixture into its own database and reopens it after ` +
      `event ${fixture.restart_after_seq}; open tasks found by the next session=${restartOpenTasks}`
  )
  notes.push(
    "isolation: one database per arm, so the full arm's restore and expiry sweep cannot " +
      'change what the single-layer ablation or the control reads'
  )
  notes.push(
    'memory-off control: the same probes over an empty isolated store, so a pass rate ' +
      'cannot be satisfied by the instrument itself'
  )
  notes.push(
    'budget: one probe is one payload with one cap. a composed read packs its state, ' +
      'history, summary and citation surfaces into the room the budgeted read left, and the ' +
      'scorer counts the delivered context itself rather than trusting used_chars'
  )
  notes.push(
    'safety: a budget overflow, a served future row, a namespace leak and a producer that ' +
      'under-reported are counted over every case, including insufficient-budget ones, and ' +
      'listed per case'
  )

  const arms = armOrder.map((arm) =>
    summarizeContinuityArm(cases, arm, ledgers.find(([candidate]) => candidate === arm)![1])
  )
  return { cases, arms, ledgers, notes, vectorsAvailable, vectorMode }
}

/** the recall knobs a config patch declares, filtered to the ones recall accepts */
export function recallSearchPatch(patch: RetrievalConfigPatch): RecallOptions['search'] {
  const requested = patch.search ?? {}
  const out: NonNullable<RecallOptions['search']> = {}
  for (const key of RECALL_PATCH_KEYS) {
    const value = requested[key]
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}

export function renderContinuityMarkdown(input: {
  fixture: ContinuityFixture
  arms: ContinuityArmMetrics[]
  cases: ContinuityCaseResult[]
  timings: Record<string, TimingSummary>
}): string {
  const sections: string[] = []
  sections.push(
    `One synthetic agent workflow, streamed in chronological order and probed at ` +
      `${new Set(input.fixture.probes.map((probe) => probe.checkpoint)).size} checkpoints: ` +
      `${input.fixture.events.length} events, ${input.fixture.probes.length} probes, ` +
      `seed ${input.fixture.seed}. A probe is read after its checkpoint event, so a served row ` +
      'written later is a leak the scorer counts. One probe is one payload with one cap: a read ' +
      'that composes surfaces (state slots, history, a close summary, citations, a second read ' +
      'after a sweep) packs every surface into what the budgeted read left, and the scorer ' +
      'measures the delivered context itself rather than trusting the producer\'s accounting. ' +
      '`passRate` is over scored cases only; an insufficient-budget case is reported and excluded ' +
      'from both numerator and denominator, while its safety findings (a budget overflow, a future ' +
      'row, a namespace leak, a producer that under-reported) are still counted in the arm block.'
  )

  sections.push(
    `### arms\n\n${markdownTable(renderContinuityArmsTable(input.arms))}\n\n` +
      '`coverage` is the share of scored cases whose gold evidence was served (denominator: scored ' +
      'cases with an evidence gold); `citation` the share whose citation names the right source and ' +
      'external id; `leakRate` the share of served rows outside the probe namespace; `staleRate` the ' +
      'share of served rows carrying a forbidden value; `distractor` the share of distractor-sensitive ' +
      'cases served the twin; `futureLeak` the share of served rows written after the checkpoint; ' +
      '`budgetViol` counts payloads over their cap and `safetyViol` counts cases with any safety ' +
      'finding — both over every case, scored or insufficient; `acctUnder` counts cases where the ' +
      'producer\'s own section was longer than the budget it claimed; `budgetReported` is the share ' +
      'of insufficient-budget cases whose own accounting reported the cut.'
  )

  sections.push(
    `### by family\n\n${markdownTable(renderContinuityFamilyTable(input.arms))}\n\n` +
      'families: `resume` (restart, resumed task, close summary), `correction` (current value and its ' +
      'history), `evidence` (episode-only evidence and citations), `namespace` (the twin namespace ' +
      'and its control), `budget`, `archive` (prune, hidden read, restore) and `expiry` (ttl sweep).'
  )

  const budgetRows = input.cases
    .filter((entry) => entry.family === 'budget')
    .map((entry) => [
      entry.arm,
      entry.probe_id,
      entry.status,
      entry.checks.budget_respected ? 'yes' : 'NO',
      entry.delivered_chars,
      entry.composed?.cap ?? entry.budget?.budget_chars ?? 0,
      entry.reported_used_chars ?? 'n/a',
      entry.budget?.dropped_memories ?? 0,
      entry.budget?.truncated_memories ?? 0,
      entry.budget?.digest_chars_cut ?? 0,
      entry.budget?.dropped_topics ?? 0,
    ])
  sections.push(
    `### budget cases\n\n${markdownTable({
      columns: [
        'arm',
        'probe',
        'status',
        'respected',
        'delivered',
        'cap',
        'reported',
        'dropMem',
        'truncMem',
        'digestCut',
        'dropTopics',
      ],
      rows: budgetRows,
    })}\n\n` +
      '`delivered` is the scorer\'s own count of the payload it scored, `cap` the probe\'s budget, ' +
      '`reported` the producer\'s claim (n/a when the read carried none). An insufficient-budget ' +
      'probe is never scored as a success: the suite reports it, and the packer\'s own ' +
      'dropped/truncated accounting is what the record shows.'
  )

  const caseRows = input.cases
    .filter((entry) => entry.arm === 'full')
    .map((entry) => [
      entry.probe_id,
      entry.family,
      entry.checkpoint,
      entry.status,
      entry.failed_checks.length > 0 ? entry.failed_checks.join(', ') : '-',
      entry.violations.length > 0 ? entry.violations.join(', ') : '-',
      entry.served,
      entry.delivered_chars,
      entry.served_tokens,
    ])
  sections.push(
    `### full arm, per case\n\n${markdownTable({
      columns: [
        'probe',
        'family',
        'checkpoint',
        'status',
        'failed checks',
        'violations',
        'served',
        'delivered',
        'tokens',
      ],
      rows: caseRows,
    })}`
  )

  const failing = input.arms
    .map((arm) => {
      const failed = input.cases.filter((entry) => entry.arm === arm.arm && entry.status === 'fail')
      if (failed.length === 0) return `${arm.arm}: no failing case`
      const names = [...new Set(failed.flatMap((entry) => entry.failed_checks))].sort()
      return `${arm.arm}: ${failed.length} failing case(s) — checks that failed: ${names.join(', ')}`
    })
    .join('\n')
  sections.push(`### what failed, by arm\n\n${failing}`)

  sections.push(
    `### operations\n\n${markdownTable({
      columns: ['arm', 'ingest write op', 'count'],
      rows: input.arms.flatMap((arm) =>
        Object.entries(arm.ingestOps)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([op, count]) => [arm.arm, op, count])
      ),
    })}\n\n` +
      `Probe-side actions, by arm (a restore or a sweep the probe itself performs, not a ` +
      `seeding cost):\n\n${markdownTable({
        columns: ['arm', 'probe op', 'count'],
        rows: input.arms.flatMap((arm) =>
          Object.entries(arm.probeOps)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([op, count]) => [arm.arm, op, count])
        ),
      })}\n\n` +
      `Read operations, by arm (the same probes, the surfaces each arm consults):\n\n${markdownTable({
        columns: ['arm', 'read op', 'count'],
        rows: input.arms.flatMap((arm) =>
          Object.entries(arm.readOps)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([op, count]) => [arm.arm, op, count])
        ),
      })}\n\n` +
      'each arm replays the fixture into its own database, so its ingest count is its own; the ' +
      '`memory-off` control writes nothing, and its own row says so.'
  )

  sections.push(
    `### latency (wall clock; not covered by the determinism guarantee)\n\n${renderTimings(
      input.timings
    )}`
  )
  return sections.join('\n\n')
}
