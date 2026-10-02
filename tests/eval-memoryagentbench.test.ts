// memoryagentbench suite tests: a hand-written two-pool fixture in the released row
// shape (numbered fact list, questions, accepted answers, metadata.source). the fixture
// is author-written; the hub release is only ever fetched into the gitignored data dir.
// the stub llm replaces the network call only — gateway presence, model pinning, the
// official substring scorer, the checkpoint and the cost gate all run for real.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAB_SUBDATASETS,
  factMemoryId,
  poolNamespace,
  poolToCorpus,
  readMabRows,
  resolvePoolFilter,
  runMemoryAgentBenchSuite,
} from '../eval/suites/memoryagentbench.js'
import {
  MAB_QUERY_TEMPLATE,
  answerCandidates,
  emptyTargetStats,
  newestFactWithAnswer,
  normalizeAnswer,
  parseFactPool,
  scoreOverAnswers,
} from '../eval/lib/mab-score.js'
import { resetGatewayForTests, setLlmTransport, type LlmCall } from '../eval/lib/llm.js'
import { buildHeader } from '../eval/lib/report.js'
import { resolveConfigs } from '../eval/lib/registry.js'
import { resetTokenizerForTests } from '../eval/lib/metrics.js'
import { EvalSetupError } from '../eval/lib/errors.js'
import type { SuiteContext } from '../eval/suites/types.js'
import type { ChatResult } from '../src/llm/client.js'

const GATEWAY_KEY_VAR = ['ENGRAM_LLM', 'API_KEY'].join('_')
const tempDirs: string[] = []
const READERS = ['engram', 'full-context', 'naive-rag']

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-mab-test-'))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  resetGatewayForTests()
  resetTokenizerForTests()
})

afterEach(() => {
  setLlmTransport(null)
  resetGatewayForTests()
  resetTokenizerForTests()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
  for (const key of ['ENGRAM_LLM_BASE_URL', GATEWAY_KEY_VAR, 'ENGRAM_LLM_MODEL']) {
    delete process.env[key]
  }
})

function useGateway(): void {
  process.env.ENGRAM_LLM_BASE_URL = 'https://gateway.example.invalid/v1'
  process.env[GATEWAY_KEY_VAR] = 'inert-fixture-value'
  process.env.ENGRAM_LLM_MODEL = 'test-model'
  resetGatewayForTests()
}

/** two pools: one where the current value replaces an older one, one with a single fact */
function fixtureRows(): unknown[] {
  return [
    {
      source: 'fixture_sh_6k',
      context:
        'Here is a list of facts:\n' +
        '0. The instrument Nimbus is a flute.\n' +
        '1. The instrument Nimbus is a trumpet.\n' +
        '2. Quill was born in the city of Bergen.',
      questions: ['Which instrument is Nimbus?', 'Where was Quill born?', 'Which instrument is absent?'],
      answers: [['trumpet'], ['Bergen'], ['tuba']],
      qa_pair_ids: ['fixture_sh_6k_no0', 'fixture_sh_6k_no1', 'fixture_sh_6k_no2'],
    },
    {
      source: 'fixture_mh_6k',
      context:
        'Here is a list of facts:\n' +
        '0. The spouse of Quill is Rune.\n' +
        '1. Rune is a citizen of Chile.\n' +
        '2. Rune is a citizen of Peru.',
      questions: ['Which country is the spouse of Quill a citizen of?'],
      answers: [['Peru', 'the Republic of Peru']],
      qa_pair_ids: ['fixture_mh_6k_no0'],
    },
  ]
}

