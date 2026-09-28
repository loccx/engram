// longmemeval suite: retrieval metrics and, with --qa, the reader/judge cost and
// accuracy run. both splits stream one record at a time (scanJsonArray), since the
// s-split is a few hundred MB with ~49 sessions per question: a whole-file parse would
// hold the dataset in memory and a whole-corpus index would hold every haystack in the
// db. each question is ingested into its own namespace (/longmemeval/<question_id>),
// queried and torn down, with session-level ground truth (has_answer, or the id in
// answer_session_ids — read from the file, never assumed).
// --qa adds the readers and the upstream judge on pinned models, and fails before any
// spend when the gateway is missing; retrieval only needs no credentials and no network.
// limits worth stating: the oracle split holds the evidence sessions, so recall on it is
// near-trivial plumbing, and *_s_cleaned is the split to quote. the reader prompt is
// local while the judge is upstream. full-context is the unbudgeted ceiling and
// naive-rag the lexical floor, both on the same questions and judge.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { countTopLevelElements, scanJsonArray, sha256File } from '../lib/json-stream.js'
import { EvalHarness } from '../lib/harness.js'
import { corpusHash, resolveTokenizer, round3, summarizeLatencies } from '../lib/metrics.js'
import { markdownTable, REPO_ROOT, renderTimings } from '../lib/report.js'
import { DEFAULT_KS, MEASUREMENT_DEFAULTS, aggregate, scoreQueries, type QueryDetail } from '../lib/score.js'
import { topLineFromBlock } from '../lib/thresholds.js'
import { gatewayStatus, qaMissingGateway } from '../lib/llm.js'
import { EvalSetupError } from '../lib/errors.js'
import { JsonlCheckpoint } from '../lib/checkpoint.js'
import { ANSCHECK_PROMPT_VERSION, ANSCHECK_SOURCE } from '../lib/judge.js'
import {
  DEFAULT_CONTEXT_BUDGET_CHARS,
  READER_PROMPT_VERSION,
  resolveReaders,
  type ReaderContext,
  type ReaderSpec,
} from '../lib/readers.js'
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_COST_CEILING_CALLS,
  aggregateQaRows,
  qaKey,
  qaTimings,
  runQa,
  type CostEstimate,
  type QaQuestion,
  type QaRow,
  type ReaderAggregate,
} from '../lib/qa-run.js'
import { describeHarness } from './retrieval.js'
import type { SuiteContext, SuiteOutput } from './types.js'
import type { Corpus, CorpusMemory, CorpusQuery, TimingSummary } from '../lib/types.js'

export const DATASETS_DIR = join(REPO_ROOT, 'eval', 'datasets')
export const MANIFEST_PATH = join(DATASETS_DIR, 'manifest.json')
export const DEFAULT_SPLIT = 'longmemeval_oracle'

const HOUR = 3_600_000
/** retrieval depth for the session-level metrics, independent of question count */
const READ_LIMIT = MEASUREMENT_DEFAULTS.limit ?? 10
/** sessions fed to a reader */
const READER_TOP_K = 10
/** records inspected for the schema block; keys are stable per split */
const SCHEMA_SAMPLE = 20

export interface ManifestSplit {
  split: string
  file: string
  url: string
  bytes: number
  sha256: string
  record_count: number | null
  fetched_at: string
  schema?: {
    record_keys?: string[]
    session_message_keys?: string[]
    sessions_per_record?: number[]
    has_answer_session_ids?: boolean
    notes?: string
  }
}

export interface Manifest {
  repo: string
  repo_sha?: string
  fetched_at: string
  splits: Record<string, ManifestSplit>
}

interface LmeMessage {
  role?: string
  content?: string
  has_answer?: boolean
}

export interface LmeRecord {
  question_id: string
  question: string
  answer: string
  question_type?: string
  question_date?: string
  haystack_sessions?: LmeMessage[][]
  haystack_dates?: string[]
  haystack_session_ids?: string[]
  answer_session_ids?: string[]
}

export function loadManifest(path: string = MANIFEST_PATH): Manifest | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest
  } catch {
    return null
  }
}

/** checked against the records actually read, never assumed */
export const REQUIRED_RECORD_FIELDS = [
  'question_id',
  'question',
  'answer',
  'question_type',
  'haystack_sessions',
  'haystack_dates',
] as const

