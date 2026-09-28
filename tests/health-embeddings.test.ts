import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pipeline as transformersPipeline } from '@huggingface/transformers'
import { createServer } from '../src/server.js'
import { getDatabase, resetDatabase, resolveDbPath } from '../src/db/init.js'
import { resolvePidFile } from '../src/utils/pid.js'
import {
  MODEL_ID,
  embeddingState,
  modelRequiredPaths,
  modelWeightsPath,
  resolveModelCacheDir,
  warmEmbeddings,
} from '../src/embeddings/pipeline.js'
import { resetServicesForTests } from '../src/mcp/handlers.js'

/** counting calls to the transformers.js pipeline proves the health endpoint never constructs the embedder */
const pipelineCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('@huggingface/transformers', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    pipeline: vi.fn(async () => {
      pipelineCalls.count += 1
      throw new Error('embedding pipeline was constructed during a health call')
    }),
  }
})

interface HealthBody {
  status: string
  uptime: number
  memoryCount: number
  sessionCount: number
  version: string
  embeddings: {
    model: string
    ready: boolean
    loaded: boolean
    vectorsAvailable: boolean
  }
}

async function getHealth(): Promise<{ status: number; body: HealthBody }> {
  const app = createServer()
  const res = await app.request('/health')
  return { status: res.status, body: (await res.json()) as HealthBody }
}

// write the on-disk layout transformers.js produces for the model: all four files
// are required, because dropping any of them sends a load to the hub, and offline
// that load fails into the silent fts5 fallback this field exists to prevent.
function seedModelCache(cacheDir: string, weightsBytes = 4096): void {
  const modelDir = join(cacheDir, ...MODEL_ID.split('/'))
  mkdirSync(join(modelDir, 'onnx'), { recursive: true })
  writeFileSync(join(modelDir, 'config.json'), '{}')
  writeFileSync(join(modelDir, 'tokenizer.json'), '{}')
  writeFileSync(join(modelDir, 'tokenizer_config.json'), '{}')
  writeFileSync(modelWeightsPath(cacheDir), Buffer.alloc(weightsBytes))
}

