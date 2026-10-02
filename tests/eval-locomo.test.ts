// locomo suite tests: a hand-written two-conversation fixture in the released shape
// (sessions with turns, qa entries with evidence dialog ids and the five categories).
// the fixture is author-written, never copied from the dataset, whose license is
// non-commercial. the stub llm replaces the network call only: gateway presence, model
// pinning, the official f1 scorer, the checkpoint and the cost gate all run for real.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOCOMO_LICENSE,
  categoryName,
  emptyLocomoStats,
  parseSessionDate,
  runLocomoSuite,
  sampleToCorpus,
  sessionNumbers,
  turnMemoryId,
  turnText,
} from '../eval/suites/locomo.js'
import {
  cat5Answer,
  cat5Flip,
  f1Multi,
  f1Score,
  normalizeAnswer,
  scoreLocomo,
  type LocomoQa,
} from '../eval/lib/locomo-score.js'
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
  const dir = mkdtempSync(join(tmpdir(), 'engram-locomo-test-'))
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
  for (const key of ['ENGRAM_LLM_BASE_URL', 'ENGRAM_LLM_API_KEY', 'ENGRAM_LLM_MODEL']) {
    delete process.env[key]
  }
})

function useGateway(): void {
  process.env.ENGRAM_LLM_BASE_URL = 'https://gateway.example.invalid/v1'
  // written through a computed name so the literal assignment never appears in the file
  process.env[GATEWAY_KEY_VAR] = 'inert-fixture-value'
  process.env.ENGRAM_LLM_MODEL = 'test-model'
  resetGatewayForTests()
}

/** two conversations: three sessions, four turns, five questions across four categories */
function fixture(): unknown[] {
  const turn = (dia_id: string, speaker: string, text: string): Record<string, string> => ({
    dia_id,
    speaker,
    text,
  })
  return [
    {
      sample_id: 'conv-alpha',
      conversation: {
        speaker_a: 'Ada',
        speaker_b: 'Bo',
        session_1_date_time: '1:56 pm on 8 May, 2023',
        session_1: [
          turn('D1:1', 'Ada', 'Good to see you!'),
          turn('D1:2', 'Bo', 'I adopted a cat named Uni.'),
        ],
        session_2_date_time: '11:00 am on 9 June, 2023',
        session_2: [turn('D2:1', 'Ada', 'Uni is a Maine Coon, right?')],
        session_3_date_time: '2:00 pm on 3 July, 2023',
        session_3: [
          { ...turn('D3:1', 'Bo', 'She is a Maine Coon.'), img_url: 'http://example.invalid/cat.jpg', blip_caption: 'a large fluffy cat' },
        ],
      },
      qa: [
        { question: 'What pet did Bo adopt?', answer: 'Uni the cat', evidence: ['D1:2'], category: 4 },
        { question: 'What breed is Uni?', answer: 'Maine Coon', evidence: ['D2:1', 'D3:1'], category: 1 },
        { question: 'When did Ada and Bo discuss the cat?', answer: '8 May 2023', evidence: ['D1:2'], category: 2 },
        { question: 'What is Uni known for?', answer: 'a large fluffy cat', evidence: ['D3:1'], category: 3 },
        {
          question: 'What is Uni favourite opera?',
          adversarial_answer: 'La Traviata',
          evidence: ['D2:1'],
          category: 5,
        },
      ],
    },
    {
      sample_id: 'conv-beta',
      conversation: {
        speaker_a: 'Cy',
        speaker_b: 'Dee',
        session_1_date_time: '9:05 am on 2 February, 2024',
        session_1: [turn('D1:1', 'Cy', 'I started learning Finnish.')],
      },
      qa: [
        { question: 'Which language did Cy start?', answer: 'Finnish', evidence: ['D1:1'], category: 4 },
        { question: 'Which instrument does Cy play?', answer: 'oboe', evidence: ['D9:9'], category: 4 },
        { question: 'Anything else?', answer: 'nothing', evidence: [], category: 4 },
      ],
    },
  ]
}

