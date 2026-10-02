// continuity scorer: gold in, verdicts out. this is the only module that sees the
// fixture's answers, evidence ids and forbidden values; the controller (continuity-runner)
// never receives them. a case is scored against the checks its gold names, plus two
// implicit invariants — the payload must respect the budget it was given and must not
// serve a row written after the probe's checkpoint. the denominator behind every rate is
// carried in the arm metrics, so a number cannot be read without the count it stands on.
import { round3 } from './metrics.js'
import type { TableSpec } from './report.js'
import type { ContinuityArm, ContinuityFamily, ContinuityGold, ContinuityProbe } from './continuity-corpus.js'
import type { ContinuityLedger, PricedRead } from './continuity-runner.js'

export type ContinuityStatus = 'pass' | 'fail' | 'insufficient-budget'

export interface ContinuityCaseResult {
  probe_id: string
  arm: ContinuityArm
  family: ContinuityFamily
  checkpoint: string
  action: string
  status: ContinuityStatus
  /** false for an insufficient-budget case: reported, never counted as a result */
  scored: boolean
  /**
   * true/false for a check the payload could answer, null when the gold gives it nothing
   * to stand on. null is not a pass: a required null fails the case, and the implicit
   * invariants fail only on an explicit false.
   */
  checks: Record<string, boolean | null>
  failed_checks: string[]
  /** the checks the gold requires that the payload did not satisfy */
  missing_required: string[]
  insufficient: boolean
  served: number
  /** characters the payload actually delivered, recomputed from the context */
  delivered_chars: number
  /** the budgeted producer's own claim, null when the read carried none */
  reported_used_chars: number | null
  /** true when the producer's own section is longer than the budget it claimed */
  producer_underreport: boolean
  /** what one cap did to a composed payload, null for a single-surface read */
  composed: {
    cap: number
    primaryChars: number
    extrasChars: number
    dropped: string[]
    truncated: boolean
  } | null
  served_tokens: number
  future_leaks: number
  namespace_leaks: number
  stale_served: number
  distractor_served: boolean
  budget: PricedRead['budget']
  /** the safety axis: did the delivered payload respect the probe's cap */
  budget_claim: 'respected' | 'violated'
  /**
   * safety findings, counted whether or not the case is scored: a budget overflow, a
   * served row written after the checkpoint, a row from another namespace, or a producer
   * whose own accounting under-reported what it delivered
   */
  violations: string[]
  safety_failed: boolean
  budget_report: {
    respected: boolean
    accounted: boolean
    reported_used_chars: number | null
    delivered_chars: number
    gap: number | null
    reported_cut: boolean | null
  }
  latency_ms: number
}

export interface ContinuityFamilyMetrics {
  cases: number
  scored: number
  pass: number
  fail: number
  insufficient: number
  passRate: number
}

export interface ContinuityArmMetrics {
  arm: ContinuityArm
  /** what this arm consults, for the report */
  reads: string
  cases: number
  scored: number
  pass: number
  fail: number
  insufficient: number
  passRate: number
  coverage: number
  citationCoverage: number
  namespaceLeakRate: number
  staleRate: number
  staleCaseRate: number
  distractorRate: number
  futureLeakRate: number
  budgetViolations: number
  budgetReportedRate: number
  resumeAccuracy: number
  correctionAccuracy: number
  evidenceAccuracy: number
  namespaceAccuracy: number
  archiveRestoreAccuracy: number
  expiryAccuracy: number
  budgetAccuracy: number
  servedItems: number
  servedChars: number
  servedTokens: number
  tokensPerChar: number
  /** a safety finding anywhere in this arm, scored or insufficient */
  safetyViolations: number
  safetyViolationRate: number
  producerUnderreports: number
  /** fixture ingest is the arm's seeding cost; a probe action is the arm's own */
  ingestOps: Record<string, number>
  probeOps: Record<string, number>
  readOps: Record<string, number>
  byFamily: Record<string, ContinuityFamilyMetrics>
  /** every rate's denominator, so the number is readable without the code */
  denominators: {
    allCases: number
    scored: number
    evidenceCases: number
    citationCases: number
    forbiddenCases: number
    distractorCases: number
    insufficientCases: number
    servedItems: number
    allServedItems: number
    staleItems: number
    violatingCases: number
  }
}

/** lowercase, whitespace-collapsed: a served line and a gold answer differ only in layout */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function contains(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle))
}

