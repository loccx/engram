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
// naive-rag the lexical floor; --systems swaps either for another registered memory
// system, or `mcp:<adapter-config>` for any server behind the adapter, on the same
// questions, corpus, budget, top-k and judge.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { countTopLevelElements, scanJsonArray, sha256File } from '../lib/json-stream.js'
import { EvalHarness } from '../lib/harness.js'
import { corpusHash, resolveTokenizer, round3, summarizeLatencies } from '../lib/metrics.js'
import { markdownTable, renderComparisonReport, REPO_ROOT, renderTimings } from '../lib/report.js'
import { DEFAULT_KS, MEASUREMENT_DEFAULTS, aggregate, scoreQueries, type QueryDetail } from '../lib/score.js'
import { topLineFromBlock } from '../lib/thresholds.js'
import { gatewayStatus, qaMissingGateway } from '../lib/llm.js'
import { EvalSetupError } from '../lib/errors.js'
import { JsonlCheckpoint } from '../lib/checkpoint.js'
import { embeddingCacheReport, formatEmbeddingCacheReport } from '../../src/embeddings/cache.js'
import { ANSCHECK_PROMPT_VERSION, ANSCHECK_SOURCE } from '../lib/judge.js'
import {
  DEFAULT_CONTEXT_BUDGET_CHARS,
  READER_PROMPT_VERSION,
  readerFor,
  type ReaderContext,
} from '../lib/readers.js'
import {
  checkSystemSpecs,
  closeAll,
  createSystems,
  requestedSystemSpecs,
  runSystemQuestion,
  systemKey,
  type MemorySystem,
  toSystemSessions,
} from '../lib/systems.js'
import {
  aggregateSystems,
  renderSystemsSection,
  scoreSystemQuery,
  storedVectorsCell,
} from '../lib/systems-score.js'
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_COST_CEILING_CALLS,
  aggregateQaRows,
  qaKey,
  qaTimings,
  runQa,
  vectorIdentity,
  type CostEstimate,
  type QaForeignKey,
  type QaQuestion,
  type QaRow,
  type ReaderAggregate,
} from '../lib/qa-run.js'
import {
  answerLatency,
  compareSystems,
  type ComparisonReport,
  type LatencyPercentiles,
  type StatsRow,
} from '../lib/stats.js'
import { describeHarness } from './retrieval.js'
import type { SuiteContext, SuiteOutput } from './types.js'
import type {
  Corpus,
  CorpusMemory,
  CorpusQuery,
  SystemAggregate,
  SystemQueryScore,
  TimingSummary,
} from '../lib/types.js'

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
 * when its has_answer flag is set or its id appears in answer_session_ids. the memory
 * also carries the session's turns; the flags never reach the system, only the bounds.
 */
