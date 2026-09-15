# Spec: Hierarchical Memory P2 — Scoped Writes + Nav-Digest Maintenance

Status: IMPLEMENTATION SPEC. Parent coordinates lanes; this file is the single
source of truth. Build on P1 (commits fabac72, a9a3825): namespace_nodes table,
src/namespace/tree.ts, src/memory/nav.ts, funnel get_context — all on main.

## Goal

Make scoped writes real so funnel savings materialize:
1. `store_memory` can target a synthetic scope (`//scope`) explicitly, with a
   deterministic auto-routing fallback when a scope already exists.
2. Nav digests refresh automatically at session end via the existing
   maintenance_jobs queue (sleep-time substrate) instead of manual calls.

Non-goals (P3): LLM-based scope inference, promotion/demotion of memories
between tree levels, recursive root consolidation, collapsed search mode.

## Part A — store_memory scope routing (lane route)

`store_memory` gains args (schemas.ts + tools.ts):

- `scope?: string` — creates/uses a synthetic scope namespace
  `${resolvedProjectPath}//${scope}`. Validation: trim; reject empty, strings
  containing `/` or `//`, length > 64 (zod refinements with clear messages).
  The synthetic node is materialized via `ensureNode` (P1), so the tree and
  scope_trace work unchanged.
- Auto-routing (deterministic, no LLM): when `scope` is absent, after entity
  extraction check whether the content mentions an existing sibling scope name
  for the resolved project — i.e. for each `namespace_nodes` row with
  `parent_path = resolvedProjectPath AND is_synthetic = 1`, parse its scope
  token; if the content contains that token as a word-boundary match
  (case-insensitive), route to that scope. At most one match wins (first by
  memory_count DESC). When it fires, the store result includes
  `routed_scope: '<token>'`; when absent, omit the field.
- Response for store_memory additionally reports the final namespace:
  `namespace: <effective namespace>` on success (additive field).

Invariants (tests/store-scope.test.ts):
1. `scope: 'payments'` on project `/p` stores into `/p//payments` (both the
   memory row and a namespace_nodes row with is_synthetic=1, depth+1).
2. Invalid scopes rejected: `'a/b'`, `'a//b'`, `''`, 65+ chars — with
   zod validation errors, not thrown exceptions.
3. Auto-route fires only on word-boundary token match of an EXISTING scope
   ('payment' must not match scope 'payments'), and never when scope was
   explicit.
4. get_context funnel from `/p//payments` (strict) sees scoped memories;
   sibling scopes stay invisible (invariant already covered, assert again
   through the store path).

## Part B — nav-digest maintenance wiring (lane navjobs)

In `src/maintenance/jobs.ts` (no handlers.ts edits):

- `enqueueEndSessionMaintenance` (called by the end_session handler) additionally
  enqueues one `digest` job with `target_key: 'nav:' + namespace` for the
  session's namespace and, when a parent node exists, one for its nearest
  existing ancestor (`nav:<parentPath>`). Idempotency comes free from the
  existing (job_type, target_key) partial-unique index.
- Job executor: the digest branch currently dispatches project digest refresh by
  target key. Add: `target_key` starting with `'nav:'` → `refreshNavDigest(db,
  targetKey.slice(4))` (import from src/memory/nav.js). Unknown namespace
  (no node row) → complete the job with a no-op result, never throw.
- Shadow-mode rules from migration 009 apply unchanged: these jobs write
  namespace_nodes.digest only.

Invariants (tests/nav-maintenance.test.ts):
1. end_session enqueues nav digest jobs for the namespace (and parent when
   present) — job rows exist with target_key 'nav:...' and are claimable.
2. Running the claimed job refreshes namespace_nodes.digest from fixture data
   (pinned memories + a cluster row) without LLM (extractive fallback).
3. `nav:` job for a namespace with no node row completes as a no-op.
4. Existing project-digest jobs behave exactly as before (no regression).

## Part C — eval extension (lane eval, after A+B)

Extend `scripts/eval-funnel.ts` (or a sibling section) to project the scoped-write
win: copy the live DB to a temp file (sqlite3 backup API or file copy while
readonly), then on the COPY only: pick the largest namespace, create k synthetic
scopes (k in {5, 20, 50}), redistribute its memories round-robin by entity token
via direct SQL insert with namespace = `<ns>//<scope-i>` (keep FTS/vectors rows
consistent or restrict the probe to FTS-only paths), re-run the existing probe
set through funnel vs flat, and report: recall@5 delta vs P1 baseline, mean
context bytes at recall, and the projected `n_scope/N` curve. Write results to
`docs/eval-funnel-p2.md` (new file; do not edit eval-funnel-p1.md).

## Lane ownership (hard boundaries)

| Lane | Owns |
| --- | --- |
| route | `src/mcp/handlers.ts` (store_memory case only), `src/mcp/schemas.ts`, `src/mcp/tools.ts`, `tests/store-scope.test.ts` |
| navjobs | `src/maintenance/jobs.ts`, `tests/nav-maintenance.test.ts` |
| eval | `scripts/eval-funnel.ts`, `docs/eval-funnel-p2.md` |

Forbidden to all lanes: git commands (parent commits), daemon start/stop,
package.json, tsconfig.json, src/db/init.ts, migrations, tree.ts, nav.ts,
funnel tests, any file outside your list. get_context code in handlers.ts is
frozen for lane route — do not touch the funnel case.

## Test matrix

All lanes: `npx tsc --noEmit` + own tests. Parent: full suite before commit.