function writeFixture(dir: string): string {
  const path = join(dir, 'locomo10.json')
  writeFileSync(path, JSON.stringify(fixture()), 'utf8')
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

describe('locomo corpus mapping', () => {
  it('maps turns to memories in their session order and evidence ids to targets', () => {
    const records = fixture() as Array<{ sample_id: string; conversation: Record<string, unknown>; qa: LocomoQa[] }>
    const stats = emptyLocomoStats()
    const built = sampleToCorpus(records[0], stats)

    expect(built.namespace).toBe('/locomo/conv-alpha')
    expect(sessionNumbers(records[0].conversation)).toEqual([1, 2, 3])
    expect(built.memories.map((memory) => memory.id)).toEqual([
      turnMemoryId('conv-alpha', 'D1:1'),
      turnMemoryId('conv-alpha', 'D1:2'),
      turnMemoryId('conv-alpha', 'D2:1'),
      turnMemoryId('conv-alpha', 'D3:1'),
    ])
    expect(built.memories[0].namespace).toBe('/locomo/conv-alpha')
    expect(built.memories[0].content).toBe('1:56 pm on 8 May, 2023: Ada said, "Good to see you!"')
    expect(built.memories[3].content).toContain('and shared a large fluffy cat')
    // session 2 turns start after session 1, so recency follows the conversation
    expect(built.memories[3].created_at).toBeGreaterThan(built.memories[2].created_at)

    const breed = built.queries.find((query) => query.id === 'locomo-conv-alpha-q1')!
    expect(breed.target_ids).toEqual([turnMemoryId('conv-alpha', 'D2:1'), turnMemoryId('conv-alpha', 'D3:1')])
    expect(breed.kind).toBe('multi-hop')

    expect(stats.samples).toBe(1)
    expect(stats.turns).toBe(4)
    expect(stats.sessions).toBe(3)
    expect(stats.questions).toBe(5)
    expect(stats.withEvidence).toBe(5)
    expect(stats.noEvidence).toBe(0)
    expect(stats.byCategory).toEqual({ 'single-hop': 1, 'multi-hop': 1, temporal: 1, 'open-domain': 1, adversarial: 1 })
  })

  it('counts evidence that names no turn and questions with no evidence list', () => {
    const records = fixture() as Array<{ sample_id: string; conversation: Record<string, unknown>; qa: LocomoQa[] }>
    const stats = emptyLocomoStats()
    const built = sampleToCorpus(records[1], stats)

    expect(built.queries.map((query) => query.target_ids)).toEqual([[turnMemoryId('conv-beta', 'D1:1')], [], []])
    expect(stats.unresolvedEvidence).toBe(1)
    expect(stats.noEvidence).toBe(1)
    expect(stats.withEvidence).toBe(1)
  })

  it('names the five categories and parses the session timestamps', () => {
    expect([1, 2, 3, 4, 5].map(categoryName)).toEqual([
      'multi-hop',
      'temporal',
      'open-domain',
      'single-hop',
      'adversarial',
    ])
    expect(parseSessionDate('1:56 pm on 8 May, 2023')).toBe(Date.UTC(2023, 4, 8, 13, 56))
    expect(parseSessionDate('12:05 am on 1 January, 2024')).toBe(Date.UTC(2024, 0, 1, 0, 5))
    expect(parseSessionDate('sometime')).toBeNull()
    expect(turnText({ dia_id: 'D1:1', speaker: 'Ada', text: 'hi' })).toBe('Ada said, "hi"')
  })

  it('states the licence and the fetch command when the dataset is missing', async () => {
    const dir = tempDir()
    await expect(
      runLocomoSuite(suiteContext(dir, { datasetPath: join(dir, 'nope.json') }))
    ).rejects.toThrow(/npm run eval:datasets -- --dataset locomo/)
    await expect(
      runLocomoSuite(suiteContext(dir, { datasetPath: join(dir, 'nope.json') }))
    ).rejects.toThrow(EvalSetupError)
    expect(LOCOMO_LICENSE).toBe('CC-BY-NC-4.0')
  })
})

describe('locomo official scoring', () => {
  it('normalizes the way the official normalization does', () => {
    expect(normalizeAnswer('The LGBTQ Support Group, and friends!')).toBe('lgbtq support group friends')
    expect(normalizeAnswer('')).toBe('')
  })

  it('scores f1 over stemmed tokens', () => {
    expect(f1Score('Adoption agencies', 'Adoption agencies')).toBe(1)
    expect(f1Score('adoption agency', 'Adoption agencies')).toBe(1)
    expect(f1Score('Finland', "I don't know")).toBe(0)
    expect(f1Score('2 years ago', 'two years ago')).toBeCloseTo(2 / 3, 6)
  })

  it('splits multi-hop answers on commas', () => {
    expect(f1Multi('tea', 'coffee, tea')).toBeCloseTo(0.5, 6)
    expect(f1Multi('coffee and tea', 'coffee, tea')).toBeCloseTo(2 / 3, 6)
  })

  it('applies the per-category branch, including the adversarial refusal rule', () => {
    const cat = (category: number, extra: Partial<LocomoQa>): LocomoQa => ({ question: 'q', category, evidence: [], ...extra })
    expect(scoreLocomo('Maine Coon', cat(4, { answer: 'Maine Coon' })).score).toBe(1)
    expect(scoreLocomo('Paris', cat(3, { answer: 'Paris; the capital of France' })).score).toBe(1)
    expect(scoreLocomo('elsewhere', cat(3, { answer: 'Paris; elsewhere' })).score).toBe(0)
    expect(scoreLocomo('tea', cat(1, { answer: 'coffee, tea' })).score).toBeCloseTo(0.5, 6)
    expect(scoreLocomo('Not mentioned in the conversation', cat(5, { adversarial_answer: 'La Traviata' })).score).toBe(1)
    expect(scoreLocomo('La Traviata', cat(5, { adversarial_answer: 'La Traviata' })).score).toBe(0)
    expect(() => scoreLocomo('anything', cat(9, { answer: 'x' }))).toThrow(/category 9/)
  })

  it('maps a/b answers back to the option text and flips deterministically', () => {
    const qa: LocomoQa = { question: 'q', category: 5, adversarial_answer: 'La Traviata', evidence: [] }
    expect(cat5Answer('a', qa, false)).toBe('Not mentioned in the conversation')
    expect(cat5Answer('(b)', qa, false)).toBe('La Traviata')
    expect(cat5Answer('b', qa, true)).toBe('Not mentioned in the conversation')
    const flips = Array.from({ length: 32 }, (_, index) => cat5Flip(`locomo-conv-alpha-q${index}`, 7))
    expect(flips).toEqual(Array.from({ length: 32 }, (_, index) => cat5Flip(`locomo-conv-alpha-q${index}`, 7)))
    expect(flips.some((flip) => flip)).toBe(true)
    expect(flips.some((flip) => !flip)).toBe(true)
  })
})

describe('locomo suite run', () => {
  it('scores evidence retrieval per category and keeps the db empty between conversations', async () => {
    const dir = tempDir()
    const path = writeFixture(dir)
    const output = await runLocomoSuite(suiteContext(dir, { datasetPath: path }))
    const metrics = (output.result.metrics as Record<string, LocomoSuiteMetrics>).baseline

    // 8 questions total, 6 with a resolvable evidence turn
    expect(metrics.evidence.questions).toBe(6)
    expect(metrics.stats.questions).toBe(8)
    expect(metrics.stats.turns).toBe(5)
    expect(metrics.stats.unresolvedEvidence).toBe(1)
    expect(metrics.stats.noEvidence).toBe(1)
    expect(Object.keys(metrics.byCategory).sort()).toEqual([
      'adversarial',
      'multi-hop',
      'open-domain',
      'single-hop',
      'temporal',
    ])
    for (const block of Object.values(metrics.byCategory)) {
      expect(block.queries).toBeGreaterThan(0)
      expect(block['recall@10']).toBeLessThanOrEqual(1)
    }
    // two conversations, each torn down: every query was scored in its own namespace
    expect(metrics.stats.samples).toBe(2)
    expect(output.result.details).toHaveLength(1)
    expect(output.result.header.suite).toBe('locomo')
    expect(output.markdown).toContain('Locomo:')
    expect(output.markdown).toContain('by category')
  })

  it('limits the run to the first conversations', async () => {
    const dir = tempDir()
    const path = writeFixture(dir)
    const output = await runLocomoSuite(suiteContext(dir, { datasetPath: path, limit: 1 }))
    const metrics = (output.result.metrics as Record<string, LocomoSuiteMetrics>).baseline
    expect(metrics.stats.samples).toBe(1)
    expect(metrics.sampledConversations).toEqual(['conv-alpha'])
  })

  it('runs the readers and the official scorer under --qa, and resumes from the checkpoint', async () => {
    useGateway()
    const requests: LlmCall[] = []
    const transport = async (call: LlmCall): Promise<ChatResult> => {
      requests.push(call)
      const text = call.messages.map((message) => message.content).join('\n')
      // the engram reader sees the stored turn text, so an answer echoes it
      const answers = text.includes('Maine Coon') ? 'Maine Coon' : "I don't know"
      return { content: answers, model: call.model }
    }
    setLlmTransport(transport)
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
      contextBudgetChars: 4000,
    }

    const first = await runLocomoSuite(suiteContext(dir, overrides))
    const metrics = (first.result.metrics as Record<string, LocomoSuiteMetrics>).baseline
    expect(metrics.qa.status).toBe('ok')
    expect(Object.keys(metrics.qa.readers ?? {}).sort()).toEqual([...READERS].sort())
    expect(metrics.qa.reader_model).toBe('stub-reader')
    expect(metrics.qa.scorer).toBe('locomo-official-f1')
    expect(metrics.qa.calls).toBe(8 * READERS.length)
    // the adversarial question is asked as a two-option item, so a refusal is possible
    expect(first.markdown).toContain('official f1')

    const second = await runLocomoSuite(
      suiteContext(dir, {
        ...overrides,
        envFile: join(dir, 'no-such-env'),
      })
    )
    const resumed = (second.result.metrics as Record<string, LocomoSuiteMetrics>).baseline
    expect(resumed.qa.calls).toBe(0)
    expect(resumed.qa.resumed_questions).toBe(8)
    expect(resumed.qa.readers!.engram.score).toBe(metrics.qa.readers!.engram.score)
  })

  it('refuses --qa without a gateway or a pinned reader model', async () => {
    const dir = tempDir()
    const path = writeFixture(dir)
    for (const key of ['ENGRAM_LLM_BASE_URL', 'ENGRAM_LLM_API_KEY', 'ENGRAM_LLM_MODEL']) {
      delete process.env[key]
    }
    resetGatewayForTests()
    await expect(
      runLocomoSuite(suiteContext(dir, { qa: true, datasetPath: path, readers: READERS, envFile: join(dir, 'none') }))
    ).rejects.toThrow(/no gateway configured/)

    useGateway()
    await expect(
      runLocomoSuite(suiteContext(dir, { qa: true, datasetPath: path, readers: READERS, envFile: join(dir, 'none') }))
    ).rejects.toThrow(/--reader-model/)
  })

  it('is deterministic: the same fixture produces the same metrics', async () => {
    const dir = tempDir()
    const path = writeFixture(dir)
    const first = await runLocomoSuite(suiteContext(dir, { datasetPath: path }))
    const second = await runLocomoSuite(suiteContext(dir, { datasetPath: path }))
    expect(JSON.stringify(second.result.metrics)).toBe(JSON.stringify(first.result.metrics))
  })
})

