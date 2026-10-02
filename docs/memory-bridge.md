# Governed memory bridge: explicit library ports

This slice is an explicitly invoked, runtime-neutral bridge library. It is not a
memory store, daemon integration, scheduler, approving tool, or export command.
Importing it, constructing a coordinator, and opening a store do not send anything.
There are no live issuers, clients, hosted-service integrations, or live exports in this slice.
An agent host could be an optional future destination client; the core does not require it.

## Public API and integration boundary

The verified repository entry point is `src/bridge/index.ts` (ESM imports use
`./src/bridge/index.js` from a repository-root TypeScript module). It exports
`BridgeCoordinator`, `BridgeStore`, `defaultDenyVerifier`, the policy helpers, and
the neutral types, including `SourcePort`, `DestinationAdapter`,
`ApprovalVerifier`, `BridgeRequester`, `DestinationRef`, and `PublicationReceipt`.
There is no verified package subpath alias or production deterministic sink export.

The Engram source adapter is present at `src/bridge/adapters/engram.ts`, exported
separately through `src/bridge/adapters/index.ts`. The verified ESM imports are
`./src/bridge/adapters/engram.js` or `./src/bridge/adapters/index.js`; neither is a
package subpath alias. The named exports are `EngramSourcePort`,
`ENGRAM_SOURCE_PROVIDER` (`'engram'`), and the type `EngramSourceOptions`.

Its constructor is `new EngramSourcePort(alreadyOpenSourceDb, { caller, now? })`.
`caller` is a trusted host-supplied `CallerScope`, not a bridge request argument or
ambient caller. Named callers require their original **and current active**
principal grants to cover both `read` and `share`; visible rows must explicitly
have `shareable = 1`. These are source eligibility checks, not approval.
`source.requester.principalId` is `engram:principal:${JSON.stringify(caller.principalId)}`
for a named principal. An explicitly supplied local-owner scope (`localOwner: true`,
`principalId: null`) maps to `engram:local-owner`; display names never define identity.
The coordinator requester must match that adapter-bound requester.

A locator is `{ provider: 'engram', namespace, sourceId: concreteMemoryId }`.
`resolveCurrent` selects that exact authorized ID and namespace, **not** a state
key or chain head. It refuses retired/superseded IDs rather than following a
successor. `readExact` also requires the opaque content-addressed revision from
an available snapshot and refuses a changed represented projection. Capture
time is not part of that revision; it is not a monotonic event counter. The
current source revision format is `engram-memory/v1:<sha256>`; represented evidence
uses `engram-episode/v1:<sha256>`. The source projection covers curated text/tags,
selected lifecycle/type/state/ownership metadata and represented evidence, not
access counts, embeddings, pin/importance or unrelated history. Restoring the
identical projection restores its revision. The read-only adapter selects visible
same-namespace evidence with bounded excerpts and inert URI metadata, without
canonical read stamps, credential lookup or URI I/O. Linked excerpt endpoints must
be stored as SQLite integers or NULL, ordered and within the content bounds before
projection. Invalid links are omitted; legitimate NULL, empty and end-boundary
spans remain supported. Offsets and the 512-character cap use SQLite characters,
not UTF-16 units, bytes or grapheme clusters.

The envelope schema is independently versioned as `bridge.payload/v1`. A proposal's
host-selected `policyId` and `policyVersion` are exact approval-bound payload fields,
not the source projection version or a built-in policy evaluator.

### Host-bound Engram constructor example

This example uses the actual adapter export and accepts already migrated/open
source and bridge databases (which may be the same connection). Source
construction and proposal do not authenticate a caller, approve export or send
anything. The host remains responsible for its trusted caller and authority.

