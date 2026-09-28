// retrieval-core configs for the eval harness (EVAL-CONTRACT.md). one file per
// improvement; the registry owns the canonical patch declaration, so this file mirrors
// it structurally and does not import it. the numbers for each config live in
// eval/reports/retrieval.md.
// knn-scoped and the absolute-relevance scorer are the shipped defaults: they cannot be
// expressed as a patch against a post-merge baseline, so `search` stays empty and the
// config exists for the harness to report under. shipping a flag that restores a
// known-broken retrieval path would be a hazard, not a measurement.
import type { SearchOptions } from '../../src/memory/search/hybrid.js'

/** structurally mirrors the frozen RetrievalConfigPatch, kept import-free */
export interface RetrievalConfigPatch {
  label: string
  /** shipped knobs only */
  search?: Partial<SearchOptions>
  /** env-gated flags, exported for the run */
  features?: Record<string, boolean | number | string>
  notes?: string
}

export const configs: Record<string, RetrievalConfigPatch> = {
  'rerank-blend': {
    label: 'cross-encoder blended across the whole candidate set (alpha 0.5)',
    search: { use_reranker: true, rerank_blend_alpha: 0.5 },
    // the harness pins ENGRAM_RERANKER_ENABLED=0, so a config that wants the cross-encoder
    // has to re-enable it; without this it reports as baseline with degraded:['reranker']
    
    features: { ENGRAM_RERANKER_ENABLED: '1' },
    notes:
      'The reranker contributes alpha*norm(rerank) + (1-alpha)*fused. Previously the window score WAS the raw ' +
      'sigmoid while the unresolved tail kept fused scores, so one list carried two incomparable scales and ' +
      'the window was 20 items against a 50-item over-fetch. alpha is also settable via ' +
      'ENGRAM_RERANK_BLEND_ALPHA for a sweep.',
  },
  'knn-scoped': {
    label: 'scoped vector search (KNN computed over the scoped set)',
    search: { touch: false },
    notes:
      'Shipped behavior in this branch; no knob, kept as a stable identifier. The previous form ran a global ' +
      '`LIMIT k` subquery and filtered on the joined row, so a scoped semantic query returned nothing whenever ' +
      'the global top-k was filled from other namespaces (measured: recall@10 0.00 pre-fix vs 1.00 post-fix on ' +
      'the adversarial fixture in eval/reports/retrieval.md).',
  },
  'absolute-floor': {
    label: 'absolute relevance + a min_score floor',
    search: { min_score: 0.4 },
    notes:
      'bm25 is mapped per-term (p/(1+p)) and vec0 distance to cosine (1 - d^2/2) instead of being divided by the ' +
      'best value in the candidate set, so a lone weak match no longer scores 1.0. min_score then has an absolute ' +
      'meaning; 0.4 is the midpoint of the measured strong/weak separation locally (weak 0.50, strong 0.64 in a ' +
      'two-memory corpus; 0.37/0.84 relevance on the lexical fixture) — sweep 0.2-0.5 on the eval corpus and ' +
      'report the precision/recall trade-off.',
  },
  'access-explicit': {
    label: 'access recorded only on an explicit id fetch',
    features: { ENGRAM_ACCESS_SIGNAL: 'explicit' },
    notes:
      'Recommended default. `retrieval` (legacy) stamps every returned top-k, which makes access_count a ' +
      'function of the ranker output that it feeds (frequentist archetype weight up to 0.45, plus the ' +
      'Ebbinghaus stability term). `off` disables access recording entirely and also overrides an explicit ' +
      '`touch: true`. See the access-inflation measurement in the report.',
  },
  'expand-multi-query': {
    label: 'deterministic multi-query expansion (identifier split, phrase, rare token)',
    search: { expand: true },
    notes:
      'Each variant is an additional lexical list weighted 1/n, so matched phrasing accumulates evidence. ' +
      'Expansion compresses the lexical signal by 1/n, which is why it is opt-in: enable it only where the eval ' +
      'corpus shows a recall gain (measured locally: identifier-split recall@10 0.00 -> 1.00 on a camelCase ' +
      'query, no change to the primary list). LLM variants stay off (expand_use_llm) and require ENGRAM_LLM_*.',
  },
}
