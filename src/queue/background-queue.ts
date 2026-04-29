import { logger } from '../utils/logger.js'

export type JobHandler<TKey extends string = string> = (key: TKey) => Promise<void>

export interface BackgroundJob<TKey extends string = string> {
  key: TKey
  promise: Promise<void>
}

export interface BackgroundQueueOptions<TKey extends string = string> {
  /** Concurrency cap; defaults to 2. Minimum 1. */
  maxConcurrency?: number
  /** Optional logger label used when the default onError fires. */
  name?: string
  /** Custom failure handler. Default: log a warn with key + err. */
  onError?: (key: TKey, err: unknown) => void
}

/**
 * Generic background job queue with coalesce-by-key, bounded concurrency, drain,
 * and best-effort error isolation.
 *
 * - enqueue(key) returns a {key, promise} pair. If a job for that key is already
 *   pending, returns the existing promise (coalescing).
 * - During drain, new enqueue calls return an immediately-resolved promise; this
 *   prevents enqueue→hang during shutdown.
 * - Failures are caught and routed to onError; the per-job promise still resolves
 *   (never rejects) so awaiting consumers don't crash.
 *
 * Used by both contradiction adjudication and importance scoring.
 */
export class BackgroundJobQueue<TKey extends string = string> {
  private readonly handler: JobHandler<TKey>
  private readonly maxConcurrency: number
  private readonly onError: (key: TKey, err: unknown) => void
  private readonly pending = new Map<TKey, Promise<void>>()
  private inflight = 0
  private waiting: Array<{ key: TKey; resolve: () => void; reject: (e: unknown) => void }> = []
  private draining = false

  constructor(handler: JobHandler<TKey>, options: BackgroundQueueOptions<TKey> = {}) {
    this.handler = handler
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 2)
    const name = options.name ?? 'background-job'
    this.onError =
      options.onError ?? ((key, err) => logger.warn({ key, err, queue: name }, `${name} failed`))
  }

  enqueue(key: TKey): BackgroundJob<TKey> {
    if (this.draining) {
      const noop = Promise.resolve()
      return { key, promise: noop }
    }
    const existing = this.pending.get(key)
    if (existing) return { key, promise: existing }

    const promise = new Promise<void>((resolve, reject) => {
      this.waiting.push({ key, resolve, reject })
      this.pump()
    }).finally(() => {
      this.pending.delete(key)
    })

    this.pending.set(key, promise)
    return { key, promise }
  }

  size(): number {
    return this.pending.size
  }

  async drain(): Promise<void> {
    this.draining = true
    const all = Array.from(this.pending.values())
    await Promise.allSettled(all)
  }

  reset(): void {
    this.pending.clear()
    this.waiting = []
    this.inflight = 0
    this.draining = false
  }

  private pump(): void {
    while (this.inflight < this.maxConcurrency && this.waiting.length > 0) {
      const next = this.waiting.shift()!
      this.inflight++
      void this.run(next.key)
        .then(() => next.resolve())
        .catch((err) => {
          this.onError(next.key, err)
          next.resolve()
        })
        .finally(() => {
          this.inflight--
          this.pump()
        })
    }
  }

  private async run(key: TKey): Promise<void> {
    await this.handler(key)
  }
}

/**
 * Race a promise against a wall-clock deadline. Returns null on timeout
 * (without rejecting the inner promise's failure modes).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      logger.debug({ ms, label }, 'timeout reached, returning null')
      resolve(null)
    }, ms)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}
