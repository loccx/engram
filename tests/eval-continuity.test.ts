// continuity suite tests: the fixture's chronology and separation, the scorer's leak
// detection, the suite's determinism, its negative control and ablation behaviour, the
// budget invariants, and the cli wiring. the suite is cheap (seven events, twelve
// probes, fts-only), so it runs in-process more than once here on purpose: only a second
// run can show that the metric block is a pure function of (fixture, seed, config, code).
import { beforeAll, describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  buildContinuityFixture,
  CONTINUITY_EPOCH,
  CONTINUITY_HOUR,
  CONTINUITY_RESTART_AFTER_SEQ,
  type ContinuityGold,
  type ContinuityProbe,
} from '../eval/lib/continuity-corpus.js'
import {
  ContinuityRunner,
  createContinuityLedger,
} from '../eval/lib/continuity-runner.js'
import {
  scoreContinuityCase,
  summarizeContinuityArm,
  type ContinuityArmMetrics,
  type ContinuityCaseResult,
} from '../eval/lib/continuity-score.js'
import { runContinuityConfig, runContinuitySuite } from '../eval/suites/continuity.js'
import { suiteNames } from '../eval/suites/index.js'
import { EvalHarness } from '../eval/lib/harness.js'
import { countEpisodes } from '../src/memory/episodes.js'
import { resetTokenizerForTests, resolveTokenizer } from '../eval/lib/metrics.js'
import { resolveConfigs } from '../eval/lib/registry.js'
import { buildHeader, REPO_ROOT } from '../eval/lib/report.js'
import type { PricedRead } from '../eval/lib/continuity-runner.js'
import type { SuiteContext, SuiteOutput } from '../eval/suites/types.js'

const SEED = 1234
const tempDirs: string[] = []

function tempDir(prefix = 'engram-eval-continuity-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function suiteContext(dir: string): SuiteContext {
  return {
    seed: SEED,
    configs: resolveConfigs([]),
    vectors: 'fts',
    qa: false,
    outDir: dir,
    gitSha: 'testsha',
    buildHeader: (input) => buildHeader({ ...input, git: undefined }),
    log: () => {},
  }
}

/** every case of one arm, from the suite's detail records */
function casesOf(output: SuiteOutput, arm: string): ContinuityCaseResult[] {
  const cases = output.result.details.flatMap(
    (entry) => (entry as { cases: ContinuityCaseResult[] }).cases
  )
  return cases.filter((entry) => entry.arm === arm)
}

function armOf(output: SuiteOutput, arm: string): ContinuityArmMetrics {
  return output.result.metrics[arm] as ContinuityArmMetrics
}

/** a read with everything empty, so one field can be varied per test */
function emptyRead(overrides: Partial<PricedRead> = {}): PricedRead {
  return {
    probe_id: 'namespace-window',
    arm: 'full',
    action: 'test',
    context: [],
    served: [],
    budget: null,
    state: null,
    task: null,
    summary: null,
    citations: null,
    archive: null,
    expiry: null,
    degraded: [],
    latencyMs: 0,
    primaryChars: 0,
    composer: null,
    chars: 0,
    tokens: 0,
    tokensPerChar: 0,
    producerUsedChars: null,
    producerUnderreport: false,
    ...overrides,
  }
}

let first: SuiteOutput
let second: SuiteOutput

beforeAll(async () => {
  first = await runContinuitySuite(suiteContext(tempDir()))
  second = await runContinuitySuite(suiteContext(tempDir()))
}, 300_000)

