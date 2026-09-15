# Spec: Hierarchical Memory P3 — Inference, Promotion, Recursive Consolidation

Status: IMPLEMENTATION SPEC. Parent coordinates lanes; this file is the single
source of truth. Builds on P1 (fabac72), P2 (8f5faa4): tree, funnel get_context,
scoped store_memory, nav-digest maintenance jobs.

## Goal

Close the loop: stores route to scopes even without deterministic matches (LLM
inference over EXISTING scopes only), repeated leaf patterns get promoted into
parent nav layers, and digests consolidate bottom-up so parents summarize fresh
children.

Non-goals (P4+): LLM-minted new scopes, demotion/pruning of memories, collapsed
search mode, cross-machine sync.

## Part A — LLM scope inference (lane infer)

New module `src/memory/scope-inference.ts`:

```ts
export interface ScopeInferenceResult { scope: string | null; via: 'inferred' | 'unavailable' }
export async function inferScope(
  db: Database.Database,
  projectPath: string,
  content: string
): Promise<ScopeInferenceResult>
```

- Candidates: existing sibling scopes only — `namespace_nodes` rows with
  `parent_path = projectPath AND is_synthetic = 1`, scope token + first 80 chars
  of the node digest. Zero candidates → `{ scope: null, via: 'unavailable' }`
  without calling the LLM.
- LLM call via `src/llm/client.ts` (`chat`, `isLlmConfigured`) with a strict
  prompt: given the memory content and the candidate list, return ONLY JSON
  `{"scope": "<token>" | null}`. Parse defensively: non-JSON, unknown token
  (not in candidates), or any throw → `{ scope: null, via: 'unavailable' }`.
  Never create or mint scopes. Timeout/failure follows the llm client's own
  conventions (see digest.ts usage for the pattern).
- `store_memory` routing order becomes: explicit `scope` arg → deterministic
  word-boundary mention (P2 `contentMentionsScope`) → `inferScope` → project
  root. The store response reports `routed_scope` (token) and adds
  `routed_via: 'explicit' | 'mention' | 'inferred' | 'root'` (additive; keep
  `routed_scope` semantics from P2: token string, omitted at root).
- Inference is skipped entirely when `ENGRAM_SCOPE_INFERENCE=0` (env kill
  switch, checked at call time) or when `isLlmConfigured()` is false.

Invariants (tests/scope-inference.test.ts):
1. Deterministic mention still wins over inference (inferScope never called
   when P2 match fires — assert via spy/mock or by observing `routed_via`).
2. LLM suggesting a token not in candidates is ignored (falls through to root).
3. LLM failure/unconfigured → store succeeds into project root, response
   `routed_via: 'root'` (or `'unavailable'` mapping — pick one and test it).
4. Env kill switch skips the LLM call entirely.
5. Valid inference routes the memory into the existing synthetic scope node
   (memory row namespace = `<project>//<token>`).

## Part B — promotion + recursive consolidation (lane maintenance)

Owns the whole sleep-time pipeline for this wave.

### Migration 011 — extend maintenance_jobs job_type CHECK

SQLite cannot ALTER a CHECK. Rebuild (follow types.ts helpers; idempotent):
`maintenance_jobs` → new table with
`CHECK (job_type IN ('digest','cluster','importance','adjudication','promote'))`,
copy all rows, drop old, rename, RECREATE every index including the partial
unique `(job_type, target_key)` index — losing that index breaks enqueue
idempotency. Guard: skip rebuild when the CHECK already contains 'promote'
(inspect `sqlite_master.sql`).

### Promotion — `src/maintenance/promote.ts`

```ts
export const PROMOTE_MIN_MEMORIES = 8
export async function promoteScopePatterns(db, projectPath): Promise<PromotionReport>
```

For each synthetic leaf scope under projectPath (is_synthetic=1) with
memory_count >= PROMOTE_MIN_MEMORIES:
1. Dedupe check first: skip when the PARENT namespace already holds a memory
   with `type='pattern'` whose tags include the scope token (deterministic,
   no LLM needed for dedupe).
2. Distill the pattern: LLM (`chat` when configured) over the scope's top-10
   memories (importance DESC) → one dense pattern paragraph (<=500 chars).
   Extractive fallback: concatenate the 3 highest-importance content snippets
   (<=160 chars each) with scope prefix — never throw.
