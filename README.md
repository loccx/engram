# engram

Local memory for AI coding tools. Speaks MCP over HTTP, so Claude Code, Cursor,
or anything else can share one memory store per project.

## Install and run

Requires Node 20.19 or newer.

```bash
npm install -g engram     # or: npm install && npm run build, then node dist/index.js
engram warm               # fetch the embedding model once (nomic-embed-text-v1.5, ~137 MB)
engram start              # daemon on 127.0.0.1:8888
```

The daemon binds loopback only. `ENGRAM_ALLOW_NONLOCAL=1` widens the bind, and is
a deliberate opt-in because the daemon has no authentication.

Point a client at it:

```json
{ "mcpServers": { "engram": {
    "type": "http",
    "url": "http://localhost:8888/mcp?project=/absolute/path/to/repo" } } }
```

`?project=` scopes memories to that path. Without it, engram walks up from its own
working directory to find `.git`.

An HTTP server cannot see the client's directory, so `stdio-server.mjs` exists for
per-workspace scoping: the client launches it with the project as cwd, it resolves
that to the git root (a worktree resolves to its primary repo, not the throwaway
path), and forwards with the right `?project=`.

```json
{ "mcpServers": { "engram": {
    "command": "node",
    "args": ["/path/to/engram/stdio-server.mjs"] } } }
```

## Tools

| Tool | Purpose |
|---|---|
| `get_context` | Memories for the current namespace, plus a digest of pinned facts. Call at session start. |
| `recall_context` | Progressive retrieval for a specific question. |
| `store_memory` | Save a note, decision, bug, pattern, gotcha, todo or procedure. Embeds, links to related memories, and queues a contradiction check. Pass `pinned: true` to make it permanent. |
| `search_memories` | Hybrid search: FTS5 and local vectors fused with reciprocal rank fusion. |
| `search_by_entity` | Look up a file, function, class or library. |
| `get_related` | Walk the memory graph. Depth 1 is direct links; deeper runs PageRank. |
| `list_memories` | Browse by tag, type or namespace. |
| `get_memory`, `update_memory`, `forget_memory`, `revise_memory`, `get_memory_history` | Fetch, patch, delete, revise, and inspect revision history. |
| `set_pin` | Pin or unpin. Pinned is the only tier that never decays. |
| `consolidate_memories` | Find near-duplicates. |
| `end_session` | Close the session and enqueue digest maintenance. |
| `get_stats`, `get_maintenance_status`, `run_pending_maintenance` | Usage statistics and the background job queue. |
| `list_brains`, `search_brain`, `get_brain_memory`, `mark_shareable` | Query and curate shared brains. See below. |

CLI: `engram status`, `engram search <query>`, `engram ls --type decision`, `engram stop`.

## How it works

Memories are scoped per namespace, and a namespace is a path, so the directory tree
is the memory tree: retrieval searches the session's deepest scope first and ascends
through parent layers only when the leaf is thin. `/projects/app-a` never sees
`/projects/app-b`.

Storage is SQLite with sqlite-vec. Keyword and vector results are fused rather than
ranked separately, so storing "WAL mode SQLite" and searching "concurrent database
access" still finds it.

**Tiers.** `pinned` is the only permanent tier. Everything else is scored
`0.5·importance + 0.3·access + 0.2·recency` and classified hot, warm or cold — which
means importance alone does not make a memory survive; it has to be pinned.

**Digest.** Pinned memories roll up into a cached markdown digest returned by
`get_context` with no search cost. `ENGRAM_DIGEST_BUDGET_CHARS` caps it (default
2000). With an LLM configured, an over-budget digest is condensed rather than
truncated.

**Contradictions.** When a new memory contradicts an older one, a background pass can
mark the old one superseded rather than deleting it. Reads hide superseded facts
unless you ask for them.

**Local by default.** Nothing leaves the machine unless you configure
`ENGRAM_LLM_BASE_URL` and `ENGRAM_LLM_API_KEY`, which enable LLM-backed importance
scoring, contradiction adjudication, promotion distillation and digest
consolidation. With no LLM configured those paths are either off or deterministic.

Database: `~/Library/Application Support/engram-nodejs/engram.db` on macOS,
`~/.local/share/engram-nodejs/engram.db` on Linux.

## Brains

A brain is an encrypted, git-distributed snapshot of the memories you mark shareable.
Publish yours; teammates follow it and their agents query it directly.

```bash
engram init
engram brain init my-brain
engram brain grant my-brain <teammate's engram_pub_...>
engram brain publish my-brain --confirm --remote <git-url>

# teammate
engram brain follow alice <git-url>
engram brain refresh alice
```

Then `search_brain(brain="alice", query="why postgres over mysql")` returns Alice's
memories with attribution.

Encryption is `age`; keys are `engram_pub_...` / `engram_priv_...` (bech32 over age).
Distribution is a plain git remote — no server, and the encrypted snapshot is the
only artefact that ships.

What travels: the memories you marked shareable, their entities and links, their
embeddings, and reduced session rows. Namespaces are rewritten owner-relative
(`/Users/you/cb` becomes `~/cb`, foreign roots become `ext/<leaf>-<hash>`), absolute
project paths are dropped, and superseded memories are excluded — so a follower sees
your knowledge, not your filesystem. Revocation applies to future snapshots only,
because a recipient who already decrypted one keeps it.

## Memory types

note, decision, bug, pattern, gotcha, todo, procedure
