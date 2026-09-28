# brains

a brain is an encrypted snapshot of the memories one person marked shareable, shipped over a plain git remote. a follower decrypts it once and their agent can query it read-only, alongside their own memory.

the motivating case: someone has years of decisions and gotchas in their own engram. a teammate's agent can ask `search_brain(brain="alice", query="why postgres over mysql")` and get the answer alice would have given, drawn from alice's memories.

## pieces

- **a brain** — a directory holding an encrypted sqlite snapshot, a manifest, and a recipient list.
- **an engram key** — an `age` x25519 keypair. the public half is `engram_pub_...`, the private half `engram_priv_...`; both are bech32 re-encodings of the underlying age key (`src/brains/keyformat.ts`), so the encoding is engram's and the key material is age's. the snapshot itself is standard `age` output.
- **the recipient list** — `recipients.txt`, one `engram_pub_...` per line, with an optional `# label`.
- **publish** — export the shareable memories, encrypt to the recipients, commit and push.
- **follow / refresh** — clone, decrypt, cache; later, pull and re-decrypt.

possession of the encrypted file is not enough to read it; the recipient needs a key on the list. the list is the owner's to edit, and revocation applies to the next snapshot — someone who already decrypted an older one keeps it.

## where the state lives

everything is under the engram data directory (`~/Library/Application Support/engram-nodejs/` on macos, `~/.local/share/engram-nodejs/` on linux). see `src/brains/paths.ts`.

```
identity                # engram_priv_..., mode 0600
brains-config.json      # per-brain defaults recorded at brain init
audit.log               # append-only jsonl of share-widening events
brains/
  my-brain/             # a brain you publish
    .git/
    brain.db            # plaintext export (gitignored, deleted after publish)
    brain.db.age        # encrypted snapshot (committed)
    manifest.json       # plaintext metadata sidecar (committed)
    recipients.txt      # the whitelist (committed)
  alice/                # a brain you follow
    .git/
    brain.db.age        # encrypted snapshot
    manifest.json
    recipients.txt
    .cache/brain.db     # local plaintext cache (gitignored)
```

`ENGRAM_AUDIT_LOG` overrides the audit path, which is what the tests use instead of the real file.

## identity

```bash
engram init          # create <data dir>/identity, print the public key
engram whoami        # print the public key of the identity already there
```

`engram init` refuses to overwrite an existing identity unless you pass `--force`. there is no export/import command: copy the file by hand to move it between machines.

## publishing

```bash
engram brain init my-brain --namespace "$PWD" --description "payments team knowledge"
engram brain grant my-brain engram_pub_... --label alice
engram brain publish my-brain                 # dry run
engram brain publish my-brain --confirm --remote git@github.com:you/my-brain.git
```

`brain init` records the namespace in `brains-config.json`, so later `export` and `publish` calls do not need `-n` repeated; without it they fall back to `default`.

`publish` is a dry run until you pass `--confirm`. it writes the export, encrypts it, and — only with `--confirm` — writes `manifest.json`, a `.gitignore` that keeps plaintext out of the repository, and commits exactly `brain.db.age`, `manifest.json`, `recipients.txt` and `.gitignore`. the commit is never `git add -A`, so a stray plaintext file cannot reach the remote. the push happens when `--remote` is given on that run; without it the commit stays local. the plaintext `brain.db` is deleted once the encrypted file exists, so a dry run keeps it and a real publish does not. with an empty recipient list publish refuses before encrypting anything, and cleans up the export it just wrote.

`--include-scopes` also exports the `//scope` layers under the namespace.

## what travels

the export (`src/brains/snapshot.ts`) is a full engram database with the same schema, plus a `brain_manifest` table, filtered to:

- memories in the chosen namespace layers with `shareable = 1`
- **and** not superseded, so a retraction travels with the correction — a correction usually lives in a memory that is not itself shareable, and without this predicate a follower would keep reading the stale fact as current
- sessions reduced to `id`, `started_at`, `ended_at` and a namespace — `tool_name` and the free-text `summary` stay behind
- links where both ends are in the snapshot
- extracted entities
- embeddings, when `sqlite-vec` is available on the source

nothing is exported before it is scrubbed:

- namespaces are rewritten owner-relative: a home path becomes `~`, so an absolute project path under the owner's home arrives as `~/proj`. a root outside the home directory becomes `ext/<leaf>-<hash8>` — the hash keeps two different roots that share a leaf name from colliding.
- free text is scrubbed the same way, because notes and entities quote paths.
- the manifest is plaintext on a shared remote, so it records the namespace in redacted form too: `source_namespace` and `included_layers`.

`mark_shareable` is what moves a memory into the snapshot:

```json
{ "id": "<memory id>", "shareable": true }
```

it writes an audit line. when the caller declared a namespace (`?project=` in the mcp url, or an explicit argument), the memory must live in that namespace or below it — an agent connected to one project cannot flag a memory from another.

## snapshot format and compatibility

`brain_manifest` carries the format version (currently 7), the engram version, the embedding model and dimension, the owner name and public key, the description, the export time, the memory count, and the redacted layer list. bumps are additive: a newer engram keeps reading older brains, while an older engram refuses a brain from a newer one, loudly, rather than misreading it. a brain published with a different embedding model or dimension is refused too — the vectors would be meaningless.

## following and refreshing

```bash
engram brain follow alice git@github.com:alice/eng-brain.git
engram brain refresh alice
engram brain list
```

`follow` clones the remote into `brains/<name>/`, decrypts `brain.db.age` with your identity, validates the manifest, and leaves the plaintext at `.cache/brain.db`. `refresh` pulls; if the head has not moved it returns the cached count without decrypting. decryption and the cache swap are serialized behind a lock file (`src/brains/lock.ts`), and the new cache is written to a temp file and renamed, so a failed refresh cannot leave a half-decrypted database that later looks valid.

a decryption failure means your key is not on that snapshot's recipient list; the previous cache is left alone.

`engram brain list` shows owned and followed brains with owner, memory count, embedding model and whether a decrypted cache is present. `engram brain import <path>` previews a `brain.db` file without touching the store.

## querying a brain

four mcp tools, in `src/brains/mcp.ts`:

- `list_brains` — the local brains, with owner and count.
- `search_brain` — `{ brain, query, limit? }`. the query is tokenized, the tokens are quoted into an fts5 phrase expression, and the snapshot is searched with `AND` first, then `OR` when `AND` finds nothing. bm25 is adjusted by small bounded boosts for importance, prominent types (`decision`, `pattern`, `gotcha`, `procedure`) and pinned rows. the lexical pass is authoritative: vectors are consulted only when it returns nothing, and then only for hits at cosine ≥ 0.6, because a knn search always returns its nearest neighbour whether or not it is related.
- `get_brain_memory` — `{ brain, id }`.
- `mark_shareable` — the one write, on your own store.

results carry the brain name on the response envelope; rows come back as id, content, type, importance, tags and `created_at`. superseded rows are filtered out of both paths, and a snapshot whose manifest is missing or incompatible fails loudly instead of serving a cache the follower cannot interpret.

## encryption

`age` (`age-encryption`), streamed to disk so a large snapshot is never buffered whole. the output is written 0600 to a temp file and renamed into place; a failed encryption leaves nothing behind, and a failed publish leaves the previous snapshot intact. no custom cryptography, and no server: distribution is whatever git remote you can push to.