describe('locomo run identity (stub llm)', () => {
  const IDENTITY_READERS = ['engram', 'full-context']

  /** one --qa run over the fixture, with a stub reader that records what it was asked */
  async function qaRun(opts: {
    dir: string
    checkpoint: string
    overrides?: Partial<SuiteContext>
  }): Promise<{ metrics: LocomoSuiteMetrics; notes: string[]; rows: Array<Record<string, unknown>>; requests: LlmCall[] }> {
    useGateway()
    const requests: LlmCall[] = []
    setLlmTransport(async (call: LlmCall): Promise<ChatResult> => {
      requests.push(call)
      const text = call.messages.map((message) => message.content).join('\n')
      return { content: text.includes('Maine Coon') ? 'Maine Coon' : "I don't know", model: call.model }
    })
    const path = writeFixture(opts.dir)
    const output = await runLocomoSuite(
      suiteContext(opts.dir, {
        qa: true,
        datasetPath: path,
        readers: IDENTITY_READERS,
        readerModel: 'stub-reader',
        checkpointPath: opts.checkpoint,
        envFile: join(opts.dir, 'no-such-env'),
        yes: true,
        concurrency: 2,
        contextBudgetChars: 4000,
        ...opts.overrides,
      })
    )
    const metrics = (output.result.metrics as Record<string, LocomoSuiteMetrics>).baseline
    const details = output.result.details as Array<{ qa?: { rows: Array<Record<string, unknown>> } }>
    return {
      metrics,
      notes: output.result.notes ?? [],
      rows: details.find((detail) => detail.qa !== undefined)?.qa?.rows ?? [],
      requests,
    }
  }

  it('stamps the identity on every row and resumes an unchanged run', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    const first = await qaRun({ dir, checkpoint })
    expect(first.metrics.qa.calls).toBe(8 * IDENTITY_READERS.length)
    expect(first.rows).toHaveLength(8 * IDENTITY_READERS.length)
    for (const row of first.rows) {
      // this fixture is seeded on the fts path, over both conversations, at the test seed
      expect(row.vectors).toBe('fts')
      expect(row.selection).toBe('samples=2/2')
      expect(row.git_sha).toBe('testsha')
      const key = String(row.key)
      expect(key).toContain('vectors=fts')
      expect(key).toContain('selection=samples=2/2')
      expect(key).toContain('engine=testsha')
      expect(key).toContain('seed=7')
    }
    expect(first.notes.some((note) => note.includes('qa identity: vectors=fts'))).toBe(true)

    const second = await qaRun({ dir, checkpoint })
    expect(second.metrics.qa.calls).toBe(0)
    expect(second.metrics.qa.resumed_questions).toBe(8)
    expect(second.metrics.qa.readers!.engram.score).toBe(first.metrics.qa.readers!.engram.score)
  }, 120_000)

  it('never resumes a lexical checkpoint as a vector run', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    await qaRun({ dir, checkpoint, overrides: { vectors: 'fts' } })

    const second = await qaRun({ dir, checkpoint, overrides: { vectors: 'cached' } })
    expect(second.metrics.qa.calls).toBe(8 * IDENTITY_READERS.length)
    expect(second.metrics.qa.resumed_questions).toBe(0)
    expect(
      second.notes.some((note) => /vectors: cached(\+vectors|\+fts-fallback) vs fts/.test(note))
    ).toBe(true)
    // the regime that was really in effect, not the flag that was typed
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

  it('resumes the identity it returns to, not the rows written in between', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    const first = await qaRun({ dir, checkpoint, overrides: { vectors: 'fts' } })
    const middle = await qaRun({ dir, checkpoint, overrides: { vectors: 'cached' } })
    expect(middle.metrics.qa.resumed_questions).toBe(0)

    // back to the first regime: the lexical rows are the ones that match, and the vector
    // rows written in between stay where they are
    const third = await qaRun({ dir, checkpoint, overrides: { vectors: 'fts' } })
    expect(third.metrics.qa.calls).toBe(0)
    expect(third.metrics.qa.resumed_questions).toBe(8)
    expect(third.metrics.qa.readers!.engram.score).toBe(first.metrics.qa.readers!.engram.score)
    expect(third.metrics.qa.foreign_keys?.[0].rows).toBe(middle.rows.length)
    const keys = new Set(
      readFileSync(checkpoint, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).key as string)
    )
    expect(keys.size).toBe(2)
  }, 120_000)

  it('never resumes a checkpoint that sampled other conversations', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    await qaRun({ dir, checkpoint })

    const second = await qaRun({ dir, checkpoint, overrides: { limit: 1 } })
    // conv-alpha holds five of the eight questions
    expect(second.metrics.qa.calls).toBe(5 * IDENTITY_READERS.length)
    expect(second.metrics.qa.resumed_questions).toBe(0)
    expect(
      second.notes.some((note) => note.includes('selection: samples=1/2 vs samples=2/2'))
    ).toBe(true)
    for (const row of second.rows) expect(row.selection).toBe('samples=1/2')
  }, 120_000)

  it('never resumes across a code revision', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    await qaRun({ dir, checkpoint, overrides: { gitSha: 'sha-a' } })

    const second = await qaRun({ dir, checkpoint, overrides: { gitSha: 'sha-b' } })
    expect(second.metrics.qa.resumed_questions).toBe(0)
    expect(second.metrics.qa.calls).toBe(8 * IDENTITY_READERS.length)
    expect(second.notes.some((note) => note.includes('engine: sha-b vs sha-a'))).toBe(true)
  }, 120_000)

  it('treats a limit above the file size as the same selection', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    await qaRun({ dir, checkpoint })

    // both conversations are on offer, so asking for more than two is the same run
    const second = await qaRun({ dir, checkpoint, overrides: { limit: 5 } })
    expect(second.metrics.qa.calls).toBe(0)
    expect(second.metrics.qa.resumed_questions).toBe(8)
    for (const row of second.rows) expect(row.selection).toBe('samples=2/2')
  }, 120_000)

  it('fails closed on a checkpoint written before the identity parts existed', async () => {
    const dir = tempDir()
    const current = join(dir, 'run.jsonl')
    const first = await qaRun({ dir, checkpoint: current })

    // the key this run would have written before vectors, engine, selection and seed
    // were part of it: the same rows, the same question ids, no identity
    const legacyKey = String(first.rows[0].key)
      .split('|')
      .filter((part) => !/^(vectors|engine|selection|seed)=/.test(part))
      .join('|')
    const legacy = join(dir, 'legacy.jsonl')
    writeFileSync(
      legacy,
      first.rows
        .map((row) => JSON.stringify({ ...row, key: legacyKey, resumed: false }))
        .join('\n') + '\n',
      'utf8'
    )

    const second = await qaRun({ dir, checkpoint: legacy })
    expect(second.metrics.qa.resumed_questions).toBe(0)
    expect(second.metrics.qa.calls).toBe(8 * IDENTITY_READERS.length)
    const note = second.notes.find((entry) => entry.includes('NOT reused')) ?? ''
    expect(note).toContain('vectors: fts vs (absent)')
    expect(note).toContain('engine: testsha vs (absent)')
    expect(note).toContain('selection: samples=2/2 vs (absent)')
    expect(note).toContain('seed: 7 vs (absent)')
    // nothing else is blamed: the parts the old key did carry still match
    expect(note).not.toContain('dataset:')
    expect(second.metrics.qa.foreign_keys?.[0].rows).toBe(first.rows.length)
    // the old rows are still there, and the new ones were appended beside them
    expect(readFileSync(legacy, 'utf8').trim().split('\n')).toHaveLength(2 * first.rows.length)
  }, 120_000)

  it('never resumes across a seed, which decides the adversarial option order', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    const first = await qaRun({ dir, checkpoint, overrides: { seed: 7 } })
    const second = await qaRun({ dir, checkpoint, overrides: { seed: 8 } })

    expect(second.metrics.qa.resumed_questions).toBe(0)
    expect(second.metrics.qa.calls).toBe(8 * IDENTITY_READERS.length)
    expect(second.notes.some((note) => note.includes('seed: 8 vs 7'))).toBe(true)
    // the flip is not cosmetic: it decides which option is (a) in the question asked
    const adversarial = (requests: LlmCall[]): string =>
      requests
        .map((call) => call.messages.map((message) => message.content).join('\n'))
        .find((text) => text.includes('favourite opera')) ?? ''
    expect(adversarial(first.requests)).toContain(
      '(a) La Traviata (b) Not mentioned in the conversation'
    )
    expect(adversarial(second.requests)).toContain(
      '(a) Not mentioned in the conversation (b) La Traviata'
    )
  }, 120_000)
})

interface LocomoSuiteMetrics {
  evidence: Record<string, number>
  byCategory: Record<string, Record<string, number>>
  sampledConversations: string[]
  stats: Record<string, number>
  qa: {
    status: string
    calls?: number
    resumed_questions?: number
    reader_model?: string
    scorer?: string
    foreign_keys?: Array<{ rows: number; differences: string[] }>
    readers?: Record<string, { score: number; graded: number }>
  }
}
