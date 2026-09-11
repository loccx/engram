# Engram Brains — Feature Spec

**Status:** Draft · **Owner:** locc · **Target:** v0.2.0

## 1. Goal

Let one engram user (a "brain owner") publish a curated subset of their memories such that other users — and crucially, their AI coding agents — can semantically query that knowledge as additional context.

The motivating use case: a senior engineer or staff EM accumulates years of decisions, mental models, and gotchas in their personal engram. Teammates' Claude Code / Cursor sessions can then `search_brain(brain="alice", query="why did we pick postgres over mysql for the billing service")` and get the actual answer Alice would have given, drawn from her real memories.

## 2. Non-goals

- **Live federation.** No always-on remote daemon. Snapshots only.
- **Real-time sync.** Snapshots are pulled on demand, not pushed.
- **Custom crypto.** All encryption is `age` underneath; engram only wraps it.
- **Server infrastructure.** Distribution is via git remotes (GitHub, Gitea, self-hosted, even local). Engram does not run any service.
- **Cross-org discovery / registry.** Brains are addressed by git URL, not by name lookup.
- **Retroactive revocation.** Once someone has decrypted a snapshot, they have that snapshot. Revocation applies to **future** snapshots only. This is a property of cryptography, not a bug.

## 3. Mental model

- A **brain** is a portable, encrypted, version-controlled snapshot of one namespace's memories.
- An **engram key** is an `age` keypair branded for engram. Public keys are shareable identifiers; private keys never leave the owner's machine.
- A **whitelist** (`recipients.txt`) is the brain owner's list of `engram_pub_...` keys allowed to decrypt the next snapshot.
- A **publish** is: filter memories → export to SQLite → encrypt to whitelist → git commit + push.
- A **follow** is: git clone → register locally. A **refresh** is: git pull → decrypt → cache.

The trust model reduces to: *possession of the encrypted file is insufficient; the recipient's private key is required.* The owner controls the whitelist; the math controls the access.

## 4. Architecture overview

```
                       ┌──────────────────────────────────────────┐
                       │             Alice's machine              │
                       │                                          │
   ┌────────────┐      │   ┌──────────────┐   ┌──────────────┐   │
   │ engram.db  │──┐   │   │ recipients   │   │ ~/.engram/   │   │
   │ (master)   │  │   │   │ .txt         │   │ identity     │   │
   └────────────┘  │   │   └──────────────┘   └──────────────┘   │
                   ▼   │           │                  │           │
              ┌─────────────────┐  │                  │           │
              │ brain publish:  │◀─┘                  │           │
              │  1. SELECT WHERE│                     │           │
              │     shareable=1 │                     │           │
              │  2. age encrypt │◀────────────────────┘           │
              │  3. git push    │                                 │
              └────────┬────────┘                                 │
                       │                                          │
                       ▼                                          │
            ┌──────────────────────┐                              │
            │ github.com/alice/    │                              │
            │   eng-brain          │                              │
            │  snapshot.brain.age  │                              │
            │  recipients.txt      │                              │
            │  manifest.json       │                              │
            └──────────┬───────────┘                              │
                       │                                          │
                       ▼                                          │
                       │   ┌──────────────┐                       │
                       │   │  Bob's       │                       │
                       │   │  machine     │                       │
                       │   │              │                       │
                       │   │  age decrypt │                       │
                       │   │  ATTACH DB   │                       │
                       │   │  search_brain│                       │
                       │   └──────────────┘                       │
                       └──────────────────────────────────────────┘
```

## 5. Filesystem layout

### Per-user state (new, lives outside `engram.db`)

```
~/.engram/
  identity                      # age private key, branded engram_priv_...
  config.json                   # { defaultBrain: "my-eng-brain", identityPath: "..." }
  audit.log                     # append-only log of mark_shareable + publish events
  brains/
    my-eng-brain/               # a brain I publish
      .git/
      recipients.txt            # the whitelist
      manifest.json             # owner, embedding_model, schema_version
      snapshot.brain.age        # encrypted SQLite (committed)
    alice/                      # a brain I follow
      .git/
      recipients.txt            # what Alice published
      manifest.json
      snapshot.brain.age        # encrypted (committed)
      .cache/
        decrypted.brain         # local plaintext cache (gitignored)
        decrypted.sha256        # so we know when to re-decrypt
```

