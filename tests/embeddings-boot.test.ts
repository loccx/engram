import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { MODEL_ID } from '../src/embeddings/pipeline.js'

// boot the real cli in a child process with a poisoned ENGRAM_MODEL_CACHE_DIR.
// it has to be a child: the in-process health suite imports pipeline.ts once, at
// collection time, with a healthy environment, so a throwing module-scope side effect
// is already past. only a fresh process can show the import-time crash — a bogus cache
// dir must not kill the daemon at boot instead of serving ready:false.
// the child gets its own data dir, db path and port, so it cannot touch the real one.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * the built cli (dist/index.js, what the installed binary runs), falling back to tsx
 * on the sources before a build — and when dist/ is older than the module under test,
 * so a stale build cannot produce a false pass
 */
function resolveCli(): { command: string; args: string[]; entry: string } {
  const built = join(repoRoot, 'dist', 'index.js')
  const source = join(repoRoot, 'src', 'embeddings', 'pipeline.ts')
  const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx')
  if (existsSync(built) && existsSync(tsx)) {
    const stale = statSync(built).mtimeMs < statSync(source).mtimeMs
    if (!stale) return { command: process.execPath, args: [built], entry: built }
    return { command: tsx, args: [join(repoRoot, 'src', 'index.ts')], entry: tsx }
  }
  if (existsSync(built)) return { command: process.execPath, args: [built], entry: built }
  if (existsSync(tsx)) return { command: tsx, args: [join(repoRoot, 'src', 'index.ts')], entry: tsx }
  throw new Error('neither dist/index.js nor node_modules/.bin/tsx exists; run npm run build first')
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
  })
}

interface HealthBody {
  status: string
  uptime: number
  memoryCount: number
  sessionCount: number
  version: string
  embeddings: { model: string; ready: boolean; loaded: boolean; vectorsAvailable: boolean }
}

interface Booted {
  status: number
  body: HealthBody
  stderr: string
  /** true when the process was still alive after answering */
  alive: boolean
}

const spawned: Array<{ child: ChildProcess; workdir: string }> = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const { child, workdir } of spawned.splice(0)) {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    rmSync(workdir, { recursive: true, force: true })
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** isolated on disk and port, with no llm settings, since those make the daemon do
 * network work the assertions do not expect */
function childEnv(cacheDir: string, workdir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...{} }
  delete env.ENGRAM_LLM_BASE_URL
  delete env.ENGRAM_LLM_API_KEY
  delete env.ENGRAM_ALLOW_NONLOCAL
  delete env.ENGRAM_EMBEDDINGS
  return {
    ...env,
    ENGRAM_MODEL_CACHE_DIR: cacheDir,
    ENGRAM_DATA_DIR: join(workdir, 'data'),
    ENGRAM_DB_PATH: join(workdir, 'engram.db'),
  }
}

/** spawn, wait for /health, return the response; throws with stderr when the process
 * dies first, the failure this test exists for */
async function boot(cacheDir: string): Promise<Booted> {
  const port = await freePort()
  const workdir = tempDir('engram-boot-')
  const { command, args } = resolveCli()
  const child = spawn(command, [...args, 'start', '--port', String(port)], {
    cwd: repoRoot,
    env: childEnv(cacheDir, workdir),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  spawned.push({ child, workdir })

  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.stdout.on('data', () => {})

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the daemon exited with code ${child.exitCode} during boot, before /health answered.\n--- child stderr ---\n${stderr}`
      )
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) {
        return { status: res.status, body: (await res.json()) as HealthBody, stderr, alive: child.exitCode === null }
      }
    } catch {
      // not listening yet (ECONNREFUSED): retry until the deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`the daemon never answered /health within 30s.\n--- child stderr ---\n${stderr}`)
}

/** the complete cache layout a q8 load reads */
function seedFullLayout(cacheDir: string): void {
  const modelDir = join(cacheDir, ...MODEL_ID.split('/'))
  mkdirSync(join(modelDir, 'onnx'), { recursive: true })
  for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
    writeFileSync(join(modelDir, file), '{}')
  }
  writeFileSync(join(modelDir, 'onnx', 'model_quantized.onnx'), Buffer.alloc(4096))
}

describe('daemon boot with a poisoned ENGRAM_MODEL_CACHE_DIR', () => {
  it('spawns the built CLI when dist is up to date, else the sources via tsx (guard against a vacuous harness)', () => {
    const { entry } = resolveCli()
    const built = join(repoRoot, 'dist', 'index.js')
    const source = join(repoRoot, 'src', 'embeddings', 'pipeline.ts')
    expect(existsSync(entry)).toBe(true)
    const distIsFresh = existsSync(built) && statSync(built).mtimeMs >= statSync(source).mtimeMs
    if (distIsFresh) {
      // after a build this must exercise the shipped artifact
      expect(entry).toBe(built)
    } else {
      expect(entry.endsWith('tsx')).toBe(true)
    }
  }, 10_000)

  it('still starts and serves /health with ready:false when the cache dir sits under a regular file (ENOTDIR)', async () => {
    const blocker = join(tempDir('engram-poison-'), 'not-a-dir')
    writeFileSync(blocker, 'x')

    const booted = await boot(join(blocker, 'models'))

    expect(booted.status).toBe(200)
    expect(booted.body.status).toBe('ok')
    expect(booted.body.embeddings.model).toBe(MODEL_ID)
    expect(booted.body.embeddings.ready).toBe(false)
    expect(booted.alive).toBe(true)
  }, 60_000)

  it('still starts and serves /health with ready:false when the cache path is itself a regular file (EEXIST)', async () => {
    const existingFile = join(tempDir('engram-poison-'), 'cache-is-a-file')
    writeFileSync(existingFile, 'x')

    const booted = await boot(existingFile)

    expect(booted.status).toBe(200)
    expect(booted.body.embeddings.ready).toBe(false)
    expect(booted.alive).toBe(true)
  }, 60_000)

  it('still starts and serves /health with ready:false when the cache dir cannot be created (EACCES)', async () => {
    if (process.getuid?.() === 0) {
      // root ignores the directory permission bits this case relies on
      return
    }
    const readOnly = tempDir('engram-poison-')
    // 0o500 on an owned directory: any mkdir below it fails EACCES
    const { chmodSync } = await import('fs')
    chmodSync(readOnly, 0o500)

    const booted = await boot(join(readOnly, 'models'))

    expect(booted.status).toBe(200)
    expect(booted.body.embeddings.ready).toBe(false)
    expect(booted.alive).toBe(true)
  }, 60_000)

  it('reports ready:true from the same harness when the complete layout is cached (control)', async () => {
    const cacheDir = tempDir('engram-control-')
    seedFullLayout(cacheDir)

    const booted = await boot(cacheDir)

    expect(booted.status).toBe(200)
    expect(booted.body.status).toBe('ok')
    expect(booted.body.embeddings.ready).toBe(true)
    expect(booted.body.embeddings.loaded).toBe(false)
    expect(booted.alive).toBe(true)
  }, 60_000)
})
