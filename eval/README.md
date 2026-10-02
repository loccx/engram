# eval

a harness for measuring retrieval and lifecycle behaviour: isolated, seeded, reproducible runs that produce one markdown table and one json artifact per suite.

it calls the shipped code — `store_memory` handlers, `hybridSearch`, `recallContext`, `findContradictionCandidates`, `judgeCandidates` — and never modifies `src/`. a green unit suite says nothing about ranking quality; this is where a ranking change is measured.

longmemeval also compares **memory systems**: the same questions, corpus, context budget, top-k, reader model and judge for every system entered, engram included, and any mcp memory server through a config file (see [memory systems](#memory-systems) and [the adapter](#any-mcp-memory-server-the-adapter)).

## run it

```bash
npm run eval                    # all suites, baseline config, offline, FTS-only
npm run eval:retrieval          # recall@k, precision@k, MRR, nDCG@k, leak, tokens, latency
npm run eval:contradiction      # candidate stage + adjudication threshold sweep
npm run eval:budget             # recall_context under a strict character budget
npm run eval:ab                 # config sweep on one fixed corpus
npm run eval:continuity         # sequential lifecycle: restart, resume, correction, evidence, expiry
npm run eval:longmemeval        # LongMemEval retrieval metrics (needs a dataset)
npm run eval:datasets           # fetch the longmemeval oracle split + verify its schema  (network)
npm run eval:datasets -- --full # the 277 MB split instead of the 15 MB oracle split
npm run eval:datasets -- --dataset locomo             # LoCoMo (2.8 MB, cc by-nc 4.0)
npm run eval:datasets -- --dataset memoryagentbench   # MemoryAgentBench Conflict_Resolution (1.5 MB, mit)
npm run eval:datasets -- --dataset all                # longmemeval oracle + both of the above
```

longmemeval with the readers and the official judge (needs a gateway and pinned models):

```bash
npx tsx eval/run.ts --suite longmemeval --dataset longmemeval_s_cleaned --limit 5 \
  --qa --systems engram,full-context,naive-rag \
  --reader-model <reader-model> --judge-model <judge-model> --yes
```

compare memory systems without spending anything (retrieval only):

```bash
npx tsx eval/run.ts --suite longmemeval --dataset longmemeval_s_cleaned --limit 3 \
  --systems engram,mcp:eval/adapters/engram-mcp.json
```

the raw cli is the frozen interface:

```bash
npx tsx eval/run.ts --suite retrieval --configs baseline,rerank-blend \
                    --seed 1234 --limit 10 --out eval/reports --json
```

| flag | meaning |
| --- | --- |
| `--suite <name>` | `retrieval` \| `contradiction` \| `budget` \| `ab` \| `state` \| `continuity` \| `longmemeval` \| `locomo` \| `memoryagentbench` \| `all` |
| `--configs <list>` | config names from `eval/configs/` (default `baseline`); unknown names fail loudly |
| `--seed <n>` | corpus seed; same seed → same corpus hash → same metrics |
| `--limit <n>` | per-query result limit (for `longmemeval`: questions, `locomo`: conversations, `memoryagentbench`: pools) |
| `--out <dir>` | report directory (default `eval/reports`) |
| `--json` | print the full JSON payload to stdout |
| `--assert` | exit non-zero when a metric misses `eval/thresholds.json` |
| `--vectors <mode>` | `fts` (default) \| `cached` \| `on` |
| `--corpus <list>` | corpus override — retrieval: corpus names; budget: the budget grid |
| `--qa` | run the readers + the suite's scorer (needs the gateway and `--reader-model`; `longmemeval` also needs `--judge-model`) |
| `--verdicts <path>` | `contradiction`: sweep recorded verdicts instead of calling the LLM |
| `--dataset <split>` | `longmemeval` split name; `memoryagentbench`: `Conflict_Resolution` (default) or one `factconsolidation_sh_6k`-style pool |
| `--dataset-path <path>` | `longmemeval`: explicit dataset file, skips the manifest lookup |
| `--question-type <list>` | `longmemeval`: keep only these `question_type` values, in file order; `--limit` then counts matches |
| `--systems <list>` | `longmemeval`: builtin names \| `mcp:<adapter-config>` (default: none, or `engram,full-context,naive-rag` with `--qa`) |
| `--readers <list>` | alias of `--systems`, kept so an existing command line still runs |
| `--reader-model <name>` | `--qa`: pinned reader model, required and recorded. a reasoning effort rides in the name, `gpt-6-luna:high`, so runs at different efforts never compare as matched |
| `--judge-model <name>` | `longmemeval --qa`: pinned judge model, required and recorded |
| `--concurrency <n>` | `longmemeval --qa`: questions in flight (default 2) |
| `--checkpoint <path>` | `longmemeval --qa`: append-only jsonl; completed rows are skipped on a rerun |
| `--yes` | confirm the pre-run cost estimate when it is above the call ceiling |
| `--context-budget-chars <n>` | `longmemeval`: context budget every budgeted system meets (default 32000) |
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

both vector modes point `ENGRAM_EMBED_CACHE_DIR` at `eval/.embed-cache` (override with the env var, which the harness respects): vectors are content-addressed by model, dtype, mode and the exact model input, so a second run of the same corpus reads them from disk instead of embedding again. hits, misses and writes are printed in the run notes. `fts` runs never touch it, and the cache is byte-identical to a fresh embed, so it cannot move a metric.

## memory systems

a memory system owns reset, ingest, retrieval and teardown for one retrieval stack, so a `--systems` run gives every system the same questions, the same per-question corpus, the same context budget and the same top-k. the registry is data (`eval/lib/systems.ts`), one entry per system:

| system | context |
| --- | --- |
| `engram` | `recall_context` output under the character budget (the system under test) |
| `engram-turns` | one memory per turn, recalled in a child namespace, hits rendered as dated session groups under the budget |
| `engram-turns-w3` | the same with 3-turn window memories (`turnSystemFactory` takes the window) |
| `engram-hybrid` | session recall picks candidate sessions, turn recall picks the snippets inside each |
| `engram-turns-agg` | `engram-turns` with statements bought before replies on an aggregation-shaped question, the top hit's window reserved |
| `engram-episodes` | every turn ingested as an episode, ranked by the episodes channel and served as dated session groups (`episodeSystemFactory` takes the allocation) |
| `engram-episodes-breadth` | the same, buying every reached session's densest turn before any session's second |
| `engram-episodes-breadth-reserve` | the same with the top hit's window bought first |
| `engram-episodes-statements` | one policy per query archetype: statements before replies on an aggregation question, the shipped order otherwise |
| `engram-episodes-routed` | the same routing with breadth-first as the aggregation policy (the shape the `qa` recipe ships) |
| `full-context` | every haystack session, unbudgeted (the ceiling) |
| `naive-rag` | lexical top-10 chunks of ~600 chars, packed to the budget (the floor) |

a system answers `reset(ns)`, `ingest(ns, sessions)`, `retrieve(ns, query, budgetChars)`, `cost()` and `close()`, and retrieves in the corpus-local session id space (`ref` on each item) or its recall cannot be scored. adding one is an entry in `SYSTEMS` plus a test — see `tests/eval-systems.test.ts`, which pins the engram context byte for byte against what the reader served before it moved onto the registry.

the turn systems are opt-in: a bare `--qa` run keeps `engram,full-context,naive-rag` (`defaultSystemNames()`), because a bare run must not silently change its cost or its checkpoint. they read a session's turns from the corpus (`CorpusMemory.turns`, built by the longmemeval adapter from `haystack_sessions`) and never see a `has_answer` flag; the suite keeps that label to score them. their recall channel returns up to 100 turn candidates, which is the same engine call as `engram` at a lower granularity — the served context is still packed to the same character budget, so `coverage`, `sessions/q` and, with `--qa`, accuracy are the comparable numbers, while `recall@k`/`mrr` are over snippet lists rather than session lists.

the report block is per system: `coverage` (the target is anywhere in the served context — the unbudgeted ceiling scores 1 by construction), `recall@k` and `mrr` (that list cut at k and ordered), `served/q` and `ctx tokens/q` (the cost of the same budget), `sessions/q` (distinct sessions the served items name) and `evid-turn cov` (share of scored questions where a served snippet landed on a message the dataset flags `has_answer`, `-` for a system that serves whole sessions and so cannot be attributed), plus `write calls`/`write tokens` (what ingest cost) and the adapter identity. `metrics.systems.<name>.by_question_type` carries the same numbers per `question_type`. latency lives in `timings` as `systems/<name>/retrieve`. every checkpoint row carries `system`, `adapter_kind` and `adapter_config_hash`, and the resume key is `name@adapter-hash`, so an edited adapter config cannot be resumed into a comparable number.

## any mcp memory server: the adapter

`--systems mcp:<config-path>` points the same questions, budget and scoring at any mcp memory server. the adapter (`eval/adapters/mcp.ts`) probes `server/discover` first and then speaks whichever era answers: a `DiscoverResult` means the 2026-07-28 revision, so every request carries `_meta` and the mirrored `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` headers, while any other error falls back to `initialize`, `notifications/initialized`, `tools/list` and `tools/call`. either way the transport is stdio (newline-delimited json) or streamable http (POST with `Accept: application/json, text/event-stream`, `Mcp-Session-Id` carried when a legacy server sends one, `data:` frames read until the matching id arrives). it is dependency-free on purpose: the harness measures a package, so it does not add one.

```json
{
  "name": "engram-mcp",
  "describe": "engram through its own mcp tool surface over stdio, in an isolated data dir",
  "transport": {
    "kind": "stdio",
    "command": "node",
    "args": ["--import", "tsx", "eval/adapters/engram-stdio.ts"],
    "env": { "ENGRAM_DB_PATH": "${tmp}/engram.db", "ENGRAM_DATA_DIR": "${tmp}", "ENGRAM_EMBEDDINGS": "off" }
  },
  "write": {
    "tool": "store_memory",
    "args": { "content": "${session.text}", "project_path": "${namespace}", "type": "note", "tags": "${session.tags}" },
    "idPath": "id"
  },
  "search": {
    "tool": "recall_context",
    "args": { "query": "${query}", "project_path": "${namespace}", "budget_chars": "${budgetChars}", "limit": "${topK}", "mode": "fused" }
  },
  "context": {
    "sections": ["digest", "memories[].content", "topics[].summary"],
    "items": { "path": "memories[]", "text": "content", "id": "id" }
  },
  "timeoutMs": 30000
}
```

| field | meaning |
| --- | --- |
| `name` | the system name every row reports; must be unique in a run |
| `transport` | `{ kind: "stdio", command, args, cwd?, env? }` or `{ kind: "http", url, headers? }` |
| `write` | the tool that stores one session, its argument template, and `idPath` (where its reply carries the stored id, so results map back to sessions) |
| `search` | the tool that answers one question, its argument template |
| `context.sections` | dot paths into the search reply, each expanded to one prompt block per value; `[]` walks an array |
| `context.items` | the ranked list inside the reply: `path`, `text` and the `id` that maps back to a session |
| `reset` | optional tool called on reset, with `${namespace}` |
| `timeoutMs` | per-call timeout (default 30000); a timed-out server is killed, not retried |

placeholders: `${session.id}`, `${session.text}`, `${session.createdAt}`, `${session.tags}` and `${namespace}` in the write args, plus `${query}`, `${budgetChars}`, `${topK}` in the search args, and `${tmp}` anywhere (a private temp dir the adapter creates per run and removes on close). an unknown placeholder fails before any call. a config that names a tool the server does not expose fails at setup, listing what the server has.

`eval/adapters/engram-mcp.json` is the shipped proof, and it never touches the machine's own db: it starts `eval/adapters/engram-stdio.ts` — engram's tool surface over stdio, from the same `src/mcp` source as the http endpoint — with `ENGRAM_DB_PATH`/`ENGRAM_DATA_DIR` pointing into that temp dir. `tests/eval-mcp-adapter.test.ts` asserts the mcp path retrieves the same evidence as the in-process system on a fixture, and that on `longmemeval_s_cleaned` both report identical coverage, recall and served tokens.

## longmemeval qa: readers, judge, cost

`--qa` runs one LLM reader plus the official judge for every question, and records what the answer cost. the reader is the thin layer over a system (`eval/lib/readers.ts`): it turns that system's retrieval into the numbered prompt blocks and stamps the system and adapter identity on every row. `locomo` and `memoryagentbench` use the same systems, checkpoint and cost accounting, but their official scorer is a local deterministic function rather than a judge model: they need no `--judge-model`, and the scorer version is pinned on every row instead.

the judge is ported from the upstream LongMemEval repository (`xiaowu0162/LongMemEval`, `src/evaluation/evaluate_qa.py`, MIT) into `eval/lib/judge.ts`: one prompt per `question_type`, the abstention prompt for ids carrying `_abs`, `'yes' in response` = correct. the reader prompt is ours and stays versioned on every row.

per question, per reader the artifact records reader input/output tokens (gateway usage when reported, tokenizer estimate otherwise and labelled as such), context tokens, retrieval/reader/judge latency, the verdict and the exact judge prompt, and the system plus adapter identity that produced the context. the report shows accuracy overall and per `question_type`, average tokens per question, p50/p95 latency, and the `(accuracy, tokens)` point per reader — a pareto table, not a single number.

### paired comparison (is the difference real?)

the report ends with a paired block over the questions every reader graded (`eval/lib/stats.ts`, rendered by `renderComparisonReport`):

- **the delta, with its noise**: exact two-sided mcnemar on the discordant pairs (`b` = one reader correct and the other wrong, `c` = the reverse) plus a paired percentile-95% bootstrap ci (10,000 resamples over question ids, the seed is printed in the report); holm step-down as soon as more than one pair is in the family;
- **per `question_type`**: the same paired stats, with a bucket under 30 paired questions flagged `low n`;
- **cost next to accuracy**: mean context tokens, mean reader input tokens, write-time llm calls/tokens when a row records them, and p50/p95 latency (retrieval + reader call) per reader, with the frontier on (accuracy up, tokens down) marked;
- **a guard, not a wink**: the comparison checks declared dataset/model/prompt/budget identity and requires a stable vector regime, effective question selection and identified engine revision. missing required fields or differences withhold it. a shared, explicit engine intervention permits a deliberate comparison across known revisions and is disclosed; it cannot make an unknown or dirty source tree identified. optional fields absent on either side are reported as unchecked. question ids missing on one side are listed and excluded from the paired stats — never folded in as a wrong answer.

so a line reads `engram vs full-context: -3.4 pts (95% ci -8.1 to +1.2), mcnemar p=0.19 (b=25, c=41) — not significant at 0.05`, and a report that cannot say that says so instead.

safety rails for a paid run:

- the gateway is checked before any work, and `--reader-model` / `--judge-model` are required — the model that graded an answer is pinned per run and written on every row, so two accuracy numbers from different judges are never merged;
- a cost estimate (calls plus reader/judge input tokens, extrapolated from the first question) is printed before the first call; above `--cost-ceiling-calls` the run stops and needs `--yes`;
- every answered (question, reader) row is appended to a jsonl checkpoint before aggregation. longmemeval binds split, dataset sha256, systems/adapters, reader/judge models and prompts, budget, top-k, vector regime/readiness, effective question selection and engine revision. locomo and memoryagentbench bind their scorer/prompt, effective sample selection, vector regime, revision and seed too. foreign or legacy keys are retained and diagnosed, never reused. incomplete-model regimes, unidentified revisions and dirty trees cannot resume even a matching key, and cannot be paired as matched evidence. a dirty suffix distinguishes it from a clean revision but cannot identify two different sets of edits, so both are refused rather than silently mixed. legacy checkpoints therefore cost a fresh run; the existing call ceiling and `--yes` gate still apply.

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
| `latestServed` / `latestAt1` | whether the newest evidence session is in the served list, and first. set by a corpus query's `latest_target`; on longmemeval that is the maximum-date answer session, computed from `haystack_dates` because the haystack is **not** in chronological order |
| `currentAccuracy` / `priorAccuracy` / `asOfAccuracy` | state suite: `get_state` reports the newest value, the value it replaced, and the value true at the as-of instant |
| `asOfLeakRate` | state suite: share of as-of reads that served a value which did not exist yet at that instant |
| `slotCoverage` | state suite: share of facts with any slot at all |
| `passRate` | continuity suite: scored cases whose required checks all held; an insufficient-budget case is in neither numerator nor denominator |
| `coverage` / `citationCoverage` | continuity suite: share of scored evidence-carrying cases whose gold evidence was served, and of citation-carrying cases whose citation names the right source and external id |
| `namespaceLeakRate` / `futureLeakRate` | continuity suite: share of served rows outside the probe namespace, and written after the probe's checkpoint |
| `staleRate` / `staleCaseRate` | continuity suite: share of served rows carrying a forbidden value, and share of forbidden-carrying cases that served one |
| `distractorRate` | continuity suite: share of distractor-sensitive cases served the twin namespace's value |
| `budgetReportedRate` | continuity suite: share of insufficient-budget cases whose own packer accounting reported the cut |

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

## state (knowledge updates)

three arms over the same twelve changing facts (`eval/lib/state-corpus.ts`), differing only in what the layer is told about the change:

| arm | what the rows carry |
| --- | --- |
| `keyed` | `state_key` on every value, so `store_memory` retires the previous one |
| `chained` | no keys; the supersession an adjudicator writes, named afterwards by `backfillChainKeys` |
| `unlinked` | no keys, no links, no closed windows |

every version of a fact is a near-duplicate of the last, so lexical scores cannot separate them: an arm that records nothing about the change ranks the newest value first anyway (`recall@1` 0.846, `latestAt1` 1.0) and still serves replaced values (`staleRate` 0.2 on current probes; `recall@1` is identical across arms). the columns that separate the arms are `staleRate`, `currentAccuracy`, `priorAccuracy` and `asOfAccuracy`. this is the state-tracking-is-not-recall result, reproduced inside the harness rather than quoted.

run it with `npx tsx eval/run.ts --suite state` (offline, fts-only, ~1s). thresholds are recorded per arm (`baseline/keyed`, `baseline/chained`, `baseline/unlinked`), so `--assert` gates each separately.

on longmemeval, `latestServed`/`latestAt1` give the real-dataset version of the same question (retrieval-only, no gateway): on `longmemeval_s_cleaned` (120 questions, fts-only) the newest evidence session is served in 1.0 of knowledge-update questions but ranked first in only 0.684 — the older session that first stated the value outranks the update in about a third of them. nothing in that path writes a `state_key` and no adjudicator runs offline, so this lane's mechanism does not move that number; the number is the diagnostic for whatever does.

## continuity

what it measures: one synthetic agent workflow — a release-train cutover — whose seven events are streamed **in chronological order** and probed at six checkpoints (twelve probes), so a row written after a checkpoint is a leak the scorer can see. this is a **contract suite, not an agentic benchmark**: it never claims task success by an agent, and nothing here should be cited as one. the shapes the other suites cannot express sit here: a session restart that disposes the harness and reopens the same database, a working task resumed by the next session and closed into one cited summary, a deploy window corrected after it was written (with its replaced value still readable as history), evidence that exists only as episodes and is cited from the memory distilled out of it, a sibling namespace holding a twin of the same fact, a prune that archives a redundant row that then has to come back, and an episode whose ttl expires while a durable one stays.

the fixture (`eval/lib/continuity-corpus.ts`) is a pure function of the seed and splits in two: `fixture` (events, probe questions, checkpoints, budgets) goes to the controller, `gold` (answers, evidence ids, forbidden values, the checks each case requires) goes only to the scorer. the controller (`eval/lib/continuity-runner.ts`) is fixed and scripted; it never receives a label and never reads a checkpoint it has not streamed.

the controller is supplied the read surface, state keys, structured writes and citations to consult. it does not learn extraction, routing or action policy. some checks require a particular API payload, so a memories-only arm can fail the contract even if a model could infer the answer from another representation. the restart disposes and reopens the harness/database in the same process; it is not a daemon crash experiment.

one probe is one payload with **one cap**: a read that composes surfaces packs every surface into what the budgeted read left, so a composed payload can never deliver more content than the probe was given. the delivered size is what the scorer measures — it recounts the context itself rather than trusting the producer's `used_chars`, and any gap between the two is reported (`reported_used_chars`, `gap`, `producerUnderreports`).

three arms answer the same probes under the same character budgets, each replaying the fixture into its **own isolated database** (a probe that mutates its store — the archive restore, the expiry sweep — cannot change what another arm reads; a test runs the arms in both orders and byte-compares the per-arm results):

| arm | what it consults |
| --- | --- |
| `full` | state slots + `recall_context` + `retrieveEpisodeContext` + task briefs, all charged against the probe budget |
| `single-layer` | `recall_context` only — the degraded ablation, same budget |
| `memory-off` | the same controller over an empty isolated store — the negative control |

`ingestOps` is each arm's own seeding cost; `probeOps` is what the arm itself did on top of it (`unarchive`, `episode_sweep`), kept separate so a mutating probe is never read as ingest.

what the numbers mean, and what they stand on:

| metric | denominator |
| --- | --- |
| `passRate` | scored cases (an insufficient-budget case is reported and excluded from both sides) |
| `coverage` / `citationCoverage` | scored cases carrying an evidence gold / a citation gold |
| `namespaceLeakRate` / `futureLeakRate` | served rows across **every** case, scored or insufficient |
| `staleRate` / `staleCaseRate` | served rows / cases carrying a forbidden value, scored or insufficient |
| `distractorRate` | distractor-sensitive cases |
| `budgetViolations` / `safetyViolations` | payloads over their cap / cases with any safety finding, over every case |
| `producerUnderreports` | cases where the producer's own section exceeded the budget it claimed |
| `budgetReportedRate` | insufficient-budget cases |

usefulness rates stand on the scored cases; **safety rates stand on all of them**, so a budget overflow, a served future row, a namespace leak or an under-reporting producer inside an insufficient-budget case is still counted rather than excluded with the usefulness verdict. every violation is also listed per case (`violations`, `safety_failed`) and shown as a column in the per-case table.

an operation a probe cannot answer is recorded as **unavailable**, never as a pass: a check whose gold names no answer, no forbidden value or no citation is `null`, and a **required** `null` fails the case, so an arm that did not read the surface cannot collect a point for it. the budget check is not in that category: it is always computable from the delivered context, even when the read carried no producer budget record (the archive read), and `budget_report.accounted` says whether a producer claim was present to compare against.

families: `resume` (restart and the resumed task's handoff, then the close summary), `correction` (current value, its prior and its chain), `evidence` (episode-only evidence and citations), `namespace` (the twin and its non-vacuous control), `budget` (one sufficient probe and one whose budget cannot reach the answer offset), `archive` (prune, hidden by id and by search, restore) and `expiry` (ttl sweep).

exact repeat command (offline, fts-only, ~1s, no gateway, no dataset):

```bash
npx tsx eval/run.ts --suite continuity                 # writes eval/reports/continuity-baseline-<sha>.{md,json}
npx tsx eval/run.ts --suite continuity --seed 1234 --vectors fts --json --assert
```

two runs with the same header produce an identical `metrics` block (a test runs the suite twice in-process and byte-compares it); `latency_ms` inside `details` and everything in `timings` is wall clock and varies.

thresholds: the suite emits `thresholds` keys per arm (`baseline/full`, `baseline/single-layer`, `baseline/memory-off`) and `eval/lib/thresholds.ts` knows the continuity metric names, so a future `--suite all --write-thresholds` records them. **no continuity entry is written to `eval/thresholds.json` by this change**: a gate generated from the same run it would gate is not a gate, and `--suite continuity --write-thresholds` on its own would replace the file with continuity-only entries and silently drop every other suite. `--assert --suite continuity` therefore checks 0 thresholds today and exits 0.

what it does not measure:

- the controller is fixed and scripted, so these are **contract** results: whether the shipped surfaces served the evidence a task needs. it is not task success by an llm agent, and the report says so (`metrics.task_success.agent.status = not_run`). a verbose or overgeneralized recalled text can still degrade a real agent that this suite scores as a pass.
- `full` passing its own fixture is a baseline, not a quality claim. the fixture is built from facts the layer is supposed to serve, so its value is as a regression gate — break state tracking, the episode layer, the task resume or the cold tier and a family drops to 0 — and the `single-layer` ablation and the `memory-off` control are the evidence that the instrument discriminates.
- twelve probes is a small sample: a family with one or two cases moves in whole points, and the family accuracies are directional. one probe is one payload, so the two halves of a case (the task survives the restart and the brief carries the work; the close is not re-opened and the summary cites the evidence) are checked in the same case rather than split into near-duplicates.
- the cap is enforced by the composer, not by the producer: `recall_context` and `retrieveEpisodeContext` still pack their own sections, and the runner adds the state/history/summary/citation surfaces into the room they left. a payload that would have exceeded its cap is therefore *truncated and reported* (`composed.dropped`, `composed.truncated`), and the case fails on the missing content rather than on an overflow — the regression that matters is a payload that quietly delivers more than the cap, which the scorer catches independently (a unit test drives a producer that claims 76 characters while delivering 316).
- the archive case exercises `planDuplicatePrune`/`applyDuplicatePrune` and `unarchiveMemory` on a dedicated namespace; it does not measure the maintenance scheduler.
- episode ttl is the ingest call's, so a mixed-retention batch is two ingests; the suite never relies on the background sweeper.
- reads are scored from the shipped functions with an injected clock; the mcp transport itself is covered by the handler and adapter suites, not here.

### integration protocol: task-level suites (MemoryArena, DolphinBench, future task benchmarks)

the interchange is the fixture/gold split, and it is deliberately small: `events` (seq, at, session, actions), `probes` (checkpoint, `after_seq`, query, namespace, budget) and `gold` (answer, evidence ids, forbidden values, required checks). to put a task-level benchmark behind it:

1. adapt the benchmark: its episodes or turns become `events` in their own order (one event = one session or one tool step), its questions or checkpoints become `probes` with `after_seq` set to the last event that may be visible, and its labels become `gold` and travel no further than the scorer;
2. run the fixed controller for contract numbers: offline, deterministic, no gateway, no reader. a task benchmark whose steps are tool calls maps directly — a step is an event, a graded task is a probe;
3. run the agent/reader arm separately and label it as such: the same fixture, a pinned reader (and judge) model recorded on every row, the cost ceiling and `--yes`, and the checkpoint the paid suites already use, so contract and agent numbers are never merged;
4. report utility next to cost: `writeOps`/`readOps`, served chars/tokens, `timings`, and the harmful-memory rate (`staleRate`, `distractorRate`) — retrieval coverage alone cannot certify usable memory;
5. vary only memory: same fixture, same budgets, same order, same models across systems, which is what `--systems` does for longmemeval and what the arms do here.

do not fold a contract pass into an agent score: the two answer different questions ("could the evidence be served" vs "did the agent use it"), and a benchmark that reports one number for both cannot tell a memory-layer regression from a reader regression.

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

`eval/thresholds.json` is generated from a measured run (`--write-thresholds`). most values are the measured number minus a 10% margin; non-invariant lower-is-better metrics are recorded as measured plus the margin and gate from above. generated gates for `leakRate`, `namespaceLeakRate`, `futureLeakRate`, `asOfLeakRate`, `safetyViolations`, `producerUnderreports` and `budgetViolations` have no margin: these are faults rather than noisy quality scores. the existing file has no continuity block, so `--assert --suite continuity` currently checks **0 thresholds**; passing it is not a continuity gate. its existing state `asOfLeakRate` thresholds still have the older 0.1 slack; this iteration leaves that file byte-identical rather than regenerating it from its own run. tests enforce the new contracts. the file is a regression gate, not a quality claim, so a low baseline passes its own gate by construction.

## adding an improvement config

add one file to `eval/configs/` and never edit `eval/lib/registry.ts` — see [`eval/configs/README.md`](configs/README.md). the registry auto-loads every module in the directory, and `ab` sweeps every registered config when `--configs` is omitted.

## gateway credentials (optional)

`--qa` (any suite's reader, plus the longmemeval judge) and live contradiction adjudication need an OpenAI-compatible endpoint. put the values in `~/.engram-eval.env`, never in the repo, and keep the file private:

```
ENGRAM_LLM_BASE_URL=<your endpoint>
ENGRAM_LLM_API_KEY=<your key>
ENGRAM_LLM_MODEL=<your model>
```

```bash
chmod 600 ~/.engram-eval.env     # owner-only
ls -l ~/.engram-eval.env         # confirm group/other have no access
```

the environment always wins over the file. credential **values** are never printed, logged, or written into a report: the harness reports only `{configured, host, model}`, and `redactSecrets()` scrubs the key and any `authorization` header from every artifact string as a second line of defence. without credentials, live contradiction adjudication reports `unavailable` and the run still exits 0; `--qa` refuses to start (exit 2), because a paid run that silently degrades to a footnote produces a number nobody can use. a suite whose dataset is missing also refuses (exit 2) and names the fetch command.

## what each suite does not measure

- **retrieval**: the corpora are synthetic and small. `paraphrase` and `distractor` are built to be lexically impossible or saturated for FTS, so their absolute numbers are not a claim about real-world recall — they are a *relative* instrument for comparing configs. `recall@10` saturates on `distractor`; read `recall@1` and `mrr`. two column caveats: (a) `staleRate` is "share of results in `must_not_retrieve`", which on `distractor` means near-duplicate *decoy contamination*, not superseded rows — only `temporal-update` and `long-horizon` measure genuine staleness; (b) `recall@1` on multi-target queries (the subtree and cross-namespace probes) cannot reach 1.0, so read it next to `mrr` there.
- **retrieval, channel coverage**: scoring runs through `hybridSearch` with explicit options, which is what the `search_memories` and `get_context` handlers call. the funnel's guide/digest channel — the parent-layer excerpts `get_context` returns when a leaf is thin — is **not** scored here. it is navigation metadata, not a memory body, and it is covered by handler-level tests rather than by a corpus, so a digest that echoes parent content into a child's context is outside this suite's leak metric.
- **contradiction**: the judged candidate per pair is the single labelled partner, so the sweep measures relation and confidence, not candidate selection (that is stage one). cross-pair relations are not labelled, so no precision claim is made about the raw candidate list.
- **budget**: the packer is measured on one small corpus with one digest and two clusters. it shows behaviour under pressure, not a real project's digest shape, and `targetRecall` here is not a k-cut recall — the served set is whatever the budget allowed.
- **ab**: one corpus, one seed. a config that wins here is a hypothesis, not a validated improvement; re-run with other corpora and seeds before believing it.
- **state**: the corpus is synthetic and clean — every fact is single-valued, every change is the only change, and no distractor competes for the slot. it measures whether state tracking works when the change is recorded, not whether a real ingestion path manages to extract the right key. `unlinked` is the honest floor, not a measurement of what a judge would recover: on a real corpus some changes do get a supersedes link from the adjudicator. the state-read metrics are read straight from `get_state`, so they do not see what the reader would do with the served context.
- **locomo**: ten conversations is a small sample, and the released file has known label defects — 9 evidence ids name no dialog turn and 4 questions carry no evidence at all (counted in the report, excluded from the metrics rather than scored as zero). a per-conversation mean is therefore noisy, and a category with 96 questions (open-domain) moves in whole points.
- **memoryagentbench**: only the `Conflict_Resolution` split is wired up; the other three competencies (accurate retrieval, test-time learning, long-range understanding) are not. the target label is derived, not shipped (see above), so `recall@1` is a proxy for "the current fact won", not an official number. the pool is ingested fact by fact rather than in the official 4,096-token chunks.
- **longmemeval**: the `longmemeval_oracle` split mostly contains evidence sessions, so retrieval-only recall on it is near-trivial plumbing. the `longmemeval_s_cleaned` split (`--full`) is the real retrieval task, streamed one question at a time. questions are sampled with an even stride across the file, because the file is grouped by `question_type`: a head slice of questions would report one type as the whole benchmark. the judge is the upstream LongMemEval prompt and the reader prompt is ours, so accuracy is comparable with published numbers only as far as the reader shape goes, and the report says which of the two it used. `full-context` is the true ceiling baseline; the reader comparison is the pareto read, not any single accuracy number.
- **longmemeval, systems block**: without `--systems` nothing extra runs, so a default artifact is unchanged. with it, the numbers cover retrieval only: `coverage`/`recall@k`/`mrr` describe what each system served, and only `--qa` adds the reader and the judge to that. the block scores one question at a time, so it says nothing about a system that improves by consolidating a whole haystack. a snippet system (`served/q` >> `sessions/q`) is scored on coverage and `sessions/q`; its `recall@k` and `mrr` are over its own snippet list and cannot be read against a session-level system's.
- nothing here measures answer quality offline; that requires the gateway.

## datasets

`npm run eval:datasets` streams `xiaowu0162/longmemeval-cleaned` to `eval/datasets/` (gitignored), hashes it, then reads the real schema back out of the downloaded bytes and records it in `eval/datasets/manifest.json` — sha256, source url, fetch time, record count, record keys, session message keys, sessions-per-record range, and whether `answer_session_ids`, `haystack_session_ids` and per-message `has_answer` exist.

`--dataset locomo` and `--dataset memoryagentbench` write the same kind of record under the manifest's `datasets` key; the longmemeval `splits` map is untouched. every suite recomputes the sha256 of the file it read and reports `sha256_verified`, and a mismatch is named in the report notes rather than averaged away.

| dataset | url | file | size | licence |
| --- | --- | --- | --- | --- |
| longmemeval oracle / s | `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned` | `longmemeval_oracle.json`, `longmemeval_s_cleaned.json` | 15 MB / 277 MB | see the hub repo |
| locomo | `raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json` | `locomo10.json` | 2,805,274 B | **cc by-nc 4.0** |
| memoryagentbench conflict resolution | `huggingface.co/datasets/ai-hyz/MemoryAgentBench/resolve/main/data/Conflict_Resolution-00000-of-00001.parquet` | `Conflict_Resolution.parquet` + derived `Conflict_Resolution.jsonl` | 1,491,588 B | mit |

**locomo is non-commercial.** its file is fetched into the gitignored `eval/datasets/` and is never committed, quoted or redistributed from this repo; reports carry hashes and counts only. the memoryagentbench split ships parquet only, so the fetch decodes it with a small in-repo reader (`eval/lib/parquet.ts`, verified against pyarrow's decode of the same file) and writes the rows as jsonl beside the parquet, recording both hashes.

## locomo

what it measures: ten long multi-session conversations (272 sessions, 5,882 dialog turns, 1,986 questions) with dialog-level evidence ids. retrieval-only mode ingests one memory per dialog turn into a per-conversation namespace and scores the dataset's own `evidence` dialog ids — `recall@k`, `mrr`, `ndcg@k`, per question category. `--qa` runs the readers on the published locomo prompts and scores with the published f1.

```bash
npm run eval:datasets -- --dataset locomo
npx tsx eval/run.ts --suite locomo --limit 1                 # offline, first conversation
npx tsx eval/run.ts --suite locomo --qa --readers engram,full-context,naive-rag \
  --reader-model <reader-model> --yes                        # paid: reader calls, local scorer
```

categories: 1 multi-hop, 2 temporal, 3 open-domain, 4 single-hop, 5 adversarial. the file carries no category names, so the mapping comes from the official scorer's branches (comma-split partial f1 for 1, `;`-truncated lists for 3, and the refusal keyword rule for 5, which is the only category whose rows have no `answer` at all). category 5 is scored by that keyword rule, not by f1.

reference point for the scale (baseline config, `--vectors fts`, 1,977 of 1,986 questions scorable): recall@1 0.311, recall@5 0.510, recall@10 0.577, mrr 0.430. per category recall@10: single-hop 0.651, temporal 0.660, adversarial 0.646, multi-hop 0.241, open-domain 0.299.

licence: cc by-nc 4.0 (the repo's `LICENSE.txt`); non-commercial use only, and the bytes stay out of git. the paper's own footer says cc by-nc-sa 4.0 for the article, which does not govern the data file — treat both as non-commercial.

scoring ports, each checked against the official python on hand-written cases: f1 over `normalize_answer` + nltk-porter stems (`eval/lib/porter-stemmer.ts` reproduces nltk 3.10.3 exactly on 14,020 dataset tokens and 235,976 dictionary words), comma-split partial f1, `;` truncation, and the category-5 refusal check. the prompts are ported from `task_eval/gpt_utils.py`.

unverified: the adversarial item's option order is drawn at random upstream (`random.random() < 0.5`) and is derived from `(seed, question_id)` here, so the two orders are not identical per question. the official rag context prefixes every retrieved dialog with its session timestamp; each turn here is stored with that prefix, so all three readers see the same line (the released dialog database keeps the timestamp outside the text). the official long-context frame (`CONV_START_PROMPT`, dated blocks) is not used: `full-context` gets the same rag frame as the other two readers. the reader is our own (`READER_PROMPT_VERSION`), only the question template is upstream.

## memoryagentbench (conflict resolution)

what it measures: the paper's selective forgetting competency. the `Conflict_Resolution` split holds eight fact pools (`factconsolidation_sh_6k` … `factconsolidation_mh_262k`), each a numbered list of 455–18,332 facts where a later fact overwrites an earlier one and the pool's own rule (stated in the official prompt) is that the larger serial number is newer. retrieval-only mode ingests one memory per numbered fact and asks whether the current fact outranks the one it replaced; `--qa` runs the readers on the published prompt and scores with the published `substring_exact_match`.

```bash
npm run eval:datasets -- --dataset memoryagentbench
npx tsx eval/run.ts --suite memoryagentbench --dataset factconsolidation_sh_6k   # one pool, offline
npx tsx eval/run.ts --suite memoryagentbench --qa --reader-model <reader-model> --yes
```

licence: mit (dataset card and repo).

the split ships **no evidence or decoy labels**, so the retrieval target is derived: the newest fact (largest serial) whose text contains one of the gold answers. the artifact states the rule, the counts (`with_target`, `unscorable`, `multiple_answer_candidates`) and `shipped_labels: false`, so a reader can see how much of the label is ours. across the eight pools all 800 questions resolve, but 574 of them have more than one answer-carrying fact — that is the derived label at its loosest.

reference point for the scale (baseline config, `--vectors fts`, all eight pools): recall@1 0.108, recall@5 0.186, recall@10 0.223, mrr 0.148; the single-hop pools score 0.35/0.59/0.63 at 6k and 0.10/0.15/0.16 at 262k, the multi-hop pools 0.00–0.01 at recall@1.

unverified: the official memory-construction step feeds each pool to the agent in 4,096-token chunks; this harness ingests fact by fact. the official generation config is `temperature 0.7` (shipped agent yaml) with `max_tokens 10` (`generation_max_length`), while this harness pins `temperature 0` and `max_tokens 10` (locomo uses its own 32); both are recorded in the artifact. no upstream number is reproduced here, and the hub cannot serve the split as json (its `/rows` route times out), which is why the parquet reader exists.

what the reader and the metrics rely on:

```
record keys:        answer, answer_session_ids, haystack_dates, haystack_session_ids,
                    haystack_sessions, question, question_date, question_id, question_type
session message:    content, has_answer, role
```

the longmemeval suite recomputes the sha256 from the file on disk and reports `sha256_verified` before quoting any number derived from it.
