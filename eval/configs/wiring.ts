// wiring config: the two channels already have env-side configs in
// index-lexical.ts, and this one turns them on through the shipped knobs,
// `SearchOptions.ident_channel` and `entity_channel` — the path a library consumer
// takes. eval/reports/wiring.md has the numbers and the reason they stay off by default.
import type { SearchOptions } from '../../src/memory/search/hybrid.js'

export interface RetrievalConfigPatch {
  label: string
  search?: Partial<SearchOptions>
  features?: Record<string, boolean | number | string>
  notes?: string
}

export const configs: Record<string, RetrievalConfigPatch> = {
  'channels-explicit': {
    label: 'ident + entity channels enabled through SearchOptions (no env)',
    search: { ident_channel: true, entity_channel: true },
    notes:
      'Exercises the shipped-knob path (`SearchOptions.ident_channel`/`entity_channel`, explicit value ' +
      'wins over the env) rather than `features`, which is what `ident-lexical` and `entity-channel` ' +
      'cover. Both channels add one weighted lexical list each; the weight is 1/n over the lists that ' +
      'returned evidence, so a channel with an empty or un-backfilled index changes nothing. Measured on ' +
      'the standard corpora (eval/reports/wiring.md): the identifier channel is metric-neutral there ' +
      '(no probe asks a cross-notation question), and the entity channel matches those corpora only ' +
      'incidentally.',
  },
}
