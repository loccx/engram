# engram

engram is local memory for coding tools. it keeps memories scoped to a project in one sqlite file and serves them over mcp, so claude code, cursor or anything else that speaks mcp can read and write the same store.

nothing leaves the machine unless you configure an llm endpoint yourself.

## install

```bash
npm install -g @loccx/engram
engram warm                 # fetch the local embedding model once (~131 MB)
engram start                # daemon on 127.0.0.1:8888
```

requires node 20.19 or newer. the published package is the scoped name `@loccx/engram`; the unscoped `engram` on npm is a different project and `npm install -g engram` will not install this one.

from a checkout:

```bash
npm install && npm run build && node dist/index.js
```

`engram start` runs in the foreground. `engram stop` stops it, `engram status` reports whether it is up.

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

**server instructions.** the `initialize` result carries a short standing-rules text. clients that honour the mcp `instructions` field put it in the system prompt. nothing to install.

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
| `session-start` | the standing rules plus a short roster for the session's namespace. fires again after compaction. |
| `pre-tool-use` | a cue: the gotchas, bugs, decisions and patterns that mention the file a tool is about to touch, matched on the path, the path relative to the namespace and the basename. each memory is injected at most once per session. |

hooks fail open. daemon down, slower than 1.5 s, or unreadable input means no output and exit 0 — a hook must never break a session, so an unreachable store costs a cue, not a reply. to turn delivery off, run `engram setup <agent> --apply --uninstall`, or leave the hooks installed and set `"disableAllHooks": true` in the host's settings.

## tools

| tool | purpose |
|---|---|
| `get_context` | memories for the current namespace, plus the pinned-fact digest. call it at session start. |
| `recall_context` | progressive retrieval for a specific question, packed to a strict character budget. |
| `store_memory` | save a note, decision, bug, pattern, gotcha, todo or procedure. embeds it, links it to related memories, queues a contradiction check. |
| `search_memories` | fts5 and local vectors, fused. takes `budget_chars` to pack the whole payload. |
| `search_by_entity` | look up a file, function, class or library. |
| `get_related` | walk the memory graph. depth 1 is direct links; deeper runs pagerank. |
| `list_memories` | browse by tag, type or namespace. |
| `get_memory`, `update_memory`, `forget_memory`, `revise_memory`, `get_memory_history` | fetch, patch, delete, revise and inspect revisions. |
| `set_pin` | pin or unpin. pinned is the only tier that never decays. |
| `consolidate_memories` | find near-duplicates. |
| `end_session` | close a session and enqueue its maintenance. omit `session_id` to close the current one. |
| `list_sessions` | sessions for a namespace, newest first, plus the current session id. also ends sessions idle past `ENGRAM_SESSION_IDLE_MS`. |
| `get_stats`, `get_maintenance_status`, `run_pending_maintenance` | usage statistics and the background job queue. |
| `list_brains`, `search_brain`, `get_brain_memory`, `mark_shareable` | query and curate shared brains — see [docs/brains.md](docs/brains.md). |

`get_context` also reports `memory_health` (duplicate groups, never-accessed count, stale and missing digests, thin scopes) and, when a result set is thin or empty, `miss` — the ancestor namespace that does hold memories.

cli: `engram status`, `engram search <query>`, `engram ls --type decision`, `engram stats`, `engram stop`. the ones that read memory take `--namespace` to scope the call. lifecycle cleanup is cli too: `engram prune-duplicates` (dry run by default, `--apply` to archive redundant duplicates through the maintenance queue), `engram reverse-supersession --target <id>` for a wrong supersession, and `engram unarchive <id>` to restore an archived memory.

## environment

the ones that change behaviour. everything else has a default that is fine.

| variable | what it does |
|---|---|
| `ENGRAM_DATA_DIR` | the data directory (pid file, default database parent, `brains/`, `identity`). macos `~/Library/Application Support/engram-nodejs`, linux `~/.local/share/engram-nodejs`. |
| `ENGRAM_DB_PATH` | the database file (default `<data dir>/engram.db`). |
| `ENGRAM_MODEL_CACHE_DIR` | where the local embedding model is cached (default `<data dir>/models`). |
| `ENGRAM_EMBEDDINGS` | `off` for keyword-only search: the model is never loaded or downloaded. the test suite runs this way. |
| `ENGRAM_DEFAULT_NAMESPACE` | namespace for callers that do not pass one, instead of the detected git root. |
| `ENGRAM_ALLOW_NONLOCAL=1` | bind `0.0.0.0` instead of loopback. the daemon has no authentication, so this is a deliberate opt-in. |
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
| `ENGRAM_LLM_MODEL` | model for those calls (default `gpt-5.4-nano`). `ENGRAM_LLM_TIMEOUT_MS` (30000) and `ENGRAM_LLM_MAX_RETRIES` (2) bound each call. |
| `ENGRAM_IMPORTANCE_DISABLED=1`, `ENGRAM_SCOPE_INFERENCE=0` | turn off importance scoring and scope inference individually. |

`ENGRAM_AUDIT_LOG` moves the brain audit log (see [docs/brains.md](docs/brains.md)). the maintenance knobs — prune, retention, promotion, leases, per-run caps — are listed in [docs/architecture.md](docs/architecture.md).

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
```

[`eval/README.md`](eval/README.md) covers the flags, the corpora and what each suite does not measure.

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
  "version": "0.2.0",
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
