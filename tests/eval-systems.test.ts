// systems registry tests: every system has to answer in the corpus-local id space, and
// the ported engram reader has to keep the exact context it served before it moved onto
// the registry.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvalHarness } from '../eval/lib/harness.js'
import { resetTokenizerForTests, resolveTokenizer } from '../eval/lib/metrics.js'
import { readerFor } from '../eval/lib/readers.js'
import { EvalSetupError } from '../eval/lib/errors.js'
import {
  builtinCodeHash,
  checkSystemSpecs,
  closeAll,
  createSystems,
  requestedSystemSpecs,
  systemNames,
  SYSTEMS,
  systemKey,
  systemSpecSlug,
  turnSystemFactory,
  turnsNamespace,
  type MemorySystem,
  type SystemSession,
} from '../eval/lib/systems.js'
import { aggregateSystems, scoreSystemQuery } from '../eval/lib/systems-score.js'
import {
  assembleTurnContext,
  isAggregationQuery,
  parseTurnMemoryId,
  turnsOf,
  type TurnHit,
  type TurnSessionMeta,
} from '../eval/lib/turns.js'
import { runLongMemEvalSuite } from '../eval/suites/longmemeval.js'
import { buildHeader } from '../eval/lib/report.js'
import { resolveConfigs } from '../eval/lib/registry.js'
import type { SuiteContext } from '../eval/suites/types.js'
import type { Corpus, CorpusMemory } from '../eval/lib/types.js'

const NS = '/longmemeval/golden-q'
const EVIDENCE = 'the deploy window for the golden fixture is 09:00-11:30 utc'
const QUESTION = 'when is the deploy window for the golden fixture?'

const tempDirs: string[] = []
const harnesses: EvalHarness[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-systems-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()!.dispose()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
  resetTokenizerForTests()
})

async function harness(): Promise<EvalHarness> {
  const created = await EvalHarness.create({ seed: 7, vectors: 'fts' })
  harnesses.push(created)
  return created
}

function fixture(): Corpus {
  return {
    name: 'golden',
    seed: 7,
    memories: [
      {
        id: 'g1',
        namespace: NS,
        content: EVIDENCE,
        created_at: 1_700_000_000_000,
        pinned: true,
        tags: ['longmemeval', 'single-session-user'],
      },
      {
        id: 'g2',
        namespace: NS,
        content: 'the golden fixture rollback drill runs right after the deploy window',
        created_at: 1_700_000_100_000,
        tags: ['longmemeval'],
      },
      {
        id: 'g3',
        namespace: NS,
        content: 'the pricing table for the golden fixture lives in a spreadsheet',
        created_at: 1_700_000_200_000,
        tags: ['longmemeval'],
      },
    ],
    queries: [],
    clusters: [
      {
        namespace: NS,
        member_ids: ['g1', 'g2'],
        summary: 'golden fixture deploy logistics: window and drill',
        created_at: 1_700_000_300_000,
      },
    ],
  }
}

function sessions(corpus: Corpus): Array<{ id: string; text: string; createdAt: number; tags: string[] }> {
  return corpus.memories.map((memory) => ({
    id: memory.id,
    text: memory.content,
    createdAt: memory.created_at,
    tags: memory.tags ?? [],
  }))
}

async function seededHarness(corpus: Corpus): Promise<EvalHarness> {
  const created = await harness()
  await created.seedCorpus(corpus, { mode: 'raw' })
  return created
}

function engramOnly(): string[] {
  return ['engram']
}

/** one s-shaped record, enough for the suite to stream, seed, score and report */
function dataset(): unknown[] {
  return [
    {
      question_id: 'q-systems',
      question: QUESTION,
      answer: EVIDENCE,
      question_type: 'single-session-user',
      question_date: '2023/04/10 (Mon) 17:50',
      haystack_session_ids: ['sess-0', 'sess-1'],
      haystack_dates: ['2023/04/10 (Mon) 17:50', '2023/04/11 (Tue) 10:00'],
      haystack_sessions: [
        [
          { role: 'user', content: 'what is the deploy window?' },
          { role: 'assistant', content: EVIDENCE, has_answer: true },
        ],
        [
          { role: 'user', content: 'anything else?' },
          { role: 'assistant', content: 'the pricing table lives in a spreadsheet' },
        ],
      ],
      answer_session_ids: ['sess-0'],
    },
  ]
}

