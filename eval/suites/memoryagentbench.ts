// memoryagentbench suite, conflict-resolution split only: eight fact pools
// (factconsolidation_sh/mh at 6k/32k/64k/262k) where a fact is overwritten by a later
// one, the pool's own rule being that the larger serial number is newer. retrieval-only
// mode scores the fact that states the current value; --qa runs the readers on the
// official prompt and scores with the official substring match.
// the split ships no evidence or decoy labels, so the target rule here is derived and
// the artifact says so: the newest fact carrying one of the gold answers.
// the hub release is mit; the file lands in the gitignored eval/datasets.
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { DatasetMissingError, EvalSetupError } from '../lib/errors.js'
import { EvalHarness } from '../lib/harness.js'
import { sha256File } from '../lib/json-stream.js'
import { corpusHash, resolveTokenizer, summarizeLatencies } from '../lib/metrics.js'
import { markdownTable, renderTimings } from '../lib/report.js'
import { DEFAULT_KS, MEASUREMENT_DEFAULTS, aggregate, scoreQueries, type QueryDetail } from '../lib/score.js'
import { topLineFromBlock } from '../lib/thresholds.js'
import type { TimingSummary } from '../lib/types.js'
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
  MAB_PROMPT_SOURCE,
  MAB_PROMPT_VERSION,
  MAB_QUERY_TEMPLATE,
  MAB_SCORER_NAME,
  MAB_SCORER_SOURCE,
  MAB_SCORER_VERSION,
  MAB_SYSTEM_MESSAGE,
  answerCandidates,
  emptyTargetStats,
  newestFactWithAnswer,
  parseFactPool,
  scoreOverAnswers,
  type MabFact,
  type MabRow,
  type MabTargetStats,
} from '../lib/mab-score.js'
import {
  DATASETS_DIR,
  datasetEntry,
  datasetFileEntry,
  datasetFilePath,
  fetchHint,
} from '../lib/datasets.js'
import { describeHarness } from './retrieval.js'
import type { SuiteContext, SuiteOutput } from './types.js'
import type { CorpusMemory, CorpusQuery } from '../lib/types.js'
import type { QaContextPlan } from '../lib/qa-run.js'

export const MAB_DATASET_ID = 'memoryagentbench'
export const MAB_SPLIT = 'Conflict_Resolution'
export const MAB_PARQUET_FILE = `${MAB_SPLIT}.parquet`
export const MAB_ROWS_FILE = `${MAB_SPLIT}.jsonl`
export const MAB_URL =
  'https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/resolve/main/data/Conflict_Resolution-00000-of-00001.parquet'
export const MAB_SUBDATASETS = [
  'factconsolidation_mh_6k',
  'factconsolidation_mh_32k',
  'factconsolidation_mh_64k',
  'factconsolidation_mh_262k',
  'factconsolidation_sh_6k',
  'factconsolidation_sh_32k',
  'factconsolidation_sh_64k',
  'factconsolidation_sh_262k',
] as const
/** the official retrieval agents run at top-k 10 */
export const MAB_READER_TOP_K = 10
/** the split's data conf sets generation_max_length: 10 */
export const MAB_MAX_TOKENS = 10
const READ_LIMIT = MEASUREMENT_DEFAULTS.limit ?? 10
const CORPUS_BASE = 1_700_000_000_000

/** one jsonl line per pool row, written by the fetch step after decoding the parquet */
export async function readMabRows(path: string): Promise<MabRow[]> {
  const rows: MabRow[] = []
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    rows.push(JSON.parse(trimmed) as MabRow)
  }
  return rows
}

export function factMemoryId(source: string, serial: number): string {
  return `${source}-f${serial}`
}

export function poolNamespace(source: string): string {
  return `/memoryagentbench/${source}`
}

/**
 * one memory per numbered fact, in the pool's own order, so the serial number the prompt
 * tells the reader to trust is part of the text and the recency of the row matches it.
 */