### `manifest.json` format

```json
{
  "owner_name": "alice",
  "owner_pubkey": "engram_pub_k1qfz8m4n2j9...",
  "embedding_model": "Xenova/bge-small-en-v1.5",
  "schema_version": 6,
  "engram_version": "0.2.0",
  "published_at": "2026-06-18T14:32:11Z",
  "memory_count": 1432,
  "description": "Alice's eng brain — distributed systems, postgres, on-call"
}
```

### `recipients.txt` format

```
# whitelist for my-eng-brain
# format: <name> <engram_pub_key>   # comment

alice  engram_pub_k1qfz8m4n2j9...   # owner (self, always included)
bob    engram_pub_k1xyz3q7r8w2...   # granted 2026-04-12
carol  engram_pub_k1mno5t8v9w3...   # granted 2026-04-15
# david engram_pub_k1abc...         # revoked 2026-05-01 — kept for audit
```

Comments survive `engram brain grant/revoke`. Audit history is preserved in `git log` of this file.

## 6. Database changes

### Migration `006_brain_support.ts`

```sql
-- mark which memories may be exported
ALTER TABLE memories ADD COLUMN shareable INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_memories_shareable ON memories(namespace, shareable) WHERE shareable = 1;

-- track followed brains
CREATE TABLE brain_subscriptions (
  brain_name TEXT PRIMARY KEY,
  git_remote TEXT NOT NULL,
  owner_name TEXT,
  owner_pubkey TEXT,
  last_refreshed_at INTEGER,
  last_commit_sha TEXT,
  memory_count INTEGER DEFAULT 0,
  description TEXT,
  added_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- track owned brains (a user can publish multiple)
CREATE TABLE owned_brains (
  brain_name TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,            -- which namespace this brain exports
  git_remote TEXT,                    -- optional; can publish to local file only
  brain_dir TEXT NOT NULL,            -- ~/.engram/brains/<name>/
  description TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_published_at INTEGER
);
```

**Migration is idempotent.** Uses `columnExists`/`tableExists` helpers per the existing migration contract.

## 7. New module layout

```
src/
  brains/                         # NEW top-level module
    identity.ts                   # generate/load/format engram keys (wraps age)
    keyformat.ts                  # engram_pub_... <-> age1... conversions
    publish.ts                    # filter memories → export → encrypt → git push
    follow.ts                     # git clone → register subscription
    refresh.ts                    # git pull → decrypt → cache
    snapshot.ts                   # SQLite export/import (uses ATTACH)
    whitelist.ts                  # recipients.txt parsing + grant/revoke
    audit.ts                      # ~/.engram/audit.log writer + reader
    types.ts                      # Brain, Recipient, Manifest, Snapshot interfaces
    paths.ts                      # ~/.engram/* resolution (XDG-respecting on Linux)
  mcp/
    handlers/
      list_brains.ts              # NEW MCP tool handler
      search_brain.ts             # NEW
      get_brain_memory.ts         # NEW
      mark_shareable.ts           # NEW
  cli/
    brain.ts                      # NEW: `engram brain <subcommand>` group
```

**Why a top-level `brains/` module:** the feature touches identity, crypto, filesystem layout, git, snapshot format, and access control — none of which belong inside `memory/` or `mcp/`. Clean separation makes it removable/skippable for users who don't want the feature.

## 8. CLI surface

### Identity (one-time per machine)

```bash
engram init                          # creates ~/.engram/identity, prints pubkey
engram whoami                        # prints your engram_pub_...
engram identity export               # dumps identity (for backup; warns loudly)
engram identity import <path>        # restores from backup
```

### Publishing your own brain

```bash
engram brain init <name> \
  [--namespace <ns>] \
  [--remote <git-url>] \
  [--description "..."]               # creates ~/.engram/brains/<name>/

engram brain grant <brain> <name> <engram_pub_...>
engram brain revoke <brain> <name>
engram brain whitelist <brain>        # show current recipients

engram brain publish <brain>          # DRY RUN by default
engram brain publish <brain> --confirm  # actually push

engram brain unpublish <brain>        # remove from git remote (rare)
```