```ts
import type Database from 'better-sqlite3'
import { BridgeCoordinator, BridgeStore } from './src/bridge/index.js'
import type { ApprovalVerifier, BridgeRuntime, SourceLocator } from './src/bridge/index.js'
import { EngramSourcePort, ENGRAM_SOURCE_PROVIDER } from './src/bridge/adapters/index.js'
import type { CallerScope } from './src/memory/access.js'

export function createEngramBridge(host: {
  sourceDb: Database.Database
  bridgeDb: Database.Database
  trustedCallerScope: CallerScope
  runtime: BridgeRuntime
  verifier: ApprovalVerifier
  namespace: string
  concreteMemoryId: string
}) {
  const source = new EngramSourcePort(host.sourceDb, {
    caller: host.trustedCallerScope, now: host.runtime.now,
  })
  const store = new BridgeStore(host.bridgeDb, host.runtime)
  const coordinator = new BridgeCoordinator({
    store, source, requester: source.requester, verifier: host.verifier,
  })
  const sourceLocator: SourceLocator = {
    provider: ENGRAM_SOURCE_PROVIDER,
    namespace: host.namespace, sourceId: host.concreteMemoryId,
  }
  return { source, store, coordinator, sourceLocator }
}
```

`tests/bridge-e2e.test.ts` now proves the actual local synthetic Engram source →
coordinator → inert sink → bound reader → exact cleanup path. It does not prove
live authorization or a real remote destination's durability. Parent acceptance
of the final combined corrective dependencies remains a separate gate.

### Neutral, explicit host API example

This repository-local example takes already configured ports and a host-supplied
approval workflow as dependencies. It installs nothing and performs no discovery.
The host must supply an initialized bridge database (migration 026), a trusted
requester binding, an authorized source port, a destination, and an independently
trusted verifier. There is intentionally no production issuer implementation here.

```ts
import type Database from 'better-sqlite3'
import { BridgeCoordinator, BridgeStore } from './src/bridge/index.js'
import type {
  ApprovalVerifier, BridgeEnvelope, BridgeRequester, BridgeRuntime,
  DestinationAdapter, PublishProposal, SourcePort,
} from './src/bridge/index.js'

interface HostPorts {
  db: Database.Database
  runtime: BridgeRuntime
  requester: BridgeRequester
  source: SourcePort
  verifier: ApprovalVerifier
  destination: DestinationAdapter
  requestApproval: (exactEnvelope: BridgeEnvelope) => Promise<string>
}

export async function publishReadAndCleanUp(host: HostPorts, input: PublishProposal) {
  const store = new BridgeStore(host.db, host.runtime)
  const coordinator = new BridgeCoordinator({
    store, requester: host.requester, source: host.source, verifier: host.verifier,
  })
  const envelope = await coordinator.proposePublish(input)
  await coordinator.approve(envelope.envelopeId, await host.requestApproval(envelope))
  coordinator.enqueue(envelope.envelopeId)
  await coordinator.drain(host.destination, { owner: 'explicit-host-worker' })
  const visibility = await coordinator.verifyVisibility(envelope.envelopeId, host.destination)
  if (visibility.status !== 'visible') {
    return { envelope, visibility, cleanup: null }
  }

  // cleanup is a separately approved operation targeting the exact remote receipt.
  const retraction = coordinator.proposeRetraction({
    targetEnvelopeId: envelope.envelopeId, reason: 'host-requested cleanup',
    purpose: input.purpose, policyId: input.policyId, policyVersion: input.policyVersion,
  })
  await coordinator.approve(retraction.envelopeId, await host.requestApproval(retraction))
  coordinator.enqueue(retraction.envelopeId)
  await coordinator.drain(host.destination, { owner: 'explicit-host-worker' })
  const absence = await coordinator.verifyRetraction(retraction.envelopeId, host.destination)
  return { envelope, visibility, cleanup: { retraction, absence } }
}
```

`drain` may return queued, uncertain, rejected, or other nonacknowledged outcomes;
`verifyVisibility`/`verifyRetraction` reject when there is no eligible acknowledged
publication. A host must inspect persisted outbox state and drain results, handle
those cases, and never interpret a returned envelope as delivery success. This
example's successful branch is not a retry loop or authorization UI.

## Trust boundaries: deny by default

- **Requester/source:** `BridgeRequester.principalId` comes from trusted host
  context, not a tool argument, display name, or ambient local-owner assumption.
  A `SourcePort` binds that requester at construction and must enforce both read
  and share/export eligibility, exact namespace/resource access, and row visibility
  before returning content or deliberately selected provenance. Engram-specific
  principal/grant/row checks belong in its adapter, not in the neutral core.
