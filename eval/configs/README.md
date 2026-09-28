# config modules

each improvement adds **exactly one** `.ts` file here and never edits `eval/lib/registry.ts`. the registry auto-loads every module in this directory (sorted by filename) and merges its `configs` export into `EVAL_CONFIGS`, so two contributors cannot conflict on a shared list.

```ts
// eval/configs/<name>.ts
import type { RetrievalConfigPatch } from '../lib/registry.js'

export const configs: Record<string, RetrievalConfigPatch> = {
  'rerank-blend': {
    label: 'rerank-blend',
    // shipped SearchOptions knobs only (src/memory/search/hybrid.ts SearchOptions)
    search: { use_reranker: true, rerank_top_n: 30 },
    // env-gated feature flags: an UPPER_SNAKE key is used verbatim, anything
    // else becomes ENGRAM_<KEY>
    features: { ENGRAM_RERANKER_ENABLED: '1' },
    notes: 'cross-encoder rerank of the top 30 hybrid candidates',
  },
}
```

rules:

- `baseline` is owned by the harness; a module that redefines it is rejected and ignored.
- config names are stable identifiers and become report column headers.
- a broken module is reported under "config load warnings" and skipped; it never takes the harness down for every other config.
- `touch: true` is refused: reads must not stamp access counts, or a run would strengthen the memories it measures.
- the report header records the active feature flags, so a config's numbers are readable back to the knobs that produced them.

run your config with:

```bash
npx tsx eval/run.ts --suite retrieval --configs baseline,rerank-blend
npx tsx eval/run.ts --suite ab --configs baseline,rerank-blend
npm run eval:ab                       # no --configs: sweeps every registered config
```

`ab` is one corpus and one seed, so a config that wins there is a hypothesis. re-run it on other corpora and seeds, and on the suite it is meant to improve, before treating the number as a result.
