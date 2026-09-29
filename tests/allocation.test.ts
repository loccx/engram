import { describe, expect, it } from 'vitest'
import {
  ALLOCATION_POLICIES,
  allocationForQuery,
  allocationPolicyNames,
  orderAllocation,
  packAllocation,
  type AllocationUnit,
} from '../src/memory/allocation.js'

const ctx = { reserveTopHits: 0, sessionOrder: (a: string, b: string) => (a < b ? -1 : 1) }

/** a unit's rendered length is what the packer charges, its rank is where the hit ranked */
const unit = (
  sessionId: string,
  position: number,
  rank: number,
  chars: number,
  role: string | null = null
): AllocationUnit => ({ sessionId, position, rank, chars, role })

describe('allocation policies', () => {
  it('registers the shipped order and the two alternatives, and rejects an unknown name', () => {
    expect(allocationPolicyNames()).toEqual(['rank-greedy', 'breadth-first', 'statements-first'])
    expect(ALLOCATION_POLICIES['rank-greedy'].describe).toContain('best hit rank first')
    expect(() => orderAllocation('deepest-first' as 'rank-greedy', [], ctx)).toThrow(
      /unknown allocation policy "deepest-first"; known: rank-greedy, breadth-first, statements-first/
    )
  })

  it('rank-greedy takes one session at a time, best hit rank first, turns in order', () => {
    const units = [
      unit('s-b', 5, 1, 10),
      unit('s-a', 2, 0, 10),
      unit('s-b', 6, 1, 10),
      unit('s-a', 1, 0, 10),
    ]
    expect(orderAllocation('rank-greedy', units, ctx).map((u) => `${u.sessionId}:${u.position}`)).toEqual([
      's-a:1',
      's-a:2',
      's-b:5',
      's-b:6',
    ])
  })

  it('breaks a best-rank tie by session date, then id', () => {
    const dated = {
      reserveTopHits: 0,
      sessionOrder: (a: string, b: string) => (a === 's-old' ? -1 : 1),
    }
    const units = [unit('s-new', 0, 0, 10), unit('s-old', 0, 0, 10)]
    expect(orderAllocation('rank-greedy', units, dated).map((u) => u.sessionId)).toEqual([
      's-old',
      's-new',
    ])
    expect(orderAllocation('rank-greedy', units, ctx).map((u) => u.sessionId)).toEqual([
      's-new',
      's-old',
    ])
  })

  it('breadth-first gives every reached session its densest turn before any session gets a second', () => {
    const units = [
      unit('s-a', 0, 0, 40),
      unit('s-a', 1, 0, 400),
      unit('s-b', 0, 1, 100),
      unit('s-b', 1, 1, 200),
      unit('s-c', 0, 2, 100),
      unit('s-c', 1, 9, 20),
    ]
    const order = orderAllocation('breadth-first', units, ctx)
    // one turn each from s-a, s-b and s-c before any of them is bought twice
    expect(order.slice(0, 3).map((u) => u.sessionId)).toEqual(['s-a', 's-b', 's-c'])
    // a session's own order is by what the turn buys per character: s-c's rank-9 turn is
    // short enough to outrank its rank-2 one
    expect(order.map((u) => `${u.sessionId}:${u.position}`)).toEqual([
      's-a:0',
      's-b:0',
      's-c:1',
      's-c:0',
      's-a:1',
      's-b:1',
    ])
  })

  it('statements-first buys user turns before replies, and the reserve ahead of both', () => {
    const units = [
      unit('s-a', 0, 1, 900, 'assistant'),
      unit('s-a', 1, 2, 80, 'user'),
      unit('s-b', 0, 0, 700, 'assistant'),
    ]
    expect(orderAllocation('statements-first', units, ctx).map((u) => `${u.sessionId}:${u.position}`)).toEqual([
      's-a:1',
      's-b:0',
      's-a:0',
    ])
    expect(
      orderAllocation('statements-first', units, { ...ctx, reserveTopHits: 1 }).map(
        (u) => `${u.sessionId}:${u.position}`
      )
    ).toEqual(['s-b:0', 's-a:1', 's-a:0'])
  })

  it('reserves the top hit windows for a policy that would defer them', () => {
    const units = [
      unit('s-big', 0, 0, 4000),
      unit('s-a', 0, 1, 100),
      unit('s-c', 0, 2, 100),
    ]
    expect(orderAllocation('breadth-first', units, ctx).map((u) => u.sessionId)).toEqual([
      's-a',
      's-c',
      's-big',
    ])
    expect(
      orderAllocation('breadth-first', units, { ...ctx, reserveTopHits: 1 }).map((u) => u.sessionId)
    ).toEqual(['s-big', 's-a', 's-c'])
  })

  it('resolves a recipe policy per query archetype, with no reserve leaking into the default', () => {
    const allocation = {
      default: { policy: 'rank-greedy' as const },
      archetypes: { aggregation: { policy: 'breadth-first' as const, reserveTopHits: 1 } },
    }
    expect(allocationForQuery(allocation, 'how many places did I visit in total?')).toEqual({
      policy: 'breadth-first',
      reserveTopHits: 1,
    })
    expect(allocationForQuery(allocation, 'what did I say about the deploy window')).toEqual({
      policy: 'rank-greedy',
      reserveTopHits: 0,
    })
  })
})

describe('allocation packing', () => {
  it('charges header, separator and newline so usedChars is the rendered length', () => {
    const units = [
      unit('s-a', 0, 0, 4),
      unit('s-a', 1, 1, 4),
      unit('s-b', 0, 2, 4),
    ]
    const packed = packAllocation({
      units,
      headerOf: (sessionId) => `[${sessionId}]`,
      budgetChars: 1000,
    })
    const blocks = packed.groups.map(
      (group) => `[${group.sessionId}]\n${group.units.map(() => 'xxxx').join('\n')}`
    )
    expect(packed.usedChars).toBe(blocks.join('\n\n').length)
    expect(packed.skippedSessions).toBe(0)
  })

  it('skips a turn that does not fit and still pays for a shorter one behind it', () => {
    const units = [unit('s-a', 0, 0, 200), unit('s-a', 1, 1, 20), unit('s-b', 0, 2, 200)]
    const packed = packAllocation({
      units,
      headerOf: (sessionId) => `[${sessionId}]`,
      budgetChars: 300,
    })
    expect(packed.kept.map((unit) => `${unit.sessionId}:${unit.position}`)).toEqual([
      's-a:0',
      's-a:1',
    ])
    expect(packed.skippedSessions).toBe(1)
    expect(packed.usedChars).toBeLessThanOrEqual(300)
  })

  it('opens no group for a session whose first turn cannot pay, and counts it skipped', () => {
    const packed = packAllocation({
      units: [unit('s-a', 0, 0, 500)],
      headerOf: () => '[2023-11-14 22:13 utc]',
      budgetChars: 10,
    })
    expect(packed.groups).toEqual([])
    expect(packed.kept).toEqual([])
    expect(packed.skippedSessions).toBe(1)
    expect(packed.usedChars).toBe(0)
  })
})