- **Approval:** without an injected `ApprovalVerifier`, approval is default-deny.
  `shareable`, pinned status, requester identity, a human-looking name, and a
  caller-supplied success flag confer no export authority. The verifier must bind
  an independently authorized grant to the exact operation, payload hash,
  destination scope, intended reader, requester, purpose, and policy. An opaque
  approval grant is not a reusable client token or a destination credential.
  This slice contains only explicitly inert test authorities, not a live issuer.
- **Destination/reader:** a destination adapter is a trusted observation boundary.
  The coordinator cannot independently authenticate an arbitrary dishonest adapter.
  Visibility is an actual adapter read under the intended reader binding, matching
  the exact publication ID, version, payload hash, adapter ID, scope, and reader.
  No scope normalization, silent retargeting, or manual success proof is allowed.
- **Persistence:** low-level store operations are trusted library internals, not
  publicly exposed approval tools. Immutable persisted payload bytes are the
  outbound record; a mutable source is not used to reconstruct approved content.
  Evidence is selected metadata/excerpts, not authority to fetch a file or URI.

## Acknowledgement is not visibility; deletion is not observed absence

A publication can be accepted remotely while its reply is pending, or acknowledged
while the bound reader still observes empty. `forbidden`, `degraded`, and
`unsupported` are not empty reads. Only an exact successful reader observation can
promote an acknowledged publication to `visible`.

Likewise, an acknowledged retraction is not `retracted_verified`. The adapter must
read the exact target for the bound reader and attest absence after remote cleanup.
An empty delayed publication before retraction is not cleanup evidence. A local
flag, missing source row, or deleted local outbox record cannot establish remote
absence. Later failed observations invalidate an earlier success projection rather
than preserving it as a current guarantee.

## Revision-bound cleanup and audit

Retraction targets the prior acknowledged publication ID **and version and hash**
in its exact destination/reader scope. It does not select the newest source row or
newest remote publication. A newer publication of the same source must survive
cleanup of the older one. A correction requires a new proposal, exact approval,
and explicit `supersedesEnvelopeId`; it does not rewrite approved bytes.

Source retirement/deletion need not prevent separately authorized cleanup of an
already acknowledged publication. The persisted source revision, envelope, grant
and lifecycle audit remain available; bridge cleanup does not mutate the canonical
source or delete its audit history.

### Explicit inactive-proposal cancellation

`coordinator.cancelProposal(envelopeId): void` is a synchronous, requester-owned,
explicit local operation. It accepts a proposal with no outbox row, or an outbox
row in `cancelled`, `rejected` or `dead`, only if there is no `delivery_started`
event. Queued, sending, acknowledged, visible, uncertain and attempted work cannot
be cancelled this way, even if an attempted row later becomes terminal.

Cancellation appends one immutable `proposal_cancelled` event; repeated calls are
idempotent. It preserves the envelope, approval and any existing outbox row, and
blocks later approval/enqueue, including approval already awaiting its verifier.
It requires no new approval and invokes no source, verifier or destination I/O;
only the local store transaction runs. It neither proves remote absence nor
retracts delivered content, creates queue work or activates a background worker.

For unusable never-enqueued cleanup proposals (for example, an expired or revoked
immutable grant), explicit cancellation releases exact-target duplicate protection.
The host must make a new retraction proposal and obtain a fresh grant bound to its
new bytes/hash; cancellation does not renew or reuse the old grant. Without the
explicit marker, merely reaching a terminal outbox state does not release that
protection. Attempted cleanup still requires reconciliation, not cancellation.

### Ordinary-DML history guards and deployment limits

Migration 026 guards `bridge_envelopes`, `bridge_approvals`,
`bridge_approval_events` and `bridge_events` against UPDATE/DELETE and conflicting
INSERT, `REPLACE`/`INSERT OR REPLACE`, UPSERT, and conflict-ignore forms. Guards
cover declared unique identities and hidden rowid identities, including `oid` and
`_rowid_`, with `recursive_triggers` both off and on. Ordinary nonconflicting
appends and fenced mutable outbox updates remain possible. SQLite's before-insert
`-1` automatic-allocation sentinel is not treated as a collision; an after-insert
guard reserves stored rowid/sequence `-1` and aborts the statement, including an
artificial preexisting `-1` replacement. Omitted/NULL allocation and otherwise
nonconflicting positive, zero and negative identities remain supported.

