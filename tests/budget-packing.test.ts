import { describe, it, expect, beforeEach } from 'vitest'
import {
  DIGEST_BUDGET_SHARE,
  digestReserve,
  digestShare,
  packWithinBudget,
} from '../src/memory/recall.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { getDatabase, resetDatabase } from '../src/db/init.js'

// a flat digest reserve starved a small budget: the payload section got a
// minority share and the digest was still truncated anyway

const TEST_PROJECT = '/home/user/budget-project'

interface Packed {
  budget: { total_chars: number; used_chars: number; per_section: { digest: number; memories: number; topics: number } }
  dropped: { memories: number; topics: number; digest_chars_cut: number }
  truncated: { digest: boolean; memories: number; topics: number }
  memories: Array<{ content: string }>
}

function corpus(): { digest: string; memories: Array<{ content: string }> } {
  return {
    digest: Array.from({ length: 60 }, (_, i) => `- fact ${i}: ${'d'.repeat(94)}`).join('\n'),
    memories: Array.from({ length: 10 }, (_, i) => ({
      content: `memory ${i} ${'m'.repeat(590)}`,
    })),
  }
}

// the flat reserve, kept here to compare against
function legacyDigestReserve(budgetChars: number, digestLen: number): number {
  return Math.min(digestLen, Math.floor(budgetChars * DIGEST_BUDGET_SHARE))
}

describe('adaptive digest reserve', () => {
  it('tapers from 10% at small budgets to the 40% cap at large budgets', () => {
    expect(digestShare(100)).toBeCloseTo(0.1, 5)
    expect(digestShare(400)).toBeCloseTo(0.1, 5)
    expect(digestShare(1000)).toBeCloseTo(0.1, 5)
    expect(digestShare(4000)).toBeCloseTo(DIGEST_BUDGET_SHARE, 5)
    expect(digestShare(50_000)).toBeCloseTo(DIGEST_BUDGET_SHARE, 5)
    expect(digestShare(2500)).toBeGreaterThan(0.1)
    expect(digestShare(2500)).toBeLessThan(DIGEST_BUDGET_SHARE)
  })

  it('never reserves more than the digest needs', () => {
    expect(digestReserve(8000, 100)).toBe(100)
    expect(digestReserve(8000, 10_000)).toBe(Math.floor(8000 * DIGEST_BUDGET_SHARE))
    expect(digestReserve(400, 6000)).toBe(40)
  })

  it('is a strict no-op at and above the full-share budget', () => {
    for (const budget of [4000, 8000, 20_000]) {
      expect(digestReserve(budget, 6000)).toBe(legacyDigestReserve(budget, 6000))
    }
  })

  it('measures the starvation it fixes at a 400-char budget', () => {
    const { digest, memories } = corpus()
    const budget = 400

    const legacyAlloc = legacyDigestReserve(budget, digest.length)
    const newAlloc = digestReserve(budget, digest.length)
    const packed = packWithinBudget({ budget_chars: budget, digest, memories, topics: [] })

    expect(legacyAlloc).toBe(160)
    expect(newAlloc).toBe(40)
    const legacyMemoryChars = budget - (legacyAlloc + 1)
    expect(packed.budget.per_section.memories).toBeGreaterThan(legacyMemoryChars)
    expect(packed.budget.per_section.memories).toBeGreaterThan(239)
    expect(packed.budget.used_chars).toBeLessThanOrEqual(budget)
    expect(packed.dropped.memories).toBeGreaterThan(0)
    expect(packed.truncated.memories).toBe(1)
    expect(packed.dropped.digest_chars_cut).toBeGreaterThan(0)
  })

  it('keeps the whole budget accounting inside the budget at every size', () => {
    const { digest, memories } = corpus()
    for (const budget of [50, 400, 1000, 4000, 8000]) {
      const packed = packWithinBudget({ budget_chars: budget, digest, memories, topics: [] })
      const { digest: d, memories: m, topics: t } = packed.budget.per_section
      expect(packed.budget.used_chars).toBe(d + m + t)
      expect(packed.budget.used_chars).toBeLessThanOrEqual(budget)
    }
  })
})

