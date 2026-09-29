// equivalence: the eval's engram-turns system is the reference (its recipe scored +11
// pts on longmemeval_s), and the engine's episode layer has to serve the same context
// from its own tables. three checks: the assembly is byte-identical to the eval recipe,
// the two systems serve the same context when both see the same evidence alone, and a
// run beside the whole-session corpus adds no memory rows. the longmemeval run itself
// is opt-in (ENGRAM_EVAL_EQUIVALENCE=1) because it reads a 277 MB dataset; the numbers
// it reports are the ones quoted in the docs.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvalHarness } from '../eval/lib/harness.js'
import { resetTokenizerForTests, resolveTokenizer } from '../eval/lib/metrics.js'
import {
  closeAll,
  createSystems,
  runSystemQuestion,
  toSystemSessions,
  type MemorySystem,
  type SystemSession,
} from '../eval/lib/systems.js'
import { scoreSystemQuery } from '../eval/lib/systems-score.js'
import {
  assembleTurnContext,
  formatTurnDate,
  turnMemoryId,
  type TurnSessionMeta,
} from '../eval/lib/turns.js'
import { runLongMemEvalSuite, DATASETS_DIR, resolveDatasetPath } from '../eval/suites/longmemeval.js'
import { buildHeader } from '../eval/lib/report.js'
import { resolveConfigs } from '../eval/lib/registry.js'
import { countEpisodes } from '../src/memory/episodes.js'
import {
  assembleEpisodeContext,
  type EpisodeSessionTurns,
} from '../src/memory/episode-context.js'
import type { Corpus, CorpusTurn } from '../eval/lib/types.js'
import type { SuiteContext } from '../eval/suites/types.js'

const NS = '/longmemeval/equivalence-q'
const QUESTION = 'what did the deploy window become and when is the rollback drill?'

const tempDirs: string[] = []
const harnesses: EvalHarness[] = []
const opened: MemorySystem[][] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-episodes-equiv-'))
  tempDirs.push(dir)
  return dir
}

async function harness(): Promise<EvalHarness> {
  const created = await EvalHarness.create({ seed: 7, vectors: 'fts' })
  harnesses.push(created)
  return created
}

afterEach(async () => {
  while (opened.length > 0) await closeAll(opened.pop()!)
  while (harnesses.length > 0) harnesses.pop()!.dispose()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
  resetTokenizerForTests()
})

