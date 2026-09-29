# changelog

## 0.3.0 — 2026-09-29

the first version-stamped release. every build before this one carried `0.2.0` in `package.json`, no tag was ever created and nothing was published to a registry, so there is no earlier entry to list.

the schema moves from 11 migrations to 22. a database written by any earlier build upgrades itself the next time it is opened — see [upgrade](README.md#upgrade).

### breaking and operational

- eleven new migrations, `012` through `022`, covering the identifier index, the archive tier, the retrieval ledger, the precomputed ident columns, working state, state slots, scope statistics, episodes, episode embed jobs and the embedding cache. a database at schema 11 is brought to 22 on the next open, behind an automatic backup.
- bearer auth is now required for any non-loopback bind. `engram auth token` writes the token; the daemon refuses to start without a usable one. loopback is unchanged and needs no token.
- a write can now be refused. admission (`ENGRAM_ADMISSION`, default `enforce`) rejects credential-shaped content outright and throttles bursts per namespace and type, so a caller that used to assume every write landed has to handle a refusal.
- the tool surface grew: `assemble_context`, `ingest_episodes`, `get_state`, `session_start` and the five task tools are new, and `recall_context` is now a recipe over the assembly path. the returning tools answer with more than they used to — `get_context` adds `memory_health` and a `miss` hint — so a caller that parses responses strictly should re-read the [tools](README.md#tools) table.

### features

- **working state.** a task records what is in flight — goal, plan with a per-step status, progress notes, artifacts, open questions — in its own tables beside `memories`, so no search returns half-finished work. a task reaches durable memory only when `task_close` writes one summary through the normal store path, where admission, embedding and linking still apply. every update is a delta and every delta lands in an append-only event log with its author, so a progress claim can be traced back. `task_start`, `task_update`, `task_get`, `task_close` and `task_handoff`.
- **the brief is a pure function of the stored task**, so the same task renders the same bytes every time. `handoff` renders the same state for a reader with no history: `for: "subagent"` keeps the unfinished steps and the newest note, `for: "new-session"` keeps the full plan and the recent notes. the lifecycle hooks re-inject it, so work survives a compaction or a handoff.
- **state slots.** single-valued facts keep their whole trajectory. `state_key` on `store_memory` keys a fact to a slot, and `get_state` reports what is true now, what it replaced, and with `as_of` or `include_superseded` the full history. the current head is derived from the supersession chain rather than materialised, because a stale head is exactly the failure this layer removes.
- **episodes.** raw evidence — one row per turn or chunk, immutable, in its own table with its own index, never extracted, summarised or decayed. they exist because serving turns beats serving whole sessions (+11.0 points over whole-session on `longmemeval_s`, 0.734 against 0.624) while keeping every turn as a memory row multiplies the curated table tenfold (246,750 rows against 23,867 over the same 500 questions). the engine keeps the granularity and the assembly and leaves `memories` its size.
- **idempotent episode ingest.** `external_id` plus the source system is the key, so a connector can re-send a session or only the turns since the last send and get `{ ingested: 0, duplicates: 12 }` back. admission runs on this path too, so a transcript carrying a credential is refused with the shape named and never the value. a chunk can point at the whole it was cut from, so multi-granularity layers stay traceable, and `retention` with a `ttl_ms` becomes an expiry that reads respect.
- **one context-assembly read path.** `assemble_context` serves named sections — working briefs, state heads, summaries, ranked memories and the episode layer as evidence — under one budget, with a recipe (`default`, `session-priming`, `qa`) picking the sections and their shares. `recall_context` becomes a recipe over the same path. the response carries per-section accounting, the channels and layers searched, and every channel that failed or could not run.
- **delivery.** three push surfaces instead of a pull-only server: the standing rules in the `initialize` and `server/discover` results, an instruction block written into the host's own file between `<!-- engram:begin -->` and `<!-- engram:end -->`, and lifecycle hooks for `session-start`, `pre-tool-use`, `pre-compact`, `post-compact`, `subagent-start`, `subagent-stop` and `session-end`. `engram setup <agent>` dry-runs by default and `--apply` writes; every write backs the file up first, refuses to follow a symlink out of the home directory, and refuses a file it cannot parse instead of overwriting it. hooks fail open, so an unreachable store costs a cue rather than a reply.
- **dual-revision mcp protocol.** the current revision and the legacy handshake are answered from the same process, and the era is decided per request from the body rather than the transport. the modern path gets `server/discover`, stateless requests, `resultType` and server identity in `_meta`, caching hints, resources and prompts; the older one gets the legacy result shape. a revision it does not speak comes back as `UnsupportedProtocolVersionError` listing what it does.
- **resources and prompts** alongside the tools: the standing rules, a namespace digest and roster, and the `session-primer` and `context` prompts.
- **identifier-aware lexical index and an entity channel**, wired into the fused search as extra lists beside the keyword and vector ones. both are off by default because an extra list dilutes the others.
- **write gate.** `merge` is the default: an exact-content duplicate returns the existing row instead of inserting it again. `link` only records near-duplicates, `off` disables the layer.
- **lifecycle.** an archive tier with `archived_at`, a durable lease-based `maintenance_jobs` queue the daemon drains on a ticker, and cli to work it: `engram prune-duplicates` (dry run by default, `--apply` to archive through the queue), `engram reverse-supersession` for a wrong supersession, `engram unarchive` to restore. an opt-in `clusterPrefix` prune mode targets burst-written duplication.
- **retrieval ledger** for query-level telemetry, with `ENGRAM_LOG_QUERIES=0` storing the query length instead of its text.
- **session lifecycle.** a session idle past `ENGRAM_SESSION_IDLE_MS` (12 h) is ended on the next write or `list_sessions` call.
- **embedding cache.** one row per distinct `(model, dtype, dim, mode, model input)`, so content written twice — across rows, namespaces or a restart — is embedded once. rows are capped and evicted least-recently-used first, and a hit restamps its lru clock at most once a minute so the common hit stays a read. `ENGRAM_EMBED_CACHE_DIR` points the same key space at files instead, which is what lets a repeat eval run skip the model entirely.
- **a repo-local `CONTRIBUTING.md`**, and `docs/architecture.md` and `docs/brains.md` for the storage layout, the write gates, retrieval channels, bi-temporal validity and the maintenance queue.

### performance

- precomputed `ident_text` columns at write time, replacing a per-character trigger CTE on the read path.
- the embedding cache above, which is the largest single win on any repeated write workload and on eval reruns.
- episodes keep the model off the write path: `defer_vectors: true` lets the rows and their fts index go live the moment the call returns and the maintenance queue embeds the backlog, bounded page by page, instead of the writer waiting on a model. `batch_embeddings: true` is the throughput alternative and is off by default because padding moves the vectors, so a batched row sits ~0.97–0.99 cosine from the single-call one.
- high-similarity links indexed, and a scope counted in one scan instead of per row.
- lexical channels scored from the scope's own statistics, cutting the work of a search that touches a large scope.

### fixes

- dangling `memory_links` rows are dropped instead of aborting the `013` rebuild.
- `clusterPrefix` is reachable from the job path rather than only from a direct call.
- the llm client speaks the reasoning-model wire format, and the reasoning effort is pinned in the model name rather than guessed.
- deterministic tie order for equal scores: candidate order, then rowid, so the same query returns the same list.
- the scope row count and invalidation now include the scope's own episodes.
- the knn is scoped, the reranker blend is folded into the fused score, and relevance is absolute rather than relative to the result set.
- dropped an unlocked `gpt-tokenizer` devDependency.

### tests

- the suite runs with `ENGRAM_EMBEDDINGS=off`, so a checkout without the model still tests.
- credential fixtures are built at runtime rather than committed.
- the schema contract, telemetry, sessions, health and budgets are pinned; migration idempotency is asserted, including that `012` is applied rather than terminal once `014` lands.
- index latency is gated on a median rather than a 10-sample maximum, so the gate measures the change and not the machine.
- embedding-cache byte-identity is proved on real turns, and episode equivalence is proved between the episode and turn-memory systems.

### docs

- the README rewritten to describe the surface as it is built, including working state, episodes, the protocol revisions and the full environment table.
- comment and prose sweeps across source, tests, migrations and eval so the code reads the way a maintainer would leave it, with benchmark numbers and operator-specific paths kept out of the tree.
- generated measurement reports and fetched datasets are kept out of the repository.
