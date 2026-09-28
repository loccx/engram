// isolated eval harness (EVAL-CONTRACT.md): a throwaway temp dir per run, writes
// through the real tool surface so validation, scope routing, the fts triggers and
// entity extraction all run (a raw-insert path exists for large corpora), and reads
// with touch:false plus an injected clock, so a run can never strengthen what it
// measures. the background adjudicator and importance queues stay off while seeding,
// or an llm-configured environment writes supersedes links between corpus rows.
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDatabase, resetDatabase } from '../../src/db/init.js'
import { normalizeIdentifiers } from '../../src/db/lexical-index.js'
import { handleTool, resetServicesForTests } from '../../src/mcp/handlers.js'
import { resetAdjudicationQueueForTests } from '../../src/contradictions/runtime.js'
import { resetImportanceQueueForTests } from '../../src/importance/runtime.js'
import { resetLlmConfigForTests } from '../../src/llm/client.js'
import { MemoryStore } from '../../src/memory/store.js'
import { MemorySearch } from '../../src/memory/search.js'
import type { SearchOptions } from '../../src/memory/search.js'
import type { SearchResult } from '../../src/memory/types.js'
import { recallContext, type RecallOptions, type RecallResult } from '../../src/memory/recall.js'
import { modelRequiredPaths, resolveModelCacheDir } from '../../src/embeddings/pipeline.js'
import { refreshDigest } from '../../src/memory/digest.js'
import { latencyMsAsync } from './metrics.js'
import type { Corpus, CorpusMemory, SeedMap, VectorMode } from './types.js'

/** at or above this size a corpus takes the raw-insert path (fts-only mode) */
export const RAW_INSERT_THRESHOLD = 50

/** env vars the harness owns: saved at create, restored on dispose */
const OWNED_ENV = [
  'ENGRAM_DB_PATH',
  'ENGRAM_DATA_DIR',
  'ENGRAM_MODEL_CACHE_DIR',
  'ENGRAM_SCOPE_INFERENCE',
  'ENGRAM_IMPORTANCE_DISABLED',
  'ENGRAM_MAINTENANCE_DISABLED',
  'ENGRAM_DEFAULT_NAMESPACE',
  'ENGRAM_RERANKER_ENABLED',
  'ENGRAM_PROMOTE_EXTRACTIVE',
] as const

const LLM_ENV = [
  'ENGRAM_LLM_BASE_URL',
  'ENGRAM_LLM_API_KEY',
  'ENGRAM_LLM_MODEL',
  'ENGRAM_LLM_USER_EMAIL',
  'ENGRAM_LLM_COMPONENT_ID',
] as const

export interface HarnessOptions {
  seed: number
  /** 'fts' (default): no vectors, no model load, no network */
  vectors?: VectorMode
  /** the scoring clock; defaults to the corpus epoch */
  now?: number
  /** temp root; defaults to a mkdtemp under the os tmpdir */
  tmpDir?: string
  /** keep the temp dir on dispose, for debugging */
  keep?: boolean
}

export interface SeedMode {
  /** 'auto' takes the raw path only for a large fts-only corpus */
  mode?: 'auto' | 'tool' | 'raw'
}

export interface SeedStats {
  viaTool: number
  raw: number
  namespaces: string[]
  ms: number
  placementVerified: boolean
  placementMismatches: string[]
}

export interface HarnessStats {
  memories: number
  pinned: number
  clusters: number
  digests: string[]
  vectors: number
  events: number
}

/** epoch for every corpus, so runs are stable across machines */
export const CORPUS_EPOCH = 1_735_689_600_000

export class EvalHarness {
  /** the isolation overrides, as saved at create() */
  private restoreEnv: Array<[string, string | undefined]> = []
  private disposed = false
  /** corpus-local id → db uuid, accumulated across seedCorpus() calls */
  private readonly seedIds: SeedMap = new Map()
  /** db uuid → corpus-local id, so artifacts hold only stable ids */
  private readonly localIds: Map<string, string> = new Map()

  private constructor(
    readonly dir: string,
    readonly dbPath: string,
    readonly db: Database.Database,
    /** vector availability for the stack under test */
    readonly vectorsAvailable: boolean,
    readonly vectorMode: VectorMode,
    /** true when a complete model was cached before the run started */
    readonly modelCacheReady: boolean,
    readonly now: number,
    private readonly keepDir: boolean
  ) {}

