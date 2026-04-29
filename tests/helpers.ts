import { DatabaseManager } from '../src/db/init.js'

export function createTestDb(): { db: import('better-sqlite3').Database; vectorsAvailable: boolean } {
  const manager = new DatabaseManager(':memory:')
  return { db: manager.db, vectorsAvailable: manager.vectorsAvailable }
}
