import type { Migration } from './types.js'
import { migration001 } from './001_namespace_supersession_metadata.js'
import { migration002 } from './002_importance_provenance.js'
import { migration003 } from './003_bitemporal.js'
import { migration004 } from './004_clusters.js'
import { migration005 } from './005_adjudication_state.js'
import { migration006 } from './006_brain_support.js'
import { migration007 } from './007_project_digests.js'
import { migration008 } from './008_provenance_revisions.js'
import { migration009 } from './009_maintenance_jobs.js'

export const migrations: Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008, migration009]

export { runMigrations } from './runner.js'
export type { MigrationRunResult } from './runner.js'
export type { Migration } from './types.js'
