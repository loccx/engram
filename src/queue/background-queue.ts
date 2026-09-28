import { logger } from '../utils/logger.js'

export type JobHandler<TKey extends string = string> = (key: TKey) => Promise<void>

export interface BackgroundJob<TKey extends string = string> {
  key: TKey
  promise: Promise<void>
}

export interface BackgroundQueueOptions<TKey extends string = string> {
  /** concurrency cap, default 2 */
  maxConcurrency?: number
  /** logger label for the default onError */
  name?: string
  /** failure handler; the default logs a warn with key and err */
  onError?: (key: TKey, err: unknown) => void
}

/**
 * background job queue: coalesce by key, bounded concurrency, drain, error isolation.
 * enqueue returns the pending promise for that key — an immediately resolved one during
 * a drain, or shutdown would hang — and a failure still resolves the job promise.
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
 * race a promise against a wall-clock deadline: null on timeout, without rejecting the
 * inner promise's own failure modes
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