  static async create(options: HarnessOptions): Promise<EvalHarness> {
    const seed = options.seed
    const mode: VectorMode = options.vectors ?? 'fts'
    const dir = options.tmpDir ?? mkdtempSync(join(tmpdir(), `engram-eval-${seed}-`))
    mkdirSync(dir, { recursive: true })

    const restore: Array<[string, string | undefined]> = []
    const setEnv = (key: string, value: string | undefined): void => {
      restore.push([key, process.env[key]])
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }

    const { modelCacheDir, vectorsAvailable, modelCacheReady } = resolveVectorSetup(dir, mode)

    for (const key of OWNED_ENV) setEnv(key, undefined)
    setEnv('ENGRAM_DB_PATH', join(dir, 'engram.db'))
    setEnv('ENGRAM_DATA_DIR', dir)
    setEnv('ENGRAM_MODEL_CACHE_DIR', modelCacheDir)
    // deterministic seeding: no llm scope inference, no background importance
    // scoring, no maintenance jobs racing the run.
    setEnv('ENGRAM_SCOPE_INFERENCE', '0')
    setEnv('ENGRAM_IMPORTANCE_DISABLED', '1')
    setEnv('ENGRAM_MAINTENANCE_DISABLED', '1')
    setEnv('ENGRAM_RERANKER_ENABLED', '0')
    if (!process.env.LOG_LEVEL) setEnv('LOG_LEVEL', 'error')

    resetDatabase()
    resetServicesForTests()
    resetAdjudicationQueueForTests()
    resetImportanceQueueForTests()
    resetLlmConfigForTests()

    const dbm = getDatabase(join(dir, 'engram.db'))
    const now = options.now ?? CORPUS_EPOCH

    const harness = new EvalHarness(
      dir,
      dbm.dbPath,
      dbm.db,
      mode === 'fts' ? false : vectorsAvailable,
      mode,
      modelCacheReady,
      now,
      options.keep === true
    )
    // the overrides stay applied for the harness lifetime and are
    // restored on dispose, so a caller can make one harness after another.
    harness.restoreEnv = restore
    return harness
  }

  /** the seeded db id, undefined when it was never seeded */
  seedIdOf(corpusLocalId: string): string | undefined {
    return this.seedIds.get(corpusLocalId)
  }

  /**
   * corpus-local id for a db row, or the row's own id when unseeded: store_memory
   * mints a fresh uuid per run, and an artifact full of uuids cannot be compared
   * across runs
   */
  localIdOf(dbId: string): string {
    return this.localIds.get(dbId) ?? dbId
  }

  /** the retrieval implementation under test */
  get search(): MemorySearch {
    return new MemorySearch(this.db, this.vectorsAvailable)
  }

  get store(): MemoryStore {
    return new MemoryStore(this.db, this.vectorsAvailable)
  }

  /**
   * seed a corpus: the tool path for a small one, raw inserts for a large fts-only
   * one. both end with the same clock and supersession links, so a suite scores the
   * same either way.
   */
  async seedCorpus(corpus: Corpus, options: SeedMode = {}): Promise<SeedStats> {
    const start = performance.now()
    const requested = options.mode ?? 'auto'
    const useRaw =
      requested === 'raw' ||
      (requested === 'auto' && corpus.memories.length >= RAW_INSERT_THRESHOLD && !this.vectorsAvailable)
    const seedMap: SeedMap = new Map()

    if (useRaw) {
      this.insertRawMemories(corpus.memories, seedMap)
    } else {
      await this.seedViaTool(corpus.memories, seedMap)
    }

    this.normalizeCorpusClock(corpus.memories, seedMap)
    this.writeSupersedesLinks(corpus.memories, seedMap)
    if (corpus.clusters && corpus.clusters.length > 0) {
      this.insertClusters(corpus, seedMap)
    }
    const mismatches = this.verifyPlacement(corpus.memories, seedMap)
    await this.refreshDigestsFor(corpus)
    for (const [localId, dbId] of seedMap) {
      this.seedIds.set(localId, dbId)
      this.localIds.set(dbId, localId)
    }

    return {
      viaTool: useRaw ? 0 : seedMap.size,
      raw: useRaw ? seedMap.size : 0,
      namespaces: [...new Set(corpus.memories.map((m) => intendedNamespace(m)))].sort(),
      ms: Math.round(performance.now() - start),
      placementVerified: mismatches.length === 0,
      placementMismatches: mismatches,
    }
  }