export interface SchemaCheck {
  checked: number
  missing: string[]
  presentFields: string[]
  sessionMessageFields: string[]
  hasAnswerField: boolean
  answerSessionIdsField: boolean
}

export function checkSchema(records: LmeRecord[]): SchemaCheck {
  const present = new Set<string>()
  const messageFields = new Set<string>()
  let hasAnswerField = false
  let answerSessionIdsField = false
  for (const record of records) {
    for (const key of Object.keys(record)) present.add(key)
    if (Array.isArray(record.answer_session_ids)) answerSessionIdsField = true
    for (const session of record.haystack_sessions ?? []) {
      for (const message of session) {
        for (const key of Object.keys(message)) {
          messageFields.add(key)
          if (key === 'has_answer') hasAnswerField = true
        }
      }
    }
  }
  const missing = REQUIRED_RECORD_FIELDS.filter((field) => !present.has(field))
  return {
    checked: records.length,
    missing: [...missing],
    presentFields: [...present].sort(),
    sessionMessageFields: [...messageFields].sort(),
    hasAnswerField,
    answerSessionIdsField,
  }
}

export interface GroundTruthStats {
  questions: number
  /** targets came from answer_session_ids */
  fromAnswerSessionIds: number
  /** targets came from per-message has_answer */
  fromHasAnswer: number
  /** both sources agree, with at least one overlapping session */
  fromBoth: number
  /** no resolvable target: excluded from the metrics, not scored as 0 */
  unscorable: number
  /** `answer_session_ids` entries that do not appear in `haystack_session_ids`. */
  unresolvedAnswerSessionIds: number
}

export function emptyGroundTruth(): GroundTruthStats {
  return {
    questions: 0,
    fromAnswerSessionIds: 0,
    fromHasAnswer: 0,
    fromBoth: 0,
    unscorable: 0,
    unresolvedAnswerSessionIds: 0,
  }
}

/**
 * one memory per haystack session, in a per-question namespace; a session is a target
 * when its has_answer flag is set or its id appears in answer_session_ids
 */
export function recordToCorpus(
  record: LmeRecord,
  recordIndex: number,
  stats: GroundTruthStats
): { memories: CorpusMemory[]; query: CorpusQuery } {
  const sessions = record.haystack_sessions ?? []
  const dates = record.haystack_dates ?? []
  const sessionIds = record.haystack_session_ids ?? []
  const answerIds = new Set(record.answer_session_ids ?? [])
  const namespace = `/longmemeval/${record.question_id}`
  const memories: CorpusMemory[] = []
  const targets: string[] = []
  stats.questions++

  for (const answerId of answerIds) {
    if (!sessionIds.includes(answerId)) stats.unresolvedAnswerSessionIds++
  }

  let viaIds = false
  let viaFlags = false

  sessions.forEach((session, sessionIndex) => {
    const id = `lme-${record.question_id}-s${sessionIndex}`
    const content = session
      .map((message) => `${message.role ?? 'unknown'}: ${message.content ?? ''}`)
      .join('\n')
    const labelled = sessionIds[sessionIndex]
    const hasAnswer = session.some((message) => message.has_answer === true)
    const fromId = labelled !== undefined && answerIds.has(labelled)
    if (fromId) viaIds = true
    if (hasAnswer) viaFlags = true
    if (hasAnswer || fromId) targets.push(id)
    memories.push({
      id,
      namespace,
      content,
      type: 'note',
      created_at: parseLmeDate(dates[sessionIndex]) ?? CORPUS_BASE + (recordIndex * 64 + sessionIndex) * HOUR,
      tags: ['longmemeval', record.question_type ?? 'unknown'],
    })
  })

  if (viaIds) stats.fromAnswerSessionIds++
  if (viaFlags) stats.fromHasAnswer++
  if (viaIds && viaFlags) stats.fromBoth++
  if (targets.length === 0) stats.unscorable++

  return {
    memories,
    query: {
      id: `lme-q-${record.question_id}`,
      query: record.question,
      namespace,
      target_ids: targets,
      kind: record.question_type ?? 'unknown',
    },
  }
}