function suiteContext(dir: string, overrides: Partial<SuiteContext> = {}): SuiteContext {
  return {
    seed: 11,
    configs: resolveConfigs(['baseline']),
    vectors: 'fts',
    qa: false,
    outDir: dir,
    gitSha: 'testsha',
    buildHeader: (input) => buildHeader({ ...input, git: undefined }),
    log: () => {},
    ...overrides,
  }
}

interface SystemsBlock {
  coverage: number
  recall: Record<string, number>
  adapter_kind: string
  adapter_config_hash: string
  write_calls: number
  avg_served: number
  sessions_per_q: number
  evidence_turn_coverage: number | null
  evidence_turn_scored: number
  avg_context_tokens: number
}

describe('systems registry', () => {
  it('lists the builtins in registry order', () => {
    expect(systemNames()).toEqual([
      'engram',
      'engram-assemble',
      'engram-turns',
      'engram-turns-w3',
      'engram-hybrid',
      'engram-turns-agg',
      'engram-episodes',
      'engram-episodes-fts',
      'engram-episodes-breadth',
      'engram-episodes-breadth-reserve',
      'engram-episodes-statements',
      'engram-episodes-routed',
      'full-context',
      'naive-rag',
    ])
  })

  it('reports what a system stored: engram under --vectors cached holds vectors', async () => {
    const h = await EvalHarness.create({
      seed: 7,
      vectors: 'cached',
      embedder: async () => {
        const vector = new Float32Array(768)
        vector[0] = 1
        return vector
      },
    })
    harnesses.push(h)
    // no cached model on this machine: vectors are off, nothing to assert
    if (!h.vectorsAvailable) return
    const corpus = fixture()
    await h.seedCorpus(corpus, { mode: 'raw', embed: true })
    const built = await createSystems(['engram', 'engram-turns'], { harness: h, topK: 10, seed: 7 })
    try {
      for (const system of built) {
        await system.reset(NS)
        await system.ingest(NS, turnSessions(corpus))
      }
      const stored = built.find((system) => system.name === 'engram')!.storedVectors!()
      expect(stored.memories.rows).toBe(corpus.memories.length)
      expect(stored.memories.vectors).toBe(corpus.memories.length)
      // turns stay lexical by design, and say so rather than looking like a bug
      const turns = built.find((system) => system.name === 'engram-turns')!
      expect(turns.storedVectors!().memories.vectors).toBe(0)
      expect(turns.lexicalOnly).toBe(true)
    } finally {
      await closeAll(built)
    }
  })

  it('labels the systems that have no vector channel, so a stored 0 is not read as a bug', async () => {
    const h = await harness()
    try {
      const built = await createSystems(
        ['engram', 'engram-turns', 'engram-episodes', 'engram-episodes-fts'],
        { harness: h, topK: 10, seed: 7 }
      )
      const byName = new Map(built.map((system) => [system.name, system]))
      expect(byName.get('engram-turns')?.lexicalOnly).toBe(true)
      expect(byName.get('engram-episodes-fts')?.lexicalOnly).toBe(true)
      expect(byName.get('engram')?.lexicalOnly ?? false).toBe(false)
      expect(byName.get('engram-episodes')?.lexicalOnly ?? false).toBe(false)
      // the report reads the instance, so the factory flag alone is not enough
      for (const name of ['engram-turns', 'engram-turns-w3', 'engram-hybrid', 'engram-turns-agg', 'engram-episodes-fts']) {
        expect(SYSTEMS.find((system) => system.name === name)?.lexicalOnly).toBe(true)
      }
      await closeAll(built)
    } finally {
      h.dispose()
    }
  })

  it('keeps the turn systems out of a bare qa comparison', async () => {
    expect(requestedSystemSpecs({ qa: true })).toEqual(['engram', 'full-context', 'naive-rag'])
    expect(requestedSystemSpecs({ systems: ['engram', 'engram-turns'] })).toEqual([
      'engram',
      'engram-turns',
    ])
    expect(() =>
      checkSystemSpecs(['engram-turns', 'engram-turns-w3', 'engram-hybrid', 'engram-episodes'])
    ).not.toThrow()
  })

  it('rejects an unknown name before any server starts', () => {
    expect(() => checkSystemSpecs(['engram', 'no-such-system'])).toThrow(EvalSetupError)
    expect(() => checkSystemSpecs(['engram', 'no-such-system'])).toThrow(/unknown system/)
  })

  it('fails loud on an unreadable adapter config', async () => {
    const h = await harness()
    await expect(
      createSystems(['mcp:does/not/exist.json'], { harness: h, topK: 10, seed: 7 })
    ).rejects.toThrow(/not readable/)
  })

  it('refuses two systems with the same name', async () => {
    const dir = tempDir()
    const path = join(dir, 'engram-name.json')
    writeFileSync(
      path,
      JSON.stringify({
        name: 'engram',
        transport: { kind: 'http', url: 'http://127.0.0.1:1/mcp' },
        write: { tool: 'store_memory' },
        search: { tool: 'recall_context' },
        context: { sections: ['digest'] },
      }),
      'utf8'
    )
    const h = await harness()
    await expect(
      createSystems(['engram', `mcp:${path}`], { harness: h, topK: 10, seed: 7 })
    ).rejects.toThrow(/both named "engram"/)
  })

  it('names a run from the adapter config, not the path', () => {
    expect(systemSpecSlug('engram')).toBe('engram')
    expect(systemSpecSlug('mcp:eval/adapters/engram-mcp.json')).toBe('engram-mcp')
  })
})