export function poolToCorpus(
  row: MabRow,
  stats: MabTargetStats
): { namespace: string; memories: CorpusMemory[]; queries: CorpusQuery[]; facts: MabFact[] } {
  const facts = parseFactPool(row.context)
  const namespace = poolNamespace(row.source)
  stats.facts += facts.length
  const memories: CorpusMemory[] = facts.map((fact) => ({
    id: factMemoryId(row.source, fact.serial),
    namespace,
    content: fact.line,
    type: 'note',
    created_at: CORPUS_BASE + fact.serial * 1000,
    tags: ['memoryagentbench', row.source],
  }))

  const queries: CorpusQuery[] = row.questions.map((question, index) => {
    const answers = row.answers[index] ?? []
    stats.questions++
    const target = newestFactWithAnswer(facts, answers)
    const candidates = answerCandidates(facts, answers)
    if (candidates.length > 1) stats.multipleCandidates++
    if (target) stats.withTarget++
    else stats.unscorable++
    return {
      id: row.qa_pair_ids[index] ?? `${row.source}-q${index}`,
      query: question,
      namespace,
      target_ids: target ? [factMemoryId(row.source, target.serial)] : [],
      kind: row.source,
    }
  })

  return { namespace, memories, queries, facts }
}

export function mabScorer(): BenchScorer {
  return {
    name: MAB_SCORER_NAME,
    version: MAB_SCORER_VERSION,
    source: MAB_SCORER_SOURCE,
    score(question, predicted) {
      const payload = (question.payload ?? {}) as { answers: string[][] }
      const score = scoreOverAnswers(predicted, payload.answers)
      return { score, detail: score === 1 ? 'substring-exact-match' : 'miss' }
    },
  }
}

/** the official frame for a retrieval agent: memories first, then the query template */
export function mabMessages(
  question: BenchQuestion,
  plan: QaContextPlan
): Array<{ role: 'system' | 'user'; content: string }> {
  const memories = plan.blocks.map((block, index) => `Memory ${index + 1}:\n${block}`).join('\n')
  return [
    { role: 'system', content: MAB_SYSTEM_MESSAGE },
    { role: 'user', content: `${memories}\n${question.prompt_question}` },
  ]
}

export function resolvePoolFilter(dataset: string | undefined): string | null {
  if (dataset === undefined || dataset === '' || dataset === MAB_SPLIT) return null
  if (!MAB_SUBDATASETS.includes(dataset as (typeof MAB_SUBDATASETS)[number])) {
    throw new EvalSetupError(
      `--dataset ${dataset} is not a ${MAB_SPLIT} sub-dataset — known: ${MAB_SUBDATASETS.join(', ')}`
    )
  }
  return dataset
}

export function defaultCheckpointPath(systemNames: string[]): string {
  return `${DATASETS_DIR}/memoryagentbench-qa-${MAB_SPLIT}-${systemNames.join('+')}.jsonl`
}