  /** the real write path, with the llm env hidden so no queue runs */
  private async seedViaTool(memories: CorpusMemory[], seedMap: SeedMap): Promise<void> {
    const savedLlm = LLM_ENV.map((key) => [key, process.env[key]] as const)
    for (const key of LLM_ENV) delete process.env[key]
    resetLlmConfigForTests()
    resetServicesForTests()
    resetAdjudicationQueueForTests()
    resetImportanceQueueForTests()

    try {
      for (const memory of memories) {
        const result = await handleTool('store_memory', {
          content: memory.content,
          project_path: memory.namespace,
          ...(memory.scope ? { scope: memory.scope } : {}),
          type: memory.type ?? 'note',
          importance: memory.importance ?? 0.5,
          tags: memory.tags ?? [],
          pinned: memory.pinned === true,
        })
        const payload = parseToolResult<{ error?: string; id?: string }>(result)
        if (payload.error || !payload.id) {
          throw new Error(`seed via store_memory failed for ${memory.id}: ${payload.error ?? 'no id'}`)
        }
        seedMap.set(memory.id, payload.id)
      }
    } finally {
      for (const [key, value] of savedLlm) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetLlmConfigForTests()
      resetServicesForTests()
      resetAdjudicationQueueForTests()
      resetImportanceQueueForTests()
    }
  }

  /**
   * bulk path: the same columns the store writes. ident_text is set explicitly because
   * since migration 015 the trigger only copies that column, so omitting it costs no
   * error — just a row missing from the identifier channel.
   */
  private insertRawMemories(memories: CorpusMemory[], seedMap: SeedMap): void {
    const insertSession = this.db.prepare(
      'INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)'
    )
    const insertMemory = this.db.prepare(
      `INSERT INTO memories
         (id, session_id, project_path, namespace, content, type, importance, tags,
          created_at, valid_from, valid_until, pinned, importance_source, origin, ident_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', 'eval-corpus', ?)`
    )
    const tx = this.db.transaction((rows: CorpusMemory[]) => {
      for (const memory of rows) {
        const id = deterministicUuid(this.now, memory.id)
        const namespace = intendedNamespace(memory)
        const sessionId = `eval-session-${slug(namespace)}`
        const tags = JSON.stringify(memory.tags ?? [])
        insertSession.run(sessionId, namespace, memory.created_at)
        insertMemory.run(
          id,
          sessionId,
          namespace,
          namespace,
          memory.content,
          memory.type ?? 'note',
          memory.importance ?? 0.5,
          tags,
          memory.created_at,
          memory.valid_from ?? memory.created_at,
          memory.valid_until ?? null,
          memory.pinned === true ? 1 : 0,
          normalizeIdentifiers(`${memory.content} ${tags}`)
        )
        seedMap.set(memory.id, id)
      }
    })
    tx(memories)
  }

  /**
   * the corpus clock wins: wall-clock created_at/valid_from would make the recency
   * signal, and the ranking with it, depend on the machine and the run
   */
  private normalizeCorpusClock(memories: CorpusMemory[], seedMap: SeedMap): void {
    const stmt = this.db.prepare(
      'UPDATE memories SET created_at = ?, valid_from = ?, valid_until = ? WHERE id = ?'
    )
    const tx = this.db.transaction((rows: CorpusMemory[]) => {
      for (const memory of rows) {
        const id = seedMap.get(memory.id)
        if (!id) continue
        stmt.run(
          memory.created_at,
          memory.valid_from ?? memory.created_at,
          memory.valid_until ?? null,
          id
        )
      }
    })
    tx(memories)
  }

