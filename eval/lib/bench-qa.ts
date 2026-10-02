// qa loop for suites whose official scorer is a deterministic function instead of a
// judge model: build nothing here, the caller prepares the contexts, this module calls
// the reader on a pinned model, scores the text with the suite's scorer, appends the row
// to a jsonl checkpoint before aggregating, and refuses to spend above the call ceiling.
// the same safety rails as the longmemeval qa loop: pinned model recorded per row, cost
// estimate before the first call, resume by key.
//
// the caller builds that key from every axis that changes what a row means: the dataset
// bytes, the systems, the model, the prompt and the scorer versions, the budget and top-k,
// the vector regime that was in effect, the effective sample selection, the code revision
// and the seed. a checkpoint written under another key is not a prefix of this run: its
// rows are left where they are and the run names the part that differed.
import { EvalSetupError } from './errors.js'
import { resumeIdentityIssue } from './run-identity.js'
import { JsonlCheckpoint } from './checkpoint.js'
import { callChat, gatewayStatus, qaMissingGateway } from './llm.js'
import { round3, summarizeLatencies, type TokenizerInfo } from './metrics.js'
import type { ReaderSpec } from './readers.js'
import type { TimingSummary, VectorMode } from './types.js'
import { vectorIdentity, type QaContextPlan } from './qa-run.js'

export const DEFAULT_BENCH_CONCURRENCY = 2
export const DEFAULT_BENCH_COST_CEILING_CALLS = 100

export interface BenchQuestion {
  question_id: string
  /** group label for the per-type table: a locomo category or a memoryagentbench sub-dataset */
  question_type: string
  question: string
  /** what the reader is asked, already in the official shape */
  prompt_question: string
  /** suite-specific state the scorer needs, e.g. the locomo option order */
  payload?: Record<string, unknown>
  contexts: QaContextPlan[]
}

export interface ScoredAnswer {
  /** 0..1; a partial-credit metric keeps its fraction */
  score: number
  /** a short label for the artifact, e.g. the f1 breakdown or the matched ground truth */
  detail: string
}

export interface BenchScorer {
  name: string
  version: string
  /** where the rule comes from, printed on the report */
  source: string
  score(question: BenchQuestion, predicted: string): ScoredAnswer
}

export interface BenchQaRow {
  key: string
  question_id: string
  question_type: string
  reader: string
  reader_model: string
  /** which reader frame was used */
  prompt_version: string
  scorer: string
  scorer_version: string
  question: string
  gold: string
  predicted: string
  score: number
  detail: string
  input_tokens: number
  output_tokens: number
  token_source: 'usage' | 'estimated'
  context_tokens: number
  retrieval_ms: number
  reader_ms: number
  git_sha: string
  /** the vector regime in effect, from `benchVectorIdentity` */
  vectors: string
  /** the effective selection this run asked about, from `selectionIdentity` */
  selection: string
  resumed: boolean
  [field: string]: unknown
}

export interface BenchQaFailure {
  question_id: string
  reader: string
  message: string
}

export interface BenchCostEstimate {
  questions: number
  resumed_questions: number
  calls: number
  reader_input_tokens: number
  ceiling_calls: number
  basis: string
}

export interface BenchQaInput {
  questions: AsyncIterable<BenchQuestion>
  readers: ReaderSpec[]
  readerModel: string
  /** message frame around the context blocks */
  buildMessages: (question: BenchQuestion, plan: QaContextPlan) => Array<{ role: 'system' | 'user'; content: string }>
  systemNote: string
  promptVersion: string
  /** the gold answer, for the artifact only */
  goldOf: (question: BenchQuestion) => string
  scorer: BenchScorer
  maxTokens: number
  temperature: number
  concurrency: number
  checkpoint: JsonlCheckpoint<BenchQaRow>
  key: string
  costCeilingCalls: number
  confirmed: boolean
  totalQuestions: number
  /** engine/code revision, recorded on every row and inside the key */
  gitSha: string
  /** the vector regime, recorded on every row: a changed regime is a different run */
  vectors: string
  /** the effective selection, recorded on every row: a changed sample is a different run */
  selection: string
  tokenizer: TokenizerInfo
  log: (message: string) => void
}

/** checkpoint rows that belong to another run identity, kept but never reused */
export interface BenchForeignKey {
  key: string
  rows: number
  /** `field: this run vs that run`, from `benchKeyDiff` */
  differences: string[]
}

export interface BenchQaOutput {
  rows: BenchQaRow[]
  estimate: BenchCostEstimate | null
  failures: BenchQaFailure[]
  calls: number
  resumedQuestions: number
  /** rows the checkpoint held under another key: not a resumable prefix of this run */
  foreignKeys: BenchForeignKey[]
}

