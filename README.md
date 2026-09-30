# engram

engram is local memory for coding tools. it keeps memories scoped to a project in one sqlite file and serves them over mcp, so claude code, cursor or anything else that speaks mcp can read and write the same store.

nothing leaves the machine unless you configure an llm endpoint yourself.

## install

```bash
npm install && npm link     # from a checkout: the package is not on a registry yet
engram warm                 # fetch the local embedding model once (~131 MB)
engram start                # daemon on 127.0.0.1:8888
```

requires node 20.19 or newer. the package name is the scoped `@loccx/engram`; the unscoped `engram` on npm is a different project and `npm install -g engram` will not install this one. it is not published to a registry yet, so `npm install -g @loccx/engram` fails and a checkout is the way in.

without installing it globally:

```bash
npm install && npm run build && node dist/index.js
```

`engram start` runs in the foreground. `engram stop` stops it, `engram status` reports whether it is up. bringing an existing database forward is [upgrade](#upgrade).

## upgrade

get the new source, `npm install`, `npm run build`, restart the daemon. the database migrates itself — there is no migration command and none is needed.

**the database migrates on open.** `DatabaseManager.init()` (`src/db/init.ts`) runs the numbered migrations in `src/db/migrations/` through `src/db/migrations/runner.ts` every time the file is opened, before the daemon answers a request. the set currently spans 001 to 022. a database written by any earlier build is brought forward on the next start; one already current does nothing.

what the runner guarantees, and why an unattended upgrade is safe:

| guarantee | how |
|---|---|
| a ledger | `schema_migrations` records every applied version with its description and duration; `PRAGMA user_version` mirrors the high-water mark |
| adoption, not re-run | a database migrated before the ledger existed is read from `user_version` alone |
| no partial state | each migration's `up(db)` and its version bump run inside one `BEGIN IMMEDIATE` |
| a backup first | `VACUUM INTO <db>.bak.<timestamp>` is written before any pending migration is applied |
| one migrator at a time | an exclusive `<db>.migrate.lock`, released in a `finally`; a pre-existing one aborts with instructions instead of guessing |
| a check afterwards | `PRAGMA quick_check` — anything but `ok` throws |
| no rewind | the high-water mark is never lowered, so a reserved version arriving late cannot move it back |
| gaps tolerated | a version gap across parallel branches is allowed; a duplicate or non-1-based version is rejected |

each migration is written to a contract (`src/db/migrations/types.ts`): idempotent, with existence checks before DDL; self-contained in `up(db)`; and backwards-compatible for readers, because backfills run after `up()` returns.

**restart the daemon.** it is long-lived and loads the compiled `dist/` tree at process start, so rebuilding does not change a process that is already running. `dist/` is gitignored, which makes a stale tree easy to miss: if `dist/` is older than `src/`, build before restarting. a daemon restarted on a stale `dist/` will not apply the migrations its own database is waiting for.

```bash
git pull                      # or re-clone
npm install                   # prepare runs the build
npm run build                 # only when prepare did not run

# restart whatever runs the daemon:
launchctl kickstart -k gui/$(id -u)/com.engram.daemon   # macos, via scripts/install-service.sh
systemctl --user restart engram.service                 # linux
```

if you started the daemon by hand, stop it and start it again — `engram stop` does the first half.

**prune the backups yourself.** every applied batch leaves a `<db>.bak.<timestamp>` beside the database, roughly the size of the database, and nothing deletes them. on a large store they accumulate faster than the store grows, so remove the ones you no longer want deliberately.

the database is `<data dir>/engram.db`; `ENGRAM_DB_PATH` names the file directly and `ENGRAM_DATA_DIR` moves everything. [environment](#environment) has the per-platform paths.

## point a client at it

an http mcp server cannot see the client's working directory, so the url carries the project:

```json
{ "mcpServers": { "engram": {
    "type": "http",
    "url": "http://localhost:8888/mcp?project=/absolute/path/to/repo" } } }
```

without `?project=` the daemon resolves the namespace from its own working directory by walking up to the nearest `.git`.

`stdio-server.mjs` exists for tools that launch a server per workspace with the project as cwd. it resolves that cwd to a git root and forwards with the right `?project=`:

```json
{ "mcpServers": { "engram": {
    "command": "node",
    "args": ["/absolute/path/to/stdio-server.mjs"] } } }
```

mcp config is read literally, so use a real path — for a global install that is `$(npm root -g)/@loccx/engram/stdio-server.mjs`. a git worktree resolves to its primary working tree, so a branch does not get an empty namespace of its own.

## deliver the rules and the context

an mcp server is pull-only: it does nothing until the agent decides to call a tool. three surfaces push instead, and all of them are optional.

**server instructions.** the `initialize` result and the `server/discover` result both carry a short standing-rules text. clients that honour the mcp `instructions` field put it in the system prompt. nothing to install.

**an instruction block.** `engram setup <agent>` writes the same rules into the host's own instruction file, between `<!-- engram:begin -->` and `<!-- engram:end -->`, so anything you wrote around it is untouched.

```bash
engram setup                          # list the agents it knows
engram setup claude-code              # dry run: print the exact lines it would change
engram setup claude-code --apply      # mcp server + rules block + hooks
engram setup codex --apply            # config.toml + ~/.codex/AGENTS.md
engram setup claude-code --apply --uninstall    # remove only what setup added
engram setup print <agent>            # print the config to paste by hand
```

`claude-code`, `codex` and `cursor` come from a registry (`src/delivery/registry.ts`), one entry per agent. for any other host, `engram setup print <agent>` prints the mcp entry and the rules text; `engram setup` on its own lists the known names.

every write backs the file up first (`<file>.engram.bak`, kept from the first run), refuses to follow a symlink out of your home directory, refuses a file it cannot parse instead of overwriting it, and re-running changes nothing.

**hooks.** `engram hook <event>` is the process a host runs at a lifecycle event: it reads that host's json on stdin and prints what the host expects on stdout. `--host claude-code` wraps the text in that host's envelope; without it, plain text.

| event | what it injects |
|---|---|
| `session-start` | the standing rules, the open task brief and a short roster for the session's namespace. fires again after compaction. |
| `pre-tool-use` | a cue: the gotchas, bugs, decisions and patterns that mention the file a tool is about to touch, matched on the path, the path relative to the namespace and the basename. each memory is injected at most once per session. |
| `pre-compact` | nothing on stdout. writes a checkpoint event to every open task and queues consolidation for the namespace, so the plan and the last progress note are already on disk when the host drops the context. |
| `post-compact` | the open task brief again, so the work resumes from the stored plan rather than from the summary the host kept. |
| `subagent-start` | a handoff brief trimmed to the unfinished plan items and the newest progress note. |
| `subagent-stop` | nothing on stdout. records the subagent's returned summary as a progress note on the parent task. |
| `session-end` | nothing on stdout. closes the namespace's session and queues its consolidation. |

hooks fail open. daemon down, slower than 1.5 s, or unreadable input means no output and exit 0 — a hook must never break a session, so an unreachable store costs a cue, not a reply. to turn delivery off, run `engram setup <agent> --apply --uninstall`, or leave the hooks installed and set `"disableAllHooks": true` in the host's settings.

## protocol

engram answers the current mcp revision and the legacy handshake from the same process, so an older client keeps working while a newer one gets the newer shape. the era is decided per request, from the body, not from the transport:

| client | how the era is decided | what it gets |
|---|---|---|
| 2026-07-28 | the request's `_meta` carries the protocol version and the client's capabilities | `server/discover`, stateless requests (no session, no `initialize`), `resultType` plus the server identity in `_meta`, caching hints, resources and prompts |
| 2025-11-25 and earlier | the request opens with `initialize` | the requested version is echoed back, then tools, resources and prompts in the legacy result shape |

engram answers the requested version with the newest revision it speaks at or below it, and a revision it does not speak comes back as `UnsupportedProtocolVersionError` listing what it does. it never mints `Mcp-Session-Id`, the standalone GET stream and the session DELETE answer `405`, and an unknown method answers `404` on the modern path and `400` on the legacy one.

alongside the tools:

| surface | uri / name | what it is |
|---|---|---|
| resource | `engram://protocol/rules` | the standing rules, as markdown |
| resource | `engram://{namespace}/digest` | the pinned-fact digest of a namespace |
| resource | `engram://{namespace}/roster` | the short present-state roster, with ids |
| prompt | `engram/session-primer` | the rules plus the roster as one user message; takes an optional `namespace` argument |
| prompt | `engram/context` | the assembled read for a namespace as one user message; takes optional `namespace`, `query`, `budget_chars` and `recipe` arguments |

a namespace is an absolute path, so the concrete form of the digest is `engram:///Users/you/repo/digest`. `resources/templates/list` describes both namespace resources, so a client can offer them without knowing a path up front.

## tools

| tool | purpose |
|---|---|
| `get_context` | memories for the current namespace, plus the pinned-fact digest. call it at session start. |
| `recall_context` | progressive retrieval for a specific question, packed to a strict character budget. |
| `assemble_context` | one assembled read over named sections — working task briefs, current state heads, summaries, ranked memories and the episode layer as evidence — under one budget. a recipe (`default`, `session-priming`, `qa`) picks the sections and their shares; the response carries per-section accounting, the channels and layers searched, and every channel that failed or could not run. |
| `store_memory` | save a note, decision, bug, pattern, gotcha, todo or procedure. embeds it, links it to related memories, queues a contradiction check. |
| `ingest_episodes` | store raw evidence — one turn or chunk per item — instead of curating it into a memory: transcripts, tool output, documents. deduplicated on `(source, external_id)`, so a re-sent session or a delta batch costs nothing. see [episodes](#episodes). |
| `delete_episodes` | permanently delete stored evidence: by namespace (with `subtree`), narrowed by `source`, `external_ids` or `before` (`occurred_at`). takes the vectors, the lexical index rows and the citations with it, reports the count per table, and `dry_run` reports without deleting. a call that would match the whole store is refused. |
| `search_memories` | fts5 and local vectors, fused. takes `budget_chars` to pack the whole payload. hides retired (archived) rows; `include_archived` reads them back and counts a fault. |
| `search_by_entity` | look up a file, function, class or library. |
| `get_related` | walk the memory graph. depth 1 is direct links; deeper runs pagerank. |
| `get_state` | the current value of single-valued facts (slots): what is true now, what it replaced, and with `include_superseded` / `as_of` the whole trajectory. pass `state_key` on `store_memory` to keep a fact in a slot. |
| `list_memories` | browse by tag, type or namespace. |
| `get_memory`, `unarchive_memory`, `update_memory`, `forget_memory`, `revise_memory`, `get_memory_history` | fetch, restore a retired row, patch, delete, revise and inspect revisions. an archived row answers to `get_memory` only with `include_archived`. `get_memory` and `get_memory_history` return `episodes`: the evidence each memory was distilled from, with the span inside it. |
| `set_pin` | pin or unpin. pinned is the only tier that never decays. |
| `consolidate_memories` | find near-duplicates. |
| `end_session` | close a session and enqueue its maintenance. omit `session_id` to close the current one. |
| `list_sessions` | sessions for a namespace, newest first, plus the current session id. also ends sessions idle past `ENGRAM_SESSION_IDLE_MS`. |
| `get_stats`, `get_maintenance_status`, `run_pending_maintenance` | usage statistics — including the eviction ledger: archived and kept counts by reason, cold-tier faults, and the fault rate — and the background job queue. |
| `list_brains`, `search_brain`, `get_brain_memory`, `mark_shareable` | query and curate shared brains — see [docs/brains.md](docs/brains.md). |
| `task_start`, `task_update`, `task_get`, `task_close`, `task_handoff` | working state: a goal, a plan with per-item status, progress notes, artifacts and open questions, plus a bounded handoff brief. see [working state](#working-state). |
| `session_start` | one priming call: standing rules, open task briefs, the pinned-fact digest and the roster, packed to a character budget. |

`get_context` also reports `memory_health` (duplicate groups, never-accessed count, stale and missing digests, thin scopes) and, when a result set is thin or empty, `miss` — the ancestor namespace that does hold memories.

cli: `engram status`, `engram search <query>`, `engram ls --type decision`, `engram stats`, `engram stop`. the ones that read memory take `--namespace` to scope the call. lifecycle cleanup is cli too: `engram prune-duplicates` (dry run by default, `--apply` to archive redundant duplicates through the maintenance queue), `engram reverse-supersession --target <id>` for a wrong supersession, and `engram unarchive <id>` to restore an archived memory.

## working state

long work outlives one context window. a task is the record of what is in flight: goal, plan with a status per step, progress notes, artifacts, open questions. it lives in its own tables beside `memories`, so no search ever returns half-finished work — a task reaches durable memory only when `task_close` writes one summary through the normal store path, where admission, embedding and linking still apply.

```bash
task_start   { title, goal, plan: ["migration 016", "hooks"], artifacts: ["src/tasks/store.ts"] }
task_update  { id, plan: [{ id: "p1", status: "done" }], progress: ["migration landed"] }
task_handoff { id, for: "subagent", budget_chars: 900 }
task_close   { id, summary: "shipped behind the task tools" }
```

every update is a delta, and every delta lands in an append-only event log with its author, so a progress claim can be traced back. reads are explicit: `task_get` by id or by namespace.

the brief is the portable part. `brief(task, budget_chars)` renders goal, plan with status, the last five progress notes, open questions and artifacts as a pure function of the stored task, so the same task renders the same bytes every time. `handoff` renders the same state for a reader with no history: `for: "subagent"` keeps the unfinished steps and the newest note, `for: "new-session"` keeps the full plan and the recent notes.

hooks re-inject it. `pre-compact` checkpoints and queues consolidation without ever blocking the compaction, `post-compact` puts the brief back, `subagent-start`/`subagent-stop` hand work out and take the answer back, `session-end` closes the session. `claude-code` gets all seven hooks; codex and cursor document no lifecycle hook surface, so there they are the tools alone (`engram setup codex --apply` says so).

## episodes

memories are the durable point; episodes are the raw evidence behind it — one row per turn or chunk, immutable, in their own table with their own index. they exist because serving turns beats serving whole sessions (turn-granularity retrieval scored +11.0 points over whole-session on longmemeval_s, 0.734 against 0.624) while keeping every turn as a memory row multiplies the curated table tenfold (246,750 rows against 23,867 over the same 500 questions). the engine keeps the winning half — the granularity and the assembly — and leaves `memories` its size.

```bash
ingest_episodes {
  source: { system: "codex", instance: "laptop:locc" },
  permissions: { visibility: "project", retention: "durable" },
  episodes: [
    { external_id: "sess-7:msg:12", session_id: "sess-7", turn_index: 12,
      content: "user: the deploy window moved to 13:00 utc", occurred_at: 1760000000000,
      provenance: { repo: "engram", commit: "046fa30" } }
  ]
}
```

what the ingest guarantees, in the order it happens: `external_id` plus the source system is the idempotency key, so a connector can re-send a session or only the turns since the last send and get `{ ingested: 0, duplicates: 12 }` back; admission runs on this path too, so a transcript carrying a credential is refused with the shape named and never the value; the batch is one transaction; a chunk can point at the whole it was cut from and an item can point at its parent, so multi-granularity layers stay traceable; and `retention` with a `ttl_ms` becomes an expiry that reads respect.

expiry is a row property, so something has to reclaim it. `retention: ephemeral` with a `ttl_ms` stores an absolute `expires_at`; `retention: session` means the evidence lives until the session that produced it ends, and the sweep removes such a row once its `session_id` names a session this store has closed (an episode whose session was never seen here is kept until a ttl or `delete_episodes` removes it). the `episodes_expired` maintenance job runs that sweep, once per boot and after a session that ended holding session-retention evidence, in bounded pages of 5000 rows. `delete_episodes` is the same path on demand: the rows, their vectors, their lexical index rows and their `memory_episodes` citations go in one transaction, and deleting evidence takes the citations with it.

the embeddings of a batch are computed before that transaction opens, one call per item, so a stored vector is what `getEmbedding` returns for that text. `defer_vectors: true` skips them entirely: the rows and their fts index are live the moment the call returns, `embed_state` stays `stale`, and the maintenance queue embeds the backlog (bounded page by page, one call per episode) instead of the writer waiting on a model. a caller that must not block on the local model — a big session replay, a byo-model daemon — wants the deferred mode; a search issued before the backlog drains ranks those rows lexically and names the evidence channel in `degraded`.

`batch_embeddings: true` is the throughput alternative on the same path: one forward pass per length-sorted chunk of up to `EMBED_BATCH_MAX` items. it is off by default because it is not vector-neutral — the tokenizer pads every row to the longest in its chunk and the q8 kernels then move the padded rows, so a batched row sits ~0.97-0.99 cosine from the single-call vector (equal-length rows stay byte-identical). batching buys back roughly a tenth of the wall clock on turns; the reproducible vector costs that tenth.

episodes are not a second memory table. nothing extracts, summarises or decays them, no search returns one as a memory, and they carry no validity window — a derived memory cites its evidence through `memory_episodes` instead. that citation is written by the paths that distill: `task_close` cites every episode ingested under the closed task id, `promote` gives the pattern the union of its sources' citations, and the `prune` keeper inherits the citations of the duplicate it absorbs. retrieval reads them by turn: candidates are ranked with the same fused lexical + vector scoring the memory channel uses, then grouped by session, dated, presented oldest first and packed to the character budget, each served line keeping its episode id, session and date. `assemble_context` with the `qa` recipe serves them as its evidence section, beside the ranked memories.

## environment

the ones that change behaviour. everything else has a default that is fine.

| variable | what it does |
|---|---|
| `ENGRAM_DATA_DIR` | the data directory (pid file, default database parent, `brains/`, `identity`). macos `~/Library/Application Support/engram-nodejs`, linux `~/.local/share/engram-nodejs`. |
| `ENGRAM_DB_PATH` | the database file (default `<data dir>/engram.db`). |
| `ENGRAM_MODEL_CACHE_DIR` | where the local embedding model is cached (default `<data dir>/models`). |
| `ENGRAM_EMBEDDINGS` | `off` for keyword-only search: the model is never loaded or downloaded. the test suite runs this way. |
| `ENGRAM_EMBED_CACHE` | `off` disables the embedding cache. on by default: one row per distinct (model, dtype, dim, mode, model input), so content written twice — across rows, namespaces or a restart — is embedded once. |
| `ENGRAM_EMBED_CACHE_DIR` | a directory switches the cache from the table to files there, which is how repeated runs reuse vectors across processes. the eval harness points `--vectors cached`/`on` at `eval/.embed-cache`. |
| `ENGRAM_EMBED_CACHE_MAX_ROWS` | row cap of the in-db cache, least-recently-used first (default 20000). |
| `ENGRAM_DEFAULT_NAMESPACE` | namespace for callers that do not pass one, instead of the detected git root. |
| `ENGRAM_ALLOW_NONLOCAL=1` | bind `0.0.0.0` instead of loopback. a deliberate opt-in, and a guarded one: a non-loopback bind requires a bearer token on every request. loopback needs no token at all. |
| `ENGRAM_AUTH_TOKEN` | the bearer token itself. wins over the token file, and is how a remote client gets it. |
| `ENGRAM_AUTH_TOKEN_FILE` | the token file (default `<data dir>/auth.token`). |
| `ENGRAM_ADMISSION` | `enforce` (default), `warn` or `off`. whether a write that fails an admission rule is refused, stored with a warning, or not checked at all. |
| `ENGRAM_ADMISSION_BURST_MIN` | how many memories sharing an opening may accumulate in one namespace and type before the next one is refused (default 5, minimum 2). |
| `ENGRAM_ADMISSION_BURST_WINDOW_MS` | how far back the burst check looks (default 7 days). |
| `ENGRAM_ADMISSION_MAX_CHARS` | content ceiling for a single memory (default 24000). |
| `ENGRAM_WRITE_GATE` | `merge` (default), `link` or `off`. `merge` returns the existing row for an exact-content duplicate instead of inserting it again; `link` only records near-duplicates. |
| `ENGRAM_WRITE_GATE_SIM` | cosine for the near-duplicate branch, clamped to 0.5–0.999 (default 0.95). |
| `ENGRAM_ACCESS_SIGNAL` | `explicit` (default: only a direct fetch counts as a use), `retrieval` (every search stamps its results) or `off`. access count feeds ranking, so this is policy. |
| `ENGRAM_LOG_QUERIES=0` | store the query length instead of the query text in the retrieval ledger. |
| `ENGRAM_SESSION_IDLE_MS` | a session with no write for this long is ended on the next write or `list_sessions` call (default 12 h, `0` disables the sweep). |
| `ENGRAM_RERANKER_ENABLED=1` | score the top candidates with a local cross-encoder and blend it into the fused score. `ENGRAM_RERANK_BLEND_ALPHA` sets the blend (default 0.5). |
| `ENGRAM_IDENT_CHANNEL=1`, `ENGRAM_ENTITY_CHANNEL=1` | add the identifier and entity fts indexes as extra search lists. both are off by default because an extra list dilutes the others. |
| `ENGRAM_MAINTENANCE_INTERVAL_MS` | how often the daemon drains the maintenance queue (default 60000; `0` stops the ticker). `ENGRAM_MAINTENANCE_DISABLED=1` disables the layer. |
| `ENGRAM_DIGEST_BUDGET_CHARS` | ceiling for the pinned-fact digest (default 2000). |
| `ENGRAM_LLM_BASE_URL`, `ENGRAM_LLM_API_KEY` | turn on the llm-backed paths: importance scoring, contradiction adjudication, digest condensation, pattern promotion, query expansion and scope inference. |
| `ENGRAM_LLM_MODEL` | model for those calls (default `gpt-5.4-nano`). append a reasoning effort for reasoning models, e.g. `gpt-6-luna:low`. `ENGRAM_LLM_TIMEOUT_MS` (30000) and `ENGRAM_LLM_MAX_RETRIES` (2) bound each call. |
| `ENGRAM_IMPORTANCE_DISABLED=1`, `ENGRAM_SCOPE_INFERENCE=0` | turn off importance scoring and scope inference individually. |

`ENGRAM_AUDIT_LOG` moves the brain audit log (see [docs/brains.md](docs/brains.md)). the maintenance knobs — prune, retention, promotion, leases, per-run caps — are listed in [docs/architecture.md](docs/architecture.md).

### off loopback

binding off loopback is the one deployment that needs a secret:

```bash
engram auth token              # writes <data dir>/auth.token, mode 0600
ENGRAM_ALLOW_NONLOCAL=1 engram start
engram auth status             # where the token comes from, never its value
```

the daemon refuses to start without a usable token, and then every request — `/health`, `/metrics`, `/delivery/*`, `/mcp` — must carry `Authorization: Bearer <token>`. generate and print one for a client on another machine with `engram auth token --print`, and give that client `ENGRAM_AUTH_TOKEN`. local tooling needs nothing: the cli, the hooks and `stdio-server.mjs` read the same token file. the comparison is constant time, the token is never logged, and a token file another user can read is refused with the `chmod 600` that fixes it.

the llm paths are optional and nothing is sent anywhere without `ENGRAM_LLM_BASE_URL` and `ENGRAM_LLM_API_KEY`. with no llm configured those paths are either off or deterministic.

## how it works

a namespace is a path, so the directory tree is the memory tree: retrieval searches the session's deepest scope first and ascends through parent layers only when that leaf is thin. `/projects/app-a` never sees `/projects/app-b`.

storage is sqlite with fts5 and `sqlite-vec`. keyword and vector results are fused rather than ranked separately, so storing `WAL mode SQLite` and later asking about `concurrent database access` still finds it. an archetype classifier picks the signal mix per query, and recency, access count and importance act as priors on top.

pinned memories roll up into a digest that `get_context` returns with no search cost. when a new memory contradicts an older one, a background pass can mark the old one superseded instead of deleting it; reads hide superseded facts unless you ask for them, and `as_of` gives a full historical view. maintenance archives redundant or cold duplicates, reversibly.

the rest — storage layout, the write gates, retrieval channels, bi-temporal validity, the maintenance queue, delivery — is in [docs/architecture.md](docs/architecture.md).

## brains

a brain is an encrypted, git-distributed snapshot of the memories you mark shareable. publish yours, a teammate follows it, and their agent can query it directly:

```bash
engram init
engram brain init my-brain --namespace "$PWD"
engram brain grant my-brain engram_pub_...
engram brain publish my-brain --confirm --remote git@github.com:you/my-brain.git

# teammate
engram brain follow alice git@github.com:alice/my-brain.git
engram brain refresh alice
```

encryption is `age`, distribution is a plain git remote, and the exported snapshot carries your shareable memories with namespaces rewritten owner-relative and superseded facts excluded. [docs/brains.md](docs/brains.md) has the details.

## eval

`eval/` measures retrieval, contradiction handling and budget packing on generated corpora, with pinned thresholds as a regression gate.

```bash
npm run eval -- --assert        # every suite, offline, fts only
npm run eval:retrieval
npm run eval:contradiction

# the turn-granularity comparison: whole-session engram, one memory per turn, and the
# engine's episodes served by the engine's own assembly
npx tsx eval/run.ts --suite longmemeval --dataset longmemeval_s_cleaned --limit 100 \
  --systems engram,engram-turns,engram-episodes
```

[`eval/README.md`](eval/README.md) covers the flags, the corpora and what each suite does not measure. on 100 questions of `longmemeval_s_cleaned` the two turn-granularity systems agree to within a point on coverage (0.851 episodes against 0.844 turn memories), evidence-turn coverage (0.938 both), sessions per question (5.13 against 5.07) and context size, while `engram-episodes` writes 49,059 episode rows and zero memory rows where `engram-turns` writes 49,061 memories. the served lists are not byte-identical there — 85% mean session overlap, 88% mean overlap of served turns — because the two systems rank against different fts indexes: the memory one also holds the whole-session rows and each turn memory's tags, while with nothing but the turns in both, the served context is byte-identical (`tests/episodes-equivalence.test.ts`). `ENGRAM_EVAL_EQUIVALENCE=1 npx vitest run tests/episodes-equivalence.test.ts` re-runs the suite check; `tmp/cmp/episodes-served-agreement.json` has the overlap numbers.

## keep it running

`engram start` is a foreground process. to bring the daemon up at login, install a per-user supervisor (no sudo, reversible):

```bash
bash scripts/install-service.sh              # install and start
bash scripts/install-service.sh --uninstall  # stop and remove
```

macos: a launch agent at `~/Library/LaunchAgents/com.engram.daemon.plist`, logs in `~/Library/Logs/engram.out.log` and `engram.err.log`. linux: a user unit at `~/.config/systemd/user/engram.service`, logs via `journalctl --user -u engram -f`. the script prints the file it wrote and the undo command, refuses to replace a file it did not write without `--force` (which backs up first), and never stops a job it did not start.

after a global install the script ships in the package: `bash "$(npm root -g)/@loccx/engram/scripts/install-service.sh"`.

## health and data

```bash
curl -s http://localhost:8888/health
```

```json
{
  "status": "ok",
  "uptime": 1234567,
  "memoryCount": 128,
  "sessionCount": 9,
  "version": "0.3.0",
  "embeddings": {
    "model": "nomic-ai/nomic-embed-text-v1.5",
    "ready": true,
    "loaded": false,
    "vectorsAvailable": true
  }
}
```

`embeddings.ready` means the whole model cache a load reads is on disk, so a load needs no download. `embeddings.loaded` means the embedder is warm in this process right now. `embeddings.vectorsAvailable` means `sqlite-vec` loaded, so vectors can be stored and searched.

without the model, engram still works, degraded: hybrid search loses its vector leg (fts5 and fusion survive, semantic match does not), a new memory is not embedded and so gets no distance-based links, and near-duplicate detection goes quiet. nothing is lost permanently — `engram warm` followed by `engram rebuild-vectors` recomputes the missing embeddings.

the database lives at `<data dir>/engram.db`; brains, the identity and the audit log live beside it. `ENGRAM_DATA_DIR` and `ENGRAM_DB_PATH` make a fully separate instance, which is what the tests use:

```bash
ENGRAM_DATA_DIR=/tmp/engram-test \
ENGRAM_DB_PATH=/tmp/engram-test/engram.db \
ENGRAM_MODEL_CACHE_DIR=/tmp/engram-test/models \
engram start --port 8899
```

## memory types

`note`, `decision`, `bug`, `pattern`, `gotcha`, `todo`, `procedure`.

a memory is a sentence someone can act on. durable decisions with the why, gotchas, conventions and non-obvious constraints are worth storing; anything the repo or the diff already records, transient state, and secrets are not — admission refuses credential-shaped content outright.
