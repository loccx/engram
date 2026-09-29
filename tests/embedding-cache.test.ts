// the embedding cache: keys, both backends and the pipeline wiring. the model is a fake
// (one deterministic row per input text) so the suite stays hermetic, but everything
// above it — task prefix, the 8k cut, the key, the hit, the write — is the shipped code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  CACHE_SWEEP_EVERY,
  DiskEmbeddingCache,
  activeEmbeddingCache,
  createDbEmbeddingCache,
  embeddingCacheKey,
  embeddingCacheReport,
  embeddingCacheStats,
  formatEmbeddingCacheReport,
  registerEmbeddingCache,
  resetEmbeddingCacheForTests,
  vectorFromBytes,
  type EmbeddingCacheEntry,
} from '../src/embeddings/cache.js'
import { EMBEDDING_DIM, MODEL_DTYPE, MODEL_ID, getEmbedding } from '../src/embeddings/pipeline.js'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { migration022 } from '../src/db/migrations/022_embedding_cache.js'
import { tableExists } from '../src/db/migrations/types.js'

const modelCalls = vi.hoisted(() => [] as Array<{ model: string; dtype: string; inputs: string[] }>)

// a fake feature-extraction pipeline: one deterministic row per input, and a throw when
// an input asks for one, so the "never cache a failure" branch has something to hit
vi.mock('@huggingface/transformers', () => {
  const dim = 768
  const rowFor = (text: string): number[] => {
    let seed = 2166136261
    for (let i = 0; i < text.length; i++) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619) >>> 0
    const row: number[] = []
    for (let i = 0; i < dim; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      row.push(seed / 2 ** 32 - 0.5)
    }
    return row
  }
  const tensor = (rows: number[][]) => ({
    dims: [rows.length, rows[0]?.length ?? 0],
    slice: () => tensor(rows),
    normalize: () => tensor(rows),
    tolist: () => rows,
  })
  return {
    env: {} as Record<string, unknown>,
    layer_norm: (output: unknown) => output,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pipeline: async (_task: string, model: string, options: any) => {
      return async (texts: string | string[]) => {
        const inputs = Array.isArray(texts) ? texts : [texts]
        modelCalls.push({ model, dtype: options?.dtype, inputs })
        if (inputs.some((input) => input.includes('boom'))) throw new Error('fake model failure')
        return tensor(inputs.map(rowFor))
      }
    },
  }
})

const ENV_KEYS = ['ENGRAM_EMBEDDINGS', 'ENGRAM_EMBED_CACHE', 'ENGRAM_EMBED_CACHE_DIR'] as const

let savedEnv: Array<[string, string | undefined]> = []
const tempDirs: string[] = []
let db: Database.Database | null = null

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-embed-cache-'))
  tempDirs.push(dir)
  return dir
}

/** the migration's own table, so the test cannot pass on a shape nobody ships */
function cacheDb(): Database.Database {
  const opened = new Database(':memory:')
  migration022.up(opened)
  db = opened
  return opened
}

function makeEntry(key: string, fill: number): EmbeddingCacheEntry {
  return {
    key,
    model: MODEL_ID,
    dtype: MODEL_DTYPE,
    mode: 'document',
    vector: new Float32Array(EMBEDDING_DIM).fill(fill),
  }
}

