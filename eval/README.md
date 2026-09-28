# eval

a harness for measuring retrieval and lifecycle behaviour: isolated, seeded, reproducible runs that produce one markdown table and one json artifact per suite.

it calls the shipped code — `store_memory` handlers, `hybridSearch`, `recallContext`, `findContradictionCandidates`, `judgeCandidates` — and never modifies `src/`. a green unit suite says nothing about ranking quality; this is where a ranking change is measured.

## run it

```bash
npm run eval                    # all suites, baseline config, offline, FTS-only
npm run eval:retrieval          # recall@k, precision@k, MRR, nDCG@k, leak, tokens, latency
npm run eval:contradiction      # candidate stage + adjudication threshold sweep
npm run eval:budget             # recall_context under a strict character budget
npm run eval:ab                 # config sweep on one fixed corpus
npm run eval:longmemeval        # LongMemEval retrieval metrics (needs a dataset)
npm run eval:datasets           # fetch dataset split + verify schema  (network)
npm run eval:datasets -- --full # the 277 MB split instead of the 15 MB oracle split
```

longmemeval with the readers and the official judge (needs a gateway and pinned models):

```bash
npx tsx eval/run.ts --suite longmemeval --dataset longmemeval_s_cleaned --limit 5 \
  --qa --readers engram,full-context,naive-rag \
  --reader-model <reader-model> --judge-model <judge-model> --yes
```

the raw cli is the frozen interface:

```bash
npx tsx eval/run.ts --suite retrieval --configs baseline,rerank-blend \
                    --seed 1234 --limit 10 --out eval/reports --json
```

| flag | meaning |
| --- | --- |
| `--suite <name>` | `retrieval` \| `contradiction` \| `budget` \| `ab` \| `longmemeval` \| `all` |
| `--configs <list>` | config names from `eval/configs/` (default `baseline`); unknown names fail loudly |
| `--seed <n>` | corpus seed; same seed → same corpus hash → same metrics |
| `--limit <n>` | per-query result limit (for `longmemeval`: number of questions) |
| `--out <dir>` | report directory (default `eval/reports`) |
| `--json` | print the full JSON payload to stdout |
| `--assert` | exit non-zero when a metric misses `eval/thresholds.json` |
| `--vectors <mode>` | `fts` (default) \| `cached` \| `on` |
| `--corpus <list>` | corpus override — retrieval: corpus names; budget: the budget grid |
| `--qa` | `longmemeval`: run the readers + judge (needs the gateway and pinned models) |
| `--verdicts <path>` | `contradiction`: sweep recorded verdicts instead of calling the LLM |
| `--dataset <split>` | `longmemeval` split name |
| `--dataset-path <path>` | `longmemeval`: explicit dataset file, skips the manifest lookup |
| `--readers <list>` | `longmemeval --qa`: `engram` \| `full-context` \| `naive-rag` (default all) |
| `--reader-model <name>` | `longmemeval --qa`: pinned reader model, required and recorded |
| `--judge-model <name>` | `longmemeval --qa`: pinned judge model, required and recorded |
| `--concurrency <n>` | `longmemeval --qa`: questions in flight (default 2) |
| `--checkpoint <path>` | `longmemeval --qa`: append-only jsonl; completed rows are skipped on a rerun |
| `--yes` | confirm the pre-run cost estimate when it is above the call ceiling |
| `--context-budget-chars <n>` | `longmemeval --qa`: context budget for `engram`/`naive-rag` (default 32000) |
| `--cost-ceiling-calls <n>` | `longmemeval --qa`: estimated calls above which `--yes` is required (default 100) |
| `--baseline` | also write the aggregate `eval/reports/BASELINE.md` and `BASELINE.json` |
| `--write-thresholds` | regenerate `eval/thresholds.json` from this run |
| `--quiet` | suppress the per-suite markdown on stdout |

