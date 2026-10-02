// run identity: the resume key and the reported identity have to name the vector regime
// that was really in effect, the sampled question set and the code revision, so that
// neither a resume nor a paired comparison can silently mix two regimes. pure functions,
// no harness, no database, no llm.
import { describe, expect, it } from 'vitest'
import { qaKey, qaKeyDiff, vectorIdentity, type QaKeyInput } from '../eval/lib/qa-run.js'
import { questionSetIdentity } from '../eval/suites/longmemeval.js'

const BASE: QaKeyInput = {
  split: 'longmemeval_s_cleaned',
  datasetSha: 'd6f21ea9d60a0d56deadbeefdeadbeef',
  systems: ['engram', 'full-context'],
  readerModel: 'reader-a',
  judgeModel: 'judge-a',
  budgetChars: 32_000,
  topK: 10,
  vectors: 'fts',
  questionSet: 'all,limit=500,stride=1',
  engineRevision: 'abc123abc123',
}

/** the key the run wrote before the identity fields existed, same order, no labels */
const LEGACY_KEY = [
  'longmemeval_s_cleaned',
  'd6f21ea9d60a0d56',
  'engram+full-context',
  'reader-a',
  'judge-a',
  'longmemeval-reader-v2',
  'longmemeval-anscheck-v1',
  'budget=32000',
  'topk=10',
].join('|')

describe('vectorIdentity', () => {
  it('names fts as a regime of its own, never as a degraded one', () => {
    expect(vectorIdentity('fts', { vectorsAvailable: false, modelCacheReady: true })).toBe('fts')
    expect(vectorIdentity('fts', { vectorsAvailable: true, modelCacheReady: true })).toBe('fts')
  })

  it('separates a requested mode that was honoured from one that fell back to fts', () => {
    expect(vectorIdentity('cached', { vectorsAvailable: true, modelCacheReady: true })).toBe(
      'cached+vectors'
    )
    expect(vectorIdentity('cached', { vectorsAvailable: false, modelCacheReady: false })).toBe(
      'cached+fts-fallback'
    )
  })

  it('marks `on` with an incomplete model as a third regime, not as vectors', () => {
    expect(vectorIdentity('on', { vectorsAvailable: true, modelCacheReady: true })).toBe('on+vectors')
    expect(vectorIdentity('on', { vectorsAvailable: true, modelCacheReady: false })).toBe(
      'on+model-incomplete'
    )
  })
})

describe('questionSetIdentity', () => {
  it('names the scope, the limit and the stride of an evenly sampled run', () => {
    expect(questionSetIdentity({ questionTypes: [], limit: 500, stride: 1 })).toBe(
      'all,limit=500,stride=1'
    )
    expect(questionSetIdentity({ questionTypes: [], limit: 60, stride: 8 })).toBe(
      'all,limit=60,stride=8'
    )
  })

  it('sorts the type filter and drops the stride, which does not apply to it', () => {
    expect(
      questionSetIdentity({ questionTypes: ['multi-session', 'temporal-reasoning'], limit: 60, stride: 3 })
    ).toBe('types=multi-session,temporal-reasoning,limit=60,stride=n/a')
    expect(questionSetIdentity({ questionTypes: ['temporal-reasoning', 'multi-session'], limit: 60, stride: 3 })).toBe(
      'types=multi-session,temporal-reasoning,limit=60,stride=n/a'
    )
  })

  it('says `all` when no limit is in effect', () => {
    expect(questionSetIdentity({ questionTypes: ['multi-session'], limit: Infinity, stride: 1 })).toBe(
      'types=multi-session,limit=all,stride=n/a'
    )
  })
})

describe('qaKey', () => {
  it('carries every axis the meaning of a row depends on', () => {
    const key = qaKey(BASE)
    for (const segment of [
      'split=longmemeval_s_cleaned',
      'dataset=d6f21ea9d60a0d56',
      'systems=engram+full-context',
      'reader=reader-a',
      'judge=judge-a',
      'budget=32000',
      'topk=10',
      'vectors=fts',
      'questions=all,limit=500,stride=1',
      'engine=abc123abc123',
    ]) {
      expect(key).toContain(segment)
    }
  })

  it('changes when only the vector regime changes', () => {
    expect(qaKey({ ...BASE, vectors: 'cached+vectors' })).not.toBe(qaKey(BASE))
    expect(qaKeyDiff(qaKey(BASE), qaKey({ ...BASE, vectors: 'cached+vectors' }))).toEqual([
      'vectors: fts vs cached+vectors',
    ])
  })

  it('changes when only the sampled question set changes', () => {
    const other = qaKey({ ...BASE, questionSet: 'types=multi-session,limit=60,stride=n/a' })
    expect(other).not.toBe(qaKey(BASE))
    expect(qaKeyDiff(qaKey(BASE), other)).toEqual([
      'questions: all,limit=500,stride=1 vs types=multi-session,limit=60,stride=n/a',
    ])
  })

  it('changes when only the code revision changes, and marks an unknown revision', () => {
    expect(qaKeyDiff(qaKey(BASE), qaKey({ ...BASE, engineRevision: 'def456def456' }))).toEqual([
      'engine: abc123abc123 vs def456def456',
    ])
    expect(qaKey({ ...BASE, engineRevision: '' })).toContain('engine=unknown')
  })

  it('names the three new fields as absent when the checkpoint predates them', () => {
    const diff = qaKeyDiff(qaKey(BASE), LEGACY_KEY)
    expect(diff).toEqual([
      'vectors: fts vs (absent)',
      'questions: all,limit=500,stride=1 vs (absent)',
      'engine: abc123abc123 vs (absent)',
    ])
  })

  it('reports nothing for two identical keys', () => {
    expect(qaKeyDiff(qaKey(BASE), qaKey({ ...BASE }))).toEqual([])
  })
})
