# Spec: Hierarchical Memory Tree + Funnel Retrieval (P1)

Status: IMPLEMENTATION SPEC — build to this document, deviations go in your lane report.
Parent coordinates lanes; this file is the single source of truth.

## Goal

Namespace isolation and target retrieval. Namespaces are filesystem paths. The
directory tree becomes the memory tree: dense leaf scopes, thin digest layers at
parents, and funnel retrieval that searches the deepest scope first and ascends
through thin navigation layers only when the leaf is thin.

Non-goals (P2+): write-side auto-routing of memories to scopes, collapsed
(descendant-flattening) search mode, sleep-time recursive consolidation,
cross-machine brain sync of trees.

## Namespace tree semantics

- A namespace is path-shaped when it starts with `/` or `~` (existing examples:
  `/Users/locc/git/research/hive`). Non-path namespaces (`autonomous-crypto-desk`,
  `research`) are their own roots: depth 0, no parent, funnel degrades to leaf-only.
- Parent of `/a/b/c` is `/a/b`; parent of `/a` is `/` (fs root, depth 0). Depth =
  number of segments (root `/` = 0, `/a` = 1, ...). `~` and `/Users/locc` collapse
  to depth 0 roots the same way.
- Synthetic scopes: a namespace may carry a suffix `//scope`, e.g.
  `/Users/locc/cb//payments`. The real path part is `/Users/locc/cb`; the synthetic
  node's full path is the literal string including `//scope`. Parent of a synthetic
  node is its real path. Synthetics are always created on demand.
- Tree persistence is derived + materialized: `namespace_nodes` rows are created
  lazily by `ensureNode` on first write/retrieval touching that namespace, and by a
  backfill sweep over distinct `COALESCE(namespace, project_path)` values.

## Migration 010 — `namespace_nodes`

Follow the pattern of `009_maintenance_jobs.ts` (`tableExists`/`indexExists` guards,
idempotent). Register `migration010` in `src/db/migrations/index.ts`.

```sql
CREATE TABLE IF NOT EXISTS namespace_nodes (
  path TEXT PRIMARY KEY,
  parent_path TEXT,                       -- NULL for roots
  depth INTEGER NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0,-- 1 when path contains '//'
  real_path TEXT,                         -- non-null for synthetic nodes
  digest TEXT,                            -- thin nav layer (condensed)
  digest_source_hash TEXT,
  memory_count INTEGER NOT NULL DEFAULT 0,
  child_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_namespace_nodes_parent ON namespace_nodes(parent_path);
CREATE INDEX IF NOT EXISTS idx_namespace_nodes_depth ON namespace_nodes(depth);
```

## Module APIs

### `src/namespace/tree.ts` (lane tree owns)

```ts
export interface NamespaceNode {
  path: string
  parent_path: string | null
  depth: number
  is_synthetic: boolean
  real_path: string | null
  digest: string | null
  memory_count: number
  child_count: number
  last_activity_at: number | null
  updated_at: number
}

export function parseNamespacePath(ns: string): {
  full: string
  realPath: string | null      // part before '//' when synthetic
  scope: string | null         // part after '//'
  isPathShaped: boolean
  parentPath: string | null    // tree parent (real path parent for synthetics)
  depth: number
}
export function ensureNode(db: Database.Database, ns: string): NamespaceNode
// Idempotent. Creates the full ancestor chain in one transaction. Non-path
// namespaces become a root node (parent_path NULL, depth 0, is_synthetic 0).
export function deepestKnownPrefix(db: Database.Database, ns: string): NamespaceNode | null
// Walk real path segments upward (longest first); return the deepest node that
// exists in namespace_nodes. Returns null when nothing matches.
export function ancestors(db: Database.Database, ns: string): NamespaceNode[]
// Tree parents of the parsed node, root-first.
export function children(db: Database.Database, path: string): NamespaceNode[]
export function setNodeDigest(db: Database.Database, path: string, digest: string, sourceHash: string | null): void
export function refreshNodeCounts(db: Database.Database, path: string): void
// memory_count = COUNT(memories WHERE COALESCE(namespace, project_path) = path
// AND no superseding memory); child_count = COUNT(namespace_nodes WHERE parent_path = path);
// last_activity_at = MAX(created_at) of those memories.
export function backfillTree(db: Database.Database): number
// ensureNode for every distinct namespace in memories; refresh counts for all
// touched nodes. Returns number of nodes ensured.
```

No filesystem I/O in tree.ts — the tree is built from stored namespace strings only.

### `src/memory/nav.ts` (lane nav owns)

```ts
export const NAV_DIGEST_BUDGET_CHARS = 1200
export interface ChildRosterEntry { path: string; digest: string; memory_count: number; child_count: number }

export async function refreshNavDigest(db, namespace: string, opts?: { budgetChars?: number }): Promise<{ content: string; changed: boolean }>
// Condenses into namespace_nodes.digest for the node:
//   1. the node's own pinned-fact digest lines (reuse getDigest from digest.ts)
//   2. top cluster summaries (memory_clusters, up to 5, newest-first)
//   3. one-line child digests (first 100 chars of each child's digest, up to 8)
// Uses llm/client.chat with a strict condensing prompt when isLlmConfigured(),
// deterministic extractive fallback otherwise (never throws on LLM failure).
// Sets digest_source_hash = sha1 of the concatenated sources; skips write when unchanged.
export function childRoster(db, namespace: string): ChildRosterEntry[]
// children(path) joined with their digests, ordered by memory_count DESC, limit 12.
// Empty digest -> '' (still listed; it is a navigation signal that the child exists).
```