### Following others' brains

```bash
engram brain follow <git-url> [--as <name>] [--identity <path>]
engram brain refresh [<name> | --all]
engram brain unfollow <name>
engram brain list                     # all brains (owned + followed)
```

### Marking memories

```bash
engram mark <memory-id> --shareable      # opt-in flag
engram mark <memory-id> --unshareable
engram audit                              # show mark_shareable + publish events
```

### Dry-run is the default for `publish`

```
$ engram brain publish my-eng-brain
DRY RUN — no commit, no push. Use --confirm to publish.

Brain:        my-eng-brain
Namespace:    /Users/locc/git/research
Recipients:   3 (alice, bob, carol)
Embedding:    Xenova/bge-small-en-v1.5
Memories:     1432 shareable (of 8201 total in namespace)

About to publish:
  + 47 new memories since last publish
  ~ 12 updated memories
  - 3 removed memories (unshareable since last publish)

  Sample new:
    - "postgres connection pooling lesson from 2025-Q3 incident"
    - "why we switched away from RDS proxy"
    - ...

Run with --confirm to encrypt + commit + push.
```

## 9. MCP tool additions

All four tools follow the existing handler contract (`{ tool_name }` → handler in `src/mcp/handlers/`).

### `list_brains`

```ts
input:  {}
output: {
  brains: Array<{
    name: string
    owner: string
    description: string | null
    memory_count: number
    last_refreshed_at: string | null
    embedding_model: string
    is_owned: boolean        // true if user is the owner
  }>
}
```

### `search_brain`

```ts
input: {
  brain: string              // required — explicit-only access
  query: string
  limit?: number             // default 10
  filters?: { tags?: string[], since?: string }
}
output: {
  results: Array<{
    id: string
    text: string
    score: number
    source: { brain: string, owner: string }
    created_at: string
    tags: string[]
  }>
  warnings?: string[]        // e.g. "FTS5-only: embedding model mismatch"
}
```

Routes through the existing hybrid search engine but `ATTACH`es the followed brain's decrypted SQLite as an aux database and queries against it.

### `get_brain_memory`

```ts
input:  { brain: string, id: string }
output: { memory: FullMemory & { source: { brain, owner } } }
```

### `mark_shareable`

```ts
input:  { id: string, shareable: boolean }
output: { id: string, shareable: boolean, audited: true }
```

Writes an `audit.log` entry. Agent-callable so a user can say "remember this and share it with the team brain" and the agent does it correctly.

### Existing tools — no breaking changes

`search_memories`, `get_memory`, etc. **only ever search the local user's namespace.** Cross-brain access is exclusively through `search_brain` / `get_brain_memory`. This is deliberate (decision #4).

## 10. Crypto details

### Library

