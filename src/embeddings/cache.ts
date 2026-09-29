// content-addressed embedding cache. the key is a sha256 over the model, the dtype,
// the dimension, the mode and the exact string the model sees (task prefix and the 8k
// cut included), so one text is embedded once however many rows, namespaces or runs
// want it. two backends: a table in the live db, shared by every row of a deployment,
// and a directory of files, which is what a cross-process caller such as the eval
// harness points at a scratch dir. only a returned vector is written: a failed embed
// is never cached.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { EmbeddingMode } from './pipeline.js'

/** bumped when the key material changes, so old rows can never answer a new lookup */
export const CACHE_KEY_VERSION = 'v1'

export interface EmbeddingCacheEntry {
  key: string
  model: string
  dtype: string
  mode: EmbeddingMode
  vector: Float32Array
}

export interface EmbeddingCache {
  get(key: string): Float32Array | null
  put(entry: EmbeddingCacheEntry): void
}

export interface EmbeddingCacheStats {
  hits: number
  misses: number
  writes: number
  evictions: number
  /** stored bytes that were not a whole vector; the row or file is dropped */
  corrupt: number
  /** a backend write that failed: the embed still returns its vector */
  writeErrors: number
}

const stats: EmbeddingCacheStats = {
  hits: 0,
  misses: 0,
  writes: 0,
  evictions: 0,
  corrupt: 0,
  writeErrors: 0,
}

export interface EmbeddingCacheKeyInput {
  model: string
  dtype: string
  dim: number
  mode: EmbeddingMode
  /** the exact string handed to the model: task prefix plus truncated text */
  text: string
}

/** hex sha256 of the key material, null-separated so no field can bleed into another */
export function embeddingCacheKey(input: EmbeddingCacheKeyInput): string {
  return createHash('sha256')
    .update(
      [
        CACHE_KEY_VERSION,
        input.model,
        input.dtype,
        `${input.dim}`,
        input.mode,
        input.text,
      ].join('\0')
    )
    .digest('hex')
}

/** a stored vector, or null when the bytes are empty or not a whole number of floats */
export function vectorFromBytes(bytes: Uint8Array): Float32Array | null {
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Float32Array(copy.buffer)
}

/** little-endian float32, the same bytes the vec0 tables carry */
function vectorBytes(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

function dropFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // a cache that cannot delete its own junk is still a cache
  }
}

export const DEFAULT_EMBED_CACHE_MAX_ROWS = 20_000

/** a hit refreshes the lru stamp at most this often, so the common hit stays one read */
export const CACHE_TOUCH_WINDOW_MS = 60_000

/** inserts between two row-count sweeps: the cap can be overshot by less than this */
export const CACHE_SWEEP_EVERY = 64

export function resolveEmbedCacheMaxRows(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.ENGRAM_EMBED_CACHE_MAX_ROWS?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMBED_CACHE_MAX_ROWS
}

/** the cache is on by default; a deployment that wants no second copy of a vector turns it off */
export function embeddingCacheDisabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.ENGRAM_EMBED_CACHE?.trim().toLowerCase() === 'off'
}

/** the directory that switches the on-disk backend on, or null for the db table */
export function resolveEmbedCacheDir(environment: NodeJS.ProcessEnv = process.env): string | null {
  if (embeddingCacheDisabled(environment)) return null
  const dir = environment.ENGRAM_EMBED_CACHE_DIR?.trim()
  return dir ? dir : null
}

export interface DbEmbeddingCacheOptions {
  /** vectors of another length are dropped on read */
  dim: number
  maxRows?: number
  touchWindowMs?: number
  now?: () => number
}

interface DbStatements {
  get: Database.Statement
  put: Database.Statement
  touch: Database.Statement
  drop: Database.Statement
  count: Database.Statement
  evict: Database.Statement
}

/**
 * the table backend: one row per key inside the live db, so the same content written
 * under two namespaces, or re-ingested after a restart, costs one embed. rows are
 * capped and evicted least-recently-used first.
 */
