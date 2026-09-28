# architecture

engram is a local sqlite database plus a daemon that speaks mcp over http. everything below is what the code in `src/` does today.

## storage

one file. `sqlite` in wal mode, opened in `src/db/init.ts` with `busy_timeout = 5000` and foreign keys on. a schema baseline is created on first open, then numbered migrations from `src/db/migrations/` run in order through `src/db/migrations/runner.ts`. migrations are additive and idempotent; the runner records each applied version in `schema_migrations`, and a database migrated before that table existed is adopted rather than re-run.

tables that carry the memory itself:

- `memories` — id, session, namespace, content, type, importance, tags, timestamps, validity window, pin/archive/embed state, shareable flag, `ident_text`
- `sessions` — one row per working session, with a namespace
- `memory_links` — typed edges: `semantic`, `temporal`, `supersedes`, `reference`, `duplicate_of`, `conflicts`
- `memory_entities` — extracted identifiers per memory
- `memory_clusters` — topic groups with a one-line summary
- `project_digests` — the cached pinned-fact digest per namespace
- `namespace_nodes` — the materialized namespace tree, with per-node digests and counts
- `memory_events` — append-only mutation audit
- `retrieval_events` — the query ledger
- `maintenance_jobs` — the durable job queue
- `brain_subscriptions` / `owned_brains` — followed and published brains

search indexes:

- `memories_fts` — fts5 over `content` and `tags`, kept in sync by triggers on `memories`
- `memories_ident_fts` — identifier-aware fts over `ident_text` (`src/db/lexical-index.ts`)
- `memory_entity_fts` — fts over extracted entity text
- `memory_vectors` — a `sqlite-vec` `vec0` table of 768-float embeddings, created only when the bundled `sqlite-vec` extension loads (`src/db/init.ts`). without it the daemon still runs and search falls back to fts5.

`ident_text` exists because stock fts5 tokenization splits on whitespace and punctuation, so a query for `hybrid search` never reached a memory that says `hybridSearch`. `normalizeIdentifiers` in `src/db/lexical-index.ts` emits both the split words (`hybrid search`) and the glued compound (`hybridsearch`), and the write path computes it in js (`src/memory/store.ts`) rather than inside the trigger.

## the write path

`MemoryStore.store()` in `src/memory/store.ts` runs three stages before anything is inserted, because a gate that needs a vector has to have it first.

**admission** (`src/memory/admission.ts`) decides whether the write may become a row at all. `ENGRAM_ADMISSION` picks `off`, `warn` or `enforce` (default `enforce`). rules:

- secrets — private key blocks, aws/github/slack/openai/google key shapes, jwts, bearer tokens, an authorization header, credentials inside a connection string. always rejected in both `warn` and `enforce`, because a credential that lands in the table is already in the fts index, the vectors and every export. the rejection names the shape, never the match.
- junk — content with no alphanumeric characters, or over `ENGRAM_ADMISSION_MAX_CHARS` (default 24000). under 8 characters of text is a warning, not a refusal.
- negative-result — a claim that is only an absence ("no issues found"). a warning, and skipped when the content carries a digit or a code span.
- burst — the write would join a lexical family of at least `ENGRAM_ADMISSION_BURST_MIN` (default 5) memories in the same namespace and type that share their opening characters (`ENGRAM_PRUNE_PREFIX_CHARS`, default 48), written inside `ENGRAM_ADMISSION_BURST_WINDOW_MS` (default 7 days). rejected, with the family's keeper in the hint.

only an agent write (`origin: 'mcp'`) can be refused; a bulk import, the eval harness or a maintenance pass is never dropped silently. a rule that cannot run allows the write.

**the write gate** reconciles the write against its neighbours, using the one k-nearest probe the store already needed. `ENGRAM_WRITE_GATE` picks `off`, `link` or `merge` (default `merge`):

- an exact-content duplicate in the same namespace and type is not inserted a second time. the existing row is returned with `deduplicated: true`, and tags are unioned and importance maxed.
- a neighbour at or above `ENGRAM_WRITE_GATE_SIM` cosine (default 0.95) of the same namespace and type, neither row pinned, is reported as `possible_duplicates` and gets a `duplicate_of` link.
- pinned rows are exempt from both branches.