const CORPUS_BASE = 1_700_000_000_000

/** `"2023/04/10 (Mon) 17:50"` -> epoch ms; null when unparseable. */
export function parseLmeDate(value: string | undefined): number | null {
  if (!value) return null
  const cleaned = value.replace(/\(([A-Za-z]{3})\)/, '').trim()
  const match = cleaned.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/)
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
  return Number.isFinite(ms) ? ms : null
}

export function defaultQuestionLimit(splitName: string): number {
  return splitName.includes('_s_cleaned') || splitName.includes('_m_cleaned') ? 20 : 50
}

/** the default checkpoint: one file per split and reader set */
export function defaultCheckpointPath(splitName: string, readers: ReaderSpec[]): string {
  const slug = readers.map((r) => r.name).join('+')
  return join(REPO_ROOT, 'eval', 'reports', `longmemeval-qa-${splitName}-${slug}.jsonl`)
}

export function resolveDatasetPath(ctx: SuiteContext, splitName: string): string {
  if (ctx.datasetPath) return ctx.datasetPath
  const split = loadManifest()?.splits[splitName]
  return split ? join(DATASETS_DIR, split.file) : join(DATASETS_DIR, `${splitName}.json`)
}

export async function runLongMemEvalSuite(ctx: SuiteContext): Promise<SuiteOutput> {
  const splitName = ctx.dataset ?? ctx.corpora?.[0] ?? DEFAULT_SPLIT
  const tokenizer = await resolveTokenizer()
  const notes: string[] = []
  const featureFlags: Record<string, string> = {}
  const manifest = loadManifest()
  const split = manifest?.splits[splitName] ?? null
  const filePath = resolveDatasetPath(ctx, splitName)
  const readers = resolveReaders(ctx.readers)
  const readerModel = ctx.readerModel ?? ''
  const judgeModel = ctx.judgeModel ?? ''
  const qaReady = preflightQa(ctx, readers, readerModel, judgeModel)

  if (!existsSync(filePath)) {
    if (ctx.datasetPath) {
      throw new EvalSetupError(`--dataset-path ${filePath} does not exist`)
    }
    notes.push(
      `dataset missing: ${splitName}. Fetch it with \`npm run eval:datasets\` ` +
        `(default: longmemeval_oracle, ~15 MB) or \`npm run eval:datasets -- --full\` for ` +
        'longmemeval_s_cleaned (~277 MB). Retrieval-only metrics and QA are skipped; exit code stays 0.'
    )
    const emptyCorpus: Corpus = {
      name: `longmemeval:${splitName}`,
      seed: ctx.seed,
      memories: [],
      queries: [],
    }
    return {
      result: {
        suite: 'longmemeval',
        header: ctx.buildHeader({
          suite: 'longmemeval',
          configs: ctx.configs.map(([name]) => name),
          seed: ctx.seed,
          corpusHash: corpusHash(emptyCorpus),
          vectorsAvailable: false,
          vectorMode: ctx.vectors,
          now: 0,
          tokenizer,
          featureFlags,
        }),
        metrics: {
          status: 'dataset-missing',
          split: splitName,
          datasetDir: DATASETS_DIR,
          manifestPresent: manifest !== null,
        },
        timings: {},
        details: [],
        notes,
      },
      markdown: `Dataset **${splitName}** is not present in \`eval/datasets/\`.\n\nRun:\n\n\`\`\`\nnpm run eval:datasets\n\`\`\`\n\nthen re-run \`npm run eval:longmemeval\`. To point at a file elsewhere, pass \`--dataset-path <file>\`.`,
      thresholds: {},
    }
  }

  const questionLimit = ctx.limit ?? defaultQuestionLimit(splitName)
  const totalRecords = await countTopLevelElements(filePath)
  const stride = Math.max(1, Math.floor(totalRecords / Math.max(1, questionLimit)))
  const questionCount = Math.min(questionLimit, totalRecords)
  // integrity is checked, not trusted: recompute the manifest hash from the
  // bytes on disk before reporting any number derived from them.
  const fileSha256 = await sha256File(filePath)
  const shaVerified = !split || split.sha256 === '' || fileSha256 === split.sha256
  if (!shaVerified) {
    notes.push(
      `SHA256 MISMATCH for ${split?.file}: manifest ${split?.sha256.slice(0, 16)}… vs file ` +
        `${fileSha256.slice(0, 16)}… — re-fetch with \`npm run eval:datasets -- --force\``
    )
  }
  notes.push(
    `dataset ${splitName}: ${questionCount} questions sampled from ${split?.file ?? filePath} ` +
      `(sha256 ${fileSha256.slice(0, 16)}…, ${split?.bytes ?? 'unknown'} bytes, manifest fetched ` +
      `${split?.fetched_at ?? 'n/a'}), streamed with stride ${stride} of ${totalRecords} records`
  )
  notes.push(
    'sampling: evenly spaced across the file (the file is grouped by question_type, so a head slice ' +
      'would report one type as the whole benchmark)'
  )
  notes.push(
    'ingest: one question at a time into its own namespace, torn down before the next; the DB never ' +
      'holds more than one haystack'
  )

  const contextBudgetChars = ctx.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS
  const checkpoint = new JsonlCheckpoint<QaRow>(
    ctx.checkpointPath ?? defaultCheckpointPath(splitName, readers)
  )
  const key = qaKey({
    split: splitName,
    datasetSha: fileSha256,
    readers: readers.map((r) => r.name),
    readerModel,
    judgeModel,
    budgetChars: contextBudgetChars,
    topK: READER_TOP_K,
  })

  const groundTruth = emptyGroundTruth()
  const schemaSample: LmeRecord[] = []
  const questionSummaries: Array<{ question_id: string; question_type: string; sessions: number }> = []
  const detailsByConfig = new Map<string, QueryDetail[]>(ctx.configs.map(([name]) => [name, []]))
  const ks = DEFAULT_KS
  let indexedSessions = 0
  let indexedChars = 0

  const harness = await EvalHarness.create({ seed: ctx.seed, vectors: ctx.vectors })
  try {
    async function* streamQuestions(): AsyncGenerator<QaQuestion> {
      for await (const entry of scanJsonArray(filePath, { limit: questionCount, stride })) {
        const record = entry.value as LmeRecord
        if (schemaSample.length < SCHEMA_SAMPLE) schemaSample.push(record)
        const built = recordToCorpus(record, entry.index, groundTruth)
        // a question with no resolvable target is not scored for retrieval, since a 0
        // would deflate every recall number), but it is still read and judged:
        // "no evidence session" is not the same as "no answer".
        const scorable = built.query.target_ids.length > 0

        const corpus: Corpus = {
          name: 'longmemeval',
          seed: ctx.seed,
          memories: built.memories,
          queries: [built.query],
        }
        await harness.seedCorpus(corpus, { mode: 'raw' })
        indexedSessions += built.memories.length
        indexedChars += built.memories.reduce((sum, m) => sum + m.content.length, 0)
        questionSummaries.push({
          question_id: record.question_id,
          question_type: record.question_type ?? 'unknown',
          sessions: built.memories.length,
        })

        if (scorable) {
          for (const [configName, patch] of ctx.configs) {
            const scored = await scoreQueries({
              harness,
              corpus,
              configOptions: patch.search,
              queries: [built.query],
              ks,
              limit: READ_LIMIT,
              tokenizer,
            })
            detailsByConfig.get(configName)!.push(scored.details[0])
          }
        }

        const contexts: ReaderContext[] = []
        if (qaReady) {
          for (const reader of readers) {
            contexts.push(
              await reader.build({
                question: record.question,
                questionDate: record.question_date,
                namespace: built.query.namespace,
                sessions: built.memories.map((m) => m.content),
                harness,
                tokenizer,
                budgetChars: contextBudgetChars,
                topK: READER_TOP_K,
              })
            )
          }
        }
        harness.dropNamespace(built.query.namespace)

        if (qaReady) {
          yield {
            question_id: record.question_id,
            question_type: record.question_type ?? 'unknown',
            question: record.question,
            gold_answer: record.answer,
            question_date: record.question_date,
            contexts: readers.map((reader, i) => ({
              reader: reader.name,
              blocks: contexts[i].blocks,
              chars: contexts[i].chars,
              tokens: contexts[i].tokens,
              retrievalMs: contexts[i].retrievalMs,
              note: contexts[i].note,
            })),
          }
        }
      }
    }

    const stream = streamQuestions()
    let qaOutput: Awaited<ReturnType<typeof runQa>> | null = null
    if (qaReady) {
      qaOutput = await runQa({
        questions: stream,
        readers,
        readerModel,
        judgeModel,
        concurrency: ctx.concurrency ?? DEFAULT_CONCURRENCY,
        checkpoint,
        key,
        costCeilingCalls: ctx.costCeilingCalls ?? DEFAULT_COST_CEILING_CALLS,
        confirmed: ctx.yes === true,
        totalQuestions: questionCount,
        gitSha: ctx.gitSha ?? '',
        tokenizer,
        log: ctx.log,
      })
    } else {
      for await (const question of stream) void question
    }

    const corpusHashValue = corpusHash(questionSummaries)
    const schemaCheck = checkSchema(schemaSample)
    const qaBlock: QaReportBlock = qaOutput
      ? describeQa(qaOutput, { readerModel, judgeModel, key, checkpoint })
      : { status: 'skipped', note: 'pass --qa to run the readers + judge' }
    if (qaOutput && qaOutput.rows.length > 0) {
      notes.push(
        `qa: ${Object.keys(qaBlock.readers ?? {}).length} reader(s) x ${qaBlock.questions_answered} question(s), ` +
          `${qaBlock.calls} calls; reader model ${readerModel}, judge model ${judgeModel}; ` +
          `reader prompt ${READER_PROMPT_VERSION}, judge prompt ${ANSCHECK_PROMPT_VERSION} (${ANSCHECK_SOURCE})`
      )
      notes.push(
        `qa resume: checkpoint ${checkpoint.path} (resumed ${qaBlock.resumed_questions} question(s), ` +
          `${qaBlock.resumed_rows} row(s))`
      )
      if ((qaBlock.failures?.length ?? 0) > 0) {
        notes.push(`qa failures: ${qaBlock.failures?.length} (see details.qa.failures)`)
      }
      if ((qaBlock.estimated_rows ?? 0) > 0) {
        notes.push(
          `qa tokens: ${qaBlock.estimated_rows} row(s) used tokenizer estimates instead of gateway usage`
        )
      }
      if ((qaBlock.fallback_judge_rows ?? 0) > 0) {
        notes.push(
          `qa judge: ${qaBlock.fallback_judge_rows} row(s) had an unknown question_type and used the ` +
            'generic fallback prompt'
        )
      }
      if (qaBlock.estimate) {
        notes.push(
          `qa cost estimate (before the first call): ${qaBlock.estimate.calls} calls, ` +
            `~${qaBlock.estimate.reader_input_tokens} reader input tokens, ` +
            `~${qaBlock.estimate.judge_input_tokens} judge input tokens, basis: ${qaBlock.estimate.basis}`
        )
      }
      if (qaBlock.mixed_git_sha) {
        notes.push(
          `qa resume MIXED CODE VERSIONS: checkpoint rows were written by more than one git sha ` +
            `(${(qaBlock.git_shas ?? []).join(', ')}); accuracy is a mix, re-run with a fresh ` +
            '--checkpoint to clean it'
        )
      }
    } else {
      notes.push(qaBlock.note ?? 'qa: no rows (every question was unscorable)')
    }

    const metrics: Record<string, unknown> = {}
    const thresholds: Record<string, Record<string, number>> = {}
    const timings: Record<string, TimingSummary> = {}
    if (qaOutput) Object.assign(timings, qaTimings(qaOutput.rows))

    for (const [configName] of ctx.configs) {
      const scored = detailsByConfig.get(configName) ?? []
      const block = aggregate(scored, ks)
      timings[`${configName}/all-queries`] = summarizeLatencies(scored.map((d) => d.latencyMs))
      metrics[configName] = {
        dataset: {
          split: splitName,
          file: split?.file ?? filePath,
          sha256_manifest: split?.sha256 ?? '',
          sha256_actual: fileSha256,
          sha256_verified: shaVerified,
          bytes: split?.bytes ?? null,
          record_count: split?.record_count ?? totalRecords,
          total_records_streamed: totalRecords,
          stride,
          sampled_questions: questionCount,
          questionFieldNote: 'retrieval-only metrics do not require credentials',
        },
        schemaCheck,
        questions: block.queries,
        processedQuestions: questionSummaries.length,
        groundTruth,
        indexedSessions,
        indexedChars,
        sessionRecall: {
          'recall@1': block['recall@1'] ?? 0,
          'recall@5': block['recall@5'] ?? 0,
          'recall@10': block['recall@10'] ?? 0,
          mrr: block.mrr,
          'ndcg@10': block['ndcg@10'] ?? 0,
          servedTokens: block.servedTokens,
        },
        overall: block,
        byQuestionType: groupByQuestionType(scored),
        qa: qaBlock,
      }
      thresholds[configName] = {
        ...topLineFromBlock(block, ks),
        ...(qaBlock.readers?.engram ? { qaAccuracy: qaBlock.readers.engram.accuracy } : {}),
      }
    }

    const markdown = renderLongMemEvalMarkdown({
      splitName,
      file: split?.file ?? filePath,
      split,
      questions: questionSummaries.length,
      unscorable: groundTruth.unscorable,
      indexedSessions,
      schemaCheck,
      metrics,
      configNames: ctx.configs.map(([name]) => name),
      timings,
      notes,
      qa: qaBlock,
    })

    return {
      result: {
        suite: 'longmemeval',
        header: ctx.buildHeader({
          suite: 'longmemeval',
          configs: ctx.configs.map(([name]) => name),
          seed: ctx.seed,
          corpusHash: corpusHashValue,
          vectorsAvailable: harness.vectorsAvailable,
          vectorMode: harness.vectorMode,
          now: harness.now,
          tokenizer,
          featureFlags,
        }),
        metrics,
        timings,
        details: [
          ...ctx.configs.map(([configName]) => ({
            config: configName,
            queries: detailsByConfig.get(configName) ?? [],
          })),
          ...(qaOutput ? [{ qa: { rows: qaOutput.rows, failures: qaOutput.failures } }] : []),
        ],
        notes: [...notes, `harness: ${describeHarness(harness)}`],
      },
      markdown,
      thresholds,
    }
  } finally {
    harness.dispose()
  }
}

