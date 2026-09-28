import type { RetrievalConfigPatch } from '../lib/registry.js'

// surface configs: no ranking knob changes, only the parts of the tool surface that are
// honest and measurable (advertised schema = accepted schema, the retrieval ledger,
// budget accounting, session lifecycle, budget packing). the two genuinely opt-in
// switches are the ledger's query text and the idle-session sweep.
// the type import is type-only on purpose: erased at runtime, so the module imports
// whether or not the eval library is on disk, and still type-checks once it is.
export const configs: Record<string, RetrievalConfigPatch> = {
  'surface-telemetry': {
    label: 'surface: retrieval ledger + recall budget accounting',
    features: { ENGRAM_LOG_QUERIES: '1' },
    notes:
      'Default. Every search_memories / get_context / recall_context call writes one retrieval_events row: query text, returned ids, latency, mode, namespace, and the recall budget accounting (dropped memories/topics, digest chars cut, truncated sections). Without it, a retrieval miss is invisible (the coarse engram_events.hit only says "something came back").',
  },
  'surface-telemetry-noquery': {
    label: 'surface: retrieval ledger, query length only',
    features: { ENGRAM_LOG_QUERIES: '0' },
    notes:
      'Privacy mode: the query string is never written (the row keeps its length, the returned ids, latency and budget accounting). Use when query text must not be persisted; miss diagnosis then relies on the recorded result ids rather than the query text.',
  },
  'surface-no-idle-sweep': {
    label: 'surface: idle-session sweep disabled',
    features: { ENGRAM_SESSION_IDLE_MS: '0' },
    notes:
      'A run that keeps writing for longer than the idle window (default 12h) would otherwise rotate sessions mid-run and enqueue end-of-session maintenance. Set for long deterministic runs; leave unset to exercise the lifecycle that gates digest/cluster/importance/adjudication and navigation refreshes.',
  },
}
