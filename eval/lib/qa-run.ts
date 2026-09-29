// longmemeval qa loop: reader call, official judge, checkpoint, cost gate. one
// question at a time with local work first, while the llm calls run through a small
// pool so a long run is not serial; every row lands in the checkpoint before it is
// aggregated, and both models are pinned per run and recorded on each row, since two
// accuracy numbers from different judges are not comparable.
import { JsonlCheckpoint } from './checkpoint.js'
import { EvalSetupError } from './errors.js'
import { callChat } from './llm.js'
import { ANSCHECK_PROMPT_VERSION, buildJudgePrompt, judgeVerdict } from './judge.js'
import {
  READER_PROMPT_VERSION,
  READER_SYSTEM_PROMPT,
  buildReaderUserPrompt,
  type ReaderSpec,
} from './readers.js'
import { round3, summarizeLatencies, type TokenizerInfo } from './metrics.js'
import type { TimingSummary } from './types.js'
import type { ChatMessage } from '../../src/llm/client.js'

export const READER_CHAT_OPTIONS = { temperature: 0, maxTokens: 64 } as const
export const DEFAULT_CONCURRENCY = 2
export const DEFAULT_COST_CEILING_CALLS = 100

export interface QaContextPlan {
  reader: string
  blocks: string[]
  chars: number
  tokens: number
  retrievalMs: number
  note: string
  /** the system behind this reader; defaults to the reader name */
  system?: string
  adapter_kind?: string
  adapter_config_hash?: string
}

export interface QaQuestion {
  question_id: string
  question_type: string
  question: string
  gold_answer: string
  question_date?: string
  contexts: QaContextPlan[]
}

export interface QaRow {
  key: string
  question_id: string
  question_type: string
  reader: string
  /** the memory system that produced the context, and how to reproduce it */
  system: string
  adapter_kind: string
  adapter_config_hash: string
  judge_prompt: string
  reader_model: string
  judge_model: string
  predicted: string
  correct: boolean
  verdict: string
  judge_template: string
  /** gateway usage when reported, tokenizer estimate otherwise */
  input_tokens: number
  output_tokens: number
  judge_input_tokens: number
  judge_output_tokens: number
  token_source: 'usage' | 'estimated'
  context_tokens: number
  retrieval_ms: number
  reader_ms: number
  judge_ms: number
  git_sha: string
  resumed: boolean
  [field: string]: unknown
}

export interface QaFailure {
  question_id: string
  reader: string
  message: string
}

export interface CostEstimate {
  questions: number
  resumed_questions: number
  calls: number
  reader_calls: number
  judge_calls: number
  reader_input_tokens: number
  judge_input_tokens: number
  ceiling_calls: number
  basis: string
}

export interface QaRunInput {
  /** in sample order; the caller owns seeding and teardown */
  questions: AsyncIterable<QaQuestion>
  readers: ReaderSpec[]
  readerModel: string
  judgeModel: string
  concurrency: number
  checkpoint: JsonlCheckpoint<QaRow>
  key: string
  costCeilingCalls: number
  confirmed: boolean
  totalQuestions: number
  gitSha: string
  tokenizer: TokenizerInfo
  log: (message: string) => void
}

export interface QaRunOutput {
  /** in sample order: question order, then reader registry order */
  rows: QaRow[]
  estimate: CostEstimate | null
  failures: QaFailure[]
  calls: number
  resumedQuestions: number
}

/**
 * identity of a run: any change here makes old rows unusable. a system enters as
 * `name@adapter-hash`, so editing an adapter config invalidates the rows it produced.
 */
export function qaKey(input: {
  split: string
  datasetSha: string
  systems: string[]
  readerModel: string
  judgeModel: string
  budgetChars: number
  topK: number
}): string {
  return [
    input.split,
    input.datasetSha.slice(0, 16),
    input.systems.join('+'),
    input.readerModel,
    input.judgeModel,
    READER_PROMPT_VERSION,
    ANSCHECK_PROMPT_VERSION,
    `budget=${input.budgetChars}`,
    `topk=${input.topK}`,
  ].join('|')
}

