import { serve } from '@hono/node-server'
import { createServer } from './server.js'
import { writePid, removePid } from './utils/pid.js'
import { logger } from './utils/logger.js'
import { getDatabase } from './db/init.js'
import { backfillNamespaces } from './db/workers/backfill.js'
import { reembedStaleMemories } from './db/workers/reembed.js'
import { MODEL_ID } from './embeddings/pipeline.js'
import { drainAdjudicationQueue } from './contradictions/runtime.js'

async function runStartupWorkers(): Promise<void> {
  const dbm = getDatabase()
  const log = (msg: string) => logger.info(msg)

  try {
    await backfillNamespaces(dbm.db, { log })
  } catch (err) {
    logger.warn({ err }, 'namespace backfill failed (will retry on next startup)')
  }

  if (dbm.vectorsAvailable) {
    try {
      const staleCount = (
        dbm.db.prepare("SELECT COUNT(*) as n FROM memories WHERE embed_state = 'stale'").get() as { n: number }
      ).n
      if (staleCount > 0) {
        logger.info({ staleCount }, 're-embedding stale memories in background')
        await reembedStaleMemories(dbm.db, MODEL_ID, { log })
      }
    } catch (err) {
      logger.warn({ err }, 're-embed worker failed (stale memories will retry on next startup)')
    }
  }
}

export async function startDaemon(port: number = 8888): Promise<void> {
  try {
    getDatabase()
    logger.info('Database initialized')
  } catch (e) {
    logger.error({ error: e }, 'Failed to initialize database')
    process.exit(1)
  }

  const app = createServer()
  writePid(process.pid)

  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, 'Engram daemon started')
    console.log(`Engram daemon running on http://localhost:${info.port}`)
    console.log(`Health: http://localhost:${info.port}/health`)
    console.log(`MCP:    http://localhost:${info.port}/mcp`)
    void runStartupWorkers()
  })

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Engram daemon')
    try {
      await Promise.race([
        drainAdjudicationQueue(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ])
    } catch (err) {
      logger.warn({ err }, 'error draining adjudication queue on shutdown')
    }
    removePid()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