interface Scenario {
  sessions: Array<{ id: string; createdAt: number; lines: string[] }>
  /** the eval's hit shape; the engine addresses the same turn by its episode id */
  hits: Array<{ sessionRef: string; turnIndex: number }>
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** turn text as the corpus carries it: `role: text` */
const line = (turn: CorpusTurn): string => (turn.role === '' ? turn.text : `${turn.role}: ${turn.text}`)
const parseLine = (text: string): CorpusTurn => {
  const match = text.match(/^([a-z_]+): (.*)$/)
  return match ? { role: match[1], text: match[2] } : { role: '', text }
}

/** the eval's session shape, from the same lines the engine would ingest */
function evalSessions(scenario: Scenario): Map<string, TurnSessionMeta> {
  return new Map(
    scenario.sessions.map((session) => [
      session.id,
      {
        id: session.id,
        createdAt: session.createdAt,
        turns: session.lines.map(parseLine),
      },
    ])
  )
}

function engineSessions(scenario: Scenario): Map<string, EpisodeSessionTurns> {
  return new Map(
    scenario.sessions.map((session) => [
      session.id,
      {
        sessionId: session.id,
        occurredAt: session.createdAt,
        turns: session.lines.map((content, index) => ({
          episodeId: turnMemoryId(session.id, index),
          content,
          occurredAt: session.createdAt,
          role: parseLine(content).role === '' ? null : parseLine(content).role,
        })),
      },
    ])
  )
}

function scenarios(): Scenario[] {
  const base = 1_700_000_000_000
  return [
    {
      // two sessions, the newer one hit first: the budget goes to it, the timeline
      // still puts the older one first
      sessions: [
        {
          id: 's-early',
          createdAt: base,
          lines: [
            'user: what is the deploy window?',
            'assistant: the deploy window is 09:00-11:30 utc',
            'user: noted',
          ],
        },
        {
          id: 's-late',
          createdAt: base + 3 * DAY,
          lines: [
            'user: any update?',
            'assistant: the deploy window became 13:00-14:00 utc',
            'user: and the rollback drill?',
          ],
        },
      ],
      hits: [
        { sessionRef: 's-late', turnIndex: 1 },
        { sessionRef: 's-early', turnIndex: 1 },
      ],
    },
    {
      // one session, several hits: the coverage map has to merge overlapping windows
      sessions: [
        {
          id: 's-one',
          createdAt: base + DAY,
          lines: [
            'user: kick off the release',
            'assistant: the deploy window is 09:00-11:30 utc',
            'user: what about the rollback drill?',
            'assistant: the rollback drill runs right after the deploy window',
            'user: thanks',
          ],
        },
      ],
      hits: [
        { sessionRef: 's-one', turnIndex: 1 },
        { sessionRef: 's-one', turnIndex: 3 },
        { sessionRef: 's-one', turnIndex: 0 },
      ],
    },
    {
      // a hit on the first and last turn, where the render window clamps
      sessions: [
        {
          id: 's-edges',
          createdAt: base + 2 * DAY,
          lines: ['user: the deploy window moved', 'assistant: to 13:00 utc', 'user: rollback?', 'assistant: drill only'],
        },
      ],
      hits: [
        { sessionRef: 's-edges', turnIndex: 0 },
        { sessionRef: 's-edges', turnIndex: 3 },
      ],
    },
    {
      // a session whose turns are undated, and a hit that belongs to no loaded session
      sessions: [{ id: 's-undated', createdAt: undefined as unknown as number, lines: ['user: rollback drill?', 'assistant: not scheduled'] }],
      hits: [
        { sessionRef: 's-undated', turnIndex: 1 },
        { sessionRef: 's-missing', turnIndex: 0 },
      ],
    },
  ]
}

describe('assembly equivalence with the eval recipe', () => {
  it('serves the same context, blocks and provenance lines at every budget', () => {
    for (const scenario of scenarios()) {
      const turnSessions = evalSessions(scenario)
      const episodeSessions = engineSessions(scenario)
      for (const budgetChars of [30, 60, 120, 400, 2000, 20000]) {
        const reference = assembleTurnContext({
          hits: scenario.hits,
          sessions: turnSessions,
          budgetChars,
          ingestWindow: 1,
          renderWindow: 1,
        })
        const engine = assembleEpisodeContext({
          hits: scenario.hits.map((hit) => ({
            episodeId: turnMemoryId(hit.sessionRef, hit.turnIndex),
            sessionId: hit.sessionRef,
          })),
          sessions: episodeSessions,
          budgetChars,
          ingestWindow: 1,
          renderWindow: 1,
        })

        expect(engine.context).toBe(reference.context)
        expect(engine.blocks).toEqual(reference.blocks)
        expect(engine.usedChars).toBe(reference.usedChars)
        expect(engine.sessionsServed).toBe(reference.sessionsServed)
        expect(engine.turnsServed).toBe(reference.turnsServed)
        expect(engine.skippedSessions).toBe(reference.skippedSessions)
        expect(
          engine.lines.map((l) => ({
            id: l.episode_id,
            ref: l.session_id,
            turn: l.turn_index,
            text: l.content,
          }))
        ).toEqual(
          reference.items.map((item) => ({
            id: item.id,
            ref: item.ref,
            turn: item.turn,
            text: item.text,
          }))
        )
      }
    }
  })

  it('serves the eval statements-first allocation, reserve included, at every budget', () => {
    for (const scenario of scenarios()) {
      const turnSessions = evalSessions(scenario)
      const episodeSessions = engineSessions(scenario)
      for (const budgetChars of [30, 60, 120, 400, 2000, 20000]) {
        for (const reserveTopHits of [0, 1, 2]) {
          const reference = assembleTurnContext({
            hits: scenario.hits,
            sessions: turnSessions,
            budgetChars,
            ingestWindow: 1,
            renderWindow: 1,
            statementsFirst: true,
            reserveTopHits,
          })
          const engine = assembleEpisodeContext({
            hits: scenario.hits.map((hit) => ({
              episodeId: turnMemoryId(hit.sessionRef, hit.turnIndex),
              sessionId: hit.sessionRef,
            })),
            sessions: episodeSessions,
            budgetChars,
            ingestWindow: 1,
            renderWindow: 1,
            allocation: 'statements-first',
            reserveTopHits,
          })

          expect(engine.context).toBe(reference.context)
          expect(engine.blocks).toEqual(reference.blocks)
          expect(engine.usedChars).toBe(reference.usedChars)
          expect(engine.sessionsServed).toBe(reference.sessionsServed)
          expect(engine.turnsServed).toBe(reference.turnsServed)
          expect(engine.skippedSessions).toBe(reference.skippedSessions)
          expect(
            engine.lines.map((l) => ({
              id: l.episode_id,
              ref: l.session_id,
              turn: l.turn_index,
              text: l.content,
            }))
          ).toEqual(
            reference.items.map((item) => ({
              id: item.id,
              ref: item.ref,
              turn: item.turn,
              text: item.text,
            }))
          )
        }
      }
    }
  })

  it('breadth-first reaches every session one turn deep before it deepens the best hit', () => {
    const base = 1_700_000_000_000
    const sessions = new Map<string, EpisodeSessionTurns>([
      [
        's-a',
        {
          sessionId: 's-a',
          occurredAt: base,
          turns: ['a0', 'a1', 'a2'].map((id, index) => ({
            episodeId: id,
            content: `user: ${id}`,
            occurredAt: base,
            role: 'user',
          })),
        },
      ],
      [
        's-b',
        {
          sessionId: 's-b',
          occurredAt: base + 24 * HOUR,
          turns: [{ episodeId: 'b0', content: 'user: b0', occurredAt: base + 24 * HOUR, role: 'user' }],
        },
      ],
    ])
    const hits = [
      { episodeId: 'a1', sessionId: 's-a' },
      { episodeId: 'b0', sessionId: 's-b' },
    ]
    // room for two turns and two headers, not for three
    const budgetChars = 70
    const ranked = assembleEpisodeContext({
      hits,
      sessions,
      budgetChars,
      ingestWindow: 1,
      renderWindow: 1,
    })
    expect(ranked.sessionsServed).toBe(1)
    expect(ranked.lines.map((line) => line.episode_id)).toEqual(['a0', 'a1', 'a2'])

    const breadth = assembleEpisodeContext({
      hits,
      sessions,
      budgetChars,
      ingestWindow: 1,
      renderWindow: 1,
      allocation: 'breadth-first',
    })
    expect(breadth.sessionsServed).toBe(2)
    expect(breadth.lines.map((line) => line.episode_id)).toEqual(['a0', 'b0'])
    expect(breadth.skippedSessions).toBe(0)
    expect(breadth.usedChars).toBeLessThanOrEqual(budgetChars)
  })

  it('expands the same hit to its window and dates the group the same way', () => {
    const scenario = scenarios()[0]
    const engine = assembleEpisodeContext({
      hits: [{ episodeId: 's-early-t1', sessionId: 's-early' }],
      sessions: engineSessions(scenario),
      budgetChars: 4000,
      ingestWindow: 1,
      renderWindow: 1,
    })
    const reference = assembleTurnContext({
      hits: [{ sessionRef: 's-early', turnIndex: 1 }],
      sessions: evalSessions(scenario),
      budgetChars: 4000,
      ingestWindow: 1,
      renderWindow: 1,
    })
    expect(engine.blocks[0].split('\n')).toEqual(reference.blocks[0].split('\n'))
    const [header] = engine.blocks[0].split('\n')
    expect(header).toBe(`[${formatTurnDate(scenario.sessions[0].createdAt)}]`)
    expect(engine.lines.map((l) => l.episode_id)).toEqual(['s-early-t0', 's-early-t1', 's-early-t2'])
  })
})

/** a haystack with explicit turns, the shape the longmemeval reader feeds a system */
function turnCorpus(): Corpus {
  const base = 1_700_000_000_000
  const sessions: Array<{ id: string; at: number; lines: string[]; tag: string }> = [
    {
      id: 'ts1',
      at: base,
      tag: 'single-session-user',
      lines: [
        'user: what is the deploy window?',
        'assistant: it is 09:00-11:30 utc',
        'user: noted',
        'assistant: the deploy window is 09:00-11:30 utc for the payments service',
        'user: thanks',
      ],
    },
    {
      id: 'ts2',
      at: base + 2 * DAY,
      tag: 'knowledge-update',
      lines: [
        'user: any change to the deploy window?',
        'assistant: the deploy window became 13:00-14:00 utc',
        'user: and the rollback drill?',
        'assistant: the rollback drill runs right after the deploy window',
      ],
    },
    {
      id: 'ts3',
      at: base + 4 * DAY,
      tag: 'multi-session',
      lines: [
        'user: where is the pricing table?',
        'assistant: the pricing table lives in a spreadsheet',
        'user: ok',
      ],
    },
  ]
  return {
    name: 'equivalence',
    seed: 7,
    memories: sessions.map((session) => ({
      id: session.id,
      namespace: NS,
      content: session.lines.join('\n'),
      created_at: session.at,
      tags: ['longmemeval', session.tag],
      turns: session.lines.map(parseLine),
    })),
    queries: [],
  }
}

const TURN_TARGET = 'ts1#3'
const TARGET_SESSION = 'ts1'

describe('engram-episodes against engram-turns', () => {
  it('serves the same context when both systems see the same evidence alone', async () => {
    const corpus = turnCorpus()
    const seeded = await harness()
    const systems = await createSystems(['engram-turns', 'engram-episodes'], {
      harness: seeded,
      topK: 10,
      seed: 7,
    })
    opened.push(systems)
    const [turns, episodes] = systems
    const sessions = toSystemSessions(corpus.memories)
    const tokenizer = await resolveTokenizer()

    const turnResult = await runSystemQuestion({
      harness: seeded,
      system: turns,
      namespace: NS,
      sessions,
      query: QUESTION,
      budgetChars: 4000,
    })
    const episodeResult = await runSystemQuestion({
      harness: seeded,
      system: episodes,
      namespace: NS,
      sessions,
      query: QUESTION,
      budgetChars: 4000,
    })

    expect(episodeResult.context).toBe(turnResult.context)
    expect(episodeResult.context.length).toBeLessThanOrEqual(4000)

    const score = (system: string, result: typeof turnResult) =>
      scoreSystemQuery({
        system,
        queryId: 'q-equivalence',
        kind: 'knowledge-update',
        targets: [TARGET_SESSION],
        turnTargets: [TURN_TARGET],
        result,
        ks: [1, 5, 10],
        tokenizer,
      })
    const turnScore = score('engram-turns', turnResult)
    const episodeScore = score('engram-episodes', episodeResult)

    expect(episodeScore.coverage).toBe(turnScore.coverage)
    expect(episodeScore.recall).toEqual(turnScore.recall)
    expect(episodeScore.mrr).toBe(turnScore.mrr)
    expect(episodeScore.sessions_represented).toBe(turnScore.sessions_represented)
    expect(episodeScore.evidence_turn_hit).toBe(turnScore.evidence_turn_hit)
    expect(episodeScore.evidence_turn_hit).toBe(true)

    // the served list is the same list: same sessions, same turns
    expect(episodeResult.items.map((item) => [item.ref, item.turn])).toEqual(
      turnResult.items.map((item) => [item.ref, item.turn])
    )
  }, 60_000)

  it('adds no memory rows, and keeps every served turn as an episode', async () => {
    const corpus = turnCorpus()
    const seeded = await harness()
    await seeded.seedCorpus(corpus, { mode: 'raw' })
    const systems = await createSystems(['engram-episodes'], {
      harness: seeded,
      topK: 10,
      seed: 7,
    })
    opened.push(systems)
    const [episodes] = systems
    const sessions: SystemSession[] = toSystemSessions(corpus.memories)
    const turns = sessions.reduce((total, session) => total + (session.turns?.length ?? 0), 0)
    const memoriesBefore = (
      seeded.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
    ).n

    await episodes.reset(NS)
    await episodes.ingest(NS, sessions)

    const memoriesAfter = (
      seeded.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
    ).n
    expect(memoriesAfter).toBe(memoriesBefore)
    expect(countEpisodes(seeded.db, { namespace: NS })).toBe(turns)

    const retrieved = await episodes.retrieve(NS, QUESTION, 4000)
    expect(retrieved.items.length).toBeGreaterThan(0)
    for (const item of retrieved.items) expect(typeof item.turn).toBe('number')
    expect(retrieved.context.length).toBeLessThanOrEqual(4000)

    // the suite's per-question teardown covers the evidence too, or the next question
    // would rank against this one's turns
    seeded.dropNamespace(NS)
    expect(countEpisodes(seeded.db, { namespace: NS })).toBe(0)
  }, 60_000)

  it('reproduces the longmemeval numbers the docs quote, on the 100-question sample', async () => {
    if (process.env.ENGRAM_EVAL_EQUIVALENCE !== '1') return
    const split = 'longmemeval_s_cleaned'
    if (!existsSync(resolveDatasetPath({} as SuiteContext, split))) return
    const outDir = tempDir()
    const output = await runLongMemEvalSuite({
      seed: 1234,
      configs: resolveConfigs(['baseline']),
      vectors: 'fts',
      qa: false,
      limit: 100,
      dataset: split,
      systems: ['engram-turns', 'engram-episodes'],
      outDir,
      gitSha: 'equivalence',
      buildHeader: (input) => buildHeader({ ...input, git: undefined }),
      log: () => {},
    } as SuiteContext)

    const systems = output.result.metrics.systems as Record<
      string,
      {
        scored: number
        coverage: number
        evidence_turn_coverage: number | null
        sessions_per_q: number
        avg_served: number
      }
    >
    const turns = systems['engram-turns']
    const episodes = systems['engram-episodes']
    expect(turns.scored).toBe(100)
    expect(episodes.scored).toBe(100)
    // the granularity, the packing and the evidence-turn coverage agree
    expect(Math.abs(episodes.coverage - turns.coverage)).toBeLessThanOrEqual(0.02)
    expect(Math.abs((episodes.evidence_turn_coverage ?? 0) - (turns.evidence_turn_coverage ?? 0))).toBeLessThanOrEqual(0.02)
    expect(Math.abs(episodes.sessions_per_q - turns.sessions_per_q)).toBeLessThanOrEqual(0.15)
    expect(Math.abs(episodes.avg_served - turns.avg_served)).toBeLessThanOrEqual(1.5)
    expect(DATASETS_DIR).toContain('datasets')
  }, 600_000)
})
