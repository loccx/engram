import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import { isLlmConfigured } from '../llm/client.js'
import { AdjudicationQueue } from './queue.js'
import { adjudicateMemory } from './adjudicator.js'

let cachedQueue: AdjudicationQueue | null | undefined

export function getAdjudicationQueue(
  db: Database.Database,
  vectorsAvailable: boolean
): AdjudicationQueue | null {
  if (cachedQueue !== undefined) return cachedQueue
  if (!isLlmConfigured()) {
    cachedQueue = null
    return null
  }
  cachedQueue = new AdjudicationQueue(
    async (memoryId) => {
      const result = await adjudicateMemory(db, memoryId, { vectorsAvailable })
      if (result.status === 'ok' && result.linksWritten > 0) {
        logger.info(
          { memoryId, linksWritten: result.linksWritten },
          'adjudicator: wrote supersedes links'
        )
      }
    },
    { maxConcurrency: 2 }
  )
  return cachedQueue
}

export async function drainAdjudicationQueue(): Promise<void> {
  if (cachedQueue) await cachedQueue.drain()
}

export function resetAdjudicationQueueForTests(): void {
  cachedQueue = undefined
}
