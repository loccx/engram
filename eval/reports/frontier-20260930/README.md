# Frontier iteration evidence — 2026-09-30

Final measurements below were run from clean commit `9dda727d30ee229c033ade8eb81e69fc94fa8945` (source changes through `49501d3`). Later evidence/documentation commits do not change the measured algorithms. Version 0.3.0, Node v24.19.0, seed 1234, baseline flags `{}`, FTS-only, embeddings off, chars/4 estimator. Each process used `env -i`, a fresh temporary HOME, and isolated databases; no reader/judge model or private-history input was used.

## Continuity: fixed-controller API contracts

The fixture has seven chronological events and twelve probes at six checkpoints. Each arm has its own independently seeded database. One intentionally insufficient-budget probe is excluded from usefulness rates but included in safety accounting.

| Arm | Passed/scored | Insufficient | Safety violations | Producer underreports | Budget violations |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full layered surfaces | 11/11 | 1 | 0 | 0 | 0 |
| Memories-only | 3/11 | 1 | 0 | 0 | 0 |
| Memory-off | 0/11 | 1 | 0 | 0 | 0 |

Full-arm coverage is 7/7 evidence-carrying cases and citation coverage is 2/2 citation-carrying cases. Forbidden-value eligibility is 3 cases; distractor eligibility is 1. Namespace/future leak rates are 0 over 26 served items across all twelve cases (25 across the eleven scored cases). Full scored content totals 3,050 characters and 767 estimated tokens; memory-off serves zero content. Seeding and probe-specific restore/sweep operations are recorded separately.

This is **not LLM-agent task success**. The controller is supplied structured writes, read surfaces, state keys and citation handles. Some checks require specific API payloads even where an agent could infer an answer from another representation. Restart means harness/database disposal and reopening within a process, not a daemon crash. The artifacts explicitly record `task_success.agent.status = not_run`.

Two separate CLI processes produced byte-identical sorted `{header,metrics}` JSON. SHA-256 of that canonical view: `62918c82c78352aa249ccf27b41108b5317dfc244198b6e336eebbe8d7ce9b6b`. Full artifact hashes differ because timings/per-case latency differ; both originals are retained. Corpus SHA-256: `b6b35e0d9fc8cbaed41ab18fc3da7854b93166b289083e1a60d34e0921825ffe`.

## Fresh regression measurements

| Suite | Measurement | Existing assertions checked |
| --- | --- | ---: |
| Retrieval | 64 probes, recall@10 0.781, MRR 0.561, namespace leak 0, stale/near-duplicate-decoy contamination 0.038 | 8 |
| State | 12 supplied facts per arm; keyed/chained current, prior and as-of accuracy 1.0; unlinked current/prior accuracy 0, as-of 0.083; temporal leaks 0 | 42 |
| Budget | 3 queries per budget; used 50/50, 200/200, 499/500 and 1,281/2,000 characters; violations 0 | 1 |

These reproduce the initial synthetic FTS baseline and establish no new answer-quality or agent-utility gain. Conversational QA was not rerun.

Continuity `--assert` checks **0 thresholds**, because the committed threshold file has no continuity block. The existing state temporal-leak thresholds retain their old 0.1 slack. Newly generated safety gates now use no margin, but `eval/thresholds.json` was not regenerated or tuned and is byte-identical to source baseline `5f1858a`. Unit/counterfactual tests are the current continuity contract gate.

## Reproduce

Check out the measured commit in a separate clean checkout with its existing dependencies. From the repository root:

```bash
testhome=$(mktemp -d /tmp/engram-frontier-home.XXXXXX)
env -i PATH="$PATH" HOME="$testhome" TMPDIR=/tmp ENGRAM_EMBEDDINGS=off \
  ./node_modules/.bin/tsx eval/run.ts --suite continuity --configs baseline \
  --seed 1234 --vectors fts --assert --out /tmp/engram-continuity-1
env -i PATH="$PATH" HOME="$testhome" TMPDIR=/tmp ENGRAM_EMBEDDINGS=off \
  ./node_modules/.bin/tsx eval/run.ts --suite continuity --configs baseline \
  --seed 1234 --vectors fts --assert --out /tmp/engram-continuity-2
jq -S '{header,metrics}' /tmp/engram-continuity-1/continuity-baseline-9dda727d30ee.json > /tmp/metrics-1.json
jq -S '{header,metrics}' /tmp/engram-continuity-2/continuity-baseline-9dda727d30ee.json > /tmp/metrics-2.json
cmp /tmp/metrics-1.json /tmp/metrics-2.json
shasum -a 256 /tmp/metrics-1.json
```

Use the same environment and flags with `--suite retrieval`, `--suite state` and `--suite budget` for the regression reports. No `--write-thresholds` flag is used.

## Acceptance evidence

Complete integrated tree: 1,442 tests passed, 3 skipped; 121 files passed, 1 skipped. Production build, evaluation source typecheck (`tsc -p eval/tsconfig.json --noEmit`) and `git diff --check` passed. After committing new files, comment-style tests passed again. The TypeScript configurations do not cover every changed test file; Vitest transpiles those tests.

Independent reviewers accepted runtime, corrected continuity, checkpoint identity and final integration. The final bounded follow-up returned OK with no verified defects, with 105 scoped test executions and real dirty/clean identity composition. Its tracked diff hash was `e04c35e3850598f6e5c8c3841dab90e19e868cd830576154898b296e7df2d30b`; newly tracked helper/test contents are retained in `49501d3`. The earlier final review also verified 198 scoped test executions and 12 counterfactual failures when corresponding fixes were reverted.

The parent initially withheld continuity acceptance: 316/100 and 696/400 delivered characters were falsely passed. Corrected composition fits the caps and fails missing-evidence checks; mutation-isolation and arm-order tests prevent archive/expiry from helping another arm. Complete local review reports and falsifiers remain in private sibling evidence records, outside this published snapshot.

The global lane checker ran and returned exit 1 for two unrelated sessions. Its returned metadata shows Engram gateway calls for all seventeen owned child attempts; those unrelated sessions were not changed. The older sibling scoped JSON covers the earlier fifteen attempts. A subsequent optional ownership-filter script was blocked before execution by the inspection guard and abandoned, as was the earlier optional broader-test-config enumeration. Neither operation was retried or delegated; no credential inspection was performed.

Only `final-run-1`, `final-run-2`, `final-regression`, the canonical metric view, this file and `SHA256SUMS` are retained by the evidence commit. Other ignored files in this directory are historical working-tree runs and are not final evidence. No push, deployment, package publication or live-daemon restart was performed.
