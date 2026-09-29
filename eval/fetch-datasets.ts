#!/usr/bin/env node
// dataset fetcher (EVAL-CONTRACT.md "Datasets"): `npm run eval:datasets` pulls the
// longmemeval oracle split (~15 MB), `-- --full` the s-split (~277 MB), and
// `-- --dataset locomo|memoryagentbench|all` the other two suites' data.
// every file streams to disk while its sha256 is computed, then the real schema is read
// back out of the downloaded bytes into eval/datasets/manifest.json: verified, never
// assumed. the memoryagentbench release is parquet only, so the fetch decodes it here and
// writes the rows as jsonl next to it, recording both hashes.
import { Command } from 'commander'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { countTopLevelElements, readFirstRecord, scanJsonArray } from './lib/json-stream.js'
import { parquetSchema, readParquetColumns } from './lib/parquet.js'
import type { DatasetEntry, DatasetFileEntry } from './lib/datasets.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DATASETS_DIR = join(REPO_ROOT, 'eval', 'datasets')
export const MANIFEST_PATH = join(DATASETS_DIR, 'manifest.json')

export const DATASET_REPO = 'xiaowu0162/longmemeval-cleaned'

export interface SplitSpec {
  /** split name on the hub */
  split: string
  /** file inside the repo */
  file: string
  /** approximate size, for progress text only */
  approxBytes: number
}

export const SPLITS: Record<string, SplitSpec> = {
  longmemeval_oracle: {
    split: 'longmemeval_oracle',
    file: 'longmemeval_oracle.json',
    approxBytes: 15_388_478,
  },
  longmemeval_s_cleaned: {
    split: 'longmemeval_s_cleaned',
    file: 'longmemeval_s_cleaned.json',
    approxBytes: 277_000_000,
  },
  longmemeval_m_cleaned: {
    split: 'longmemeval_m_cleaned',
    file: 'longmemeval_m_cleaned.json',
    approxBytes: 0,
  },
}

export function resolveUrl(spec: SplitSpec): string {
  return `https://huggingface.co/datasets/${DATASET_REPO}/resolve/main/${spec.file}`
}

export interface DatasetSource {
  id: string
  title: string
  url: string
  /** file inside eval/datasets */
  file: string
  license: string
  note: string
  approxBytes: number
}

export const DATASET_SOURCES: Record<string, DatasetSource> = {
  locomo: {
    id: 'locomo',
    title: 'LoCoMo: ten long multi-session conversations with dialog-level QA evidence ids',
    url: 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json',
    file: 'locomo10.json',
    license: 'CC-BY-NC-4.0',
    note:
      'non-commercial: the file is fetched into the gitignored eval/datasets and must never be ' +
      'committed, quoted or redistributed from this repo',
    approxBytes: 2_805_274,
  },
  memoryagentbench: {
    id: 'memoryagentbench',
    title: 'MemoryAgentBench: Conflict_Resolution split (factconsolidation sh/mh pools)',
    url: 'https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/resolve/main/data/Conflict_Resolution-00000-of-00001.parquet',
    file: 'Conflict_Resolution.parquet',
    license: 'MIT',
    note: 'parquet only on the hub, so the fetch decodes it and writes Conflict_Resolution.jsonl beside it',
    approxBytes: 1_491_588,
  },
}

interface ManifestSplitEntry {
  split: string
  file: string
  url: string
  bytes: number
  sha256: string
  record_count: number | null
  fetched_at: string
  schema: {
    verified_from: 'downloaded file'
    root_type: 'array' | 'object' | 'unknown'
    record_keys: string[]
    session_message_keys: string[]
    sessions_per_record: { min: number; max: number; mean: number } | null
    has_answer_session_ids: boolean
    has_haystack_session_ids: boolean
    has_per_message_has_answer: boolean
    notes: string
  }
}

interface Manifest {
  repo: string
  repo_sha?: string
  fetched_at: string
  splits: Record<string, ManifestSplitEntry>
  datasets?: Record<string, DatasetEntry>
}

interface CliOptions {
  full?: boolean
  split?: string
  dataset?: string
  force?: boolean
  out?: string
}

const program = new Command()
program
  .name('engram-eval-datasets')
  .description('Download eval datasets and record their schema')
  .option('--full', 'longmemeval: fetch longmemeval_s_cleaned (277 MB) instead of the 15 MB oracle split')
  .option('--split <name>', 'longmemeval: explicit split name')
  .option('--dataset <name>', 'locomo | memoryagentbench | longmemeval | all', 'longmemeval')
  .option('--force', 're-download even when the file is already present')
  .option('--out <dir>', 'dataset directory (default eval/datasets)')
  .parse(process.argv)

const options = program.opts<CliOptions>()