describe('continuity fixture', () => {
  it('streams events in order and probes each one after its checkpoint', () => {
    const { fixture } = buildContinuityFixture(SEED)
    expect(fixture.events.length).toBe(7)
    expect(fixture.probes.length).toBe(12)
    expect(fixture.restart_after_seq).toBe(CONTINUITY_RESTART_AFTER_SEQ)
    for (const [index, event] of fixture.events.entries()) {
      expect(event.seq).toBe(index + 1)
      if (index > 0) expect(event.at).toBeGreaterThan(fixture.events[index - 1].at)
    }
    for (const probe of fixture.probes) {
      expect(probe.after_seq).toBeGreaterThanOrEqual(1)
      expect(probe.after_seq).toBeLessThanOrEqual(fixture.events.length)
      expect(probe.budget_chars).toBeGreaterThan(0)
      expect(fixture.events.some((event) => event.seq === probe.after_seq)).toBe(true)
    }
  })

  it('arrives at every probe’s evidence at or before its checkpoint', () => {
    const { fixture, gold } = buildContinuityFixture(SEED)
    const eventSeqOf = (fragment: string): number | null => {
      for (const event of fixture.events) {
        for (const action of event.actions) {
          const texts =
            action.kind === 'memory'
              ? [action.content]
              : action.kind === 'episodes'
                ? action.items.map((item) => item.content)
                : action.kind === 'cold_store'
                  ? action.contents
                  : []
          if (texts.some((text) => text.includes(fragment))) return event.seq
        }
      }
      return null
    }
    for (const entry of gold) {
      const probe = fixture.probes.find((candidate) => candidate.id === entry.probe_id)
      expect(probe).toBeDefined()
      const fragments = [entry.answer, ...(entry.required_fragments ?? [])].filter(
        (value): value is string => typeof value === 'string'
      )
      for (const fragment of fragments) {
        const seq = eventSeqOf(fragment)
        // a fragment no event carries is a resume brief assembled at close time; those
        // are checked against the task the events built, not against a single event
        if (seq === null) continue
        expect(seq, `${entry.probe_id}: "${fragment}" arrives after its checkpoint`).toBeLessThanOrEqual(
          probe!.after_seq
        )
      }
      // the question must not contain its own answer
      if (entry.answer) expect(probe!.query).not.toContain(entry.answer)
    }
    // the distractor twin exists by the checkpoint that probes for it
    const distractor = gold.find((entry) => entry.probe_id === 'namespace-window')!
    expect(distractor.distractor_value).toBe('02:00-04:00 utc')
    expect(eventSeqOf('02:00-04:00')).toBeLessThanOrEqual(3)
  })

  it('is a pure function of the seed, and the seed moves the twin', () => {
    const a = buildContinuityFixture(SEED)
    const b = buildContinuityFixture(SEED)
    const c = buildContinuityFixture(SEED + 1)
    const hashOf = (bundle: { fixture: unknown }): string => JSON.stringify(bundle.fixture)
    expect(hashOf(a)).toBe(hashOf(b))
    expect(hashOf(c)).not.toBe(hashOf(a))
    // only the distractor namespace carries a seed-derived token; the target's answers
    // do not move with the seed
    const answer = (bundle: typeof a): string | undefined =>
      bundle.gold.find((entry) => entry.probe_id === 'namespace-window')?.answer
    expect(answer(a)).toBe(answer(c))
    const twin = (bundle: typeof a): string | undefined =>
      bundle.gold.find((entry) => entry.probe_id === 'namespace-window')?.distractor_value
    expect(twin(a)).toBe(twin(c))
    expect(JSON.stringify(a.fixture)).not.toBe(JSON.stringify(c.fixture))
  })

  it('declares exactly one insufficient-budget probe, and it is the tight one', () => {
    const { fixture, gold } = buildContinuityFixture(SEED)
    const withGold = fixture.probes.map((probe) => ({
      probe,
      gold: gold.find((entry) => entry.probe_id === probe.id)!,
    }))
    const insufficient = withGold.filter(({ probe, gold: entry }) => probe.budget_chars < entry.min_chars)
    expect(insufficient.map(({ probe }) => probe.id)).toEqual(['budget-tight'])
    expect(insufficient[0].probe.budget_chars).toBe(40)
    expect(insufficient[0].gold.min_chars).toBeGreaterThan(40)
  })
})

