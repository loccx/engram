// shared eval types. the metric *names* are frozen (EVAL-CONTRACT.md) and everything
// added here is additive: a corpus record may carry extra optional fields, but it has
// to keep id, content, namespace and the target ids a query should retrieve.
import type { MemoryType } from '../../src/memory/types.js'
import type { SearchOptions } from '../../src/memory/search.js'

/** one memory the harness seeds */
export interface CorpusMemory {
  /** corpus-local id; the db id is a fresh uuid, see SeedMap */
  id: string
  content: string
  /** `ns`, or a synthetic `ns//scope` */
  namespace: string
  /** stores into `<namespace>//<scope>` */
  scope?: string
  type?: MemoryType
  importance?: number
  pinned?: boolean
  tags?: string[]
  /** ms; restamped from the corpus clock after the write path runs */
  created_at: number
  valid_from?: number
  valid_until?: number | null
  /**
   * corpus-local id of the memory this one supersedes. seeding writes the
   * memory_links row in the shape `notSupersededClause` filters on.
   */
  superseded_by?: string
  /** extra query text this row should also be reachable by */
}

/** one query under test: the ids it should retrieve, and where */
export interface CorpusQuery {
  id: string
  query: string
  namespace: string
  /** recall@k ground truth */
  target_ids: string[]
  /** must not be served (superseded or stale); reported as staleRate */
  must_not_retrieve?: string[]
  /** forwarded to SearchOptions.as_of */
  as_of?: number
  include_superseded?: boolean
  limit?: number
  /** probe family, for the per-kind breakdown */
  kind?: string
  /** per-query overrides; the config patch merges on top */
  search?: Partial<SearchOptions>
}

/** a labelled pair for the contradiction suite */
export type PairRelation = 'contradicts' | 'updates' | 'duplicate' | 'unrelated'

export interface LabelledPair {
  id: string
  namespace: string
  /** corpus-local id of the new row, the adjudication subject */
  new_id: string
  /** corpus-local id of the memory the judge compares against */
  candidate_id: string
  /** ground truth for new → candidate */
  relation: PairRelation
  note?: string
}

export interface CorpusCluster {
  namespace: string
  member_ids: string[]
  summary: string
  created_at: number
}

export interface Corpus {
  name: CorpusName | string
  seed: number
  notes?: string
  memories: CorpusMemory[]
  queries: CorpusQuery[]
  pairs?: LabelledPair[]
  clusters?: CorpusCluster[]
}

export type CorpusName =
  | 'paraphrase'
  | 'cross-notation'
  | 'distractor'
  | 'temporal-update'
  | 'cross-namespace'
  | 'long-horizon'
  | 'contradiction'
  | 'budget'
  | 'mixed'

/** corpus-local id -> DB uuid, captured from the real store_memory response. */
export type SeedMap = Map<string, string>

export interface RunHeader {
  suite: string
  configs: string[]
  seed: number
  /** git sha of the worktree, '' when unavailable */
  gitSha: string
  gitShaShort: string
  gitBranch: string
  /** sha256 of the corpus payload, 16 hex chars */
  corpusHash: string
  /** full sha256 of the corpus payload */
  corpusHashFull: string
  /** true only when the stack really had vectors: sqlite-vec loaded and the run was not fts-only */
  vectorsAvailable: boolean
  vectorMode: VectorMode
  /** the dev-only tokenizer when importable, else 'chars/4' */
  tokenizer: string
  /** the scoring clock every query used */
  now: number
  nowIso: string
  /** the package version under test */
  engramVersion: string
  nodeVersion: string
  /** env-gated flags active for this run */
  featureFlags: Record<string, string>
  /** what the determinism guarantee actually covers */
  determinism: string
}

export type VectorMode = 'fts' | 'cached' | 'on'

export interface TimingSummary {
  count: number
  minMs: number
  p50Ms: number
  p90Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  meanMs: number
}

/**
 * a suite's output. `metrics` must be a pure function of (corpus, seed, config,
 * code) — the determinism test byte-compares it — while `timings` are wall-clock and
 * stay out of `metrics`.
 */
export interface SuiteResult {
  suite: string
  header: RunHeader
  metrics: Record<string, unknown>
  timings: Record<string, TimingSummary>
  /** per-query detail for the json artifact */
  details: unknown[]
  notes: string[]
}
