// the decay scale is a property of the store's expected lifetime, not of the formula,
// so it is policy the same way the access signal is: overridable, with a shipped
// default of 365 days.
//
// the mechanism these tests pin: `ebbinghaus` is `exp(-age / (scale * strength))`, so
// at the default importance of 0.5 a scale of 365 gives S = 182.5 days. At a scale of
// 30, S was 15 days — a ~10-day half-life, where a 60-day-old memory scores 0.018 and
// a fresh one scores 1.0. That is a 55x multiplier between two memories in the same
// store, and it is what let a fresh-but-worse row outrank an older-but-better one
// once the clock was live.
//
// both halves are pinned here: a valid override is honoured, and an absent or invalid
// one leaves the shipped behaviour byte-identical (the negative control).
import { afterEach, describe, expect, it } from 'vitest'
import {
  DECAY_SCALE_ENV,
  DEFAULT_DECAY_SCALE_DAYS,
  DEFAULT_RECENCY_WEIGHT_SCALE,
  ebbinghaus,
  RECENCY_WEIGHT_ENV,
  resolveDecayScaleDays,
  resolveRecencyWeightScale,
} from '../src/memory/search/scoring.js'
import { episodeRecency } from '../src/memory/search/episodes.js'
import type { Memory } from '../src/memory/types.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2025, 0, 1)

/** the fields ebbinghaus reads, so a row needs no db */
function row(ageDays: number, importance = 0.5): Memory {
  return {
    id: `row-${ageDays}`,
    session_id: 's',
    project_path: '/ns',
    content: 'x',
    type: 'note',
    importance,
    tags: [],
    created_at: NOW - ageDays * DAY,
    last_accessed: null,
    access_count: 0,
    vec_rowid: null,
    valid_from: NOW - ageDays * DAY,
    valid_until: null,
  } as Memory
}

afterEach(() => {
  delete process.env[DECAY_SCALE_ENV]
  delete process.env[RECENCY_WEIGHT_ENV]
})

describe('decay scale override', () => {
  it('defaults to the shipped scale and is unchanged when the override is absent', () => {
    expect(DEFAULT_DECAY_SCALE_DAYS).toBe(365)
    expect(resolveDecayScaleDays({})).toBe(365)

    // the negative control: with no override, the default path is the explicit default
    delete process.env[DECAY_SCALE_ENV]
    expect(ebbinghaus(row(60), NOW)).toBe(ebbinghaus(row(60), NOW, DEFAULT_DECAY_SCALE_DAYS))
    expect(ebbinghaus(row(0), NOW)).toBe(1)
    // the shipped scale keeps most of a 60 day old memory's age signal
    expect(ebbinghaus(row(60), NOW)).toBeCloseTo(0.7198106, 5)
    // the short scale the larger default moves away from: 60 days at S = 15 is 0.018
    expect(ebbinghaus(row(60), NOW, 30)).toBeCloseTo(0.018316, 5)
  })

  it('honours a valid override', () => {
    expect(resolveDecayScaleDays({ [DECAY_SCALE_ENV]: '365' })).toBe(365)
    process.env[DECAY_SCALE_ENV] = '365'
    // the scale is 365 * 0.5 = 182.5 days, so exp(-60 / 182.5)
    expect(ebbinghaus(row(60), NOW)).toBeCloseTo(0.7198106, 5)
    // and the scale-90 case is the middle of the sweep
    expect(ebbinghaus(row(60), NOW, 90)).toBeCloseTo(0.263597, 5)
    expect(ebbinghaus(row(60), NOW)).toBeGreaterThan(ebbinghaus(row(60), NOW, 30))
    // a longer scale keeps a memory legible for longer at every age
    for (const age of [1, 11, 60, 200]) {
      expect(ebbinghaus(row(age), NOW, 365)).toBeGreaterThan(ebbinghaus(row(age), NOW, 30))
    }
  })

  it('falls back to the default for an absent, non-numeric or non-positive override', () => {
    for (const bad of ['', '  ', 'abc', '0', '-5', 'NaN', 'Infinity']) {
      expect(resolveDecayScaleDays({ [DECAY_SCALE_ENV]: bad })).toBe(DEFAULT_DECAY_SCALE_DAYS)
    }
  })

  it('applies the same scale to the episode channel', () => {
    const at = NOW - 60 * DAY
    expect(episodeRecency(at, NOW, 30)).toBeLessThan(episodeRecency(at, NOW, 365))
    delete process.env[DECAY_SCALE_ENV]
    expect(episodeRecency(at, NOW)).toBe(episodeRecency(at, NOW, DEFAULT_DECAY_SCALE_DAYS))
    process.env[DECAY_SCALE_ENV] = '365'
    expect(episodeRecency(at, NOW)).toBe(episodeRecency(at, NOW, 365))
  })
})

describe('recency weight override', () => {
  it('defaults to full weight and is unchanged when absent', () => {
    expect(DEFAULT_RECENCY_WEIGHT_SCALE).toBe(1)
    expect(resolveRecencyWeightScale({})).toBe(1)
  })

  it('honours a valid override and rejects invalid ones', () => {
    expect(resolveRecencyWeightScale({ [RECENCY_WEIGHT_ENV]: '0.5' })).toBe(0.5)
    // 0 is meaningful: it is how a caller removes the term entirely
    expect(resolveRecencyWeightScale({ [RECENCY_WEIGHT_ENV]: '0' })).toBe(0)
    for (const bad of ['', '  ', 'abc', '-1', 'NaN']) {
      expect(resolveRecencyWeightScale({ [RECENCY_WEIGHT_ENV]: bad })).toBe(
        DEFAULT_RECENCY_WEIGHT_SCALE
      )
    }
  })
})