describe('continuity scoring', () => {
  const bundle = buildContinuityFixture(SEED)

  function probeAndGold(id: string): { probe: (typeof bundle.fixture.probes)[number]; gold: ContinuityGold } {
    const probe = bundle.fixture.probes.find((entry) => entry.id === id)!
    const gold = bundle.gold.find((entry) => entry.probe_id === id)!
    return { probe, gold }
  }

  it('detects a row written after the checkpoint', () => {
    const { probe, gold } = probeAndGold('namespace-window')
    const read = emptyRead({
      context: [gold.answer!],
      served: [
        {
          id: 'future-row',
          local_id: 'deploy-window-v1',
          namespace: probe.namespace,
          content: gold.answer!,
          at: CONTINUITY_EPOCH + 4 * CONTINUITY_HOUR,
          seq: probe.after_seq + 1,
          source: 'memory',
        },
      ],
    })
    const result = scoreContinuityCase(read, probe, gold)
    expect(result.future_leaks).toBe(1)
    expect(result.checks.future_absent).toBe(false)
    expect(result.failed_checks).toContain('future_absent')
    expect(result.status).toBe('fail')
  })

  it('counts a sibling namespace’s row as a leak and the twin as a distractor', () => {
    const { probe, gold } = probeAndGold('namespace-window')
    const read = emptyRead({
      context: [gold.answer!, gold.distractor_value!],
      served: [
        {
          id: 'twin-row',
          local_id: 'staging-window',
          namespace: bundle.fixture.staging_namespace,
          content: gold.distractor_value!,
          at: CONTINUITY_EPOCH + 3 * CONTINUITY_HOUR,
          seq: 3,
          source: 'memory',
        },
      ],
    })
    const result = scoreContinuityCase(read, probe, gold)
    expect(result.namespace_leaks).toBe(1)
    expect(result.checks.namespace_isolated).toBe(false)
    expect(result.distractor_served).toBe(true)
    expect(result.checks.distractor_absent).toBe(false)
    expect(result.status).toBe('fail')
  })

  it('never scores an insufficient-budget case as a pass or a failure', () => {
    const { probe, gold } = probeAndGold('budget-tight')
    const read = emptyRead({
      probe_id: 'budget-tight',
      context: ['x'.repeat(probe.budget_chars)],
      served: [],
      budget: {
        budget_chars: probe.budget_chars,
        used_chars: probe.budget_chars,
        dropped_memories: 2,
        dropped_topics: 0,
        digest_chars_cut: 0,
        truncated_memories: 1,
        truncated_topics: 0,
      },
    })
    const result = scoreContinuityCase(read, probe, gold)
    expect(result.insufficient).toBe(true)
    expect(result.scored).toBe(false)
    expect(result.status).toBe('insufficient-budget')
    // the packer's own accounting is what "reported" means here
    expect(result.budget_report).toEqual({
      respected: true,
      accounted: true,
      reported_used_chars: probe.budget_chars,
      delivered_chars: probe.budget_chars,
      gap: 0,
      reported_cut: true,
    })
  })

  it("checks the delivered context itself, not the producer's accounting", () => {
    // parent falsifier: a producer that claims 76 chars while delivering 316 must not be
    // able to buy a pass with its own number
    const base = probeAndGold('state-history')
    const probe = { ...base.probe, budget_chars: 100 }
    const gold = base.gold
    const honest = emptyRead({
      probe_id: 'state-history',
      context: ['x'.repeat(316)],
      primaryChars: 76,
      budget: {
        budget_chars: probe.budget_chars,
        used_chars: 76,
        dropped_memories: 0,
        dropped_topics: 0,
        digest_chars_cut: 0,
        truncated_memories: 0,
        truncated_topics: 0,
      },
    })
    const over = scoreContinuityCase(honest, probe, gold)
    expect(over.delivered_chars).toBe(316)
    expect(over.reported_used_chars).toBe(76)
    expect(over.checks.budget_respected).toBe(false)
    expect(over.violations).toContain('budget_overflow')
    expect(over.status).toBe('fail')

    // the same numbers with a dishonest producer section: its own claim is smaller than
    // what its section delivered, which is a violation of its own
    const underreported = scoreContinuityCase(
      emptyRead({
        probe_id: 'state-history',
        context: ['x'.repeat(316)],
        primaryChars: 316,
        producerUsedChars: 76,
        producerUnderreport: true,
      }),
      probe,
      gold
    )
    expect(underreported.violations).toContain('producer_underreport')
    expect(underreported.violations).toContain('budget_overflow')
    expect(underreported.status).toBe('fail')

    // a read with no producer accounting is still checked against the cap
    const noAccounting = scoreContinuityCase(
      emptyRead({ probe_id: 'state-history', context: ['x'.repeat(40)], budget: null }),
      probe,
      gold
    )
    expect(noAccounting.checks.budget_respected).toBe(true)
    expect(noAccounting.budget_report.accounted).toBe(false)
    expect(noAccounting.violations).toEqual([])
  })

  it('keeps a safety violation visible when the case is insufficient', () => {
    const { probe, gold } = probeAndGold('budget-tight')
    const read = emptyRead({
      probe_id: 'budget-tight',
      // 40-char cap, 80 delivered: the usefulness question cannot be scored, but the
      // overflow is a safety finding and must survive the exclusion
      context: ['x'.repeat(80)],
      budget: {
        budget_chars: probe.budget_chars,
        used_chars: 80,
        dropped_memories: 0,
        dropped_topics: 0,
        digest_chars_cut: 0,
        truncated_memories: 0,
        truncated_topics: 0,
      },
    })
    const result = scoreContinuityCase(read, probe, gold)
    expect(result.insufficient).toBe(true)
    expect(result.scored).toBe(false)
    expect(result.status).toBe('insufficient-budget')
    expect(result.violations).toEqual(['budget_overflow'])
    expect(result.safety_failed).toBe(true)

    // the arm rollup counts it even though the case is not scored
    const arm = summarizeContinuityArm([result], 'full', createContinuityLedger())
    expect(arm.scored).toBe(0)
    expect(arm.pass).toBe(0)
    expect(arm.fail).toBe(0)
    expect(arm.budgetViolations).toBe(1)
    expect(arm.safetyViolations).toBe(1)
    expect(arm.denominators.allCases).toBe(1)
    expect(arm.denominators.violatingCases).toBe(1)
  })

  it('fails a case whose payload never read the surface it required', () => {
    const { probe, gold } = probeAndGold('archive-restore')
    const result = scoreContinuityCase(emptyRead({ probe_id: 'archive-restore' }), probe, gold)
    expect(result.status).toBe('fail')
    expect(result.missing_required.length).toBeGreaterThan(0)
    expect(result.checks.archive_applied).toBe(false)
  })
})

