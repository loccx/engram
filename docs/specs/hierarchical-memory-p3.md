# Scope inference, promotion, and recursive consolidation

The sleep-time half of the memory tree: routing a memory into an existing scope
when words alone do not decide it, condensing a busy scope into a parent-layer
pattern, and refreshing digests bottom-up so parents summarise fresh children.

The tree, funnel retrieval, and scoped writes are in
`hierarchical-memory-p1.md` and `hierarchical-memory-p2.md`.

## Scope inference

`src/memory/scope-inference.ts` decides which existing scope a memory belongs to
when no scope was named and no sibling scope is mentioned by name.

Candidates are existing sibling scopes only: synthetic children of the resolved
project, each represented by its token and the first 80 characters of its digest.
With no candidates the function returns `unavailable` without calling a model.

The prompt asks for a single JSON object naming one candidate token. Parsing is
defensive: non-JSON, an unknown token, or any throw all become
`{ scope: null, via: 'unavailable' }`. Scope inference never creates a scope, and
a failure never fails the store; the memory lands at the project root instead.
Inference is skipped when `ENGRAM_SCOPE_INFERENCE=0` or when no gateway is
configured, both checked at call time.

## Promotion

A synthetic scope with at least `PROMOTE_MIN_MEMORIES` (8) memories can be
condensed into one pattern memory in its parent path.

Dedupe happens before any model call: a scope is skipped when the parent already
holds a pattern with origin `promotion` whose tags carry the scope token and
which has not itself been superseded. Requiring the origin matters, because a
user-authored pattern that happens to carry the token would otherwise block that
scope forever.

The pattern is a distillation of the scope's most important memories, produced by
the model. Without a working model, promotion writes nothing and reports the
scope with reason `no_llm`. The earlier deterministic fallback concatenated the
three highest-importance snippets, which is not a summary, and the result is
read by every agent through the parent digest; it is available only when
explicitly requested with `ENGRAM_PROMOTE_EXTRACTIVE=1`, for tests and
operations.

A promoted pattern is written into the parent path as `type: 'pattern'`,
importance 0.7, tagged with the scope token, content prefixed `[<scope>] `.
Each source memory is linked to it with `memory_links.link_type =
'promoted_from'`, and the parent digest is refreshed once anything was promoted.

## Recursive consolidation

`src/maintenance/consolidate.ts` walks a subtree post-order, refreshing each
node's digest so parents condense children that were just recomputed. It is
enqueued as a `navtree:` job at daemon startup, one per forest root, which is how
existing memories get a primed tree without anyone running a command.

## Job wiring

- `end_session` enqueues `nav:<namespace>` and its nearest existing ancestor, and
  one `promote:<namespace>` job. Coalescing comes from the partial unique index
  on `(job_type, target_key)`; migration 011 rebuilt the `job_type` CHECK to admit
  `promote`, and recreating that index was part of the rebuild, since losing it
  would break enqueue idempotency.
- startup enqueues `navtree:<root>` per forest root for bottom-up consolidation.
- the `promote:` executor may write canonical memories. It is the only job type
  that does; `nav:` and `navtree:` write digests only.

## Behaviour locked by tests

- `tests/scope-inference.test.ts` — a mention beats inference, an invented token
  is ignored, failure or no gateway falls through to the root, the kill switch
  skips the call, a valid inference lands in the existing scope.
- `tests/promote.test.ts` — threshold and skip reasons, dedupe on a second run,
  the shape of the promoted memory and its links, digest refresh after promotion,
  no pattern written when the model is unavailable, the explicit opt-in still
  working, and post-order consolidation on a three-level fixture.
- `tests/maintenance.test.ts` — job admission for `promote` and the unique index.
