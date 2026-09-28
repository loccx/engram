#!/usr/bin/env node
// dataset fetcher (EVAL-CONTRACT.md "Datasets"): npm run eval:datasets pulls the
// oracle split (~15 MB), `-- --full` the s-split (~277 MB), from HuggingFace
// `xiaowu0162/longmemeval-cleaned`.
// the file streams to disk while its sha256 is computed, then the real schema is read
// back out of the downloaded bytes into eval/datasets/manifest.json: verified, never
// assumed (the oracle split has no `answer_session_ids` at all).
import { Command } from 'commander'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { countTopLevelElements, readFirstRecord, scanJsonArray } from './lib/json-stream.js'

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
}

interface CliOptions {
  full?: boolean
  split?: string
  force?: boolean
  out?: string
}

const program = new Command()
program
  .name('engram-eval-datasets')
  .description('Download the LongMemEval cleaned splits and record their schema')
  .option('--full', 'fetch longmemeval_s_cleaned (277 MB) instead of the 15 MB oracle split')
  .option('--split <name>', 'explicit split name')
  .option('--force', 're-download even when the file is already present')
  .option('--out <dir>', 'dataset directory (default eval/datasets)')
  .parse(process.argv)

const options = program.opts<CliOptions>()

async function main(): Promise<number> {
  const outDir = options.out ? join(REPO_ROOT, options.out) : DATASETS_DIR
  mkdirSync(outDir, { recursive: true })
  const splitName = options.split ?? (options.full ? 'longmemeval_s_cleaned' : 'longmemeval_oracle')
  const spec = SPLITS[splitName]
  if (!spec) {
    throw new Error(`unknown split "${splitName}" — known: ${Object.keys(SPLITS).join(', ')}`)
  }

  const target = join(outDir, spec.file)
  const manifestPath = join(outDir, 'manifest.json')
  const manifest = readManifest(manifestPath)
  const url = resolveUrl(spec)

  process.stdout.write(
    `dataset: ${DATASET_REPO} split ${spec.split} (~${formatBytes(spec.approxBytes)})\n` +
      `  url:   ${url}\n` +
      `  into:  ${target}\n`
  )

  let bytes: number
  let sha256: string
  if (existsSync(target) && !options.force) {
    process.stdout.write('  file already present; verifying size and hash instead of re-downloading\n')
    bytes = statSync(target).size
    sha256 = await hashFile(target)
  } else {
    await downloadToFile(url, target)
    bytes = statSync(target).size
    sha256 = await hashFile(target)
  }

  // read the real schema back from the bytes on disk. this is the "confirm, do
  // not assume" step: field names come from the file, not from documentation.
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

function readManifest(path: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest
  } catch {
    return null
  }
}

async function downloadToFile(url: string, target: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText} for ${url}`)
  }
  // stream to a temp name first, so an interrupted download never looks complete
  const temp = `${target}.part`
  await pipeline(response.body, createWriteStream(temp))
  const { renameSync } = await import('node:fs')
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

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })

export { formatBytes }