describe('engram system', () => {
  it('serves the same context the reader served before the registry', async () => {
    const corpus = fixture()
    const seeded = await seededHarness(corpus)
    const [system] = await createSystems(engramOnly(), { harness: seeded, topK: 10, seed: 7 })
    try {
      await system.reset(NS)
      await system.ingest(NS, sessions(corpus))
      const retrieved = await system.retrieve(NS, QUESTION, 2000)

      // captured from eval/lib/readers.ts before the port; a change here changes every
      // accuracy number that was produced with it
      expect(retrieved.blocks).toEqual([
        '- [note] the deploy window for the golden fixture is 09:00-11:30 utc',
        'the deploy window for the golden fixture is 09:00-11:30 utc',
        'the golden fixture rollback drill runs right after the deploy window',
        'the pricing table for the golden fixture lives in a spreadsheet',
        'golden fixture deploy logistics: window and drill',
      ])
      expect(retrieved.context).toBe(retrieved.blocks.join('\n\n'))
      expect(retrieved.context.length).toBe(315)
      expect(retrieved.note).toBe('used=307/2000 chars, memories=3, dropped=0')

      const tokenizer = await resolveTokenizer()
      const reader = readerFor(system)
      const context = await reader.build({
        question: QUESTION,
        namespace: NS,
        budgetChars: 2000,
        tokenizer,
        retrieved,
      })
      expect(context.chars).toBe(retrieved.context.length)
      expect(context.tokens).toBe(tokenizer.count(retrieved.context))
      expect(context.adapterKind).toBe('builtin')
      expect(context.adapterConfigHash).toBe('')
      expect(context.system).toBe('engram')
    } finally {
      await closeAll([system])
    }
  }, 60_000)

  it('reports the sessions ingest made durable', async () => {
    const corpus = fixture()
    const seeded = await seededHarness(corpus)
    const [system] = await createSystems(engramOnly(), { harness: seeded, topK: 10, seed: 7 })
    try {
      await system.ingest(NS, sessions(corpus))
      expect(system.cost()).toEqual({ writeCalls: 3, writeTokens: 0 })
    } finally {
      await closeAll([system])
    }
  }, 60_000)

  it('ingests into a namespace the caller did not seed', async () => {
    const corpus = fixture()
    const h = await harness()
    const [system] = await createSystems(engramOnly(), { harness: h, topK: 10, seed: 7 })
    try {
      await system.ingest(NS, sessions(corpus))
      const retrieved = await system.retrieve(NS, QUESTION, 2000)
      expect(retrieved.context).toContain(EVIDENCE)
    } finally {
      await closeAll([system])
    }
  }, 60_000)
})

