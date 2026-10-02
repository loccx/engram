// locomo suite: ten long multi-session conversations with dialog-level evidence ids, five
// question categories including an adversarial one. retrieval-only mode scores the
// evidence ids (recall@k, mrr, ndcg per category); --qa runs the readers on the official
// locomo prompts and scores with the official f1, so a number here is comparable with a
// published one to the same degree the reader frame matches theirs.
// the data is cc by-nc 4.0, so it is fetched into the gitignored eval/datasets and never
// committed; a missing file is a setup refusal with the fetch command, not an empty run.
import { existsSync, readFileSync } from 'node:fs'
import { DatasetMissingError } from '../lib/errors.js'
import { EvalHarness } from '../lib/harness.js'
import { sha256File } from '../lib/json-stream.js'
import { corpusHash, resolveTokenizer, summarizeLatencies } from '../lib/metrics.js'
import { markdownTable, renderTimings } from '../lib/report.js'
import { DEFAULT_KS, MEASUREMENT_DEFAULTS, aggregate, scoreQueries, type QueryDetail } from '../lib/score.js'
import { topLineFromBlock } from '../lib/thresholds.js'
import { JsonlCheckpoint } from '../lib/checkpoint.js'
import { DEFAULT_CONTEXT_BUDGET_CHARS, readerFor, type ReaderContext } from '../lib/readers.js'
import {
  checkSystemSpecs,
  closeAll,
  createSystems,
  requestedSystemSpecs,
  retrieveEachSystem,
  systemKey,
  toSystemSessions,
  type MemorySystem,
} from '../lib/systems.js'
import {
  DEFAULT_BENCH_CONCURRENCY,
  DEFAULT_BENCH_COST_CEILING_CALLS,
  benchQaKey,
  benchQaTimings,
  benchVectorIdentity,
  describeBenchQa,
  preflightBenchQa,
  runBenchQa,
  selectionIdentity,
  type BenchQaBlock,
  type BenchQaRow,
  type BenchQuestion,
  type BenchScorer,
} from '../lib/bench-qa.js'
import {
  LOCOMO_CATEGORY_NAMES,
  LOCOMO_PROMPT_SOURCE,
  LOCOMO_PROMPT_VERSION,
  LOCOMO_QA_PROMPT,
  LOCOMO_QA_PROMPT_CAT_5,
  LOCOMO_SCORER_NAME,
  LOCOMO_SCORER_SOURCE,
  LOCOMO_SCORER_VERSION,
  cat5Answer,
  cat5Flip,
  cat5Question,
  goldAnswer,
  scoreLocomo,
  type LocomoQa,
} from '../lib/locomo-score.js'
import {
  DATASETS_DIR,
  datasetEntry,
  datasetFileEntry,
  datasetFilePath,
  fetchHint,
  DATASET_MANIFEST_PATH,
} from '../lib/datasets.js'
import { describeHarness } from './retrieval.js'
import type { SuiteContext, SuiteOutput } from './types.js'
import type { CorpusMemory, CorpusQuery, TimingSummary } from '../lib/types.js'
import type { QaContextPlan } from '../lib/qa-run.js'

export const LOCOMO_DATASET_ID = 'locomo'
export const LOCOMO_FILE = 'locomo10.json'
export const LOCOMO_URL = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json'
/** the released file is non-commercial: fetched into the gitignored eval/datasets only */
export const LOCOMO_LICENSE = 'CC-BY-NC-4.0'
/** dialog-level retrieval depth; the paper's rag runs default to top-k 5 */
export const LOCOMO_READER_TOP_K = 10
/** the official single-question run asks for 32 completion tokens */
export const LOCOMO_MAX_TOKENS = 32
const READ_LIMIT = MEASUREMENT_DEFAULTS.limit ?? 10
const HOUR = 3_600_000
const CORPUS_BASE = 1_700_000_000_000

export interface LocomoTurn {
  dia_id: string
  speaker: string
  text: string
  img_url?: string
  blip_caption?: string
}

export interface LocomoRecord {
  sample_id: string
  conversation: Record<string, unknown>
  qa: LocomoQa[]
}