describe('continuity suite', () => {
  it('is wired into the suite registry', () => {
    expect(suiteNames()).toContain('continuity')
  })

  it('separates the fixed-controller contract from the unclaimed agent run', () => {
    const taskSuccess = first.result.metrics.task_success as {
      contract: string
      agent: { status: string; reason: string; protocol: string }
    }
    expect(taskSuccess.contract).toContain('fixed controller')
    expect(taskSuccess.agent.status).toBe('not_run')
    expect(taskSuccess.agent.reason).toContain('no gateway')
    expect(taskSuccess.agent.protocol).toBe('eval/README.md#continuity')
    expect(first.result.header.suite).toBe('continuity')
    expect(first.result.header.corpusHash).toBeTruthy()
    expect(first.thresholds['baseline/single-layer']).toBeDefined()
    expect(first.thresholds['baseline/memory-off']).toBeDefined()
    // every flat name eval/lib/thresholds.ts gates for continuity is emitted, and a
    // rate can never be recorded as a string or a missing key
    const gated = [
      'passRate',
      'coverage',
      'citationCoverage',
      'namespaceLeakRate',
      'staleRate',
      'staleCaseRate',
      'distractorRate',
      'futureLeakRate',
      'budgetViolations',
      'safetyViolations',
      'producerUnderreports',
      'budgetReportedRate',
    ]
    for (const arm of ['baseline/full', 'baseline/single-layer', 'baseline/memory-off']) {
      for (const metric of gated) {
        expect(typeof first.thresholds[arm][metric], `${arm}.${metric}`).toBe('number')
      }
    }
    expect(first.thresholds['baseline/full'].budgetViolations).toBe(0)
    expect(first.thresholds['baseline/memory-off'].passRate).toBe(0)
  })

  it('is deterministic: same seed and config, identical metrics', () => {
    expect(JSON.stringify(second.result.metrics)).toEqual(JSON.stringify(first.result.metrics))
    const strip = (output: SuiteOutput): string =>
      JSON.stringify(
        output.result.details.map((entry) =>
          (entry as { cases: ContinuityCaseResult[] }).cases.map(({ latency_ms: _latency, ...rest }) => rest)
        )
      )
    expect(strip(second)).toEqual(strip(first))
  })

  it('collapses the memory-off control and keeps the ablation below the full arm', () => {
    const full = armOf(first, 'full')
    const single = armOf(first, 'single-layer')
    const off = armOf(first, 'memory-off')
    expect(off.scored).toBeGreaterThan(0)
    expect(off.pass).toBe(0)
    expect(off.passRate).toBe(0)
    expect(full.pass).toBeGreaterThan(single.pass)
    expect(single.pass).toBeGreaterThan(0)
    // every case is either scored or reported insufficient, never silently dropped
    for (const arm of [full, single, off]) {
      expect(arm.cases).toBe(arm.scored + arm.insufficient)
      expect(arm.byFamily.resume.cases).toBe(2)
      expect(arm.byFamily.budget.insufficient).toBe(1)
    }
    // the full arm serves the lifecycle the other suites cannot express
    expect(full.pass / full.scored).toBeGreaterThan(0.7)
    expect(full.byFamily.resume.pass).toBe(2)
    expect(full.byFamily.correction.pass).toBe(2)
    expect(full.byFamily.evidence.pass).toBe(2)
    expect(full.byFamily.archive.pass).toBe(1)
    expect(full.byFamily.expiry.pass).toBe(1)
    // the ablation is what the memories layer alone buys
    expect(single.byFamily.namespace.pass).toBe(2)
    expect(single.byFamily.resume.pass).toBe(0)
    expect(single.byFamily.correction.pass).toBe(0)
    expect(single.byFamily.expiry.pass).toBe(0)
  })

  it('keeps every payload inside its budget and reports the tight one', () => {
    const full = armOf(first, 'full')
    expect(full.budgetViolations).toBe(0)
    expect(full.budgetReportedRate).toBe(1)
    const cases = casesOf(first, 'full')
    for (const entry of cases) {
      const probe = buildContinuityFixture(SEED).fixture.probes.find(
        (candidate) => candidate.id === entry.probe_id
      )!
      expect(entry.delivered_chars, entry.probe_id).toBeLessThanOrEqual(probe.budget_chars)
      if (entry.budget) {
        expect(entry.budget.budget_chars, entry.probe_id).toBe(probe.budget_chars)
      }
    }
    const tight = cases.find((entry) => entry.probe_id === 'budget-tight')!
    expect(tight.status).toBe('insufficient-budget')
    expect(tight.scored).toBe(false)
    expect(tight.budget_report?.reported_cut).toBe(true)
    const sufficient = cases.find((entry) => entry.probe_id === 'budget-sufficient')!
    expect(sufficient.status).toBe('pass')
  })

  it('isolates the probe namespace and keeps the twin retrievable in its own', () => {
    const cases = casesOf(first, 'full')
    for (const entry of cases) {
      expect(entry.namespace_leaks, entry.probe_id).toBe(0)
      expect(entry.future_leaks, entry.probe_id).toBe(0)
    }
    const window = cases.find((entry) => entry.probe_id === 'namespace-window')!
    expect(window.checks.distractor_absent).toBe(true)
    expect(window.checks.answer_served).toBe(true)
    expect(window.checks.evidence_served).toBe(true)
    const control = cases.find((entry) => entry.probe_id === 'namespace-staging-control')!
    expect(control.status).toBe('pass')
    const full = armOf(first, 'full')
    expect(full.denominators.servedItems).toBeGreaterThan(0)
    expect(full.denominators.distractorCases).toBe(1)
    expect(full.namespaceLeakRate).toBe(0)
    expect(full.futureLeakRate).toBe(0)
    expect(full.staleRate).toBe(0)
  })

  it('carries the lifecycle checks each case exists for', () => {
    const cases = casesOf(first, 'full')
    const by = (id: string): ContinuityCaseResult => cases.find((entry) => entry.probe_id === id)!
    expect(by('resume-brief').checks.fragments_present).toBe(true)
    expect(by('resume-brief').checks.task_found).toBe(true)
    expect(by('state-current').checks.state_current_contains).toBe(true)
    expect(by('state-current').checks.forbidden_absent).toBe(true)
    expect(by('state-history').checks.state_prior_contains).toBe(true)
    expect(by('state-history').checks.history_contains).toBe(true)
    expect(by('citation-source').checks.citation_correct).toBe(true)
    expect(by('archive-restore').checks).toMatchObject({
      archive_applied: true,
      archive_hidden: true,
      archive_by_id_hidden: true,
      archive_readable_with_flag: true,
      archive_restored: true,
      archive_restored_served: true,
    })
    expect(by('expiry-sweep').checks).toMatchObject({
      expired_absent_before: true,
      durable_served_before: true,
      sweep_removed_expired: true,
      expired_gone_after: true,
      durable_still_served: true,
    })
    expect(by('close-summary').checks).toMatchObject({
      no_open_task: true,
      summary_found: true,
      summary_served: true,
      citation_correct: true,
    })
    // the archive read carries no producer budget record, so its delivered context is
    // checked against the cap directly and its accounting is reported as absent
    expect(by('archive-restore').budget).toBeNull()
    expect(by('archive-restore').budget_claim).toBe('respected')
    expect(by('archive-restore').checks.budget_respected).toBe(true)
    expect(by('archive-restore').budget_report.accounted).toBe(false)
    expect(by('archive-restore').delivered_chars).toBeLessThanOrEqual(
      by('archive-restore').composed?.cap ?? Number.MAX_SAFE_INTEGER
    )
    // raw per-case action is recorded, not inferred
    expect(by('archive-restore').action).toContain('unarchive_memory')
    expect(by('expiry-sweep').action).toContain('delete_episodes')
    const resumeActions = cases
      .filter((entry) => entry.family === 'resume')
      .map((entry) => entry.action)
    expect(resumeActions.some((action) => action.includes('task_handoff'))).toBe(true)
    expect(resumeActions.some((action) => action.includes('cited_episodes'))).toBe(true)
  })
})