/** the namespace a served row has to sit in: the probe's node, or one below it */
function insideNamespace(namespace: string, probeNamespace: string): boolean {
  return (
    namespace === probeNamespace ||
    namespace.startsWith(`${probeNamespace}/`) ||
    namespace.startsWith(`${probeNamespace}//`)
  )
}

/**
 * score one probe's payload. every check is computed, not just the required ones, so the
 * detail record shows what the arm did answer; `gold.require` decides what a pass means.
 */
export function scoreContinuityCase(
  read: PricedRead,
  probe: ContinuityProbe,
  gold: ContinuityGold
): ContinuityCaseResult {
  const text = read.context.join('\n')
  // the delivered size is recomputed from the context here, independently of the
  // producer's accounting and of whatever the runner wrote into `chars`: a payload is
  // scored on what it delivered, not on what its producer said it delivered
  const deliveredChars = read.context.reduce((n, entry) => n + entry.length, 0)
  const forbidden = gold.forbidden ?? []
  const wanted = [...(gold.memory_ids ?? []), ...(gold.episode_external_ids ?? [])]

  const futureLeaks = read.served.filter(
    (item) => item.seq >= 0 && item.seq > probe.after_seq
  ).length
  const namespaceLeaks = read.served.filter(
    (item) => !insideNamespace(item.namespace, probe.namespace)
  ).length
  const staleServed = read.served.filter((item) =>
    forbidden.some((value) => contains(item.content, value))
  ).length
  const forbiddenInText = forbidden.some((value) => contains(text, value))
  const distractorServed = gold.distractor_value
    ? contains(text, gold.distractor_value)
    : false

  const citations = read.citations ?? []
  const citationWanted = gold.citation?.external_ids ?? []
  const citationMatches = citations.filter((citation) =>
    citationWanted.includes(citation.external_id)
  )

  const fragments = gold.required_fragments ?? []
  const checks: Record<string, boolean | null> = {
    // implicit for every case: the complete delivered payload against the probe's cap,
    // composed surfaces included, whatever the producer's own accounting claims
    budget_respected: deliveredChars <= probe.budget_chars,
    future_absent: futureLeaks === 0,
    // value and evidence
    answer_served: gold.answer === undefined ? null : contains(text, gold.answer),
    evidence_served:
      wanted.length === 0
        ? null
        : wanted.some((id) => read.served.some((item) => item.local_id === id)),
    forbidden_absent: forbidden.length === 0 ? null : !forbiddenInText && staleServed === 0,
    distractor_absent: gold.distractor_value === undefined ? null : !distractorServed,
    fragments_present:
      fragments.length === 0 ? null : fragments.every((fragment) => contains(text, fragment)),
    namespace_isolated: namespaceLeaks === 0,
    // state reads: the answer is what the surface has to carry, so no answer means no
    // check; an arm that never read the surface answers false
    state_current_contains:
      gold.answer === undefined
        ? null
        : (read.state?.current ?? []).some((value) => contains(value, gold.answer!)),
    state_prior_contains:
      gold.answer === undefined
        ? null
        : (read.state?.prior ?? []).some((value) => contains(value, gold.answer!)),
    history_contains:
      gold.answer === undefined
        ? null
        : (read.state?.history ?? []).some((value) => contains(value, gold.answer!)),
    // citations
    citation_present:
      citationWanted.length === 0
        ? null
        : citationWanted.every((id) => citationMatches.some((c) => c.external_id === id)),
    citation_correct:
      citationWanted.length === 0
        ? null
        : citationMatches.length === citationWanted.length &&
          citationMatches.every((citation) => citation.source === gold.citation?.source),
    // task / working state
    task_found: read.task?.found === true,
    no_open_task: read.task !== null && read.task.found === false,
    summary_found: read.summary?.found === true,
    summary_served: read.served.some((item) => item.local_id === 'task-summary'),
    // archive
    archive_applied: (read.archive?.archived_ids.length ?? 0) === 1,
    archive_hidden: read.archive?.hidden_from_search === true,
    archive_by_id_hidden: read.archive?.by_id_hidden === true,
    archive_readable_with_flag: read.archive?.by_id_with_archived === true,
    archive_restored: read.archive?.restored === true,
    archive_restored_served: read.archive?.restored_served === true,
    // expiry
    expired_absent_before: read.expiry !== null && read.expiry.expired_served_before === false,
    durable_served_before: read.expiry?.durable_served_before === true,
    sweep_removed_expired: read.expiry?.swept === 1,
    expired_gone_after: read.expiry?.expired_gone_after === true,
    durable_still_served: read.expiry?.durable_still_served === true,
    // budget accounting: the packer's own numbers say what it cut, rather than the
    // caller being told everything fitted
    budget_cut_reported: read.budget === null ? null : budgetCutReported(read),
  }

  const missingRequired = gold.require.filter((name) => checks[name] !== true)
  // the two invariants: a served future row always fails, and so does a payload over its
  // cap — the cap is checked against the delivered context, not the producer's claim
  const implicitMissing: string[] = []
  if (checks.future_absent !== true) implicitMissing.push('future_absent')
  if (checks.budget_respected !== true) implicitMissing.push('budget_respected')
  const failed = [...new Set([...missingRequired, ...implicitMissing])]
  const insufficient = probe.budget_chars < gold.min_chars
  const status: ContinuityStatus = insufficient
    ? 'insufficient-budget'
    : failed.length === 0
      ? 'pass'
      : 'fail'

  // safety findings are independent of the usefulness verdict: an insufficient case is
  // not scored, but a leak, a future row or a budget overflow inside it is still counted
  const violations: string[] = []
  if (checks.budget_respected === false) violations.push('budget_overflow')
  if (futureLeaks > 0) violations.push('future_leak')
  if (namespaceLeaks > 0) violations.push('namespace_leak')
  if (read.producerUnderreport) violations.push('producer_underreport')
  // the producer's claim: what the runner copied off the read, or the read's own budget
  // record when it was constructed without one
  const reportedUsed = read.producerUsedChars ?? read.budget?.used_chars ?? null

  return {
    probe_id: probe.id,
    arm: read.arm,
    family: probe.family,
    checkpoint: probe.checkpoint,
    action: read.action,
    status,
    scored: !insufficient,
    checks,
    failed_checks: failed,
    missing_required: missingRequired,
    insufficient,
    served: read.served.length,
    delivered_chars: deliveredChars,
    reported_used_chars: reportedUsed,
    producer_underreport: read.producerUnderreport,
    composed: read.composer
      ? {
          cap: read.composer.cap,
          primaryChars: read.composer.primaryChars,
          extrasChars: read.composer.extrasChars,
          dropped: [...read.composer.dropped],
          truncated: read.composer.truncated,
        }
      : null,
    served_tokens: read.tokens,
    future_leaks: futureLeaks,
    namespace_leaks: namespaceLeaks,
    stale_served: staleServed,
    distractor_served: distractorServed,
    budget: read.budget,
    budget_claim: checks.budget_respected === true ? 'respected' : 'violated',
    violations,
    safety_failed: violations.length > 0,
    // the independent check is always present; the producer's accounting is what may be
    // absent, and the gap between the two is reported rather than reconciled
    budget_report: {
      respected: checks.budget_respected === true,
      accounted: read.budget !== null,
      reported_used_chars: reportedUsed,
      delivered_chars: deliveredChars,
      gap: reportedUsed === null ? null : deliveredChars - reportedUsed,
      reported_cut:
        read.budget === null || checks.budget_cut_reported === null
          ? null
          : checks.budget_cut_reported === true,
    },
    latency_ms: read.latencyMs,
  }
}