export interface LocomoStats {
  samples: number
  questions: number
  turns: number
  sessions: number
  /** questions whose evidence list resolved to at least one stored turn */
  withEvidence: number
  /** no evidence ids at all: read for qa, never scored for retrieval */
  noEvidence: number
  /** evidence ids that name no turn in the conversation */
  unresolvedEvidence: number
  byCategory: Record<string, number>
}

export function emptyLocomoStats(): LocomoStats {
  return {
    samples: 0,
    questions: 0,
    turns: 0,
    sessions: 0,
    withEvidence: 0,
    noEvidence: 0,
    unresolvedEvidence: 0,
    byCategory: {},
  }
}

export function categoryName(category: number): string {
  return LOCOMO_CATEGORY_NAMES[category] ?? `category-${category}`
}

export function readLocomoFile(path: string): LocomoRecord[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as LocomoRecord[]
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a json array of conversations`)
  return parsed
}

/** session numbers in file order; the conversation mixes `session_1` with `session_1_date_time` */
export function sessionNumbers(conversation: Record<string, unknown>): number[] {
  const numbers = Object.keys(conversation)
    .map((key) => key.match(/^session_(\d+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => Number.parseInt(match[1], 10))
  return numbers.sort((a, b) => a - b)
}

export function sessionTurns(conversation: Record<string, unknown>, number: number): LocomoTurn[] {
  const turns = conversation[`session_${number}`]
  return Array.isArray(turns) ? (turns as LocomoTurn[]) : []
}

export function sessionDate(conversation: Record<string, unknown>, number: number): string {
  const value = conversation[`session_${number}_date_time`]
  return typeof value === 'string' ? value : ''
}

/** `"1:56 pm on 8 May, 2023"` -> epoch ms; null when unparseable */
export function parseSessionDate(value: string): number | null {
  const match = value.match(/(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i)
  if (!match) return null
  const [, hour, minute, meridiem, day, monthName, year] = match
  const months = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ]
  const month = months.indexOf(monthName.toLowerCase())
  if (month < 0) return null
  let hours = Number.parseInt(hour, 10) % 12
  if (meridiem.toLowerCase() === 'pm') hours += 12
  return Date.UTC(Number.parseInt(year, 10), month, Number.parseInt(day, 10), hours, Number.parseInt(minute, 10))
}

/** the official dialog-database shape: `speaker said, "text"` plus a shared caption */
export function turnText(turn: LocomoTurn): string {
  const caption = turn.blip_caption ? ` and shared ${turn.blip_caption}` : ''
  return `${turn.speaker} said, "${turn.text}"${caption}`
}

export function turnMemoryId(sampleId: string, diaId: string): string {
  return `${sampleId}-${diaId}`
}

export function turnNamespace(sampleId: string): string {
  return `/locomo/${sampleId}`
}

/**
 * one memory per dialog turn, one query per question, targets are the turns its
 * `evidence` list names. the stored text is the timestamped dialog line, which is what
 * the official rag context shows a reader.
 */
export function sampleToCorpus(
  record: LocomoRecord,
  stats: LocomoStats
): { namespace: string; memories: CorpusMemory[]; queries: CorpusQuery[] } {
  const namespace = turnNamespace(record.sample_id)
  const memories: CorpusMemory[] = []
  const queries: CorpusQuery[] = []
  const known = new Map<string, string>()

  stats.samples++
  for (const number of sessionNumbers(record.conversation)) {
    const date = sessionDate(record.conversation, number)
    const at = parseSessionDate(date) ?? CORPUS_BASE + number * HOUR
    const turns = sessionTurns(record.conversation, number)
    stats.sessions++
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index]
      if (!turn || typeof turn.dia_id !== 'string') continue
      const id = turnMemoryId(record.sample_id, turn.dia_id)
      known.set(turn.dia_id, id)
      memories.push({
        id,
        namespace,
        content: `${date}: ${turnText(turn)}`,
        type: 'note',
        created_at: at + index * 1000,
        tags: ['locomo', `session-${number}`],
      })
      stats.turns++
    }
  }

  record.qa.forEach((qa, index) => {
    stats.questions++
    const category = categoryName(qa.category)
    stats.byCategory[category] = (stats.byCategory[category] ?? 0) + 1
    const evidence = qa.evidence ?? []
    const targets: string[] = []
    for (const diaId of evidence) {
      const id = known.get(diaId)
      if (id) targets.push(id)
      else stats.unresolvedEvidence++
    }
    if (evidence.length > 0 && targets.length > 0) stats.withEvidence++
    if (evidence.length === 0) stats.noEvidence++
    queries.push({
      id: `locomo-${record.sample_id}-q${index}`,
      query: qa.question,
      namespace,
      target_ids: targets,
      kind: category,
    })
  })

  return { namespace, memories, queries }
}

export function defaultCheckpointPath(systemNames: string[]): string {
  return `${DATASETS_DIR}/locomo-qa-${systemNames.join('+')}.jsonl`
}

export function locomoScorer(): BenchScorer {
  return {
    name: LOCOMO_SCORER_NAME,
    version: LOCOMO_SCORER_VERSION,
    source: LOCOMO_SCORER_SOURCE,
    score(question, predicted) {
      const payload = (question.payload ?? {}) as { qa: LocomoQa; flip: boolean }
      const answer = payload.qa.category === 5 ? cat5Answer(predicted, payload.qa, payload.flip) : predicted
      return scoreLocomo(answer, payload.qa)
    },
  }
}

/** the official reader frame: context first, then the question template */
export function locomoMessages(question: BenchQuestion, plan: QaContextPlan): Array<{ role: 'system' | 'user'; content: string }> {
  const context = plan.blocks.join('\n')
  return [{ role: 'user', content: `${context}\n\n${question.prompt_question}` }]
}

export async function runLocomoSuite(ctx: SuiteContext): Promise<SuiteOutput> {
  const tokenizer = await resolveTokenizer()
  const notes: string[] = []
  const entry = datasetEntry(LOCOMO_DATASET_ID, ctx.datasetManifestPath)
  const sourceFile = datasetFilePath(entry, 'source', LOCOMO_FILE)
  const path = ctx.datasetPath ?? sourceFile
  if (!existsSync(path)) {
    throw new DatasetMissingError(
      `locomo dataset missing: ${path}\n` +
        `fetch it with \`${fetchHint(LOCOMO_DATASET_ID)}\` (${LOCOMO_URL}, ~2.8 MB, cc by-nc 4.0: ` +
        `the file stays in the gitignored eval/datasets and is never committed)`
    )
  }
  const manifestFile = datasetFileEntry(entry, 'source')
  // the hash is recomputed from the bytes on disk and compared, so a stale or hand-edited
  // file cannot pass as the pinned one
  const fileSha256 = await sha256File(path)
  const shaVerified = manifestFile === null || manifestFile.sha256 === fileSha256

  const records = readLocomoFile(path)
  const sampleLimit = ctx.limit ?? records.length
  const samples = records.slice(0, Math.max(1, sampleLimit))
  const stats = emptyLocomoStats()
  const ks = DEFAULT_KS
  const harness = await EvalHarness.create({ seed: ctx.seed, vectors: ctx.vectors })
  const systemSpecs = requestedSystemSpecs(ctx)
  checkSystemSpecs(systemSpecs)
  const readerModel = ctx.readerModel ?? ''
  const qaReady = preflightBenchQa(ctx, systemSpecs, readerModel, LOCOMO_SCORER_NAME)
  const budgetChars = ctx.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS
  let systems: MemorySystem[] = []

  const detailsByConfig = new Map<string, QueryDetail[]>(ctx.configs.map(([name]) => [name, []]))
  let qaOutput: Awaited<ReturnType<typeof runBenchQa>> | null = null
  const sampleSummaries: Array<{ sample_id: string; questions: number; turns: number }> = []
  let indexedTurns = 0
  let indexedChars = 0

  try {
    systems = await createSystems(systemSpecs, { harness, topK: LOCOMO_READER_TOP_K, seed: ctx.seed })
    const readers = systems.map(readerFor)
    const checkpoint = new JsonlCheckpoint<BenchQaRow>(
      ctx.checkpointPath ?? defaultCheckpointPath(systems.map((system) => system.name))
    )
    // the regime that is really in effect, not the flag that was typed: a `cached`
    // request on a machine without the model runs fts, and resuming it as a vector run
    // would mix two regimes into one number
    const vectorRegime = benchVectorIdentity(harness.vectorMode, {
      vectorsAvailable: harness.vectorsAvailable,
      modelCacheReady: harness.modelCacheReady,
    })
    // the conversations that were really asked, not the limit that was passed
    const selection = selectionIdentity('samples', samples.length, records.length)
    const key = benchQaKey({
      dataset: LOCOMO_DATASET_ID,
      sha: fileSha256.slice(0, 16),
      readers: systems.map(systemKey).join('+'),
      model: readerModel,
      prompt: LOCOMO_PROMPT_VERSION,
      scorer: `${LOCOMO_SCORER_NAME}@${LOCOMO_SCORER_VERSION}`,
      topk: LOCOMO_READER_TOP_K,
      budget: budgetChars,
      vectors: vectorRegime,
      engine: ctx.gitSha || 'unknown',
      selection,
      // the seed decides the option order of every category-5 item, so it changes both
      // the prompt the reader sees and the answer the official rule expects
      seed: ctx.seed,
    })

    async function* streamQuestions(): AsyncGenerator<BenchQuestion> {
      for (const record of samples) {
        const built = sampleToCorpus(record, stats)
        const corpus = {
          name: 'locomo',
          seed: ctx.seed,
          memories: built.memories,
          queries: built.queries,
        }
        await harness.seedCorpus(corpus, { mode: 'raw', embed: harness.vectorsAvailable })
        indexedTurns += built.memories.length
        indexedChars += built.memories.reduce((sum, m) => sum + m.content.length, 0)
        sampleSummaries.push({
          sample_id: record.sample_id,
          questions: built.queries.length,
          turns: built.memories.length,
        })

        const scorable = built.queries.filter((query) => query.target_ids.length > 0)
        for (const [configName, patch] of ctx.configs) {
          if (scorable.length === 0) continue
          const scored = await scoreQueries({
            harness,
            corpus,
            configOptions: patch.search,
            queries: scorable,
            ks,
            limit: READ_LIMIT,
            tokenizer,
          })
          detailsByConfig.get(configName)!.push(...scored.details)
        }

        if (qaReady) {
          const sessions = toSystemSessions(built.memories)
          // one ingest per conversation per system: every question in a sample shares that history
          const retrievals = await retrieveEachSystem({
            harness,
            systems,
            namespace: built.namespace,
            sessions,
            queries: record.qa.map((qa) => qa.question),
            budgetChars,
          })
          for (let index = 0; index < record.qa.length; index++) {
            const qa = record.qa[index]
            const questionId = `locomo-${record.sample_id}-q${index}`
            const flip = qa.category === 5 ? cat5Flip(questionId, ctx.seed) : false
            const asked = qa.category === 5 ? cat5Question(qa, flip) : qa.question
            const template = qa.category === 5 ? LOCOMO_QA_PROMPT_CAT_5 : LOCOMO_QA_PROMPT
            const contexts: ReaderContext[] = []
            for (let i = 0; i < systems.length; i++) {
              const retrieved = retrievals[index][i]
              contexts.push(
                await readers[i].build({
                  question: qa.question,
                  namespace: built.namespace,
                  budgetChars,
                  tokenizer,
                  retrieved,
                })
              )
            }
            yield {
              question_id: questionId,
              question_type: categoryName(qa.category),
              question: qa.question,
              prompt_question: template.replace('{}', asked),
              payload: { qa, flip },
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
        harness.dropNamespace(built.namespace)
      }
    }

    const stream = streamQuestions()
    if (qaReady) {
      qaOutput = await runBenchQa({
        questions: stream,
        readers,
        readerModel,
        buildMessages: locomoMessages,
        systemNote: 'official locomo rag frame: context, then the question template',
        promptVersion: LOCOMO_PROMPT_VERSION,
        goldOf: (question) => goldAnswer(((question.payload ?? {}) as { qa: LocomoQa }).qa),
        scorer: locomoScorer(),
        maxTokens: LOCOMO_MAX_TOKENS,
        temperature: 0,
        concurrency: ctx.concurrency ?? DEFAULT_BENCH_CONCURRENCY,
        checkpoint,
        key,
        costCeilingCalls: ctx.costCeilingCalls ?? DEFAULT_BENCH_COST_CEILING_CALLS,
        confirmed: ctx.yes === true,
        totalQuestions: sampleSummaries.reduce((sum, sample) => sum + sample.questions, 0),
        gitSha: ctx.gitSha ?? '',
        vectors: vectorRegime,
        selection,
        tokenizer,
        log: ctx.log,
      })
    } else {
      for await (const question of stream) void question
    }

    const corpusHashValue = corpusHash(sampleSummaries)
    const qaBlock: BenchQaBlock = qaOutput
      ? describeBenchQa(qaOutput, {
          readerModel,
          promptVersion: LOCOMO_PROMPT_VERSION,
          promptSource: LOCOMO_PROMPT_SOURCE,
          scorer: locomoScorer(),
          topK: LOCOMO_READER_TOP_K,
          budgetChars,
          checkpoint,
          key,
        })
      : { status: 'skipped', note: 'pass --qa to run the readers + the official f1 scorer' }
    notes.push(
    ...locomoNotes({
      stats,
      sampleSummaries,
      manifestFile,
      file: path,
      fileSha256,
      shaVerified,
      qaBlock,
      readerModel,
    })
  )
    if (qaBlock.status === 'ok') {
      notes.push(
        `qa identity: vectors=${vectorRegime}, selection=${selection}, engine=` +
          `${ctx.gitSha || 'unknown'}, seed=${ctx.seed} — a changed regime, sample, revision ` +
          'or seed is a different run, not a resume'
      )
      if ((qaBlock.foreign_keys?.length ?? 0) > 0) {
        const kept = qaBlock.foreign_keys!.reduce((sum, entry) => sum + entry.rows, 0)
        notes.push(
        `qa resume: ${kept} checkpoint row(s) have an unverified or different identity and ` +
            `were NOT reused (${qaBlock.foreign_keys!
              .map((entry) => entry.differences.join('; ') || entry.key)
              .join(' | ')}); they are kept, and this run appends its own rows under the ` +
            'current key'
        )
      }
    }

    const metrics: Record<string, unknown> = {}
    const thresholds: Record<string, Record<string, number>> = {}
    const timings: Record<string, TimingSummary> = {}
    if (qaOutput) Object.assign(timings, benchQaTimings(qaOutput.rows))

    for (const [configName] of ctx.configs) {
      const scored = detailsByConfig.get(configName) ?? []
      const block = aggregate(scored, ks)
      const byCategory: Record<string, unknown> = {}
      for (const category of Object.keys(stats.byCategory).sort()) {
        const subset = scored.filter((detail) => detail.kind === category)
        byCategory[category] = { questions: subset.length, ...aggregate(subset, ks) }
      }
      timings[`${configName}/all-queries`] = summarizeLatencies(scored.map((detail) => detail.latencyMs))
      metrics[configName] = {
        dataset: {
          id: LOCOMO_DATASET_ID,
          file: path,
          url: LOCOMO_URL,
          license: LOCOMO_LICENSE,
          sha256_manifest: manifestFile?.sha256 ?? '',
          sha256_actual: fileSha256,
          sha256_verified: shaVerified,
          bytes: manifestFile?.bytes ?? null,
          record_count: manifestFile?.record_count ?? records.length,
        },
        sampledConversations: samples.map((record) => record.sample_id),
        stats,
        evidence: {
          questions: block.queries,
          'recall@1': block['recall@1'] ?? 0,
          'recall@5': block['recall@5'] ?? 0,
          'recall@10': block['recall@10'] ?? 0,
          mrr: block.mrr,
          'ndcg@10': block['ndcg@10'] ?? 0,
          servedTokens: block.servedTokens,
        },
        overall: block,
        byCategory,
        qa: qaBlock,
      }
      thresholds[configName] = {
        ...topLineFromBlock(block, ks),
        ...(qaBlock.readers?.engram ? { qaScore: qaBlock.readers.engram.score } : {}),
      }
    }

    const markdown = renderLocomoMarkdown({
      path,
      manifestFile,
      stats,
      sampleSummaries,
      indexedTurns,
      indexedChars,
      metrics,
      configNames: ctx.configs.map(([name]) => name),
      timings,
      qa: qaBlock,
    })

    return {
      result: {
        suite: 'locomo',
        header: ctx.buildHeader({
          suite: 'locomo',
          configs: ctx.configs.map(([name]) => name),
          seed: ctx.seed,
          corpusHash: corpusHashValue,
          vectorsAvailable: harness.vectorsAvailable,
          vectorMode: harness.vectorMode,
          now: harness.now,
          tokenizer,
          featureFlags: {},
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
    await closeAll(systems)
    harness.dispose()
  }
}

function locomoNotes(input: {
  stats: LocomoStats
  sampleSummaries: Array<{ sample_id: string; questions: number; turns: number }>
  manifestFile: { sha256: string; bytes: number; record_count: number | null } | null
  file: string
  fileSha256: string
  shaVerified: boolean
  qaBlock: BenchQaBlock
  readerModel: string
}): string[] {
  const notes: string[] = []
  notes.push(
    `dataset locomo: ${input.sampleSummaries.length} conversation(s), ${input.stats.questions} question(s), ` +
      `${input.stats.turns} dialog turn(s); file ${input.file}` +
      (input.manifestFile
        ? ` (sha256 ${input.fileSha256.slice(0, 16)}…, ${input.manifestFile.bytes} bytes, ` +
          `${input.manifestFile.record_count ?? '?'} conversations)`
        : ' (not in the manifest: run the fetch to record its hash)') + (input.shaVerified ? '' : ' — SHA256 MISMATCH against the manifest, re-fetch with --force')
  )
  notes.push(
    'ingest: one conversation at a time into its own namespace, torn down before the next; a memory ' +
      'is one dialog turn, carrying its session timestamp'
  )
  notes.push(
    `evidence labels: the dataset's dialog ids; ${input.stats.withEvidence} question(s) scored, ` +
      `${input.stats.noEvidence} with no evidence list and ${input.stats.unresolvedEvidence} id(s) that name no turn`
  )
  notes.push(
    'categories: 1 multi-hop, 2 temporal, 3 open-domain, 4 single-hop, 5 adversarial; the ids are mapped ' +
      'from the official scorer, the file carries no names. category 5 is scored by the official keyword ' +
      'rule (a refusal counts as correct), not by f1'
  )
  if (input.qaBlock.status === 'ok') {
    notes.push(
      `qa: ${Object.keys(input.qaBlock.readers ?? {}).length} reader(s) x ${input.qaBlock.questions_answered} ` +
        `question(s), ${input.qaBlock.calls} call(s); reader model ${input.readerModel}, scorer ` +
        `${input.qaBlock.scorer}@${input.qaBlock.scorer_version}, reader prompt ${input.qaBlock.prompt_version} ` +
        `(${input.qaBlock.prompt_source})`
    )
    if ((input.qaBlock.failures?.length ?? 0) > 0) {
      notes.push(`qa failures: ${input.qaBlock.failures?.length} (see details.qa.failures)`)
    }
    if ((input.qaBlock.estimated_rows ?? 0) > 0) {
      notes.push(`qa tokens: ${input.qaBlock.estimated_rows} row(s) used tokenizer estimates`)
    }
  } else {
    notes.push(`qa skipped: ${input.qaBlock.note ?? 'not requested'}`)
  }
  notes.push(
    `dataset manifest: ${DATASET_MANIFEST_PATH} (the locomo file is cc by-nc 4.0 and stays gitignored; ` +
      'no bytes from it are committed or quoted beyond hashes and counts)'
  )
  return notes
}

export function renderLocomoMarkdown(input: {
  path: string
  manifestFile: { sha256: string; bytes: number; record_count: number | null } | null
  stats: LocomoStats
  sampleSummaries: Array<{ sample_id: string; questions: number; turns: number }>
  indexedTurns: number
  indexedChars: number
  metrics: Record<string, unknown>
  configNames: string[]
  timings: Record<string, TimingSummary>
  qa: BenchQaBlock
}): string {
  const rows: Array<Array<string | number>> = []
  for (const config of input.configNames) {
    const entry = input.metrics[config] as {
      evidence: Record<string, number>
      overall: { queries: number }
    }
    if (!entry) continue
    rows.push([
      config,
      entry.overall.queries,
      entry.evidence['recall@1'] ?? 0,
      entry.evidence['recall@5'] ?? 0,
      entry.evidence['recall@10'] ?? 0,
      entry.evidence.mrr,
      entry.evidence['ndcg@10'] ?? 0,
      entry.evidence.servedTokens,
    ])
  }

  const categoryRows: Array<Array<string | number>> = []
  const first = input.metrics[input.configNames[0]] as
    | { byCategory?: Record<string, { questions: number; 'recall@5': number; 'recall@10': number; mrr: number }> }
    | undefined
  for (const [category, block] of Object.entries(first?.byCategory ?? {})) {
    categoryRows.push([category, block.questions, block['recall@5'], block['recall@10'], block.mrr])
  }

  const sections: string[] = [
    `Locomo: ${input.sampleSummaries.length} conversation(s) ` +
      `(${input.sampleSummaries.map((sample) => sample.sample_id).join(', ')}), ` +
      `${input.stats.questions} question(s) over ${input.indexedTurns} dialog turn(s) ` +
      `(${input.indexedChars} chars). Evidence ids are the dataset's ` +
      '\`evidence\` dialog ids, so recall is dialog-level.',
    markdownTable({
      columns: ['config', 'questions', 'recall@1', 'recall@5', 'recall@10', 'mrr', 'ndcg@10', 'servedTokens'],
      rows,
    }),
    `### by category (config ${input.configNames[0] ?? 'baseline'})\n\n${markdownTable({
      columns: ['category', 'questions', 'recall@5', 'recall@10', 'mrr'],
      rows: categoryRows,
    })}`,
  ]

  if (input.qa.status === 'ok') {
    sections.push(
      `### reader comparison (official f1, same questions and same rule)\n\n${markdownTable({
        columns: ['reader', 'graded', 'mean f1', 'exact', 'ctx tokens/q', 'reader in tokens/q', 'reader out tokens/q'],
        rows: Object.entries(input.qa.readers ?? {}).map(([name, agg]) => [
          name,
          agg.graded,
          agg.score,
          agg.exact,
          agg.avg_context_tokens,
          agg.avg_input_tokens,
          agg.avg_output_tokens,
        ]),
      })}`
    )
    const typeRows: Array<Array<string | number>> = []
    for (const [name, agg] of Object.entries(input.qa.readers ?? {})) {
      for (const [type, stat] of Object.entries(agg.by_question_type)) {
        typeRows.push([name, type, stat.graded, stat.score, stat.exact])
      }
    }
    sections.push(
      `### f1 by category\n\n${markdownTable({
        columns: ['reader', 'category', 'graded', 'mean f1', 'exact'],
        rows: typeRows,
      })}`
    )
    sections.push(
      `### scorer and cost\n\n${markdownTable({
        columns: ['field', 'value'],
        rows: [
          ['reader model', input.qa.reader_model ?? ''],
          ['prompt', input.qa.prompt_version ?? ''],
          ['prompt source', input.qa.prompt_source ?? ''],
          ['scorer', `${input.qa.scorer ?? ''}@${input.qa.scorer_version ?? ''}`],
          ['scorer source', input.qa.scorer_source ?? ''],
          ['retrieval top-k', input.qa.top_k ?? ''],
          ['context budget (chars)', input.qa.budget_chars ?? ''],
          ['calls', input.qa.calls ?? 0],
          ['questions answered', input.qa.questions_answered ?? 0],
          ['resumed questions', input.qa.resumed_questions ?? 0],
          ['estimated-token rows', input.qa.estimated_rows ?? 0],
          ['checkpoint', input.qa.checkpoint ?? ''],
          ['checkpoint key', input.qa.key ?? ''],
        ],
      })}`
    )
  } else {
    sections.push(`QA skipped: ${input.qa.note ?? 'not requested'}.`)
  }

  sections.push(
    `### labels and counts\n\n${markdownTable({
      columns: ['field', 'value'],
      rows: [
        ['conversations', input.stats.samples],
        ['questions', input.stats.questions],
        ['dialog turns', input.stats.turns],
        ['sessions', input.stats.sessions],
        ['scored (has evidence)', input.stats.withEvidence],
        ['no evidence list', input.stats.noEvidence],
        ['evidence id names no turn', input.stats.unresolvedEvidence],
        ['file', input.path],
        ['sha256', input.manifestFile?.sha256 ?? '(not in the manifest)'],
        ['bytes', input.manifestFile?.bytes ?? 0],
      ],
    })}`,
    `### latency (wall clock; not covered by the determinism guarantee)\n\n${renderTimings(input.timings)}`
  )
  return sections.join('\n\n')
}