describe('engram-assemble system', () => {
  it('serves the qa recipe in the corpus-local id space', async () => {
    const corpus = fixture()
    const seeded = await seededHarness(corpus)
    const [system] = await createSystems(['engram-assemble'], { harness: seeded, topK: 10, seed: 7 })
    try {
      await system.reset(NS)
      await system.ingest(NS, sessions(corpus))
      const retrieved = await system.retrieve(NS, QUESTION, 2000)

      // the memories section carries the answer and the summaries keep the digest and the
      // cluster summary; this system writes no episodes, so the evidence section is empty
      // and nothing is deduped
      expect(retrieved.context).toContain(EVIDENCE)
      expect(retrieved.context).toContain('golden fixture deploy logistics: window and drill')
      expect(retrieved.note).toContain('recipe=qa')
      expect(retrieved.note).toContain('deduped=0')
      expect(retrieved.items.map((item) => item.ref)).toEqual(['g1', 'g2', 'g3'])
      expect(retrieved.context).toBe(retrieved.blocks.join('\n\n'))
    } finally {
      await closeAll([system])
    }
  }, 60_000)

  it('reports the sessions ingest made durable', async () => {
    const corpus = fixture()
    const seeded = await seededHarness(corpus)
    const [system] = await createSystems(['engram-assemble'], { harness: seeded, topK: 10, seed: 7 })
    try {
      await system.ingest(NS, sessions(corpus))
      expect(system.cost()).toEqual({ writeCalls: 3, writeTokens: 0 })
    } finally {
      await closeAll([system])
    }
  }, 60_000)
})

const TURNS_NS = '/longmemeval/turn-fixture'
const DEPLOY_QUESTION = 'when is the deploy window?'

/** three sessions with explicit turns: the answer sits in one turn of the oldest one */
function turnCorpus(): Corpus {
  const session = (
    id: string,
    createdAt: number,
    turns: Array<[string, string]>,
    extra: Array<[string, string]> = []
  ): CorpusMemory => ({
    id,
    namespace: TURNS_NS,
    content: turns.map(([role, text]) => `${role}: ${text}`).join('\n'),
    created_at: createdAt,
    tags: ['longmemeval', 'single-session-user'],
    turns: [...turns, ...extra].map(([role, text]) => ({ role, text })),
  })
  return {
    name: 'turn-fixture',
    seed: 7,
    memories: [
      session('ts1', 1_700_000_000_000, [
        ['user', 'morning check-in'],
        ['assistant', 'rota looks clear'],
        ['user', 'what about the deploy'],
        ['assistant', 'the deploy window is 09:00-11:30 utc'],
        ['user', 'noted'],
      ]),
      session('ts2', 1_700_000_100_000, [
        ['user', 'any deploy news'],
        ['assistant', 'the rollback drill follows the deploy window'],
      ]),
      session('ts3', 1_700_000_200_000, [
        ['user', 'pricing'],
        ['assistant', 'the pricing table lives in a spreadsheet'],
      ]),
    ],
    queries: [],
  }
}

function turnSessions(corpus: Corpus): SystemSession[] {
  return corpus.memories.map((memory) => ({
    id: memory.id,
    text: memory.content,
    createdAt: memory.created_at,
    tags: memory.tags ?? [],
    turns: memory.turns,
  }))
}

