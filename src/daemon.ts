import { serve } from '@hono/node-server'
import { createServer } from './server.js'
import { writePid, removePid } from './utils/pid.js'
import { resolveAuthRequirement, TOKEN_ENV } from './mcp/auth.js'
import { hasLivePrincipals } from './mcp/principals.js'
import { logger } from './utils/logger.js'
import { getDatabase } from './db/init.js'
import { backfillNamespaces } from './db/workers/backfill.js'
import { backfillLexicalIndex } from './db/workers/lexical-backfill.js'
import { reembedStaleMemories } from './db/workers/reembed.js'
import { MODEL_ID } from './embeddings/pipeline.js'
import { drainAdjudicationQueue, getAdjudicationQueue } from './contradictions/runtime.js'
import { drainImportanceQueue, getImportanceQueue, isImportanceScoringEnabled } from './importance/runtime.js'
import { runClusterWorker } from './memory/cluster-worker.js'
import {
  enqueueEpisodeReembed,
  enqueueNamespaceMaintenance,
  isMaintenanceEnabled,
  releaseOwnedLeases,
  runPendingMaintenanceJobs,
  MAINTENANCE_OWNER,
} from './maintenance/jobs.js'
import {
  armEagerDrain,
  startMaintenanceScheduler,
  type MaintenanceScheduler,
} from './maintenance/scheduler.js'

// module-scoped so the shutdown handler can stop it; started after the boot drain,
// which runs the backlog from while the daemon was down
let maintenanceScheduler: MaintenanceScheduler | null = null

async function runStartupWorkers(): Promise<void> {
  const dbm = getDatabase()
  const log = (msg: string) => logger.info(msg)

  try {
    await backfillNamespaces(dbm.db, { log })
  } catch (err) {
    logger.warn({ err }, 'namespace backfill failed (will retry on next startup)')
  }

  // fills rows written before the identifier index existed; safe to re-run
  try {
    await backfillLexicalIndex(dbm.db, { log, batchSize: 500, pauseMs: 10 })
  } catch (err) {
    logger.warn({ err }, 'identifier index backfill failed (will retry on next startup)')
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

    // the evidence backlog of a deferred ingest: queued, not embedded here, so the job
    // queue's lease and attempts own it like every other maintenance turn
    try {
      const staleEpisodes = (
        dbm.db.prepare("SELECT COUNT(*) as n FROM episodes WHERE embed_state = 'stale'").get() as { n: number }
      ).n
      if (staleEpisodes > 0) {
        logger.info({ staleEpisodes }, 'queueing the vectors of episodes written without one')
        enqueueEpisodeReembed(dbm.db, { source: 'startup' })
      }
    } catch (err) {
      logger.warn({ err }, 'episode re-embed enqueue failed (stale episodes retry on next startup)')
    }
  }

  // enqueue per-namespace jobs, then drain a bounded number: this also reclaims
  // leases that expired while the daemon was down
  
  if (isMaintenanceEnabled()) {
    try {
      const namespaces = enqueueNamespaceMaintenance(dbm.db)
      // the drain has to cover the burst just enqueued: digest + cluster per namespace,
      // plus one navtree job per root. a smaller cap leaves jobs queued on every boot;
      // the ceiling keeps a boot bounded.
      
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

    // armed here, not in the library, so tests and CLI paths keep enqueue pure:
    // the eager drain runs an end_session's burst now, not up to an interval later
    try {
      maintenanceScheduler = startMaintenanceScheduler(dbm.db)
      armEagerDrain(true)
      logger.info(
        { intervalMs: maintenanceScheduler.intervalMs, started: maintenanceScheduler.started },
        'maintenance: scheduler started'
      )
    } catch (err) {
      logger.warn({ err }, 'maintenance: scheduler failed to start (jobs still run at next boot)')
    }
  }
}

/** loopback unless ENGRAM_ALLOW_NONLOCAL=1, which binds every interface and turns auth on */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGRAM_ALLOW_NONLOCAL === '1' ? '0.0.0.0' : '127.0.0.1'
}

export async function startDaemon(port: number = 8888): Promise<void> {
  try {
    getDatabase()
    logger.info('Database initialized')
  } catch (e) {
    logger.error({ error: e }, 'Failed to initialize database')
    process.exit(1)
  }

  const hostname = resolveBindHost()
  const auth = resolveAuthRequirement(hostname)
  // a store with principals authenticates that way, so the install token is one option
  // among the credentials rather than the only one
  const principalBacked = auth.error !== undefined && hasLivePrincipals(getDatabase().db)
  if (auth.error && !principalBacked) {
    console.error(`engram: refusing to start. ${auth.error}`)
    process.exit(1)
  }

  const app = createServer({ requireAuth: auth.required })
  writePid(process.pid)

  if (auth.required) {
    const where = principalBacked
      ? 'the store holds principals, so a principal token is accepted'
      : auth.source === 'env'
        ? TOKEN_ENV
        : auth.path
    console.log(`Auth:   every request on ${hostname} needs a bearer token (${where})`)
  }
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    logger.info({ port: info.port }, 'Engram daemon started')
    console.log(`Engram daemon running on http://localhost:${info.port}`)
    console.log(`Health: http://localhost:${info.port}/health`)
    console.log(`MCP:    http://localhost:${info.port}/mcp`)
    void runStartupWorkers()
  })

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Engram daemon')
    try {
      armEagerDrain(false)
      maintenanceScheduler?.stop()
      maintenanceScheduler = null
    } catch (err) {
      logger.warn({ err }, 'maintenance: stopping the scheduler failed')
    }
    try {
      // hand back held jobs, so a clean exit leaves only expired leases for the next boot
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