- **`age-encryption` npm package** ([npm](https://www.npmjs.com/package/age-encryption)) — pure JS, ~30KB, MIT licensed, by the `age` author.
- Standard `age` format on disk. A power user with the `age` CLI installed can decrypt any `snapshot.brain.age` directly without engram: `age -d -i ~/.engram/identity snapshot.brain.age > snapshot.brain`. This is **deliberate** — anti-lockin.

### Key format

| Layer | Format |
|---|---|
| Underlying | X25519 keypair, exactly as `age` generates |
| `engram_pub_` encoding | `engram_pub_` + bech32 of the raw 32-byte public key |
| `engram_priv_` encoding | `engram_priv_` + bech32 of the raw 32-byte private key |
| File format | `~/.engram/identity` is a UTF-8 file: a single line `engram_priv_...` |
| Conversion to `age` | Trivial: strip prefix, bech32-decode, re-encode in age's bech32 alphabet |

Wrapping `age` keys in our own bech32 prefix means:
- Users see consistent branding (`engram_pub_...` everywhere).
- The escape hatch still works (we provide `engram identity export --age-format` for power users).
- We never see raw `age1...` strings in our UX.

### Encryption

```ts
// publish.ts pseudocode
const recipients = parseRecipientsTxt('recipients.txt')
  .map(r => engramPubToAge(r.pubkey))
  .map(age.Recipient.fromString)

const ciphertext = await age.encrypt({
  recipients,
  plaintext: fs.readFileSync('snapshot.brain'),
})

fs.writeFileSync('snapshot.brain.age', ciphertext)
```

```ts
// refresh.ts pseudocode
const identity = age.Identity.fromString(loadEngramPriv())
const plaintext = await age.decrypt({
  identities: [identity],
  ciphertext: fs.readFileSync('snapshot.brain.age'),
})
fs.writeFileSync('.cache/decrypted.brain', plaintext)
```

If decryption fails: we print "your engram key is not on this brain's whitelist." That's the only auth check we need.

## 11. Snapshot format

A `.brain` file is **a SQLite database** with engram's full schema, filtered to one namespace. We use SQLite because:
- Zero serialization cost; no schema translation on import.
- Vectors come along as `BLOB` columns.
- FTS5 indexes come along.
- Recipients can `ATTACH DATABASE` and query natively.
- Diffing across versions is doable via `sqldiff`.

### Export procedure

```sql
-- 1. Create empty target DB with engram schema (run migrations).
-- 2. For each memory table, copy rows where namespace = $BRAIN_NS AND shareable = 1
INSERT INTO target.memories
  SELECT * FROM main.memories
  WHERE namespace = ? AND shareable = 1;

-- 3. Copy dependent tables (entities, edges, clusters) filtered to
--    those memory_ids only. Cascade respects the same filter.
INSERT INTO target.memory_entities
  SELECT * FROM main.memory_entities
  WHERE memory_id IN (SELECT id FROM target.memories);

-- ... (repeat for graph_edges, cluster_members, etc.)

-- 4. Rebuild FTS5 from target (FTS5 doesn't survive INSERT cleanly).
INSERT INTO target.memories_fts(memories_fts) VALUES('rebuild');

-- 5. Write manifest row into target.brain_manifest table.
```

### Schema version gate

`manifest.json.schema_version` must match the importer's expected version, else refuse import with a clear message. Bumping engram's schema means publishers republish; old snapshots become unreadable. Acceptable cost for a young project.

### Embedding model gate (per decision #5)

`manifest.embedding_model` must equal the importer's `ENGRAM_EMBEDDING_MODEL` constant. Mismatch → import refuses with "this brain was published with model X; your engram uses model Y. Embeddings would be useless." Hard fail; no FTS5-only fallback (we'd rather force consistency in v0.2).

## 12. Git integration

We shell out to `git` (subprocess). No JS git library. Rationale: every user has `git` installed, the operations we need (`init`, `add`, `commit`, `push`, `pull`, `clone`, `log`, `rev-parse HEAD`) are dead simple, and shelling out avoids ~5MB of bundled JS git.

```ts
// brains/publish.ts (excerpt)
async function gitPushBrain(brainDir: string) {
  await exec('git', ['add', 'snapshot.brain.age', 'recipients.txt', 'manifest.json'], { cwd: brainDir })
  await exec('git', ['commit', '-m', `publish ${new Date().toISOString()}`], { cwd: brainDir })
  await exec('git', ['push'], { cwd: brainDir })
}
```

Auth to git remote is **the user's existing git setup** (SSH keys, `gh auth`, credential helper). Engram does nothing special. If `git push` works in their terminal, it works in `engram brain publish`.

## 13. Subscription refresh flow

```
$ engram brain refresh alice
[1/4] git fetch alice ............ ok (3 new commits)
[2/4] checkout HEAD .............. ok (snapshot.brain.age changed)
[3/4] age decrypt ................ ok (using engram key engram_pub_k1xyz...)
[4/4] validating manifest ........ ok (model: bge-small-en-v1.5 ✓)

alice brain refreshed:
  1432 memories (+47 since last refresh)
  published 2h ago by alice
  description: Alice's eng brain — distributed systems, postgres, on-call
```

If git HEAD hasn't moved → skip decryption, exit fast.
If decryption fails → "you've been revoked from this brain since last refresh" + leave previous cache intact.

## 14. Audit log

`~/.engram/audit.log`, append-only, one JSON event per line:

```json
{"ts": "2026-06-18T14:30:00Z", "event": "mark_shareable", "memory_id": "mem_abc123", "via": "mcp:claude-code", "text_excerpt": "postgres connection pooling..."}
{"ts": "2026-06-18T14:32:11Z", "event": "publish", "brain": "my-eng-brain", "memory_count": 1432, "commit_sha": "a1b2c3"}
{"ts": "2026-06-18T15:01:42Z", "event": "grant", "brain": "my-eng-brain", "name": "bob", "pubkey": "engram_pub_k1xyz..."}
{"ts": "2026-06-18T15:01:42Z", "event": "revoke", "brain": "my-eng-brain", "name": "carol"}
```

`engram audit` tails this with pretty formatting. Defense against prompt-injection-driven `mark_shareable` calls: the user can review what's been marked.

## 15. Test plan

### Unit tests (`tests/brains/`)

- `keyformat.test.ts`: round-trip `engram_pub_...` ↔ `age1...`, malformed input rejection
- `whitelist.test.ts`: parse `recipients.txt` (comments, blank lines, malformed lines), grant/revoke idempotency
- `snapshot.test.ts`: export filters to `shareable=1`, dependent tables cascade correctly, FTS5 rebuilds
- `publish.test.ts`: encryption produces decryptable output for each whitelisted identity; non-whitelisted identity cannot decrypt
- `refresh.test.ts`: stale-cache detection by sha256, decryption failure path, manifest validation gates (schema + embedding model)
- `audit.test.ts`: append-only behavior, JSON parse round-trip

### Integration tests

- `tests/brains/end-to-end.test.ts`: Alice publishes brain → Bob follows → Bob refreshes → Bob's `search_brain` returns Alice's memories with correct source attribution. Use two temp DBs and two temp git repos (local bare).
- Revocation: Bob refreshes successfully → Alice revokes Bob → Alice republishes → Bob's next refresh fails decryption gracefully.

### Coverage target

Match the existing standard: ≥ 90% line coverage on `src/brains/`. Adds ~30-40 tests to the suite (currently 258 → ~295).

## 16. Dependency additions

| Package | Why | Size |
|---|---|---|
| `age-encryption` | Crypto | ~30KB |
| `bech32` | Engram key encoding | ~5KB |

No other new dependencies. Git is shelled out. SQLite is already there. Hono is already there.

## 17. Sequenced implementation plan

### Phase 1a — Identity + export/import (no encryption, no git)

**Goal:** ship local file-based brain transfer. Useful by itself ("here's my brain on a USB stick").

| File | Action | Est. LOC |
|---|---|---|
| `src/brains/paths.ts` | new | 40 |
| `src/brains/identity.ts` | new (stub — just generates raw keys, no age yet) | 60 |
| `src/brains/keyformat.ts` | new (bech32 round-trip) | 50 |
| `src/brains/snapshot.ts` | new (SQLite export/import) | 150 |
| `src/db/migrations/006_brain_support.ts` | new | 60 |
| `src/cli/brain.ts` | new (commands: init, export, import) | 80 |
| `src/index.ts` | wire new CLI subcommand | 10 |
| `tests/brains/snapshot.test.ts` | new | 100 |
| `tests/brains/keyformat.test.ts` | new | 40 |

**Acceptance:** `engram brain init my-brain && engram brain export my-brain --to /tmp/me.brain && engram brain import /tmp/me.brain --as imported` round-trips memories.

### Phase 1b — Encryption + whitelist

**Goal:** ship `recipients.txt`-driven encryption. Snapshots are now encrypted blobs.

| File | Action | Est. LOC |
|---|---|---|
| `src/brains/identity.ts` | extend (real age key gen) | +60 |
| `src/brains/whitelist.ts` | new | 100 |
| `src/brains/publish.ts` | new (encrypt path; no git yet) | 120 |
| `src/brains/refresh.ts` | new (decrypt path; no git yet) | 80 |
| `src/brains/audit.ts` | new | 50 |
| `src/cli/brain.ts` | extend (grant, revoke, whitelist) | +60 |
| `tests/brains/publish.test.ts` | new | 120 |
| `tests/brains/whitelist.test.ts` | new | 80 |
| `tests/brains/audit.test.ts` | new | 40 |

**Acceptance:** Alice publishes encrypted blob to local file; Bob (in whitelist) decrypts successfully; Eve (not in whitelist) gets clean error.

### Phase 1c — Git integration

**Goal:** GitHub-hosted brains.

| File | Action | Est. LOC |
|---|---|---|
| `src/brains/git.ts` | new (subprocess wrappers) | 100 |
| `src/brains/publish.ts` | extend (git push after encrypt) | +40 |
| `src/brains/follow.ts` | new (git clone + register) | 80 |
| `src/brains/refresh.ts` | extend (git pull first) | +30 |
| `src/cli/brain.ts` | extend (publish, follow, refresh, list) | +80 |
| `tests/brains/end-to-end.test.ts` | new (uses local bare git repo) | 200 |

**Acceptance:** Full publish/follow/refresh round-trip via a local bare git repo in a tmp dir.

### Phase 1d — MCP tools

**Goal:** agents can use brains without leaving Claude Code / Cursor.

| File | Action | Est. LOC |
|---|---|---|
| `src/mcp/handlers/list_brains.ts` | new | 50 |
| `src/mcp/handlers/search_brain.ts` | new (ATTACH + query) | 120 |
| `src/mcp/handlers/get_brain_memory.ts` | new | 40 |
| `src/mcp/handlers/mark_shareable.ts` | new | 30 |
| `src/mcp/tools.ts` | register 4 new tools in schema | +60 |
| `src/mcp/handlers.ts` | dispatch new tools | +20 |
| `tests/brains/mcp.test.ts` | new | 150 |

**Acceptance:** with a followed brain, an MCP client calls `list_brains` → `search_brain` and gets attributed results back.

### Effort summary

| Phase | LOC (impl + tests) | Risk | Days |
|---|---|---|---|
| 1a | ~590 | Low | 2 |
| 1b | ~710 | Medium (crypto) | 3 |
| 1c | ~530 | Low | 2 |
| 1d | ~470 | Low | 2 |
| **Total** | **~2300** | — | **~9 working days** |

Each phase is independently mergeable.

## 18. Open questions for the owner

1. **Default brain remote.** Do we auto-generate a GitHub repo on `engram brain init`, or require the user to create one first and pass `--remote`? My take: require explicit `--remote` for v0.2; auto-creation needs `gh auth` and adds magic.
2. **Multi-machine identity.** If Alice has a laptop and a desktop, does she duplicate her identity file (simple, but losing one means key loss) or do we support multi-identity per brain (more code, more flexibility)? My take: v0.2 = manual copy of `~/.engram/identity`; v0.3 = explore multi-device.
3. **Imported brain TTL.** Should followed brains auto-stale (e.g., warn after 30 days without refresh)? My take: yes, just a warning in `list_brains` output; no auto-deletion.
4. **Telemetry.** Do we capture (anonymously) brain count / refresh frequency for engram's own metrics? My take: no — brains are a privacy feature, telemetry would undermine the trust story.

## 19. Out of scope for v0.2 (potential v0.3+)

- Brain discovery / registry
- Live federated query (always-on remote daemon)
- Brain forking workflows (Bob takes Alice's brain, annotates, republishes as `bob-fork-of-alice`)
- Snapshot diffing (`engram brain diff alice@HEAD~5 alice@HEAD`)
- Multi-device identity (one keypair, multiple machines)
- Brain analytics ("which memories in my brain are most-queried by followers?") — would require remote-write back, which we explicitly chose not to do
- Webhook on publish ("notify Slack when alice publishes a new snapshot")

## 20. Success criteria for v0.2 ship

- A user can run `engram init`, publish a brain to a private GitHub repo, grant another user, and that user can run `engram brain follow` + `engram brain refresh` and have their Claude Code agent query the brain via `search_brain` — all in under 10 minutes from a clean machine.
- Revoking a user and republishing produces a snapshot they cannot decrypt, demonstrated by a passing integration test.
- Zero MCP-tool breakage on existing `search_memories` / `get_memory` / etc. surface.
- Test suite grows from 258 → ~295 tests, all green, no LSP/tsc errors.
