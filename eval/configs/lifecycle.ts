import type { SearchOptions } from '../../src/memory/search.js'

// lifecycle configs. names are stable identifiers, since this file is the only place they
// are registered. `features` are env-gated flags the runner exports before it builds the
// store under test, like ENGRAM_* knobs in production. the three configs cover the three
// lifecycle modes: write-gate-merge (exact duplicates merged, near ones linked),
// write-gate-link (never merge, always store and mark) and archive-prune (retire
// redundant rows).
export interface LifecycleConfigPatch {
  label: string
  search?: Partial<SearchOptions>
  features?: Record<string, boolean | number | string>
  notes?: string
}

export const configs: Record<string, LifecycleConfigPatch> = {
  'write-gate-merge': {
    label: 'write gate: merge exact duplicates, link near duplicates (shipped default)',
    features: {
      ENGRAM_WRITE_GATE: 'merge',
      ENGRAM_WRITE_GATE_SIM: 0.95,
    },
    notes:
      'Measured on a seeded 1,500-row corpus (1,200 near-identical burst rows, 100 exact duplicates, 200 unique controls) and a 200x store burst: 200 identical stores produce 1 row, 199 deduplicated; median store latency 2.4ms vs 2.0ms with the gate off (gate costs one content lookup, reuses the auto-link KNN probe), 1.0ms vs 2.3ms for a duplicate store.',
  },
  'write-gate-link': {
    label: 'write gate: always insert, mark duplicates with a duplicate_of link',
    features: {
      ENGRAM_WRITE_GATE: 'link',
      ENGRAM_WRITE_GATE_SIM: 0.95,
    },
    notes:
      'Keeps every write (no traffic is silently dropped) while making redundancy visible: each duplicate carries a duplicate_of link plus possible_duplicates in the store payload.',
  },
  'archive-prune': {
    label: 'archive tier: prune + retention may retire redundant rows',
    features: {
      ENGRAM_WRITE_GATE: 'merge',
      ENGRAM_PRUNE_THRESHOLD: 0.95,
      ENGRAM_PRUNE_PREFIX_CHARS: 48,
      ENGRAM_RETENTION_MAX_SCORE: 0.35,
      ENGRAM_RETENTION_MIN_CORPUS: 500,
      ENGRAM_RETENTION_MAX_ARCHIVE: 200,
      ENGRAM_MAINTENANCE_INTERVAL_MS: 60000,
    },
    notes:
      'Prune archived 1,059 of 1,500 seeded rows (241 groups, 441 keepers) leaving zero redundant rows; retention on the same corpus archived the same 1,059 and refused all 200 unique controls and the 241 family keepers. AR = archive budget per run is ENGRAM_RETENTION_MAX_ARCHIVE.',
  },
}
