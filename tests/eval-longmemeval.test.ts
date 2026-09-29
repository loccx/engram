// longmemeval qa tests: a stub llm over a tiny synthetic s-shaped split (several
// sessions per question, six question types, one unanswerable `_abs` question).
// the stub replaces the network call only — gateway presence, model pinning,
// checkpointing, aggregation and the cost gate all run for real, and the credentials
// are inert fixtures that never reach a socket.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLongMemEvalSuite } from '../eval/suites/longmemeval.js'
import { resetGatewayForTests, setLlmTransport, type LlmCall } from '../eval/lib/llm.js'
import { buildHeader } from '../eval/lib/report.js'
import { resolveConfigs } from '../eval/lib/registry.js'
import { resetTokenizerForTests } from '../eval/lib/metrics.js'
import type { SuiteContext } from '../eval/suites/types.js'
import type { ChatResult } from '../src/llm/client.js'

const tempDirs: string[] = []
const READERS = ['engram', 'full-context', 'naive-rag']
const EVIDENCE = 'gold-fact'

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-lme-test-'))
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
  process.env.ENGRAM_LLM_API_KEY = 'sk-test-not-a-real-key'
  process.env.ENGRAM_LLM_MODEL = 'test-model'
  resetGatewayForTests()
}

interface FakeQuestion {
  id: string
  type: string
  question: string
  answer: string
  sessions: number
  /** index of the session carrying evidence, -1 for the unanswerable one */
  evidenceAt: number
}

const QUESTIONS: FakeQuestion[] = [
  {
    id: 'q-one',
    type: 'single-session-user',
    question: 'What is the code phrase for the cinder deploy window?',
    answer: `${EVIDENCE} is the cinder code phrase`,
    sessions: 4,
    evidenceAt: 3,
  },
  {
    id: 'q-two',
    type: 'knowledge-update',
    question: 'How long is the cinder deploy window now?',
    answer: `${EVIDENCE} covers the cinder deploy window length`,
    sessions: 4,
    evidenceAt: 1,
  },
  {
    id: 'q-three',
    type: 'multi-session',
    question: 'Which two reviewers signed off on the cinder deploy window?',
    answer: `the cinder sign-off pair is ${EVIDENCE}`,
    sessions: 5,
    evidenceAt: 2,
  },
  {
    id: 'q-four',
    type: 'single-session-preference',
    question: 'How do I like the cinder deploy summary formatted?',
    answer: `preference marker ${EVIDENCE}`,
    sessions: 4,
    evidenceAt: 0,
  },
  {
    id: 'q-five',
    type: 'temporal-reasoning',
    question: 'How many days before the cinder deploy window did the rename land?',
    answer: `the rename offset is ${EVIDENCE}`,
    sessions: 6,
    evidenceAt: 5,
  },
  {
    id: 'q-six_abs',
    type: 'single-session-user',
    question: 'What is the passphrase for the cinder rollback drill?',
    answer: 'You did not mention a cinder rollback passphrase.',
    sessions: 4,
    evidenceAt: -1,
  },
]

function buildDataset(path: string): void {
  const records = QUESTIONS.map((q) => {
    const sessions = Array.from({ length: q.sessions }, (_, i) => {
      const evidence = i === q.evidenceAt
      const chat = [
        {
          role: 'user',
          content:
            evidence
              ? `i keep losing the note: ${q.answer}. cinder deploy window details, reviewers, offsets.`
              : `about the cinder deploy window, session ${i}: the reviewers, offsets and timings are written down.`,
        },
        {
          role: 'assistant',
          content:
            `noted for the cinder deploy window (part ${i}). ` +
            'the rollout checklist mentions reviewers, offsets, timings and a rollback drill. '.repeat(6),
          ...(evidence ? { has_answer: true } : {}),
        },
      ]
      return chat
    })
    return {
      question_id: q.id,
      question: q.question,
      answer: q.answer,
      question_type: q.type,
      question_date: '2023/04/10 (Mon) 17:50',
      haystack_session_ids: sessions.map((_, i) => `sess-${q.id}-${i}`),
      haystack_dates: sessions.map(() => '2023/04/10 (Mon) 17:50'),
      haystack_sessions: sessions,
      answer_session_ids:
        q.evidenceAt >= 0 ? [`sess-${q.id}-${q.evidenceAt}`] : [`sess-${q.id}-0`],
    }
  })
  writeFileSync(path, JSON.stringify(records), 'utf8')
}

interface Stub {
  requests: LlmCall[]
  transport: (call: LlmCall) => Promise<ChatResult>
}