**enrichment** runs after insert: the row is embedded (nomic-ai/nomic-embed-text-v1.5, 768 dims, layer-normalised and L2-normalised in `src/embeddings/pipeline.ts`), entities are extracted by regex (`src/memory/entities.ts` — file paths, functions, classes, symbols, imported libraries, urls, error lines, at most 30), a semantic link is written to every neighbour closer than `LINK_DISTANCE_THRESHOLD` (0.837), and the row is queued for contradiction adjudication.

the same `store()` serves `store_memory` and the harness, so the gates cannot be bypassed by one caller.

**revisions** are append-only. `revise_memory` inserts a new row, copies the predecessor's importance, tags and entities, closes the predecessor's validity window, and writes a manual `supersedes` edge with `revision > 0` (successor → predecessor). the predecessor stays readable through `include_superseded` and `get_memory_history`.

## retrieval

`hybridSearch` in `src/memory/search/hybrid.ts`. the query becomes up to four kinds of list, each scored on its own, then fused.

- **fts** — `memories_fts` with per-token quoting. implicit and first, falling back to or when a three-or-more-term query matches nothing. bm25 is scaled per query term and squashed to `p / (p + 1)`, so relevance is absolute and corpus-independent rather than relative to the result set.
- **ident** — `memories_ident_fts`, off unless the caller passes `ident_channel` or `ENGRAM_IDENT_CHANNEL=1`.
- **entity** — `memory_entity_fts`, off unless `entity_channel` or `ENGRAM_ENTITY_CHANNEL=1`.
- **vector** — a `sqlite-vec` knn probe, l2 distance converted to cosine (`cos = 1 - d²/2`, valid because vectors are unit length).

`expand` adds deterministic query variants as extra fts lists — a split form of an identifier (`hybridSearch` → `hybrid search`), a phrase variant, and the query's rare tokens — and `expand_use_llm` adds an llm tier when `ENGRAM_LLM_BASE_URL` and `ENGRAM_LLM_API_KEY` are set. a variant is diluted by `1/n`, where `n` is the number of contributing lists, so an extra channel can never outvote the primary query. a channel that matched nothing is left out of `n`.

fusion weights come from a query archetype (`classifyQuery` in `src/memory/search/scoring.ts`): temporal, lookup, frequentist, semantic. the profiles mix the fts and vector score with three priors — recency (`ebbinghaus` decay), access (log-scaled count, saturating at 100) and importance. when no vector list contributed, the vector weight is redistributed across the others instead of being spent on zeros. `relevance` is reported separately from `score`: it is the evidence share (fts + vector) with the priors excluded, so a caller can gate on evidence rather than on a memory that merely looks recent.

optional stages:

- **reranker** — with `ENGRAM_RERANKER_ENABLED=1`, the top `rerank_top_n` (default 50) candidates are scored by `onnx-community/bge-reranker-v2-m3-ONNX` and blended with the fused score at `ENGRAM_RERANK_BLEND_ALPHA` (default 0.5). the tail keeps a neutral 0.5 so the whole list stays on one scale. if the model is unavailable the fused order is returned with `diagnostics.degraded` naming it.
- **min_score** — an absolute floor on the final score.
- **access signal** — `ENGRAM_ACCESS_SIGNAL` decides which reads count as a use: `explicit` (default, only a direct fetch stamps `last_accessed`), `retrieval` (every search stamps its results) or `off`.

every channel shares the namespace and temporal predicates in `src/memory/search/scope.ts`, so a subtree search cannot return a sibling namespace by accident.

**the funnel.** a namespace is a path, so the directory tree is the memory tree (`src/namespace/tree.ts`, `src/memory/nav.ts`). tree rows are materialised lazily — by a query read, by `get_context` when it needs counts, by the health report, and at session end (`ensureNode`, `refreshNodeCounts`), with an idempotent backfill sweep on daemon start. `get_context` with a query searches the session's own namespace first. if that leaf is rich — at least 3 hits and a top score at or above 0.35 — the ancestors are skipped. otherwise each ancestor contributes up to two short excerpts matched from its nav digest and cluster summaries. the excerpts are navigation metadata, never a memory body, and the response carries `scope_trace` showing which layer was searched, skipped or used as a guide. `scope: 'leaf'` turns the ascent off.

**recall_context** (`src/memory/recall.ts`) is the same retrieval behind a strict character budget. it packs its sections in a fixed order — digest, then memories, then topics — trims the digest to its share, serves a memory whole or trimmed once when that is the only way to use the last of the budget, drops what still does not fit, suppresses near-duplicates of a kept sibling, and reports the accounting. reads never stamp access, so repeated calls are byte-identical.