function bytesOf(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

beforeEach(() => {
  savedEnv = ENV_KEYS.map((key) => [key, process.env[key]])
  resetEmbeddingCacheForTests()
  // the suite's global switch is off, so the pipeline must be turned back on per test
  process.env.ENGRAM_EMBEDDINGS = 'on'
  delete process.env.ENGRAM_EMBED_CACHE
  delete process.env.ENGRAM_EMBED_CACHE_DIR
})

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetEmbeddingCacheForTests()
  resetDatabase()
  if (db) {
    db.close()
    db = null
  }
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('cache keys', () => {
  const base = { model: MODEL_ID, dtype: MODEL_DTYPE, dim: EMBEDDING_DIM, mode: 'document' as const, text: 'a turn' }

  it('is a stable hex sha256 of the key material', () => {
    const key = embeddingCacheKey(base)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(embeddingCacheKey(base)).toBe(key)
    expect(embeddingCacheKey({ ...base, text: 'another turn' })).not.toBe(key)
  })

  it('separates every field a different model, dtype, dim or mode would change', () => {
    const key = embeddingCacheKey(base)
    expect(embeddingCacheKey({ ...base, model: 'other/model' })).not.toBe(key)
    expect(embeddingCacheKey({ ...base, dtype: 'fp32' })).not.toBe(key)
    expect(embeddingCacheKey({ ...base, dim: 256 })).not.toBe(key)
    expect(embeddingCacheKey({ ...base, mode: 'query' })).not.toBe(key)
  })

  it('cannot confuse two fields that shift position', () => {
    expect(embeddingCacheKey({ ...base, model: 'a\0b' })).not.toBe(
      embeddingCacheKey({ ...base, dtype: 'a\0b' })
    )
  })
})

describe('the db backend', () => {
  it('round-trips the exact bytes the model returned', () => {
    const cache = createDbEmbeddingCache(cacheDb(), { dim: EMBEDDING_DIM })
    const vector = new Float32Array(EMBEDDING_DIM).map((_, index) => Math.sin(index))
    cache.put({ ...makeEntry('k1', 0), vector })
    const read = cache.get('k1')
    expect(read).not.toBeNull()
    expect(bytesOf(read!).equals(bytesOf(vector))).toBe(true)
    // a copy per read, so a caller mutating its vector cannot poison the cache
    read![0] = 99
    expect(bytesOf(cache.get('k1')!).equals(bytesOf(vector))).toBe(true)
  })

  it('misses on an unknown key and drops a stored blob that is not a whole vector', () => {
    const opened = cacheDb()
    const cache = createDbEmbeddingCache(opened, { dim: EMBEDDING_DIM })
    expect(cache.get('nothing')).toBeNull()
    opened
      .prepare(
        `INSERT INTO embedding_cache (key, model, dtype, mode, dim, vector, created_at, last_used_at)
         VALUES ('short', 'm', 'q8', 'document', 768, ?, 1, 1)`
      )
      .run(Buffer.from([1, 2, 3]))
    expect(cache.get('short')).toBeNull()
    expect(cache.size()).toBe(0)
    expect(embeddingCacheStats().corrupt).toBe(1)
  })

  it('evicts the least recently used rows past the cap', () => {
    let clock = 1000
    const cache = createDbEmbeddingCache(cacheDb(), {
      dim: EMBEDDING_DIM,
      maxRows: 2,
      touchWindowMs: 0,
      now: () => ++clock,
    })
    cache.put(makeEntry('a', 1))
    cache.put(makeEntry('b', 2))
    cache.put(makeEntry('c', 3))
    expect(cache.size()).toBe(3)
    // a fresh hit on a moves it ahead of b, so b is the one the cap drops
    expect(cache.get('a')).not.toBeNull()
    expect(cache.evict()).toBe(1)
    expect(cache.size()).toBe(2)
    expect(cache.get('b')).toBeNull()
    expect(cache.get('a')).not.toBeNull()
    expect(cache.get('c')).not.toBeNull()
  })

  it('sweeps on its own once the insert throttle is reached', () => {
    let clock = 0
    const cache = createDbEmbeddingCache(cacheDb(), {
      dim: EMBEDDING_DIM,
      maxRows: 4,
      touchWindowMs: 0,
      now: () => ++clock,
    })
    for (let i = 0; i < CACHE_SWEEP_EVERY; i++) cache.put(makeEntry(`k${i}`, i))
    expect(cache.size()).toBe(4)
    expect(embeddingCacheStats().evictions).toBe(CACHE_SWEEP_EVERY - 4)
    expect(cache.evict()).toBe(0)
  })

  it('refuses a read when the table is absent, without throwing', () => {
    const bare = new Database(':memory:')
    db = bare
    const cache = createDbEmbeddingCache(bare, { dim: EMBEDDING_DIM })
    expect(cache.get('k')).toBeNull()
    cache.put(makeEntry('k', 1))
    expect(cache.size()).toBe(0)
  })
})

describe('the disk backend', () => {
  it('round-trips bytes through the files and misses on an unknown key', () => {
    const cache = new DiskEmbeddingCache(tempDir())
    const vector = new Float32Array(EMBEDDING_DIM).map((_, index) => Math.cos(index))
    expect(cache.get('missing')).toBeNull()
    cache.put({ ...makeEntry('abc123', 0), vector })
    const read = cache.get('abc123')
    expect(bytesOf(read!).equals(bytesOf(vector))).toBe(true)
  })

  it('drops a file whose bytes are not a whole vector instead of serving it', () => {
    const dir = tempDir()
    const cache = new DiskEmbeddingCache(dir)
    mkdirSync(join(dir, 'ba'), { recursive: true })
    writeFileSync(cache.pathFor('bad'), Buffer.from([1, 2, 3, 4, 5]))
    expect(cache.get('bad')).toBeNull()
    expect(existsSync(cache.pathFor('bad'))).toBe(false)
    expect(embeddingCacheStats().corrupt).toBe(1)
  })
})

describe('the pipeline', () => {
  it('serves the second call of a text from the disk cache, byte for byte', async () => {
    process.env.ENGRAM_EMBED_CACHE = 'off'
    const fresh = await getEmbedding('a deploy window moved to tuesday')
    expect(fresh).not.toBeNull()
    expect(embeddingCacheStats().writes).toBe(0)

    const dir = tempDir()
    delete process.env.ENGRAM_EMBED_CACHE
    process.env.ENGRAM_EMBED_CACHE_DIR = dir
    const first = await getEmbedding('a deploy window moved to tuesday')
    const second = await getEmbedding('a deploy window moved to tuesday')
    expect(bytesOf(second!).equals(bytesOf(first!))).toBe(true)
    expect(bytesOf(second!).equals(bytesOf(fresh!))).toBe(true)
    expect(embeddingCacheStats()).toMatchObject({ hits: 1, writes: 1 })
  })

  it('answers the db backend across two rows of the same content', async () => {
    const opened = cacheDb()
    registerEmbeddingCache(createDbEmbeddingCache(opened, { dim: EMBEDDING_DIM }))
    const first = await getEmbedding('the rollback drill runs on fridays')
    const second = await getEmbedding('the rollback drill runs on fridays')
    expect(bytesOf(second!).equals(bytesOf(first!))).toBe(true)
    expect(embeddingCacheStats()).toMatchObject({ hits: 1, writes: 1 })
    const row = opened
      .prepare('SELECT model, dtype, mode, dim FROM embedding_cache')
      .get() as { model: string; dtype: string; mode: string; dim: number }
    expect(row).toEqual({ model: MODEL_ID, dtype: MODEL_DTYPE, mode: 'document', dim: EMBEDDING_DIM })
  })

  it('serves the second write of a content through the table the daemon registers', async () => {
    const dbm = getDatabase(':memory:')
    expect(activeEmbeddingCache()).not.toBeNull()
    const first = await getEmbedding('a session summary about the release train')
    const second = await getEmbedding('a session summary about the release train')
    expect(bytesOf(second!).equals(bytesOf(first!))).toBe(true)
    expect(embeddingCacheStats()).toMatchObject({ hits: 1, writes: 1 })
    const rows = dbm.db.prepare('SELECT COUNT(*) AS n FROM embedding_cache').get() as { n: number }
    expect(rows.n).toBe(1)
    resetDatabase()
    expect(activeEmbeddingCache()).toBeNull()
  })

  it('keys on the text after the 8k cut, so a longer tail shares one entry', async () => {
    const dir = tempDir()
    process.env.ENGRAM_EMBED_CACHE_DIR = dir
    const head = 'h'.repeat(8192)
    const first = await getEmbedding(`${head} and a tail that never reaches the model`)
    const second = await getEmbedding(`${head} another tail entirely`)
    expect(bytesOf(second!).equals(bytesOf(first!))).toBe(true)
    expect(embeddingCacheStats()).toMatchObject({ hits: 1, writes: 1 })
  })

  it('keeps the query and the document of one text apart', async () => {
    const dir = tempDir()
    process.env.ENGRAM_EMBED_CACHE_DIR = dir
    const asDocument = await getEmbedding('rollback drill', 'document')
    const asQuery = await getEmbedding('rollback drill', 'query')
    expect(bytesOf(asQuery!).equals(bytesOf(asDocument!))).toBe(false)
    expect(embeddingCacheStats()).toMatchObject({ hits: 0, writes: 2 })
  })

  it('never caches a failed embed', async () => {
    const dir = tempDir()
    process.env.ENGRAM_EMBED_CACHE_DIR = dir
    expect(await getEmbedding('boom')).toBeNull()
    expect(embeddingCacheStats().writes).toBe(0)
    const wrote = await getEmbedding('a text that works')
    expect(wrote).not.toBeNull()
    expect(embeddingCacheStats().writes).toBe(1)
  })

  it('writes nothing while the model is switched off', async () => {
    const dir = tempDir()
    process.env.ENGRAM_EMBED_CACHE_DIR = dir
    process.env.ENGRAM_EMBEDDINGS = 'off'
    expect(await getEmbedding('anything at all')).toBeNull()
    expect(embeddingCacheStats().writes).toBe(0)
  })

  it('records the model and dtype the loader actually used', () => {
    const last = modelCalls[modelCalls.length - 1]
    expect(last).toBeDefined()
    expect(last.model).toBe(MODEL_ID)
    expect(last.dtype).toBe(MODEL_DTYPE)
    expect(last.inputs[0].startsWith('search_document: ')).toBe(true)
  })

  it('resolves the backend from the environment, off winning over a dir', () => {
    const dir = tempDir()
    expect(activeEmbeddingCache({ ENGRAM_EMBED_CACHE_DIR: dir })).toBeInstanceOf(DiskEmbeddingCache)
    expect(activeEmbeddingCache({ ENGRAM_EMBED_CACHE_DIR: dir, ENGRAM_EMBED_CACHE: 'OFF' })).toBeNull()
    expect(activeEmbeddingCache({})).toBeNull()
    const opened = new Database(':memory:')
    db = opened
    registerEmbeddingCache(createDbEmbeddingCache(opened, { dim: EMBEDDING_DIM }))
    expect(activeEmbeddingCache({})).not.toBeNull()
    expect(embeddingCacheReport({}).backend).toBe('db')
    expect(embeddingCacheReport({ ENGRAM_EMBED_CACHE_DIR: dir }).backend).toBe('disk')
    expect(embeddingCacheReport({ ENGRAM_EMBED_CACHE: 'off' }).backend).toBe('off')
  })

  it('reports hits, misses and writes in one line', () => {
    const line = formatEmbeddingCacheReport({
      backend: 'disk',
      dir: '/tmp/vectors',
      stats: { hits: 3, misses: 1, writes: 4, evictions: 0, corrupt: 0, writeErrors: 0 },
    })
    expect(line).toBe('embedding cache (disk /tmp/vectors): 3 hits, 1 misses (75.0% hit), 4 writes, 0 evictions')
  })
})

describe('vector bytes', () => {
  it('rejects bytes that cannot be a vector', () => {
    expect(vectorFromBytes(new Uint8Array(0))).toBeNull()
    expect(vectorFromBytes(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(vectorFromBytes(new Uint8Array(8))).toEqual(new Float32Array([0, 0]))
  })
})

describe('the migration', () => {
  it('creates the cache table and its lru index', () => {
    const opened = cacheDb()
    expect(tableExists(opened, 'embedding_cache')).toBe(true)
    const indexes = opened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_embedding_cache_lru'")
      .all() as Array<{ name: string }>
    expect(indexes).toHaveLength(1)
    migration022.up(opened)
  })
})