describe('aggregation detection', () => {
  it('reads a counting question as aggregation and a single-fact question as not', () => {
    expect(isAggregationQuery('How many different doctors did I visit?')).toBe(true)
    expect(isAggregationQuery('How much did I spend on workshops in total?')).toBe(true)
    expect(isAggregationQuery('How often did I bake bread?')).toBe(true)
    expect(isAggregationQuery('What degree did I graduate with?')).toBe(false)
    expect(isAggregationQuery('When is the deploy window for the golden fixture?')).toBe(false)
  })
})

describe('turn systems', () => {
  it('serves dated session groups with the hit turn and its neighbours', async () => {
    const corpus = turnCorpus()
    const seeded = await seededHarness(corpus)
    const [system] = await createSystems(['engram-turns'], { harness: seeded, topK: 10, seed: 7 })
    try {
      await system.reset(TURNS_NS)
      await system.ingest(TURNS_NS, turnSessions(corpus))
      const retrieved = await system.retrieve(TURNS_NS, DEPLOY_QUESTION, 4000)

      // one block per session, oldest first, each prefixed with its date
      expect(retrieved.blocks[0]).toMatch(/^\[2023-11-14 22:13 utc\]/)
      expect(retrieved.context).toContain('the deploy window is 09:00-11:30 utc')
      expect(retrieved.context.length).toBeLessThanOrEqual(4000)
      // items are turns, not whole sessions, and each carries its session and index
      const answer = retrieved.items.find((item) => item.text.includes('09:00-11:30'))
      expect(answer?.ref).toBe('ts1')
      expect(answer?.turn).toBe(3)
      expect(retrieved.items.every((item) => typeof item.turn === 'number')).toBe(true)
      expect(retrieved.items.some((item) => item.text === corpus.memories[0].content)).toBe(false)

      const tokenizer = await resolveTokenizer()
      const score = scoreSystemQuery({
        system: 'engram-turns',
        queryId: 'q-turn',
        targets: ['ts1'],
        turnTargets: ['ts1#3'],
        ks: [1],
        tokenizer,
        result: retrieved,
      })
      expect(score.coverage).toBe(1)
      expect(score.sessions_represented).toBeGreaterThanOrEqual(1)
      expect(score.evidence_turn_hit).toBe(true)
    } finally {
      await closeAll([system])
    }
  }, 60_000)

  it('presents sessions on the timeline even when relevance picked them', async () => {
    const corpus = turnCorpus()
    const seeded = await seededHarness(corpus)
    const [system] = await createSystems(['engram-turns'], { harness: seeded, topK: 10, seed: 7 })
    try {
      await system.reset(TURNS_NS)
      await system.ingest(TURNS_NS, turnSessions(corpus))
      // both sessions match; the older one is served first whatever the rank order
      const retrieved = await system.retrieve(TURNS_NS, 'deploy window deploy pricing', 8000)
      const blocks = retrieved.blocks
      expect(blocks.length).toBeGreaterThanOrEqual(2)
      expect(blocks[0]).toContain('09:00-11:30')
      expect(blocks[1]).toContain('rollback drill')
    } finally {
      await closeAll([system])
    }
  }, 60_000)

  it('pays for statement turns before the long replies they compete with', async () => {
    const session = (id: string, createdAt: number, statement: string): TurnSessionMeta => ({
      id,
      createdAt,
      turns: [
        { role: 'assistant', text: `reply for ${id} ${'context '.repeat(8)}` },
        { role: 'user', text: statement },
      ],
    })
    const sessions = new Map<string, TurnSessionMeta>([
      ['s1', session('s1', 1_700_000_000_000, 'i sold the bike today')],
      ['s2', session('s2', 1_700_000_100_000, 'i sold the trailer today')],
      ['s3', session('s3', 1_700_000_200_000, 'i sold the kayak today')],
    ])
    const hits: TurnHit[] = [
      { sessionRef: 's1', turnIndex: 0 },
      { sessionRef: 's2', turnIndex: 0 },
      { sessionRef: 's3', turnIndex: 0 },
    ]
    // 320 chars hold two reply+statement groups, or every statement and one reply
    const input = { hits, sessions, budgetChars: 320, ingestWindow: 1, renderWindow: 1 }

    const ranked = assembleTurnContext(input)
    expect(ranked.sessionsServed).toBe(2)
    expect(ranked.context).not.toContain('kayak')

    const statements = assembleTurnContext({ ...input, statementsFirst: true })
    expect(statements.sessionsServed).toBe(3)
    for (const statement of ['bike', 'trailer', 'kayak']) {
      expect(statements.context).toContain(`i sold the ${statement} today`)
    }
    expect(statements.context.length).toBeLessThanOrEqual(320)
    // presented as dated groups, oldest first
    expect(statements.blocks[0]).toMatch(/^\[2023-11-14/)
  }, 60_000)

  it('applies the statement allocation to a counting question only', async () => {
    const corpus = turnCorpus()
    const seeded = await seededHarness(corpus)
    const [plain, counting] = await createSystems(['engram-turns', 'engram-turns-agg'], {
      harness: seeded,
      topK: 10,
      seed: 7,
    })
    try {
      for (const system of [plain, counting]) {
        await system.reset(TURNS_NS)
        await system.ingest(TURNS_NS, turnSessions(corpus))
      }
      const ask = 'how many things did i note across the deploy sessions'
      const ranked = await plain.retrieve(TURNS_NS, ask, 320)
      const statements = await counting.retrieve(TURNS_NS, ask, 320)
      expect(statements.note).toContain('aggregation=true')
      expect(ranked.note).not.toContain('aggregation=true')
      // the same budget buys at least as many distinct sessions once statements lead
      expect(statements.items.length).toBeGreaterThanOrEqual(ranked.items.length)
      expect(statements.items.some((item) => item.text.startsWith('user:'))).toBe(true)

      const singleFact = await counting.retrieve(TURNS_NS, DEPLOY_QUESTION, 320)
      expect(singleFact.note).not.toContain('aggregation=true')
    } finally {
      await closeAll([plain, counting])
    }
  }, 60_000)

  it('keeps the served context inside a small budget', async () => {
    const corpus = turnCorpus()
    const seeded = await seededHarness(corpus)
    const [system] = await createSystems(['engram-turns'], { harness: seeded, topK: 10, seed: 7 })
    try {
      await system.reset(TURNS_NS)
      await system.ingest(TURNS_NS, turnSessions(corpus))
      const retrieved = await system.retrieve(TURNS_NS, DEPLOY_QUESTION, 90)
      expect(retrieved.context.length).toBeLessThanOrEqual(90)
      expect(retrieved.items.length).toBeGreaterThan(0)
      expect(retrieved.items.every((item) => retrieved.context.includes(item.text))).toBe(true)
    } finally {
      await closeAll([system])
    }
  }, 60_000)

  it('ingests one memory per window start when the window is wider', async () => {
    const corpus = turnCorpus()
    const seeded = await seededHarness(corpus)
    const [system] = await createSystems([`engram-turns-w3`], {
      harness: seeded,
      topK: 10,
      seed: 7,
    })
    try {
      await system.ingest(TURNS_NS, turnSessions(corpus))
      expect(system.cost().writeCalls).toBe(9)
      const rows = seeded.db
        .prepare(
          'SELECT COUNT(*) AS n FROM memories WHERE COALESCE(namespace, project_path) = ?'
        )
        .get(turnsNamespace(TURNS_NS)) as { n: number }
      expect(rows.n).toBe(9)
      const retrieved = await system.retrieve(TURNS_NS, DEPLOY_QUESTION, 4000)
      expect(retrieved.context).toContain('the deploy window is 09:00-11:30 utc')
      // a 3-turn window covers the answer turn from one start, not three
      expect(retrieved.items.filter((item) => item.text.includes('09:00-11:30'))).toHaveLength(1)
    } finally {
      await closeAll([system])
    }
  }, 60_000)

  it('drops the previous question\'s turn rows when the next one is adopted', async () => {
    const corpus = turnCorpus()
    const seeded = await seededHarness(corpus)
    const [system] = await createSystems(['engram-turns'], { harness: seeded, topK: 10, seed: 7 })
    try {
      await system.ingest(TURNS_NS, turnSessions(corpus))
      await system.ingest('/longmemeval/next', turnSessions(corpus))
      const stale = seeded.db
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE COALESCE(namespace, project_path) = ?')
        .get(turnsNamespace(TURNS_NS)) as { n: number }
      expect(stale.n).toBe(0)
    } finally {
      await closeAll([system])
    }
  }, 60_000)

  it('picks candidate sessions first, then snippets inside them', async () => {
    const corpus = turnCorpus()
    const seeded = await seededHarness(corpus)
    const [system] = await createSystems(['engram-hybrid'], { harness: seeded, topK: 10, seed: 7 })
    try {
      await system.ingest(TURNS_NS, turnSessions(corpus))
      const retrieved = await system.retrieve(TURNS_NS, DEPLOY_QUESTION, 4000)
      expect(retrieved.items.length).toBeGreaterThan(0)
      expect(retrieved.items.every((item) => typeof item.turn === 'number')).toBe(true)
      // snippets, not session bodies
      expect(retrieved.items.every((item) => !item.text.includes('\n'))).toBe(true)
      expect(retrieved.note).toContain('candidateSessions=')
    } finally {
      await closeAll([system])
    }
  }, 60_000)

  it('splits a session without explicit turns on role lines', () => {
    expect(turnsOf({ text: 'user: hi\nassistant: hello\nplain' })).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
      { role: '', text: 'plain' },
    ])
  })

  it('round-trips a turn memory id', () => {
    expect(parseTurnMemoryId('lme-ab12-s3-t7')).toEqual({ sessionRef: 'lme-ab12-s3', turnIndex: 7 })
    expect(parseTurnMemoryId('lme-ab12-s3')).toBeNull()
  })

  it('builds a system from an explicit window', async () => {
    const factory = turnSystemFactory('engram-turns-w2', { ingestWindow: 2, renderWindow: 0 })
    const seeded = await harness()
    const system = factory.create({ harness: seeded, topK: 10, seed: 7 })
    expect(system.describe).toContain('2-turn window memories')
    await closeAll([system])
  }, 60_000)
})

