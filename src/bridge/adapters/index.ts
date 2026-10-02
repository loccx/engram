// host-bound source adapters are separate from the runtime-neutral bridge barrel.
// the EngramSourcePort requires an explicit trusted CallerScope and already-open source DB;
// neither it nor the core authenticates callers, grants human approval or opens live stores.
export { ENGRAM_SOURCE_PROVIDER, EngramSourcePort } from './engram.js'
export type { EngramSourceOptions } from './engram.js'
