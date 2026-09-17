import { serve } from '@hono/node-server'
import { createServer } from './server.js'
import { writePid, removePid } from './utils/pid.js'
import { logger } from './utils/logger.js'
import { getDatabase } from './db/init.js'
import { backfillNamespaces } from './db/workers/backfill.js'
import { reembedStaleMemories } from './db/workers/reembed.js'
import { MODEL_ID } from './embeddings/pipeline.js'
import { drainAdjudicationQueue, getAdjudicationQueue } from './contradictions/runtime.js'
import { drainImportanceQueue, getImportanceQueue, isImportanceScoringEnabled } from './importance/runtime.js'
import { runClusterWorker } from './memory/cluster-worker.js'
import {
  enqueueNamespaceMaintenance,
  isMaintenanceEnabled,
  releaseOwnedLeases,
  runPendingMaintenanceJobs,
  MAINTENANCE_OWNER,
} from './maintenance/jobs.js'

async function runStartupWorkers(): Promise<void> {
  const dbm = getDatabase()
  const log = (msg: string) => logger.info(msg)

  try {
    await backfillNamespaces(dbm.db, { log })
  } catch (err) {
    logger.warn({ err }, 'namespace backfill failed (will retry on next startup)')
  }

  if (isImportanceScoringEnabled()) {
    try {
      const unscored = dbm.db
        .prepare("SELECT id FROM memories WHERE importance_source = 'default' LIMIT 100")
        .all() as Array<{ id: string }>
      const queue = getImportanceQueue(dbm.db)
      if (queue && unscored.length > 0) {
        for (const { id } of unscored) queue.enqueue(id)
        logger.info({ count: unscored.length }, 'importance: re-enqueued unscored memories')
      }
    } catch (err) {
      logger.warn({ err }, 'importance replay failed')
    }
  }

  try {
    const pending = dbm.db
      .prepare("SELECT id FROM memories WHERE adjudication_state = 'pending' LIMIT 100")
      .all() as Array<{ id: string }>
    const adjQueue = getAdjudicationQueue(dbm.db, dbm.vectorsAvailable)
    if (adjQueue && pending.length > 0) {
      for (const { id } of pending) adjQueue.enqueue(id)
      logger.info({ count: pending.length }, 'adjudication: re-enqueued pending memories')
    }
  } catch (err) {
    logger.warn({ err }, 'adjudication replay failed')
  }

  try {
    const projects = dbm.db
      .prepare('SELECT DISTINCT COALESCE(namespace, project_path) as p FROM memories')
      .all() as Array<{ p: string }>
    for (const { p } of projects) {
      await runClusterWorker(dbm.db, p)
    }
  } catch (err) {
    logger.warn({ err }, 'cluster worker failed (will retry on next startup)')
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

  // Durable maintenance: enqueue per-namespace shadow jobs, then run a
  // bounded drain. Also reclaims any job whose lease expired while the
  // daemon was down (crash recovery). Shadow-only handlers make this safe.
  if (isMaintenanceEnabled()) {
    try {
      const namespaces = enqueueNamespaceMaintenance(dbm.db)
      // Size the startup drain to the burst we just enqueued: digest + cluster
      // per namespace, plus one navtree consolidation job per forest root. The
      // default cap of 20 sat below the burst (2 per namespace alone) and left
      // jobs queued on every boot; the ceiling keeps a boot bounded.
      const startupBudget = Math.min(Math.max(20, namespaces * 2 + 40), 400)
      const ran = await runPendingMaintenanceJobs(dbm.db, {
        owner: MAINTENANCE_OWNER,
        maxJobs: startupBudget,
      })
      logger.info(
        { namespaces, ...ran },
        'maintenance: startup enqueue + bounded shadow drain complete'
      )
    } catch (err) {
      logger.warn({ err }, 'maintenance: startup drain failed (jobs will retry on next startup)')
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
      // Requeue maintenance jobs this process still holds so a clean exit
      // leaves only recoverable, expired leases for the next startup.
      const released = releaseOwnedLeases(getDatabase().db, MAINTENANCE_OWNER)
      if (released > 0) logger.info({ released }, 'maintenance: released leases on shutdown')
    } catch (err) {
      logger.warn({ err }, 'maintenance: lease release on shutdown failed')
    }
    try {
      await Promise.race([
        Promise.allSettled([drainAdjudicationQueue(), drainImportanceQueue()]),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ])
    } catch (err) {
      logger.warn({ err }, 'error draining background queues on shutdown')
    }
    removePid()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
