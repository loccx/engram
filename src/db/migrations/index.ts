import type { Migration } from './types.js'
import { migration001 } from './001_namespace_supersession_metadata.js'

export const migrations: Migration[] = [migration001]

export { runMigrations } from './runner.js'
export type { MigrationRunResult } from './runner.js'
export type { Migration } from './types.js'
