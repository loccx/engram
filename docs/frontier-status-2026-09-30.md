# Engram against the memory-research frontier

Evidence date: 2026-09-30. Source baseline: `5f1858a`, version 0.3.0.

Engram has a substantial external-memory data plane. Its next research question is whether the right memory reaches an agent at the right lifecycle boundary and changes its actions for the better. More storage layers or higher retrieval coverage do not establish that result.

At baseline the checkout was clean and **127 commits ahead of `ghe/main`**. The local daemon reports version 0.3.0 and ready embeddings; `/health` does not expose its commit. Source features below are verified in the checkout, not assertions that every ahead commit is deployed. Benchmarks use isolated temporary databases and public/synthetic fixtures. The daemon is used for ordinary workspace memory/task tracking and metadata status; this iteration does not push, publish a package, restart the daemon, migrate its schema, or ingest private histories.

## What exists

| Research concept | Engram implementation | Remaining distinction |
| --- | --- | --- |
| Short-term / working memory | `tasks`, append-only task events, brief/checkpoint/handoff, session priming and host lifecycle hooks (`src/tasks`, `src/delivery`) | Persistent working state is not the model's active context. Delivery still depends on the harness; hooks are registered for Claude Code, tools alone for the other documented hosts. |
| Episodic memory | Immutable, idempotent raw `episodes`, separate lexical/vector indexes, dated turn windows, expiry and deletion (`src/memory/episodes.ts`, `episode-context.ts`) | No shipped source connector automatically captures all eligible experience. Raw records are observations, not authoritative current truth. |
| Semantic / long-term memory | Curated rows, hybrid retrieval, entities/graph, explicit state slots, validity windows, append-only revisions and historical recall (`src/memory/store.ts`, `state.ts`, `search`) | Extraction quality and natural-language conflict resolution remain separate from correctness once a state key or revision is recorded. |
| Procedural memory | Procedure type and metadata; patterns and provenance-linked promotion | Representation exists; verified learning from repeated success/failure and safe procedure promotion are not a measured closed loop. |
| Unified external context | `assemble_context`: working, state, memories, summaries and evidence under a deterministic character budget; named recipes (`src/memory/assemble.ts`) | The hook/session primer uses its own delivery path rather than this assembly recipe. One read interface does not imply every type should share a ranking or lifetime. QA's evidence-heavy recipe is not a demonstrated coding-agent policy. |
| Memory scheduling | Durable jobs, leases, retries, startup/session-end triggers and ticker (`src/maintenance`) | Some handlers inspect in shadow mode; sanctioned promotion/retention/index operations write. A queue is not a trained sleep-time reasoning policy. |
| Paging / eviction | Budgeted assembly, reversible archive/restore and eviction/fault telemetry | No complete minimum-fidelity protected working set across prompt compactions, no optimal residency guarantee, and no automatic model-context page table. |
| Isolation / sharing | Principals and namespace grants, scoped reads, admission, explicit encrypted brain snapshots (`src/mcp/principals.ts`, `src/memory/access.ts`, `src/brains`) | Namespace isolation is not a general artifact-level information-flow or revocation guarantee. Followed snapshots remain copies. |
| Activation / parametric memory | Not implemented | KV-cache placement and model-weight learning require serving/training integration. An external SQLite/MCP daemon cannot reproduce them merely by adding tables. |

The useful OS analogy is concrete: address spaces, admission, durable writeback, scheduling, bounded residency, fault reasons and restoration. Treating every representation as an undifferentiated vector record would weaken those contracts.

## Load-bearing research

These are primary-source mechanisms, not a ranking of vendors. Recent preprints have narrower evidence than a broad deployment claim.