async function main(): Promise<number> {
  const outDir = options.out ? join(REPO_ROOT, options.out) : DATASETS_DIR
  mkdirSync(outDir, { recursive: true })
  const manifestPath = join(outDir, 'manifest.json')
  const manifest = readManifest(manifestPath)
  const requested = options.dataset ?? 'longmemeval'

  if (requested === 'longmemeval') {
    return fetchLongMemEval(outDir, manifestPath, manifest)
  }
  if (requested === 'all') {
    const first = await fetchLongMemEval(outDir, manifestPath, manifest)
    await fetchDataset('locomo', outDir, manifestPath)
    await fetchDataset('memoryagentbench', outDir, manifestPath)
    return first
  }
  const source = DATASET_SOURCES[requested]
  if (!source) {
    throw new Error(
      `unknown dataset "${requested}" — known: longmemeval, ${Object.keys(DATASET_SOURCES).join(', ')}, all`
    )
  }
  await fetchDataset(requested, outDir, manifestPath)
  return 0
}

async function fetchLongMemEval(
  outDir: string,
  manifestPath: string,
  manifest: Manifest | null
): Promise<number> {
  const splitName = options.split ?? (options.full ? 'longmemeval_s_cleaned' : 'longmemeval_oracle')
  const spec = SPLITS[splitName]
  if (!spec) {
    throw new Error(`unknown split "${splitName}" — known: ${Object.keys(SPLITS).join(', ')}`)
  }

  const target = join(outDir, spec.file)
  const url = resolveUrl(spec)

  process.stdout.write(
    `dataset: ${DATASET_REPO} split ${spec.split} (~${formatBytes(spec.approxBytes)})\n` +
      `  url:   ${url}\n` +
      `  into:  ${target}\n`
  )

  const { bytes, sha256 } = await fetchOrHash(url, target, options.force === true)
  const schema = await inspectSchema(target)
  const recordCount = await countTopLevelElements(target)

  const entry: ManifestSplitEntry = {
    split: spec.split,
    file: spec.file,
    url,
    bytes,
    sha256,
    record_count: recordCount,
    fetched_at: new Date().toISOString(),
    schema,
  }

  const next: Manifest = {
    ...(manifest ?? { repo: DATASET_REPO, fetched_at: entry.fetched_at, splits: {} }),
    repo: DATASET_REPO,
    ...(manifest?.repo_sha ? { repo_sha: manifest.repo_sha } : {}),
    fetched_at: entry.fetched_at,
    splits: { ...(manifest?.splits ?? {}), [spec.split]: entry },
  }
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')

  process.stdout.write(
    `  bytes:  ${bytes}\n` +
      `  sha256: ${sha256}\n` +
      `  records: ${recordCount ?? 'unknown'}\n` +
      `  schema record keys: ${schema.record_keys.join(', ')}\n` +
      `  schema session message keys: ${schema.session_message_keys.join(', ')}\n` +
      `  answer_session_ids present: ${schema.has_answer_session_ids}\n` +
      `  haystack_session_ids present: ${schema.has_haystack_session_ids}\n` +
      `  per-message has_answer present: ${schema.has_per_message_has_answer}\n` +
      `\nmanifest written to ${manifestPath}\n`
  )
  return 0
}

async function fetchDataset(id: string, outDir: string, manifestPath: string): Promise<void> {
  const source = DATASET_SOURCES[id]
  const target = join(outDir, source.file)
  process.stdout.write(
    `\ndataset: ${source.title}\n` +
      `  url:     ${source.url}\n` +
      `  into:    ${target}\n` +
      `  license: ${source.license} — ${source.note}\n`
  )
  const { bytes, sha256 } = await fetchOrHash(source.url, target, options.force === true)
  process.stdout.write(`  bytes:   ${bytes}\n  sha256:  ${sha256}\n`)

  const files: DatasetFileEntry[] = [
    { role: 'source', file: source.file, bytes, sha256, record_count: null },
  ]
  let schema: Record<string, unknown>
  if (id === 'locomo') {
    schema = inspectLocomo(target, files)
  } else {
    schema = await inspectMemoryAgentBench(target, outDir, files)
  }

  const entry: DatasetEntry = {
    id: source.id,
    title: source.title,
    url: source.url,
    license: source.license,
    note: source.note,
    files,
    fetched_at: new Date().toISOString(),
    schema,
  }
  updateManifest(manifestPath, (manifest) => ({
    ...manifest,
    datasets: { ...(manifest.datasets ?? {}), [id]: entry },
  }))
  const rows = files.find((file) => file.role === 'rows')
  process.stdout.write(
    `  records: ${rows?.record_count ?? files[0].record_count ?? 'unknown'}\n` +
      Object.entries(schema)
        .map(([key, value]) => `  schema ${key}: ${formatSchemaValue(value)}`)
        .join('\n') +
      `\n\nmanifest written to ${manifestPath}\n`
  )
}

