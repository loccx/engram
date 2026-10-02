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
- `eviction_events` — the eviction ledger: one row per retention/prune decision (kept or archived, with the reason and tier) and one per cold-tier fault. `kept` counts decisions, not memories: retention writes one per row it scanned, prune one per keeper that retired a family member
- `maintenance_jobs` — the durable job queue
- `tasks` — working state: goal, plan, progress, artifacts, open questions, status
- `task_events` — append-only log of every task update, checkpoint, handoff and close
- `episodes` — raw evidence: one row per turn or chunk, keyed on `(source, external_id)`, with session, occurrence and ingest clocks, content type, uri, chunk position, provenance and visibility/retention. immutable, and never written by `store_memory`
- `memory_episodes` — the link from a derived memory to the episode it cites, with the character span inside it
- `brain_subscriptions` / `owned_brains` — followed and published brains

search indexes:

- `memories_fts` — fts5 over `content` and `tags`, kept in sync by triggers on `memories`
- `memories_ident_fts` — identifier-aware fts over `ident_text` (`src/db/lexical-index.ts`)
- `memory_entity_fts` — fts over extracted entity text
- `memory_vectors` — a `sqlite-vec` `vec0` table of 768-float embeddings, created only when the bundled `sqlite-vec` extension loads (`src/db/init.ts`). without it the daemon still runs and search falls back to fts5.
- `episodes_fts` — fts5 over episode content, kept in sync by triggers on `episodes`
- `episode_vectors` — the same `vec0` shape for episodes, so the evidence layer can be read by vector too. ingest writes a vector only when the extension is loaded; until then a row is `embed_state = 'stale'` and the lexical channel still finds it.

`ident_text` exists because stock fts5 tokenization splits on whitespace and punctuation, so a query for `hybrid search` never reached a memory that says `hybridSearch`. `normalizeIdentifiers` in `src/db/lexical-index.ts` emits both the split words (`hybrid search`) and the glued compound (`hybridsearch`), and the write path computes it in js (`src/memory/store.ts`) rather than inside the trigger.

## the embedding cache

every vector engram computes — a memory on the write path, an episode at ingest, a query, a re-embed, the eval harness — comes from `getEmbedding` in `src/embeddings/pipeline.ts`, and that call consults a content-addressed cache first (`src/embeddings/cache.ts`). the key is a sha256 over the key version, the model id, the dtype (`q8`), the dimension, the mode (`document` or `query`) and the exact string the model sees: the nomic task prefix applied and the text cut at 8192 characters. two texts that differ only past the cut share one entry, and a model, dtype or dimension change walks away from every old key. the value is the raw little-endian float32 vector, the bytes the `vec0` tables carry, so a hit is byte-identical to the call that wrote it. a failed embed is never written: only a returned vector lands in the cache.

two backends, one interface. the db backend is the default: the `embedding_cache` table (migration 022) holds one row per key, so the same content written under two namespaces, re-ingested after a restart, or seen once as a document and once as a query costs one model call. rows are capped (`ENGRAM_EMBED_CACHE_MAX_ROWS`, default 20000) and evicted least-recently-used first, and a hit restamps its lru clock at most once a minute so the common hit stays a read; `ENGRAM_EMBED_CACHE=off` disables the layer. the disk backend is for a caller that starts a fresh process against a fresh database: `ENGRAM_EMBED_CACHE_DIR` points the same key space at files (`<2 hex>/<key>.vec`, written through a temp name and a rename), which is what `--vectors cached` and `--vectors on` in the eval harness do at `eval/.embed-cache`, so a repeat run of the same corpus skips the model entirely.

the batch path (`getEmbeddings`) is deliberately uncached: a row padded to the longest in its chunk is not the single-call vector, and handing one to a later single call would be wrong.

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

## episodes (the evidence layer)

`episodes` is the raw tier: one row per turn or chunk, beside the curated memories rather than inside them. a long session is thousands of turns, and serving that granularity is what moved longmemeval_s — +11.0 points for turn-granularity retrieval over whole sessions ([eval/README.md](eval/README.md)) — but the same turns stored as memory rows multiply the table that carries digests, clusters, adjudication and bm25 statistics. so the evidence has its own table, its own index and its own channel, and `memories` keeps its size.

### ingest

`ingestEpisodes(db, batch)` in `src/memory/episodes.ts` writes one batch; with vectors available it embeds each item with its own call before the write transaction opens, and `defer_vectors` moves that off the write path entirely:

