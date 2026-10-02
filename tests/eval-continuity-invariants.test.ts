import { describe, expect, it } from 'vitest'
import { buildContinuityFixture } from '../eval/lib/continuity-corpus.js'
import { ContinuityRunner, createContinuityLedger } from '../eval/lib/continuity-runner.js'
import { scoreContinuityCase, summarizeContinuityArm, type ContinuityCaseResult } from '../eval/lib/continuity-score.js'
import { EvalHarness } from '../eval/lib/harness.js'
import { resolveTokenizer } from '../eval/lib/metrics.js'
import { buildHeader } from '../eval/lib/report.js'
import { buildThresholds, evaluateThresholds } from '../eval/lib/thresholds.js'
import { runContinuitySuite } from '../eval/suites/continuity.js'

describe('continuity safety invariants', () => {
  it('never gives safety findings a regression margin', () => {
    const names = [
      'namespaceLeakRate', 'futureLeakRate', 'safetyViolations',
      'producerUnderreports', 'budgetViolations',
      'asOfLeakRate',
    ]
    const baseline = { ...Object.fromEntries(names.map((name) => [name, 0])), passRate: 1 }
    const file = buildThresholds({ suites: { continuity: { 'baseline/full': baseline } }, margin: 0.1 })
    for (const name of names) {
      expect(file.suites.continuity['baseline/full'][name], name).toBe(0)
      const checked = evaluateThresholds(file, {
        continuity: { 'baseline/full': { ...baseline, [name]: 0.01 } },
      })
      expect(checked.failures.map((failure) => failure.metric)).toContain(name)
    }
    expect(file.suites.continuity['baseline/full'].passRate).toBe(0.9)
  })

  it('derives metric eligibility from checks rather than fixture probe names', async () => {
    const output = await runContinuitySuite({
      seed: 1234,
      vectors: 'fts',
      configs: [['baseline', {}]],
      outDir: '/tmp',
      gitSha: 'inert-fixture',
      log: () => {},
      buildHeader: (input) => buildHeader(input),
    })
    const detail = output.result.details[0] as { cases: ContinuityCaseResult[] }
    const cases = detail.cases.filter((entry) => entry.arm === 'full')
    const ledger = createContinuityLedger()
    const before = summarizeContinuityArm(cases, 'full', ledger)
    const after = summarizeContinuityArm(
      cases.map((entry) => ({ ...entry, probe_id: `renamed-${entry.probe_id}` })), 'full', ledger
    )
    expect(after.denominators).toEqual(before.denominators)
    expect(after.coverage).toBe(before.coverage)
    expect(after.citationCoverage).toBe(before.citationCoverage)
    expect(after.staleCaseRate).toBe(before.staleCaseRate)
    expect(after.distractorRate).toBe(before.distractorRate)
  })

  it('checks a close-summary citation against the checkpoint even without its episode text', async () => {
    const { fixture, gold } = buildContinuityFixture(1234)
    const harness = await EvalHarness.create({ seed: 1234, vectors: 'fts', now: fixture.now })
    const ledger = createContinuityLedger()
    const runner = new ContinuityRunner(harness, fixture, ledger, await resolveTokenizer())
    try {
      for (const event of fixture.events) await runner.applyEvent(event)
      const probe = fixture.probes.find((entry) => entry.id === 'close-summary')!
      const initial = await runner.readProbe(probe, 'full')
      const citation = initial.citations![0]!
      expect(citation).toBeDefined()
      const episode = ledger.episodeByExternal.get(citation.external_id)!
      expect(episode).toBeDefined()
      const provenance = ledger.provenance.get(episode.id)!
      // counterfactual provenance: the delivered pointer would refer to a future row
      ledger.provenance.set(episode.id, { ...provenance, seq: probe.after_seq + 1 })
      const read = await runner.readProbe(probe, 'full')
      expect(read.citations?.some((entry) => entry.external_id === citation.external_id)).toBe(true)
      const scored = scoreContinuityCase(read, probe, gold.find((entry) => entry.probe_id === probe.id)!)
      expect(scored.future_leaks).toBe(1)
      expect(scored.safety_failed).toBe(true)
      expect(scored.status).toBe('fail')
    } finally {
      harness.dispose()
    }
  })
})
