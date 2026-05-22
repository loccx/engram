import type { Migration } from './types.js'
import { migration001 } from './001_namespace_supersession_metadata.js'
import { migration002 } from './002_importance_provenance.js'
import { migration003 } from './003_bitemporal.js'
import { migration004 } from './004_clusters.js'

export const migrations: Migration[] = [migration001, migration002, migration003, migration004]

export { runMigrations } from './runner.js'
export type { MigrationRunResult } from './runner.js'
export type { Migration } from './types.js'