export async function runQa(input: QaRunInput): Promise<QaRunOutput> {
  const concurrency = Math.max(1, Math.floor(input.concurrency))
  const done = new Map<string, QaRow>()
  for (const line of input.checkpoint.load()) {
    if (line.key === input.key) done.set(`${line.question_id}|${line.reader}`, line)
  }

  const rows: QaRow[] = []
  const failures: QaFailure[] = []
  const order = new Map<string, number>()
  /** in-flight tasks, oldest first; bounded so prepared questions cannot pile up */
  const inFlight: Array<Promise<void>> = []
  const readerOrder = new Map(input.readers.map((r, i) => [r.name, i]))
  let estimate: CostEstimate | null = null
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
    const recorded = question.contexts.filter((p) =>
      done.has(`${question.question_id}|${p.reader}`)
    )
    for (const plan of recorded) {
      rows.push({ ...done.get(`${question.question_id}|${plan.reader}`)!, resumed: true })
    }
    const pending = question.contexts.filter((p) => !done.has(`${question.question_id}|${p.reader}`))
    if (recorded.length === question.contexts.length) {
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
            `ceiling of ${input.costCeilingCalls}; re-run with --yes to spend it (estimated reader ` +
            `input ${estimate.reader_input_tokens} tokens, judge input ${estimate.judge_input_tokens} tokens)`
        )
      }
    }

    for (const plan of pending) {
      inFlight.push(
        acquire()
          .then(() => answerOne(question, plan, input))
          .then((row) => {
            calls += 2
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
    // the producer holds one prepared question, context included, per yield, so a slow
    // gateway must not let the whole run queue up behind it
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

interface OneAnswer {
  predicted: string
  verdict: string
  correct: boolean
  judgeTemplate: string
  inputTokens: number
  outputTokens: number
  judgeInputTokens: number
  judgeOutputTokens: number
  tokenSource: 'usage' | 'estimated'
  readerMs: number
  judgeMs: number
}

async function answerOne(
  question: QaQuestion,
  plan: QaContextPlan,
  input: QaRunInput
): Promise<QaRow> {
  const answered = await runReaderAndJudge(question, plan, input)
  return {
    key: input.key,
    question_id: question.question_id,
    question_type: question.question_type,
    reader: plan.reader,
    system: plan.system ?? plan.reader,
    adapter_kind: plan.adapter_kind ?? 'builtin',
    adapter_config_hash: plan.adapter_config_hash ?? '',
    judge_prompt: answered.judgePrompt,
    reader_model: input.readerModel,
    judge_model: input.judgeModel,
    predicted: answered.predicted,
    correct: answered.correct,
    verdict: answered.verdict,
    judge_template: answered.judgeTemplate,
    input_tokens: answered.inputTokens,
    output_tokens: answered.outputTokens,
    judge_input_tokens: answered.judgeInputTokens,
    judge_output_tokens: answered.judgeOutputTokens,
    token_source: answered.tokenSource,
    context_tokens: plan.tokens,
    retrieval_ms: plan.retrievalMs,
    reader_ms: answered.readerMs,
    judge_ms: answered.judgeMs,
    git_sha: input.gitSha,
    resumed: false,
  }
}

interface Answered extends OneAnswer {
  judgePrompt: string
}

export async function runReaderAndJudge(
  question: QaQuestion,
  plan: QaContextPlan,
  input: Pick<QaRunInput, 'readerModel' | 'judgeModel' | 'tokenizer'>
): Promise<Answered> {
  const messages: ChatMessage[] = [
    { role: 'system', content: READER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildReaderUserPrompt({
        question: question.question,
        questionDate: question.question_date,
        blocks: plan.blocks,
      }),
    },
  ]
  const estimatedInput = input.tokenizer.count(messages.map((m) => m.content).join('\n'))

  const readerStart = performance.now()
  const readerResult = await callChat({
    messages,
    options: { ...READER_CHAT_OPTIONS },
    model: input.readerModel,
  })
  const readerMs = performance.now() - readerStart
  const predicted = readerResult.content.trim()

  const judgeStart = performance.now()
  const verdict = await judgeVerdict(
    {
      questionId: question.question_id,
      questionType: question.question_type,
      question: question.question,
      goldAnswer: question.gold_answer,
      predictedAnswer: predicted,
    },
    input.judgeModel
  )
  const judgeMs = performance.now() - judgeStart

  const estimatedOutput = input.tokenizer.count(predicted)
  const estimatedJudgeInput = input.tokenizer.count(verdict.prompt)
  const estimatedJudgeOutput = input.tokenizer.count(verdict.raw)
  const fromUsage =
    readerResult.promptTokens !== undefined &&
    readerResult.completionTokens !== undefined &&
    verdict.promptTokens !== undefined &&
    verdict.completionTokens !== undefined
  return {
    predicted,
    verdict: verdict.raw,
    correct: verdict.correct,
    judgeTemplate: verdict.template,
    judgePrompt: verdict.prompt,
    inputTokens: readerResult.promptTokens ?? estimatedInput,
    outputTokens: readerResult.completionTokens ?? estimatedOutput,
    judgeInputTokens: verdict.promptTokens ?? estimatedJudgeInput,
    judgeOutputTokens: verdict.completionTokens ?? estimatedJudgeOutput,
    tokenSource: fromUsage ? 'usage' : 'estimated',
    readerMs,
    judgeMs,
  }
}

export function estimateCost(
  sample: QaQuestion,
  questions: number,
  input: Pick<QaRunInput, 'readerModel' | 'judgeModel' | 'tokenizer' | 'costCeilingCalls' | 'readers'>
): CostEstimate {
  let readerInput = 0
  let judgeInput = 0
  for (const plan of sample.contexts) {
    readerInput += input.tokenizer.count(
      [
        READER_SYSTEM_PROMPT,
        buildReaderUserPrompt({
          question: sample.question,
          questionDate: sample.question_date,
          blocks: plan.blocks,
        }),
      ].join('\n')
    )
    judgeInput += input.tokenizer.count(
      buildJudgePrompt({
        questionId: sample.question_id,
        questionType: sample.question_type,
        question: sample.question,
        goldAnswer: sample.gold_answer,
        predictedAnswer: '',
      }).prompt
    )
  }
  const readerCalls = questions * sample.contexts.length
  return {
    questions,
    resumed_questions: 0,
    calls: readerCalls * 2,
    reader_calls: readerCalls,
    judge_calls: readerCalls,
    reader_input_tokens: readerInput * questions,
    judge_input_tokens: judgeInput * questions,
    ceiling_calls: input.costCeilingCalls,
    basis: `sample question ${sample.question_id} (${sample.contexts.length} reader(s)), extrapolated`,
  }
}

export function formatEstimate(estimate: CostEstimate, input: Pick<QaRunInput, 'readerModel' | 'judgeModel'>): string {
  return [
    `qa cost estimate: ${estimate.questions} question(s) x ${estimate.reader_calls / Math.max(1, estimate.questions)} reader(s) ` +
      `-> ${estimate.reader_calls} reader calls + ${estimate.judge_calls} judge calls`,
    `  reader input ~${estimate.reader_input_tokens} tokens, judge input ~${estimate.judge_input_tokens} tokens`,
    `  reader model ${input.readerModel}; judge model ${input.judgeModel}`,
    `  ceiling ${estimate.ceiling_calls} calls; basis: ${estimate.basis}`,
  ].join('\n')
}

export interface QuestionTypeStat {
  graded: number
  correct: number
  accuracy: number
}

export interface ReaderAggregate {
  graded: number
  correct: number
  accuracy: number
  resumed: number
  avg_input_tokens: number
  avg_output_tokens: number
  avg_judge_input_tokens: number
  avg_context_tokens: number
  token_sources: Record<string, number>
  by_question_type: Record<string, QuestionTypeStat>
}

export function aggregateQaRows(rows: QaRow[]): Record<string, ReaderAggregate> {
  const scoresByReader = new Map<string, Map<string, QaRow[]>>()
  const readers = new Set(rows.map((r) => r.reader))
  for (const reader of readers) scoresByReader.set(reader, new Map())
  for (const row of rows) {
    const byType = scoresByReader.get(row.reader)!
    const list = byType.get(row.question_type) ?? []
    list.push(row)
    byType.set(row.question_type, list)
  }

  const out: Record<string, ReaderAggregate> = {}
  for (const [reader, byType] of [...scoresByReader.entries()].sort()) {
    const all = rows.filter((r) => r.reader === reader)
    const correct = all.filter((r) => r.correct).length
    const byQuestionType: Record<string, QuestionTypeStat> = {}
    for (const [type, list] of [...byType.entries()].sort()) {
      const typeCorrect = list.filter((r) => r.correct).length
      byQuestionType[type] = {
        graded: list.length,
        correct: typeCorrect,
        accuracy: round3(list.length === 0 ? 0 : typeCorrect / list.length),
      }
    }
    const tokenSources: Record<string, number> = {}
    for (const row of all) tokenSources[row.token_source] = (tokenSources[row.token_source] ?? 0) + 1
    out[reader] = {
      graded: all.length,
      correct,
      accuracy: round3(all.length === 0 ? 0 : correct / all.length),
      resumed: all.filter((r) => r.resumed).length,
      avg_input_tokens: mean(all.map((r) => r.input_tokens)),
      avg_output_tokens: mean(all.map((r) => r.output_tokens)),
      avg_judge_input_tokens: mean(all.map((r) => r.judge_input_tokens)),
      avg_context_tokens: mean(all.map((r) => r.context_tokens)),
      token_sources: tokenSources,
      by_question_type: byQuestionType,
    }
  }
  return out
}

/** wall-clock summaries, outside `metrics` on purpose: they vary per run */
export function qaTimings(rows: QaRow[]): Record<string, TimingSummary> {
  const out: Record<string, TimingSummary> = {}
  for (const reader of [...new Set(rows.map((r) => r.reader))].sort()) {
    const forReader = rows.filter((r) => r.reader === reader)
    out[`qa/${reader}/retrieval`] = summarizeLatencies(forReader.map((r) => r.retrieval_ms))
    out[`qa/${reader}/reader-call`] = summarizeLatencies(forReader.map((r) => r.reader_ms))
    out[`qa/${reader}/judge-call`] = summarizeLatencies(forReader.map((r) => r.judge_ms))
  }
  return out
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return round3(values.reduce((a, b) => a + b, 0) / values.length)
}