function inspectLocomo(target: string, files: DatasetFileEntry[]): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(target, 'utf8')) as Array<{
    sample_id: string
    conversation: Record<string, unknown>
    qa: Array<{ category: number; evidence?: string[]; answer?: string; adversarial_answer?: string }>
  }>
  const recordKeys = new Set<string>()
  const qaKeys = new Set<string>()
  const turnKeys = new Set<string>()
  const categories: Record<string, number> = {}
  let questions = 0
  let turns = 0
  let sessions = 0
  let withEvidence = 0
  let noEvidence = 0
  let adversarialWithoutAnswer = 0
  for (const record of parsed) {
    for (const key of Object.keys(record)) recordKeys.add(key)
    for (const [key, value] of Object.entries(record.conversation)) {
      const match = key.match(/^session_(\d+)$/)
      if (!match || !Array.isArray(value)) continue
      sessions++
      for (const turn of value as Array<Record<string, unknown>>) {
        turns++
        for (const turnKey of Object.keys(turn)) turnKeys.add(turnKey)
      }
    }
    for (const qa of record.qa) {
      questions++
      for (const key of Object.keys(qa)) qaKeys.add(key)
      categories[String(qa.category)] = (categories[String(qa.category)] ?? 0) + 1
      if ((qa.evidence ?? []).length > 0) withEvidence++
      else noEvidence++
      if (qa.category === 5 && qa.answer === undefined) adversarialWithoutAnswer++
    }
  }
  files[0].record_count = parsed.length
  return {
    record_keys: [...recordKeys].sort(),
    qa_keys: [...qaKeys].sort(),
    turn_keys: [...turnKeys].sort(),
    conversations: parsed.length,
    sessions,
    dialog_turns: turns,
    questions,
    questions_with_evidence: withEvidence,
    questions_without_evidence: noEvidence,
    questions_by_category: categories,
    adversarial_rows_without_answer: adversarialWithoutAnswer,
    evidence_field: 'qa[].evidence = dialog ids (D<session>:<turn>)',
    notes:
      'cc by-nc 4.0: fetch only, never commit; category ids are 1 multi-hop, 2 temporal, ' +
      '3 open-domain, 4 single-hop, 5 adversarial (mapped from the official scorer)',
  }
}

async function inspectMemoryAgentBench(
  target: string,
  outDir: string,
  files: DatasetFileEntry[]
): Promise<Record<string, unknown>> {
  const requested = ['context', 'questions', 'answers', 'metadata.source', 'metadata.qa_pair_ids']
  const decoded = readParquetColumns(target, requested)
  const columns = new Map(decoded.columns.map((column) => [column.path, column.values]))
  const sources = columns.get('metadata.source') as string[]
  const contexts = columns.get('context') as string[]
  const questionLists = columns.get('questions') as string[][]
  const answerLists = columns.get('answers') as string[][][]
  const qaPairIds = (columns.get('metadata.qa_pair_ids') ?? []) as string[][]

  const rows = decoded.rows
  const pools: Array<{
    source: string
    context_chars: number
    facts: number
    questions: number
    answers_per_question: number
  }> = []
  const encoded: string[] = []
  for (let index = 0; index < rows; index++) {
    const facts = contexts[index].split('\n').filter((line) => /^\d+\.\s+/.test(line.trim()))
    pools.push({
      source: sources[index],
      context_chars: contexts[index].length,
      facts: facts.length,
      questions: questionLists[index].length,
      answers_per_question: answerLists[index].length,
    })
    encoded.push(
      JSON.stringify({
        source: sources[index],
        context: contexts[index],
        questions: questionLists[index],
        answers: answerLists[index],
        qa_pair_ids: qaPairIds[index] ?? [],
      })
    )
  }

  const rowsFile = `${join(outDir, 'Conflict_Resolution.jsonl')}`
  writeFileSync(rowsFile, `${encoded.join('\n')}\n`, 'utf8')
  const rowsBytes = statSync(rowsFile).size
  const rowsSha256 = await hashFile(rowsFile)
  files.push({
    role: 'rows',
    file: 'Conflict_Resolution.jsonl',
    bytes: rowsBytes,
    sha256: rowsSha256,
    record_count: rows,
    derived_from: 'Conflict_Resolution.parquet',
  })

  return {
    parquet_columns: parquetSchema(target),
    row_keys: ['source', 'context', 'questions', 'answers', 'qa_pair_ids'],
    split_rows: rows,
    sub_datasets: pools.map((pool) => pool.source),
    pools,
    rows_file: `Conflict_Resolution.jsonl (${rowsBytes} bytes, sha256 ${rowsSha256.slice(0, 16)}…)`,
    evidence_field: 'none: the split ships no evidence or decoy labels',
    notes:
      'mit; the parquet holds one row per factconsolidation pool, each with a numbered fact ' +
      'list, 100 questions and their accepted answers; the rows file is derived by the fetch',
  }
}

