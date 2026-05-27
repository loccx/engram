import { logger } from '../utils/logger.js'

export type JobHandler = (memoryId: string) => Promise<void>

export interface AdjudicationJob {
  memoryId: string
  promise: Promise<void>
}

export interface QueueOptions {
  maxConcurrency?: number
  onError?: (memoryId: string, err: unknown) => void
}

export class AdjudicationQueue {
  private readonly handler: JobHandler
  private readonly maxConcurrency: number
  private readonly onError: (memoryId: string, err: unknown) => void
  private readonly pending = new Map<string, Promise<void>>()
  private inflight = 0
  private waiting: Array<{ memoryId: string; resolve: () => void; reject: (e: unknown) => void }> = []
  private draining = false

  constructor(handler: JobHandler, options: QueueOptions = {}) {
    this.handler = handler
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 2)
    this.onError =
      options.onError ?? ((memoryId, err) => logger.warn({ memoryId, err }, 'adjudication job failed'))
  }

  enqueue(memoryId: string): AdjudicationJob {
    if (this.draining) {
      const noop = Promise.resolve()
      return { memoryId, promise: noop }
    }
    const existing = this.pending.get(memoryId)
    if (existing) return { memoryId, promise: existing }

    const promise = new Promise<void>((resolve, reject) => {
      this.waiting.push({ memoryId, resolve, reject })
      this.pump()
    }).finally(() => {
      this.pending.delete(memoryId)
    })

    this.pending.set(memoryId, promise)
    return { memoryId, promise }
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
      void this.run(next.memoryId)
        .then(() => next.resolve())
        .catch((err) => {
          this.onError(next.memoryId, err)
          next.resolve()
        })
        .finally(() => {
          this.inflight--
          this.pump()
        })
    }
  }

  private async run(memoryId: string): Promise<void> {
    await this.handler(memoryId)
  }
}

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