3. Insert into the PARENT path namespace: type `'pattern'`, importance 0.7,
   tags include the scope token, content prefixed `[<scope>] `. provenance
   source `'promotion'` via whatever provenance fields P1/P2 already use
   (mirror how revisions/importance write provenance; keep it consistent).
4. Link each source memory to the promoted pattern via `memory_links`
   (link_type `'promoted_from'`) — reuse the existing links API/SQL shape.
5. Refresh the parent nav digest afterwards (call refreshNavDigest).

Report shape: `{ promoted: string[], skipped: string[], reasons: Record<string,string> }`.

### Recursive consolidation — `src/maintenance/consolidate.ts`

```ts
export async function consolidateTree(db, rootPath: string): Promise<{ refreshed: number }>
```
Post-order traversal (children before parents) from rootPath's subtree, calling
`refreshNavDigest` per node — parents therefore condense fresh child digests.
Depth-bounded by the tree (real paths only; synthetic scopes included where
present as nodes).

### jobs.ts wiring

- Enqueue side (`enqueueEndSessionMaintenance`): after nav jobs, enqueue ONE
  `promote` job with `target_key: 'promote:' + namespace` (idempotent via the
  unique index — coalesces across sessions).
- Executor: `job_type = 'promote'` → if target_key starts with `'promote:'`,
  run `promoteScopePatterns(db, targetKey.slice(8))` for real (canonical
  writes allowed — this is the consolidation pipeline, same class as digest
  refresh; document in the file header). Then, when the report promoted
  anything, enqueue nothing extra (parent digest refresh already happened
  inside promoteScopePatterns).
- Executor: digest jobs with `target_key` prefix `'navtree:'` → run
  `consolidateTree(db, targetKey.slice(8))`. (Enqueue sites for navtree are
  P4; the executor exists so ops/CLI can enqueue manually.)

Invariants (tests/promote.test.ts):
1. Scope at/under PROMOTE_MIN_MEMORIES is skipped with reason; over it promotes.
2. Second run dedupes (no duplicate pattern memory in the parent).
3. Promoted memory: parent namespace, type 'pattern', scope-token tag,
   linked to sources; parent digest refreshed after.
4. Extractive fallback content when LLM unconfigured; never throws.
5. Migration 011: old rows survive, 'promote' jobs insertable, unique index
   still enforces (job_type, target_key) idempotency.
6. navtree executor consolidates post-order on a 3-level fixture (child digest
   content visible in parent digest after run).

## Part C — eval (lane eval, after A+B)

On a temp copy of the live hive DB: synthesize 3-4 leaf scopes, backfill
memories, run promote + consolidateTree, then measure: guide-hit rate for
thin-leaf queries (was 0 without primed digests), recall@5, context bytes —
before vs after consolidation. Write `docs/eval-funnel-p3.md` (new file).
Read-only against the original DB; writes only on the copy.

## Lane ownership (hard boundaries)

| Lane | Owns |
| --- | --- |
| infer | `src/memory/scope-inference.ts`, `src/mcp/handlers.ts` (store_memory case ONLY — get_context frozen), `src/mcp/schemas.ts`, `src/mcp/tools.ts`, `tests/scope-inference.test.ts` |
| maintenance | `src/db/migrations/011_promote_jobs.ts`, `src/db/migrations/index.ts` (registration only), `src/maintenance/promote.ts`, `src/maintenance/consolidate.ts`, `src/maintenance/jobs.ts`, `tests/promote.test.ts` |
| eval | `scripts/eval-funnel.ts`, `docs/eval-funnel-p3.md` |

Forbidden to all lanes: git commands, daemon start/stop, package.json,
tsconfig.json, src/db/init.ts, src/memory/nav.ts, src/namespace/tree.ts,
existing tests outside your lane (parent reconciles shared-test fallout like
the P2 maintenance-count ripple).

## Test matrix

All lanes: `npx tsc --noEmit` + own tests. Parent: full suite, then commit,
rebuild, daemon restart, live probe (store with inference + end_session →
promote job run → parent guide hit visible in a thin-leaf get_context).