function updateManifest(path: string, update: (manifest: Manifest) => Manifest): void {
  const current = readManifest(path) ?? { repo: DATASET_REPO, fetched_at: new Date().toISOString(), splits: {} }
  writeFileSync(path, `${JSON.stringify(update(current), null, 2)}\n`, 'utf8')
}

function readManifest(path: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest
  } catch {
    return null
  }
}

async function fetchOrHash(
  url: string,
  target: string,
  force: boolean
): Promise<{ bytes: number; sha256: string }> {
  let bytes: number
  let sha256: string
  if (existsSync(target) && !force) {
    process.stdout.write('  file already present; verifying size and hash instead of re-downloading\n')
    bytes = statSync(target).size
    sha256 = await hashFile(target)
  } else {
    await downloadToFile(url, target)
    bytes = statSync(target).size
    sha256 = await hashFile(target)
  }
  return { bytes, sha256 }
}

async function downloadToFile(url: string, target: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText} for ${url}`)
  }
  // stream to a temp name first, so an interrupted download never looks complete
  const temp = `${target}.part`
  await pipeline(response.body, createWriteStream(temp))
  renameSync(temp, target)
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** records inspected when deriving the schema; keys are stable per split */
export const SCHEMA_SAMPLE_SIZE = 20

/**
 * read from the file, never assumed: up to SCHEMA_SAMPLE_SIZE records, so
 * sessions_per_record is a real range rather than one record's value
 */
async function inspectSchema(path: string): Promise<ManifestSplitEntry['schema']> {
  const recordKeys = new Set<string>()
  const messageKeys = new Set<string>()
  const sessionsPerRecord: number[] = []
  let hasAnswerSessionIds = false
  let hasHaystackSessionIds = false
  let hasPerMessageAnswer = false
  let inspected = 0

  for await (const entry of scanJsonArray(path, { limit: SCHEMA_SAMPLE_SIZE })) {
    if (!entry.value || typeof entry.value !== 'object') continue
    inspected++
    const record = entry.value as {
      haystack_sessions?: unknown
      haystack_session_ids?: unknown
      answer_session_ids?: unknown
    }
    for (const key of Object.keys(record)) recordKeys.add(key)
    if (Array.isArray(record.answer_session_ids)) hasAnswerSessionIds = true
    if (Array.isArray(record.haystack_session_ids)) hasHaystackSessionIds = true
    const sessions = Array.isArray(record.haystack_sessions) ? record.haystack_sessions : []
    sessionsPerRecord.push(sessions.length)
    for (const session of sessions) {
      if (!Array.isArray(session)) continue
      for (const message of session) {
        if (!message || typeof message !== 'object') continue
        for (const key of Object.keys(message)) {
          messageKeys.add(key)
          if (key === 'has_answer') hasPerMessageAnswer = true
        }
      }
    }
  }

  const sessionsStat =
    sessionsPerRecord.length > 0
      ? {
          min: Math.min(...sessionsPerRecord),
          max: Math.max(...sessionsPerRecord),
          mean:
            Math.round(
              (sessionsPerRecord.reduce((a, b) => a + b, 0) / sessionsPerRecord.length) * 100
            ) / 100,
        }
      : null

  const notes = [
    `inspected ${inspected} record(s)`,
    hasAnswerSessionIds
      ? 'answer_session_ids is present in this split'
      : 'answer_session_ids is ABSENT in this split; ground truth = per-message has_answer + haystack_session_ids',
  ]

  return {
    verified_from: 'downloaded file',
    root_type: recordKeys.size > 0 ? 'array' : 'unknown',
    record_keys: [...recordKeys].sort(),
    session_message_keys: [...messageKeys].sort(),
    sessions_per_record: sessionsStat,
    has_answer_session_ids: hasAnswerSessionIds,
    has_haystack_session_ids: hasHaystackSessionIds,
    has_per_message_has_answer: hasPerMessageAnswer,
    notes: notes.join('; '),
  }
}

// the streaming scanner lives in eval/lib/json-stream.ts and is shared with the
// longmemeval suite, so fetch-time schema verification and index-time reading
// can never disagree about where a record begins.
export { countTopLevelElements, readFirstRecord }

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} kB`
  return `${bytes} B`
}

function formatSchemaValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 8
      ? `${value.slice(0, 8).map((item) => JSON.stringify(item)).join(', ')}, … (${value.length})`
      : value.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join(', ')
  }
  if (value && typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })

export { formatBytes }
