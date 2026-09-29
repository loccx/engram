// harness isolation: the run shares one db across systems and questions, so a system's
// served list must not depend on which other systems ran. the suites tear a question
// down with dropNamespace, which has to cover the child namespaces systems ingest into
// (`question//scope`), or the next system answers with another haystack's rows still in
// the db and the fts index statistics behind every bm25 come with them.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvalHarness } from '../eval/lib/harness.js'
import { resetTokenizerForTests } from '../eval/lib/metrics.js'
import { buildHeader } from '../eval/lib/report.js'
import { resolveConfigs } from '../eval/lib/registry.js'
import { createSystems, systemNames, turnsNamespace, closeAll } from '../eval/lib/systems.js'
import { runLongMemEvalSuite } from '../eval/suites/longmemeval.js'
import type { SuiteContext } from '../eval/suites/types.js'
import type { Corpus, CorpusMemory, SystemQueryScore } from '../eval/lib/types.js'

const NS = '/isolation/q-1'
const QUESTION = 'when is the deploy window for the golden fixture?'

const tempDirs: string[] = []
const harnesses: EvalHarness[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-isolation-test-'))
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

/** two sessions with turns, enough for a turn system to write rows below the namespace */
function turnCorpus(): Corpus {
  const session = (id: string, createdAt: number, turns: Array<[string, string]>): CorpusMemory => ({
    id,
    namespace: NS,
    content: turns.map(([role, text]) => `${role}: ${text}`).join('\n'),
    created_at: createdAt,
    tags: ['longmemeval'],
    turns: turns.map(([role, text]) => ({ role, text })),
  })
  return {
    name: 'isolation',
    seed: 7,
    memories: [
      session('s0', 1_700_000_000_000, [
        ['user', 'what is the deploy window?'],
        ['assistant', 'the deploy window for the golden fixture is 09:00-11:30 utc'],
        ['user', 'noted'],
      ]),
      session('s1', 1_700_000_100_000, [
        ['user', 'anything else?'],
        ['assistant', 'the pricing table for the golden fixture lives in a spreadsheet'],
      ]),
    ],
    queries: [],
  }
}

function turnSessions(corpus: Corpus): Array<{ id: string; text: string; createdAt?: number; tags?: string[]; turns?: CorpusMemory['turns'] }> {
  return corpus.memories.map((memory) => ({
    id: memory.id,
    text: memory.content,
    createdAt: memory.created_at,
    tags: memory.tags ?? [],
    turns: memory.turns,
  }))
}

/** rows the engine would return for the namespace, children included */
function rowsUnder(h: EvalHarness, namespace: string): number {
  const esc = namespace.replace(/[\\%_]/g, '\\$&')
  const row = h.db
    .prepare(
      `SELECT COUNT(*) AS n FROM memories
        WHERE COALESCE(namespace, project_path) = ?
           OR COALESCE(namespace, project_path) LIKE ? ESCAPE '\\'
           OR COALESCE(namespace, project_path) LIKE ? ESCAPE '\\'`
    )
    .get(namespace, `${esc}/%`, `${esc}//%`) as { n: number }
  return row.n
}

describe('question teardown', () => {
  it('leaves no row of the question behind, child namespaces included', async () => {
    const h = await harness()
    const corpus = turnCorpus()
    await h.seedCorpus(corpus, { mode: 'raw' })
    const [system] = await createSystems(['engram-turns'], { harness: h, topK: 10, seed: 7 })
    try {
      await system.reset(NS)
      await system.ingest(NS, turnSessions(corpus))
      expect(rowsUnder(h, turnsNamespace(NS))).toBeGreaterThan(0)

      h.dropNamespace(NS)

      expect(rowsUnder(h, NS)).toBe(0)
      expect(h.stats().memories).toBe(0)
    } finally {
      await closeAll([system])
    }
  }, 60_000)
})

/** three questions, six sessions each, one answer turn: the s-shaped shape the suite streams */
function dataset(): unknown[] {
  const themes = ['golden fixture', 'silver fixture', 'bronze fixture']
  return themes.map((theme, index) => ({
    question_id: `q-isolation-${index}`,
    question: `when is the deploy window for the ${theme}?`,
    answer: `the deploy window for the ${theme} is 09:00-11:30 utc`,
    question_type: 'single-session-user',
    question_date: '2023/04/10 (Mon) 17:50',
    haystack_session_ids: Array.from({ length: 6 }, (_, i) => `${theme}-${i}`),
    haystack_dates: Array.from({ length: 6 }, (_, i) => `2023/04/${10 + i} (Mon) 17:50`),
    haystack_sessions: Array.from({ length: 6 }, (_, i) => [
      { role: 'user', content: `checking the deploy window for the ${theme}` },
      {
        role: 'assistant',
        content:
          i === 2
            ? `the deploy window for the ${theme} is 09:00-11:30 utc`
            : `the pricing table for the ${theme} lives in a spreadsheet`,
        ...(i === 2 ? { has_answer: true } : {}),
      },
      {
        role: 'assistant',
        content: `the rollback drill for the ${theme} follows the deploy window`,
      },
      { role: 'user', content: `any change to the ${theme} deploy week rota?` },
      { role: 'assistant', content: `the ${theme} deploy week rota is posted` },
    ]),
    answer_session_ids: [`${theme}-2`],
  }))
}

function suiteContext(dir: string, datasetPath: string, systems?: string[]): SuiteContext {
  return {
    seed: 11,
    configs: resolveConfigs(['baseline']),
    vectors: 'fts',
    qa: false,
    outDir: dir,
    gitSha: 'testsha',
    dataset: 'isolation-split',
    datasetPath,
    limit: 3,
    // smaller than the haystack, so a system has to select rather than serve everything
    contextBudgetChars: 1_200,
    systems,
    buildHeader: (input) => buildHeader({ ...input, git: undefined }),
    log: () => {},
  }
}

/** what a system served, per question, in corpus-local ids */
type Served = Record<string, string[]>

async function servedBy(systems: string[]): Promise<Record<string, Served>> {
  const dir = tempDir()
  const datasetPath = join(dir, 'fixture.json')
  writeFileSync(datasetPath, JSON.stringify(dataset()), 'utf8')
  const output = await runLongMemEvalSuite(suiteContext(dir, datasetPath, systems))
  const details = output.result.details as Array<{ systems?: { scores: SystemQueryScore[] } }>
  const scores = details.find((entry) => entry.systems)?.systems?.scores ?? []
  expect(scores.length).toBeGreaterThan(0)
  const out: Record<string, Served> = {}
  for (const score of scores) {
    const served = (out[score.system] ??= {})
    served[score.query_id] = score.served.map((item) =>
      item.turn === undefined ? item.ref : `${item.ref}#${item.turn}`
    )
  }
  return out
}

describe('system set independence', () => {
  it('serves the same list alone, with every other system, and in reverse order', async () => {
    const sets: Array<[string, Record<string, Served>]> = [
      ['all systems', await servedBy(systemNames())],
      ['reversed order', await servedBy([...systemNames()].reverse())],
    ]
    const failures: string[] = []
    for (const name of systemNames()) {
      const alone = await servedBy([name])
      for (const [label, together] of sets) {
        const viaSet = together[name] ?? {}
        for (const [queryId, list] of Object.entries(alone[name] ?? {})) {
          const other = viaSet[queryId] ?? []
          if (JSON.stringify(list) !== JSON.stringify(other)) {
            failures.push(
              `${name} ${queryId} (${label})\n  alone: ${list.join(', ') || '(nothing)'}\n  set:   ${other.join(', ') || '(nothing)'}`
            )
          }
        }
      }
    }
    expect(failures.join('\n')).toBe('')
  }, 300_000)
})
