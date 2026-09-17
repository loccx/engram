# Scoped writes and navigation digests

How memories get routed into a namespace scope, and how the digest layer above
them is kept current.

The tree itself, funnel retrieval, and the `namespace_nodes` schema are described
in `hierarchical-memory-p1.md`. Scope inference over existing scopes and the
promotion/consolidation pipeline are in `hierarchical-memory-p3.md`.

## store_memory scope targeting

`store_memory` takes an optional `scope` argument naming a synthetic suffix, and
stores into `<project>//<scope>`. The scope must be a single path segment: empty
strings, anything containing `/`, and names longer than 64 characters are
rejected by schema validation rather than by a thrown exception, so the caller
gets a normal tool error.

The synthetic node is materialised on demand by `ensureNode`, which means the
tree, the child roster, and `scope_trace` work for scopes with no extra
bookkeeping.

## Routing

When `scope` is absent the namespace is chosen in this order:

1. an existing sibling scope whose token appears in the content on a word
   boundary (`payment` does not match the scope `payments`). The most-used
   candidate wins. This step is deterministic and needs no model.
2. inference over existing scopes when a gateway is configured — see
   `hierarchical-memory-p3.md`. A token that is not already a candidate is
   ignored; routing never mints a scope.
3. the project root.

The store response reports the effective `namespace`, plus `routed_scope` (the
token, omitted at the root) and `routed_via`
(`explicit` | `mention` | `inferred` | `root`) when routing fired. Routing never
fails a store: if the model is unreachable or disabled, the memory lands at the
project root.

## Navigation digest jobs

`end_session` enqueues a `digest` job with target key `nav:<namespace>` for the
session's namespace, and one for its nearest existing ancestor when there is one.
Idempotency comes from the partial unique index on `(job_type, target_key)`, so
repeated sessions coalesce onto the same job instead of queueing duplicates.

The executor dispatches a `nav:` target to `refreshNavDigest`. A namespace with
no node row completes as a no-op rather than failing, which matters because a
session can end in a namespace the tree has not seen yet.

Digests are built from pinned digests, cluster summaries, and child digests. When
a gateway is configured the sources are distilled by the model; otherwise the
extractive path is used instead. These jobs write only `namespace_nodes.digest`
— they do not touch memories.

## Behaviour locked by tests

- `tests/store-scope.test.ts` — explicit scope storage, validation rejections,
  word-boundary matching that does not fire on partial tokens, funnel visibility
  from the scope and isolation from siblings.
- `tests/nav-maintenance.test.ts` — end-session enqueue for namespace and parent,
  digest refresh from fixtures, no-op for an unknown namespace, no regression in
  project-digest jobs.
- `tests/nav.test.ts` — digest composition from pinned, cluster, and child
  sources.