/**
 * did the payload report what it could not fit? either the packer's accounting shows a
 * cut (a dropped memory, a dropped topic, a clipped digest) or nothing was served at
 * all, which is an honest empty answer rather than a silent one.
 */
function budgetCutReported(read: PricedRead): boolean {
  if (read.budget === null) return read.served.length === 0
  const cut =
    read.budget.dropped_memories +
    read.budget.dropped_topics +
    read.budget.digest_chars_cut +
    read.budget.truncated_memories +
    read.budget.truncated_topics
  return cut > 0 || read.served.length === 0
}

/**
 * per-arm rollup. usefulness rates (pass, coverage, citation) stand on the scored cases;
 * every safety rate stands on all cases, so a leak or an overflow inside an
 * insufficient-budget case is counted rather than excluded with it.
 */
export function summarizeContinuityArm(
  cases: ContinuityCaseResult[],
  arm: ContinuityArm,
  ledger: ContinuityLedger
): ContinuityArmMetrics {
  const armCases = cases.filter((entry) => entry.arm === arm)
  const scored = armCases.filter((entry) => entry.scored)
  const pass = scored.filter((entry) => entry.status === 'pass').length
  const fail = scored.filter((entry) => entry.status === 'fail').length
  const insufficient = armCases.filter((entry) => entry.insufficient).length

  const evidenceCases = scored.filter((entry) => applies(entry, 'evidence_served'))
  const citationCases = scored.filter((entry) => applies(entry, 'citation_correct'))
  const forbiddenCases = armCases.filter((entry) => applies(entry, 'forbidden_absent'))
  const distractorCases = armCases.filter((entry) => applies(entry, 'distractor_absent'))

  const servedItems = scored.reduce((sum, entry) => sum + entry.served, 0)
  const servedChars = scored.reduce((sum, entry) => sum + entry.delivered_chars, 0)
  const servedTokens = scored.reduce((sum, entry) => sum + entry.served_tokens, 0)
  // safety counters: every case, scored or not
  const allServedItems = armCases.reduce((sum, entry) => sum + entry.served, 0)
  const staleItems = armCases.reduce((sum, entry) => sum + entry.stale_served, 0)
  const futureItems = armCases.reduce((sum, entry) => sum + entry.future_leaks, 0)
  const namespaceLeaks = armCases.reduce((sum, entry) => sum + entry.namespace_leaks, 0)
  const safetyViolations = armCases.filter((entry) => entry.safety_failed).length
  const producerUnderreports = armCases.filter((entry) => entry.producer_underreport).length

  const byFamily: Record<string, ContinuityFamilyMetrics> = {}
  for (const entry of armCases) {
    const bucket = (byFamily[entry.family] ??= {
      cases: 0,
      scored: 0,
      pass: 0,
      fail: 0,
      insufficient: 0,
      passRate: 0,
    })
    bucket.cases++
    if (entry.scored) bucket.scored++
    if (entry.status === 'pass') bucket.pass++
    if (entry.status === 'fail') bucket.fail++
    if (entry.insufficient) bucket.insufficient++
  }
  for (const bucket of Object.values(byFamily)) {
    bucket.passRate = bucket.scored === 0 ? 0 : round3(bucket.pass / bucket.scored)
  }

  const readOps: Record<string, number> = {}
  for (const [key, value] of Object.entries(ledger.readOps)) {
    const [opArm, op] = key.split('.')
    if (opArm !== arm) continue
    readOps[op] = (readOps[op] ?? 0) + value
  }

  const accuracy = (family: ContinuityFamily): number => {
    const bucket = byFamily[family]
    return bucket ? bucket.passRate : 0
  }

  return {
    arm,
    reads: ARM_READS[arm],
    cases: armCases.length,
    scored: scored.length,
    pass,
    fail,
    insufficient,
    passRate: scored.length === 0 ? 0 : round3(pass / scored.length),
    coverage:
      evidenceCases.length === 0
        ? 0
        : round3(
            evidenceCases.filter((entry) => entry.checks.evidence_served === true).length /
              evidenceCases.length
          ),
    citationCoverage:
      citationCases.length === 0
        ? 0
        : round3(
            citationCases.filter((entry) => entry.checks.citation_correct === true).length /
              citationCases.length
          ),
    namespaceLeakRate: allServedItems === 0 ? 0 : round3(namespaceLeaks / allServedItems),
    staleRate: allServedItems === 0 ? 0 : round3(staleItems / allServedItems),
    staleCaseRate:
      forbiddenCases.length === 0
        ? 0
        : round3(
            forbiddenCases.filter((entry) => entry.stale_served > 0).length /
              forbiddenCases.length
          ),
    distractorRate:
      distractorCases.length === 0
        ? 0
        : round3(
            distractorCases.filter((entry) => entry.distractor_served).length /
              distractorCases.length
          ),
    futureLeakRate: allServedItems === 0 ? 0 : round3(futureItems / allServedItems),
    // a payload over its cap is a violation wherever it appears; an insufficient case is
    // not scored for usefulness but its overflow still counts here
    budgetViolations: armCases.filter((entry) => entry.checks.budget_respected === false).length,
    safetyViolations,
    safetyViolationRate: armCases.length === 0 ? 0 : round3(safetyViolations / armCases.length),
    producerUnderreports,
    budgetReportedRate:
      insufficient === 0
        ? 0
        : round3(
            armCases.filter(
              (entry) =>
                entry.insufficient &&
                entry.budget_report?.respected === true &&
                entry.budget_report?.reported_cut === true
            ).length / insufficient
          ),
    resumeAccuracy: accuracy('resume'),
    correctionAccuracy: accuracy('correction'),
    evidenceAccuracy: accuracy('evidence'),
    namespaceAccuracy: accuracy('namespace'),
    archiveRestoreAccuracy: accuracy('archive'),
    expiryAccuracy: accuracy('expiry'),
    budgetAccuracy: accuracy('budget'),
    servedItems,
    servedChars,
    servedTokens,
    tokensPerChar: servedChars === 0 ? 0 : round3(servedTokens / servedChars),
    // ingest is this arm's seeding cost (every arm now replays the fixture into its own
    // store); a probe action is the arm's own restore or sweep, kept separate so a
    // mutating probe cannot look like ingest
    ingestOps: { ...ledger.ingestOps },
    probeOps: { ...ledger.probeOps },
    readOps,
    byFamily,
    denominators: {
      allCases: armCases.length,
      scored: scored.length,
      evidenceCases: evidenceCases.length,
      citationCases: citationCases.length,
      forbiddenCases: forbiddenCases.length,
      distractorCases: distractorCases.length,
      insufficientCases: insufficient,
      // the usefulness denominators stand on scored cases; the safety ones on every case
      servedItems,
      allServedItems,
      staleItems,
      violatingCases: safetyViolations,
    },
  }
}