The 182-test immutable-history suite proves these ordinary-DML guards, statement
rollback, retained source/history bytes, repeated migration `up` and local API
idempotency on synthetic databases. It is not tamper-proof storage: a trusted
administrator with DDL or file access can remove triggers or alter the database.
These guards are in the migration-026 source, not a deployed upgrade. The runner
does not replay an already-recorded migration 026; upgrading an existing database
that applied an older definition requires a separately designed and authorized
upgrade. No existing/live database has been inspected or upgraded here.

## Delivery guarantees and remaining acceptance gates

Delivery is at-least-once attempted, not distributed atomicity, exactly-once, or a
guarantee of eventual visibility. Stable operation/envelope/hash-bound idempotency
keys allow an idempotent destination to return the same exact receipt after remote
acceptance and loss of local completion. Retry attempts and leases are bounded;
a non-idempotent uncertain delivery needs reconciliation, not blind resend. Lease
generation/token fences prevent a stale worker from appending a completion after
another worker takes over, but cannot undo an accepted remote side effect.

Inclusive expiry and revocation are checked around asynchronous calls. Source or
authority changes during a remote call preserve the exact attempted revision and
record uncertainty; they do not prove rollback or invisibility. There is always a
residual cross-system race after a final preflight check.

**The preventable pre-send window in `d8aa9d4` is closed in candidate `a85521b`:**
the core rechecks the exact source after the asynchronous authority wait, then
checks synchronous local expiry/revocation/lease/binding/integrity before I/O.
The retained `tests/bridge-conformance-source-window.test.ts` falsifier passes,
and the new actual-Engram E2E cases change source content or revoke its share
grant during the verifier wait and observe **zero destination calls**. This is
bounded local evidence, not independent final review or distributed atomicity.

The combined local core also rechecks the exact source after the post-send
authority wait, retains any earlier invalid observation, and synchronously fences
lease ownership, persisted integrity, port/requester binding and local approval
before classifying completion. Source/authority drift after a remote side effect
requires reconciliation; a matching actual receipt is retained, not promoted to
acknowledged/visible proof. Remote authority can still change during the final
source wait: the tests explicitly retain that cross-system race rather than claim
distributed atomicity.

For a trusted-admin integrity fault after delivery start,
`BridgeStore.completeUncertainDelivery` is a specialized evidence path, not a
success or repair API. It requires a valid exact attempted envelope, a matching
delivery-start attempt/generation, a current fenced lease and, if present, an
exact matching receipt. It records verified attempted bytes/hash and only
`reconciliation_required`, even when the persisted envelope cannot pass integrity
checks. It does not repair that row or establish delivery, visibility or absence;
a stale lease cannot append this evidence. Synthetic fault tests remove a trigger
to model trusted-admin corruption, not a normal coordinator capability or a
promise to survive arbitrary database/DDL destruction.

The preflight, postflight/cancellation and immutable-history desired tests pass
on this combined tree, so those core corrections are not pending dependencies.
The source-span correction and meaning-preserving comment cleanup are also
integrated. The complete local test suite, production typecheck/build and scoped
eval typecheck passed on measured source commit
`4dd68eec13cdd346facfab3344e3bfb5e9eab3a4`. Final whole-tree review and local
integration acceptance are separate gates. Local synthetic proof is not live
visibility, destination durability or authorization.

## Local synthetic integration and inert conformance instrument

`tests/bridge-e2e.test.ts` constructs actual migrated synthetic Engram rows and
`new EngramSourcePort(db, { caller: trustedCallerScope, now })`, then invokes only
public coordinator proposal/approval/enqueue/drain/observation APIs with the
existing known inert authority and stateful `DeterministicDestination`. The
complete-path driver reads actual exact approved bytes, revision, version, hash,
scope and reader binding before verifying visibility, then observes empty reader
state plus an exact sink tombstone before verifying cleanup. It never installs a
fake source or writes success projections.

