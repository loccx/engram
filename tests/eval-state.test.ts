import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runStateSuite, type StateArmMetrics } from '../eval/suites/state.js'
import { buildStateArms, valueIndexAt, STATE_NOW } from '../eval/lib/state-corpus.js'
import { resolveConfigs } from '../eval/lib/registry.js'
import { buildHeader } from '../eval/lib/report.js'
import type { SuiteContext } from '../eval/suites/types.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'engram-eval-state-'))
}

function suiteContext(dir: string, overrides: Partial<SuiteContext> = {}): SuiteContext {
  return {
    seed: 1234,
    configs: resolveConfigs([]),
    vectors: 'fts',
    qa: false,
    outDir: dir,
    gitSha: 'testsha',
    buildHeader: (input) => buildHeader({ ...input, git: undefined }),
    log: () => {},
    ...overrides,
  }
}

describe('state corpus', () => {
  it('builds the three arms over the same facts', () => {
    const arms = buildStateArms()
    expect(arms.map((a) => a.name)).toEqual(['keyed', 'chained', 'unlinked'])
    for (const arm of arms) {
      expect(arm.corpus.memories).toHaveLength(arm.facts.length * 3)
      expect(arm.corpus.queries).toHaveLength(arm.facts.length + 8 + 6)
      const latest = arm.facts.map((fact, index) => {
        const query = arm.corpus.queries.find((q) => q.id === `state-current-f${index}`)!
        return query.target_ids[0] === `state-f${index}-v2`
      })
      expect(latest.every(Boolean)).toBe(true)
      const current = arm.corpus.queries.filter((q) => q.kind === 'current')
      expect(current.every((q) => (q.must_not_retrieve ?? []).length === 2)).toBe(true)
    }
  })

  it('tells the write path about the change only in the keyed and chained arms', () => {
    const [keyed, chained, unlinked] = buildStateArms()
    expect(keyed.corpus.memories.every((m) => typeof m.state_key === 'string')).toBe(true)
    expect(keyed.corpus.memories.filter((m) => m.valid_until).length).toBe(
      keyed.facts.length * 2
    )
    expect(chained.corpus.memories.every((m) => m.state_key === undefined)).toBe(true)
    expect(chained.corpus.memories.filter((m) => m.superseded_by).length).toBe(
      chained.facts.length * 2
    )
    expect(unlinked.corpus.memories.every((m) => m.superseded_by === undefined)).toBe(true)
    expect(unlinked.corpus.memories.every((m) => m.valid_until === undefined)).toBe(true)
  })

  it('asks as-of questions about the value that was true then, per fact', () => {
    const [keyed] = buildStateArms()
    for (const query of keyed.corpus.queries.filter((q) => q.kind === 'as-of')) {
      const factIndex = Number(/f(\d+)$/.exec(query.id)![1])
      const expected = valueIndexAt(factIndex, query.as_of!)
      expect(query.target_ids).toEqual([`state-f${factIndex}-v${expected}`])
      expect(query.must_not_retrieve).toHaveLength(2)
      expect(query.must_not_retrieve).not.toContain(`state-f${factIndex}-v${expected}`)
    }
    // a fact whose first value lands after the probe has no value at that instant
    expect(valueIndexAt(11, keyed.asOf)).toBe(-1)
    expect(STATE_NOW).toBeGreaterThan(keyed.asOf)
  })
})

describe('state suite run', () => {
  it('separates the arms that track the change from the one that does not', async () => {
    const dir = tempDir()
    try {
      const output = await runStateSuite(suiteContext(dir))
      const metrics = output.result.metrics as Record<string, StateArmMetrics>
      const keyed = metrics['baseline/keyed']
      const chained = metrics['baseline/chained']
      const unlinked = metrics['baseline/unlinked']

      expect(output.result.header.suite).toBe('state')

      // the value that has been replaced is never served once the change is recorded
      expect(keyed.retrieval.staleRate).toBe(0)
      expect(chained.retrieval.staleRate).toBe(0)
      expect(unlinked.retrieval.staleRate).toBeGreaterThan(0)

      // ranking does not reveal it: every arm puts the newest value first
      expect(keyed.latestAt1).toBe(1)
      expect(unlinked.latestAt1).toBe(1)
      expect(keyed.retrieval['recall@1']).toBe(unlinked.retrieval['recall@1'])

      // the slot layer does
      expect(keyed.state.currentAccuracy).toBe(1)
      expect(keyed.state.priorAccuracy).toBe(1)
      expect(keyed.state.asOfAccuracy).toBe(1)
      expect(chained.state.currentAccuracy).toBe(1)
      expect(chained.state.slotCoverage).toBe(1)
      expect(unlinked.state.slotCoverage).toBe(0)
      expect(unlinked.state.currentAccuracy).toBe(0)

      // the chain backfill is what makes an unkeyed arm answerable at all
      expect(output.result.notes.join('\n')).toContain('existing chains named by the backfill')

      // trajectory probes still see every value
      expect(keyed.byKind.trajectory['recall@5']).toBe(1)
      expect(unlinked.byKind.current.staleRate).toBeGreaterThan(0)

      // thresholds are reported per arm, so --assert can gate them
      expect(Object.keys(output.thresholds).sort()).toEqual([
        'baseline/chained',
        'baseline/keyed',
        'baseline/unlinked',
      ])
      expect(output.thresholds['baseline/keyed'].currentAccuracy).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is deterministic: same seed, same metrics', async () => {
    const dir = tempDir()
    const dir2 = tempDir()
    try {
      const first = await runStateSuite(suiteContext(dir))
      const second = await runStateSuite(suiteContext(dir2))
      expect(JSON.stringify(second.result.metrics)).toEqual(JSON.stringify(first.result.metrics))
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})