exit codes: `0` success (including "dataset missing"), `1` `--assert` threshold miss, `2` an unexpected error or a setup refusal (`--qa` without a gateway or without pinned models, a cost estimate above the ceiling without `--yes`, an unknown reader). setup refusals print the message alone: no stack, no partial report.

## vector modes

| mode | behaviour |
| --- | --- |
| `fts` (default) | FTS-only. `sqlite-vec` and the local embedding model are bypassed; no network, no model load. |
| `cached` (alias `auto`) | use vectors **only** if the nomic-embed-text model is already fully cached locally. never downloads. |
| `on` (alias `vec`) | force vectors; may download the local embedding model on first use. |

`fts` is offline-safe by construction: the harness points `ENGRAM_MODEL_CACHE_DIR` at a path under a regular file, so the pipeline's `mkdirSync` fails and it returns `null` *before* any download attempt. the report header records `vectorsAvailable` and the mode, so a report can never be mistaken for a vector run.

## longmemeval qa: readers, judge, cost

`--qa` runs one LLM reader plus the official judge for every question, and records what the answer cost. the three readers are data, one entry each (`eval/lib/readers.ts`):

| reader | context |
| --- | --- |
| `engram` | `recall_context` output under the character budget (the system under test) |
| `full-context` | every haystack session, unbudgeted (the ceiling) |
| `naive-rag` | lexical top-10 chunks of ~600 chars, packed to the budget (the floor) |

the judge is ported from the upstream LongMemEval repository (`xiaowu0162/LongMemEval`, `src/evaluation/evaluate_qa.py`, MIT) into `eval/lib/judge.ts`: one prompt per `question_type`, the abstention prompt for ids carrying `_abs`, `'yes' in response` = correct. the reader prompt is ours and stays versioned on every row.

per question, per reader the artifact records reader input/output tokens (gateway usage when reported, tokenizer estimate otherwise and labelled as such), context tokens, retrieval/reader/judge latency, the verdict and the exact judge prompt. the report shows accuracy overall and per `question_type`, average tokens per question, p50/p95 latency, and the `(accuracy, tokens)` point per reader — a pareto table, not a single number.

safety rails for a paid run:

- the gateway is checked before any work, and `--reader-model` / `--judge-model` are required — the model that graded an answer is pinned per run and written on every row, so two accuracy numbers from different judges are never merged;
- a cost estimate (calls plus reader/judge input tokens, extrapolated from the first question) is printed before the first call; above `--cost-ceiling-calls` the run stops and needs `--yes`;
- every answered (question, reader) row is appended to a jsonl checkpoint before aggregation, and a rerun skips rows whose key matches (split, dataset sha256, readers, both models, both prompt versions, budget, top-k). a different key is never reused, and the report warns when resumed rows span more than one git sha.

## metrics

| metric | definition |
| --- | --- |
| `recall@k` | `|hits@k| / |targets|`, macro-averaged over queries |
| `precision@k` | `|hits@k| / k` |
| `mrr` | reciprocal rank of the first relevant result (0 when none) |
| `ndcg@k` | binary-relevance nDCG (DCG / ideal DCG) |
| `leakRate` | share of results outside the query namespace (descendants count as inside for subtree queries) |
| `staleRate` | share of results that are superseded or in `must_not_retrieve` |
| `tokenCost` | `{chars, tokens, tokensPerChar}` over the text served; the real tokenizer when importable, else `ceil(chars/4)` |
| `latency` | wall-clock, reported in `timings`, deliberately **not** part of `metrics` |

`gpt-tokenizer` is optional and not installed by default: when one of `gpt-tokenizer`, `js-tiktoken` or `@dqbd/tiktoken` happens to be importable the header names the exact tokenizer, otherwise it says `tokenizer: chars/4`, and that fallback is what runs by default.

## corpora

`--seed` is the only other input. every corpus is a pure function of it (`eval/lib/corpus.ts`), and every seeded row is verified to land in its intended namespace, so a scope-routing surprise fails loudly instead of silently changing what a corpus measures.