/** identity of a run: any change here retires the recorded rows */
export function benchQaKey(parts: Record<string, string | number>): string {
  return Object.keys(parts)
    .sort()
    .map((name) => `${name}=${parts[name]}`)
    .join('|')
}

// the vector regime a bench run records. the shared helper names the regime that was
// really in effect; the one case it cannot settle up front is `on` with an incomplete
// model, where the pipeline may reach vectors or fall back to lexical at run time, so
// that regime is named uncertain rather than promising a channel.
export function benchVectorIdentity(
  mode: VectorMode,
  state: { vectorsAvailable: boolean; modelCacheReady: boolean }
): string {
  const identity = vectorIdentity(mode, state)
  return identity === 'on+model-incomplete' ? 'on+model-incomplete(uncertain)' : identity
}

/**
 * the effective selection a run used, as `unit=used/available`: a `--limit` above what the
 * file holds collapses to the whole file, and a smaller one can never resume the larger run
 */
export function selectionIdentity(unit: string, used: number, available: number): string {
  return `${unit}=${used}/${available}`
}

function keyParts(key: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of key.split('|')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    out.set(part.slice(0, at), part.slice(at + 1))
  }
  return out
}

// `field: this vs that` for the labelled parts of two bench keys. a bench key is built
// from a sorted map, so parts are matched by name: a key from before `vectors=` existed
// reports that part as absent instead of shifting every later part by one.
export function benchKeyDiff(current: string, other: string): string[] {
  const mine = keyParts(current)
  const theirs = keyParts(other)
  const out: string[] = []
  for (const field of [...new Set([...mine.keys(), ...theirs.keys()])].sort()) {
    const a = mine.get(field)
    const b = theirs.get(field)
    if (a === b) continue
    out.push(`${field}: ${a ?? '(absent)'} vs ${b ?? '(absent)'}`)
  }
  return out
}

/** `--qa` needs a gateway, a pinned reader model and a system; the official scorer is local, so no judge */
export function preflightBenchQa(
  ctx: { qa?: boolean; envFile?: string },
  systemSpecs: string[],
  readerModel: string,
  scorerName: string
): boolean {
  if (!ctx.qa) return false
  const status = gatewayStatus(ctx.envFile)
  if (!status.configured) throw new EvalSetupError(qaMissingGateway(ctx.envFile))
  if (readerModel === '') {
    throw new EvalSetupError(
      'qa: --reader-model is required with --qa — the model that answered is pinned per run and ' +
        `recorded on every row (the scoring rule is ${scorerName}, which needs no judge)`
    )
  }
  if (systemSpecs.length === 0) {
    throw new EvalSetupError('qa: no system selected — pass --systems engram,full-context,naive-rag')
  }
  return true
}

