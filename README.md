# Engram

Local memory for AI coding tools. Claude Code, Cursor, anything that speaks MCP, at the same time.

```
Claude Code
Cursor        -> http://localhost:8888/mcp?project=/your/repo -> engram.db
OpenCode
```

## Setup

```bash
npm install -g engram
engram warm
engram start
```

`.claude/settings.json`:
```json
{
  "mcpServers": {
    "engram": {
      "type": "http",
      "url": "http://localhost:8888/mcp?project=/absolute/path/to/your/project"
    }
  }
}
```

`?project=` scopes memories to that path. Skip it and engram walks up from cwd to find `.git`. Same `?project=` value from multiple tools shares the same memory pool.

## Tools

| Tool | What it does |
|---|---|
| `get_context` | Load memories for the current project, plus a pre-consolidated `digest` string of pinned facts. Call at session start. |
| `store_memory` | Save a decision, bug, pattern, note. Extracts entities, embeds, auto links, checks for contradictions in the background. |
| `search_memories` | FTS5 + semantic search, fused with RRF. |
| `search_by_entity` | Find memories mentioning a file, function, class, library. |
| `get_related` | Walk the memory graph from a memory. Depth 1 is direct links, depth 2+ is PageRank over the link graph. |
| `list_memories` | Browse with tag, type, namespace filters. |
| `get_memory` / `update_memory` / `forget_memory` | Fetch, patch, delete by id. |
| `set_pin` | Pin a memory so it always shows up and never decays. |
| `consolidate_memories` | Find near duplicates to clean up. |
| `get_stats` | Local usage stats. |
| `list_brains` / `search_brain` / `get_brain_memory` / `mark_shareable` | Share memories with teammates over git. See below. |

Add to `CLAUDE.md`:
```markdown
## memory
call get_context at the start of every session.
use store_memory for decisions, bugs, patterns, gotchas.
set importance 0 to 1. higher means it sticks around longer.
```

CLI:
```bash
engram search "authentication"
engram ls --type decision
engram status
engram stop
```

## How it works

Memories are scoped per project. `/projects/app-a` never sees `/projects/app-b`.

Search is hybrid: FTS5 keyword match plus local vector embeddings ([all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)), fused with reciprocal rank fusion. Store "WAL mode SQLite", search "concurrent database access", still finds it. `use_reranker=true` adds a cross encoder pass on top, costs 500 to 1000ms, needs `ENGRAM_RERANKER_ENABLED=1`.

Memories decay. Importance and access frequency set how fast, following an Ebbinghaus curve. High importance and frequent use stays near the top for months. A throwaway note drops off in days. `set_pin` exempts a memory from decay entirely.

Pinned memories also roll up into a digest: a small, always-present markdown snapshot that `get_context` hands back with zero search cost, so the facts you care most about are in context before the agent asks for anything. It is derived from the pinned set and cached until that set changes, never a rewrite of it. `ENGRAM_DIGEST_BUDGET_CHARS` caps its size (default 2000); over budget, an LLM condenses it if one is configured, otherwise it truncates.

Storing a memory auto links it to similar existing ones. `get_related` walks those links: depth 1 is direct, depth 2+ runs PageRank over the graph for multi hop discovery.

Facts get corrected, not just deleted. When a new memory contradicts an old one, a background LLM pass (set `ENGRAM_LLM_BASE_URL` and `ENGRAM_LLM_API_KEY`) marks the old one superseded instead of removing it. Superseded facts stay hidden from search unless you pass `include_superseded=true`.

File paths, function names, classes, libraries get extracted and indexed on store, so `search_by_entity` can do exact lookups without going through semantic search.

Everything is local. Nothing leaves your machine.

```
~/Library/Application Support/engram/engram.db   # macOS
~/.local/share/engram/engram.db                   # Linux
```

## Brains

A brain is an encrypted, git versioned snapshot of one namespace's shareable memories. Publish yours, teammates follow it, their agents query it directly.

```bash
engram init
engram brain init my-eng-brain
engram brain grant my-eng-brain bob <bob's engram_pub_...>
engram brain publish my-eng-brain --confirm

# teammate
engram brain follow <git-url> --as alice
engram brain refresh alice
```

Then `search_brain(brain="alice", query="why postgres over mysql")` returns Alice's actual memories with attribution. Nothing gets published unless you mark it shareable first. Encryption is plain `age`, no custom crypto, decryptable with the `age` CLI alone if you ever want out. No server, just a git remote. Full design in `docs/brains-spec.md`.

## Memory types

note, decision, bug, pattern, gotcha, todo, procedure

## Requirements

Node 20+. Internet once, to pull the embedding model.