/**
 * deterministic stub: one user message is the judge call, two are the reader call. the
 * reader echoes ANSWER-OK once the context carries the evidence marker, and the judge
 * says yes when the response earned it (the abstention prompt wants "I don't know").
 */
function stubLlm(): Stub {
  const requests: LlmCall[] = []
  return {
    requests,
    transport: async (call) => {
      requests.push(call)
      const text = call.messages.map((m) => m.content).join('\n')
      if (call.messages.length === 1) {
        const wantsAbstention = text.includes('unanswerable')
        const satisfied = wantsAbstention
          ? text.includes("I don't know")
          : text.includes('ANSWER-OK')
        return { content: satisfied ? 'yes' : 'no', model: call.model }
      }
      return {
        content: text.includes(EVIDENCE) ? 'ANSWER-OK' : "I don't know",
        model: call.model,
      }
    },
  }
}

function suiteContext(dir: string, overrides: Partial<SuiteContext> = {}): SuiteContext {
  return {
    seed: 11,
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

interface QaMetrics {
  status: string
  questions_answered?: number
  calls?: number
  resumed_questions?: number
  resumed_rows?: number
  checkpoint?: string
  failures?: unknown[]
  estimate?: { calls: number }
  readers?: Record<
    string,
    {
      graded: number
      correct: number
      accuracy: number
      resumed: number
      avg_input_tokens: number
      avg_context_tokens: number
      by_question_type: Record<string, { graded: number; correct: number; accuracy: number }>
    }
  >
}

async function runQa(opts: {
  dir: string
  checkpoint: string
  stub: Stub
  overrides?: Partial<SuiteContext>
}): Promise<{ metrics: QaMetrics; result: Awaited<ReturnType<typeof runLongMemEvalSuite>> }> {
  useGateway()
  setLlmTransport(opts.stub.transport)
  const datasetPath = join(opts.dir, 'longmemeval_s_cleaned.json')
  buildDatasetIfMissing(datasetPath)
  const output = await runLongMemEvalSuite(
    suiteContext(opts.dir, {
      qa: true,
      dataset: 'longmemeval_s_cleaned',
      datasetPath,
      readers: READERS,
      readerModel: 'stub-reader',
      judgeModel: 'stub-judge',
      checkpointPath: opts.checkpoint,
      contextBudgetChars: 2000,
      concurrency: 2,
      yes: true,
      envFile: join(opts.dir, 'no-such-env-file'),
      ...opts.overrides,
    })
  )
  const baseline = (output.result.metrics as Record<string, { qa: QaMetrics }>).baseline
  return { metrics: baseline.qa, result: output }
}

function buildDatasetIfMissing(path: string): void {
  try {
    readFileSync(path)
  } catch {
    buildDataset(path)
  }
}

describe('per-question teardown', () => {
  it('dropNamespace removes the question rows, their fts entries and their session', async () => {
    const { EvalHarness } = await import('../eval/lib/harness.js')
    const harness = await EvalHarness.create({ seed: 3, vectors: 'fts' })
    try {
      const corpus = {
        name: 'teardown',
        seed: 3,
        memories: [
          {
            id: 'm1',
            namespace: '/longmemeval/q-teardown',
            content: 'the cinder deploy window code phrase is gold-fact',
            created_at: 1_700_000_000_000,
          },
        ],
        queries: [],
      }
      await harness.seedCorpus(corpus, { mode: 'raw' })
      const found = await harness.runSearch('cinder deploy window code phrase', {
        project_path: '/longmemeval/q-teardown',
      })
      expect(found.length).toBeGreaterThan(0)

      harness.dropNamespace('/longmemeval/q-teardown')
      expect(harness.stats().memories).toBe(0)
      const after = await harness.runSearch('cinder deploy window code phrase', {
        project_path: '/longmemeval/q-teardown',
      })
      expect(after).toEqual([])
      const sessions = harness.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
      expect(sessions.n).toBe(0)
    } finally {
      harness.dispose()
    }
  }, 60_000)
})

describe('longmemeval qa (stub llm)', () => {
  it('runs every reader end to end and records per-question cost and verdicts', async () => {
    const dir = tempDir()
    const stub = stubLlm()
    const { metrics, result } = await runQa({ dir, checkpoint: join(dir, 'run.jsonl'), stub })

    expect(metrics.status).toBe('ok')
    expect(Object.keys(metrics.readers ?? {}).sort()).toEqual([...READERS].sort())
    expect(metrics.questions_answered).toBe(QUESTIONS.length)
    // 6 questions x 3 readers x (reader + judge)
    expect(metrics.calls).toBe(QUESTIONS.length * READERS.length * 2)
    expect(stub.requests).toHaveLength(metrics.calls!)

    const full = metrics.readers!['full-context']
    expect(full.graded).toBe(QUESTIONS.length)
    // the ceiling sees every session, so it always finds the evidence
    expect(full.accuracy).toBe(1)
    const engram = metrics.readers!.engram
    expect(engram.graded).toBe(QUESTIONS.length)
    expect(engram.accuracy).toBeGreaterThanOrEqual(0)
    expect(engram.accuracy).toBeLessThanOrEqual(1)
    // the budget binds: the ceiling sends strictly more context
    expect(full.avg_context_tokens).toBeGreaterThan(engram.avg_context_tokens)
    expect(engram.avg_input_tokens).toBeGreaterThan(0)

    const rows = (result.result.details as Array<{ qa?: { rows: Array<Record<string, unknown>> } }>).find(
      (entry) => entry.qa !== undefined
    )?.qa?.rows
    expect(rows).toHaveLength(QUESTIONS.length * READERS.length)
    for (const row of rows!) {
      expect(typeof row.predicted).toBe('string')
      expect(typeof row.correct).toBe('boolean')
      expect(row.input_tokens as number).toBeGreaterThan(0)
      expect(row.context_tokens as number).toBeGreaterThan(0)
      expect(row.token_source).toBe('estimated')
    }
    // checkpoint is append-only jsonl, one line per row
    const lines = readFileSync(join(dir, 'run.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(rows!.length)
    expect(JSON.parse(lines[0]).key).toBeTruthy()
  }, 120_000)

  it('aggregates accuracy per question_type and per reader', async () => {
    const dir = tempDir()
    const stub = stubLlm()
    const { metrics } = await runQa({ dir, checkpoint: join(dir, 'run.jsonl'), stub })

    const types = new Set(QUESTIONS.map((q) => q.type))
    for (const [name, agg] of Object.entries(metrics.readers ?? {})) {
      const graded = Object.values(agg.by_question_type).reduce((sum, s) => sum + s.graded, 0)
      const correct = Object.values(agg.by_question_type).reduce((sum, s) => sum + s.correct, 0)
      expect(graded, `${name}: per-type graded`).toBe(agg.graded)
      expect(correct, `${name}: per-type correct`).toBe(agg.correct)
      for (const type of Object.keys(agg.by_question_type)) {
        expect(types.has(type), `${name}: unexpected type ${type}`).toBe(true)
      }
    }
    // the unanswerable question is graded through the abstention prompt
    expect(metrics.readers!.engram.by_question_type['single-session-user'].graded).toBe(2)
  }, 120_000)

  it('resumes from the checkpoint without a single new call', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    const first = await runQa({ dir, checkpoint, stub: stubLlm() })

    const second = await runQa({
      dir,
      checkpoint,
      stub: {
        requests: [],
        transport: async () => {
          throw new Error('resume must not call the llm again')
        },
      },
    })

    expect(second.metrics.status).toBe('ok')
    expect(second.metrics.calls).toBe(0)
    expect(second.metrics.resumed_questions).toBe(QUESTIONS.length)
    expect(second.metrics.resumed_rows).toBe(QUESTIONS.length * READERS.length)
    for (const name of READERS) {
      expect(second.metrics.readers![name].accuracy).toBe(first.metrics.readers![name].accuracy)
      expect(second.metrics.readers![name].resumed).toBe(QUESTIONS.length)
    }
  }, 120_000)

  it('refuses to spend above the call ceiling until --yes is passed', async () => {
    const dir = tempDir()
    const stub = stubLlm()
    await expect(
      runQa({ dir, checkpoint: join(dir, 'run.jsonl'), stub, overrides: { yes: false, costCeilingCalls: 1 } })
    ).rejects.toThrow(/--yes/)
    expect(stub.requests).toHaveLength(0)

    // below the ceiling the same run proceeds without --yes
    const allowed = await runQa({
      dir,
      checkpoint: join(dir, 'allowed.jsonl'),
      stub: stubLlm(),
      overrides: { yes: false, costCeilingCalls: 1000 },
    })
    expect(allowed.metrics.status).toBe('ok')
    expect(allowed.metrics.estimate?.calls).toBe(QUESTIONS.length * READERS.length * 2)
  }, 120_000)

  it('refuses --qa without pinned models', async () => {
    const dir = tempDir()
    const datasetPath = join(dir, 'longmemeval_s_cleaned.json')
    buildDataset(datasetPath)
    useGateway()

    await expect(
      runLongMemEvalSuite(
        suiteContext(dir, {
          qa: true,
          dataset: 'longmemeval_s_cleaned',
          datasetPath,
          readers: READERS,
          checkpointPath: join(dir, 'run.jsonl'),
          envFile: join(dir, 'no-such-env-file'),
        })
      )
    ).rejects.toThrow(/--judge-model/)
  }, 60_000)

  it('fails hard when --qa is asked for without a gateway', async () => {
    const dir = tempDir()
    const datasetPath = join(dir, 'longmemeval_s_cleaned.json')
    buildDataset(datasetPath)
    for (const key of ['ENGRAM_LLM_BASE_URL', 'ENGRAM_LLM_API_KEY', 'ENGRAM_LLM_MODEL']) {
      delete process.env[key]
    }
    resetGatewayForTests()

    await expect(
      runLongMemEvalSuite(
        suiteContext(dir, {
          qa: true,
          dataset: 'longmemeval_s_cleaned',
          datasetPath,
          readers: READERS,
          readerModel: 'stub-reader',
          judgeModel: 'stub-judge',
          checkpointPath: join(dir, 'run.jsonl'),
          envFile: join(dir, 'no-such-env-file'),
        })
      )
    ).rejects.toThrow(/no gateway configured/)

    // and the retrieval-only path still runs offline for the same file
    const offline = await runLongMemEvalSuite(
      suiteContext(dir, { qa: false, dataset: 'longmemeval_s_cleaned', datasetPath })
    )
    const qa = (offline.result.metrics as Record<string, { qa: { status: string } }>).baseline.qa
    expect(qa.status).toBe('skipped')
    expect(
      (offline.result.metrics as Record<string, { questions: number }>).baseline.questions
    ).toBe(QUESTIONS.length)
  }, 120_000)

  it('keeps only the requested question_type, and --limit counts matches', async () => {
    const dir = tempDir()
    const datasetPath = join(dir, 'longmemeval_s_cleaned.json')
    buildDataset(datasetPath)

    const only = async (
      overrides: Partial<SuiteContext>
    ): Promise<{ questions: number; processed: number; types: string[]; notes: string[] }> => {
      const output = await runLongMemEvalSuite(
        suiteContext(dir, { qa: false, dataset: 'longmemeval_s_cleaned', datasetPath, ...overrides })
      )
      const baseline = (
        output.result.metrics as {
          baseline: { questions: number; processedQuestions: number; byQuestionType: Record<string, unknown> }
        }
      ).baseline
      return {
        questions: baseline.questions,
        processed: baseline.processedQuestions,
        types: Object.keys(baseline.byQuestionType).sort(),
        notes: output.result.notes ?? [],
      }
    }

    const one = await only({ questionTypes: ['multi-session'] })
    expect(one.questions).toBe(1)
    expect(one.processed).toBe(1)
    expect(one.types).toEqual(['multi-session'])
    expect(one.notes.some((note) => note.includes('question_type filter: kept 1 of 6'))).toBe(true)

    // the file groups types, so a filtered run must scan past the earlier records
    const pair = await only({ questionTypes: ['single-session-user'] })
    expect(pair.questions).toBe(2)
    expect(pair.types).toEqual(['single-session-user'])

    const capped = await only({ questionTypes: ['single-session-user', 'multi-session'], limit: 2 })
    expect(capped.questions).toBe(2)
    expect(capped.types).toEqual(['multi-session', 'single-session-user'])

    const unfiltered = await only({})
    expect(unfiltered.questions).toBe(QUESTIONS.length)
    expect(unfiltered.types).toHaveLength(5)
  }, 120_000)

  it('is deterministic: same seed and stub produce identical metrics and rows', async () => {
    const dir = tempDir()
    const checkpoint = join(dir, 'run.jsonl')
    const first = await runQa({ dir, checkpoint, stub: stubLlm() })
    rmSync(checkpoint)
    const second = await runQa({ dir, checkpoint, stub: stubLlm() })

    expect(JSON.stringify(second.metrics)).toBe(JSON.stringify(first.metrics))

    const rows = (output: Awaited<ReturnType<typeof runLongMemEvalSuite>>) =>
      JSON.stringify(
        (output.result.details as Array<{ qa?: { rows: unknown[] } }>).find((d) => d.qa)?.qa?.rows,
        (key, value) => (key.endsWith('_ms') ? 0 : value)
      )
    expect(rows(second.result)).toBe(rows(first.result))

    // the markdown body is identical apart from the wall-clock latency table
    const withoutLatency = (markdown: string): string => markdown.split('### latency')[0]
    expect(withoutLatency(second.result.markdown)).toBe(withoutLatency(first.result.markdown))
  }, 120_000)
})
