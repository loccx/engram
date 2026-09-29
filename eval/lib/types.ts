// shared eval types. the metric *names* are frozen (EVAL-CONTRACT.md) and everything
// added here is additive: a corpus record may carry extra optional fields, but it has
// to keep id, content, namespace and the target ids a query should retrieve.
import type { MemoryType } from '../../src/memory/types.js'
import type { SearchOptions } from '../../src/memory/search.js'

/** one corpus turn: a message of a session, without any label a retriever must not see */
export interface CorpusTurn {
  role: string
  text: string
}

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
  /**
   * state slot this row is a value of. seeded through store_memory, so the write
   * path retires the previous value the way any caller's write would.
   */
  state_key?: string
  /** per-turn structure of a session row, for systems that retrieve below a session */
  turns?: CorpusTurn[]
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
  /**
   * the evidence a knowledge-update question has to end on: the newest session
   * among the targets. scored as latestTargetRank by scoreQueries.
   */
  latest_target?: string
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

/** one system's retrieval for one question, in the corpus-local id space */
export interface SystemQueryScore {
  system: string
  query_id: string
  kind: string
  targets: string[]
  /** ranked refs as served; `ref` is '' when the system cannot name the session */
  served: Array<{ rank: number; ref: string; turn?: number }>
  /** distinct sessions the served items name */
  sessions_represented: number
  /** a served snippet landed on an evidence turn; null for a session-granularity system */
  evidence_turn_hit: boolean | null
  /** share of targets present anywhere in the served context, no k-cut */
  coverage: number
  /** recall over the served list cut at k; a system serving more than k is ranked on it */
  recall: Record<string, number>
  mrr: number
  contextChars: number
  contextTokens: number
  /** wall-clock; copied into `timings`, never into an aggregate */
  retrievalMs: number
}

/** what a system served and what it cost, over all questions or one question_type */
export interface SystemTypeAggregate {
  /** questions with a resolvable target, the ones in the recall numbers */
  scored: number
  coverage: number
  recall: Record<string, number>
  mrr: number
  avg_served: number
  /** mean distinct sessions the served items name, over the scored questions */
  sessions_per_q: number
  /** mean share of questions whose served snippets reached an evidence turn; null when
   * no scored question could be attributed to a turn (a session-granularity system)
   */
  evidence_turn_coverage: number | null
  /** scored questions the evidence-turn number is computed over */
  evidence_turn_scored: number
  avg_context_tokens: number
}

/**
 * the per-system block of a suite report: recall over the served context and what that
 * context cost, so two systems can be read side by side under the same budget and top-k
 */
/** what a system's write path left in the shared db, and how much of it carries a vector */
export interface StoredVectors {
  memories: { rows: number; vectors: number }
  episodes: { rows: number; vectors: number }
}

export interface SystemAggregate extends SystemTypeAggregate {
  describe: string
  adapter_kind: string
  adapter_config_hash: string
  /** questions the system was asked */
  questions: number
  /** the same numbers per question_type, so a multi-session gain is not averaged away */
  by_question_type: Record<string, SystemTypeAggregate>
  write_calls: number
  write_tokens: number | null
  /** stored rows and how many carry a vector, captured after the system's last ingest */
  stored_vectors: StoredVectors | null
  /** true when the system has no vector channel at all, so 0 stored vectors is by design */
  lexical_only: boolean
}

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