- **idempotency** is `(source, external_id)`, unique in the table. re-sending a session, or only the turns since the last send, is a no-op: the answer reports `ingested` / `duplicate` / `rejected` per item, in request order, with the episode id for a deduplicated item resolved to the row that already exists. the key belongs to the source system, so the engine never invents one.
- **admission runs here too** (`admit()` before the insert, same as `store()`): a credential is refused on this path in every mode, so a transcript cannot walk past the boundary `store_memory` enforces. the refusal names the shape, never the value. a warn-mode rule (thin content, an absence claim) is refused only for an agent write, since only an agent can act on the hint.
- **the envelope** (`src/mcp/tools.ts`, `IngestEpisodesSchema`) follows the harness-integration contract: `source` (system, instance, version), a namespace, `permissions` (visibility, retention, `ttl_ms`), and per item `external_id`, `content`, `session_id`, `task_id`, `author`, `role`, `occurred_at`, `content_type`, `uri`, `turn_index`, `parent_external_id`, `provenance` and `chunk` (index, of, parent). a chunk links back to the whole it was cut from, so the summary ↔ chunk ↔ memory chain stays traceable. `retention` with a `ttl_ms` becomes an absolute `expires_at`, and a read hides expired rows unless it asks for them.
- **no derived rows are written.** the tier is lossless by design: an extractor that later distils an episode into a memory calls `linkMemoryEpisode` and the memory cites its evidence (`memory_episodes`, with the span inside the episode). reads back that way: `episodesForMemory`, and `get_memory` / `get_memory_history` return the cited episodes (id, source, external_id, occurred_at, uri, span) as `episodes` on the memory. the product wires it on the paths that distill: `task_close` cites every episode ingested under the closed task id, `promote` gives the pattern the union of its sources' citations, and the `prune` keeper inherits the citations of the duplicate it absorbs.
- a batch is one transaction, and every embedding of that batch is computed before it opens (a model call inside a write transaction blocks every other writer). one call per item by default, so the stored vector is the single-call vector; `batch_embeddings: true` uses one forward pass per length-sorted chunk of `EMBED_BATCH_MAX` items instead, which is faster but pads short rows and moves their numbers (min cosine 0.97).
- `defer_vectors: true` writes the rows and their fts index and returns: `embed_state` stays `stale`, the daemon's `reembed_episodes` maintenance job embeds the backlog in bounded pages of single calls, and a read before then ranks those rows lexically and names the evidence channel in `assemble_context`'s `degraded` list. a row left without a vector (no `sqlite-vec`, a deferred batch, an embedder that failed) is still findable lexically.

connectors are out of scope: the api and the tool are the boundary a connector builds on. nothing here reads a filesystem, a transcript file or a network call.

### the channel and the assembly

`searchEpisodes` (`src/memory/search/episodes.ts`) is one channel: bm25 over `episodes_fts` at the same content weight the memory channel gives its content column, plus a `vec0` knn over `episode_vectors` when a model is available, scoped to a namespace or its subtree and filtered by expiry. the fusion is the memory channel's — the same `classifyQuery` archetype picks the same weights, the vector weight is handed to the other signals when no vector list contributed, and ties break on candidate order, never on an id. an episode has no importance and no access count, so those two priors hold the memory defaults: they shift every candidate by the same amount and cannot reorder it.

`retrieveEpisodeContext` (`src/memory/episode-context.ts`) turns ranked episodes into the context the granularity experiment served:

