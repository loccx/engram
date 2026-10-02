## suite: retrieval
| field            | value |
| ---------------- | ------------ |
| suite            | retrieval |
| configs          | baseline |
| seed             | 1234 |
| corpus hash      | 1b2ab47fc91d3365 |
| git sha          | 9dda727d30ee (main) |
| vectorsAvailable | false |
| vector mode      | fts |
| tokenizer        | chars/4 |
| scoring clock    | 1735689600000 (2025-01-01T00:00:00.000Z) |
| engram version   | 0.3.0 |
| node             | v24.19.0 |
| feature flags    | baseline={} |
Metrics are macro-averaged over queries. `recall@k` = |hits@k| / |targets|; `leakRate` = share of results outside the query namespace (descendants count as inside for subtree queries); `staleRate` = share of results that are superseded or otherwise must-not-retrieve; `servedTokens`/`tokens/char` price the top-k content a caller would actually receive.

### corpus: cross-notation

| config | recall@1 | precision@1 | ndcg@1 | recall@5 | precision@5 | ndcg@5 | recall@10 | precision@10 | ndcg@10 | mrr | leakRate | staleRate | servedTokens | tokens/char | queries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.1 | 0.1 | 0.1 | 0.1 | 0.02 | 0.1 | 0.2 | 0.02 | 0.136 | 0.117 | 0 | 0 | 581 | 0.253 | 10 |

### corpus: paraphrase

| config | recall@1 | precision@1 | ndcg@1 | recall@5 | precision@5 | ndcg@5 | recall@10 | precision@10 | ndcg@10 | mrr | leakRate | staleRate | servedTokens | tokens/char | queries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.2 | 0.2 | 0.2 | 0.4 | 0.08 | 0.313 | 0.4 | 0.04 | 0.313 | 0.283 | 0 | 0 | 1063 | 0.255 | 10 |

### corpus: distractor

| config | recall@1 | precision@1 | ndcg@1 | recall@5 | precision@5 | ndcg@5 | recall@10 | precision@10 | ndcg@10 | mrr | leakRate | staleRate | servedTokens | tokens/char | queries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.25 | 0.25 | 0.25 | 1 | 0.2 | 0.608 | 1 | 0.1 | 0.608 | 0.479 | 0 | 0.3 | 1421 | 0.255 | 8 |

### corpus: temporal-update

| config | recall@1 | precision@1 | ndcg@1 | recall@5 | precision@5 | ndcg@5 | recall@10 | precision@10 | ndcg@10 | mrr | leakRate | staleRate | servedTokens | tokens/char | queries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1 | 1 | 1 | 1 | 0.2 | 1 | 1 | 0.1 | 1 | 1 | 0 | 0 | 496 | 0.255 | 12 |

### corpus: cross-namespace

| config | recall@1 | precision@1 | ndcg@1 | recall@5 | precision@5 | ndcg@5 | recall@10 | precision@10 | ndcg@10 | mrr | leakRate | staleRate | servedTokens | tokens/char | queries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.453 | 1 | 1 | 0.953 | 0.475 | 1 | 1 | 0.275 | 1 | 1 | 0 | 0 | 464 | 0.253 | 8 |

### corpus: long-horizon

| config | recall@1 | precision@1 | ndcg@1 | recall@5 | precision@5 | ndcg@5 | recall@10 | precision@10 | ndcg@10 | mrr | leakRate | staleRate | servedTokens | tokens/char | queries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.313 | 0.313 | 0.313 | 0.813 | 0.163 | 0.56 | 1 | 0.1 | 0.623 | 0.505 | 0 | 0 | 2056 | 0.255 | 16 |

### pooled (all scored corpora, mean over queries)

| config | recall@1 | precision@1 | ndcg@1 | recall@5 | precision@5 | ndcg@5 | recall@10 | precision@10 | ndcg@10 | mrr | leakRate | staleRate | servedTokens | tokens/char | queries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.401 | 0.469 | 0.469 | 0.713 | 0.178 | 0.593 | 0.781 | 0.1 | 0.615 | 0.561 | 0 | 0.038 | 6081 | 0.255 | 64 |

### by probe kind (the columns that carry the signal)

| config / kind | recall@1 | mrr | recall@10 | queries |
| --- | --- | --- | --- | --- |
| baseline / cross-namespace:cross-negative | 0.5 | 1 | 1 | 1 |
| baseline / cross-namespace:strict-scope | 0.5 | 1 | 1 | 5 |
| baseline / cross-namespace:subtree | 0.313 | 1 | 1 | 2 |
| baseline / cross-notation:camel-to-snake | 0 | 0 | 0 | 2 |
| baseline / cross-notation:camel-to-spaced | 0 | 0 | 0 | 3 |
| baseline / cross-notation:prose-notation | 0.5 | 0.584 | 1 | 2 |
| baseline / cross-notation:snake-to-camel | 0 | 0 | 0 | 3 |
| baseline / distractor:context-clue | 1 | 1 | 1 | 2 |
| baseline / distractor:near-duplicate-decoys | 0 | 0.305 | 1 | 6 |
| baseline / long-horizon:historical | 0.5 | 0.671 | 1 | 8 |
| baseline / long-horizon:revised-fact | 0.125 | 0.34 | 1 | 8 |
| baseline / paraphrase:paraphrase | 0.2 | 0.283 | 0.4 | 10 |
| baseline / temporal-update:historical | 1 | 1 | 1 | 6 |
| baseline / temporal-update:present-state | 1 | 1 | 1 | 6 |

### latency (wall clock; not covered by the determinism guarantee)

| operation | n | p50 ms | p90 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| baseline/all-queries | 64 | 0.392 | 0.796 | 0.99 | 1.131 | 1.131 |
Notes:
- cross-notation: 34 memories seeded (34 via store_memory, 0 raw-insert), 10 queries, placement verified=true
- paraphrase: 30 memories seeded (30 via store_memory, 0 raw-insert), 10 queries, placement verified=true
- distractor: 37 memories seeded (37 via store_memory, 0 raw-insert), 8 queries, placement verified=true
- temporal-update: 18 memories seeded (18 via store_memory, 0 raw-insert), 12 queries, placement verified=true
- cross-namespace: 10 memories seeded (10 via store_memory, 0 raw-insert), 8 queries, placement verified=true
- long-horizon: 72 memories seeded (0 via store_memory, 72 raw-insert), 16 queries, placement verified=true
- harness: isolated db /tmp/engram-eval-1234-Klffpf/engram.db; 201 memories, 0 pinned, 0 clusters, digests for 0 namespace(s), 0 rows with vectors
- baseline: Shipped defaults: no reranker, no access-count stamping, no feature flags. search={"use_reranker":false,"touch":false}