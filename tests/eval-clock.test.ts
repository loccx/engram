// the scoring clock decides what a recency term is even able to say, so it is part of
// what a run means rather than a detail of it.
//
// every recency term is `exp(-age / S)`, so it is a function of the distance between
// the rows' timestamps and the clock the read is evaluated at. LongMemEval rows carry
// their real session dates (2023-04 .. 2023-05) while the harness's fixed epoch is
// 2025-01-01, which put every row ~590 days old: `exp(-590 / 15)` is ~1e-17, far too
// small to move a sum, so the suite scored a lexical-only ranking the shipped system
// never performs. These tests pin both halves: the clock must be movable, and the
// recency term must actually discriminate when the clock sits near the data.
//
// the second test is the negative control for the first: it shows the old fixed epoch
// cannot satisfy the same assertion, so the contract needs a live signal.
import { describe, expect, it } from 'vitest'
import { CORPUS_EPOCH, EvalHarness } from '../eval/lib/harness.js'
import { DEFAULT_DECAY_SCALE_DAYS, ebbinghaus } from '../src/memory/search/scoring.js'
import type { Memory } from '../src/memory/types.js'

const SEED = 1234
const DAY = 24 * 60 * 60 * 1000
/** a plausible dataset timestamp, roughly the LongMemEval session range */
const T0 = Date.UTC(2023, 4, 20, 2, 21)

/** the fields ebbinghaus reads, so a row needs no db */
function row(createdAt: number, importance = 0.5): Memory {
  return {
    id: `row-${createdAt}`,
    session_id: 's',
    project_path: '/ns',
    content: 'x',
    type: 'note',
    importance,
    tags: [],
    created_at: createdAt,
    last_accessed: null,
    access_count: 0,
    vec_rowid: null,
    valid_from: createdAt,
    valid_until: null,
  } as Memory
}

describe('scoring clock', () => {
  it('defaults to the corpus epoch and moves on request', async () => {
    const harness = await EvalHarness.create({ seed: SEED, vectors: 'fts' })
    try {
      expect(harness.now).toBe(CORPUS_EPOCH)
      const moved = T0 + 30 * DAY
      harness.setScoringClock(moved)
      expect(harness.now).toBe(moved)
      // the clock is the value the reads are evaluated at, so moving it must not be
      // a private detail: runRecall/runSearch read `this.now`
      const back = T0
      harness.setScoringClock(back)
      expect(harness.now).toBe(back)
    } finally {
      harness.dispose()
    }
  })

  it('keeps its ordering at any clock but loses the magnitude that makes it count', () => {
    const older = row(T0)
    const newer = row(T0 + 30 * DAY)

    // near the data the newer row scores strictly higher -- the point of the signal
    const nearClock = T0 + 30 * DAY
    expect(ebbinghaus(newer, nearClock)).toBeGreaterThan(ebbinghaus(older, nearClock))

    // the ratio is a function of the rows' AGE DIFFERENCE, not of the clock, so the
    // ordering survives a distant clock: exp(30/15) at the near clock and at the far
    // one alike. That is exactly why the defect is easy to miss.
    const nearRatio = ebbinghaus(newer, nearClock) / ebbinghaus(older, nearClock)
    const farOlder = ebbinghaus(older, CORPUS_EPOCH)
    const farNewer = ebbinghaus(newer, CORPUS_EPOCH)
    expect(farNewer / farOlder).toBeCloseTo(nearRatio, 10)

    // the negative control: what actually collapses is the magnitude, and how far it
    // collapses is the scale's business. at a scale of 30 (S = 15 days) the fixed 2025
    // epoch puts both rows ~590 days old and the term is ~1e-17 against an fts term of
    // order 1: a sum cannot be moved by 1e-17, so the term can only decide an exact tie.
    expect(nearClock - T0).toBeLessThan(100 * DAY)
    expect(ebbinghaus(older, CORPUS_EPOCH, 30)).toBeLessThan(1e-12)
    expect(ebbinghaus(newer, CORPUS_EPOCH, 30)).toBeLessThan(1e-12)

    // at the shipped scale the same distance keeps a small but real share instead of
    // vanishing, so a stale corpus stops being a tie-only regime. the clock still has
    // to sit near the data for the term to mean what it says, which is the contract
    // these tests exist to hold.
    const shipped = ebbinghaus(older, CORPUS_EPOCH, DEFAULT_DECAY_SCALE_DAYS)
    expect(shipped).toBeGreaterThan(1e-3)
    expect(shipped).toBeLessThan(0.05)
  })

  it('moves the recency contribution the real read path sees', async () => {
    const harness = await EvalHarness.create({ seed: SEED, vectors: 'fts' })
    try {
      // two rows, identical content, 30 days apart in one namespace: relevance ties,
      // so only the clock can separate them
      await harness.seedCorpus(
        {
          name: 'clock-contract',
          seed: SEED,
          memories: [
            { id: 'older', namespace: '/ns', content: 'release train cutover', created_at: T0 },
            {
              id: 'newer',
              namespace: '/ns',
              content: 'release train cutover',
              created_at: T0 + 30 * DAY,
            },
          ],
          queries: [],
        },
        { mode: 'raw' }
      )

      const scoreOf = async (id: string, now: number): Promise<number> => {
        harness.setScoringClock(now)
        const results = await harness.runSearch('release train cutover', { limit: 10 })
        const hit = results.find((r) => harness.localIdOf(r.id) === id)
        expect(hit, `no hit for ${id}`).toBeDefined()
        return hit!.score
      }

      // near the data the newer row wins, and by a margin
      harness.setScoringClock(T0 + 30 * DAY)
      const nearResults = await harness.runSearch('release train cutover', { limit: 10 })
      expect(harness.localIdOf(nearResults[0].id)).toBe('newer')

      // far from the data the two rows are nearly indistinguishable and the gap shrinks
      // by orders of magnitude. how far it shrinks is the decay scale's business, so
      // this asserts the direction and a small bound rather than a fixed magnitude: at
      // the shipped scale a stale corpus keeps a sliver of margin instead of none.
      const farGap = Math.abs((await scoreOf('newer', CORPUS_EPOCH)) - (await scoreOf('older', CORPUS_EPOCH)))
      const nearGap = Math.abs((await scoreOf('newer', T0 + 30 * DAY)) - (await scoreOf('older', T0 + 30 * DAY)))
      expect(nearGap).toBeGreaterThan(farGap)
      expect(farGap).toBeLessThan(1e-2)
    } finally {
      harness.dispose()
    }
  })
})