| corpus | what it exposes |
| --- | --- |
| `paraphrase` | the query paraphrases the target and shares **no rare token** with it; FTS-only is expected to be near zero. a test asserts zero lexical overlap. |
| `distractor` | near-duplicate decoys sharing the target's rare token, in two families: `near-duplicate-decoys` (recall@10 saturates by construction — the signal is `recall@1`/`mrr`) and `context-clue` (the target differs only by a context word). |
| `temporal-update` | facts revised at `valid_from`/`valid_until` boundaries; half the queries are historical (`as_of`), half present-state. `must_not_retrieve` marks the stale revision. |
| `cross-namespace` | several namespaces including two synthetic `ns//scope` nodes and a sibling; leak rate plus subtree containment. |
| `cross-notation` | the query names a symbol in prose (`hybridSearch` → "hybrid search"), with decoys that share words but not the symbol. |
| `long-horizon` | eight sessions of filler plus eight facts that get revised; catches drift and stale-row resurrection. |
| `contradiction` | 16 labelled pairs: 4 `contradicts`, 4 `updates`, 4 `duplicate`, 4 `unrelated` (same topic vocabulary, different subject). |
| `budget` | 3 pinned facts (digest) + 2 clusters (topics) + one long target + 12 siblings. |
| `mixed` | union of paraphrase + distractor + temporal-update + long-horizon; the `ab` suite's fixed corpus. |

## determinism

reproducing a run byte-for-byte requires the same header: git sha, seed, corpus hash, `vectorsAvailable`, tokenizer, config list, scoring clock.

three things are enforced rather than left to the caller:

1. `SearchOptions.touch = false` on every measured read — a run cannot strengthen the memories it measures, because the access count feeds ranking.
2. the scoring clock is injected (`now` = corpus epoch by default); no wall-clock in ranking. `store_memory` stamps `created_at` from `Date.now()`, so after the real write path runs, the harness re-stamps `created_at`/`valid_from`/`valid_until` from the corpus clock.
3. background work is disabled while seeding: no LLM scope inference, no importance scoring, no maintenance jobs, and the adjudication queue never runs (the contradiction suite invokes the judge explicitly instead).

precisely: **the `metrics` blocks are identical for two runs with the same header.** `timings` are wall-clock and vary, which is why they live outside `metrics`. `tests/eval-harness.test.ts` asserts this by running the retrieval suite twice in-process and comparing the serialized metrics.

## reports

```
eval/reports/<suite>-<configs>-<git-sha-short>.md     human tables
eval/reports/<suite>-<configs>-<git-sha-short>.json   full per-query detail + timings
eval/reports/longmemeval-<configs>-qa-<split>-<readers>-<sha>.{md,json}
                                                      longmemeval QA artifact (paid run)
eval/reports/longmemeval-qa-<split>-<readers>.jsonl   append-only resume checkpoint
eval/reports/BASELINE.md / BASELINE.json              aggregate reference run (`--baseline`)
```

per-run reports are gitignored because they are regenerated constantly; `--baseline` writes the aggregate pair to keep. a baseline is a reference point — re-run it after a change that should move the numbers, and never edit one by hand.

## thresholds and `--assert`

`eval/thresholds.json` is generated from a measured run (`--write-thresholds`). most values are the measured number minus a 10% margin; lower-is-better metrics (`leakRate`, `staleRate`) are recorded as measured plus the margin and gate from above. `leakRate` is an invariant: no margin applies, so any namespace leak fails `--assert` outright — a leak is a bug, not a regression. the file is a regression gate, not a quality claim, so a low baseline passes its own gate by construction.

## adding an improvement config

add one file to `eval/configs/` and never edit `eval/lib/registry.ts` — see [`eval/configs/README.md`](configs/README.md). the registry auto-loads every module in the directory, and `ab` sweeps every registered config when `--configs` is omitted.

## gateway credentials (optional)