/**
 * `--qa` preconditions, checked before any local work: a run that would spend
 * money must not discover at question 1 that it has no key or no pinned models.
 */
export function preflightQa(
  ctx: SuiteContext,
  readers: ReaderSpec[],
  readerModel: string,
  judgeModel: string
): boolean {
  if (!ctx.qa) return false
  const status = gatewayStatus(ctx.envFile)
  if (!status.configured) throw new EvalSetupError(qaMissingGateway(ctx.envFile))
  if (readerModel === '' || judgeModel === '') {
    throw new EvalSetupError(
      'qa: --reader-model and --judge-model are required with --qa — the judge is the measuring ' +
        'instrument, so the model that produced a verdict is pinned per run and recorded on every row'
    )
  }
  if (readers.length === 0) {
    throw new EvalSetupError('qa: no reader selected — pass --readers engram,full-context,naive-rag')
  }
  return true
}

export interface QaReportBlock {
  status: 'ok' | 'skipped'
  note?: string
  questions_answered?: number
  calls?: number
  failures?: Array<{ question_id: string; reader: string; message: string }>
  reader_model?: string
  judge_model?: string
  reader_prompt?: string
  judge_prompt?: string
  judge_source?: string
  checkpoint?: string
  key?: string
  resumed_questions?: number
  resumed_rows?: number
  estimated_rows?: number
  fallback_judge_rows?: number
  git_shas?: string[]
  mixed_git_sha?: boolean
  estimate?: CostEstimate | null
  readers?: Record<string, ReaderAggregate>
}