export class DbEmbeddingCache implements EmbeddingCache {
  private statements: DbStatements | null = null
  private insertsSinceSweep = 0

  constructor(
    private readonly db: Database.Database,
    private readonly options: DbEmbeddingCacheOptions
  ) {}

  private prepare(): DbStatements | null {
    if (this.statements) return this.statements
    const present = this.db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'embedding_cache'"
      )
      .get() as { present: number } | undefined
    if (!present) return null
    this.statements = {
      get: this.db.prepare('SELECT vector FROM embedding_cache WHERE key = ?'),
      put: this.db.prepare(
        `INSERT INTO embedding_cache (key, model, dtype, mode, dim, vector, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           vector = excluded.vector,
           model = excluded.model,
           dtype = excluded.dtype,
           mode = excluded.mode,
           dim = excluded.dim,
           last_used_at = excluded.last_used_at`
      ),
      touch: this.db.prepare(
        'UPDATE embedding_cache SET last_used_at = ? WHERE key = ? AND last_used_at <= ?'
      ),
      drop: this.db.prepare('DELETE FROM embedding_cache WHERE key = ?'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM embedding_cache'),
      evict: this.db.prepare(
        `DELETE FROM embedding_cache WHERE key IN (
           SELECT key FROM embedding_cache ORDER BY last_used_at ASC, created_at ASC LIMIT ?
         )`
      ),
    }
    return this.statements
  }

  get(key: string): Float32Array | null {
    const statements = this.prepare()
    if (!statements) return null
    try {
      const row = statements.get.get(key) as { vector: Buffer } | undefined
      if (!row) {
        stats.misses += 1
        return null
      }
      const vector = vectorFromBytes(row.vector)
      if (!vector || vector.length !== this.options.dim) {
        stats.corrupt += 1
        stats.misses += 1
        try {
          statements.drop.run(key)
        } catch {
          // a row that cannot be dropped is a miss either way
        }
        return null
      }
      stats.hits += 1
      this.touch(key)
      return vector
    } catch {
      stats.misses += 1
      return null
    }
  }

  put(entry: EmbeddingCacheEntry): void {
    const statements = this.prepare()
    if (!statements) return
    const now = this.now()
    try {
      statements.put.run(
        entry.key,
        entry.model,
        entry.dtype,
        entry.mode,
        entry.vector.length,
        vectorBytes(entry.vector),
        now,
        now
      )
      stats.writes += 1
    } catch {
      stats.writeErrors += 1
      return
    }
    this.insertsSinceSweep += 1
    if (this.insertsSinceSweep >= CACHE_SWEEP_EVERY) {
      this.insertsSinceSweep = 0
      this.evict()
    }
  }

  /** drop the least-recently-used rows past the cap; returns how many went */
  evict(): number {
    const statements = this.prepare()
    if (!statements) return 0
    const maxRows = this.options.maxRows ?? DEFAULT_EMBED_CACHE_MAX_ROWS
    try {
      const { n } = statements.count.get() as { n: number }
      const over = n - maxRows
      if (over <= 0) return 0
      const info = statements.evict.run(over)
      stats.evictions += info.changes
      return info.changes
    } catch {
      return 0
    }
  }