describe('GET /health embeddings state', () => {
  let savedCacheDir: string | undefined
  let savedSwitch: string | undefined
  const tempDirs: string[] = []

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'engram-health-'))
    tempDirs.push(dir)
    return dir
  }

  beforeEach(() => {
    savedCacheDir = process.env.ENGRAM_MODEL_CACHE_DIR
    savedSwitch = process.env.ENGRAM_EMBEDDINGS
    // these cases are about the model path, so the suite-wide off switch must not apply
    delete process.env.ENGRAM_EMBEDDINGS
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  afterEach(() => {
    if (savedCacheDir === undefined) delete process.env.ENGRAM_MODEL_CACHE_DIR
    else process.env.ENGRAM_MODEL_CACHE_DIR = savedCacheDir
    if (savedSwitch === undefined) delete process.env.ENGRAM_EMBEDDINGS
    else process.env.ENGRAM_EMBEDDINGS = savedSwitch
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reports ready:false, and never a 500, when the model cache dir is empty', async () => {
    process.env.ENGRAM_MODEL_CACHE_DIR = tempDir()

    const { status, body } = await getHealth()

    expect(status).toBe(200)
    expect(body.embeddings.ready).toBe(false)
    expect(body.embeddings.model).toBe(MODEL_ID)
    // the probe must use the override, not the real ~137MB cache
    expect(resolveModelCacheDir()).toBe(process.env.ENGRAM_MODEL_CACHE_DIR)
  })

  it('reports ready:true when the cache holds the complete nomic-embed-text-v1.5 layout', async () => {
    const cacheDir = tempDir()
    seedModelCache(cacheDir)
    process.env.ENGRAM_MODEL_CACHE_DIR = cacheDir

    const { status, body } = await getHealth()

    expect(status).toBe(200)
    expect(body.embeddings.ready).toBe(true)
  })

  /**
   * `ready:true` claims a load needs no download, so a partial cache must not report
   * it: each layout here still sends a load to the hub, which offline ends in the
   * silent fts5 fallback. `files` picks which of the four artifacts are cached.
   */
  const requiredFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json'] as const
  type RequiredFile = (typeof requiredFiles)[number] | 'onnx/model_quantized.onnx'

  function seedPartialModelCache(cacheDir: string, files: readonly RequiredFile[]): void {
    const modelDir = join(cacheDir, ...MODEL_ID.split('/'))
    mkdirSync(join(modelDir, 'onnx'), { recursive: true })
    for (const file of files) {
      const path = join(modelDir, file)
      writeFileSync(path, file.endsWith('.onnx') ? Buffer.alloc(4096) : '{}')
    }
  }

  it('reports ready:false when only the weights are cached (a load still fetches 715,125 bytes)', async () => {
    const cacheDir = tempDir()
    seedPartialModelCache(cacheDir, ['onnx/model_quantized.onnx'])
    process.env.ENGRAM_MODEL_CACHE_DIR = cacheDir

    const { status, body } = await getHealth()

    expect(status).toBe(200)
    expect(body.embeddings.ready).toBe(false)
  })

  it('reports ready:false when the weights and config.json are cached but the tokenizer is not', async () => {
    const cacheDir = tempDir()
    seedPartialModelCache(cacheDir, ['config.json', 'onnx/model_quantized.onnx'])
    process.env.ENGRAM_MODEL_CACHE_DIR = cacheDir

    const { body } = await getHealth()

    expect(body.embeddings.ready).toBe(false)
  })

  it('reports ready:false when the weights and tokenizer.json are cached but config.json is not', async () => {
    const cacheDir = tempDir()
    seedPartialModelCache(cacheDir, ['tokenizer.json', 'onnx/model_quantized.onnx'])
    process.env.ENGRAM_MODEL_CACHE_DIR = cacheDir

    const { body } = await getHealth()

    expect(body.embeddings.ready).toBe(false)
  })

  it('reports ready:false when only tokenizer_config.json is missing (a load still fetches 1,191 bytes)', async () => {
    const cacheDir = tempDir()
    seedPartialModelCache(cacheDir, ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'])
    process.env.ENGRAM_MODEL_CACHE_DIR = cacheDir

    const { body } = await getHealth()

    expect(body.embeddings.ready).toBe(false)
  })

  it('reports ready:false when a required file is present but zero-byte', async () => {
    const cacheDir = tempDir()
    seedModelCache(cacheDir)
    // an interrupted download leaves a zero-byte tokenizer.json behind
    writeFileSync(join(cacheDir, ...MODEL_ID.split('/'), 'tokenizer.json'), '')
    process.env.ENGRAM_MODEL_CACHE_DIR = cacheDir

    const { body } = await getHealth()

    expect(body.embeddings.ready).toBe(false)
  })

  it('reports ready:false when the weights file is missing from the model dir', async () => {
    const cacheDir = tempDir()
    mkdirSync(join(cacheDir, ...MODEL_ID.split('/'), 'onnx'), { recursive: true })
    process.env.ENGRAM_MODEL_CACHE_DIR = cacheDir

    const { body } = await getHealth()

    expect(body.embeddings.ready).toBe(false)
  })

  it('reports ready:false for a zero-byte weights file (interrupted download)', async () => {
    const cacheDir = tempDir()
    seedModelCache(cacheDir, 0)
    process.env.ENGRAM_MODEL_CACHE_DIR = cacheDir

    const { body } = await getHealth()

    expect(body.embeddings.ready).toBe(false)
  })

  it('degrades to ready:false instead of 500 when the cache path is unusable', async () => {
    // a path under a regular file cannot be stat'ed; health still answers
    const blocker = join(tempDir(), 'not-a-dir')
    writeFileSync(blocker, 'x')
    process.env.ENGRAM_MODEL_CACHE_DIR = join(blocker, 'models')

    const { status, body } = await getHealth()

    expect(status).toBe(200)
    expect(body.embeddings.ready).toBe(false)
  })

  it('keeps the existing fields and adds embeddings with the model id and three booleans', async () => {
    process.env.ENGRAM_MODEL_CACHE_DIR = tempDir()

    const { status, body } = await getHealth()

    expect(status).toBe(200)
    expect(body.status).toBe('ok')
    expect(typeof body.uptime).toBe('number')
    expect(typeof body.memoryCount).toBe('number')
    expect(typeof body.sessionCount).toBe('number')
    expect(typeof body.version).toBe('string')
    expect(body.embeddings.model).toBe('nomic-ai/nomic-embed-text-v1.5')
    expect(body.embeddings.ready).toBe(false)
    expect(body.embeddings.loaded).toBe(false)
    expect(typeof body.embeddings.vectorsAvailable).toBe('boolean')
    expect(body.embeddings.vectorsAvailable).toBe(getDatabase().vectorsAvailable)
  })

  it('loads no model and fetches nothing during a health call', async () => {
    const cacheDir = tempDir()
    process.env.ENGRAM_MODEL_CACHE_DIR = cacheDir
    pipelineCalls.count = 0

    const { status, body } = await getHealth()

    expect(status).toBe(200)
    // the pipeline was never constructed...
    expect(pipelineCalls.count).toBe(0)
    // ...the embedder is not loaded in this process...
    expect(body.embeddings.loaded).toBe(false)
    expect(embeddingState().loaded).toBe(false)
    // ...and no download started: the cache dir is untouched
    expect(readdirSync(cacheDir)).toEqual([])
  })

  it('would notice a load: the pipeline spy records real construction attempts', async () => {
    // non-vacuity check for the test above: if the spy were not the module the daemon
    // imports, "no model load" would pass without proving anything
    process.env.ENGRAM_MODEL_CACHE_DIR = tempDir()
    expect(vi.isMockFunction(transformersPipeline)).toBe(true)
    expect(pipelineCalls.count).toBe(0)

    // warmEmbeddings() is the one entry point allowed to construct it, so the counter
    // must move here (the mock throws instead of downloading)
    expect(await warmEmbeddings()).toBe(false)
    expect(pipelineCalls.count).toBe(1)
  })
})

/**
 * the same overrides the daemon itself reads, so a test instance cannot collide with
 * the daemon on its default port
 */
describe('isolation env overrides', () => {
  it('lists every cached file a q8 feature-extraction load reads', () => {
    expect(modelRequiredPaths('/tmp/c')).toEqual([
      join('/tmp/c', MODEL_ID, 'config.json'),
      join('/tmp/c', MODEL_ID, 'tokenizer.json'),
      join('/tmp/c', MODEL_ID, 'tokenizer_config.json'),
      join('/tmp/c', MODEL_ID, 'onnx', 'model_quantized.onnx'),
    ])
  })

  it('resolves the model cache dir from ENGRAM_MODEL_CACHE_DIR', () => {
    expect(resolveModelCacheDir({} as NodeJS.ProcessEnv).endsWith('models')).toBe(true)
    expect(resolveModelCacheDir({ ENGRAM_MODEL_CACHE_DIR: '/tmp/x' } as NodeJS.ProcessEnv)).toBe('/tmp/x')
    expect(resolveModelCacheDir({ ENGRAM_MODEL_CACHE_DIR: '   ' } as NodeJS.ProcessEnv).endsWith('models')).toBe(
      true
    )
  })

  it('resolves the database path from ENGRAM_DB_PATH, else from the data dir', () => {
    expect(resolveDbPath({ ENGRAM_DB_PATH: '/tmp/e/engram.db' } as NodeJS.ProcessEnv)).toBe('/tmp/e/engram.db')
    expect(resolveDbPath({ ENGRAM_DATA_DIR: '/tmp/e' } as NodeJS.ProcessEnv)).toBe(join('/tmp/e', 'engram.db'))
    // neither is set, so the env-paths default keeps its filename
    expect(resolveDbPath({} as NodeJS.ProcessEnv).endsWith('engram.db')).toBe(true)
  })

  it('resolves the pid file inside the ENGRAM_DATA_DIR override', () => {
    expect(resolvePidFile({ ENGRAM_DATA_DIR: '/tmp/e' } as NodeJS.ProcessEnv)).toBe(join('/tmp/e', 'engram.pid'))
    expect(resolvePidFile({} as NodeJS.ProcessEnv).endsWith('engram.pid')).toBe(true)
  })
})