describe('longmemeval systems block', () => {
  async function runSuite(systems?: string[]): Promise<{
    systems?: Record<string, SystemsBlock>
    markdown: string
  }> {
    const dir = tempDir()
    const datasetPath = join(dir, 'fixture.json')
    writeFileSync(datasetPath, JSON.stringify(dataset()), 'utf8')
    const output = await runLongMemEvalSuite(
      suiteContext(dir, { dataset: 'fixture-split', datasetPath, limit: 1, systems })
    )
    const metrics = output.result.metrics as { systems?: Record<string, SystemsBlock> }
    return { systems: metrics.systems, markdown: output.markdown }
  }

  it('runs the requested systems and reports their cost and adapter identity', async () => {
    const { systems, markdown } = await runSuite(['engram', 'full-context', 'naive-rag'])
    expect(Object.keys(systems ?? {}).sort()).toEqual(['engram', 'full-context', 'naive-rag'])
    expect(systems!.engram.coverage).toBe(1)
    expect(systems!.engram.recall['recall@5']).toBe(1)
    expect(systems!.engram.write_calls).toBe(2)
    expect(systems!.engram.adapter_kind).toBe('builtin')
    expect(systems!.engram.adapter_config_hash).toBe('')
    // the ceiling serves every session; the budgeted system serves what it packed
    expect(systems!['full-context'].avg_served).toBe(2)
    expect(systems!['full-context'].coverage).toBe(1)
    expect(systems!.engram.avg_context_tokens).toBeGreaterThan(0)
    expect(markdown).toContain('### memory systems')
  }, 60_000)

  it('reports turn coverage and session spread for a snippet system', async () => {
    const { systems, markdown } = await runSuite(['engram', 'engram-turns'])
    expect(systems!.engram.evidence_turn_coverage).toBeNull()
    expect(systems!.engram.sessions_per_q).toBeGreaterThanOrEqual(1)
    expect(systems!['engram-turns'].evidence_turn_scored).toBe(1)
    expect(systems!['engram-turns'].evidence_turn_coverage).toBe(1)
    expect(systems!['engram-turns'].avg_served).toBeGreaterThanOrEqual(1)
    expect(markdown).toContain('evid-turn cov')
  }, 60_000)

  it('adds nothing to a run that did not ask for systems', async () => {
    const { systems, markdown } = await runSuite(undefined)
    expect(systems).toBeUndefined()
    expect(markdown).not.toContain('### memory systems')
  }, 60_000)
})