export function describeQa(
  output: Awaited<ReturnType<typeof runQa>>,
  meta: {
    readerModel: string
    judgeModel: string
    key: string
    checkpoint: JsonlCheckpoint<QaRow>
  }
): QaReportBlock {
  const rows = output.rows
  const shas = configShas(rows)
  const answered = new Set(rows.filter((r) => !r.resumed).map((r) => r.question_id))
  return {
    status: 'ok',
    questions_answered: answered.size,
    calls: output.calls,
    failures: output.failures,
    reader_model: meta.readerModel,
    judge_model: meta.judgeModel,
    reader_prompt: READER_PROMPT_VERSION,
    judge_prompt: ANSCHECK_PROMPT_VERSION,
    judge_source: ANSCHECK_SOURCE,
    checkpoint: meta.checkpoint.path,
    key: meta.key,
    resumed_questions: output.resumedQuestions,
    resumed_rows: rows.filter((r) => r.resumed).length,
    estimated_rows: rows.filter((r) => r.token_source === 'estimated').length,
    fallback_judge_rows: rows.filter((r) => r.judge_template === 'generic-fallback').length,
    git_shas: shas,
    mixed_git_sha: shas.length > 1,
    estimate: output.estimate,
    readers: aggregateQaRows(rows),
  }
}

