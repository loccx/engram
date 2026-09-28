import { BackgroundJobQueue, withTimeout as bgWithTimeout } from '../queue/background-queue.js'
import type { BackgroundQueueOptions, JobHandler as BgJobHandler } from '../queue/background-queue.js'

export type JobHandler = BgJobHandler<string>

export interface AdjudicationJob {
  memoryId: string
  promise: Promise<void>
}

export interface QueueOptions {
  maxConcurrency?: number
  onError?: (memoryId: string, err: unknown) => void
}

export class AdjudicationQueue {
  private readonly inner: BackgroundJobQueue<string>

  constructor(handler: JobHandler, options: QueueOptions = {}) {
    const innerOptions: BackgroundQueueOptions<string> = {
      maxConcurrency: options.maxConcurrency,
      name: 'adjudication',
    }
    if (options.onError) innerOptions.onError = options.onError
    this.inner = new BackgroundJobQueue<string>(handler, innerOptions)
  }

  enqueue(memoryId: string): AdjudicationJob {
    const job = this.inner.enqueue(memoryId)
    return { memoryId: job.key, promise: job.promise }
  }

  size(): number {
    return this.inner.size()
  }

  async drain(): Promise<void> {
    await this.inner.drain()
  }

  reset(): void {
    this.inner.reset()
  }
}

export const withTimeout = bgWithTimeout