- [MemGPT (2023)](https://arxiv.org/abs/2310.08560): explicit virtual-context tier management. Engram already has persistent tiers and tools; the missing seam is reliable placement in the host's active context.
- [Memory OS of AI Agent (2025)](https://arxiv.org/abs/2506.06326): short/mid/long-term organization and dialogue-chain updates. Engram's tasks/episodes/facts are already distinct layers; another tier needs an ablation, not just a new name.
- [MemOS (2025)](https://arxiv.org/abs/2507.03724): MemCube content plus provenance/version metadata, and plaintext/activation/parameter unification. The conceptual framework is broader than an external-memory product; the abstract does not establish that all proposed transitions are implemented or evaluated.
- [A-MEM (2025)](https://arxiv.org/abs/2502.12110): structured notes, generated links and evolving contextual representations. Useful for derived indexing; do not mutate canonical facts in place or let a generated association acquire authority without evidence.
- [Sleep-time Compute (2025)](https://arxiv.org/abs/2504.13171): precompute reasoning over persistent context before a future query. A periodic summary alone does not reproduce it. Benefit depends on query predictability and amortization; total background cost belongs in the result.
- [ReasoningBank (2025)](https://arxiv.org/abs/2509.25140): non-parametric strategies and guardrails distilled from successful and failed trajectories, with contrastive multi-rollout curation. This can inform draft procedures without retraining. Its model-judged outcomes are proxy labels; use independent executable checks or explicit validation before treating a lesson as a permanent rule.
- [Memory-R1 (2025)](https://arxiv.org/abs/2508.19828) and [AgeMem (2026)](https://arxiv.org/abs/2601.01885): outcome-trained memory operations; AgeMem jointly learns long-term edits and short-term retrieval/summary/filter. Adding these tools does not implement the trained policy. Engram first needs unbiased operation/outcome traces and held-out task rewards.
- [ClawVM (2026)](https://arxiv.org/abs/2604.10352): typed pages, minimum-fidelity representations and validated lifecycle writeback. Its strongest guarantees concern structural faults when the minimum set fits; replay success is not live semantic correctness. This is an implementable direction for Engram's harness boundary.
- [MemoryArena (2026)](https://arxiv.org/abs/2602.16313): retrieve during actions, update after subtasks, reset active history while keeping persistent memory. Cross-session causal task dependencies expose failures that post-hoc QA misses.
- [DolphinBench (2026)](https://arxiv.org/abs/2609.24971): memory usefulness through task completion, with total cost and latency alongside accuracy.
- [VibeMemBench (2026)](https://arxiv.org/abs/2609.23570): matched coding tasks with executable outcomes. In the reported study, 11 of 12 solver/system pairings did not exceed memory-off; record form and transcript volume were larger failure sources than ranking misses. Its history/target selection is benchmark-specific, so it does not establish a universal effect size. The linked public release was checked on 2026-09-30 and contained only a `Coming` README: cite the paper finding, but do not make this unreleased benchmark an execution dependency.

## What the existing numbers establish

An existing artifact, `eval/reports/longmemeval-baseline-qa-longmemeval_s_cleaned-engram+engram-turns-2005becd20da.md`, records **500 matched questions** at a **32,000-character context budget**, cached vectors, reader `gpt-6-luna:xhigh`, judge `gpt-4o`, reader prompt `longmemeval-reader-v2`:

| Representation | Judged QA accuracy | Context tokens/question, chars/4 estimate |
| --- | ---: | ---: |
| Whole-session Engram memories | 0.624 | 7,715.532 |
| Turn-level Engram memories | 0.734 | 7,967.380 |

This supports finer-grained conversational evidence under that setup. It is neither a memory-off coding-agent result nor a comparison with another vendor's reader/judge. Turn rows also increased curated-table writes from 23,867 to 246,750; the separate episode tier addresses that storage design issue.

A separate **100-question** artifact at `06af6f4` records whole-session Engram 0.63, unbudgeted full-context 0.76 and naive RAG 0.21. Do not combine those scores with the 500-question comparison as matched results.

The newer episode/assembly headlines previously in `docs/architecture.md` and `CHANGELOG.md` do not have a complete retained matching report/checkpoint in the audited workspace. They have been labeled unreproduced rather than presented as established 500-question results. The older 500-question artifact above is historical and predates later ranking, isolation and assembly changes; it is not HEAD's judged accuracy. No paid reader/judge benchmark was rerun in this iteration.

The oracle LongMemEval split is a plumbing check. The full S split is the meaningful retrieval test. LoCoMo has ten conversations and documented evidence-label defects. Engram's MemoryAgentBench adapter currently covers conflict resolution, not all four competencies. An FTS-only run, a vector run, a structural replay and judged QA are different experiments.

## Benchmark the whole loop

Use four levels. Keep regression gates separate from research-quality claims.

1. **Structural lifecycle gates.** Chronological synthetic replay against the shipped APIs: session handoff/restart, compaction delivery, correction/history, evidence citation, namespace interference, bounded assembly and archive/restore. Ground truth stays in the scorer. Include negative controls and binding small budgets. These diagnose implementation faults; a fixed deterministic controller is not an LLM agent.
2. **Read/answer quality.** LongMemEval-S across all 500 questions and, separately, a longer split; LoCoMo with label exclusions disclosed; all MemoryAgentBench competencies when adapters exist. Hold the reader, judge, prompt, question IDs, seed and context budget fixed. Pair outcomes per question; report confidence intervals and per-type accuracy, abstention, stale-fact rate and evidence coverage. Report the write-side cost too.
3. **Agent utility.** MemoryArena for multi-session dependencies; VibeMemBench or an equivalently leakage-controlled coding task suite for executable transfer. Reset the environment and active context between paired arms. Compare memory-off, raw-history/RAG, curated-only, episodes-only and a gated mixed policy with the same agent, tools, image, task order and budget. History construction must not see target gold patches, test patches or outcomes. Use repeated seeds and held-out repositories. Report success/progress, harmful-memory frequency, steps, full input/output/background tokens and latency.
4. **Operational pressure and safety.** Increase corpus size and distractor density; repeat compactions, restart during writes, exercise expiry and query after archive/restore. Probe every accessible channel for scope leaks, stale derived copies, poisoning and deletion failures. A serving or eviction claim needs a restore counterfactual and p50/p95 measurements.

Do not tune on the final benchmark and then call it held out. Keep policy selection in a development partition, freeze it, and evaluate on untouched tasks. Record exact code commit, dataset hash, tokenizer/estimator, model/effort, prompt, tool configuration, adapter version, successful and failed calls, and resumption identity. Vendor-reported accuracy is not comparable without these controls.

The opt-in `no-memory` evaluation system supplies empty history even when the shared fixture database is populated; existing default arms stay unchanged. This gives conversational QA a query-only negative control, not a substitute for a memory-off coding-agent run. LongMemEval's checkpoint key now binds vector regime/readiness, effective sample selection and engine revision; LoCoMo and MemoryAgentBench bind their sample selection and relevant seed too. Legacy/foreign rows are retained but not reused. Unsettled incomplete-model regimes, unidentified revisions and dirty source trees cannot resume even a matching key or be paired as matched. A dirty suffix is a warning rather than a fingerprint of the edits. An explicit shared intervention permits intentional comparisons across known revisions and is printed in the human-readable report. For a quality run, use a clean committed checkout, confirm per-system vectors actually stored, and keep the regime stable; these guards are not an attestation of provider/model weights.

## Iteration order

| Order | Change | Why / falsifying experiment |
| --- | --- | --- |
| 1 | Restore cue eligibility at compaction boundaries and add sequential lifecycle gates | A memory delivered once can leave active context while its dedup flag persists. Test seed → cue → dedup → compaction → re-delivery without weakening ordinary dedup. |
| 2 | Minimum-fidelity working set: goal, unresolved constraints, current state and resolvable evidence handles | At tight budgets, report an unsatisfied protected-set requirement instead of silently claiming complete context. Repeated-compaction paired tasks should reduce structural faults without increasing irrelevant injection. |
| 3 | Managed, explicitly opted-in episode connector with cursor/revision/deletion reconciliation | A store cannot learn from experience it never receives. Test crash/replay idempotency, source deletion and credential-free fixtures before any private-history ingestion. |
| 4 | Provenance-bound draft procedures with observed outcome counts and explicit promotion | Avoid overgeneralized fixes becoming standing instructions. Test executable transfer, procedure expiry and harmful-memory rate; retrieval frequency is exposure, not a success label. |
| 5 | Goal/event-conditioned retrieval and abstention | Inject only when evidence is applicable; a no-memory decision is valid. Ablate decision policy separately from representation/ranking under task-level evaluation. |
| 6 | Sleep-time repair proposals, then learned controllers | Add bounded background reasoning only if held-out downstream gain exceeds its measured cost and hallucination/interference risk. Train only after trustworthy trajectories and reward instrumentation exist. |

The compaction repair is narrower than a residency guarantee: repeated notifications of the same kind each reopen cue eligibility, while the two host notification kinds can pair once inside 30 s. A pair followed by another compaction is covered. Without a host compaction id, two distinct different-kind events can still be conflated, and a delayed pair can duplicate delivery; concurrent state-file writes and other rebuild sources remain limitations. The best-effort cache retains the most recent 200 cue ids, so eviction can also duplicate a cue. The next protected-working-set experiment must test those boundaries rather than assume they are solved.

Keep activation/KV paging, parameter updates, live federation and automatic destructive memory policy out of this iteration. They need separate serving, security, revocation or training contracts; the existing external-memory engine is not evidence those contracts are solved.

## Execution evidence

Local implementation begins from `5f1858a` and preserves its 127 ahead commits. Accepted parent source commits:

| Commit | Change |
| --- | --- |
| `2b4ade6` | Redact custom HOME roots in brain snapshots; an isolated HOME exposed the original privacy defect. |
| `3ec1ea4` | Opt-in query-only `no-memory` control, including empty history when the shared fixture DB is seeded. |
| `58020d3` | Qualify unreproduced QA headlines rather than treating them as retained measurements. |
| `912cf7c` | Bind LongMemEval resume/comparison identity to vector readiness, effective selection and engine revision. |
| `bdceeee`, `bb162b9` | Reopen cue eligibility after compaction; pair the two notification kinds without swallowing repeated same-kind compactions. |
| `3cd1e9d`, `67a4cc7` | Add continuity contracts, then correct aggregate budgeting and isolate mutable arms. |
| `d05e16f` | Bind LoCoMo/MAB keys to effective selection, vector regime, revision and seed. |
| `405694a` | Conservatively redact case variants of custom HOME roots, with Unicode limits stated. |
| `49501d3` | Fail closed on uncertain/dirty identities; consistent reporting, citation provenance, derived eligibility and no-margin generated safety gates. |

The final integration adds conservative case-variant root redaction; a shared guard for unverified vector/revision/dirty-tree identities; renderer/diagnostic consistency; citation-pointer provenance; gold-backed metric eligibility; and no-margin generated safety gates. The corpus and committed threshold file are not tuned to these results.

Validation on the complete integration tree: **1,442 tests passed, 3 skipped; 121 files passed, 1 skipped**. Production build, `tsc -p eval/tsconfig.json --noEmit` and `git diff --check` pass. These TypeScript configurations cover product/evaluation source and the existing harness test, not every changed test file. An optional broader test-config enumeration was blocked before execution and abandoned; no credential operation is needed.

The independent final reviewer verified 198 scoped tests and a counterfactual tree where all 12 new certainty/provenance/eligibility/safety tests failed when the corresponding fixes were reverted. The bounded follow-up verified another 105 scoped test executions, actual dirty-tree identity composition and clean stable resumes, then returned **OK, no verified defects**. The accepted tracked code/test diff hash was `e04c35e3850598f6e5c8c3841dab90e19e868cd830576154898b296e7df2d30b`; new helper/test files were also read directly and retained in `49501d3`.

Original acceptance was withheld when the parent falsifier found 316 delivered characters against a 100-character history cap and 696 against a 400-character close-summary cap, both incorrectly passing. The corrected composer delivers at most 100/400 and fails missing-history/citation checks instead. It also seeds an independent DB for each arm; an order-reversal test proves mutations cannot improve the ablation.

The repeat protocol below uses a clean committed checkout, isolated HOME and fresh per-arm databases, seed 1234, FTS-only retrieval and the chars/4 estimator. Reports retain the measured commit, corpus hash, vectors, flags and denominators. Each continuity run is a separate process; compare `header` and `metrics`, excluding wall-clock `timings` and per-case `latency_ms`.

```bash
testhome=$(mktemp -d /tmp/engram-frontier-home.XXXXXX)
env -i PATH="$PATH" HOME="$testhome" TMPDIR=/tmp ENGRAM_EMBEDDINGS=off \
  ./node_modules/.bin/tsx eval/run.ts --suite continuity --seed 1234 --vectors fts \
  --assert --out eval/reports/frontier-20260930/final-run-1
env -i PATH="$PATH" HOME="$testhome" TMPDIR=/tmp ENGRAM_EMBEDDINGS=off \
  ./node_modules/.bin/tsx eval/run.ts --suite continuity --seed 1234 --vectors fts \
  --assert --out eval/reports/frontier-20260930/final-run-2
```

No `--write-thresholds` is used. Continuity CLI assertions check **0 thresholds** because the committed file has no continuity block; the unit/counterfactual tests are the current contract gate. Generated gates now apply no margin to safety counters and namespace/future/as-of leak rates, but the existing state `asOfLeakRate` threshold still has the old 0.1 slack. That file remains byte-identical to `5f1858a`.

Fresh runs at clean committed revision **`9dda727d30ee229c033ade8eb81e69fc94fa8945`** produced byte-identical sorted `{header,metrics}` views in two separate CLI processes. Canonical view SHA-256: `62918c82c78352aa249ccf27b41108b5317dfc244198b6e336eebbe8d7ce9b6b`; corpus SHA-256: `b6b35e0d9fc8cbaed41ab18fc3da7854b93166b289083e1a60d34e0921825ffe`. Full artifact hashes differ because wall-clock timing differs. The reports, canonical view, manifest and commands are retained in [the evidence directory](../eval/reports/frontier-20260930/README.md).

| Continuity arm | Passed/scored | Insufficient | Safety / producer / budget violations |
| --- | ---: | ---: | --- |
| Full layered surfaces | 11/11 | 1 | 0 / 0 / 0 |
| Memories-only | 3/11 | 1 | 0 / 0 / 0 |
| Memory-off | 0/11 | 1 | 0 / 0 / 0 |

Full-arm evidence coverage is 7/7 and citation coverage 2/2. Safety checks include all twelve cases and 26 served items (25 across the eleven scored cases); namespace/future leak rates are 0. Memory-off serves zero content. These are **fixed-controller API contracts**, not an LLM-agent benefit: the controller is supplied read surfaces, state keys, structured writes and citations, and some checks demand specific payloads even where an agent could infer an answer. Harness/database reopening occurs in the same process, not through a live-daemon crash. The artifact explicitly records agent task success as `not_run`.

Fresh FTS regressions reproduce the initial synthetic baseline: retrieval 64 probes, recall@10 **0.781**, MRR **0.561**, leak **0**, stale/near-duplicate-decoy contamination **0.038**; supplied keyed/chained current/prior/as-of state accuracy **1.0** on 12 facts, unlinked current/prior **0** and as-of **0.083**; budget violations **0** across 50/200/500/2,000-character caps. Existing assertions checked 8 retrieval, 42 state and 1 budget thresholds. After the new files were committed, comment-style tests passed again. No current conversational-QA accuracy or matched coding-agent gain is claimed.

Seventeen owned child attempts made actual Engram gateway calls according to the global checker's returned metadata. Its two misses are unrelated sessions and were left untouched. The next decisive experiment remains a held-out, repeated-seed agent-utility comparison against memory-off, with a protected working set and total foreground/background cost measured.