export function recordToCorpus(
  record: LmeRecord,
  recordIndex: number,
  stats: GroundTruthStats
): { memories: CorpusMemory[]; query: CorpusQuery; turnTargets: string[] } {
  const sessions = record.haystack_sessions ?? []
  const dates = record.haystack_dates ?? []
  const sessionIds = record.haystack_session_ids ?? []
  const answerIds = new Set(record.answer_session_ids ?? [])
  const namespace = `/longmemeval/${record.question_id}`
  const memories: CorpusMemory[] = []
  const targets: string[] = []
  const turnTargets: string[] = []
  stats.questions++

  for (const answerId of answerIds) {
    if (!sessionIds.includes(answerId)) stats.unresolvedAnswerSessionIds++
  }

  let viaIds = false
  let viaFlags = false
  // the newest evidence session: a knowledge-update answer has to end on it. the
  // haystack is NOT chronological (checked on the s split: 0 of 78 knowledge-update
  // haystacks are date-ordered), so this comes from the dates, never from position.
  let latestTargetId: string | null = null
  let latestTargetAt = Number.NEGATIVE_INFINITY

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
    if (hasAnswer || fromId) {
      targets.push(id)
      const at = parseLmeDate(dates[sessionIndex]) ?? CORPUS_BASE + (recordIndex * 64 + sessionIndex) * HOUR
      if (latestTargetId === null || at > latestTargetAt) {
        latestTargetId = id
        latestTargetAt = at
      }
    }
    session.forEach((message, turnIndex) => {
      // the turn the answer sits in, so a snippet system is scored on the snippet
      if (message.has_answer === true) turnTargets.push(`${id}#${turnIndex}`)
    })
    memories.push({
      id,
      namespace,
      content,
      type: 'note',
      created_at: parseLmeDate(dates[sessionIndex]) ?? CORPUS_BASE + (recordIndex * 64 + sessionIndex) * HOUR,
      tags: ['longmemeval', record.question_type ?? 'unknown'],
      turns: session.map((message) => ({
        role: message.role ?? 'unknown',
        text: message.content ?? '',
      })),
    })
  })

  if (viaIds) stats.fromAnswerSessionIds++
  if (viaFlags) stats.fromHasAnswer++
  if (viaIds && viaFlags) stats.fromBoth++
  if (targets.length === 0) stats.unscorable++

  return {
    memories,
    turnTargets,
    query: {
      id: `lme-q-${record.question_id}`,
      query: record.question,
      namespace,
      target_ids: targets,
      kind: record.question_type ?? 'unknown',
      ...(latestTargetId ? { latest_target: latestTargetId } : {}),
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

// which questions a run asks, and how they were drawn. the dataset sha covers the bytes,
// not the selection: a 60-question slice of a 500-question file and the whole file are
// different runs, and neither resumes the other. a type filter keeps every match in file
// order, so the stride does not apply to it.
export function questionSetIdentity(input: {
  questionTypes: string[]
  limit: number
  stride: number
}): string {
  const scope =
    input.questionTypes.length === 0
      ? 'all'
      : `types=${[...input.questionTypes].sort().join(',')}`
  const limit = Number.isFinite(input.limit) ? `limit=${input.limit}` : 'limit=all'
  const stride = input.questionTypes.length === 0 ? `stride=${input.stride}` : 'stride=n/a'
  return `${scope},${limit},${stride}`
}

/** the default checkpoint: one file per split and system set */
export function defaultCheckpointPath(splitName: string, systems: string[]): string {
  const slug = systems.map((name) => name.replace(/[^a-zA-Z0-9._-]+/g, '-')).join('+')
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
  const systemSpecs = requestedSystemSpecs(ctx)
  checkSystemSpecs(systemSpecs)
  const readerModel = ctx.readerModel ?? ''
  const judgeModel = ctx.judgeModel ?? ''
  const qaReady = preflightQa(ctx, systemSpecs, readerModel, judgeModel)

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

  const questionTypes = (ctx.questionTypes ?? []).map((type) => type.trim()).filter(Boolean)
  const typeFilter = questionTypes.length > 0 ? new Set(questionTypes) : null
  const questionLimit = ctx.limit ?? defaultQuestionLimit(splitName)
  const totalRecords = await countTopLevelElements(filePath)
  const stride = Math.max(1, Math.floor(totalRecords / Math.max(1, questionLimit)))
  // a type filter keeps matches wherever they sit in the file, so `--limit` counts
  // matching questions and the whole file is scanned in order
  const questionCount = typeFilter
    ? ctx.limit ?? Number.POSITIVE_INFINITY
    : Math.min(questionLimit, totalRecords)
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
    `dataset ${splitName}: ` +
      (typeFilter
        ? `question_type ${questionTypes.join(', ')} of ${split?.file ?? filePath} ` +
          `(sha256 ${fileSha256.slice(0, 16)}…, ${split?.bytes ?? 'unknown'} bytes, manifest fetched ` +
          `${split?.fetched_at ?? 'n/a'}), every match in file order`
        : `${questionCount} questions sampled from ${split?.file ?? filePath} ` +
          `(sha256 ${fileSha256.slice(0, 16)}…, ${split?.bytes ?? 'unknown'} bytes, manifest fetched ` +
          `${split?.fetched_at ?? 'n/a'}), streamed with stride ${stride} of ${totalRecords} records`)
  )
  notes.push(
    typeFilter
      ? 'sampling: a question_type filter keeps every matching record, so no stride applies'
      : 'sampling: evenly spaced across the file (the file is grouped by question_type, so a head slice ' +
        'would report one type as the whole benchmark)'
  )
  notes.push(
    'ingest: one question at a time into its own namespace, torn down before the next; the DB never ' +
      'holds more than one haystack'
  )

  const contextBudgetChars = ctx.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS
  const groundTruth = emptyGroundTruth()
  const schemaSample: LmeRecord[] = []
  const questionSummaries: Array<{ question_id: string; question_type: string; sessions: number }> = []
  const detailsByConfig = new Map<string, QueryDetail[]>(ctx.configs.map(([name]) => [name, []]))
  const systemScores: SystemQueryScore[] = []
  const ks = DEFAULT_KS
  let indexedSessions = 0
  let indexedChars = 0

  const harness = await EvalHarness.create({ seed: ctx.seed, vectors: ctx.vectors })
  let systems: MemorySystem[] = []
  try {
    systems =
      systemSpecs.length === 0
        ? []
        : await createSystems(systemSpecs, { harness, topK: READER_TOP_K, seed: ctx.seed })
    const readers = systems.map(readerFor)
    const checkpoint = new JsonlCheckpoint<QaRow>(
      ctx.checkpointPath ?? defaultCheckpointPath(splitName, systems.map((system) => system.name))
    )
    // the regime that is really in effect, not the flag that was typed: a `cached`
    // request on a machine without the model runs FTS, and resuming it as if it were a
    // vector run would mix two regimes into one number
    const vectorRegime = vectorIdentity(harness.vectorMode, {
      vectorsAvailable: harness.vectorsAvailable,
      modelCacheReady: harness.modelCacheReady,
    })
    const questionSetId = questionSetIdentity({
      questionTypes,
      limit: questionCount,
      stride,
    })
    const key = qaKey({
      split: splitName,
      datasetSha: fileSha256,
      systems: systems.map(systemKey),
      readerModel,
      judgeModel,
      budgetChars: contextBudgetChars,
      topK: READER_TOP_K,
      vectors: vectorRegime,
      questionSet: questionSetId,
      engineRevision: ctx.gitSha ?? '',
    })

    async function* streamQuestions(): AsyncGenerator<QaQuestion> {
      let matched = 0
      for await (const entry of scanJsonArray(filePath, {
        ...(typeFilter ? {} : { limit: questionCount, stride }),
      })) {
        const record = entry.value as LmeRecord
        if (typeFilter && !typeFilter.has(record.question_type ?? 'unknown')) continue
        if (matched >= questionCount) break
        matched++
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
        // the engine systems read these rows; with vectors on, they must carry vectors,
        // or the report would measure the lexical channel while claiming the vector one
        await harness.seedCorpus(corpus, { mode: 'raw', embed: harness.vectorsAvailable })
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

        const sessions = toSystemSessions(built.memories)
        const contexts: ReaderContext[] = []
        for (let i = 0; i < systems.length; i++) {
          const system = systems[i]
          const retrieved = await runSystemQuestion({
            harness,
            system,
            namespace: built.query.namespace,
            sessions,
            query: record.question,
            budgetChars: contextBudgetChars,
          })
          if (scorable) {
            systemScores.push(
              scoreSystemQuery({
                system: system.name,
                queryId: record.question_id,
                kind: record.question_type ?? 'unknown',
                targets: built.query.target_ids,
                turnTargets: built.turnTargets,
                result: retrieved,
                ks,
                tokenizer,
              })
            )
          }
          if (qaReady) {
            contexts.push(
              await readers[i].build({
                question: record.question,
                questionDate: record.question_date,
                namespace: built.query.namespace,
                budgetChars: contextBudgetChars,
                tokenizer,
                retrieved,
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
              system: contexts[i].system,
              adapter_kind: contexts[i].adapterKind,
              adapter_config_hash: contexts[i].adapterConfigHash,
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
        totalQuestions: Number.isFinite(questionCount) ? questionCount : totalRecords,
        gitSha: ctx.gitSha ?? '',
        vectors: vectorRegime,
        questionSet: questionSetId,
        tokenizer,
        log: ctx.log,
      })
    } else {
      for await (const question of stream) void question
    }

    if (typeFilter) {
      notes.push(
        `question_type filter: kept ${questionSummaries.length} of ${totalRecords} record(s) with type ` +
          `${questionTypes.join(', ')}`
      )
    }

    const corpusHashValue = corpusHash(questionSummaries)
    const schemaCheck = checkSchema(schemaSample)
    const qaBlock: QaReportBlock = qaOutput
      ? describeQa(qaOutput, { readerModel, judgeModel, key, checkpoint })
      : { status: 'skipped', note: 'pass --qa to run the readers + judge' }
    const qaRows = qaOutput?.rows ?? []
    // one paired block for the whole reader set: the same question ids, the same judge,
    // and the guard refuses the comparison when the rows disagree on that
    const comparisonLatencies: Record<string, LatencyPercentiles> = {}
    if (qaRows.length > 0 && readers.length > 1) {
      qaBlock.comparison = compareSystems({
        systems: readers.map((reader) => ({
          name: reader.name,
          rows: qaStatsRows(qaRows, reader.name),
        })),
        runIdentity: {
          dataset_sha: fileSha256,
          reader_model: readerModel,
          judge_model: judgeModel,
          reader_prompt: READER_PROMPT_VERSION,
          judge_prompt: ANSCHECK_PROMPT_VERSION,
          budget_chars: contextBudgetChars,
          vectors: vectorRegime,
          question_set: questionSetId,
          // an unidentified checkout cannot prove two row sets came from the same code,
          // so it stays undeclared and the guard withholds the comparison with that reason
          ...(ctx.gitSha ? { engine_revision: ctx.gitSha } : {}),
        },
        seed: ctx.seed,
      })
      for (const reader of readers) {
        const summary = answerLatency(qaStatsRows(qaRows, reader.name))
        if (summary) comparisonLatencies[reader.name] = summary
      }
      notes.push(
        `qa comparison: ${qaBlock.comparison.pairs.length} pair(s) over ` +
          `${qaBlock.comparison.n_paired} shared question id(s), exact mcnemar + ` +
          `${qaBlock.comparison.resamples}-resample paired bootstrap (seed ${qaBlock.comparison.seed}); ` +
          `comparable: ${qaBlock.comparison.comparable}`
      )
      notes.push(
        'qa comparison identity: the rows were measured under one vector regime, one question ' +
          `set and one code revision — vectors=${vectorRegime}, questions=${questionSetId}, ` +
          `engine=${ctx.gitSha || 'unknown'}`
      )
      if (qaBlock.comparison.interventions.length > 0) {
        notes.push(
          `qa comparison intervention: a cross-revision comparison was declared — ` +
            qaBlock.comparison.interventions.join('; ')
        )
      }
      if (!qaBlock.comparison.comparable) {
        notes.push(
          `qa comparison withheld: ${qaBlock.comparison.differences.join('; ')} — no delta is ` +
            'printed for rows that disagree on the fields a comparison stands on'
        )
      }
    }
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
      if ((qaBlock.foreign_keys?.length ?? 0) > 0) {
        const kept = qaBlock.foreign_keys!.reduce((sum, entry) => sum + entry.rows, 0)
        notes.push(
        `qa resume: ${kept} checkpoint row(s) have an unverified or different identity and were ` +
            `NOT reused (${qaBlock.foreign_keys!
              .map((entry) => entry.differences.join('; ') || entry.key)
              .join(' | ')}); they are kept, and this run appends its own rows under the current key`
        )
      }
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

    const cacheReport = embeddingCacheReport()
    if (cacheReport.backend !== 'off' || cacheReport.stats.hits + cacheReport.stats.misses > 0) {
      notes.push(formatEmbeddingCacheReport(cacheReport))
    }

    const systemAggregates = aggregateSystems({ systems, scores: systemScores, ks })
    if (systems.length > 0) {
      notes.push(
        `vectors: --vectors ${ctx.vectors} -> ${vectorRegime} (model cache ready: ` +
          `${harness.modelCacheReady}) — stored/rows per ` +
          `system: ${systems
            .map((system) => `${system.name} ${storedVectorsCell(systemAggregates[system.name])}`)
            .join('; ')}`
      )
      const silentlyLexical = systems.filter((system) => {
        const aggregate = systemAggregates[system.name]
        if (!aggregate || aggregate.lexical_only) return false
        const storedVectors = aggregate.stored_vectors
        if (!storedVectors) return false
        const rows = storedVectors.memories.rows + storedVectors.episodes.rows
        const vectors = storedVectors.memories.vectors + storedVectors.episodes.vectors
        return rows > 0 && vectors === 0
      })
      if (silentlyLexical.length > 0 && ctx.vectors !== 'fts' && harness.vectorsAvailable) {
        notes.push(
          `vectors: ${silentlyLexical.map((system) => system.name).join(', ')} stored 0 vectors while ` +
            `--vectors ${ctx.vectors} was in effect — its vector channel was NOT measured. fix: seed the ` +
            'raw path with `{ embed: true }`, or mark the system lexical-only by design'
        )
      }
      notes.push(
        `systems: ${systems
          .map(
            (system) =>
              `${system.name} (${system.adapter.kind}` +
              `${system.adapter.configHash === '' ? '' : ` ${system.adapter.configHash.slice(0, 8)}`})`
          )
          .join(', ')}`
      )
      notes.push(
        'systems comparison: one question set, one per-question corpus, one context budget and one '
          + 'top-k for every system, one reader model and one judge per run; `coverage` asks whether '
          + 'the target is anywhere in the served context (the unbudgeted ceiling scores 1 by '
          + 'construction), `recall@k` cuts that list at k, so a system serving more than k items is '
          + 'scored on its ranking'
      )
      notes.push(
        'systems comparison: a session-granularity system serves whole sessions, so its served/q '
          + 'and sessions/q are the same number and `evid-turn cov` is `-`; a snippet system serves '
          + 'turns, so `served/q` counts snippets and `recall@k`/`mrr` are over snippet lists, not '
          + 'session lists. read `coverage`, `sessions/q` and, with --qa, accuracy across the two'
      )
      notes.push(
        'systems comparison: `evid-turn cov` is the share of scored questions where a served '
          + 'snippet landed on a message the dataset flags `has_answer`; questions with no flagged '
          + 'message are out of that number, see `evidence_turn_scored`'
      )
      notes.push(
        'systems isolation: the question namespace is shared, every namespace below it is dropped '
          + 'before and after each system, so a system answers over the same db state alone or in any set'
      )
    }

    const metrics: Record<string, unknown> = {}
    const thresholds: Record<string, Record<string, number>> = {}
    const timings: Record<string, TimingSummary> = {}
    if (qaOutput) Object.assign(timings, qaTimings(qaOutput.rows))
    for (const system of systems) {
      timings[`systems/${system.name}/retrieve`] = summarizeLatencies(
        systemScores.filter((score) => score.system === system.name).map((score) => score.retrievalMs)
      )
    }
    if (systems.length > 0) metrics.systems = systemAggregates

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
          sampled_questions: Number.isFinite(questionCount) ? questionCount : questionSummaries.length,
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
      systems: systemAggregates,
      comparisonLatencies,
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
          ...(systems.length > 0 ? [{ systems: { scores: systemScores } }] : []),
        ],
        notes: [...notes, `harness: ${describeHarness(harness)}`],
      },
      markdown,
      thresholds,
    }
  } finally {
    await closeAll(systems)
    harness.dispose()
  }
}

/**
 * `--qa` preconditions, checked before any local work: a run that would spend
 * money must not discover at question 1 that it has no key or no pinned models.
 */
export function preflightQa(
  ctx: SuiteContext,
  systemSpecs: string[],
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
  if (systemSpecs.length === 0) {
    throw new EvalSetupError(
      'qa: no system selected — pass --systems engram,full-context,naive-rag or mcp:<config-path>'
    )
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
  /** checkpoint rows under another run identity: kept, never reused */
  foreign_keys?: QaForeignKey[]
  git_shas?: string[]
  mixed_git_sha?: boolean
  estimate?: CostEstimate | null
  readers?: Record<string, ReaderAggregate>
  /** paired stats over the readers: same question ids, same judge, or withheld */
  comparison?: ComparisonReport
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
    foreign_keys: output.foreignKeys,
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
  /** share of questions whose newest evidence session appears anywhere in the list */
  latestServed: number
  /** share of questions that rank the newest evidence session first */
  latestAt1: number
}

/** per-question-type retrieval breakdown, from the scored details */
export function groupByQuestionType(
  details: Array<{
    id: string
    kind: string
    recall: Record<string, number>
    mrr: number
    latestTarget?: string
    latestTargetRank: number | null
  }>
): Record<string, QuestionTypeBlock> {
  const buckets = new Map<
    string,
    Array<{
      recall: Record<string, number>
      mrr: number
      latestTarget?: string
      latestTargetRank: number | null
    }>
  >()
  for (const detail of details) {
    const list = buckets.get(detail.kind) ?? []
    list.push({
      recall: detail.recall,
      mrr: detail.mrr,
      latestTarget: detail.latestTarget,
      latestTargetRank: detail.latestTargetRank,
    })
    buckets.set(detail.kind, list)
  }
  const meanOf = (values: number[]): number =>
    values.length === 0 ? 0 : round3(values.reduce((a, b) => a + b, 0) / values.length)
  const out: Record<string, QuestionTypeBlock> = {}
  for (const [type, values] of [...buckets.entries()].sort()) {
    const withLatest = values.filter((v) => v.latestTarget !== undefined)
    out[type] = {
      questions: values.length,
      'recall@1': meanOf(values.map((v) => v.recall['recall@1'] ?? 0)),
      'recall@5': meanOf(values.map((v) => v.recall['recall@5'] ?? 0)),
      'recall@10': meanOf(values.map((v) => v.recall['recall@10'] ?? 0)),
      mrr: meanOf(values.map((v) => v.mrr)),
      latestServed: meanOf(withLatest.map((v) => (v.latestTargetRank === null ? 0 : 1))),
      latestAt1: meanOf(withLatest.map((v) => (v.latestTargetRank === 1 ? 1 : 0))),
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
  systems: Record<string, SystemAggregate>
  /** wall clock per system for the pareto table, kept out of the metrics block */
  comparisonLatencies?: Record<string, LatencyPercentiles>
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

  const typeRows: Array<Array<string | number>> = []
  for (const config of input.configNames) {
    const entry = input.metrics[config] as
      | { byQuestionType?: Record<string, QuestionTypeBlock> }
      | undefined
    for (const [type, block] of Object.entries(entry?.byQuestionType ?? {})) {
      typeRows.push([
        config,
        type,
        block.questions,
        block['recall@1'],
        block['recall@5'],
        block.mrr,
        block.latestServed,
        block.latestAt1,
      ])
    }
  }
  if (typeRows.length > 0) {
    sections.push(
      `### retrieval by question_type\n\n${markdownTable({
        columns: ['config', 'question_type', 'questions', 'recall@1', 'recall@5', 'mrr', 'latestServed', 'latestAt1'],
        rows: typeRows,
      })}\n\n\`latestServed\`/\`latestAt1\` ask whether the newest evidence session is in the served list, and first. \`recall@k\` counts every evidence session equally, so serving an older one alongside the update still scores — for a knowledge-update question that is the failure mode (the answer session that first stated the value is usually also an evidence session).`
    )
  }

  if (Object.keys(input.systems).length > 0) {
    sections.push(
      `### memory systems (one question set, one budget, one top-k)\n\n${renderSystemsSection({
        systems: input.systems,
        ks: DEFAULT_KS,
      })}\n\n\`coverage\` counts a question when a target is anywhere in the context the system ` +
        'served, so the unbudgeted `full-context` ceiling scores 1 and the column reads as packing ' +
        'quality under the shared budget. `recall@k` and `mrr` cut and order that served list, so a ' +
        'system that serves more than k items is scored on its ranking. Per-system retrieval latency ' +
        'is in the wall-clock table below (`systems/<name>/retrieve`).'
    )
  }

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
  // last, because the pareto rows carry wall-clock latency: everything above the
  // latency heading stays a pure function of the rows
  if (qa.status === 'ok' && qa.comparison) {
    sections.push(
      renderComparisonReport(qa.comparison, { latencies: input.comparisonLatencies })
    )
  }
  return sections.join('\n\n')
}

/** one reader's rows, in the shape the paired stats read */
function qaStatsRows(rows: QaRow[], reader: string): StatsRow[] {
  return rows.filter((row) => row.reader === reader).map(statsRow)
}

function statsRow(row: QaRow): StatsRow {
  const out: StatsRow = {
    question_id: row.question_id,
    question_type: row.question_type,
    correct: row.correct,
    context_tokens: row.context_tokens,
    input_tokens: row.input_tokens,
    retrieval_ms: row.retrieval_ms,
    reader_ms: row.reader_ms,
    reader_model: row.reader_model,
    judge_model: row.judge_model,
  }
  // the identity travels with the row, so a row set that disagrees with itself about the
  // regime, the sample or the code revision is refused instead of compared
  if (typeof row.vectors === 'string' && row.vectors !== '') out.vectors = row.vectors
  if (typeof row.question_set === 'string' && row.question_set !== '') {
    out.question_set = row.question_set
  }
  if (typeof row.git_sha === 'string' && row.git_sha !== '') out.engine_revision = row.git_sha
  // write-time cost lands on the row only when the suite that owns ingest measures it
  if (typeof row.write_llm_calls === 'number') out.write_llm_calls = row.write_llm_calls
  if (typeof row.write_llm_tokens === 'number') out.write_llm_tokens = row.write_llm_tokens
  return out
}
