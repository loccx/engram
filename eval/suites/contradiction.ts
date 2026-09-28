// contradiction suite: adjudication quality, with the false-supersession rate called
// out. two stages, because they fail for different reasons. the candidate stage is
// offline and always real: findContradictionCandidates runs on each incoming memory and
// the suite records whether the labelled partner surfaced, and at what rank. it is
// recall-oriented on purpose — the finder is supposed to return topically similar rows,
// so adjudication is what filters them.
// the adjudication stage takes relation + confidence per candidate from the gateway or a
// recorded verdicts file and sweeps thresholds 0.50 → 0.99. a duplicate is allowed by
// policy and reported on its own, never counted as a precision error.
// without a gateway and without --verdicts the block reports unavailable and the run
// still exits 0, as longmemeval --qa does.
import { readFileSync } from 'node:fs'
import { EvalHarness } from '../lib/harness.js'
import { buildCorpus } from '../lib/corpus.js'
import { corpusHash, f1, mean, resolveTokenizer, round3, summarizeLatencies } from '../lib/metrics.js'
import { applyFeatureFlags, type RetrievalConfigPatch } from '../lib/registry.js'
import { markdownTable, renderTimings } from '../lib/report.js'
import { gatewayStatus, qaUnavailableReason } from '../lib/llm.js'
import { findContradictionCandidates, type Candidate } from '../../src/contradictions/candidates.js'
import { judgeCandidates } from '../../src/contradictions/judge.js'
import { SUPERSEDES_THRESHOLD } from '../../src/contradictions/adjudicator.js'
import { getEmbedding } from '../../src/embeddings/pipeline.js'
import type { Memory } from '../../src/memory/types.js'
import type { LabelledPair, PairRelation, TimingSummary } from '../lib/types.js'
import type { SuiteContext, SuiteOutput } from './types.js'

export const SWEEP_START = 0.5
export const SWEEP_STOP = 0.99
export const SWEEP_STEP = 0.01

/** the relations the adjudicator treats as a supersession */
const SUPERSEDING_RELATIONS: ReadonlySet<string> = new Set(['contradicts', 'updates', 'duplicate'])
/** a supersession is required here: the ground-truth positives */
const MUST_SUPERSEDE: ReadonlySet<string> = new Set(['contradicts', 'updates'])

export interface PairCandidateResult {
  pair_id: string
  relation: PairRelation
  found: boolean
  rank: number | null
  candidate_count: number
  /** how the candidate was found: vec, fts or both */
  sources: string[]
}

export interface PairVerdict {
  pair_id: string
  relation: string
  confidence: number
  reason: string
}

export interface ThresholdRow {
  threshold: number
  superseded: number
  truePositives: number
  falsePositives: number
  falseNegatives: number
  duplicatesSuperseded: number
  precision: number
  recall: number
  f1: number
  falseSupersessionRate: number
  duplicateSupersessionRate: number
}