describe('systems scoring', () => {
  it('scores recall and mrr over what a system served', async () => {
    const tokenizer = await resolveTokenizer()
    const score = scoreSystemQuery({
      system: 'stub',
      queryId: 'q-1',
      targets: ['t2'],
      ks: [1, 2],
      tokenizer,
      result: {
        context: 'alpha\n\nbeta',
        blocks: ['alpha', 'beta'],
        // an item with no ref cannot be attributed to a session, so it never scores
        items: [{ text: 'alpha', ref: 't1' }, { text: 'beta', ref: 't2' }, { text: 'gamma' }],
        retrievalMs: 5,
        note: '',
      },
    })
    expect(score.recall['recall@1']).toBe(0)
    expect(score.recall['recall@2']).toBe(1)
    // coverage ignores the k-cut: the target is in the served context, just not first
    expect(score.coverage).toBe(1)
    expect(score.mrr).toBe(0.5)
    expect(score.served).toHaveLength(3)
    expect(score.contextChars).toBe('alpha\n\nbeta'.length)
  })

  it('aggregates a stub system and carries its adapter identity', async () => {
    const tokenizer = await resolveTokenizer()
    const stub: MemorySystem = {
      name: 'stub',
      describe: 'a system that serves one fixed item',
      adapter: { kind: 'mcp', configHash: 'abcdef0123456789', source: '/tmp/stub.json' },
      async reset() {},
      async ingest() {},
      async retrieve() {
        return {
          context: 'alpha',
          blocks: ['alpha'],
          items: [{ text: 'alpha', ref: 't1' }],
          retrievalMs: 1,
          note: 'fixed',
        }
      },
      cost: () => ({ writeCalls: 2, writeTokens: 0 }),
      async close() {},
    }
    const score = scoreSystemQuery({
      system: 'stub',
      queryId: 'q-1',
      targets: ['t1'],
      ks: [1],
      tokenizer,
      result: await stub.retrieve('ns', 'query', 100),
    })
    const aggregates = aggregateSystems({ systems: [stub], scores: [score], ks: [1] })
    expect(aggregates.stub.scored).toBe(1)
    expect(aggregates.stub.coverage).toBe(1)
    expect(aggregates.stub.recall['recall@1']).toBe(1)
    expect(aggregates.stub.write_calls).toBe(2)
    expect(aggregates.stub.adapter_kind).toBe('mcp')
    expect(aggregates.stub.adapter_config_hash).toBe('abcdef0123456789')
  })
})

describe('checkpoint identity of a builtin system', () => {
  it('carries a hash of the serving code, so an edited builtin never resumes old rows', () => {
    const system = { name: 'engram', adapter: { kind: 'builtin', configHash: '', source: '' } } as unknown as MemorySystem
    expect(builtinCodeHash()).toMatch(/^[0-9a-f]{12}$/)
    expect(systemKey(system)).toBe(`engram@builtin-${builtinCodeHash()}`)
    const mcp = { name: 'x', adapter: { kind: 'mcp', configHash: 'abc123', source: 'f' } } as unknown as MemorySystem
    expect(systemKey(mcp)).toBe('x@abc123')
  })
})
