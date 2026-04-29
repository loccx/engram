import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import { isLlmConfigured } from '../llm/client.js'
import { BackgroundJobQueue } from '../queue/background-queue.js'
import { scoreImportance } from './scorer.js'

let cachedQueue: BackgroundJobQueue<string> | null | undefined

export function isImportanceScoringEnabled(): boolean {
  if (process.env.ENGRAM_IMPORTANCE_DISABLED?.trim() === '1') return false
  return isLlmConfigured()
}

export function getImportanceQueue(db: Database.Database): BackgroundJobQueue<string> | null {
  if (cachedQueue !== undefined) return cachedQueue
  if (!isImportanceScoringEnabled()) {
    cachedQueue = null
    return null
  }

  cachedQueue = new BackgroundJobQueue<string>(
    async (memoryId) => {
      await runScoringJob(db, memoryId)
    },
    {
      maxConcurrency: 2,
      name: 'importance-scoring',
    }
  )
  return cachedQueue
}

export async function drainImportanceQueue(): Promise<void> {
  if (cachedQueue) await cachedQueue.drain()
}

export function resetImportanceQueueForTests(): void {
  cachedQueue = undefined
}

async function runScoringJob(db: Database.Database, memoryId: string): Promise<void> {
  const row = db
    .prepare('SELECT id, content, type, tags, importance_source FROM memories WHERE id = ?')
    .get(memoryId) as
    | { id: string; content: string; type: string; tags: string; importance_source: string }
    | undefined

  if (!row) {
    logger.debug({ memoryId }, 'importance: memory not found, skipping')
    return
  }

  if (row.importance_source === 'user') {
    logger.debug({ memoryId }, 'importance: user-provided, skipping')
    return
  }

  let tags: string[] = []
  try {
    const parsed = JSON.parse(row.tags)
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    // tags column corrupt; proceed without
  }

  const score = await scoreImportance({ content: row.content, type: row.type, tags })

  const now = Date.now()
  const result = db
    .prepare(
      `UPDATE memories
       SET importance = ?,
           importance_source = 'llm',
           importance_model = ?,
           importance_prompt_version = ?,
           importance_scored_at = ?
       WHERE id = ? AND importance_source != 'user'`
    )
    .run(score.importance, score.model, score.promptVersion, now, memoryId)

  if (result.changes === 0) {
    logger.debug(
      { memoryId },
      'importance: row gone or became user-provided between read and write'
    )
  } else {
    logger.info(
      { memoryId, importance: score.importance, model: score.model },
      'importance scored'
    )
  }
}