`--qa` (longmemeval reader + judge) and live contradiction adjudication need an OpenAI-compatible endpoint. put the values in `~/.engram-eval.env`, never in the repo, and keep the file private:

```
ENGRAM_LLM_BASE_URL=<your endpoint>
ENGRAM_LLM_API_KEY=<your key>
ENGRAM_LLM_MODEL=<your model>
```

```bash
chmod 600 ~/.engram-eval.env     # owner-only
ls -l ~/.engram-eval.env         # confirm group/other have no access
```

the environment always wins over the file. credential **values** are never printed, logged, or written into a report: the harness reports only `{configured, host, model}`, and `redactSecrets()` scrubs the key and any `authorization` header from every artifact string as a second line of defence. without credentials, live contradiction adjudication reports `unavailable` and the run still exits 0; `longmemeval --qa` refuses to start (exit 2), because a paid run that silently degrades to a footnote produces a number nobody can use.

## what each suite does not measure

- **retrieval**: the corpora are synthetic and small. `paraphrase` and `distractor` are built to be lexically impossible or saturated for FTS, so their absolute numbers are not a claim about real-world recall — they are a *relative* instrument for comparing configs. `recall@10` saturates on `distractor`; read `recall@1` and `mrr`. two column caveats: (a) `staleRate` is "share of results in `must_not_retrieve`", which on `distractor` means near-duplicate *decoy contamination*, not superseded rows — only `temporal-update` and `long-horizon` measure genuine staleness; (b) `recall@1` on multi-target queries (the subtree and cross-namespace probes) cannot reach 1.0, so read it next to `mrr` there.
- **retrieval, channel coverage**: scoring runs through `hybridSearch` with explicit options, which is what the `search_memories` and `get_context` handlers call. the funnel's guide/digest channel — the parent-layer excerpts `get_context` returns when a leaf is thin — is **not** scored here. it is navigation metadata, not a memory body, and it is covered by handler-level tests rather than by a corpus, so a digest that echoes parent content into a child's context is outside this suite's leak metric.
- **contradiction**: the judged candidate per pair is the single labelled partner, so the sweep measures relation and confidence, not candidate selection (that is stage one). cross-pair relations are not labelled, so no precision claim is made about the raw candidate list.
- **budget**: the packer is measured on one small corpus with one digest and two clusters. it shows behaviour under pressure, not a real project's digest shape, and `targetRecall` here is not a k-cut recall — the served set is whatever the budget allowed.
- **ab**: one corpus, one seed. a config that wins here is a hypothesis, not a validated improvement; re-run with other corpora and seeds before believing it.
- **longmemeval**: the `longmemeval_oracle` split mostly contains evidence sessions, so retrieval-only recall on it is near-trivial plumbing. the `longmemeval_s_cleaned` split (`--full`) is the real retrieval task, streamed one question at a time. questions are sampled with an even stride across the file, because the file is grouped by `question_type`: a head slice of questions would report one type as the whole benchmark. the judge is the upstream LongMemEval prompt and the reader prompt is ours, so accuracy is comparable with published numbers only as far as the reader shape goes, and the report says which of the two it used. `full-context` is the true ceiling baseline; the reader comparison is the pareto read, not any single accuracy number.
- nothing here measures answer quality offline; that requires the gateway.

## datasets

`npm run eval:datasets` streams `xiaowu0162/longmemeval-cleaned` to `eval/datasets/` (gitignored), hashes it, then reads the real schema back out of the downloaded bytes and records it in `eval/datasets/manifest.json` — sha256, source url, fetch time, record count, record keys, session message keys, sessions-per-record range, and whether `answer_session_ids`, `haystack_session_ids` and per-message `has_answer` exist.

what the reader and the metrics rely on:

```
record keys:        answer, answer_session_ids, haystack_dates, haystack_session_ids,
                    haystack_sessions, question, question_date, question_id, question_type
session message:    content, has_answer, role
```

the longmemeval suite recomputes the sha256 from the file on disk and reports `sha256_verified` before quoting any number derived from it.
