import { describe, expect, it } from 'vitest'
import {
  defaultSystemNames,
  noMemorySystem,
  systemNames,
  type SystemDeps,
} from '../eval/lib/systems.js'

describe('query-only memory-off control', () => {
  it('is opt-in and leaves existing default comparisons unchanged', () => {
    expect(systemNames()).toContain('no-memory')
    expect(defaultSystemNames()).toEqual(['engram', 'full-context', 'naive-rag'])
  })

  it('never reads the shared store or serves supplied history, at any budget', async () => {
    const deps = new Proxy({} as SystemDeps, {
      get() { throw new Error('memory-off must not consult shared memory') },
    })
    const system = noMemorySystem.create(deps)
    await system.reset('/fixture/a')
    await system.ingest('/fixture/a', [
      { id: 'answer', text: 'the fixture code is violet', createdAt: 1 },
    ])
    await system.ingest('/fixture/b', [{ id: 'distractor', text: 'the fixture code is amber' }])
    for (const budget of [0, 50, 2000, 32000]) {
      const result = await system.retrieve('/fixture/a', 'what is the fixture code?', budget)
      expect(result.context).toBe('')
      expect(result.blocks).toEqual([])
      expect(result.items).toEqual([])
      expect(result.retrievalMs).toBe(0)
      expect(result.note).toContain('memory disabled')
    }
    expect(system.cost()).toEqual({ writeCalls: 0, writeTokens: 0 })
    expect(system.lexicalOnly).toBe(true)
    await system.reset('/fixture/a')
    expect((await system.retrieve('/fixture/b', 'fixture code', 32000)).context).toBe('')
    await system.close()
  })
})
