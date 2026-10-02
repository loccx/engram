## suite: continuity
| field            | value |
| ---------------- | ------------ |
| suite            | continuity |
| configs          | baseline |
| seed             | 1234 |
| corpus hash      | b6b35e0d9fc8cbae |
| git sha          | 9dda727d30ee (main) |
| vectorsAvailable | false |
| vector mode      | fts |
| tokenizer        | chars/4 |
| scoring clock    | 1735718400000 (2025-01-01T08:00:00.000Z) |
| engram version   | 0.3.0 |
| node             | v24.19.0 |
| feature flags    | baseline={} |
One synthetic agent workflow, streamed in chronological order and probed at 6 checkpoints: 7 events, 12 probes, seed 1234. A probe is read after its checkpoint event, so a served row written later is a leak the scorer counts. One probe is one payload with one cap: a read that composes surfaces (state slots, history, a close summary, citations, a second read after a sweep) packs every surface into what the budgeted read left, and the scorer measures the delivered context itself rather than trusting the producer's accounting. `passRate` is over scored cases only; an insufficient-budget case is reported and excluded from both numerator and denominator, while its safety findings (a budget overflow, a future row, a namespace leak, a producer that under-reported) are still counted in the arm block.

### arms

| arm | cases | scored | pass | fail | insuff | passRate | coverage | citation | leakRate | staleRate | distractor | futureLeak | budgetViol | safetyViol | acctUnder | budgetReported | servedTokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| full | 12 | 11 | 11 | 0 | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 767 |
| single-layer | 12 | 11 | 3 | 8 | 1 | 0.273 | 0.571 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 256 |
| memory-off | 12 | 11 | 0 | 11 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |

`coverage` is the share of scored cases whose gold evidence was served (denominator: scored cases with an evidence gold); `citation` the share whose citation names the right source and external id; `leakRate` the share of served rows outside the probe namespace; `staleRate` the share of served rows carrying a forbidden value; `distractor` the share of distractor-sensitive cases served the twin; `futureLeak` the share of served rows written after the checkpoint; `budgetViol` counts payloads over their cap and `safetyViol` counts cases with any safety finding — both over every case, scored or insufficient; `acctUnder` counts cases where the producer's own section was longer than the budget it claimed; `budgetReported` is the share of insufficient-budget cases whose own accounting reported the cut.

### by family

| family | arm | cases | scored | pass | fail | insuff | passRate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archive | full | 1 | 1 | 1 | 0 | 0 | 1 |
| archive | single-layer | 1 | 1 | 0 | 1 | 0 | 0 |
| archive | memory-off | 1 | 1 | 0 | 1 | 0 | 0 |
| budget | full | 2 | 1 | 1 | 0 | 1 | 1 |
| budget | single-layer | 2 | 1 | 1 | 0 | 1 | 1 |
| budget | memory-off | 2 | 1 | 0 | 1 | 1 | 0 |
| correction | full | 2 | 2 | 2 | 0 | 0 | 1 |
| correction | single-layer | 2 | 2 | 0 | 2 | 0 | 0 |
| correction | memory-off | 2 | 2 | 0 | 2 | 0 | 0 |
| evidence | full | 2 | 2 | 2 | 0 | 0 | 1 |
| evidence | single-layer | 2 | 2 | 0 | 2 | 0 | 0 |
| evidence | memory-off | 2 | 2 | 0 | 2 | 0 | 0 |
| expiry | full | 1 | 1 | 1 | 0 | 0 | 1 |
| expiry | single-layer | 1 | 1 | 0 | 1 | 0 | 0 |
| expiry | memory-off | 1 | 1 | 0 | 1 | 0 | 0 |
| namespace | full | 2 | 2 | 2 | 0 | 0 | 1 |
| namespace | single-layer | 2 | 2 | 2 | 0 | 0 | 1 |
| namespace | memory-off | 2 | 2 | 0 | 2 | 0 | 0 |
| resume | full | 2 | 2 | 2 | 0 | 0 | 1 |
| resume | single-layer | 2 | 2 | 0 | 2 | 0 | 0 |
| resume | memory-off | 2 | 2 | 0 | 2 | 0 | 0 |

families: `resume` (restart, resumed task, close summary), `correction` (current value and its history), `evidence` (episode-only evidence and citations), `namespace` (the twin namespace and its control), `budget`, `archive` (prune, hidden read, restore) and `expiry` (ttl sweep).

### budget cases

| arm | probe | status | respected | delivered | cap | reported | dropMem | truncMem | digestCut | dropTopics |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| full | budget-sufficient | pass | yes | 44 | 120 | 44 | 0 | 0 | 0 | 0 |
| full | budget-tight | insufficient-budget | yes | 40 | 40 | 40 | 0 | 1 | 0 | 0 |
| single-layer | budget-sufficient | pass | yes | 44 | 120 | 44 | 0 | 0 | 0 | 0 |
| single-layer | budget-tight | insufficient-budget | yes | 40 | 40 | 40 | 0 | 1 | 0 | 0 |
| memory-off | budget-sufficient | fail | yes | 0 | 120 | 0 | 0 | 0 | 0 | 0 |
| memory-off | budget-tight | insufficient-budget | yes | 0 | 40 | 0 | 0 | 0 | 0 | 0 |

`delivered` is the scorer's own count of the payload it scored, `cap` the probe's budget, `reported` the producer's claim (n/a when the read carried none). An insufficient-budget probe is never scored as a success: the suite reports it, and the packer's own dropped/truncated accounting is what the record shows.

### full arm, per case