export async function runContradictionSuite(ctx: SuiteContext): Promise<SuiteOutput> {
  const corpus = buildCorpus('contradiction', ctx.seed)
  const pairs = corpus.pairs ?? []
  const tokenizer = await resolveTokenizer()
  const hash = corpusHash(corpus)
  const notes: string[] = []
  const metrics: Record<string, unknown> = {}
  const timings: Record<string, TimingSummary> = {}
  const thresholds: Record<string, Record<string, number>> = {}
  const details: unknown[] = []
  const featureFlags: Record<string, string> = {}

  const harness = await EvalHarness.create({ seed: ctx.seed, vectors: ctx.vectors })
  const store = harness.store

  try {
    const seedStats = await harness.seedCorpus(corpus)
    notes.push(
      `${corpus.name}: ${corpus.memories.length} memories ` +
        `(${seedStats.viaTool} via store_memory, ${seedStats.raw} raw-insert), ${pairs.length} labelled pairs, ` +
        `placement verified=${seedStats.placementVerified}`
    )
    if (!seedStats.placementVerified) {
      notes.push(`PLACEMENT MISMATCHES: ${seedStats.placementMismatches.slice(0, 5).join(' | ')}`)
    }

    // verdicts are cached across configs: the judge is the expensive stage and
    // a config's search patch cannot influence it. A config's *flags* can (they
    // gate the candidate finder), so the candidate stage re-runs per config.
    const verdictCache = new Map<string, PairVerdict>()
    const emptyVerdicts = new Map<string, PairVerdict>()

    for (const [configName, patch] of ctx.configs) {
      const flags = applyFeatureFlags(patch.features)
      featureFlags[configName] = JSON.stringify(patch.features ?? {})
      try {
        const candidateStage = await runCandidateStage(harness, store, pairs)
        const adjudicationStage = await runAdjudicationStage(ctx, {
          harness,
          store,
          pairs,
          candidateResults: candidateStage.results,
          cache: verdictCache,
          notes,
          timings,
        })

        const sweep = adjudicationStage.verdicts.length > 0
          ? sweepThresholds(pairs, adjudicationStage.verdicts)
          : []
        const operatingPoint = sweep.find(
          (row) => Math.abs(row.threshold - SUPERSEDES_THRESHOLD) < 1e-9
        )

        timings['candidate-generation'] = summarizeLatencies(candidateStage.latencies)
        metrics[configName] = {
          pairs: pairs.length,
          byRelation: candidateStage.byRelationTotals,
          candidateStage: {
            candidateRecall: candidateStage.candidateRecall,
            candidateRecallByRelation: candidateStage.byRelationFound,
            byRelationTotals: candidateStage.byRelationTotals,
            meanCandidates: round3(mean(candidateStage.results.map((r) => r.candidate_count))),
            found: candidateStage.results.filter((r) => r.found).length,
            missing: candidateStage.results.filter((r) => !r.found).map((r) => r.pair_id),
            perPair: candidateStage.results,
          },
          adjudication: {
            status: adjudicationStage.status,
            model: adjudicationStage.model,
            promptVersion: adjudicationStage.status === 'llm' ? 'contradiction-v1' : '',
            verdicts: adjudicationStage.verdicts.length,
            judgeFailures: adjudicationStage.failures,
            judgeCalls: adjudicationStage.calls,
            shippedThreshold: SUPERSEDES_THRESHOLD,
            atShippedThreshold: operatingPoint ?? null,
            sweep,
            meanConfidenceByRelation: computeMeanConfidence(adjudicationStage.verdicts, pairs),
            ...(adjudicationStage.status === 'unavailable'
              ? { note: qaUnavailableReason() }
              : {}),
          },
        }
        thresholds[configName] = {
          candidateRecall: candidateStage.candidateRecall,
          ...(operatingPoint
            ? {
                precision: operatingPoint.precision,
                recall: operatingPoint.recall,
                falseSupersessionRate: operatingPoint.falseSupersessionRate,
                duplicateSupersessionRate: operatingPoint.duplicateSupersessionRate,
              }
            : {}),
        }
        details.push({
          config: configName,
          candidateResults: candidateStage.results,
          verdicts: adjudicationStage.verdicts,
          sweep,
        })

        const markdown = renderContradictionMarkdown({
          pairs: pairs.length,
          byRelation: candidateStage.byRelationTotals,
          candidateRecall: candidateStage.candidateRecall,
          candidateMean: round3(mean(candidateStage.results.map((r) => r.candidate_count))),
          missing: candidateStage.results.filter((r) => !r.found).map((r) => r.pair_id),
          sweep,
          status: adjudicationStage.status,
          judgeModel: adjudicationStage.model,
          judgeCalls: adjudicationStage.calls,
          timings,
          meanConfidenceByRelation: computeMeanConfidence(adjudicationStage.verdicts, pairs),
        })

        return {
          result: {
            suite: 'contradiction',
            header: ctx.buildHeader({
              suite: 'contradiction',
              configs: ctx.configs.map(([name]) => name),
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
            notes: [...notes, verdictDefinitionNote()],
          },
          markdown,
          thresholds,
        }
      } finally {
        flags.restore()
      }
    }

    // unreachable: resolveConfigs() always yields at least the baseline
    throw new Error('contradiction suite: no configs resolved')
    void emptyVerdicts
  } finally {
    harness.dispose()
  }
}

async function runCandidateStage(
  harness: EvalHarness,
  store: ReturnType<EvalHarness['store'] extends never ? never : () => never> | {
    getById(id: string): Memory | null
  },
  pairs: LabelledPair[]
): Promise<{
  results: PairCandidateResult[]
  latencies: number[]
  candidateRecall: number
  byRelationTotals: Record<string, number>
  byRelationFound: Record<string, number>
}> {
  const results: PairCandidateResult[] = []
  const latencies: number[] = []
  const byRelationTotals: Record<string, number> = {}
  const byRelationFound: Record<string, number> = {}

  for (const pair of pairs) {
    const newId = seedIdOrThrow(harness, pair, 'new_id')
    const candidateId = seedIdOrThrow(harness, pair, 'candidate_id')
    const incoming = store.getById(newId)
    if (!incoming) throw new Error(`missing seeded memory for pair ${pair.id}`)
    const embedding = harness.vectorsAvailable
      ? await getEmbedding(incoming.content, 'document')
      : null

    const start = performance.now()
    const candidates: Candidate[] = findContradictionCandidates(
      harness.db,
      {
        namespace: pair.namespace,
        excludeMemoryId: newId,
        embedding,
        contentForFts: incoming.content,
        vectorsAvailable: harness.vectorsAvailable,
      },
      {}
    )
    latencies.push(performance.now() - start)

    const rank = candidates.findIndex((c) => c.memory.id === candidateId)
    byRelationTotals[pair.relation] = (byRelationTotals[pair.relation] ?? 0) + 1
    if (rank >= 0) byRelationFound[pair.relation] = (byRelationFound[pair.relation] ?? 0) + 1
    results.push({
      pair_id: pair.id,
      relation: pair.relation,
      found: rank >= 0,
      rank: rank >= 0 ? rank + 1 : null,
      candidate_count: candidates.length,
      sources: candidates.map((c) => c.source),
    })
  }

  const mustSurface = pairs.filter((p) => MUST_SUPERSEDE.has(p.relation))
  const found = results.filter((r) => MUST_SUPERSEDE.has(r.relation) && r.found)
  return {
    results,
    latencies,
    candidateRecall: round3(mustSurface.length === 0 ? 0 : found.length / mustSurface.length),
    byRelationTotals,
    byRelationFound,
  }
}

interface AdjudicationStageInput {
  harness: EvalHarness
  store: { getById(id: string): Memory | null }
  pairs: LabelledPair[]
  candidateResults: PairCandidateResult[]
  cache: Map<string, PairVerdict>
  notes: string[]
  timings: Record<string, TimingSummary>
}

interface AdjudicationStageResult {
  status: 'llm' | 'recorded' | 'unavailable'
  verdicts: PairVerdict[]
  model: string
  failures: number
  calls: number
}

async function runAdjudicationStage(
  ctx: SuiteContext,
  input: AdjudicationStageInput
): Promise<AdjudicationStageResult> {
  const { harness, store, pairs, candidateResults, cache, notes, timings } = input

  if (ctx.verdictsPath) {
    const recorded = readRecordedVerdicts(ctx.verdictsPath)
    const verdicts: PairVerdict[] = []
    let missing = 0
    for (const pair of pairs) {
      const hit = recorded.get(pair.id)
      if (hit) verdicts.push({ pair_id: pair.id, ...hit })
      else missing++
    }
    notes.push(
      `adjudication: recorded verdicts from ${ctx.verdictsPath} ` +
        `(${verdicts.length}/${pairs.length} pairs covered${missing > 0 ? `, ${missing} missing` : ''})`
    )
    return { status: 'recorded', verdicts, model: '', failures: missing, calls: 0 }
  }

  if (!gatewayStatus().configured) {
    notes.push(qaUnavailableReason())
    return { status: 'unavailable', verdicts: [], model: '', failures: 0, calls: 0 }
  }

  const status = gatewayStatus()
  notes.push(`gateway: configured (host ${status.host}, model ${status.model})`)
  const verdicts: PairVerdict[] = []
  const callLatencies: number[] = []
  let failures = 0
  let model = status.model

  for (const pair of pairs) {
    const cached = cache.get(pair.id)
    if (cached) {
      verdicts.push(cached)
      continue
    }
    const newId = seedIdOrThrow(harness, pair, 'new_id')
    const candidateId = seedIdOrThrow(harness, pair, 'candidate_id')
    const incoming = store.getById(newId)
    const existing = store.getById(candidateId)
    if (!incoming || !existing) {
      failures++
      continue
    }
    const start = performance.now()
    try {
      const result = await judgeCandidates({
        newMemory: {
          id: incoming.id,
          content: incoming.content,
          created_at: incoming.created_at,
          type: incoming.type,
        },
        candidates: [buildLabelledCandidate(existing, pair, candidateResults)],
      })
      callLatencies.push(performance.now() - start)
      const verdict = result.verdicts[0]
      if (!verdict) {
        failures++
        continue
      }
      model = result.model
      const entry: PairVerdict = {
        pair_id: pair.id,
        relation: verdict.relation,
        confidence: verdict.confidence,
        reason: verdict.reason,
      }
      verdicts.push(entry)
      cache.set(pair.id, entry)
    } catch (e) {
      callLatencies.push(performance.now() - start)
      failures++
      notes.push(
        `judge failed for ${pair.id}: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  if (callLatencies.length > 0) timings['judge-calls'] = summarizeLatencies(callLatencies)

  if (verdicts.length === 0) {
    notes.push('every judge call failed; adjudication metrics reported as unavailable')
    return { status: 'unavailable', verdicts, model, failures, calls: callLatencies.length }
  }
  notes.push(
    `adjudication: live judge (${verdicts.length} verdicts, ${failures} failures) — ` +
      'the candidate set per pair is the single labelled partner, so the sweep measures ' +
      'relation+confidence, not candidate selection'
  )
  return { status: 'llm', verdicts, model, failures, calls: callLatencies.length }
}

/**
 * the judged candidate for a pair is the labelled partner. the whole candidate list would
 * mix in rows with no labelled relation, where a fabricated supersession looks exactly
 * like a real error. candidate selection is scored separately, in stage one.
 */
function buildLabelledCandidate(
  memory: Memory,
  pair: LabelledPair,
  candidateResults: PairCandidateResult[]
): Candidate {
  const observed = candidateResults.find((r) => r.pair_id === pair.id)
  const source = observed?.sources[0] ?? 'fts'
  return {
    memory,
    source: source === 'vec' || source === 'both' ? source : 'fts',
  }
}

function verdictDefinitionNote(): string {
  return (
    'Definitions: predicted supersession at t = relation in {contradicts, updates, duplicate} and ' +
    'confidence >= t; ground-truth positive = {contradicts, updates}; falseSupersessionRate(t) is ' +
    'the share of {unrelated} pairs superseded at t; duplicateSupersessionRate(t) is reported ' +
    `separately because adjudicator.ts:164 supersedes duplicates by design. Shipped point: ${SUPERSEDES_THRESHOLD}.`
  )
}

/**
 * either `[{pair_id, relation, confidence}]`, `{verdicts: [...]}`, or a map from pair_id
 * to `{relation, confidence}`
 */
export function readRecordedVerdicts(path: string): Map<string, Omit<PairVerdict, 'pair_id'>> {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const out = new Map<string, Omit<PairVerdict, 'pair_id'>>()
  const push = (pairId: string, relation: unknown, confidence: unknown, reason: unknown): void => {
    out.set(pairId, {
      relation: typeof relation === 'string' ? relation : 'unrelated',
      confidence: typeof confidence === 'number' ? confidence : 0,
      reason: typeof reason === 'string' ? reason : '',
    })
  }
  const fromArray = (list: unknown[]): void => {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const pairId = String(record.pair_id ?? record.pairId ?? record.id ?? '')
      if (pairId) push(pairId, record.relation, record.confidence, record.reason)
    }
  }

  if (Array.isArray(raw)) {
    fromArray(raw)
  } else if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    if (Array.isArray(record.verdicts)) {
      fromArray(record.verdicts)
    } else {
      for (const [pairId, value] of Object.entries(record)) {
        if (!value || typeof value !== 'object') continue
        const entry = value as Record<string, unknown>
        push(pairId, entry.relation, entry.confidence, entry.reason)
      }
    }
  }

  if (out.size === 0) {
    throw new Error(
      `verdicts file ${path} contained no usable verdicts — expected {verdicts:[{pair_id, relation, confidence}]} or {pair_id: {relation, confidence}}`
    )
  }
  return out
}

/** every confidence threshold in the sweep, low to high */
export function sweepThresholds(pairs: LabelledPair[], verdicts: PairVerdict[]): ThresholdRow[] {
  const byPair = new Map(verdicts.map((v) => [v.pair_id, v]))
  const rows: ThresholdRow[] = []
  for (let t = SWEEP_START; t <= SWEEP_STOP + 1e-9; t = round2(t + SWEEP_STEP)) {
    const threshold = round2(t)
    let truePositives = 0
    let falsePositives = 0
    let falseNegatives = 0
    let duplicatesSuperseded = 0
    let duplicates = 0
    let unrelated = 0
    let superseded = 0

    for (const pair of pairs) {
      const verdict = byPair.get(pair.id)
      const predicted =
        verdict !== undefined &&
        SUPERSEDING_RELATIONS.has(verdict.relation) &&
        verdict.confidence >= threshold
      if (predicted) superseded++
      if (pair.relation === 'duplicate') {
        duplicates++
        if (predicted) duplicatesSuperseded++
        continue
      }
      if (pair.relation === 'unrelated') {
        unrelated++
        if (predicted) falsePositives++
        continue
      }
      if (predicted) truePositives++
      else falseNegatives++
    }

    const precision =
      truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives)
    const recall =
      truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives)
    rows.push({
      threshold,
      superseded,
      truePositives,
      falsePositives,
      falseNegatives,
      duplicatesSuperseded,
      precision: round3(precision),
      recall: round3(recall),
      f1: round3(f1(precision, recall)),
      falseSupersessionRate: round3(unrelated === 0 ? 0 : falsePositives / unrelated),
      duplicateSupersessionRate: round3(duplicates === 0 ? 0 : duplicatesSuperseded / duplicates),
    })
  }
  return rows
}

function computeMeanConfidence(
  verdicts: PairVerdict[],
  pairs: LabelledPair[]
): Record<string, number> {
  const relationByPair = new Map(pairs.map((p) => [p.id, p.relation]))
  const buckets = new Map<string, number[]>()
  for (const verdict of verdicts) {
    const label = relationByPair.get(verdict.pair_id) ?? 'unknown'
    const list = buckets.get(label) ?? []
    list.push(verdict.confidence)
    buckets.set(label, list)
  }
  const out: Record<string, number> = {}
  for (const [label, values] of [...buckets.entries()].sort()) {
    out[label] = round3(mean(values))
  }
  return out
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function seedIdOrThrow(
  harness: EvalHarness,
  pair: LabelledPair,
  field: 'new_id' | 'candidate_id'
): string {
  const local = pair[field]
  const dbId = harness.seedIdOf(local)
  if (!dbId) throw new Error(`pair ${pair.id}: ${field} "${local}" was not seeded`)
  return dbId
}

export function renderContradictionMarkdown(input: {
  pairs: number
  byRelation: Record<string, number>
  candidateRecall: number
  candidateMean: number
  missing: string[]
  sweep: ThresholdRow[]
  status: string
  judgeModel: string
  judgeCalls: number
  timings: Record<string, TimingSummary>
  meanConfidenceByRelation: Record<string, number>
}): string {
  const sections: string[] = []
  sections.push(
    `Labelled pairs: ${input.pairs} (${Object.entries(input.byRelation)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}).`
  )
  sections.push(
    '### stage 1 — candidate generation (offline, no LLM)\n\n' +
      markdownTable({
        columns: ['metric', 'value'],
        rows: [
          ['candidateRecall (contradicts/updates partner surfaced)', input.candidateRecall],
          ['mean candidates returned per incoming memory', input.candidateMean],
          ['partners never surfaced', input.missing.length],
        ],
      }) +
      (input.missing.length > 0 ? `\n\nNot surfaced: ${input.missing.join(', ')}` : '')
  )

  if (input.sweep.length === 0) {
    sections.push(
      `### stage 2 — adjudication\n\n_adjudication: ${input.status}._ ` +
        'Configure a gateway or pass `--verdicts <file>` with recorded verdicts to populate the ' +
        'threshold sweep. The candidate-stage numbers above are real either way.'
    )
  } else {
    const shown = input.sweep.filter((row) =>
      [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99].includes(row.threshold)
    )
    sections.push(
      `### stage 2 — adjudication at each confidence threshold (${input.status}${
        input.judgeModel ? `, model ${input.judgeModel}` : ''
      }, ${input.judgeCalls} judge calls)\n\n` +
        markdownTable({
          columns: [
            'threshold',
            'superseded',
            'precision',
            'recall',
            'f1',
            'falseSupersessionRate',
            'duplicateSupersessionRate',
          ],
          rows: shown.map((row) => [
            row.threshold,
            row.superseded,
            row.precision,
            row.recall,
            row.f1,
            row.falseSupersessionRate,
            row.duplicateSupersessionRate,
          ]),
        }) +
        `\n\nAll ${input.sweep.length} sweep points (0.50 -> 0.99) are in the JSON artifact. ` +
        `The row at ${SUPERSEDES_THRESHOLD} is the shipped operating point.`
    )
    if (Object.keys(input.meanConfidenceByRelation).length > 0) {
      sections.push(
        `### mean judge confidence by ground-truth relation\n\n${markdownTable({
          columns: ['relation', 'mean confidence'],
          rows: Object.entries(input.meanConfidenceByRelation).map(([k, v]) => [k, v]),
        })}`
      )
    }
  }

  sections.push(
    `### latency (wall clock; not covered by the determinism guarantee)\n\n${renderTimings(
      input.timings
    )}`
  )
  return sections.join('\n\n')
}

export type ContradictionPatch = RetrievalConfigPatch
