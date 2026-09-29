// suite contract: a suite is a pure function of (ctx, code). it creates its own
// isolated harness, seeds, measures and returns artifacts, without writing to the live
// db or mutating global state outside its harness.
import type { RetrievalConfigPatch } from '../lib/registry.js'
import type { HeaderInput } from '../lib/report.js'
import type { RunHeader, SuiteResult, VectorMode } from '../lib/types.js'

export interface SuiteContext {
  seed: number
  /** resolved configs in caller order: [name, patch] */
  configs: Array<[string, RetrievalConfigPatch]>
  vectors: VectorMode
  /** suite-specific; the retrieval suite reads it as a corpus list */
  corpora?: string[]
  limit?: number
  /** longmemeval only: run the readers + judge (needs a configured gateway). */
  qa: boolean
  /** longmemeval --qa: gateway env file override (tests point at a temp path). */
  envFile?: string
  /** longmemeval: explicit dataset file, bypassing the manifest lookup. */
  datasetPath?: string
  /** dataset manifest override: tests pin one so a check never depends on what this machine fetched */
  datasetManifestPath?: string
  /**
   * systems to compare: a builtin name, or `mcp:<adapter-config-path>` for any mcp
   * memory server. empty means every builtin, which is the longmemeval --qa default.
   */
  systems?: string[]
  /** alias of `systems`, kept for callers and flags that still say reader. */
  readers?: string[]
  /** longmemeval --qa: questions in flight (default 2). */
  concurrency?: number
  /** longmemeval --qa: append-only jsonl checkpoint path. */
  checkpointPath?: string
  /** longmemeval --qa: pinned reader model. */
  readerModel?: string
  /** longmemeval --qa: pinned judge model. */
  judgeModel?: string
  /** longmemeval --qa: operator confirmed the pre-run cost estimate. */
  yes?: boolean
  /** longmemeval --qa: estimated-call ceiling above which `yes` is required. */
  costCeilingCalls?: number
  /** longmemeval --qa: context budget (chars) for the engram / naive-rag readers. */
  contextBudgetChars?: number
  /** git sha captured at process start; recorded on every checkpoint row. */
  gitSha?: string
  /** contradiction only: recorded verdicts to sweep instead of calling the LLM. */
  verdictsPath?: string
  /** longmemeval only: dataset split name. */
  dataset?: string
  /**
   * longmemeval only: keep records whose question_type is one of these, so a run can
   * target one slice (multi-session, temporal-reasoning) of a mixed split.
   */
  questionTypes?: string[]
  outDir: string
  /** bound to the git state captured at process start */
  buildHeader: (input: HeaderInput) => RunHeader
  /**
   * true when --configs was explicit: the ab suite sweeps every registered config
   * otherwise and exactly the requested list when it was
   */
  configsExplicit?: boolean
  log: (message: string) => void
}

export interface SuiteOutput {
  result: SuiteResult
  /** the markdown body; the report writer prepends the header */
  markdown: string
  /**
   * flat metric records keyed by config name, every value a number, so a threshold
   * path (`overall.recall@10`) needs no nested traversal
   */
  thresholds: Record<string, Record<string, number>>
}