describe('packWithinBudget', () => {
  it('charges exactly what it emits, including truncation markers', () => {
    const packed = packWithinBudget({
      budget_chars: 100,
      digest: null,
      memories: [{ content: 'a'.repeat(500) }, { content: 'b'.repeat(500) }],
      topics: [],
    })
    expect(packed.memories).toHaveLength(1)
    expect(packed.memories[0].content).toHaveLength(100)
    expect(packed.memories[0].content.endsWith('…')).toBe(true)
    expect(packed.budget.used_chars).toBe(100)
    expect(packed.dropped.memories).toBe(1)
    expect(packed.truncated.memories).toBe(1)
  })

  it('packs digest, memories and topics in that order', () => {
    const packed = packWithinBudget({
      budget_chars: 1000,
      digest: 'digest '.repeat(10),
      memories: [{ content: 'memory body' }],
      topics: [{ summary: 'a topic summary' }],
    })
    expect(packed.digest).toBe('digest '.repeat(10))
    expect(packed.memories).toHaveLength(1)
    expect(packed.topics).toHaveLength(1)
    expect(packed.budget.per_section.digest).toBe(70)
    expect(packed.budget.per_section.memories).toBe('memory body'.length)
  })

  it('packs roster previews honestly when given a size hook', () => {
    const roster = [{ id: 'a', preview: 'p'.repeat(40) }, { id: 'b', preview: 'q'.repeat(40) }]
    const hooks = {
      memorySize: (entry: { preview: string }) => entry.preview.length,
      truncateMemory: (entry: { id: string; preview: string }, keep: number) => ({
        ...entry,
        preview: `${entry.preview.slice(0, keep)}…`,
      }),
    }

    // the second preview is truncated rather than dropped, since the marker fits
    const truncated = packWithinBudget({ budget_chars: 60, digest: null, memories: roster, topics: [], ...hooks })
    expect(truncated.memories).toHaveLength(2)
    expect(truncated.budget.used_chars).toBe(60)
    expect(truncated.truncated.memories).toBe(1)
    expect(truncated.memories[1].preview.endsWith('…')).toBe(true)

    const dropped = packWithinBudget({ budget_chars: 56, digest: null, memories: roster, topics: [], ...hooks })
    expect(dropped.memories).toHaveLength(1)
    expect(dropped.budget.used_chars).toBe(40)
    expect(dropped.dropped.memories).toBe(1)
  })
})

describe('budget_chars on the context tools', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  async function seed(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await handleTool('store_memory', {
        content: `Budget probe ${i} ${'z'.repeat(400)}`,
        project_path: TEST_PROJECT,
      })
    }
  }

  it('omitting budget_chars keeps the shipped shape (no budget/dropped keys)', async () => {
    await seed()
    const result = JSON.parse(
      (
        await handleTool('get_context', { project_path: TEST_PROJECT, query: 'budget probe' })
      ).content[0].text
    ) as Record<string, unknown>
    expect(result.budget).toBeUndefined()
    expect(result.dropped).toBeUndefined()
    expect(result.truncated).toBeUndefined()

    const roster = JSON.parse(
      (await handleTool('get_context', { project_path: TEST_PROJECT })).content[0].text
    ) as Record<string, unknown>
    expect(roster.budget).toBeUndefined()
    expect(roster.memories).toBeDefined()
  })

  it('packs the get_context query path to budget_chars and reports the accounting', async () => {
    await seed()
    const result = JSON.parse(
      (
        await handleTool('get_context', {
          project_path: TEST_PROJECT,
          query: 'budget probe',
          budget_chars: 600,
        })
      ).content[0].text
    ) as unknown as Packed & { memories: Array<{ content: string }> }

    expect(result.budget.total_chars).toBe(600)
    expect(result.budget.used_chars).toBeLessThanOrEqual(600)
    expect(result.memories.length).toBeGreaterThan(0)
    expect(result.memories.length).toBeLessThan(4) // a 600-char budget cannot hold four
    expect(result.dropped.memories).toBe(4 - result.memories.length)
  })

  it('packs the get_context roster path to budget_chars by preview length', async () => {
    await seed()
    const result = JSON.parse(
      (
        await handleTool('get_context', { project_path: TEST_PROJECT, budget_chars: 200 })
      ).content[0].text
    ) as unknown as Packed & { memories: Array<{ preview: string }> }

    expect(result.budget.total_chars).toBe(200)
    expect(result.budget.used_chars).toBeLessThanOrEqual(200)
    expect(result.memories.every((m) => !('content' in m))).toBe(true)
  })

  it('packs search_memories to budget_chars in rank order', async () => {
    await seed()
    const result = JSON.parse(
      (
        await handleTool('search_memories', {
          project_path: TEST_PROJECT,
          query: 'budget probe',
          budget_chars: 500,
          limit: 10,
        })
      ).content[0].text
    ) as unknown as Packed & { results: Array<{ content: string }> }

    expect(result.budget.total_chars).toBe(500)
    expect(result.budget.used_chars).toBeLessThanOrEqual(500)
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.dropped.memories).toBe(4 - result.results.length)
  })
})
