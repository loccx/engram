import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'

// the ticker that makes the durable job queue run on a long-lived daemon: jobs
// otherwise sat until a restart or a manual run_pending_maintenance. eager drains
// after an enqueue burst are armed by the daemon only, so a library/test caller
// keeps enqueue deterministic.

export const DEFAULT_MAINTENANCE_INTERVAL_MS = 60000

export interface MaintenanceDrainResult {
  claimed: number
  done: number
  failed: number
}

export interface MaintenanceScheduler {
  readonly intervalMs: number
  readonly started: boolean
  stop(): void
  ticks(): number
  /** await one drain now (tests and shutdown) */
  drainNow(): Promise<MaintenanceDrainResult | null>
}

export function maintenanceIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ENGRAM_MAINTENANCE_INTERVAL_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAINTENANCE_INTERVAL_MS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAINTENANCE_INTERVAL_MS
  return n
}

let eagerDrainArmed = false
let inFlight: Promise<MaintenanceDrainResult | null> | null = null

export function armEagerDrain(enabled: boolean): void {
  eagerDrainArmed = enabled
}

export function isEagerDrainArmed(): boolean {
  return eagerDrainArmed
}

// lazy on purpose: jobs.ts imports this module, so a static cycle would only work
// by accident of evaluation order
async function loadDrain(): Promise<typeof import('./jobs.js').runPendingMaintenanceJobs> {
  const mod = await import('./jobs.js')
  return mod.runPendingMaintenanceJobs
}

// fire and forget: coalesces to one in-flight drain per process and never rejects
// prettier-ignore
export function requestMaintenanceDrain(db: Database.Database): void {
  if (!eagerDrainArmed) return
  void drainOnce(db).catch((err) => {
    logger.debug({ err }, 'maintenance: eager drain failed (ignored)')
  })
}

async function drainOnce(db: Database.Database): Promise<MaintenanceDrainResult | null> {
  if (inFlight) return inFlight
  const promise = (async () => {
    try {
      const runPending = await loadDrain()
      return await runPending(db)
    } catch (err) {
      logger.debug({ err }, 'maintenance: drain failed (ignored)')
      return null
    }
  })()
  inFlight = promise
  try {
    return await promise
  } finally {
    inFlight = null
  }
}

export interface StartSchedulerOptions {
  intervalMs?: number
  /** injected by tests in place of the coalescing drain */
  drain?: (db: Database.Database) => Promise<MaintenanceDrainResult | null>
  onTick?: (result: MaintenanceDrainResult | null) => void
}

// intervalMs 0 returns a stopped scheduler; the timer is unref'd, so it can never
// be the reason a process stays alive
export function startMaintenanceScheduler(
  db: Database.Database,
  opts: StartSchedulerOptions = {}
): MaintenanceScheduler {
  const intervalMs = opts.intervalMs ?? maintenanceIntervalMs()
  let tickCount = 0
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const drainNow = async (): Promise<MaintenanceDrainResult | null> => {
    if (stopped) return null
    const result = opts.drain ? await opts.drain(db) : await drainOnce(db)
    return result
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      if (stopped || inFlight) return
      void drainNow()
        .then((result) => {
          tickCount++
          if (result && (result.claimed > 0 || result.failed > 0)) {
            logger.debug({ ...result }, 'maintenance: scheduled drain ran jobs')
          }
          opts.onTick?.(result)
        })
        .catch((err) => {
          logger.warn({ err }, 'maintenance: scheduled drain failed')
        })
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  return {
    intervalMs,
    started: intervalMs > 0,
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
    },
    ticks: () => tickCount,
    drainNow,
  }
}
