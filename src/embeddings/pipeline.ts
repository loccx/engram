/**
 * Local embedding pipeline using @huggingface/transformers.
 * Downloads nomic-ai/nomic-embed-text-v1.5 (~137MB quantized) on first use,
 * then caches locally. Zero external services required.
 *
 * Model: nomic-embed-text-v1.5 — 768 dims, 8K context, Matryoshka.
 * Requires task prefixes and layer normalization post-processing.
 * See: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { join } from 'path'
import { mkdirSync } from 'fs'
import envPaths from 'env-paths'

const paths = envPaths('engram')

const modelCacheDir = join(paths.data, 'models')
mkdirSync(modelCacheDir, { recursive: true })
env.cacheDir = modelCacheDir

export const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5'

export const EMBEDDING_DIM = 768

// nomic requires different prefixes for documents vs queries
const TASK_PREFIX = {
  document: 'search_document: ',
  query: 'search_query: ',
} as const

export type EmbeddingMode = 'document' | 'query'

/**
 * L2-distance threshold for Zettelkasten auto-linking (cosine_sim > ~0.65).
 * For normalized unit vectors: cos_sim = 1 - L2²/2
 * L2=0.837 → cos_sim≈0.65. Previous threshold (1.2 → cos_sim 0.28) linked
 * barely-related memories, polluting the knowledge graph.
 */
export const LINK_DISTANCE_THRESHOLD = 0.837

/**
 * L2-distance threshold for near-duplicate detection (cosine_sim > 0.95).
 * L2=0.316 → cos_sim≈0.95.
 */
export const DUPLICATE_DISTANCE_THRESHOLD = 0.316

let _pipeline: FeatureExtractionPipeline | null = null
let _loading: Promise<FeatureExtractionPipeline> | null = null
let _failed = false

// Cache the layer_norm function after first dynamic import
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
  if (_failed) return null
  if (_pipeline) return _pipeline
  if (!_loading) {
    _loading = (async () => {
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

/**
 * Compute a normalized 768-dim embedding for a single text.
 * Mode determines task prefix: 'document' for storage, 'query' for search.
 * Returns null if the model is unavailable (FTS5 fallback still works).
 */
export async function getEmbedding(
  text: string,
  mode: EmbeddingMode = 'document'
): Promise<Float32Array | null> {
  const p = await getPipeline()
  if (!p) return null
  try {
    // nomic-embed-text-v1.5: 8K token context
    const prefixed = TASK_PREFIX[mode] + text.slice(0, 8192)
    const output = await p(prefixed, { pooling: 'mean' })

    // nomic models require layer_norm → optional Matryoshka slice → L2 normalize
    // (huggingface.co/nomic-ai/nomic-embed-text-v1.5#transformersjs)
    const ln = await loadLayerNorm()
    if (ln) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const normalized = ln(output, [(output as any).dims[1]])
        .slice(null, [0, EMBEDDING_DIM])
        .normalize(2, -1)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new Float32Array((normalized as any).tolist()[0] as number[])
    }

    // Fallback if layer_norm unavailable: use raw pooled output with L2 norm
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (output as any).normalize(2, -1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Float32Array((raw as any).tolist()[0] as number[])
  } catch {
    return null
  }
}

/**
 * Warm up the model (pre-load before first real request).
 * Call from `engram warm` or daemon startup.
 */
export async function warmEmbeddings(): Promise<boolean> {
  const p = await getPipeline()
  return p !== null
}
