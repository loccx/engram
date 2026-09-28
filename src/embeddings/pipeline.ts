// local embedder: nomic-embed-text-v1.5. it wants task prefixes and a layer_norm
// pass after pooling, or the vectors are useless — see the model card

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { join } from 'path'
import { mkdirSync, statSync } from 'fs'
import envPaths from 'env-paths'

const paths = envPaths('engram')

/** env-paths data dir unless ENGRAM_MODEL_CACHE_DIR points somewhere else; read per call */
export function resolveModelCacheDir(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.ENGRAM_MODEL_CACHE_DIR?.trim()
  return override ? override : join(paths.data, 'models')
}

/** keyword-only mode when ENGRAM_EMBEDDINGS=off: the model is never loaded or downloaded; read per call */
export function embeddingsDisabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.ENGRAM_EMBEDDINGS?.trim().toLowerCase() === 'off'
}

// best effort on purpose: an unusable path must not stop the daemon booting
function ensureModelCacheDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

// module scope: a throw here kills the daemon before /health can say ready:false
const initialCacheDir = resolveModelCacheDir()
if (!ensureModelCacheDir(initialCacheDir)) {
  process.stderr.write(
    `Engram: model cache directory '${initialCacheDir}' is unusable; running without the local model (FTS5 keyword search only).\n`
  )
}
env.cacheDir = initialCacheDir

export const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5'

export const EMBEDDING_DIM = 768

// nomic wants a different prefix for a query than for a document
const TASK_PREFIX = {
  document: 'search_document: ',
  query: 'search_query: ',
} as const

export type EmbeddingMode = 'document' | 'query'

/** l2 cut for zettelkasten auto-linking: 0.837 is cos 0.65 on unit vectors (cos = 1 - l2²/2) */
export const LINK_DISTANCE_THRESHOLD = 0.837

/** near-duplicate cut: L2 0.316 is cos 0.95 on unit vectors */
export const DUPLICATE_DISTANCE_THRESHOLD = 0.316

let _pipeline: FeatureExtractionPipeline | null = null
let _loading: Promise<FeatureExtractionPipeline> | null = null
let _failed = false

/** layout transformers.js expects for MODEL_ID under the cache dir */
const MODEL_WEIGHTS_RELATIVE = join(MODEL_ID, 'onnx', 'model_quantized.onnx')

// every file a q8 load reads. transformers.js fetches whatever is missing, so
// "ready" may only claim all of them are cached — offline, a partial cache fails
// the load and lands in the silent FTS5 fallback
const MODEL_REQUIRED_FILES = [
  join(MODEL_ID, 'config.json'),
  join(MODEL_ID, 'tokenizer.json'),
  join(MODEL_ID, 'tokenizer_config.json'),
  MODEL_WEIGHTS_RELATIVE,
] as const

/** absolute path of the weights a q8 load reads */
export function modelWeightsPath(cacheDir: string = resolveModelCacheDir()): string {
  return join(cacheDir, MODEL_WEIGHTS_RELATIVE)
}

/** every cached file a q8 load needs, under cacheDir */
export function modelRequiredPaths(cacheDir: string = resolveModelCacheDir()): string[] {
  return MODEL_REQUIRED_FILES.map((relative) => join(cacheDir, relative))
}

/** readiness snapshot for /health and the setup UIs */
export interface EmbeddingState {
  model: string
  /** weights alone are not ready: a load would still fetch the tokenizer and config */
  ready: boolean
  loaded: boolean
}

// a zero-byte file is an interrupted download, not a usable one
function modelFilesPresent(): boolean {
  try {
    return modelRequiredPaths().every((path) => {
      const stats = statSync(path)
      return stats.isFile() && stats.size > 0
    })
  } catch {
    return false
  }
}

/** stat only: never loads the model or touches the network, and never throws */
export function embeddingState(): EmbeddingState {
  try {
    return { model: MODEL_ID, ready: !embeddingsDisabled() && modelFilesPresent(), loaded: _pipeline !== null }
  } catch {
    return { model: MODEL_ID, ready: false, loaded: _pipeline !== null }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _layerNorm: ((input: any, shape: number[]) => any) | null = null

async function loadLayerNorm(): Promise<typeof _layerNorm> {
  if (_layerNorm) return _layerNorm
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await import('@huggingface/transformers') as any
  _layerNorm = mod.layer_norm ?? null
  return _layerNorm
}

async function getPipeline(): Promise<FeatureExtractionPipeline | null> {
  if (_failed || embeddingsDisabled()) return null
  if (_pipeline) return _pipeline
  if (!_loading) {
    _loading = (async () => {
      // env.cacheDir was pinned at module load; callers may set the variable after
      const cacheDir = resolveModelCacheDir()
      env.cacheDir = cacheDir
      if (!ensureModelCacheDir(cacheDir)) {
        // a download into a dir that cannot hold the model, then a failure; take
        // the same FTS5 fallback every other load failure takes
        process.stderr.write(
          `Engram: model cache directory '${cacheDir}' is unusable, falling back to FTS5.\n`
        )
        _failed = true
        return null as unknown as FeatureExtractionPipeline
      }
      process.stderr.write('Engram: loading embedding model (first run only)...\n')
      const p = await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      process.stderr.write('Engram: embedding model ready.\n')
      return p as FeatureExtractionPipeline
    })().catch((e) => {
      process.stderr.write(`Engram: embedding model unavailable (${e.message}), falling back to FTS5.\n`)
      _failed = true
      return null as unknown as FeatureExtractionPipeline
    })
  }
  _pipeline = await _loading
  return _pipeline
}

/** normalized 768-dim vector, or null when the model is unavailable */
export async function getEmbedding(
  text: string,
  mode: EmbeddingMode = 'document'
): Promise<Float32Array | null> {
  const p = await getPipeline()
  if (!p) return null
  try {
    // 8k is the model's context limit
    const prefixed = TASK_PREFIX[mode] + text.slice(0, 8192)
    const output = await p(prefixed, { pooling: 'mean' })

    // layer_norm then matryoshka slice then L2 normalize — the model card's order
    const ln = await loadLayerNorm()
    if (ln) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const normalized = ln(output, [(output as any).dims[1]])
        .slice(null, [0, EMBEDDING_DIM])
        .normalize(2, -1)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new Float32Array((normalized as any).tolist()[0] as number[])
    }

    // no layer_norm: raw pooled output, L2 only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (output as any).normalize(2, -1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Float32Array((raw as any).tolist()[0] as number[])
  } catch {
    return null
  }
}

export async function warmEmbeddings(): Promise<boolean> {
  const p = await getPipeline()
  return p !== null
}
