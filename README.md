# Engram

Local memory daemon for AI coding tools. Stores memories in SQLite, searchable by meaning (not just keywords). Works across Claude Code, Cursor, and any MCP-compatible tool simultaneously.

```
Claude Code ──┐
Cursor        ├──► http://localhost:8888/mcp?project=/your/repo ──► engram.db
OpenCode      ┘
```

---

## Setup

```bash
npm install -g engram
engram warm      # downloads embedding model once (~23MB)
engram start     # runs in background
```

**Connect to Claude Code** — add to your project's `.claude/settings.json`:
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

The `?project=` parameter scopes all memories to that path. Without it, engram falls back to git root detection from the daemon's working directory. Multiple tools sharing the same `?project=` path share the same memory pool.

---

## Usage

Engram exposes tools that Claude (or any MCP client) calls automatically.

| Tool | What it does |
|---|---|
| `get_context` | Load important memories for the current project. Call at session start. |
| `store_memory` | Save a decision, bug, pattern, or note. |
| `search_memories` | Search by meaning — finds relevant memories even without exact keywords. |
| `get_related` | Traverse the knowledge graph from a given memory. |
| `consolidate_memories` | Find near-duplicate memories to clean up. |
| `forget_memory` | Delete a memory by ID. |

**Add this to your `CLAUDE.md`** to make it automatic:
```markdown
## Memory
- Call `get_context` at the start of every session.
- Use `store_memory` for decisions (type="decision"), bugs (type="bug"),
  patterns (type="pattern"), and gotchas (type="gotcha").
- Set importance 0.0–1.0. High importance = slower decay over time.
```

**CLI:**
```bash
engram search "authentication"   # search from terminal
engram ls --type decision        # list decisions
engram status                    # check daemon health
engram stop                      # shut down
```

---

## How it works

**Memories are scoped per-project** — set via the `?project=` URL parameter, or by walking up from `cwd` to find `.git`. Memories from `/projects/app-a` never appear in `/projects/app-b`.

**Search is hybrid** — combines keyword matching (FTS5) and semantic similarity (local vector embeddings via [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)) fused with Reciprocal Rank Fusion. Finds "concurrent database access" even if you stored "WAL mode SQLite".

**Memories decay over time** — importance and access frequency determine how fast a memory fades from search results. A pattern you set `importance: 0.9` and reference often stays near the top for months. A throwaway note drops off in days.

**Related memories auto-link** — when you store a memory, similar existing memories are automatically linked. Use `get_related` to traverse these connections.

**Everything runs locally.** No accounts, no cloud, no data leaves your machine. DB lives at:
```
~/Library/Application Support/engram/engram.db   # macOS
~/.local/share/engram/engram.db                   # Linux
```

---

## Memory types

`note` · `decision` · `bug` · `pattern` · `gotcha` · `todo`

---

## Requirements

- Node.js 20+
- Internet connection once (to download the embedding model)