## Funnel retrieval (handlers.ts — lane funnel owns)

`get_context` gains args (schemas.ts + tools.ts):

- `scope?: 'leaf' | 'funnel'` — default `'funnel'` for path-shaped namespaces,
  leaf-only behavior otherwise. `'leaf'` forces current single-namespace behavior.
- `strict_scope?: boolean` — default `true`. When false, leaf search expands to the
  whole subtree (`path = ns OR path LIKE ns || '/%' OR path LIKE ns || '//%'`).
  Strict never returns memories outside the node's own namespace, full stop.

Funnel algorithm (query path only; blanket path keeps roster + adds nav guide):

```
node = deepestKnownPrefix(db, ns) ?? ensureNode(db, ns)
results = hybridSearch(query, { namespace: node.path, limit, ... })   // unchanged scoring
trace = [{ namespace: node.path, depth: node.depth, hits: results.length,
           top_score: top hybrid score (normalized 0..1) or null, action: 'searched' }]
guide: Array<{ namespace: string; kind: 'digest' | 'cluster' | 'child_roster'; source: string; excerpt: string }> = []
for parent of ancestors(node):                       // root-first
  if results.length >= K_MIN && topScore >= THETA:
    trace.push({ namespace: parent.path, depth: parent.depth, action: 'skipped' }); continue
  guideHits = FTS match of query tokens against parent.digest + parent cluster summaries
             (strip to <=2 excerpts per parent, <=240 chars each)
  guide.push(...guideHits)
  trace.push({ namespace: parent.path, depth: parent.depth, hits: guideHits.length, action: 'guide_only' })
```

Constants: `K_MIN = 3`, `THETA = 0.35` — module-level consts in handlers.ts, tune
via eval later. Normalization: reuse whatever normalized score hybridSearch already
exposes; if it exposes none, add a `score` field to search results (min-max normalized
within the result set) — that edit lives in search.ts and is owned by lane funnel.

Response additions (both paths):
- `scope_trace`: as above; always present for path-shaped namespaces.
- `guide`: nav excerpts (query path: ancestor digests/clusters; blanket path: the
  node's `childRoster` as `kind: 'child_roster'` entries). Guide is navigation
  metadata — never a memory body, never counted against `limit`.

Isolation invariants (funnel.test.ts must assert all):
1. Strict results only from the node's own namespace string.
2. Ascent touches only ancestors of the resolved node — siblings never queried.
3. Non-path namespaces behave exactly as today (no tree machinery invoked beyond
   ensureNode root creation).
4. `strict_scope: false` may return subtree descendants only (`ns/%`, `ns//%`),
   never siblings.
5. scope_trace shape/order: deepest first, ends at depth-0 root.

## Eval harness (lane eval owns)

`scripts/eval-funnel.ts`: read-only against the live DB
(`~/Library/Application Support/engram-nodejs/engram.db` — open with
`readonly: true` file option; never write). Builds a probe set: 30 queries sampled
from memory contents of the two largest namespaces (held-out terms + entity terms
from memory_entities), compares:
  A. flat baseline: hybridSearch on the full namespace
  B. funnel: leaf scope first, ascent as specified
Metrics: recall@5, tokens-of-context-at-recall (sum of returned content lengths),
mean response JSON bytes. Writes `docs/eval-funnel-p1.md` with a results table and
recommended THETA/K_MIN. Pure script (`tsx scripts/eval-funnel.ts`), no src/ edits.

## Test matrix (all lanes run `npx tsc --noEmit` + their own tests; parent runs full suite)

- tree.test.ts: ensureNode ancestor chain, idempotency, parseNamespacePath
  (`//` synthetics, non-path, `~`), deepestKnownPrefix ordering, ancestors
  root-first, refreshNodeCounts math, backfillTree on seeded rows.
- nav.test.ts: extractive fallback digest determinism, source-hash skip, roster
  ordering + limit, empty-child digest tolerated.
- funnel.test.ts: the 5 isolation invariants above + thin-leaf ascent triggers
  guide hits from parent digest + skipped-ascend when leaf is rich.

## Lane ownership (hard boundaries)

| Lane | Owns (may create/edit ONLY these) |
| --- | --- |
| tree | `src/db/migrations/010_namespace_nodes.ts`, `src/db/migrations/index.ts` (add migration010 only), `src/namespace/tree.ts`, `tests/tree.test.ts` |
| nav | `src/memory/nav.ts`, `tests/nav.test.ts` |
| funnel | `src/mcp/handlers.ts`, `src/mcp/schemas.ts`, `src/mcp/tools.ts`, `src/memory/search.ts`, `tests/funnel.test.ts` |
| eval | `scripts/eval-funnel.ts`, `docs/eval-funnel-p1.md` |

Forbidden to all lanes: package.json, tsconfig.json, src/db/init.ts, src/daemon.ts,
src/server.ts, existing tests, any file not in your lane. Do NOT run `git commit`,
`git add`, or any state-changing git command — the parent stages and commits.
Do NOT start/restart the daemon.

## Sequence

1. tree + nav in parallel (nav codes against tree.ts signatures from this spec).
2. funnel after both merge (handlers wiring + tsc must pass against real tree/nav).
3. eval + fresh-context review in parallel after funnel.