/**
 * a gold-backed check is boolean only when its gold defines a case. unread surfaces
 * return false rather than null, so eligibility travels with the scored record and
 * does not depend on a second list of probe names.
 */
function applies(entry: ContinuityCaseResult, check: string): boolean {
  return typeof entry.checks[check] === 'boolean'
}

export const ARM_READS: Record<ContinuityArm, string> = {
  full: 'state slots + memories + raw-episode evidence + task briefs, each under the probe budget',
  'single-layer': 'the memories layer only (recall_context), under the same budget',
  'memory-off': 'the same controller over an empty isolated store (negative control)',
}

/**
 * the flat threshold/comparison view of an arm's metrics. every name here is recorded by
 * `--suite all --write-thresholds`, and the rates that must not move gate from above with
 * no margin.
 */
export function continuityFlatMetrics(metrics: ContinuityArmMetrics): Record<string, number> {
  return {
    passRate: metrics.passRate,
    coverage: metrics.coverage,
    citationCoverage: metrics.citationCoverage,
    namespaceLeakRate: metrics.namespaceLeakRate,
    staleRate: metrics.staleRate,
    staleCaseRate: metrics.staleCaseRate,
    distractorRate: metrics.distractorRate,
    futureLeakRate: metrics.futureLeakRate,
    budgetViolations: metrics.budgetViolations,
    safetyViolations: metrics.safetyViolations,
    producerUnderreports: metrics.producerUnderreports,
    budgetReportedRate: metrics.budgetReportedRate,
    resumeAccuracy: metrics.resumeAccuracy,
    correctionAccuracy: metrics.correctionAccuracy,
    evidenceAccuracy: metrics.evidenceAccuracy,
    namespaceAccuracy: metrics.namespaceAccuracy,
    archiveRestoreAccuracy: metrics.archiveRestoreAccuracy,
    expiryAccuracy: metrics.expiryAccuracy,
    budgetAccuracy: metrics.budgetAccuracy,
    servedTokens: metrics.servedTokens,
  }
}