| probe | family | checkpoint | status | failed checks | violations | served | delivered | tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| resume-brief | resume | post-restart | pass | - | - | 1 | 378 | 95 |
| evidence-command | evidence | after-evidence | pass | - | - | 5 | 454 | 114 |
| namespace-window | namespace | after-evidence | pass | - | - | 1 | 44 | 11 |
| namespace-staging-control | namespace | after-evidence | pass | - | - | 1 | 59 | 15 |
| budget-sufficient | budget | after-evidence | pass | - | - | 1 | 44 | 11 |
| budget-tight | budget | after-correction | insufficient-budget | - | - | 1 | 40 | 10 |
| state-current | correction | after-correction | pass | - | - | 1 | 152 | 38 |
| state-history | correction | after-correction | pass | - | - | 2 | 316 | 79 |
| citation-source | evidence | after-correction | pass | - | - | 6 | 580 | 146 |
| archive-restore | archive | after-archive | pass | - | - | 1 | 95 | 24 |
| expiry-sweep | expiry | after-expiry | pass | - | - | 1 | 148 | 38 |
| close-summary | resume | after-close | pass | - | - | 5 | 780 | 196 |

### what failed, by arm

full: no failing case
single-layer: 8 failing case(s) — checks that failed: answer_served, archive_applied, archive_by_id_hidden, archive_hidden, archive_readable_with_flag, archive_restored, archive_restored_served, citation_correct, citation_present, durable_served_before, durable_still_served, evidence_served, expired_absent_before, expired_gone_after, fragments_present, history_contains, no_open_task, state_current_contains, state_prior_contains, summary_found, sweep_removed_expired, task_found
memory-off: 11 failing case(s) — checks that failed: answer_served, archive_applied, archive_by_id_hidden, archive_hidden, archive_readable_with_flag, archive_restored, archive_restored_served, citation_correct, citation_present, durable_served_before, durable_still_served, evidence_served, expired_absent_before, expired_gone_after, fragments_present, history_contains, no_open_task, state_current_contains, state_prior_contains, summary_found, summary_served, sweep_removed_expired, task_found

### operations

| arm | ingest write op | count |
| --- | --- | --- |
| full | episode_items | 8 |
| full | link_memory_episode | 1 |
| full | prune_apply | 1 |
| full | store_memory | 5 |
| full | task_checkpoint | 1 |
| full | task_close | 1 |
| full | task_start | 1 |
| full | task_update | 1 |
| single-layer | episode_items | 8 |
| single-layer | link_memory_episode | 1 |
| single-layer | prune_apply | 1 |
| single-layer | store_memory | 5 |
| single-layer | task_checkpoint | 1 |
| single-layer | task_close | 1 |
| single-layer | task_start | 1 |
| single-layer | task_update | 1 |

Probe-side actions, by arm (a restore or a sweep the probe itself performs, not a seeding cost):

| arm | probe op | count |
| --- | --- | --- |
| full | episode_sweep | 1 |
| full | unarchive | 1 |

Read operations, by arm (the same probes, the surfaces each arm consults):

| arm | read op | count |
| --- | --- | --- |
| full | cited_episodes | 2 |
| full | count_episodes | 1 |
| full | get_memory | 1 |
| full | get_memory(include_archived) | 1 |
| full | get_memory_history | 1 |
| full | get_state | 2 |
| full | list_open_tasks | 2 |
| full | list_task_summaries | 1 |
| full | recall | 7 |
| full | retrieve_episode_context | 4 |
| full | search | 2 |
| full | task_handoff | 1 |
| single-layer | recall | 12 |
| memory-off | recall | 12 |

each arm replays the fixture into its own database, so its ingest count is its own; the `memory-off` control writes nothing, and its own row says so.

### latency (wall clock; not covered by the determinism guarantee)

| operation | n | p50 ms | p90 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| baseline/ingest-per-event | 14 | 1.136 | 2.37 | 5.131 | 5.131 | 5.131 |
| baseline/probe/full | 12 | 1.313 | 2.234 | 3.515 | 3.515 | 3.515 |
| baseline/probe/memory-off | 12 | 0.377 | 0.612 | 0.708 | 0.708 | 0.708 |
| baseline/probe/single-layer | 12 | 0.779 | 1.117 | 1.182 | 1.182 | 1.182 |
Notes:
- fixture: 7 events streamed in order, 12 probes at 6 checkpoints, seed 1234, families resume=2 evidence=2 namespace=2 budget=2 correction=2 archive=1 expiry=1
- restart: each arm replays the fixture into its own database and reopens it after event 2; open tasks found by the next session=1
- isolation: one database per arm, so the full arm's restore and expiry sweep cannot change what the single-layer ablation or the control reads
- memory-off control: the same probes over an empty isolated store, so a pass rate cannot be satisfied by the instrument itself
- budget: one probe is one payload with one cap. a composed read packs its state, history, summary and citation surfaces into the room the budgeted read left, and the scorer counts the delivered context itself rather than trusting used_chars
- safety: a budget overflow, a served future row, a namespace leak and a producer that under-reported are counted over every case, including insufficient-budget ones, and listed per case
- arms: full reads state slots + memories + raw-episode evidence + task briefs, each under the probe budget; single-layer reads the memories layer only (recall_context), under the same budget; memory-off reads the same controller over an empty isolated store (negative control)
- budget: 1 of 12 probes declare a budget below the answer offset; they are reported as insufficient-budget and are not counted as a pass or a failure
- task success: these are fixed-controller contract results. true llm-agent task success is NOT measured here (offline suite: no gateway, no pinned reader or judge model, so no llm-agent run is claimed); eval/README.md documents the integration protocol for a reader/judge run and for MemoryArena/DolphinBench-style task suites
- ground truth: answers, evidence ids and forbidden values live in the scorer only; the controller receives the events and the probe questions, never a label