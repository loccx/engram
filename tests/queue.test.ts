import { describe, it, expect } from 'vitest'
import { BackgroundJobQueue, withTimeout } from '../src/queue/background-queue.js'

function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('BackgroundJobQueue', () => {
  describe('enqueue', () => {
    it('runs a handler for each unique key', async () => {
      const seen: string[] = []
      const q = new BackgroundJobQueue<string>(async (key) => {
        seen.push(key)
      })
      await Promise.all([q.enqueue('a').promise, q.enqueue('b').promise, q.enqueue('c').promise])
      expect(seen.sort()).toEqual(['a', 'b', 'c'])
    })

    it('coalesces duplicate keys while in-flight', async () => {
      let runs = 0
      let release: () => void = () => {}
      const block = new Promise<void>((r) => {
        release = r
      })
      const q = new BackgroundJobQueue<string>(async () => {
        runs++
        await block
      })

      const j1 = q.enqueue('same')
      const j2 = q.enqueue('same')
      const j3 = q.enqueue('same')
      expect(j1.promise).toBe(j2.promise)
      expect(j2.promise).toBe(j3.promise)
      expect(q.size()).toBe(1)

      release()
      await j1.promise
      expect(runs).toBe(1)
    })

    it('allows the same key to run again after completion', async () => {
      let runs = 0
      const q = new BackgroundJobQueue<string>(async () => {
        runs++
      })
      await q.enqueue('x').promise
      await q.enqueue('x').promise
      expect(runs).toBe(2)
    })
  })

  describe('concurrency', () => {
    it('respects maxConcurrency', async () => {
      let inflight = 0
      let peak = 0
      const releases: Array<() => void> = []
      const q = new BackgroundJobQueue<string>(
        async () => {
          inflight++
          if (inflight > peak) peak = inflight
          await new Promise<void>((r) => releases.push(r))
          inflight--
        },
        { maxConcurrency: 2 }
      )

      const jobs = ['a', 'b', 'c', 'd'].map((k) => q.enqueue(k))
      // Drain by releasing one slot at a time and yielding so the next job
      // can attach to the releases array before we shift again.
      for (let i = 0; i < 4; i++) {
        while (releases.length === 0) await tick(1)
        expect(inflight).toBeLessThanOrEqual(2)
        releases.shift()!()
        await tick(1)
      }
      await Promise.all(jobs.map((j) => j.promise))
      expect(peak).toBe(2)
    })

    it('clamps maxConcurrency to a minimum of 1', async () => {
      let inflight = 0
      let peak = 0
      const releases: Array<() => void> = []
      const q = new BackgroundJobQueue<string>(
        async () => {
          inflight++
          if (inflight > peak) peak = inflight
          await new Promise<void>((r) => releases.push(r))
          inflight--
        },
        { maxConcurrency: 0 }
      )

      const jobs = ['a', 'b'].map((k) => q.enqueue(k))
      for (let i = 0; i < 2; i++) {
        while (releases.length === 0) await tick(1)
        expect(inflight).toBe(1)
        releases.shift()!()
        await tick(1)
      }
      await Promise.all(jobs.map((j) => j.promise))
      expect(peak).toBe(1)
    })
  })

  describe('error isolation', () => {
    it('routes failures to onError and resolves the per-job promise', async () => {
      const errors: Array<{ key: string; err: unknown }> = []
      const q = new BackgroundJobQueue<string>(
        async (key) => {
          if (key === 'bad') throw new Error('boom')
        },
        { onError: (key, err) => errors.push({ key, err }) }
      )

      const okJob = q.enqueue('ok')
      const badJob = q.enqueue('bad')

      await expect(okJob.promise).resolves.toBeUndefined()
      await expect(badJob.promise).resolves.toBeUndefined()

      expect(errors).toHaveLength(1)
      expect(errors[0].key).toBe('bad')
      expect((errors[0].err as Error).message).toBe('boom')
    })

    it('continues processing the queue after a failure', async () => {
      const ran: string[] = []
      const q = new BackgroundJobQueue<string>(
        async (key) => {
          if (key === 'bad') throw new Error('boom')
          ran.push(key)
        },
        { onError: () => {} }
      )

      await Promise.all([
        q.enqueue('bad').promise,
        q.enqueue('good1').promise,
        q.enqueue('good2').promise,
      ])
      expect(ran.sort()).toEqual(['good1', 'good2'])
    })
  })

  describe('drain', () => {
    it('waits for all in-flight and queued jobs to settle', async () => {
      const completed: string[] = []
      const q = new BackgroundJobQueue<string>(async (key) => {
        await tick(10)
        completed.push(key)
      })

      q.enqueue('a')
      q.enqueue('b')
      q.enqueue('c')
      await q.drain()
      expect(completed.sort()).toEqual(['a', 'b', 'c'])
    })

    it('rejects new enqueues during drain with a no-op promise', async () => {
      const q = new BackgroundJobQueue<string>(async () => {
        await tick(5)
      })
      q.enqueue('inflight')
      const drainPromise = q.drain()
      const lateJob = q.enqueue('late')
      await expect(lateJob.promise).resolves.toBeUndefined()
      await drainPromise
    })
  })

  describe('reset', () => {
    it('clears internal state', () => {
      const q = new BackgroundJobQueue<string>(async () => {
        await tick(100)
      })
      q.enqueue('a')
      q.enqueue('b')
      expect(q.size()).toBe(2)
      q.reset()
      expect(q.size()).toBe(0)
    })
  })
})

describe('withTimeout', () => {
  it('returns the resolved value when promise completes before timeout', async () => {
    const value = await withTimeout(Promise.resolve(42), 100)
    expect(value).toBe(42)
  })

  it('returns null when the promise misses the deadline', async () => {
    const slow = new Promise<number>((r) => setTimeout(() => r(99), 50))
    const value = await withTimeout(slow, 10, 'test')
    expect(value).toBeNull()
  })

  it('propagates rejection from the inner promise', async () => {
    const failing = Promise.reject(new Error('inner failure'))
    await expect(withTimeout(failing, 100)).rejects.toThrow('inner failure')
  })
})