describe('continuity temporal order', () => {
  it('has written nothing from a later event before its checkpoint', async () => {
    const dir = tempDir()
    const { fixture } = buildContinuityFixture(SEED)
    const tokenizer = await resolveTokenizer()
    const ledger = createContinuityLedger()
    const harness = await EvalHarness.create({
      seed: SEED,
      vectors: 'fts',
      now: fixture.now,
      tmpDir: dir,
      keep: true,
    })
    try {
      const runner = new ContinuityRunner(harness, fixture, ledger, tokenizer)
      for (const event of fixture.events.filter(
        (entry) => entry.seq <= CONTINUITY_RESTART_AFTER_SEQ
      )) {
        await runner.applyEvent(event)
      }
      // the only memory written by the first two events is the first deploy-window
      // value; nothing from a later event can be in the store yet
      const rows = harness.db
        .prepare('SELECT COUNT(*) AS n, MAX(created_at) AS at FROM memories')
        .get() as { n: number; at: number }
      expect(rows.n).toBe(1)
      expect(rows.at).toBe(CONTINUITY_EPOCH + CONTINUITY_HOUR)
      const externals = (
        harness.db
          .prepare('SELECT external_id FROM episodes ORDER BY external_id')
          .all() as Array<{ external_id: string }>
      ).map((row) => row.external_id)
      expect(externals).toEqual(['ct-s1-t1', 'ct-s1-t2', 'ct-s2-t1'])
      expect(
        (
          harness.db
            .prepare("SELECT COUNT(*) AS n FROM episodes WHERE external_id LIKE 'ct-s3%'")
            .get() as { n: number }
        ).n
      ).toBe(0)
      // the ledger's provenance has no row from a later event either
      expect(
        [...ledger.provenance.values()].every(
          (entry) => entry.seq <= CONTINUITY_RESTART_AFTER_SEQ
        )
      ).toBe(true)
    } finally {
      harness.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
    resetTokenizerForTests()
  }, 60_000)
})

/**
 * the parent falsifier's shape: ingest the fixture, then read one probe at a lowered
 * budget and score it. `budget` undefined keeps the fixture's own budget, so the same
 * helper proves the case still passes when the cap fits.
 */
async function readProbeAtBudget(
  id: string,
  budget?: number
): Promise<{ read: PricedRead; result: ContinuityCaseResult; probe: ContinuityProbe }> {
  const dir = tempDir()
  const { fixture, gold } = buildContinuityFixture(SEED)
  const tokenizer = await resolveTokenizer()
  const ledger = createContinuityLedger()
  const harness = await EvalHarness.create({
    seed: SEED,
    vectors: 'fts',
    now: fixture.now,
    tmpDir: dir,
    keep: true,
  })
  try {
    const runner = new ContinuityRunner(harness, fixture, ledger, tokenizer)
    const original = fixture.probes.find((probe) => probe.id === id)!
    for (const event of fixture.events) {
      await runner.applyEvent(event)
      if (event.seq !== original.after_seq) continue
      const probe = budget === undefined ? original : { ...original, budget_chars: budget }
      const read = await runner.readProbe(probe, 'full')
      const entry = gold.find((candidate) => candidate.probe_id === id)!
      return { read, result: scoreContinuityCase(read, probe, entry), probe }
    }
    throw new Error(`continuity: probe ${id} never reached its checkpoint`)
  } finally {
    harness.dispose()
    rmSync(dir, { recursive: true, force: true })
    resetTokenizerForTests()
  }
}

describe('continuity parent falsifiers', () => {
  it('does not pass state-history under a 100-char cap (316 delivered, 76 reported before the fix)', async () => {
    const { read, result } = await readProbeAtBudget('state-history', 100)
    expect(read.chars).toBeLessThanOrEqual(100)
    expect(result.delivered_chars).toBeLessThanOrEqual(100)
    expect(result.status).not.toBe('pass')
    expect(result.failed_checks).toContain('history_contains')
    expect(result.checks.budget_respected).toBe(true)
    expect(result.violations).toEqual([])
  }, 60_000)

  it('does not pass close-summary under a 400-char cap (696 delivered, 386 reported before the fix)', async () => {
    const { read, result } = await readProbeAtBudget('close-summary', 400)
    expect(read.chars).toBeLessThanOrEqual(400)
    expect(result.delivered_chars).toBeLessThanOrEqual(400)
    expect(result.status).not.toBe('pass')
    expect(result.checks.budget_respected).toBe(true)
    expect(result.violations).toEqual([])
  }, 60_000)

  it('reports state-current at a 50-char cap as insufficient and keeps it out of pass', async () => {
    const { read, result } = await readProbeAtBudget('state-current', 50)
    expect(read.chars).toBeLessThanOrEqual(50)
    expect(result.delivered_chars).toBeLessThanOrEqual(50)
    expect(result.insufficient).toBe(true)
    expect(result.scored).toBe(false)
    expect(result.status).toBe('insufficient-budget')
    expect(result.checks.state_current_contains).toBe(false)
    expect(result.violations).toEqual([])
  }, 60_000)

  it('still passes the same three probes at their fixture budgets', async () => {
    for (const id of ['state-history', 'close-summary', 'state-current']) {
      const { result } = await readProbeAtBudget(id)
      expect(result.status, id).toBe('pass')
      expect(result.delivered_chars, id).toBeLessThanOrEqual(
        buildContinuityFixture(SEED).fixture.probes.find((probe) => probe.id === id)!.budget_chars
      )
      expect(result.violations, id).toEqual([])
    }
  }, 120_000)
})

describe('continuity arm isolation', () => {
  /** the per-arm case records and metrics, minus wall clock */
  async function runInOrder(armOrder: Array<'full' | 'single-layer' | 'memory-off'>) {
    const { fixture, gold } = buildContinuityFixture(SEED)
    const tokenizer = await resolveTokenizer()
    const goldByProbe = new Map(gold.map((entry) => [entry.probe_id, entry]))
    const patch = resolveConfigs([])[0][1]
    const run = await runContinuityConfig(
      suiteContext(tempDir()),
      fixture,
      goldByProbe,
      patch,
      tokenizer,
      { armOrder }
    )
    resetTokenizerForTests()
    const casesByArm = Object.fromEntries(
      ['full', 'single-layer', 'memory-off'].map((arm) => [
        arm,
        JSON.stringify(
          run.cases
            .filter((entry) => entry.arm === arm)
            .map(({ latency_ms: _latency, ...rest }) => rest)
        ),
      ])
    )
    const metricsByArm = Object.fromEntries(
      run.arms.map((arm) => [arm.arm, JSON.stringify(arm)])
    )
    return { run, casesByArm, metricsByArm }
  }

  it('gives every arm the same results in either execution order', async () => {
    const shipped = await runInOrder(['full', 'single-layer', 'memory-off'])
    const flipped = await runInOrder(['single-layer', 'full', 'memory-off'])
    expect(flipped.casesByArm).toEqual(shipped.casesByArm)
    expect(flipped.metricsByArm).toEqual(shipped.metricsByArm)
  }, 180_000)

it('leaves a freshly seeded arm untouched by another arm\'s mutations', async () => {
    const { fixture } = buildContinuityFixture(SEED)
    const tokenizer = await resolveTokenizer()
    const archivedCount = (db: { prepare: (sql: string) => { get: () => unknown } }): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived_at IS NOT NULL').get() as {
        n: number
      }).n

    // arm A: seed, then run the two probes that mutate their own store
    const dirA = tempDir()
    const a = await EvalHarness.create({
      seed: SEED,
      vectors: 'fts',
      now: fixture.now,
      tmpDir: dirA,
      keep: true,
    })
    let sweptCount = 0
    let restoredCount = 0
    try {
      const runner = new ContinuityRunner(a, fixture, createContinuityLedger(), tokenizer)
      for (const event of fixture.events) await runner.applyEvent(event)
      for (const id of ['archive-restore', 'expiry-sweep']) {
        await runner.readProbe(fixture.probes.find((probe) => probe.id === id)!, 'full')
      }
      sweptCount = countEpisodes(a.db, { namespace: fixture.namespace })
      restoredCount = archivedCount(a.db)
    } finally {
      a.dispose()
      rmSync(dirA, { recursive: true, force: true })
    }
    // the full arm swept one episode and restored the pruned row
    expect(sweptCount).toBe(7)
    expect(restoredCount).toBe(0)

    // arm B: the same fixture into its own database, untouched by arm A
    const dirB = tempDir()
    const b = await EvalHarness.create({
      seed: SEED,
      vectors: 'fts',
      now: fixture.now,
      tmpDir: dirB,
      keep: true,
    })
    try {
      const runner = new ContinuityRunner(b, fixture, createContinuityLedger(), tokenizer)
      for (const event of fixture.events) await runner.applyEvent(event)
      expect(countEpisodes(b.db, { namespace: fixture.namespace })).toBe(8)
      expect(archivedCount(b.db)).toBe(1)
    } finally {
      b.dispose()
      rmSync(dirB, { recursive: true, force: true })
      resetTokenizerForTests()
    }
  }, 120_000)

  it('separates each arm\'s own probe actions from the ingest it replays', async () => {
    const { run } = await runInOrder(['full', 'single-layer', 'memory-off'])
    const full = run.arms.find((arm) => arm.arm === 'full')!
    const single = run.arms.find((arm) => arm.arm === 'single-layer')!
    const off = run.arms.find((arm) => arm.arm === 'memory-off')!
    // the full arm restores the pruned row and sweeps the expired episode; those are its
    // own actions, not seeding, and no other arm performs them
    expect(Object.keys(full.probeOps).sort()).toEqual(['episode_sweep', 'unarchive'])
    expect(single.probeOps).toEqual({})
    expect(off.probeOps).toEqual({})
    // every arm that ingests replays the whole fixture into its own database
    expect(full.ingestOps.episode_items).toBe(8)
    expect(single.ingestOps.episode_items).toBe(8)
    expect(off.ingestOps).toEqual({})
    expect(full.ingestOps).not.toHaveProperty('unarchive')
    expect(full.ingestOps).not.toHaveProperty('episode_sweep')
  }, 180_000)
})

