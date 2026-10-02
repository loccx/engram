# Typed representations of canonical memory

Assertions are optional sidecars on existing memory revisions. They do not replace canonical prose, ownership, validity, supersession or evidence, and schema validation does not establish truth or authority.

Trusted local-owner host code, outside tool requests, can register immutable `name@version` schemas, attach a representation, and change its schema representation through compare-and-swap. Changing the subject, predicate or value requires a new canonical revision. Definitions use a bounded, closed JSON-schema subset without references, executable validators, coercion or defaults.

The agent surface is read-only: `query_assertions` intersects an exact namespace with authenticated read grants and canonical row visibility. Subject, predicate, schema and whole JSON value filters are exact; object key order does not affect value equality. Results default to 20 and are capped at 100.

`observed_at` comes from the canonical revision's creation time. `observed_before` is an independent inclusive observation cutoff. `valid_at` aliases canonical `as_of`; conflicting clocks are rejected. Historical queries explicitly report current-only schema representations and current-visible evidence links, rather than implying a complete historical evidence snapshot.

Canonical deletion cascades sidecars, and an in-place content change invalidates the old representation. Source removal purges linked claims and their typed representations together. Schema definitions survive forgetting and must contain reusable type definitions, not private claim data.