1. rank up to 100 candidate episodes for the query
2. load the turns of the sessions those hits belong to
3. each hit expands to the turns its own window holds plus one neighbour on each side
4. hits group by session, and each group is headed by its date
5. an allocation policy decides which of those turns the budget buys (see [allocation](#allocation-of-the-evidence-budget)); the shipped order spends it on the best-ranked sessions first
6. the groups are then presented oldest first, because the reader reasons about a timeline
7. every served line keeps its provenance: episode id, session, turn position and date

`assemble()`'s `evidence` section is this function: the section's room is the budget, one item per dated session group, and `evidence` on the item lists the episode ids the group was built from. a `qa` read therefore serves ranked memories and dated raw turns side by side. an `as_of` read skips the section (an episode is evidence of what was said, not of what was true at an instant), and a namespace with no episodes has an empty one.

measured against the eval system it came from (`engram-turns`, one memory per turn), on 100 questions of `longmemeval_s_cleaned`: coverage 0.851 against 0.844, evidence-turn coverage 0.938 on both, 5.13 against 5.07 sessions per question, and 49,059 episode rows written where the memory path writes 49,061 turns — the curated table gains nothing. the served lists overlap 85% by session (88% by served turn) rather than matching exactly, because the memory channel ranks against an fts index that also holds the whole-session rows and the turn memories' tags; with both indexes holding only the turns, the two serve byte-identical context.

the deferred embedding backlog is drained by `reembed_episodes` maintenance jobs. episodes have no `as_of` or supersession semantics — those belong to the curated tier the evidence is distilled into.

### retention and deletion

expiry is a property of the row, not of the read. `retention: ephemeral` with `ttl_ms` stores an absolute `expires_at`, and `retention: session` means the evidence lives until the session that produced it ends — the sweep removes such a row once its `session_id` names a session this store has closed, so an episode whose session was never seen here is kept until a ttl or a caller removes it.

reclaiming is the `episodes_expired` maintenance job (`src/maintenance/episode-retention.ts`), enqueued once per boot and after a session that ended holding session-retention evidence. one pass removes at most `EPISODE_SWEEP_LIMIT` (5000) rows and queues the next page when it fills, so a backlog drains over ticks instead of in one long transaction.

`delete_episodes` is the item-level form of the same path: a namespace (with `subtree`), narrowed by `source`, `external_ids` or `before` (`occurred_at` strictly before a unix ms; a row with no `occurred_at` is never matched by it). `dry_run` reports what would go. both the sweep and the tool go through `deleteEpisodes(db, scope, selector)`, which removes the rows, their `episode_vectors`, their `episodes_fts` index rows and their `memory_episodes` citations in one transaction, and answers with the count per table. a call that would match the whole store is refused: the namespace is required, and a root subtree with nothing else narrowing it is rejected.

### allocation of the evidence budget

which turns the budget buys is a policy, not a loop. `src/memory/allocation.ts` holds the registry (`ALLOCATION_POLICIES`), and one packer charges every turn as it goes, so every policy shares the accounting and the same budget check: a turn that does not fit is skipped, and a shorter one behind it can still pay. the policy is the order the reached turns are bought in:

| policy | order |
| --- | --- |
| `rank-greedy` (shipped) | one session at a time, best hit rank first, turns inside it in order: the budget deepens the best hits before it reaches the rest |
| `breadth-first` | the densest turn of every reached session, then each session one turn deeper, round by round. density is the rank's evidence share (`1/(1+rank)`) over the turn's length, so a short turn outranks a long one at equal rank, and no session is dropped for being ranked behind a long reply |
| `statements-first` | the reached statement turns (`role = 'user'`) before any reply, best rank first: a count or a sum is assembled from what was stated, while replies are the long turns that fill a budget |

`reserveTopHits` is an option on any policy: windows of the top-ranked hits are bought before the rest, so the question's own best evidence cannot be crowded out by a cheap turn from a session that only mentions the item.

a recipe can pick the policy per query archetype, so one class of question gets a different allocation while every other class keeps the bytes it had. the shipped `qa` recipe does not: it currently serves every query `rank-greedy`; the later vector comparison used to justify dropping routing has no complete retained matching artifact and needs a reproducible rerun. routing stays a producer capability a recipe can ask for, and the `engram-episodes-*` eval systems exercise it. the `default` recipe has no evidence section, so recall_context is untouched by any of this.

measured through the eval systems (`engram-episodes*` in `eval/lib/systems.ts`), `longmemeval_s_cleaned` 500 questions, retrieval only, fts, 32k-char budget. each cell is answer-session coverage with answer-turn coverage in parenthesis:

| question_type | n | rank-greedy | breadth-first | breadth-first + reserve | statements-first (routed) | breadth-first (routed) |
| --- | --- | --- | --- | --- | --- | --- |
| multi-session | 133 | 0.770 (0.960) | 0.987 (0.928) | 0.987 (0.944) | 0.931 (0.976) | 0.936 (0.944) |
| single-session-user | 70 | 0.971 (0.984) | 1.000 (0.953) | 1.000 (0.984) | 0.986 (0.984) | 0.986 (0.984) |
| single-session-assistant | 56 | 1.000 (1.000) | 1.000 (0.250) | 1.000 (0.875) | 1.000 (1.000) | 1.000 (1.000) |
| single-session-preference | 30 | 0.700 (0.633) | 1.000 (0.800) | 1.000 (0.800) | 0.700 (0.633) | 0.700 (0.633) |
| knowledge-update | 78 | 0.942 (0.972) | 0.981 (0.944) | 0.981 (0.972) | 0.955 (0.972) | 0.955 (0.972) |
| temporal-reasoning | 133 | 0.817 (0.902) | 0.989 (0.894) | 0.989 (0.924) | 0.842 (0.902) | 0.842 (0.894) |
| all | 500 | 0.859 (0.933) | 0.991 (0.837) | 0.991 (0.931) | 0.913 (0.937) | 0.914 (0.927) |

sessions per question on multi-session: 5.4 under rank-greedy, 34.6 under both spreading orders, 24.9 under statements-first and 27.2 under routed breadth-first.

the two unconditional orders buy a turn from every session they reached, which is why they lift coverage in every class and why they break `single-session-assistant`: that class's answer is the long reply, density (evidence per character) defers it behind every short turn, and answer-turn coverage falls to 0.250. the reserve buys the top hit's own window back before the rest (0.875), and routing the policy through the aggregation archetype takes the class out of its reach entirely (1.000).

with the reader and the judge on the same question class (multi-session, the first 40 questions in file order, fts, paired over the same question ids, exact mcnemar plus a 10,000-resample bootstrap at seed 1234): accuracy 0.200 under rank-greedy, 0.425 under breadth-first, 0.425 under breadth-first with the reserve, 0.475 under statements-first. each spreading order beats the shipped one (+0.225 to +0.275, 11 questions won and 0 to 2 lost, p 0.023 against breadth-first and 0.001 against statements-first, the latter surviving the family correction at 0.006); statements-first does not beat the role-agnostic order beyond noise (+0.050, 7 won and 5 lost, p 0.774), and the reserve is exactly neutral in accuracy (3 won and 3 lost, p 1).

locomo and memoryagentbench cannot discriminate the orders at this budget: the candidate pool (100 turns, 10 facts) is smaller than 32k characters, so every policy serves the same set and the spread is reader noise (locomo 0.575-0.593 mean f1 over 491 questions, memoryagentbench substring accuracy 0.618-0.629 over 800). measured with locomo's budget tightened to 8k characters, where the allocation does bind, the role-agnostic order holds rank-greedy's f1 (-0.003, paired ci -0.027 to +0.020 over 491 questions) and routed statements-first holds it too (-0.016, ci -0.038 to +0.005).

those cells are the lexical regime. later notes reported 500-question vector comparisons for episodes and routed allocation, but a complete matching report/checkpoint is not retained with this checkout; those accuracy claims are not reproducible evidence. the qa recipe currently uses rank order, and that policy needs a fresh matched vector run before it is called a measured improvement. an agentic regime is also unmeasured here: conversational evidence coverage does not establish useful or harmless injection during execution.

## retrieval

`hybridSearch` in `src/memory/search/hybrid.ts`. the query becomes up to four kinds of list, each scored on its own, then fused.

- **fts** — `memories_fts` with per-token quoting. implicit and first, falling back to or when a three-or-more-term query matches nothing. bm25 is scaled per query term and squashed to `p / (p + 1)`, so relevance is absolute and corpus-independent rather than relative to the result set.
- **ident** — `memories_ident_fts`, off unless the caller passes `ident_channel` or `ENGRAM_IDENT_CHANNEL=1`.
- **entity** — `memory_entity_fts`, off unless `entity_channel` or `ENGRAM_ENTITY_CHANNEL=1`.
- **vector** — a `sqlite-vec` knn probe, l2 distance converted to cosine (`cos = 1 - d²/2`, valid because vectors are unit length).

`expand` adds deterministic query variants as extra fts lists — a split form of an identifier (`hybridSearch` → `hybrid search`), a phrase variant, and the query's rare tokens — and `expand_use_llm` adds an llm tier when `ENGRAM_LLM_BASE_URL` and `ENGRAM_LLM_API_KEY` are set. a variant is diluted by `1/n`, where `n` is the number of contributing lists, so an extra channel can never outvote the primary query. a channel that matched nothing is left out of `n`.

fusion weights come from a query archetype (`classifyQuery` in `src/memory/search/scoring.ts`): temporal, lookup, frequentist, aggregation, semantic (the fallback). the cue lists are data (`QUERY_ARCHETYPES`), in precedence order, so a new class is one entry; `aggregation` holds the semantic weights deliberately, because it routes how much evidence the assembly buys rather than how the channel ranks (see [allocation](#allocation-of-the-evidence-budget)). the profiles mix the fts and vector score with three priors — recency (`ebbinghaus` decay), access (log-scaled count, saturating at 100) and importance. when no vector list contributed, the vector weight is redistributed across the others instead of being spent on zeros. `relevance` is reported separately from `score`: it is the evidence share (fts + vector) with the priors excluded, so a caller can gate on evidence rather than on a memory that merely looks recent.

optional stages:

- **reranker** — with `ENGRAM_RERANKER_ENABLED=1`, the top `rerank_top_n` (default 50) candidates are scored by `onnx-community/bge-reranker-v2-m3-ONNX` and blended with the fused score at `ENGRAM_RERANK_BLEND_ALPHA` (default 0.5). the tail keeps a neutral 0.5 so the whole list stays on one scale. if the model is unavailable the fused order is returned with `diagnostics.degraded` naming it.
- **min_score** — an absolute floor on the final score.
- **access signal** — `ENGRAM_ACCESS_SIGNAL` decides which reads count as a use: `explicit` (default, only a direct fetch stamps `last_accessed`), `retrieval` (every search stamps its results) or `off`.

every channel shares the namespace and temporal predicates in `src/memory/search/scope.ts`, so a subtree search cannot return a sibling namespace by accident.

**the funnel.** a namespace is a path, so the directory tree is the memory tree (`src/namespace/tree.ts`, `src/memory/nav.ts`). tree rows are materialised lazily — by a query read, by `get_context` when it needs counts, by the health report, and at session end (`ensureNode`, `refreshNodeCounts`), with an idempotent backfill sweep on daemon start. `get_context` with a query searches the session's own namespace first. if that leaf is rich — at least 3 hits and a top score at or above 0.35 — the ancestors are skipped. otherwise each ancestor contributes up to two short excerpts matched from its nav digest and cluster summaries. the excerpts are navigation metadata, never a memory body, and the response carries `scope_trace` showing which layer was searched, skipped or used as a guide. `scope: 'leaf'` turns the ascent off.

**recall_context** (`src/memory/recall.ts`) is the same retrieval behind a strict character budget. it packs its sections in a fixed order — digest, then memories, then topics — trims the digest to its share, serves a memory whole or trimmed once when that is the only way to use the last of the budget, drops what still does not fit, suppresses near-duplicates of a kept sibling, and reports the accounting. reads never stamp access, so repeated calls are byte-identical. the budget-free half of it is `recallChannel` (ranked, enriched, deduped candidates plus the summary layer), and `packRecall` turns a channel into the payload; `recallContext` is the two composed.

**assemble** (`src/memory/assemble.ts`) is the read path that composes a whole context: named sections drawn from what already exists — `working` (open task briefs), `state` (current state heads), `memories` (the fused channel), `summaries` (the namespace digest and cluster summaries) and `evidence` (the episode layer) — each packed in recipe order into its share of one character budget (see `carryUnused` below for how unused room moves). the result carries per-section accounting (`used`, `items`, `dropped`, `truncated`, `deduped`, where `deduped` covers the channel's by-id and near-duplicate suppression plus ids an earlier section already served), a trace of the channels and namespace layers read, and `degraded` naming every channel that failed or could not run (no query for the memory channel, an `as_of` read for present-state task briefs, or a thrown read). nothing in it generates text, refreshes a digest, or stamps access, so the same store and inputs give the same bytes.

**recipes** are data (`RECIPES` in the same module): a name, a section list with a budget share, a limit and — for the evidence section — an allocation each, channel toggles (`ident`, `entity`, `expand`), a reranker mode with its blend weight, and an absolute relevance floor. `default` is the recall_context contract and carries that packed payload in `legacy`, so routing the tool through assembly changes no byte of it; `session-priming` puts working and state first; `qa` gives the evidence section nine tenths of the room and ranked memories the rest, with summaries served only from what is left. a recipe with `carryUnused` also moves unused room: forward to later sections, then back to any section that dropped or clipped, and a section that packs itself (evidence) is asked again with the larger room — so a store with no episodes hands the whole budget to its memories, and one with no memories to its evidence. the nine-tenths share is the current experimental policy, not a reproduced accuracy result: the later 500-question assembly ablation has no complete retained matching artifact. section producers live in `SECTION_PRODUCERS`: `evidence` is the episode layer read, so a `qa` read serves dated sessions of raw turns beside the ranked memories. a producer may return a promise, which the episode channel needs to embed the query; the `default` recipe has no evidence section, so its bytes are untouched by that producer.

## time and supersession

`memories` carries `valid_from` and `valid_until`. two read modes:

- `as_of: t` — a full historical view: rows valid at `t`, and only supersedes links that had already been judged at `t` (`notSupersededAtClause`). a fact superseded later still appears in the snapshot.
- `before: t` — the legacy bound: `valid_from <= t` only.

a memory is treated as superseded when a `supersedes` link with confidence at or above 0.8 points at it (`src/contradictions/supersession.ts`). the threshold and the sql fragment live in one module so every read path hides superseded and archived rows the same way. `include_superseded` opts back in to superseded rows and never to archived ones; `include_archived` on `get_memory`/`search_memories` is the only way to read a cold row, and it counts as a fault.

contradiction handling is two-stage (`src/contradictions/`):

1. **candidates** — for a freshly stored memory, cosine-knn and fts both propose neighbours, capped and floored, so the judge sees a short list.
2. **judge** — an llm call returns one verdict per candidate (relation, confidence, reason). thresholds are per relation, because a false positive costs more for some than others: `contradicts` 0.8, `updates` 0.9, `duplicate` 0.95, with anything under 0.4 dropped instead of recorded. each is overridable with `ENGRAM_<RELATION>_THRESHOLD`.
3. **effects** — a confident `supersedes` hides the older row from default reads; a sub-threshold contradiction writes a `conflicts` marker that hides nothing and leaves both sides readable as `disputed`.

a wrong call is reversible: `engram reverse-supersession --target <id>` removes the link and reopens the target's validity window (`src/contradictions/reversal.ts`).

### state slots (current values)

supersession answers "which rows are stale"; a slot answers "what is the value now". a slot is a single-valued fact — `state_key` on `store_memory` / `revise_memory`, a normalized subject+attribute such as `atlas deploy target`, or any caller key. writing the same key again retires the previous value: the predecessor's window closes and a confidence-1.0 `supersedes` link points at it, so every existing read filter prefers the head without a new code path (`src/memory/state.ts`). the key is normalised (trimmed, whitespace collapsed, lowercased) at the one boundary, so the key read back is the key written.

nothing is cached: the head is derived from the chain. three writers create or remove supersession edges (the store path, the adjudicator, `reverse-supersession`), and a materialised head would have to be repaired by all three — a stale head is exactly the failure this layer removes. `memories.state_key` (migration 017, partial index) is the only stored part; every value stays a `memories` row with its own window, so history cannot be lost and the derivation is rebuildable from data alone.

reads:

- `get_state(namespace, key?)` — the current value with its `valid_from`, the value it replaced, and the count of values; without a key, every slot in the namespace. `include_superseded` adds the trajectory (each value with its window and why it was retired). `as_of` returns the value that was current then.
- `get_context` carries a `state` section (up to 5 slots, previews, charged against the budget) so a blanket read can say "this was X until <date>, now Y".
- a slot follows its chain: if an adjudicated successor does not carry the key, the walk still reports it as current and marks it `keyed: false`.
- deleting the head leaves the slot with `current: null` and the last value as `prior`; the values are not resurrected.

chains that predate keys are named by the migration backfill: one connected component of supersedes links is one slot, keyed `chain:<oldest row>` (`backfillChainKeys`, idempotent, never overwrites an explicit key). a component that already carries a key keeps it.

## maintenance

`src/maintenance/jobs.ts` is a durable queue in `maintenance_jobs`. enqueue is idempotent over `(job_type, target_key)` while a job is active, claiming is a single update with a lease (`ENGRAM_MAINTENANCE_LEASE_MS`, default 5 minutes) so an interrupted run is reclaimable, and attempts are capped (`ENGRAM_MAINTENANCE_MAX_ATTEMPTS`, default 3) before a job lands in `dead`. the daemon ticks the queue every `ENGRAM_MAINTENANCE_INTERVAL_MS` (default 60000; 0 turns the ticker off) via `src/maintenance/scheduler.ts`, and `ENGRAM_MAINTENANCE_DISABLED=1` disables the layer.

job types: `digest`, `cluster`, `importance`, `adjudication`, `promote`, `prune`, `retention`, `reembed_episodes`, `episodes_expired`. `end_session` enqueues digest, cluster, importance and adjudication for the session's namespaces, plus a nav digest for the namespace and its nearest existing ancestor, plus a promotion job, plus the episode expiry sweep when that session holds session-retention evidence.

what each one is allowed to write differs:

- `digest` / `cluster` / `importance` / `adjudication` inspect state and record a summary in the job row. the nav variant does write, but only `namespace_nodes.digest` — thin navigation metadata.
- `promote` (`src/maintenance/promote.ts`) distills a leaf `//scope` with at least 8 memories into one `pattern` memory in the parent namespace and links the sources. llm-only by default; `ENGRAM_PROMOTE_EXTRACTIVE=1` restores the extractive fallback for tests and ops.
- `prune` (`src/maintenance/prune.ts`) archives redundant near-identical memories. candidates are bucketed by `(namespace, type, first N characters)`; within a family one keeper survives, chosen by pinned > importance > access count > link degree > oldest, and a member whose text shares enough of the keeper's is archived. archiving sets `archived_at` and repoints the links, so it is reversible. `ENGRAM_PRUNE_THRESHOLD` (default 0.95), `ENGRAM_PRUNE_PREFIX_CHARS` (default 48), `ENGRAM_PRUNE_CLUSTER_PREFIX=1` to treat a whole bucket as one family.
- `retention` (`src/maintenance/retention.ts`) archives on interference, not age alone: a row must be redundant (duplicate-marked, or a non-keeper family member), below `ENGRAM_RETENTION_MAX_SCORE` (default 0.35), unused for at least 14 days, and the corpus must be at least `ENGRAM_RETENTION_MIN_CORPUS` (default 500) memories. a small corpus, and pinned, shareable, promoted, adjudication-winning, dedupe-keeper and hot rows, are skipped and counted. at most `ENGRAM_RETENTION_MAX_ARCHIVE` (default 200) rows go per run. `engram unarchive <id>` and the `unarchive_memory` tool reverse it; every decision is written to `eviction_events`.
- `episodes_expired` (`src/maintenance/episode-retention.ts`) deletes the evidence whose retention ran out — see [retention and deletion](#retention-and-deletion). unlike the memory tier this one is not reversible, because the raw evidence is the only copy.

alongside the durable queue there are two in-process queues (`src/queue/background-queue.ts`) for importance scoring and adjudication, so a slow llm call never blocks a write.

derived data:

- **digest** — pinned memories roll up into a markdown digest per namespace, capped at `ENGRAM_DIGEST_BUDGET_CHARS` (default 2000) and condensed by the llm when one is configured. `get_context` returns it without a search.
- **clusters** — union-find over `semantic` links, each group summarised in one line (llm, or the first sentence extractively).
- **namespace digests** — a compact per-node summary (pinned facts, topic summaries, one-line child digests) at a 1200-character budget; `consolidateTree` refreshes children before parents.
- **importance** — an llm rubric scores each memory and records `importance_source`; `ENGRAM_IMPORTANCE_DISABLED=1` turns it off.
- **scope inference** — when a namespace has `//scope` layers, an llm can file a new memory into the best-matching one. requires `ENGRAM_LLM_*`; `ENGRAM_SCOPE_INFERENCE=0` disables it.

workers (`src/db/workers/`) backfill what an older schema left behind: `namespace` from `project_path`, the identifier/entity fts tables, and embeddings marked `stale`.

## working state

`src/tasks/` is the working tier: what a long-horizon task is doing right now, kept beside the memories rather than in them.

- **`tasks`** holds one row per task (`namespace`, `session_id`, `title`, `goal`, `status` of `open|blocked|done|abandoned`, `plan_json`, `progress_json`, `artifacts_json`, `open_questions_json`, timestamps). the row is never indexed for retrieval — no fts, no vectors — so no search can return half-finished work by similarity.
- **`task_events`** is append-only: every delta an `updateTask` call applies lands there with its author, plus `checkpoint` (pre-compaction), `handoff` and `close`. `updateTask` returns the delta it applied, so a call that changed nothing is visible as such.
- **deltas, not replacements.** `progress`, `artifacts` and `open_questions` append; `plan` entries address an existing item by id (`p1`, `p2`, …) or append a new one; `resolved_questions` removes by exact text. a plan delta naming an item the task does not have is an error, not a silent append.
- **closing writes memory once.** `task_close` renders one summary (goal, plan counts, unfinished steps, last progress, open questions, artifacts) and writes it through `MemoryStore.store()`, so admission, the write gate, embedding and adjudication all still apply; a refusal still closes the task and is reported as the write's answer. closing twice writes nothing the second time.
- **the brief** (`src/tasks/brief.ts`) is a pure function of the stored task and a character budget: goal, plan with status, the last five progress notes, open questions, artifacts. sections are dropped whole when the budget runs out, and what was dropped is reported (`omitted`). `handoff(task, for, budget_chars)` renders the same state for a subagent (unfinished steps, newest note) or a new session (full plan, recent notes).
- **the daemon side** (`src/delivery/tasks.ts`) is what the hooks call: open task briefs for a namespace (a task opened under the host's session id wins the tie), checkpoint-plus-consolidation, a progress note from a subagent's returned summary, and closing the namespace's session at session end.

## delivery

there is one daemon. everything else either calls it or pushes text into a host.

- **mcp instructions** — `initialize` (legacy clients) and `server/discover` (2026-07-28 clients) return the standing rules from `src/delivery/protocol.ts`. clients that honour the mcp `instructions` field put them in the system prompt.
- **protocol revisions** — `src/mcp/dispatch.ts` picks the era per request: a request whose `params._meta` carries `io.modelcontextprotocol/protocolVersion` is answered under 2026-07-28 (stateless, `resultType` and server identity on every result, caching hints on the cacheable ones, `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` headers validated against the body), and anything else under the legacy handshake `src/mcp/revisions.ts` negotiates. `server/discover` answers only the modern path, so a probe from a client that speaks both eras gets a `DiscoverResult` and a legacy probe gets the method miss it falls back on. resources (`src/mcp/resources.ts`) and prompts (`src/mcp/prompts.ts`) are read-only and namespace-scoped; the two provider entries are where a brief or a current-state resource plugs in.
- **daemon auth** — loopback needs no token. a non-loopback bind (`ENGRAM_ALLOW_NONLOCAL=1`) requires a bearer token on every route: `ENGRAM_AUTH_TOKEN`, or the 0600 file `engram auth token` writes (`src/mcp/auth.ts`). the other clients of the daemon — the cli, the hooks and `stdio-server.mjs` — send the same token, and `resolveAuthRequirement` refuses to start the daemon when one is missing.
- **an instruction block** — `engram setup <agent>` writes the longer rules into the host's own instruction file between `<!-- engram:begin -->` and `<!-- engram:end -->`. planning and applying are separate: the default is a dry run, and every write is idempotent and reversible (`--uninstall` removes only the block setup added). agents come from a registry (`src/delivery/registry.ts`, currently `claude-code`, `codex`, `cursor`); any other host can use `engram setup print <agent>`. setup backs up a file before touching it and refuses to follow a symlink out of the home directory.
- **hooks** — `engram hook <event>` reads the host's json on stdin and prints what the host expects. `session-start` injects the rules, the open task brief and a budgeted roster for the namespace, and fires again after compaction. `pre-tool-use` injects up to three short cues: the gotchas, bugs, decisions and patterns that mention the file about to be edited, matched on the absolute path, the path relative to the namespace and the basename. a best-effort cache suppresses the most recent 200 cue ids in a window (state in `src/delivery/cue-state.ts`); cache eviction can duplicate a cue. a repeated compaction kind reopens eligibility; the two distinct notification kinds can join once inside 30 s. without a host compaction id this is a pairing heuristic: two distinct different-kind events may be conflated, and a delayed pair can duplicate delivery. the lifecycle hooks carry the working tier: `pre-compact` checkpoints open tasks and queues consolidation while printing nothing (compaction stays the host's decision), `post-compact` re-injects the brief, `subagent-start` injects a handoff brief, `subagent-stop` records the subagent's returned summary as a progress note (from the payload, or from the last assistant message of the transcript it names), and `session-end` closes the namespace's session. hooks fail open — daemon down, slower than 1.5 s, or unreadable input means no output and exit 0.
- **workspace resolution** — an http mcp server cannot see the client's directory, so `stdio-server.mjs` resolves its own cwd to a git root and forwards with `?project=`. a git worktree canonicalizes to its primary working tree, so a branch does not get an empty namespace of its own. namespaces resolve in a fixed order (`src/namespace/resolver.ts`): tool argument, url parameter, `ENGRAM_DEFAULT_NAMESPACE`, then the detected git root.
- **daemon routes** — `src/server.ts` serves `/mcp` (json-rpc), `/health`, `/metrics`, and the delivery routes the hook cli calls: `/delivery/roster` and `/delivery/cue` read, while `/delivery/task-brief`, `/delivery/task-checkpoint`, `/delivery/task-progress` and `/delivery/session-end` carry the lifecycle hooks. the daemon binds `127.0.0.1`; `ENGRAM_ALLOW_NONLOCAL=1` widens it and turns on bearer auth for every route, and `GET`/`DELETE` on `/mcp` answer `405` because this revision has no session and no standalone stream.

## telemetry

`engram_events` holds per-call counters; `retrieval_events` holds the query text, the returned ids, latency, mode, namespace and the budget accounting for every search. `ENGRAM_LOG_QUERIES=0` stores the query length instead of the text. `eviction_events` holds one row per retention/prune decision and per cold-tier fault, so `get_stats.evictions` reports archived/kept counts by action and reason, the faults, and the fault rate (faults / archived) over the window; the table is bounded by `ENGRAM_EVICTION_MAX_AGE_DAYS` (default 90) and `ENGRAM_EVICTION_MAX_ROWS` (default 100000), both enforced in the maintenance pass that writes to it. `get_stats` and `/metrics` report all three. all of it stays in the local database.

## brains

a brain is an encrypted snapshot of the memories marked shareable, distributed over git. it has its own document: [brains.md](brains.md).

## where things live

```
src/db/            sqlite open, migrations, fts index helpers, backfill workers
src/memory/        store (admission, gate, links), state slots, recall, assemble, episodes (ingest and
                   the dated session context), digest, nav, entities, clustering
src/memory/search/ channels (memories and episodes), fusion, scoring, scope, graph walk
src/contradictions/candidates, judge, adjudicator, supersession, reversal
src/maintenance/   durable queue, scheduler, promote, prune, retention, consolidate
src/namespace/     tree materialization and resolution
src/delivery/      registry, setup planner, markers, hooks, cue, roster, workspace, task hooks
src/tasks/         working state: task store, event log, brief and handoff rendering
src/brains/        identity, snapshot, publish, follow, encryption, mcp tools
src/mcp/           tool schemas, handlers, health
src/embeddings/    local model pipeline, cross-encoder reranker
src/queue/         in-process background queues
src/metrics/       event counters, retrieval ledger, tokenizer
src/session/       sessions and git-root detection
src/cli/           brain, hook, lifecycle and setup commands
```
