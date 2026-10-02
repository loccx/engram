## suite: budget
| field            | value |
| ---------------- | ------------ |
| suite            | budget |
| configs          | baseline |
| seed             | 1234 |
| corpus hash      | c494a4d52fcfd7b0 |
| git sha          | 9dda727d30ee (main) |
| vectorsAvailable | false |
| vector mode      | fts |
| tokenizer        | chars/4 |
| scoring clock    | 1735689600000 (2025-01-01T00:00:00.000Z) |
| engram version   | 0.3.0 |
| node             | v24.19.0 |
| feature flags    | baseline={} |
Strict-budget recall: the packer allocates in a fixed order (digest reserve, then ranked memories, then topics) and must never exceed `budget_chars`.

| config | budget | usedChars | digestChars | memoryChars | topicChars | memories | topics | targetRecall | dropMem | dropTopic | dropTrust | dropDup | truncDigest | truncMem | truncTopic | servedTokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 50 | 50 | 6 | 44 | 0 | 1 | 0 | 1 | 9 | 2 | 0 | 0 | 1 | 1 | 0 | 13 |
| baseline | 200 | 200 | 21 | 179 | 0 | 2 | 0 | 1 | 8 | 2 | 0 | 0 | 1 | 1 | 0 | 51 |
| baseline | 500 | 499 | 51 | 448 | 0 | 4 | 0 | 1 | 6 | 2 | 0 | 0 | 1 | 0 | 0 | 126 |
| baseline | 2000 | 1281 | 226 | 876 | 179 | 10 | 2 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 324 |

### latency (wall clock; not covered by the determinism guarantee)

| operation | n | p50 ms | p90 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| baseline/budget200 | 3 | 0.599 | 0.635 | 0.635 | 0.635 | 0.635 |
| baseline/budget2000 | 3 | 0.479 | 0.528 | 0.528 | 0.528 | 0.528 |
| baseline/budget50 | 3 | 0.883 | 2.402 | 2.402 | 2.402 | 2.402 |
| baseline/budget500 | 3 | 0.613 | 1.891 | 1.891 | 1.891 | 1.891 |
Notes:
- budget: 16 memories (16 via store_memory, 0 raw-insert), 3 queries, pinned=3, clusters=2, placement verified=true
- baseline: budget grid 50, 200, 500, 2000; strict-budget violations=0
- harness: isolated db /tmp/engram-eval-1234-gu1s5r/engram.db; 16 memories, 3 pinned, 2 clusters, digests for 1 namespace(s), 0 rows with vectors
- Columns: usedChars = budget.used_chars; digestChars/memoryChars/topicChars = budget.per_section; dropped*/truncated* come from recall.dropped / recall.truncated; servedTokens counts digest + memory contents + topic summaries; targetRecall is the share of expected ids present in the served memories (there is no k cut here).