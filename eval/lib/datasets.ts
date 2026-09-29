// the dataset manifest written by eval/fetch-datasets.ts. longmemeval keeps its own
// `splits` map for compatibility; everything else lands under `datasets`, one entry per
// dataset with the files it produced, their sha256 and the schema read back from them.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './report.js'

export const DATASETS_DIR = join(REPO_ROOT, 'eval', 'datasets')

export interface DatasetFileEntry {
  role: 'source' | 'rows' | 'rows-jsonl'
  file: string
  bytes: number
  sha256: string
  record_count: number | null
  /** set when the file was derived from another one, e.g. parquet -> jsonl */
  derived_from?: string
}

export interface DatasetEntry {
  id: string
  title: string
  url: string
  license: string
  /** what the split is, for the report */
  note: string
  files: DatasetFileEntry[]
  fetched_at: string
  schema: Record<string, unknown>
}

export interface DatasetManifest {
  repo: string
  fetched_at: string
  splits?: Record<string, unknown>
  datasets?: Record<string, DatasetEntry>
}

export const DATASET_MANIFEST_PATH = join(DATASETS_DIR, 'manifest.json')

export function loadDatasetManifest(path: string = DATASET_MANIFEST_PATH): DatasetManifest | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DatasetManifest
  } catch {
    return null
  }
}

export function datasetEntry(id: string, path?: string): DatasetEntry | null {
  return loadDatasetManifest(path)?.datasets?.[id] ?? null
}

/** absolute path of a dataset file, manifest first, filename fallback */
export function datasetFilePath(entry: DatasetEntry | null, role: DatasetFileEntry['role'], fallback: string): string {
  const file = entry?.files.find((candidate) => candidate.role === role)?.file
  return join(DATASETS_DIR, file ?? fallback)
}

export function datasetFileEntry(entry: DatasetEntry | null, role: DatasetFileEntry['role']): DatasetFileEntry | null {
  return entry?.files.find((candidate) => candidate.role === role) ?? null
}

/** the fetch command a user needs, named in every missing-dataset error */
export function fetchHint(id: string): string {
  return `npm run eval:datasets -- --dataset ${id}`
}

export function datasetPresent(path: string): boolean {
  return existsSync(path)
}