function configShas(rows: QaRow[]): string[] {
  const shas = new Set<string>()
  for (const row of rows) {
    const sha = row.git_sha
    if (typeof sha === 'string' && sha !== '') shas.add(sha.slice(0, 12))
  }
  return [...shas]
}


interface QuestionTypeBlock {
  questions: number
  'recall@1': number
  'recall@5': number
  'recall@10': number
  mrr: number
}

/** per-question-type retrieval breakdown, from the scored details */
export function groupByQuestionType(
  details: Array<{ id: string; kind: string; recall: Record<string, number>; mrr: number }>
): Record<string, QuestionTypeBlock> {
  const buckets = new Map<string, Array<{ recall: Record<string, number>; mrr: number }>>()
  for (const detail of details) {
    const list = buckets.get(detail.kind) ?? []
    list.push({ recall: detail.recall, mrr: detail.mrr })
    buckets.set(detail.kind, list)
  }
  const meanOf = (values: number[]): number =>
    values.length === 0 ? 0 : round3(values.reduce((a, b) => a + b, 0) / values.length)
  const out: Record<string, QuestionTypeBlock> = {}
  for (const [type, values] of [...buckets.entries()].sort()) {
    out[type] = {
      questions: values.length,
      'recall@1': meanOf(values.map((v) => v.recall['recall@1'] ?? 0)),
      'recall@5': meanOf(values.map((v) => v.recall['recall@5'] ?? 0)),
      'recall@10': meanOf(values.map((v) => v.recall['recall@10'] ?? 0)),
      mrr: meanOf(values.map((v) => v.mrr)),
    }
  }
  return out
}

