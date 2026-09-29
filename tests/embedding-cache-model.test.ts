// the real model, opt-in with ENGRAM_EMBED_CACHE_E2E=1: a cached vector has to be the
// bytes one uncached call returns, not a near copy. the sample is real longmemeval turns
// when the s split is on disk, plus a text past the 8k cut. the main suite stays
// hermetic, which is why this is gated instead of always on.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanJsonArray } from '../eval/lib/json-stream.js'
import { turnsOf, turnText } from '../eval/lib/turns.js'
import { EvalHarness } from '../eval/lib/harness.js'
import { DEFAULT_CONTEXT_BUDGET_CHARS } from '../eval/lib/readers.js'
import {
  closeAll,
  createSystems,
  runSystemQuestion,
  toSystemSessions,
  type MemorySystem,
} from '../eval/lib/systems.js'
import {
  DATASETS_DIR,
  emptyGroundTruth,
  recordToCorpus,
  type LmeRecord,
} from '../eval/suites/longmemeval.js'
import { EMBEDDING_DIM, getEmbedding } from '../src/embeddings/pipeline.js'
import { embeddingCacheStats, resetEmbeddingCacheForTests } from '../src/embeddings/cache.js'

const ENABLED = process.env.ENGRAM_EMBED_CACHE_E2E === '1'
const SPLIT = join(DATASETS_DIR, 'longmemeval_s_cleaned.json')
const ENV_KEYS = ['ENGRAM_EMBEDDINGS', 'ENGRAM_EMBED_CACHE', 'ENGRAM_EMBED_CACHE_DIR'] as const

const tempDirs: string[] = []
const harnesses: EvalHarness[] = []
const systems: MemorySystem[][] = []
let savedEnv: Array<[string, string | undefined]> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-embed-cache-e2e-'))
  tempDirs.push(dir)
  return dir
}

function bytesOf(vector: Float32Array | null): Buffer {
  if (!vector) throw new Error('no vector')
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

/** the first real haystack, built the way the eval builds it */
async function firstHaystack() {
  for await (const entry of scanJsonArray(SPLIT, { limit: 1 })) {
    return recordToCorpus(entry.value as LmeRecord, entry.index, emptyGroundTruth())
  }
  throw new Error(`${SPLIT} has no records`)
}

/** a spread of real turns from the first haystack: the earliest, and the longest four */
async function realTurns(): Promise<string[]> {
  const corpus = await firstHaystack()
  const turns = corpus.memories.flatMap((memory) => turnsOf(memory).map(turnText))
  const longest = [...turns].sort((a, b) => a.length - b.length).slice(-4)
  return [...turns.slice(0, 6), ...longest]
}

beforeEach(() => {
  savedEnv = ENV_KEYS.map((key) => [key, process.env[key]])
  resetEmbeddingCacheForTests()
  process.env.ENGRAM_EMBEDDINGS = 'on'
  delete process.env.ENGRAM_EMBED_CACHE
  delete process.env.ENGRAM_EMBED_CACHE_DIR
})

afterEach(async () => {
  while (systems.length > 0) await closeAll(systems.pop()!)
  while (harnesses.length > 0) harnesses.pop()!.dispose()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetEmbeddingCacheForTests()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe.skipIf(!ENABLED)('embedding cache against the real model', () => {
  it.skipIf(!existsSync(SPLIT))('returns the bytes of a fresh single call for real turns', async () => {
    const turns = await realTurns()
    expect(turns.length).toBeGreaterThanOrEqual(8)

    process.env.ENGRAM_EMBED_CACHE = 'off'
    const fresh: Float32Array[] = []
    for (const text of turns) {
      const vector = await getEmbedding(text)
      expect(vector?.length).toBe(EMBEDDING_DIM)
      fresh.push(vector!)
    }

    delete process.env.ENGRAM_EMBED_CACHE
    process.env.ENGRAM_EMBED_CACHE_DIR = tempDir()
    for (const [index, text] of turns.entries()) {
      const cold = await getEmbedding(text)
      const warm = await getEmbedding(text)
      expect(bytesOf(warm).equals(bytesOf(cold))).toBe(true)
      expect(bytesOf(warm).equals(bytesOf(fresh[index]))).toBe(true)
    }
    expect(embeddingCacheStats()).toMatchObject({
      hits: turns.length,
      writes: turns.length,
      misses: turns.length,
    })
  })

  it.skipIf(!existsSync(SPLIT))('serves the same context with and without the cache', async () => {
    const corpus = await firstHaystack()
    const sessions = toSystemSessions(corpus.memories)
    const namespace = corpus.query.namespace
    const runOnce = async (harness: EvalHarness): Promise<string> => {
      const [system] = await createSystems(['engram-episodes'], { harness, topK: 10, seed: 11 })
      systems.push([system])
      const result = await runSystemQuestion({
        harness,
        system,
        namespace,
        sessions,
        query: corpus.query.query,
        budgetChars: DEFAULT_CONTEXT_BUDGET_CHARS,
      })
      return result.context
    }

    process.env.ENGRAM_EMBED_CACHE = 'off'
    const uncached = await EvalHarness.create({ seed: 11, vectors: 'cached' })
    harnesses.push(uncached)
    const withoutCache = await runOnce(uncached)

    delete process.env.ENGRAM_EMBED_CACHE
    process.env.ENGRAM_EMBED_CACHE_DIR = tempDir()
    const cached = await EvalHarness.create({ seed: 11, vectors: 'cached' })
    harnesses.push(cached)
    const cold = await runOnce(cached)
    const warm = await runOnce(cached)

    expect(warm).toBe(withoutCache)
    expect(cold).toBe(withoutCache)
    expect(embeddingCacheStats().hits).toBeGreaterThan(corpus.memories.length * 4)
  }, 900_000)

  it('shares one entry between two texts that differ past the 8k cut', async () => {
    const head = 'a turn with a very long tail '.repeat(400).slice(0, 8192)
    process.env.ENGRAM_EMBED_CACHE_DIR = tempDir()
    const cold = await getEmbedding(`${head} first tail`)
    const warm = await getEmbedding(`${head} second, longer tail that never reaches the model`)
    expect(bytesOf(warm).equals(bytesOf(cold))).toBe(true)
    expect(embeddingCacheStats()).toMatchObject({ hits: 1, writes: 1 })
  })
})
