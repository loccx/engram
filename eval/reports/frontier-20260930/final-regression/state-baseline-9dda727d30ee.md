## suite: state
| field            | value |
| ---------------- | ------------ |
| suite            | state |
| configs          | baseline |
| seed             | 1234 |
| corpus hash      | 806de2f0672480a9 |
| git sha          | 9dda727d30ee (main) |
| vectorsAvailable | false |
| vector mode      | fts |
| tokenizer        | chars/4 |
| scoring clock    | 1738108800000 (2025-01-29T00:00:00.000Z) |
| engram version   | 0.3.0 |
| node             | v24.19.0 |
| feature flags    | baseline={} |
Three arms over the same changing facts: `keyed` writes an explicit state_key, `chained` records the supersession an adjudicator writes and names the chains afterwards, `unlinked` records nothing about the change. `staleRate` is the share of served rows that have been replaced — the failure this suite exists for — and `latestAt1` asks whether the newest evidence session is ranked first. Every version of a fact is a near-duplicate of the previous one, so recall cannot separate them and only state tracking can.

### retrieval and state reads

| config / arm | probes | recall@1 | recall@5 | mrr | staleRate | latestAt1 | currentAcc | priorAcc | asOfAcc | asOfLeak | slotCoverage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline / keyed | 26 | 0.846 | 1 | 1 | 0 | 1 | 1 | 1 | 1 | 0 | 1 |
| baseline / chained | 26 | 0.846 | 1 | 1 | 0 | 1 | 1 | 1 | 1 | 0 | 1 |
| baseline / unlinked | 26 | 0.846 | 1 | 1 | 0.108 | 1 | 0 | 0 | 0.083 | 0 | 0 |

### by probe kind

`current` asks for the value now, `as-of` for the one that was true at an instant inside the corpus, `trajectory` for every value with include_superseded.

| config / arm / kind | probes | recall@1 | recall@5 | staleRate |
| --- | --- | --- | --- | --- |
| baseline / keyed / as-of | 8 | 1 | 1 | 0 |
| baseline / keyed / current | 12 | 1 | 1 | 0 |
| baseline / keyed / trajectory | 6 | 0.333 | 1 | 0 |
| baseline / chained / as-of | 8 | 1 | 1 | 0 |
| baseline / chained / current | 12 | 1 | 1 | 0 |
| baseline / chained / trajectory | 6 | 0.333 | 1 | 0 |
| baseline / unlinked / as-of | 8 | 1 | 1 | 0.05 |
| baseline / unlinked / current | 12 | 1 | 1 | 0.2 |
| baseline / unlinked / trajectory | 6 | 0.333 | 1 | 0 |
Notes:
- keyed: 36 memories (36 via store_memory), 26 probes, placement verified=true
- chained: 12 existing chains named by the backfill (36 rows)
- chained: 36 memories (36 via store_memory), 26 probes, placement verified=true
- unlinked: 36 memories (36 via store_memory), 26 probes, placement verified=true