export async function runMemoryAgentBenchSuite(ctx: SuiteContext): Promise<SuiteOutput> {
  const tokenizer = await resolveTokenizer()
  const notes: string[] = []
  const entry = datasetEntry(MAB_DATASET_ID, ctx.datasetManifestPath)
  const sourceFile = datasetFilePath(entry, 'source', MAB_PARQUET_FILE)
  const rowsFile = ctx.datasetPath ?? datasetFilePath(entry, 'rows', MAB_ROWS_FILE)
  if (!existsSync(rowsFile)) {
    throw new DatasetMissingError(
      `memoryagentbench ${MAB_SPLIT} rows missing: ${rowsFile}\n` +
        `fetch it with \`${fetchHint(MAB_DATASET_ID)}\` (${MAB_URL} -> ` +
        'decoded to jsonl in the gitignored eval/datasets; the release is mit)'
    )
  }
  if (!existsSync(sourceFile)) {
    notes.push(
      `parquet source missing at ${sourceFile}: the rows file was read, but the fetch is what ` +
        'records the upstream hash'
    )
  }
  const manifestFile = datasetFileEntry(entry, 'rows')
  const sourceEntry = datasetFileEntry(entry, 'source')
  const fileSha256 = await sha256File(rowsFile)
  const shaVerified = manifestFile === null || manifestFile.sha256 === fileSha256
  const filter = resolvePoolFilter(ctx.dataset)
  const allRows = await readMabRows(rowsFile)
  const selected = filter === null ? allRows : allRows.filter((row) => row.source === filter)
  if (selected.length === 0) {
    throw new EvalSetupError(
      `no pool row for ${filter ?? MAB_SPLIT} in ${rowsFile} (rows present: ` +
        `${[...new Set(allRows.map((row) => row.source))].sort().join(', ')})`
    )
  }
  const rowLimit = ctx.limit ?? selected.length
  const rows = selected.slice(0, Math.max(1, rowLimit))

  const stats = emptyTargetStats()
  const ks = DEFAULT_KS
  const systemSpecs = requestedSystemSpecs(ctx)
  checkSystemSpecs(systemSpecs)
  const readerModel = ctx.readerModel ?? ''
  const qaReady = preflightBenchQa(ctx, systemSpecs, readerModel, MAB_SCORER_NAME)
  const budgetChars = ctx.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS
  let systems: MemorySystem[] = []

  const detailsByConfig = new Map<string, QueryDetail[]>(ctx.configs.map(([name]) => [name, []]))
  const poolSummaries: Array<{ source: string; facts: number; questions: number; unscorable: number }> = []
  let indexedFacts = 0
  let indexedChars = 0
  let qaOutput: Awaited<ReturnType<typeof runBenchQa>> | null = null

  const harness = await EvalHarness.create({ seed: ctx.seed, vectors: ctx.vectors })
  try {
    systems = await createSystems(systemSpecs, { harness, topK: MAB_READER_TOP_K, seed: ctx.seed })
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
    // the pools that were really asked, not the limit that was passed
    const selection = selectionIdentity('rows', rows.length, selected.length)
    const key = benchQaKey({
      dataset: MAB_DATASET_ID,
      split: MAB_SPLIT,
      rows_sha: fileSha256.slice(0, 16),
      subset: filter ?? 'all',
      readers: systems.map(systemKey).join('+'),
      model: readerModel,
      prompt: MAB_PROMPT_VERSION,
      scorer: `${MAB_SCORER_NAME}@${MAB_SCORER_VERSION}`,
      topk: MAB_READER_TOP_K,
      budget: budgetChars,
      vectors: vectorRegime,
      engine: ctx.gitSha || 'unknown',
      selection,
      // the seed names the corpus a raw-seeded run wrote (its ids are seed-derived), so
      // rows from another seed describe another store even when the text is the same
      seed: ctx.seed,
    })

    async function* streamQuestions(): AsyncGenerator<BenchQuestion> {
      for (const row of rows) {
        const built = poolToCorpus(row, stats)
        const corpus = {
          name: 'memoryagentbench',
          seed: ctx.seed,
          memories: built.memories,
          queries: built.queries,
        }
        await harness.seedCorpus(corpus, { mode: 'raw', embed: harness.vectorsAvailable })
        indexedFacts += built.memories.length
        indexedChars += built.memories.reduce((sum, memory) => sum + memory.content.length, 0)
        poolSummaries.push({
          source: row.source,
          facts: built.memories.length,
          questions: built.queries.length,
          unscorable: built.queries.filter((query) => query.target_ids.length === 0).length,
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
          // one ingest per pool per system: every question over a pool shares its facts
          const retrievals = await retrieveEachSystem({
            harness,
            systems,
            namespace: built.namespace,
            sessions,
            queries: row.questions,
            budgetChars,
          })
          for (let index = 0; index < row.questions.length; index++) {
            const questionId = row.qa_pair_ids[index] ?? `${row.source}-q${index}`
            const contexts: ReaderContext[] = []
            for (let i = 0; i < systems.length; i++) {
              const retrieved = retrievals[index][i]
              contexts.push(
                await readers[i].build({
                  question: row.questions[index],
                  namespace: built.namespace,
                  budgetChars,
                  tokenizer,
                  retrieved,
                })
              )
            }
            yield {
              question_id: questionId,
              question_type: row.source,
              question: row.questions[index],
              prompt_question: MAB_QUERY_TEMPLATE.replace('{question}', row.questions[index]),
              payload: { answers: row.answers[index] ?? [] },
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
        buildMessages: mabMessages,
        systemNote: 'official memoryagentbench retrieval frame: Memory N blocks, then the query template',
        promptVersion: MAB_PROMPT_VERSION,
        goldOf: (question) => ((question.payload ?? {}) as { answers: string[] }).answers.join(' | '),
        scorer: mabScorer(),
        maxTokens: MAB_MAX_TOKENS,
        temperature: 0,
        concurrency: ctx.concurrency ?? DEFAULT_BENCH_CONCURRENCY,
        checkpoint,
        key,
        costCeilingCalls: ctx.costCeilingCalls ?? DEFAULT_BENCH_COST_CEILING_CALLS,
        confirmed: ctx.yes === true,
        totalQuestions: poolSummaries.reduce((sum, pool) => sum + pool.questions, 0),
        gitSha: ctx.gitSha ?? '',
        vectors: vectorRegime,
        selection,
        tokenizer,
        log: ctx.log,
      })
    } else {
      for await (const question of stream) void question
    }

    const qaBlock: BenchQaBlock = qaOutput
      ? describeBenchQa(qaOutput, {
          readerModel,
          promptVersion: MAB_PROMPT_VERSION,
          promptSource: MAB_PROMPT_SOURCE,
          scorer: mabScorer(),
          topK: MAB_READER_TOP_K,
          budgetChars,
          checkpoint,
          key,
        })
      : { status: 'skipped', note: 'pass --qa to run the readers + the official substring match' }
    notes.push(
      ...mabNotes({
        stats,
        poolSummaries,
        rowsFile,
        sourceFile,
        manifestFile,
        sourceEntry,
        fileSha256,
        shaVerified,
        qaBlock,
        readerModel,
        filter,
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

    const corpusHashValue = corpusHash(poolSummaries)
    const metrics: Record<string, unknown> = {}
    const thresholds: Record<string, Record<string, number>> = {}
    const timings: Record<string, TimingSummary> = {}
    if (qaOutput) Object.assign(timings, benchQaTimings(qaOutput.rows))

    for (const [configName] of ctx.configs) {
      const scored = detailsByConfig.get(configName) ?? []
      const block = aggregate(scored, ks)
      const bySubDataset: Record<string, unknown> = {}
      for (const pool of [...new Set(scored.map((detail) => detail.kind))].sort()) {
        const subset = scored.filter((detail) => detail.kind === pool)
        bySubDataset[pool] = { questions: subset.length, ...aggregate(subset, ks) }
      }
      timings[`${configName}/all-queries`] = summarizeLatencies(scored.map((detail) => detail.latencyMs))
      metrics[configName] = {
        dataset: {
          id: MAB_DATASET_ID,
          split: MAB_SPLIT,
          file: rowsFile,
          source_file: sourceFile,
          url: MAB_URL,
          license: 'MIT',
          rows_sha256_manifest: manifestFile?.sha256 ?? '',
          rows_sha256_actual: fileSha256,
          sha256_verified: shaVerified,
          parquet_sha256_manifest: sourceEntry?.sha256 ?? '',
          record_count: manifestFile?.record_count ?? allRows.length,
        },
        pools: poolSummaries,
        derivedLabels: {
          rule: 'newest fact (largest serial) whose text contains one of the gold answers',
          questions: stats.questions,
          with_target: stats.withTarget,
          multiple_answer_candidates: stats.multipleCandidates,
          unscorable: stats.unscorable,
          facts: stats.facts,
          shipped_labels: false,
        },
        currentFactRecall: {
          questions: block.queries,
          'recall@1': block['recall@1'] ?? 0,
          'recall@5': block['recall@5'] ?? 0,
          'recall@10': block['recall@10'] ?? 0,
          mrr: block.mrr,
          'ndcg@10': block['ndcg@10'] ?? 0,
          servedTokens: block.servedTokens,
        },
        overall: block,
        bySubDataset,
        qa: qaBlock,
      }
      thresholds[configName] = {
        ...topLineFromBlock(block, ks),
        ...(qaBlock.readers?.engram ? { qaScore: qaBlock.readers.engram.score } : {}),
      }
    }

    const markdown = renderMabMarkdown({
      rowsFile,
      sourceFile,
      stats,
      poolSummaries,
      indexedFacts,
      indexedChars,
      metrics,
      configNames: ctx.configs.map(([name]) => name),
      timings,
      qa: qaBlock,
    })

    return {
      result: {
        suite: 'memoryagentbench',
        header: ctx.buildHeader({
          suite: 'memoryagentbench',
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

function mabNotes(input: {
  stats: MabTargetStats
  poolSummaries: Array<{ source: string; facts: number; questions: number; unscorable: number }>
  rowsFile: string
  sourceFile: string
  manifestFile: { sha256: string; bytes: number; record_count: number | null } | null
  sourceEntry: { sha256: string; bytes: number } | null
  fileSha256: string
  shaVerified: boolean
  qaBlock: BenchQaBlock
  readerModel: string
  filter: string | null
}): string[] {
  const notes: string[] = []
  notes.push(
    `dataset memoryagentbench split ${MAB_SPLIT}: ${input.poolSummaries.length} pool(s)` +
      (input.filter ? ` (filtered to ${input.filter})` : '') +
      `, ${input.stats.questions} question(s), ${input.stats.facts} numbered fact(s) from ${input.rowsFile}`
  )
  notes.push(
    'selective forgetting in the paper, conflict resolution in the release: each pool carries a fact and a ' +
      'later contradicting fact, and the prompt tells the reader that the larger serial number is newer'
  )
  notes.push(
    `derived labels: the split ships no evidence or decoy labels, so a target is the newest fact carrying one ` +
      `of the gold answers — ${input.stats.withTarget}/${input.stats.questions} question(s) resolved, ` +
      `${input.stats.unscorable} left unscorable, and ${input.stats.multipleCandidates} question(s) have more ` +
      'than one answer-carrying fact, which is where the rule is a choice rather than a lookup'
  )
  notes.push(
    (input.manifestFile
      ? `hashes: rows sha256 ${input.fileSha256.slice(0, 16)}…, upstream parquet sha256 ` +
        `${input.sourceEntry?.sha256.slice(0, 16) ?? '?'}… (${input.sourceEntry?.bytes ?? 0} bytes)`
      : 'hashes: the rows file is not in the dataset manifest; run the fetch to record its sha256') +
      (input.shaVerified ? '' : ' — SHA256 MISMATCH against the manifest; re-fetch with --force')
  )
  if (input.qaBlock.status === 'ok') {
    notes.push(
      `qa: ${Object.keys(input.qaBlock.readers ?? {}).length} reader(s) x ${input.qaBlock.questions_answered} ` +
        `question(s), ${input.qaBlock.calls} call(s); reader model ${input.readerModel}, scorer ` +
        `${input.qaBlock.scorer}@${input.qaBlock.scorer_version}, reader prompt ${input.qaBlock.prompt_version}`
    )
    if ((input.qaBlock.failures?.length ?? 0) > 0) {
      notes.push(`qa failures: ${input.qaBlock.failures?.length} (see details.qa.failures)`)
    }
  } else {
    notes.push(`qa skipped: ${input.qaBlock.note ?? 'not requested'}`)
  }
  notes.push(
    'readers: engram retrieves facts with recall_context, naive-rag with lexical top-k, full-context sends the ' +
      'whole pool; the official run feeds the pool to memory in 4096-token chunks, which this harness does not ' +
      'model (the pool is ingested fact by fact)'
  )
  return notes
}

export function renderMabMarkdown(input: {
  rowsFile: string
  sourceFile: string
  stats: MabTargetStats
  poolSummaries: Array<{ source: string; facts: number; questions: number; unscorable: number }>
  indexedFacts: number
  indexedChars: number
  metrics: Record<string, unknown>
  configNames: string[]
  timings: Record<string, TimingSummary>
  qa: BenchQaBlock
}): string {
  const rows: Array<Array<string | number>> = []
  for (const config of input.configNames) {
    const entry = input.metrics[config] as {
      currentFactRecall: Record<string, number>
      overall: { queries: number }
    }
    if (!entry) continue
    rows.push([
      config,
      entry.overall.queries,
      entry.currentFactRecall['recall@1'] ?? 0,
      entry.currentFactRecall['recall@5'] ?? 0,
      entry.currentFactRecall['recall@10'] ?? 0,
      entry.currentFactRecall.mrr,
      entry.currentFactRecall['ndcg@10'] ?? 0,
      entry.currentFactRecall.servedTokens,
    ])
  }

  const poolRows: Array<Array<string | number>> = []
  const first = input.metrics[input.configNames[0]] as
    | { bySubDataset?: Record<string, { questions: number; 'recall@1': number; 'recall@10': number; mrr: number }> }
    | undefined
  for (const [pool, block] of Object.entries(first?.bySubDataset ?? {})) {
    poolRows.push([pool, block.questions, block['recall@1'], block['recall@10'], block.mrr])
  }

  const sections: string[] = [
    `Memoryagentbench ${MAB_SPLIT}: ${input.poolSummaries.length} pool(s) over ` +
      `${input.indexedFacts} fact(s) (${input.indexedChars} chars). A query target is the newest fact that ` +
      'states the gold answer, so recall@1 asks whether the current value outranks the one it replaced.',
    markdownTable({
      columns: ['config', 'questions', 'recall@1', 'recall@5', 'recall@10', 'mrr', 'ndcg@10', 'servedTokens'],
      rows,
    }),
    `### by sub-dataset (config ${input.configNames[0] ?? 'baseline'})\n\n${markdownTable({
      columns: ['sub-dataset', 'questions', 'recall@1', 'recall@5', 'recall@10', 'mrr'],
      rows: poolRows,
    })}`,
  ]

  if (input.qa.status === 'ok') {
    sections.push(
      `### reader comparison (official substring match)\n\n${markdownTable({
        columns: ['reader', 'graded', 'accuracy', 'exact', 'ctx tokens/q', 'reader in tokens/q', 'reader out tokens/q'],
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
        typeRows.push([name, type, stat.graded, stat.score])
      }
    }
    sections.push(
      `### accuracy by sub-dataset\n\n${markdownTable({
        columns: ['reader', 'sub-dataset', 'graded', 'accuracy'],
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
          ['calls (no judge call)', input.qa.calls ?? 0],
          ['questions answered', input.qa.questions_answered ?? 0],
          ['resumed questions', input.qa.resumed_questions ?? 0],
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
        ['pools', input.poolSummaries.length],
        ['facts', input.stats.facts],
        ['questions', input.stats.questions],
        ['target resolved', input.stats.withTarget],
        ['unscorable (no answer-carrying fact)', input.stats.unscorable],
        ['more than one answer-carrying fact', input.stats.multipleCandidates],
        ['rows file', input.rowsFile],
        ['parquet source', input.sourceFile],
      ],
    })}`,
    `### latency (wall clock; not covered by the determinism guarantee)\n\n${renderTimings(input.timings)}`
  )
  return sections.join('\n\n')
}