export function renderContinuityArmsTable(arms: ContinuityArmMetrics[]): TableSpec {
  return {
    columns: [
      'arm',
      'cases',
      'scored',
      'pass',
      'fail',
      'insuff',
      'passRate',
      'coverage',
      'citation',
      'leakRate',
      'staleRate',
      'distractor',
      'futureLeak',
      'budgetViol',
      'safetyViol',
      'acctUnder',
      'budgetReported',
      'servedTokens',
    ],
    rows: arms.map((arm) => [
      arm.arm,
      arm.cases,
      arm.scored,
      arm.pass,
      arm.fail,
      arm.insufficient,
      arm.passRate,
      arm.coverage,
      arm.citationCoverage,
      arm.namespaceLeakRate,
      arm.staleRate,
      arm.distractorRate,
      arm.futureLeakRate,
      arm.budgetViolations,
      arm.safetyViolations,
      arm.producerUnderreports,
      arm.budgetReportedRate,
      arm.servedTokens,
    ]),
  }
}

export function renderContinuityFamilyTable(arms: ContinuityArmMetrics[]): TableSpec {
  const families = [...new Set(arms.flatMap((arm) => Object.keys(arm.byFamily)))].sort()
  const rows: Array<Array<string | number>> = []
  for (const family of families) {
    for (const arm of arms) {
      const bucket = arm.byFamily[family]
      if (!bucket) continue
      rows.push([
        family,
        arm.arm,
        bucket.cases,
        bucket.scored,
        bucket.pass,
        bucket.fail,
        bucket.insufficient,
        bucket.passRate,
      ])
    }
  }
  return {
    columns: ['family', 'arm', 'cases', 'scored', 'pass', 'fail', 'insuff', 'passRate'],
    rows,
  }
}