Additional integrated cases prove default denial despite source shareability,
wrong-grant/scope/reader denial, foreign personal/namespace refusal, hidden
provenance exclusion, unchanged **entire source database serialization** across
reads/refusals and bridge operations with separate source/bridge databases,
source correction with fresh approval/publication, and old-version cleanup that
preserves newer local and remote content. Personal rows owned by the caller can
still be source-eligible; the refusal is for a foreign owner's personal rows.
A colocated migrated database case deletes the source row without cascading any
bridge proposal, approval, receipt or audit, then completes separately approved
cleanup. Both publish and retract completion-loss cases close/reopen the real
synthetic source and bridge SQLite databases, reconstruct the source/coordinator,
and explicitly replay identical approved bytes and keys into retained sink state.

`tests/bridge-conformance.test.ts` contains the executable local example
“drives complete real coordinator/store → deterministic sink → bound reader →
exact cleanup”. It invokes `exerciseDestinationConformance` from
`tests/fixtures/bridge-destination.ts` with the real core, an inert source, a known
inert authority, and a supplied adapter. The reusable helper accepts scripts at
acknowledgement/observation boundaries; it never writes gold success states or
calls low-level delivery completion to create proof.

`DeterministicDestination` stores exact immutable envelopes and idempotency
receipts. Its accepted records, reader projection, and target-bound tombstones are
separate actual sink state. `bindReader` represents trusted host reader binding;
it is test instrumentation, not an authentication service. Reader reads return
only content in the exact configured adapter/scope/principal. Delivery scripts
can delay projection, acknowledge/pending independently, or suspend after
acceptance. Retraction deletes only the exact matching publication, leaving newer
versions untouched. Verified absence requires a tombstone **and an actual empty
reader read**. Fault decorators intentionally corrupt real receipts/read proofs
for negative tests; they do not create coordinator success.

The tests simulate acceptance followed by loss of local completion and closing/
reopening a temporary synthetic SQLite database, then explicitly drain again with
the same sink state/key/bytes. This is a deterministic completion-loss/crash
instrument, not a process-kill test, durable remote-service test, live proof, or
live Engram export. The new E2E suite uses the real local Engram adapter over
synthetic rows, but retains the inert remote sink in memory across reopen. It
therefore establishes local database recovery and protocol replay, not remote
service durability, process-kill recovery, live cloud authentication or live
publication. Fixtures are not production exports and activate nothing.

Hermetic validation uses existing dependencies, Node 24.19.0 / ABI 137, an empty
environment with an explicit PATH, and fresh short HOME/TMPDIR. No credentials,
models, network, daemon, installation, configuration changes, publication, or CLI
export/approval surface are needed. The retained source-window falsifier remains
in the gate and is green on this candidate.

### Measured local validation

The parent gate ran on clean source commit
`4dd68eec13cdd346facfab3344e3bfb5e9eab3a4` with Node 24.19.0 / ABI 137,
an empty environment, explicit compatible PATH and fresh short HOME/TMPDIR.
The full suite passed **2,001 tests with 3 skipped**, across **135 passed files
and 1 skipped file**. Production typecheck, an emitted build in a temporary
directory, scoped eval typecheck, whitespace, clean-tree and final-SHA checks
also passed. This is local synthetic/product regression evidence, not a live
export or model-utility measurement.

| Bridge scope included in the passing suite | Tests |
| --- | ---: |
| Real local Engram-source end-to-end path | 21 |
| Source adapter and coordinator | 81 |
| Linked excerpt span validation | 54 |
| Inert destination, conformance and retained source-window falsifier | 62 |
| Preflight correction | 16 |
| Cancellation and postflight correction | 40 |
| Immutable-history DML guards | 182 |
| Original neutral policy/outbox/lifecycle | 103 |
| Total bridge tests | 559 |

The historical six-file scope of 117 tests included 103 original bridge tests,
4 principals-migration tests, 8 migration-runner tests and 2 comment-style tests;
it was never 117 bridge-only tests. The current comment-style gate passes without
rule changes. All comments and JSDoc information were retained; comment-only
changes preserved noncomment syntax, assertions and fixture strings.

Earlier candidate gates were honestly red for the stale-source window, malformed
spans and copied-comment style. Corrective tests retain those desired assertions
and pass in the combined suite. Blocked supplemental diagnostics were abandoned,
not reformulated or retried. Production/eval typechecks cover their existing
configured source sets; they are not a claim that every test file is typechecked.
Final combined review and local integration remain required before acceptance.