describe('continuity cli', () => {
  it('accepts --suite continuity, writes a report pair and gates nothing unrecorded', () => {
    const outDir = tempDir('engram-continuity-cli-')
    const home = tempDir('engram-continuity-home-')
    const thresholdsPath = join(REPO_ROOT, 'eval', 'thresholds.json')
    const thresholdsBefore = readFileSync(thresholdsPath, 'utf8')
    // a minimal allowlisted environment: no inherited gateway variables, a temporary
    // home directory, embeddings off, no credential file anywhere the run could reach
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TMPDIR: outDir,
      ENGRAM_EMBEDDINGS: 'off',
      LOG_LEVEL: 'error',
      NODE_ENV: 'test',
    }
    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(REPO_ROOT, 'eval', 'run.ts'),
        '--suite',
        'continuity',
        '--out',
        outDir,
        '--quiet',
        '--json',
        '--assert',
      ],
      { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 240_000 }
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('"suite": "continuity"')
    // no continuity entry is recorded in thresholds.json yet, so --assert has nothing to
    // gate; the suite must not write its own score into the gate from the same run
    expect(result.stdout).toContain('0 threshold(s) checked')
    const files = readdirSync(outDir)
    const json = files.find((file) => file.startsWith('continuity-') && file.endsWith('.json'))
    const markdown = files.find((file) => file.startsWith('continuity-') && file.endsWith('.md'))
    expect(json, files.join(', ')).toBeTruthy()
    expect(markdown).toBeTruthy()
    const artifact = JSON.parse(readFileSync(join(outDir, json!), 'utf8')) as {
      suite: string
      metrics: Record<string, unknown>
    }
    expect(artifact.suite).toBe('continuity')
    expect(artifact.metrics['full']).toBeTruthy()
    expect(readFileSync(thresholdsPath, 'utf8')).toBe(thresholdsBefore)
    expect(existsSync(join(home, '.engram-eval.env'))).toBe(false)
  }, 300_000)
})