function writeFixture(dir: string): string {
  const path = join(dir, 'Conflict_Resolution.jsonl')
  writeFileSync(path, `${fixtureRows().map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  return path
}

// a pinned manifest whose recorded hash the fixture cannot match, so the mismatch path runs
// the same way on a machine that fetched the real dataset and on one that never did
function writeManifest(dir: string): string {
  const path = join(dir, 'manifest.json')
  const pinned = '0'.repeat(64)
  writeFileSync(
    path,
    JSON.stringify({
      repo: 'fixture',
      fetched_at: '2026-01-01T00:00:00.000Z',
      datasets: {
        memoryagentbench: {
          id: 'memoryagentbench',
          title: 'fixture',
          url: 'https://example.invalid/fixture.parquet',
          license: 'MIT',
          note: 'fixture',
          files: [
            { role: 'source', file: 'Conflict_Resolution.parquet', bytes: 1, sha256: pinned, record_count: null },
            { role: 'rows', file: 'Conflict_Resolution.jsonl', bytes: 1, sha256: pinned, record_count: 2 },
          ],
          fetched_at: '2026-01-01T00:00:00.000Z',
          schema: {},
        },
      },
    }),
    'utf8'
  )
  return path
}

function suiteContext(dir: string, overrides: Partial<SuiteContext> = {}): SuiteContext {
  return {
    seed: 7,
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

describe('memoryagentbench scoring', () => {
  it('parses the numbered pool and ignores the header line', () => {
    const facts = parseFactPool('Here is a list of facts:\n0. A is B.\n1. C is D.\n\n2. E is F.')
    expect(facts.map((fact) => fact.serial)).toEqual([0, 1, 2])
    expect(facts[0].text).toBe('A is B.')
    expect(facts[0].line).toBe('0. A is B.')
  })

  it('takes the newest fact that states an accepted answer', () => {
    const facts = parseFactPool(
      'Here is a list of facts:\n0. The instrument Nimbus is a flute.\n1. The instrument Nimbus is a trumpet.'
    )
    expect(newestFactWithAnswer(facts, ['trumpet'])?.serial).toBe(1)
    expect(newestFactWithAnswer(facts, ['flute'])?.serial).toBe(0)
    expect(newestFactWithAnswer(facts, ['tuba'])).toBeNull()
    // a match is a substring, so the subject alone also matches both facts: that looseness
    // is what the artifact counts as multi-candidate questions
    expect(newestFactWithAnswer(facts, ['Nimbus'])?.serial).toBe(1)
    expect(answerCandidates(facts, ['Nimbus'])).toHaveLength(2)
    expect(answerCandidates(facts, ['trumpet'])).toHaveLength(1)
  })

  it('normalizes and substring-matches the way the official metric does', () => {
    expect(normalizeAnswer('The Republic of Peru, 2024!')).toBe('republic of peru 2024')
    expect(scoreOverAnswers('Peru', [['Peru']])).toBe(1)
    expect(scoreOverAnswers('The answer is Peru.', [['the Republic of Peru']])).toBe(0)
    expect(scoreOverAnswers('citizen of the Republic of Peru', [['Peru', 'the Republic of Peru']])).toBe(1)
    expect(scoreOverAnswers('I am not sure', [['Peru']])).toBe(0)
    // a ground truth that normalizes to nothing matches anything, as `'' in x` does
    expect(scoreOverAnswers('anything', [['the']])).toBe(1)
    expect(scoreOverAnswers('anything', 'Peru')).toBe(0)
    expect(scoreOverAnswers('in Peru', 'Peru')).toBe(1)
  })

  it('builds the official question text around the pool question', () => {
    expect(MAB_QUERY_TEMPLATE).toContain('the newer fact has larger serial number')
    expect(MAB_QUERY_TEMPLATE.replace('{question}', 'Which instrument is Nimbus?')).toContain(
      'Now Answer the Question: Based on the provided Knowledge Pool, Which instrument is Nimbus?'
    )
  })
})

describe('memoryagentbench corpus mapping', () => {
  it('stores one memory per numbered fact and targets the current one', () => {
    const rows = fixtureRows() as Array<{
      source: string
      context: string
      questions: string[]
      answers: string[][]
      qa_pair_ids: string[]
    }>
    const stats = emptyTargetStats()
    const built = poolToCorpus(rows[0], stats)

    expect(built.namespace).toBe(poolNamespace('fixture_sh_6k'))
    expect(built.memories.map((memory) => memory.id)).toEqual([
      factMemoryId('fixture_sh_6k', 0),
      factMemoryId('fixture_sh_6k', 1),
      factMemoryId('fixture_sh_6k', 2),
    ])
    expect(built.memories[1].content).toBe('1. The instrument Nimbus is a trumpet.')
    // the pool order is the recency order the prompt relies on
    expect(built.memories[1].created_at).toBeGreaterThan(built.memories[0].created_at)
    expect(built.queries[0].target_ids).toEqual([factMemoryId('fixture_sh_6k', 1)])
    expect(built.queries[1].target_ids).toEqual([factMemoryId('fixture_sh_6k', 2)])
    // the third question has no fact carrying its answer: unscorable, not scored as zero
    expect(built.queries[2].target_ids).toEqual([])
    expect(stats.questions).toBe(3)
    expect(stats.withTarget).toBe(2)
    expect(stats.unscorable).toBe(1)
    expect(stats.facts).toBe(3)
    expect(built.queries[0].kind).toBe('fixture_sh_6k')
  })

  it('keeps the first accepted answer as a target when there are several facts', () => {
    const rows = fixtureRows() as Array<{
      source: string
      context: string
      questions: string[]
      answers: string[][]
      qa_pair_ids: string[]
    }>
    const stats = emptyTargetStats()
    const built = poolToCorpus(rows[1], stats)
    // both citizen facts carry "Rune" but only the newest states the accepted answer
    expect(built.queries[0].target_ids).toEqual([factMemoryId('fixture_mh_6k', 2)])
    expect(stats.multipleCandidates).toBe(0)
  })

  it('accepts only the split name or a real sub-dataset as the pool filter', () => {
    expect(resolvePoolFilter(undefined)).toBeNull()
    expect(resolvePoolFilter('Conflict_Resolution')).toBeNull()
    expect(resolvePoolFilter('factconsolidation_sh_6k')).toBe('factconsolidation_sh_6k')
    expect(MAB_SUBDATASETS).toHaveLength(8)
    expect(() => resolvePoolFilter('fixture_sh_6k')).toThrow(EvalSetupError)
  })
})

describe('memoryagentbench suite run', () => {
  it('reads both fixture pools and reports a target label per pool', async () => {
    const dir = tempDir()
    const path = writeFixture(dir)
    const rows = await readMabRows(path)
    expect(rows).toHaveLength(2)

    const output = await runMemoryAgentBenchSuite(
      suiteContext(dir, { datasetPath: path, datasetManifestPath: writeManifest(dir) })
    )
    const metrics = (output.result.metrics as Record<string, MabSuiteMetrics>).baseline

    expect(metrics.currentFactRecall.questions).toBe(3)
    expect(metrics.derivedLabels.questions).toBe(4)
    expect(metrics.derivedLabels.with_target).toBe(3)
    expect(metrics.derivedLabels.unscorable).toBe(1)
    expect(metrics.derivedLabels.facts).toBe(6)
    expect(metrics.derivedLabels.shipped_labels).toBe(false)
    expect(Object.keys(metrics.bySubDataset).sort()).toEqual(['fixture_mh_6k', 'fixture_sh_6k'])
    expect(metrics.pools.map((pool) => pool.source).sort()).toEqual(['fixture_mh_6k', 'fixture_sh_6k'])
    expect(output.markdown).toContain('Memoryagentbench Conflict_Resolution')
    expect(output.markdown).toContain('newest fact')
    // the fixture stands in for the pinned file, so the hash check says so out loud
    expect(output.result.notes.join('\n')).toContain('SHA256 MISMATCH')
    expect(output.result.header.suite).toBe('memoryagentbench')
  })

  it('refuses a missing rows file with the fetch command, and an unknown split filter', async () => {
    const dir = tempDir()
    await expect(
      runMemoryAgentBenchSuite(suiteContext(dir, { datasetPath: join(dir, 'nope.jsonl') }))
    ).rejects.toThrow(/npm run eval:datasets -- --dataset memoryagentbench/)
    await expect(
      runMemoryAgentBenchSuite(
        suiteContext(dir, { datasetPath: join(dir, 'nope.jsonl'), dataset: 'Conflict_Resolution' })
      )
    ).rejects.toThrow(EvalSetupError)

    const path = writeFixture(dir)
    await expect(
      runMemoryAgentBenchSuite(suiteContext(dir, { datasetPath: path, dataset: 'not_a_pool' }))
    ).rejects.toThrow(/not a Conflict_Resolution sub-dataset/)
    await expect(
      runMemoryAgentBenchSuite(
        suiteContext(dir, { datasetPath: path, dataset: 'factconsolidation_sh_6k' })
      )
    ).rejects.toThrow(/no pool row/)
  })

  it('runs the readers and the official scorer under --qa, and resumes from the checkpoint', async () => {
    useGateway()
    const requests: LlmCall[] = []
    setLlmTransport(async (call: LlmCall): Promise<ChatResult> => {
      requests.push(call)
      const text = call.messages.map((message) => message.content).join('\n')
      const answer = text.includes('1. The instrument Nimbus is a trumpet.') ? 'trumpet' : 'unknown'
      return { content: answer, model: call.model }
    })
    const dir = tempDir()
    const path = writeFixture(dir)
    const checkpoint = join(dir, 'run.jsonl')
    const overrides: Partial<SuiteContext> = {
      qa: true,
      datasetPath: path,
      readers: READERS,
      readerModel: 'stub-reader',
      checkpointPath: checkpoint,
      envFile: join(dir, 'no-such-env'),
      yes: true,
      concurrency: 2,
      contextBudgetChars: 2000,
    }

    const first = await runMemoryAgentBenchSuite(suiteContext(dir, overrides))
    const metrics = (first.result.metrics as Record<string, MabSuiteMetrics>).baseline
    expect(metrics.qa.status).toBe('ok')
    expect(metrics.qa.calls).toBe(4 * READERS.length)
    expect(metrics.qa.scorer).toBe('memoryagentbench-substring-exact-match')
    // the stub answers only for the pool that states the trump fact, so one of the four
    // questions is right for a reader that sees every fact
    expect(metrics.qa.readers!['full-context'].score).toBe(0.25)
    expect(metrics.qa.readers!['full-context'].graded).toBe(4)
    expect(first.markdown).toContain('official substring match')

    const second = await runMemoryAgentBenchSuite(suiteContext(dir, overrides))
    const resumed = (second.result.metrics as Record<string, MabSuiteMetrics>).baseline
    expect(resumed.qa.calls).toBe(0)
    expect(resumed.qa.resumed_questions).toBe(4)
    expect(resumed.qa.readers!['full-context'].score).toBe(metrics.qa.readers!['full-context'].score)
  }, 120_000)

  it('refuses --qa without a gateway or a pinned reader model', async () => {
    const dir = tempDir()
    const path = writeFixture(dir)
    for (const key of ['ENGRAM_LLM_BASE_URL', GATEWAY_KEY_VAR, 'ENGRAM_LLM_MODEL']) delete process.env[key]
    resetGatewayForTests()
    await expect(
      runMemoryAgentBenchSuite(
        suiteContext(dir, { qa: true, datasetPath: path, readers: READERS, envFile: join(dir, 'none') })
      )
    ).rejects.toThrow(/no gateway configured/)

    useGateway()
    await expect(
      runMemoryAgentBenchSuite(
        suiteContext(dir, { qa: true, datasetPath: path, readers: READERS, envFile: join(dir, 'none') })
      )
    ).rejects.toThrow(/--reader-model/)
  })

  it('is deterministic: the same fixture produces the same metrics', async () => {
    const dir = tempDir()
    const path = writeFixture(dir)
    const first = await runMemoryAgentBenchSuite(suiteContext(dir, { datasetPath: path }))
    const second = await runMemoryAgentBenchSuite(suiteContext(dir, { datasetPath: path }))
    expect(JSON.stringify(second.result.metrics)).toBe(JSON.stringify(first.result.metrics))
  })
})

describe('memoryagentbench run identity (stub llm)', () => {
  const IDENTITY_READERS = ['engram', 'full-context']

  /** one --qa run over the fixture pools, with a stub reader that answers from the facts */
  async function qaRun(opts: {
    dir: string
    checkpoint: string
    overrides?: Partial<SuiteContext>
  }): Promise<{ metrics: MabSuiteMetrics; notes: string[]; rows: Array<Record<string, unknown>> }> {
    useGateway()
    setLlmTransport(async (call: LlmCall): Promise<ChatResult> => {
      const text = call.messages.map((message) => message.content).join('\n')
      return {
        content: text.includes('1. The instrument Nimbus is a trumpet.') ? 'trumpet' : 'unknown',
        model: call.model,
      }
    })
    const path = writeFixture(opts.dir)
    const output = await runMemoryAgentBenchSuite(
      suiteContext(opts.dir, {
        qa: true,
        datasetPath: path,
        readers: IDENTITY_READERS,
        readerModel: 'stub-reader',
        checkpointPath: opts.checkpoint,
        envFile: join(opts.dir, 'no-such-env'),
        yes: true,
        concurrency: 2,
        contextBudgetChars: 2000,
        ...opts.overrides,
      })
    )
    const metrics = (output.result.metrics as Record<string, MabSuiteMetrics>).baseline
    const details = output.result.details as Array<{ qa?: { rows: Array<Record<string, unknown>> } }>
    return {
      metrics,
      notes: output.result.notes ?? [],
      rows: details.find((detail) => detail.qa !== undefined)?.qa?.rows ?? [],
    }
  }

  it('stamps the identity on every row and resumes an unchanged run', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    const first = await qaRun({ dir, checkpoint })
    expect(first.metrics.qa.calls).toBe(4 * IDENTITY_READERS.length)
    for (const row of first.rows) {
      // this fixture is seeded on the fts path, over both pools, at the test seed
      expect(row.vectors).toBe('fts')
      expect(row.selection).toBe('rows=2/2')
      expect(row.git_sha).toBe('testsha')
      const key = String(row.key)
      expect(key).toContain('vectors=fts')
      expect(key).toContain('selection=rows=2/2')
      expect(key).toContain('engine=testsha')
      expect(key).toContain('seed=7')
    }
    expect(first.notes.some((note) => note.includes('qa identity: vectors=fts'))).toBe(true)

    const second = await qaRun({ dir, checkpoint })
    expect(second.metrics.qa.calls).toBe(0)
    expect(second.metrics.qa.resumed_questions).toBe(4)
    expect(second.metrics.qa.readers!['full-context'].score).toBe(
      first.metrics.qa.readers!['full-context'].score
    )
  }, 120_000)

  it('never resumes a lexical checkpoint as a vector run', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    await qaRun({ dir, checkpoint, overrides: { vectors: 'fts' } })

    const second = await qaRun({ dir, checkpoint, overrides: { vectors: 'cached' } })
    expect(second.metrics.qa.calls).toBe(4 * IDENTITY_READERS.length)
    expect(second.metrics.qa.resumed_questions).toBe(0)
    expect(
      second.notes.some((note) => /vectors: cached(\+vectors|\+fts-fallback) vs fts/.test(note))
    ).toBe(true)
    for (const row of second.rows) expect(row.vectors).not.toBe('fts')
    // the old rows are kept: two identities in one file, nothing deleted
    const keys = new Set(
      readFileSync(checkpoint, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).key as string)
    )
    expect(keys.size).toBe(2)
  }, 120_000)

  it('never resumes a checkpoint that asked fewer pools', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    await qaRun({ dir, checkpoint })

    const second = await qaRun({ dir, checkpoint, overrides: { limit: 1 } })
    // the first pool holds three of the four questions
    expect(second.metrics.qa.calls).toBe(3 * IDENTITY_READERS.length)
    expect(second.metrics.qa.resumed_questions).toBe(0)
    expect(second.notes.some((note) => note.includes('selection: rows=1/2 vs rows=2/2'))).toBe(true)
    for (const row of second.rows) expect(row.selection).toBe('rows=1/2')
  }, 120_000)

  it('never resumes across a code revision', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    await qaRun({ dir, checkpoint, overrides: { gitSha: 'sha-a' } })

    const second = await qaRun({ dir, checkpoint, overrides: { gitSha: 'sha-b' } })
    expect(second.metrics.qa.resumed_questions).toBe(0)
    expect(second.metrics.qa.calls).toBe(4 * IDENTITY_READERS.length)
    expect(second.notes.some((note) => note.includes('engine: sha-b vs sha-a'))).toBe(true)
  }, 120_000)

  it('treats a limit above the file size as the same selection', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    await qaRun({ dir, checkpoint })

    // both pools are on offer, so asking for more than two is the same run
    const second = await qaRun({ dir, checkpoint, overrides: { limit: 9 } })
    expect(second.metrics.qa.calls).toBe(0)
    expect(second.metrics.qa.resumed_questions).toBe(4)
    for (const row of second.rows) expect(row.selection).toBe('rows=2/2')
  }, 120_000)

  it('never resumes across a seed, which names a different corpus', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    await qaRun({ dir, checkpoint, overrides: { seed: 7 } })

    const second = await qaRun({ dir, checkpoint, overrides: { seed: 8 } })
    expect(second.metrics.qa.resumed_questions).toBe(0)
    expect(second.metrics.qa.calls).toBe(4 * IDENTITY_READERS.length)
    expect(second.notes.some((note) => note.includes('seed: 8 vs 7'))).toBe(true)
  }, 120_000)
})

interface MabSuiteMetrics {
  currentFactRecall: Record<string, number>
  derivedLabels: Record<string, number | string | boolean>
  bySubDataset: Record<string, Record<string, number>>
  pools: Array<{ source: string; facts: number; questions: number; unscorable: number }>
  qa: {
    status: string
    calls?: number
    resumed_questions?: number
    scorer?: string
    readers?: Record<string, { score: number; graded: number }>
  }
}
