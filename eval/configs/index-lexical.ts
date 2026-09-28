// identifier-index config patches. the registry merges every eval/configs/*.ts module,
// so this one exports `configs` and never touches the registry. the type is
// re-declared to stay import-free and is structurally identical to the contract.
// the two channel configs are live switches (wired in scoring.ts); the graph flags are
// inert for the harness, which eval/reports/wiring.md says out loud.
import type { SearchOptions } from '../../src/memory/search/hybrid.js'

export interface RetrievalConfigPatch {
  label: string
  search?: Partial<SearchOptions>
  features?: Record<string, boolean | number | string>
  notes?: string
}

export const configs: Record<string, RetrievalConfigPatch> = {
  'ident-lexical': {
    label: 'ident-lexical',
    features: { ident_channel: true },
    notes:
      'Identifier-normalised lexical channel (migration 012, memories_ident_fts): camelCase/snake_case/spaced/dotted-path ' +
      'queries all match the same stored identifier. Measured (12 cross-notation + 4 dotted-path queries, k=10): ' +
      'cross-notation recall@10 1.000 vs 0.083 for memories_fts; leakRate 0.000; median 0.07ms / p95 0.18ms. ' +
      'See eval/reports/index-lexical.md.',
  },
  'entity-channel': {
    label: 'entity-channel',
    features: { entity_channel: true },
    notes:
      'Normalised + prefix + multi-token entity channel (memory_entity_fts over memory_entities): prose queries such as ' +
      '"how does traverse_graph walk edges" return the entity-bearing memory, which exact ' +
      '`entity_text = ? COLLATE NOCASE` cannot. Measured (10 prose queries, k=10): recall@10 1.000, MRR 1.000 vs ' +
      'recall@10 0.000 for the shipped path; median 0.13ms / p95 0.44ms. See eval/reports/index-lexical.md.',
  },
  'graph-fused': {
    label: 'graph-fused',
    features: { graph_namespace_scope: true, graph_edge_weights: true },
    notes:
      'Namespace-scoped, similarity-weighted graph walk: pprSearch/traverseGraph accept namespace_subtree/project_path, ' +
      'weight transitions by memory_links.similarity (out-degree fallback) and return real link_type/hops. ' +
      'Measured (8 seeds with cross-project _autoLink edges): leakRate 0.333 unscoped -> 0.000 scoped; ' +
      'hub-above-leaf ranking 8/8 with similarity weights. See eval/reports/index-lexical.md. ' +
      'INERT FOR RETRIEVAL (by design, wired nowhere): the graph is not a retrieval channel, so these two flags ' +
      'are read by no code path under hybridSearch/recall — only an explicit traverse/ppr call honours them. ' +
      'Running this config through the harness therefore reports baseline numbers, not a graph effect ' +
      '(eval/reports/wiring.md).',
  },
}
