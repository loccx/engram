// qa loop for suites whose official scorer is a deterministic function instead of a
// judge model: build nothing here, the caller prepares the contexts, this module calls
// the reader on a pinned model, scores the text with the suite's scorer, appends the row
// to a jsonl checkpoint before aggregating, and refuses to spend above the call ceiling.
// the same safety rails as the longmemeval qa loop: pinned model recorded per row, cost
// estimate before the first call, resume by key.
import { EvalSetupError } from './errors.js'
import { JsonlCheckpoint } from './checkpoint.js'
import { callChat, gatewayStatus, qaMissingGateway } from './llm.js'
import { round3, summarizeLatencies, type TokenizerInfo } from './metrics.js'
import type { ReaderSpec } from './readers.js'
import type { TimingSummary } from './types.js'
import type { QaContextPlan } from './qa-run.js'

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
  gitSha: string
  tokenizer: TokenizerInfo
  log: (message: string) => void
}

export interface BenchQaOutput {
  rows: BenchQaRow[]
  estimate: BenchCostEstimate | null
  failures: BenchQaFailure[]
  calls: number
  resumedQuestions: number
}

/** identity of a run: any change here retires the recorded rows */
export function benchQaKey(parts: Record<string, string | number>): string {
  return Object.keys(parts)
    .sort()
    .map((name) => `${name}=${parts[name]}`)
    .join('|')
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
  for (const line of input.checkpoint.load()) {
    if (line.key === input.key) done.set(`${line.question_id}|${line.reader}`, line)
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
  return { rows, estimate, failures, calls, resumedQuestions }
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