## time and supersession

`memories` carries `valid_from` and `valid_until`. two read modes:

- `as_of: t` — a full historical view: rows valid at `t`, and only supersedes links that had already been judged at `t` (`notSupersededAtClause`). a fact superseded later still appears in the snapshot.
- `before: t` — the legacy bound: `valid_from <= t` only.

a memory is treated as superseded when a `supersedes` link with confidence at or above 0.8 points at it (`src/contradictions/supersession.ts`). the threshold and the sql fragment live in one module so every read path hides superseded and archived rows the same way. `include_superseded` opts back in.

contradiction handling is two-stage (`src/contradictions/`):

1. **candidates** — for a freshly stored memory, cosine-knn and fts both propose neighbours, capped and floored, so the judge sees a short list.
2. **judge** — an llm call returns one verdict per candidate (relation, confidence, reason). thresholds are per relation, because a false positive costs more for some than others: `contradicts` 0.8, `updates` 0.9, `duplicate` 0.95, with anything under 0.4 dropped instead of recorded. each is overridable with `ENGRAM_<RELATION>_THRESHOLD`.
3. **effects** — a confident `supersedes` hides the older row from default reads; a sub-threshold contradiction writes a `conflicts` marker that hides nothing and leaves both sides readable as `disputed`.

a wrong call is reversible: `engram reverse-supersession --target <id>` removes the link and reopens the target's validity window (`src/contradictions/reversal.ts`).

## maintenance

`src/maintenance/jobs.ts` is a durable queue in `maintenance_jobs`. enqueue is idempotent over `(job_type, target_key)` while a job is active, claiming is a single update with a lease (`ENGRAM_MAINTENANCE_LEASE_MS`, default 5 minutes) so an interrupted run is reclaimable, and attempts are capped (`ENGRAM_MAINTENANCE_MAX_ATTEMPTS`, default 3) before a job lands in `dead`. the daemon ticks the queue every `ENGRAM_MAINTENANCE_INTERVAL_MS` (default 60000; 0 turns the ticker off) via `src/maintenance/scheduler.ts`, and `ENGRAM_MAINTENANCE_DISABLED=1` disables the layer.

job types: `digest`, `cluster`, `importance`, `adjudication`, `promote`, `prune`, `retention`. `end_session` enqueues digest, cluster, importance and adjudication for the session's namespaces, plus a nav digest for the namespace and its nearest existing ancestor, plus a promotion job.

what each one is allowed to write differs:

- `digest` / `cluster` / `importance` / `adjudication` inspect state and record a summary in the job row. the nav variant does write, but only `namespace_nodes.digest` — thin navigation metadata.
- `promote` (`src/maintenance/promote.ts`) distills a leaf `//scope` with at least 8 memories into one `pattern` memory in the parent namespace and links the sources. llm-only by default; `ENGRAM_PROMOTE_EXTRACTIVE=1` restores the extractive fallback for tests and ops.
- `prune` (`src/maintenance/prune.ts`) archives redundant near-identical memories. candidates are bucketed by `(namespace, type, first N characters)`; within a family one keeper survives, chosen by pinned > importance > access count > link degree > oldest, and a member whose text shares enough of the keeper's is archived. archiving sets `archived_at` and repoints the links, so it is reversible. `ENGRAM_PRUNE_THRESHOLD` (default 0.95), `ENGRAM_PRUNE_PREFIX_CHARS` (default 48), `ENGRAM_PRUNE_CLUSTER_PREFIX=1` to treat a whole bucket as one family.
- `retention` (`src/maintenance/retention.ts`) archives on interference, not age alone: a row must be redundant (duplicate-marked, or a non-keeper family member), below `ENGRAM_RETENTION_MAX_SCORE` (default 0.35), unused for at least 14 days, and the corpus must be at least `ENGRAM_RETENTION_MIN_CORPUS` (default 500) memories. a small corpus, and pinned, shareable, promoted, adjudication-winning, dedupe-keeper and hot rows, are skipped and counted. at most `ENGRAM_RETENTION_MAX_ARCHIVE` (default 200) rows go per run. `engram unarchive <id>` reverses it.

alongside the durable queue there are two in-process queues (`src/queue/background-queue.ts`) for importance scoring and adjudication, so a slow llm call never blocks a write.

