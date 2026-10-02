import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonlCheckpoint } from '../eval/lib/checkpoint.js'
import { runQa, type QaRow } from '../eval/lib/qa-run.js'
import { runBenchQa, type BenchQaRow } from '../eval/lib/bench-qa.js'
import { resolveTokenizer } from '../eval/lib/metrics.js'
import { checkComparability } from '../eval/lib/stats.js'
import { engineRevisionIdentity, resumeIdentityIssue } from '../eval/lib/run-identity.js'

async function* noQuestions(): AsyncGenerator<never> {}

const KNOWN = { vectors: 'fts', question_set: 'none', engine_revision: 'fixture-sha' }
const UNCERTAIN = [
  { vectors: 'on+model-incomplete', gitSha: 'fixture-sha' },
  { vectors: 'on+model-incomplete(uncertain)', gitSha: 'fixture-sha' },
  { vectors: 'fts', gitSha: '' },
  { vectors: 'fts', gitSha: 'unknown' },
  { vectors: 'fts', gitSha: 'fixture-sha-dirty' },
]

describe('unsettled evaluation identity', () => {
  it('allows a named stable regime and known revision', () => {
    expect(resumeIdentityIssue('fts', 'fixture-sha')).toBeNull()
    expect(resumeIdentityIssue('cached+vectors', 'fixture-sha')).toBeNull()
    expect(resumeIdentityIssue('cached+fts-fallback', 'fixture-sha')).toBeNull()
  })

  it('marks dirty trees as unverified rather than treating a suffix as an edit fingerprint', () => {
    const clean = engineRevisionIdentity({ sha: 'fixture-sha', dirty: false })
    const dirty = engineRevisionIdentity({ sha: 'fixture-sha', dirty: true })
    expect(clean).toBe('fixture-sha')
    expect(dirty).toBe('fixture-sha-dirty')
    expect(resumeIdentityIssue('fts', clean)).toBeNull()
    expect(resumeIdentityIssue('fts', dirty)).toMatch(/unidentified/)
  })

  it.each(UNCERTAIN)('withholds a comparison for $vectors / $gitSha', ({ vectors, gitSha }) => {
    const identity = { ...KNOWN, vectors, engine_revision: gitSha, engine_intervention: 'explicit-ab' }
    const guard = checkComparability(identity, { ...identity })
    expect(guard.comparable).toBe(false)
    expect(guard.differences.join('; ')).toMatch(/unverified|unidentified/)
  })

  it.each(UNCERTAIN)('keeps but never reuses matching-key rows for $vectors / $gitSha', async ({ vectors, gitSha }) => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-resume-certainty-'))
    try {
      const qaCheckpoint = new JsonlCheckpoint<QaRow>(join(dir, 'qa.jsonl'))
      const benchCheckpoint = new JsonlCheckpoint<BenchQaRow>(join(dir, 'bench.jsonl'))
      // eligibility-only fixture: no questions, answers, credentials or model calls
      qaCheckpoint.append({ key: 'same', question_id: 'fixture', reader: 'engram' } as QaRow)
      benchCheckpoint.append({ key: 'same', question_id: 'fixture', reader: 'engram' } as BenchQaRow)
      const common = {
        readers: [], readerModel: 'inert-reader', concurrency: 1,
        key: 'same', vectors, gitSha, costCeilingCalls: 0,
        confirmed: false, totalQuestions: 0,
        tokenizer: await resolveTokenizer(), log: () => {},
      }
      const qa = await runQa({
        ...common, questions: noQuestions(), judgeModel: 'inert-judge',
        questionSet: 'none', checkpoint: qaCheckpoint,
      })
      const bench = await runBenchQa({
        ...common, questions: noQuestions(), checkpoint: benchCheckpoint, selection: 'none',
        buildMessages: () => [], systemNote: '', promptVersion: 'inert', goldOf: () => '',
        scorer: { name: 'inert', version: '1', source: 'inert-fixture', score: () => ({ score: 0, detail: '' }) },
        maxTokens: 1, temperature: 0,
      })
      for (const output of [qa, bench]) {
        expect(output.calls).toBe(0)
        expect(output.foreignKeys).toHaveLength(1)
        expect(output.foreignKeys[0].key).toBe('same')
        expect(output.foreignKeys[0].differences.join('; ')).toMatch(/unverified|unidentified/)
      }
      expect(qaCheckpoint.load()).toHaveLength(1)
      expect(benchCheckpoint.load()).toHaveLength(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