  /**
   * corpus-declared supersessions, written as the adjudicator writes them (supersedes,
   * confidence 1.0, judged_at set) so the supersession clauses see them
   */
  private writeSupersedesLinks(memories: CorpusMemory[], seedMap: SeedMap): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO memory_links
         (source_id, target_id, similarity, link_type, created_at, confidence, reason,
          decider_model, prompt_version, judged_at)
       VALUES (?, ?, ?, 'supersedes', ?, ?, ?, 'eval-corpus', 'corpus-v1', ?)`
    )
    const byId = new Map(memories.map((m) => [m.id, m]))
    const tx = this.db.transaction(() => {
      for (const memory of memories) {
        if (!memory.superseded_by) continue
        const newer = byId.get(memory.superseded_by)
        const newId = seedMap.get(memory.superseded_by)
        const oldId = seedMap.get(memory.id)
        if (!newId || !oldId) continue
        const at = newer?.created_at ?? memory.created_at
        stmt.run(newId, oldId, 1.0, at, 1.0, 'corpus label: revised fact', at)
      }
    })
    tx()
  }

  private insertClusters(corpus: Corpus, seedMap: SeedMap): void {
    const stmt = this.db.prepare(
      `INSERT INTO memory_clusters
         (project_path, member_ids, summary, is_extractive, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`
    )
    const tx = this.db.transaction(() => {
      for (const cluster of corpus.clusters ?? []) {
        // cluster membership is declared with corpus-local ids and resolved to the seeded ones
        

        const memberIds = cluster.member_ids
          .map((id) => seedMap.get(id))
          .filter((id): id is string => typeof id === 'string')
        stmt.run(
          cluster.namespace,
          JSON.stringify(memberIds),
          cluster.summary,
          cluster.created_at,
          cluster.created_at
        )
      }
    })
    tx()
  }

  /** a scope mention rerouting a row must fail loudly */
  private verifyPlacement(memories: CorpusMemory[], seedMap: SeedMap): string[] {
    const mismatches: string[] = []
    const stmt = this.db.prepare(
      'SELECT COALESCE(namespace, project_path) AS ns FROM memories WHERE id = ?'
    )
    for (const memory of memories) {
      const id = seedMap.get(memory.id)
      if (!id) {
        mismatches.push(`${memory.id}: not seeded`)
        continue
      }
      const row = stmt.get(id) as { ns: string } | undefined
      const expected = intendedNamespace(memory)
      if (!row || row.ns !== expected) {
        mismatches.push(`${memory.id}: expected ${expected}, got ${row?.ns ?? '<missing>'}`)
      }
    }
    return mismatches
  }

  /** pinned facts feed the digest section the budget suite checks */
  private async refreshDigestsFor(corpus: Corpus): Promise<void> {
    const namespaces = [
      ...new Set(corpus.memories.filter((m) => m.pinned === true).map(intendedNamespace)),
    ].sort()
    for (const namespace of namespaces) {
      try {
        await refreshDigest(this.db, namespace)
      } catch {
        // refreshDigest already degrades internally; a throw here must not
        // abort a measurement run.
      }
    }
  }

  /**
   * `touch: false` and a fixed `now` are not caller choices: a run that strengthened
   * its own memories would not be reproducible
   */
  async runSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const merged: SearchOptions = {
      limit: 10,
      touch: false,
      now: this.now,
      ...options,
    }
    return this.search.hybridSearch(query, merged)
  }

  /** timed variant: latency belongs in `timings`, never in `metrics` */
  async timedSearch(
    query: string,
    options: SearchOptions = {}
  ): Promise<{ results: SearchResult[]; ms: number }> {
    const { ms, value } = await latencyMsAsync(() => this.runSearch(query, options))
    return { results: value, ms }
  }

  /** the recall_context backend, with an injected clock */
  async runRecall(
    options: Omit<RecallOptions, 'now'> & { now?: number }
  ): Promise<RecallResult> {
    return recallContext(this.db, this.store, this.search, {
      limit: 10,
      mode: 'fused',
      ...options,
      now: options.now ?? this.now,
    })
  }

  /**
   * drop every row in a question's namespace, so the streamed longmemeval run holds
   * one haystack at a time and each question starts from the same state. the fts table
   * is handled by its delete trigger and links cascade; the session row goes by hand.
   */
  dropNamespace(namespace: string): void {
    this.db.prepare('DELETE FROM memories WHERE COALESCE(namespace, project_path) = ?').run(namespace)
    this.db.prepare('DELETE FROM sessions WHERE project_path = ?').run(namespace)
  }

  /** the mcp read surface, smoke checks only (it uses Date.now) */
  async toolCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return parseToolResult<Record<string, unknown>>(await handleTool(name, args))
  }

  stats(): HarnessStats {
    const one = <T>(sql: string): T => this.db.prepare(sql).get() as T
    return {
      memories: one<{ n: number }>('SELECT COUNT(*) AS n FROM memories').n,
      pinned: one<{ n: number }>('SELECT COUNT(*) AS n FROM memories WHERE pinned = 1').n,
      clusters: one<{ n: number }>('SELECT COUNT(*) AS n FROM memory_clusters').n,
      digests: (
        this.db.prepare('SELECT namespace FROM project_digests ORDER BY namespace').all() as Array<{
          namespace: string
        }>
      ).map((r) => r.namespace),
      vectors: one<{ n: number }>('SELECT COUNT(*) AS n FROM memories WHERE vec_rowid IS NOT NULL').n,
      events: one<{ n: number }>('SELECT COUNT(*) AS n FROM engram_events').n,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.db.close()
    } catch {
      // already closed
    }
    resetDatabase()
    resetServicesForTests()
    resetAdjudicationQueueForTests()
    resetImportanceQueueForTests()
    resetLlmConfigForTests()
    for (const [key, value] of this.restoreEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (!this.keepDir) {
      try {
        rmSync(this.dir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  }
}

/** where a corpus record lands: `ns` or `ns//scope` */
export function intendedNamespace(memory: CorpusMemory): string {
  return memory.scope ? `${memory.namespace}//${memory.scope}` : memory.namespace
}

/**
 * `fts` needs a model cache dir that is provably unusable: getPipeline() runs
 * mkdirSync first and bails to the fts5 fallback before any network call, whereas a
 * writable-but-empty dir would try a download
 */
export function resolveVectorSetup(
  dir: string,
  mode: VectorMode
): { modelCacheDir: string; vectorsAvailable: boolean; modelCacheReady: boolean } {
  const defaultCacheDir = resolveModelCacheDir({} as NodeJS.ProcessEnv)
  const defaultReady = requiredModelFilesPresent(defaultCacheDir)

  if (mode === 'on') {
    return { modelCacheDir: defaultCacheDir, vectorsAvailable: true, modelCacheReady: defaultReady }
  }
  if (mode === 'cached' && defaultReady) {
    return { modelCacheDir: defaultCacheDir, vectorsAvailable: true, modelCacheReady: true }
  }
  // a regular file where a directory must go → ENOTDIR → no download attempt
  const blocker = join(dir, '.no-model')
  try {
    writeFileSync(blocker, 'not a directory\n')
  } catch {
    // if even that fails, the unusable path below still fails its mkdir
  }
  return { modelCacheDir: join(blocker, 'models'), vectorsAvailable: false, modelCacheReady: defaultReady }
}

function requiredModelFilesPresent(cacheDir: string): boolean {
  try {
    return modelRequiredPaths(cacheDir).every((path) => {
      const stats = statSync(path)
      return stats.isFile() && stats.size > 0
    })
  } catch {
    return false
  }
}

/** why a vector mode degraded, for the report header */
export function vectorModeNote(mode: VectorMode, effective: boolean, modelCacheReady: boolean): string {
  if (mode === 'fts') return 'FTS-only (forced): sqlite-vec and the local model are bypassed'
  if (effective) {
    return modelCacheReady
      ? 'vectors enabled: local model was already cached (no download)'
      : 'vectors requested; the model is incomplete, so embeddings degrade to FTS-only'
  }
  return 'vectors requested but no cached model found -> FTS-only (no download attempted)'
}

export function parseToolResult<T>(result: {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}): T {
  const text = result.content[0]?.text ?? '{}'
  return JSON.parse(text) as T
}

/** seeded uuid, so a raw-insert run is byte-reproducible anywhere */
function deterministicUuid(seed: number, corpusId: string): string {
  const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0').slice(-width)
  let h1 = 0x811c9dc5
  const input = `${seed}:${corpusId}`
  for (let i = 0; i < input.length; i++) {
    h1 = (h1 ^ input.charCodeAt(i)) * 0x01000193
    h1 >>>= 0
  }
  let h2 = 0x9e3779b9
  for (let i = input.length - 1; i >= 0; i--) {
    h2 = (h2 ^ input.charCodeAt(i)) * 0x85ebca6b
    h2 >>>= 0
  }
  const a = hex(h1, 8)
  const b = hex(h2, 8)
  return `${a}-${b.slice(0, 4)}-4${b.slice(4, 7)}-8${a.slice(0, 3)}-${a}${b.slice(0, 4)}`
}

function slug(text: string): string {
  return text.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root'
}