export async function runBenchQa(input: BenchQaInput): Promise<BenchQaOutput> {
  const concurrency = Math.max(1, Math.floor(input.concurrency))
  const done = new Map<string, BenchQaRow>()
  const resumeIssue = resumeIdentityIssue(input.vectors, input.gitSha)
  if (resumeIssue !== null) input.log(`qa resume disabled: ${resumeIssue}`)
  const foreign = new Map<string, number>()
  for (const line of input.checkpoint.load()) {
    if (resumeIssue === null && line.key === input.key) done.set(`${line.question_id}|${line.reader}`, line)
    else foreign.set(line.key, (foreign.get(line.key) ?? 0) + 1)
  }
  // a row under another key was answered under another regime (or another code revision);
  // it is not reused and it is not deleted, but the run must not stay quiet about it
  const foreignKeys: BenchForeignKey[] = [...foreign.entries()]
    .sort((a, b) => (a[1] !== b[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
    .map(([key, rows]) => ({
      key, rows, differences: [
        ...benchKeyDiff(input.key, key),
        ...(key === input.key && resumeIssue !== null ? [resumeIssue] : []),
      ],
    }))
  if (foreignKeys.length > 0) {
    const total = foreignKeys.reduce((sum, entry) => sum + entry.rows, 0)
    input.log(
      `qa resume: ${total} checkpoint row(s) have an unverified or different identity and are not ` +
        `reused — ${foreignKeys[0].differences.join('; ') || foreignKeys[0].key}`
    )
  }

  const rows: BenchQaRow[] = []
  const failures: BenchQaFailure[] = []
  const order = new Map<string, number>()
  const inFlight: Array<Promise<void>> = []
  const readerOrder = new Map(input.readers.map((r, i) => [r.name, i]))
  let estimate: BenchCostEstimate | null = null
  let calls = 0
  let questionIndex = 0
  let resumedQuestions = 0
  let active = 0
  const waiting: Array<() => void> = []

  const acquire = async (): Promise<void> => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
  }
  const release = (): void => {
    active--
    waiting.shift()?.()
  }

  for await (const question of input.questions) {
    order.set(question.question_id, questionIndex++)
    const recorded = question.contexts.filter((plan) => done.has(`${question.question_id}|${plan.reader}`))
    for (const plan of recorded) {
      rows.push({ ...done.get(`${question.question_id}|${plan.reader}`)!, resumed: true })
    }
    const pending = question.contexts.filter((plan) => !done.has(`${question.question_id}|${plan.reader}`))
    if (pending.length === 0) {
      resumedQuestions++
      continue
    }

    if (!estimate) {
      const remaining = input.totalQuestions - resumedQuestions
      estimate = { ...estimateCost(question, remaining, input), resumed_questions: resumedQuestions }
      input.log(formatEstimate(estimate, input))
      if (!input.confirmed && estimate.calls > input.costCeilingCalls) {
        throw new EvalSetupError(
          `qa cost gate: ${estimate.calls} estimated calls for ${remaining} question(s) is above the ` +
            `ceiling of ${input.costCeilingCalls}; re-run with --yes to spend it (estimated reader input ` +
            `${estimate.reader_input_tokens} tokens)`
        )
      }
    }

    for (const plan of pending) {
      inFlight.push(
        acquire()
          .then(() => answerOne(question, plan, input))
          .then((row) => {
            calls++
            rows.push(row)
            input.checkpoint.append({ ...row, at: new Date().toISOString() })
          })
          .catch((error) => {
            failures.push({
              question_id: question.question_id,
              reader: plan.reader,
              message: error instanceof Error ? error.message : String(error),
            })
          })
          .finally(release)
      )
    }
    // one prepared question per yield, so a slow gateway cannot queue the whole run
    while (inFlight.length > concurrency * 2) await inFlight.shift()
  }
  await Promise.all(inFlight)

  rows.sort((a, b) => {
    const qa = order.get(a.question_id) ?? 0
    const qb = order.get(b.question_id) ?? 0
    if (qa !== qb) return qa - qb
    return (readerOrder.get(a.reader) ?? 0) - (readerOrder.get(b.reader) ?? 0)
  })
  return { rows, estimate, failures, calls, resumedQuestions, foreignKeys }
}

async function answerOne(
  question: BenchQuestion,
  plan: QaContextPlan,
  input: BenchQaInput
): Promise<BenchQaRow> {
  const messages = input.buildMessages(question, plan)
  const estimatedInput = input.tokenizer.count(messages.map((m) => m.content).join('\n'))

  const started = performance.now()
  const result = await callChat({
    messages,
    options: { temperature: input.temperature, maxTokens: input.maxTokens },
    model: input.readerModel,
  })
  const readerMs = performance.now() - started

  const predicted = result.content.trim()
  const scored = input.scorer.score(question, predicted)
  const fromUsage = result.promptTokens !== undefined && result.completionTokens !== undefined
  return {
    key: input.key,
    question_id: question.question_id,
    question_type: question.question_type,
    reader: plan.reader,
    reader_model: input.readerModel,
    prompt_version: input.promptVersion,
    scorer: input.scorer.name,
    scorer_version: input.scorer.version,
    question: question.question,
    gold: input.goldOf(question),
    predicted,
    score: scored.score,
    detail: scored.detail,
    input_tokens: result.promptTokens ?? estimatedInput,
    output_tokens: result.completionTokens ?? input.tokenizer.count(predicted),
    token_source: fromUsage ? 'usage' : 'estimated',
    context_tokens: plan.tokens,
    retrieval_ms: plan.retrievalMs,
    reader_ms: readerMs,
    git_sha: input.gitSha,
    vectors: input.vectors,
    selection: input.selection,
    resumed: false,
  }
}

export function estimateCost(
  sample: BenchQuestion,
  questions: number,
  input: Pick<BenchQaInput, 'readerModel' | 'buildMessages' | 'tokenizer'>
): BenchCostEstimate {
  let readerInput = 0
  for (const plan of sample.contexts) {
    readerInput += input.tokenizer.count(
      input
        .buildMessages(sample, plan)
        .map((m) => m.content)
        .join('\n')
    )
  }
  const readerCalls = questions * sample.contexts.length
  return {
    questions,
    resumed_questions: 0,
    calls: readerCalls,
    reader_input_tokens: readerInput * questions,
    ceiling_calls: Number.POSITIVE_INFINITY,
    basis: `sample question ${sample.question_id} (${sample.contexts.length} reader(s)), extrapolated`,
  }
}

export function formatEstimate(
  estimate: BenchCostEstimate,
  input: Pick<BenchQaInput, 'readerModel' | 'promptVersion' | 'scorer'>
): string {
  return [
    `qa cost estimate: ${estimate.questions} question(s) x ` +
      `${estimate.calls / Math.max(1, estimate.questions)} reader(s) -> ${estimate.calls} reader calls ` +
      '(no judge call: the official scorer is local)',
    `  reader input ~${estimate.reader_input_tokens} tokens`,
    `  reader model ${input.readerModel}; prompt ${input.promptVersion}; scorer ${input.scorer.name} ${input.scorer.version}`,
    `  basis: ${estimate.basis}`,
  ].join('\n')
}

export interface BenchQaBlock {
  status: 'ok' | 'skipped'
  note?: string
  questions_answered?: number
  calls?: number
  reader_model?: string
  prompt_version?: string
  prompt_source?: string
  scorer?: string
  scorer_version?: string
  scorer_source?: string
  top_k?: number
  budget_chars?: number
  checkpoint?: string
  key?: string
  resumed_questions?: number
  estimated_rows?: number
  /** checkpoint rows under another run identity: kept, never reused */
  foreign_keys?: BenchForeignKey[]
  failures?: BenchQaFailure[]
  estimate?: BenchCostEstimate | null
  readers?: Record<string, BenchReaderAggregate>
}

/** what the artifact records about the run: models, prompt and scorer versions, resume state */
export function describeBenchQa(
  output: BenchQaOutput,
  meta: {
    readerModel: string
    promptVersion: string
    promptSource: string
    scorer: BenchScorer
    topK: number
    budgetChars: number
    checkpoint: JsonlCheckpoint<BenchQaRow>
    key: string
  }
): BenchQaBlock {
  const answered = new Set(output.rows.filter((row) => !row.resumed).map((row) => row.question_id))
  return {
    status: 'ok',
    questions_answered: answered.size,
    calls: output.calls,
    reader_model: meta.readerModel,
    prompt_version: meta.promptVersion,
    prompt_source: meta.promptSource,
    scorer: meta.scorer.name,
    scorer_version: meta.scorer.version,
    scorer_source: meta.scorer.source,
    top_k: meta.topK,
    budget_chars: meta.budgetChars,
    checkpoint: meta.checkpoint.path,
    key: meta.key,
    resumed_questions: output.resumedQuestions,
    estimated_rows: output.rows.filter((row) => row.token_source === 'estimated').length,
    foreign_keys: output.foreignKeys,
    failures: output.failures,
    estimate: output.estimate,
    readers: aggregateBenchRows(output.rows),
  }
}

export interface BenchTypeStat {
  graded: number
  score: number
  /** share of rows at a perfect score */
  exact: number
}

export interface BenchReaderAggregate {
  graded: number
  /** mean score over graded rows */
  score: number
  exact: number
  resumed: number
  avg_input_tokens: number
  avg_output_tokens: number
  avg_context_tokens: number
  token_sources: Record<string, number>
  by_question_type: Record<string, BenchTypeStat>
}

export function aggregateBenchRows(rows: BenchQaRow[]): Record<string, BenchReaderAggregate> {
  const out: Record<string, BenchReaderAggregate> = {}
  for (const reader of [...new Set(rows.map((r) => r.reader))].sort()) {
    const all = rows.filter((r) => r.reader === reader)
    const byType: Record<string, BenchTypeStat> = {}
    for (const type of [...new Set(all.map((r) => r.question_type))].sort()) {
      const list = all.filter((r) => r.question_type === type)
      byType[type] = {
        graded: list.length,
        score: round3(mean(list.map((r) => r.score))),
        exact: round3(list.filter((r) => r.score >= 1).length / Math.max(1, list.length)),
      }
    }
    const tokenSources: Record<string, number> = {}
    for (const row of all) tokenSources[row.token_source] = (tokenSources[row.token_source] ?? 0) + 1
    out[reader] = {
      graded: all.length,
      score: round3(mean(all.map((r) => r.score))),
      exact: round3(all.filter((r) => r.score >= 1).length / Math.max(1, all.length)),
      resumed: all.filter((r) => r.resumed).length,
      avg_input_tokens: round3(mean(all.map((r) => r.input_tokens))),
      avg_output_tokens: round3(mean(all.map((r) => r.output_tokens))),
      avg_context_tokens: round3(mean(all.map((r) => r.context_tokens))),
      token_sources: tokenSources,
      by_question_type: byType,
    }
  }
  return out
}

/** wall-clock summaries, kept out of `metrics` on purpose */
export function benchQaTimings(rows: BenchQaRow[]): Record<string, TimingSummary> {
  const out: Record<string, TimingSummary> = {}
  for (const reader of [...new Set(rows.map((r) => r.reader))].sort()) {
    const forReader = rows.filter((r) => r.reader === reader)
    out[`qa/${reader}/retrieval`] = summarizeLatencies(forReader.map((r) => r.retrieval_ms))
    out[`qa/${reader}/reader-call`] = summarizeLatencies(forReader.map((r) => r.reader_ms))
  }
  return out
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}