  /** rows in the table, whatever their model */
  size(): number {
    const statements = this.prepare()
    if (!statements) return 0
    try {
      return (statements.count.get() as { n: number }).n
    } catch {
      return 0
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private touch(key: string): void {
    const statements = this.statements
    if (!statements) return
    const now = this.now()
    const window = this.options.touchWindowMs ?? CACHE_TOUCH_WINDOW_MS
    try {
      statements.touch.run(now, key, now - window)
    } catch {
      // a hit that cannot restamp its lru position is still a hit
    }
  }
}

export function createDbEmbeddingCache(
  db: Database.Database,
  options: DbEmbeddingCacheOptions
): DbEmbeddingCache {
  return new DbEmbeddingCache(db, options)
}

/**
 * the file backend: `<dir>/<first two hex chars>/<key>.vec` holding the raw float32
 * bytes, written to a temp name and renamed so a reader never sees half a file. the dir
 * is scratch: an entry whose model changed keeps its old key and is never read again.
 */
export class DiskEmbeddingCache implements EmbeddingCache {
  constructor(private readonly dir: string) {}

  pathFor(key: string): string {
    return join(this.dir, key.slice(0, 2), `${key}.vec`)
  }

  get(key: string): Float32Array | null {
    const path = this.pathFor(key)
    try {
      const vector = vectorFromBytes(readFileSync(path))
      if (!vector) {
        stats.corrupt += 1
        stats.misses += 1
        dropFile(path)
        return null
      }
      stats.hits += 1
      return vector
    } catch {
      stats.misses += 1
      return null
    }
  }

  put(entry: EmbeddingCacheEntry): void {
    const path = this.pathFor(entry.key)
    const temp = `${path}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(temp, vectorBytes(entry.vector))
      renameSync(temp, path)
      stats.writes += 1
    } catch {
      stats.writeErrors += 1
      dropFile(temp)
    }
  }
}

let registered: EmbeddingCache | null = null
let diskCache: { dir: string; cache: DiskEmbeddingCache } | null = null

/** the live db's table backend; the db layer owns this, so it unregisters on close */
export function registerEmbeddingCache(cache: EmbeddingCache | null): void {
  registered = cache
}

export function registeredEmbeddingCache(): EmbeddingCache | null {
  return registered
}

/** the backend the environment selects, read per call: a dir wins, then the db table */
export function activeEmbeddingCache(environment: NodeJS.ProcessEnv = process.env): EmbeddingCache | null {
  if (embeddingCacheDisabled(environment)) return null
  const dir = resolveEmbedCacheDir(environment)
  if (dir) {
    if (diskCache?.dir !== dir) diskCache = { dir, cache: new DiskEmbeddingCache(dir) }
    return diskCache.cache
  }
  return registered
}

export interface EmbeddingCacheReport {
  backend: 'off' | 'disk' | 'db'
  dir: string | null
  stats: EmbeddingCacheStats
}

export function embeddingCacheStats(): EmbeddingCacheStats {
  return { ...stats }
}

/** what a run should record about its cache, for a report header or a log line */
export function embeddingCacheReport(
  environment: NodeJS.ProcessEnv = process.env
): EmbeddingCacheReport {
  if (embeddingCacheDisabled(environment)) {
    return { backend: 'off', dir: null, stats: embeddingCacheStats() }
  }
  const dir = resolveEmbedCacheDir(environment)
  if (dir) return { backend: 'disk', dir, stats: embeddingCacheStats() }
  return { backend: registered ? 'db' : 'off', dir: null, stats: embeddingCacheStats() }
}

/** one line for a report: the backend and what it answered */
export function formatEmbeddingCacheReport(report: EmbeddingCacheReport): string {
  const { hits, misses, writes, evictions, corrupt, writeErrors } = report.stats
  const lookups = hits + misses
  const rate = lookups > 0 ? ` (${((hits / lookups) * 100).toFixed(1)}% hit)` : ''
  const where = report.backend === 'disk' ? `disk ${report.dir}` : report.backend
  const parts = [
    `${hits} hits, ${misses} misses${rate}`,
    `${writes} writes`,
    `${evictions} evictions`,
  ]
  if (corrupt > 0) parts.push(`${corrupt} corrupt dropped`)
  if (writeErrors > 0) parts.push(`${writeErrors} write errors`)
  return `embedding cache (${where}): ${parts.join(', ')}`
}

export function resetEmbeddingCacheForTests(): void {
  registered = null
  diskCache = null
  stats.hits = 0
  stats.misses = 0
  stats.writes = 0
  stats.evictions = 0
  stats.corrupt = 0
  stats.writeErrors = 0
}
