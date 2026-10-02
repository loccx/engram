// bench run identity: the locomo and memoryagentbench checkpoint keys have to name the
// vector regime that was in effect, the effective sample selection, the code revision and
// the seed, so that neither a resume nor a later reading of the artifact can mix two runs.
// pure functions, no harness, no database, no llm.
import { describe, expect, it } from 'vitest'
import {
  benchKeyDiff,
  benchQaKey,
  benchVectorIdentity,
  selectionIdentity,
} from '../eval/lib/bench-qa.js'

const BASE: Record<string, string | number> = {
  dataset: 'locomo',
  sha: 'd6f21ea9d60a0d56',
  readers: 'engram+full-context',
  model: 'reader-a',
  prompt: 'locomo-v1',
  scorer: 'locomo-official-f1@1',
  topk: 10,
  budget: 32000,
  vectors: 'fts',
  engine: 'abc123abc123',
  selection: 'samples=2/2',
  seed: 7,
}

/** the key a run wrote before the identity parts existed */
const LEGACY_KEY = [
  'budget=32000',
  'dataset=locomo',
  'model=reader-a',
  'prompt=locomo-v1',
  'readers=engram+full-context',
  'scorer=locomo-official-f1@1',
  'sha=d6f21ea9d60a0d56',
  'topk=10',
].join('|')

describe('benchVectorIdentity', () => {
  it('names fts as a regime of its own, never as a degraded one', () => {
    expect(benchVectorIdentity('fts', { vectorsAvailable: false, modelCacheReady: true })).toBe('fts')
    expect(benchVectorIdentity('fts', { vectorsAvailable: true, modelCacheReady: true })).toBe('fts')
  })

  it('separates a request that was honoured from one that fell back to fts', () => {
    expect(benchVectorIdentity('cached', { vectorsAvailable: true, modelCacheReady: true })).toBe(
      'cached+vectors'
    )
    expect(benchVectorIdentity('cached', { vectorsAvailable: false, modelCacheReady: false })).toBe(
      'cached+fts-fallback'
    )
  })

  it('names an incomplete `on` request as uncertain rather than promising vectors', () => {
    expect(benchVectorIdentity('on', { vectorsAvailable: true, modelCacheReady: true })).toBe('on+vectors')
    // the pipeline may reach vectors or fall back to lexical, and the key is written before
    // either happened, so the regime is recorded as unknown rather than as achieved
    expect(benchVectorIdentity('on', { vectorsAvailable: true, modelCacheReady: false })).toBe(
      'on+model-incomplete(uncertain)'
    )
  })
})

describe('selectionIdentity', () => {
  it('names what was used of what was on offer', () => {
    expect(selectionIdentity('samples', 2, 2)).toBe('samples=2/2')
    expect(selectionIdentity('samples', 1, 2)).toBe('samples=1/2')
    expect(selectionIdentity('rows', 3, 8)).toBe('rows=3/8')
  })
})

describe('benchQaKey', () => {
  it('labels every part, sorted, so a key can be read and diffed', () => {
    const key = benchQaKey(BASE)
    expect(key).toContain('vectors=fts')
    expect(key).toContain('engine=abc123abc123')
    expect(key).toContain('selection=samples=2/2')
    expect(key).toContain('seed=7')
    expect(key.split('|')).toHaveLength(Object.keys(BASE).length)
  })

  it('changes when only one identity part changes', () => {
    const base = benchQaKey(BASE)
    expect(benchQaKey({ ...BASE, vectors: 'cached+vectors' })).not.toBe(base)
    expect(benchQaKey({ ...BASE, selection: 'samples=1/2' })).not.toBe(base)
    expect(benchQaKey({ ...BASE, engine: 'def456' })).not.toBe(base)
    expect(benchQaKey({ ...BASE, seed: 8 })).not.toBe(base)
  })
})

describe('benchKeyDiff', () => {
  it('names the part that differs', () => {
    expect(benchKeyDiff(benchQaKey(BASE), benchQaKey({ ...BASE, vectors: 'cached+vectors' }))).toEqual([
      'vectors: fts vs cached+vectors',
    ])
    expect(benchKeyDiff(benchQaKey(BASE), benchQaKey({ ...BASE, seed: 8 }))).toEqual(['seed: 7 vs 8'])
    expect(benchKeyDiff(benchQaKey(BASE), benchQaKey({ ...BASE, selection: 'samples=1/2' }))).toEqual([
      'selection: samples=2/2 vs samples=1/2',
    ])
  })

  it('reports the identity parts as absent on a key that predates them', () => {
    // the bench key is built from a sorted map, so an older key must be diffed by name:
    // diffing by position would blame every later part for one missing one
    expect(benchKeyDiff(benchQaKey(BASE), LEGACY_KEY)).toEqual([
      'engine: abc123abc123 vs (absent)',
      'seed: 7 vs (absent)',
      'selection: samples=2/2 vs (absent)',
      'vectors: fts vs (absent)',
    ])
  })

  it('reports nothing for two identical keys', () => {
    expect(benchKeyDiff(benchQaKey(BASE), benchQaKey({ ...BASE }))).toEqual([])
  })
})