derived data:

- **digest** — pinned memories roll up into a markdown digest per namespace, capped at `ENGRAM_DIGEST_BUDGET_CHARS` (default 2000) and condensed by the llm when one is configured. `get_context` returns it without a search.
- **clusters** — union-find over `semantic` links, each group summarised in one line (llm, or the first sentence extractively).
- **namespace digests** — a compact per-node summary (pinned facts, topic summaries, one-line child digests) at a 1200-character budget; `consolidateTree` refreshes children before parents.
- **importance** — an llm rubric scores each memory and records `importance_source`; `ENGRAM_IMPORTANCE_DISABLED=1` turns it off.
- **scope inference** — when a namespace has `//scope` layers, an llm can file a new memory into the best-matching one. requires `ENGRAM_LLM_*`; `ENGRAM_SCOPE_INFERENCE=0` disables it.

workers (`src/db/workers/`) backfill what an older schema left behind: `namespace` from `project_path`, the identifier/entity fts tables, and embeddings marked `stale`.

## delivery

there is one daemon. everything else either calls it or pushes text into a host.

- **mcp instructions** — `initialize` returns the standing rules from `src/delivery/protocol.ts`. clients that honour the mcp `instructions` field put them in the system prompt.
- **an instruction block** — `engram setup <agent>` writes the longer rules into the host's own instruction file between `<!-- engram:begin -->` and `<!-- engram:end -->`. planning and applying are separate: the default is a dry run, and every write is idempotent and reversible (`--uninstall` removes only the block setup added). agents come from a registry (`src/delivery/registry.ts`, currently `claude-code`, `codex`, `cursor`); any other host can use `engram setup print <agent>`. setup backs up a file before touching it and refuses to follow a symlink out of the home directory.
- **hooks** — `engram hook <event>` reads the host's json on stdin and prints what the host expects. `session-start` injects the rules plus a budgeted roster for the namespace, and fires again after compaction. `pre-tool-use` injects up to three short cues: the gotchas, bugs, decisions and patterns that mention the file about to be edited, matched on the absolute path, the path relative to the namespace and the basename. each memory is injected at most once per session (state in `src/delivery/cue-state.ts`). hooks fail open — daemon down, slower than 1.5 s, or unreadable input means no output and exit 0.
- **workspace resolution** — an http mcp server cannot see the client's directory, so `stdio-server.mjs` resolves its own cwd to a git root and forwards with `?project=`. a git worktree canonicalizes to its primary working tree, so a branch does not get an empty namespace of its own. namespaces resolve in a fixed order (`src/namespace/resolver.ts`): tool argument, url parameter, `ENGRAM_DEFAULT_NAMESPACE`, then the detected git root.
- **daemon routes** — `src/server.ts` serves `/mcp` (json-rpc), `/health`, `/metrics`, and two read-only delivery routes, `/delivery/roster` and `/delivery/cue`, which the hook cli calls. the daemon binds `127.0.0.1`; `ENGRAM_ALLOW_NONLOCAL=1` widens it, and there is no authentication.

## telemetry

`engram_events` holds per-call counters; `retrieval_events` holds the query text, the returned ids, latency, mode, namespace and the budget accounting for every search. `ENGRAM_LOG_QUERIES=0` stores the query length instead of the text. `get_stats` and `/metrics` report both. all of it stays in the local database.

## brains

a brain is an encrypted snapshot of the memories marked shareable, distributed over git. it has its own document: [brains.md](brains.md).

## where things live

```
src/db/            sqlite open, migrations, fts index helpers, backfill workers
src/memory/        store (admission, gate, links), recall, digest, nav, entities, clustering
src/memory/search/ channels, fusion, scoring, scope, graph walk
src/contradictions/candidates, judge, adjudicator, supersession, reversal
src/maintenance/   durable queue, scheduler, promote, prune, retention, consolidate
src/namespace/     tree materialization and resolution
src/delivery/      registry, setup planner, markers, hooks, cue, roster, workspace
src/brains/        identity, snapshot, publish, follow, encryption, mcp tools
src/mcp/           tool schemas, handlers, health
src/embeddings/    local model pipeline, cross-encoder reranker
src/queue/         in-process background queues
src/metrics/       event counters, retrieval ledger, tokenizer
src/session/       sessions and git-root detection
src/cli/           brain, hook, lifecycle and setup commands
```