export function renderLongMemEvalMarkdown(input: {
  splitName: string
  file: string
  split: ManifestSplit | null
  questions: number
  unscorable: number
  indexedSessions: number
  schemaCheck: SchemaCheck
  metrics: Record<string, unknown>
  configNames: string[]
  timings: Record<string, TimingSummary>
  notes: string[]
  qa: QaReportBlock
}): string {
  const rows: Array<Array<string | number>> = []
  for (const config of input.configNames) {
    const entry = input.metrics[config] as {
      sessionRecall: Record<string, number>
      questions: number
      indexedSessions: number
    }
    if (!entry) continue
    rows.push([
      config,
      entry.questions,
      entry.indexedSessions,
      entry.sessionRecall['recall@5'] ?? 0,
      entry.sessionRecall['recall@10'] ?? 0,
      entry.sessionRecall.mrr,
      entry.sessionRecall.servedTokens,
    ])
  }

  const schemaRows: Array<[string, string]> = [
    ['records checked', String(input.schemaCheck.checked)],
    ['record fields present', input.schemaCheck.presentFields.join(', ') || '(none)'],
    ['session message fields', input.schemaCheck.sessionMessageFields.join(', ') || '(none)'],
    ['per-message has_answer', String(input.schemaCheck.hasAnswerField)],
    ['answer_session_ids', String(input.schemaCheck.answerSessionIdsField)],
    ['missing required fields', input.schemaCheck.missing.join(', ') || '(none)'],
  ]

  const groundTruthRows = (() => {
    const entry = input.metrics[input.configNames[0]] as {
      groundTruth?: GroundTruthStats
    }
    const g = entry?.groundTruth
    if (!g) return [['(unavailable)', 0]]
    return [
      ['answer_session_ids', g.fromAnswerSessionIds],
      ['per-message has_answer', g.fromHasAnswer],
      ['both agree', g.fromBoth],
      ['unscorable (excluded from metrics)', g.unscorable],
      ['answer_session_ids not in haystack', g.unresolvedAnswerSessionIds],
    ] as Array<[string, number]>
  })()

  const qa = input.qa
  const sections: string[] = [
    `Split **${input.splitName}** (\`${input.file}\`, ${input.split?.bytes ?? 'unknown'} bytes, ` +
      `sha256 ${(input.split?.sha256 ?? '').slice(0, 16)}…, fetched ${input.split?.fetched_at ?? 'n/a'}).`,
    `Session-level retrieval, streamed per question; ${input.questions} questions processed, ` +
      `${input.unscorable} without a resolvable target (read but not scored), over ` +
      `${input.indexedSessions} session memories (each question ingested and torn down on its own).`,
    markdownTable({
      columns: ['config', 'questions', 'sessions', 'recall@5', 'recall@10', 'mrr', 'servedTokens'],
      rows,
    }),
  ]

  if (qa.status === 'ok') {
    sections.push(
      `### reader comparison (accuracy vs cost, same questions and same judge)\n\n${markdownTable({
        columns: [
          'reader',
          'graded',
          'accuracy',
          'ctx tokens/q',
          'reader in tokens/q',
          'reader out tokens/q',
          'judge in tokens/q',
        ],
        rows: Object.entries(qa.readers ?? {}).map(([name, agg]) => [
          name,
          agg.graded,
          agg.accuracy,
          agg.avg_context_tokens,
          agg.avg_input_tokens,
          agg.avg_output_tokens,
          agg.avg_judge_input_tokens,
        ]),
      })}\n\nEach row is one point on the (accuracy, reader input tokens per question) plane; ` +
        '`full-context` is the unbudgeted ceiling and `naive-rag` the no-engram floor. ' +
        'Latency lives in the wall-clock table at the end of this report (`qa/<reader>/reader-call`).'
    )
    const typeRows: Array<Array<string | number>> = []
    for (const [name, agg] of Object.entries(qa.readers ?? {})) {
      for (const [type, stat] of Object.entries(agg.by_question_type)) {
        typeRows.push([name, type, stat.graded, stat.accuracy])
      }
    }
    sections.push(
      `### accuracy by question_type\n\n${markdownTable({
        columns: ['reader', 'question_type', 'graded', 'accuracy'],
        rows: typeRows,
      })}`
    )
    sections.push(
      `### judge and cost\n\n${markdownTable({
        columns: ['field', 'value'],
        rows: [
          ['reader model', qa.reader_model ?? ''],
          ['judge model', qa.judge_model ?? ''],
          ['reader prompt', qa.reader_prompt ?? ''],
          ['judge prompt', qa.judge_prompt ?? ''],
          ['judge source', qa.judge_source ?? ''],
          ['calls', qa.calls ?? 0],
          ['questions answered', qa.questions_answered ?? 0],
          ['resumed questions', qa.resumed_questions ?? 0],
          ['estimated-token rows', qa.estimated_rows ?? 0],
          ['generic-fallback judge rows', qa.fallback_judge_rows ?? 0],
          ['checkpoint', qa.checkpoint ?? ''],
          ['checkpoint key', qa.key ?? ''],
        ],
      })}` +
        (qa.estimate
          ? `\n\nPre-run estimate: ${qa.estimate.calls} calls, ~${qa.estimate.reader_input_tokens} ` +
            `reader input tokens, ~${qa.estimate.judge_input_tokens} judge input tokens ` +
            `(${qa.estimate.basis}).`
          : '')
    )
  } else {
    sections.push(`QA skipped: ${qa.note ?? 'not requested'}.`)
  }

  sections.push(
    `### ground truth sources\n\n${markdownTable({
      columns: ['source', 'questions'],
      rows: groundTruthRows,
    })}`,
    `### schema verification (read from the file, not assumed)\n\n${markdownTable({
      columns: ['field', 'observed'],
      rows: schemaRows,
    })}`,
    `### latency (wall clock; not covered by the determinism guarantee)\n\n${renderTimings(
      input.timings
    )}`
  )
  return sections.join('\n\n')
}
