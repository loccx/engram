// context assembly: sections drawn from the store, one budget over all of them, and a
// recipe registry that is data. the default recipe carries the recall_context payload,
// while session-priming and qa read the same store in a different order.
import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { MemoryStore } from '../src/memory/store.js'
import { MemorySearch } from '../src/memory/search.js'
import { recallChannel, recallContext } from '../src/memory/recall.js'
import {
  assemble,
  recipeNames,
  recipeOf,
  recallViaAssemble,
  RECIPES,
  SECTION_PRODUCERS,
  type AssembleOptions,
  type ProducerInput,
} from '../src/memory/assemble.js'
import { advanceStateHead } from '../src/memory/state.js'
import { episodeVectorsAvailable, ingestEpisodes } from '../src/memory/episodes.js'
import { retrieveEpisodeContext, EPISODE_RENDER_WINDOW } from '../src/memory/episode-context.js'
import type { AllocationPolicyName } from '../src/memory/allocation.js'
import { createTask } from '../src/tasks/store.js'

const NS = '/home/user/assemble-project'
const T0 = 1_760_000_000_000

let db: Database.Database
let store: MemoryStore
let search: MemorySearch

function insertMemory(
  id: string,
  content: string,
  opts: { pinned?: boolean; stateKey?: string; validFrom?: number } = {}
): void {
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags, created_at,
        valid_from, access_count, pinned, state_key)
     VALUES (?, 'assemble-session', ?, ?, ?, 'note', 0.5, '[]', ?, ?, 0, ?, ?)`
  ).run(id, NS, NS, content, opts.validFrom ?? T0, opts.validFrom ?? T0, opts.pinned ? 1 : 0, opts.stateKey ?? null)
}

function seedNamespace(): string {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    'assemble-session',
    NS,
    T0
  )
  insertMemory('a-pin', 'the assemble project deploys on fridays', { pinned: true })
  insertMemory('a-kafka-1', 'kafka consumer lag spiked after the rebalance', {})
  insertMemory('a-kafka-2', 'kafka retention keeps seven days of messages', {})
  insertMemory('a-long', `kafka rebalance notes: ${'the consumer group state machine '.repeat(24)}`, {})
  insertMemory('a-slot-1', 'the deploy target is staging', { stateKey: 'deploy target' })
  insertMemory('a-slot-2', 'the deploy target is production', {
    stateKey: 'deploy target',
    validFrom: T0 + 1000,
  })
  insertMemory('a-state-note', `atlas deploy note: ${'warm the cache before the cutover '.repeat(12)}`, {
    stateKey: 'atlas deploy note',
  })
  advanceStateHead(db, {
    namespace: NS,
    key: 'deploy target',
    memoryId: 'a-slot-2',
    now: T0 + 1000,
  })
  db.prepare(
    `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`
  ).run(NS, JSON.stringify(['a-kafka-1', 'a-kafka-2']), 'kafka tuning: rebalance lag and retention', T0, T0)
  db.prepare(
    'INSERT INTO project_digests (namespace, content, source_hash, updated_at) VALUES (?, ?, NULL, ?)'
  ).run(NS, '- [note] the assemble project deploys on fridays', T0)

  return createTask(db, {
    namespace: NS,
    title: 'ship the assemble read path',
    goal: 'one assembled read over working, state, summaries and memories',
    plan: [{ text: 'write the assembly module', status: 'active' }],
    now: T0,
  }).id
}

function options(overrides: Partial<AssembleOptions> = {}): AssembleOptions {
  return { scope: NS, budgetChars: 4000, query: 'kafka', now: T0 + 2000, ...overrides }
}

describe('assemble', () => {
  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    store = new MemoryStore(db, false)
    search = new MemorySearch(db, false)
  })

  it('draws every section from what the store already has', async () => {
    const taskId = seedNamespace()
    const result = await assemble(db, store, search, options({ recipe: 'session-priming' }))

    expect(result.sections.map((section) => section.kind)).toEqual([
      'working',
      'state',
      'summaries',
      'memories',
    ])
    const working = result.sections[0]
    expect(working.items[0].id).toBe(taskId)
    expect(working.items[0].text).toContain('ship the assemble read path')
    expect(working.items[0].why).toBe('open task brief')

    const state = result.sections[1]
    expect(state.items[0].text).toBe('deploy target: the deploy target is production')
    expect(state.items[0].why).toBe('current state head')
    const clipped = state.items.find((item) => item.id === 'a-state-note')
    expect(clipped?.truncated).toBe(true)

    const summaries = result.sections[2]
    expect(summaries.items[0].id).toBe('digest')
    expect(summaries.items[0].text).toContain('deploys on fridays')
    const topic = summaries.items.find((item) => item.id.startsWith('topic:'))
    expect(topic?.text).toBe('kafka tuning: rebalance lag and retention')

    const memories = result.sections[3]
    expect(memories.items.length).toBeGreaterThan(0)
    expect(memories.items[0].why.startsWith('fused rank 1')).toBe(true)
    expect(memories.items[0].score).toBeGreaterThan(0)
    expect(memories.items[0].components).toBeDefined()

    expect(result.trace.channels).toEqual(['working', 'state', 'summaries', 'memories'])
    expect(result.trace.layers).toEqual([{ namespace: NS, action: 'searched', hits: memories.items.length }])
    expect(result.degraded).toEqual([])
    expect(result.accounting.used).toBeLessThanOrEqual(4000)
    expect(result.accounting.perSection.working.used).toBe(working.items[0].text.length)
    expect(result.accounting.used).toBe(
      Object.values(result.accounting.perSection).reduce((sum, section) => sum + section.used, 0)
    )
  })

  it('is deterministic and never stamps access on a read', async () => {
    seedNamespace()
    const first = await assemble(db, store, search, options({ recipe: 'session-priming' }))
    const second = await assemble(db, store, search, options({ recipe: 'session-priming' }))
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))

    const access = db.prepare('SELECT access_count FROM memories WHERE project_path = ?').all(NS) as Array<{
      access_count: number
    }>
    expect(access.every((row) => row.access_count === 0)).toBe(true)
  })

  it('clips an item once with a marker and then drops', async () => {
    seedNamespace()
    const result = await assemble(db, store, search, options({ recipe: 'default', budgetChars: 200 }))
    expect(result.accounting.used).toBeLessThanOrEqual(200)
    const items = result.sections.flatMap((section) => section.items)
    const truncated = items.filter((item) => item.truncated === true)
    expect(truncated.length).toBeGreaterThan(0)
    expect(truncated[0].text.endsWith('…')).toBe(true)
    expect(result.accounting.dropped + result.accounting.truncated).toBeGreaterThan(0)
    for (const section of result.sections) {
      const entry = result.accounting.perSection[section.title]
      expect(entry.items).toBe(section.items.length)
    }
  })

  it('keeps the recall_context payload for the default recipe', async () => {
    seedNamespace()
    const recallOptions = { query: 'kafka', project_path: NS, budget_chars: 1500, limit: 5, now: T0 + 2000 }
    const direct = await recallContext(db, store, search, recallOptions)
    const assembled = await assemble(db, store, search, options({ recipe: 'default', budgetChars: 1500, limit: 5 }))
    expect(JSON.stringify(assembled.legacy)).toBe(JSON.stringify(direct))
    expect(JSON.stringify(await recallViaAssemble(db, store, search, recallOptions))).toBe(
      JSON.stringify(direct)
    )
  })

  it('serves the qa evidence section from the episode layer', async () => {
    seedNamespace()
    // no episodes ingested: the section is empty rather than a second copy of the memories
    const withoutEvidence = await assemble(db, store, search, options({ recipe: 'qa' }))
    expect(withoutEvidence.sections.map((section) => section.kind)).toEqual([
      'memories',
      'evidence',
      'summaries',
    ])
    expect(withoutEvidence.sections[1].items).toEqual([])
    expect(withoutEvidence.accounting.perSection.evidence.items).toBe(0)
    expect(withoutEvidence.accounting.deduped).toBe(0)

    await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      items: [
        {
          external_id: 'v:0',
          content: 'user: what did kafka retention become?',
          session_id: 'v',
          turn_index: 0,
          occurred_at: T0 - 86_400_000,
        },
        {
          external_id: 'v:1',
          content: 'assistant: kafka retention keeps thirty days of messages now',
          session_id: 'v',
          turn_index: 1,
          occurred_at: T0 - 86_400_000,
        },
      ],
      now: T0,
    })

    const result = await assemble(db, store, search, options({ recipe: 'qa' }))
    const evidence = result.sections.find((section) => section.kind === 'evidence')!
    expect(evidence.items).toHaveLength(1)
    // one item per session group: dated, and citing the episodes it was built from
    expect(evidence.items[0].text).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} utc\]/)
    expect(evidence.items[0].text).toContain('thirty days of messages now')
    expect(evidence.items[0].evidence).toHaveLength(2)
    expect(evidence.items[0].id).toBe('episode-session:v')
    expect(result.accounting.used).toBeLessThanOrEqual(4000)

    // the registry entry point: one entry reads the episode layer
    const channel = await recallChannel(db, store, search, {
      query: 'kafka',
      project_path: NS,
      budget_chars: 1000,
      now: T0 + 2000,
    })
    const input: ProducerInput = {
      db,
      search,
      scope: NS,
      spec: { kind: 'evidence', title: 'evidence', budgetShare: 0.5, limit: 10 },
      sectionChars: 1000,
      channel,
      options: options({ now: T0 }),
    }
    const produced = await SECTION_PRODUCERS.evidence(input)
    expect(produced.items.map((item) => item.id)).toEqual(['episode-session:v'])
    expect(produced.items[0].why).toContain('dated session group')
    expect(produced.items[0].evidence).toHaveLength(2)
  })

  it('routes the evidence room by query archetype and serves a plain query the shipped order', async () => {
    seedNamespace()
    const sessions: Array<{ id: string; at: number; turns: string[] }> = [
      {
        id: 'r-early',
        at: T0 - 3 * 86_400_000,
        turns: [
          'user: kafka retention?',
          'assistant: seven days',
          'user: noted',
        ],
      },
      {
        id: 'r-mid',
        at: T0 - 2 * 86_400_000,
        turns: ['user: kafka replay?', 'assistant: three days', 'user: thanks'],
      },
      {
        id: 'r-late',
        at: T0 - 86_400_000,
        turns: ['user: kafka again?', 'assistant: ten days now'],
      },
    ]
    await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      items: sessions.flatMap((session) =>
        session.turns.map((line, index) => {
          const [role, text] = line.split(': ')
          return {
            external_id: `${session.id}:${index}`,
            content: line,
            session_id: session.id,
            role,
            turn_index: index,
            occurred_at: session.at,
          }
        })
      ),
      now: T0,
    })

    const evidenceSpec = recipeOf('qa').sections.find((section) => section.kind === 'evidence')!
    expect(evidenceSpec.allocation).toEqual({
      default: { policy: 'rank-greedy' },
      archetypes: { aggregation: { policy: 'breadth-first', reserveTopHits: 1 } },
    })

    // room for three dated groups, not for the deepest one of a single session
    const sectionChars = 150
    const produce = async (query: string): Promise<string[]> => {
      const channel = await recallChannel(db, store, search, {
        query,
        project_path: NS,
        budget_chars: 1000,
        now: T0 + 2000,
      })
      const produced = await SECTION_PRODUCERS.evidence({
        db,
        search,
        scope: NS,
        spec: evidenceSpec,
        sectionChars,
        channel,
        options: options({ query }),
      })
      return produced.items.map((item) => item.text)
    }
    const direct = async (
      query: string,
      allocation?: AllocationPolicyName,
      reserveTopHits?: number
    ): Promise<string[]> => {
      const found = await retrieveEpisodeContext({
        db,
        query,
        namespace: NS,
        budget_chars: sectionChars,
        render_window: EPISODE_RENDER_WINDOW,
        now: T0 + 2000,
        vectorsAvailable: episodeVectorsAvailable(db),
        ...(allocation !== undefined ? { allocation } : {}),
        ...(reserveTopHits !== undefined ? { reserve_top_hits: reserveTopHits } : {}),
      })
      return found.blocks
    }

    const plain = 'kafka retention and replay'
    expect(await produce(plain)).toEqual(await direct(plain))

    const aggregation = 'how many days of kafka data do the sessions keep in total'
    expect(await produce(aggregation)).toEqual(await direct(aggregation, 'breadth-first', 1))
    expect(await produce(aggregation)).not.toEqual(await direct(aggregation))
  })

  it('names episodes that have no vector yet instead of serving a weaker result silently', async () => {
    seedNamespace()
    await ingestEpisodes(db, {
      namespace: NS,
      source: 'codex',
      items: [
        {
          external_id: 'u:0',
          content: 'user: what did kafka retention become?',
          session_id: 'u',
          turn_index: 0,
          occurred_at: T0 - 1000,
        },
        {
          external_id: 'u:1',
          content: 'assistant: thirty days of messages now',
          session_id: 'u',
          turn_index: 1,
          occurred_at: T0 - 1000,
        },
      ],
      now: T0,
    })

    const result = await assemble(db, store, search, options({ recipe: 'qa' }))
    const reason = result.degraded.find((entry) => entry.signal === 'evidence')?.reason ?? ''
    expect(reason).toContain('2 episode(s)')
    expect(reason).toContain('no vector yet')
    // the section still serves them, lexically
    const evidence = result.sections.find((section) => section.kind === 'evidence')!
    expect(evidence.items.length).toBeGreaterThan(0)
  })

  it('treats recipes as data: registry order, quotas and one-entry contribution', async () => {
    seedNamespace()
    expect(recipeNames()).toEqual(['default', 'session-priming', 'qa'])
    expect(() => recipeOf('no-such-recipe')).toThrow(/unknown recipe "no-such-recipe"/)
    for (const name of recipeNames()) {
      const recipe = recipeOf(name)
      expect(recipe.sections.length).toBeGreaterThan(0)
      for (const section of recipe.sections) expect(SECTION_PRODUCERS[section.kind]).toBeDefined()
      expect(recipe.sections.reduce((sum, section) => sum + section.budgetShare, 0)).toBeLessThanOrEqual(1)
    }

    const quota = await assemble(
      db,
      store,
      search,
      options({ recipe: 'session-priming', quotas: { working: { budgetShare: 0, limit: 0 } } })
    )
    expect(quota.accounting.perSection.working.used).toBe(0)
    expect(quota.accounting.perSection.working.items).toBe(0)

    RECIPES['test-recipe'] = {
      name: 'test-recipe',
      description: 'a contributed recipe',
      sections: [
        { kind: 'summaries', title: 'summaries', budgetShare: 0.5, limit: 3 },
        { kind: 'memories', title: 'memories', budgetShare: 0.5, limit: 3 },
      ],
    }
    try {
      expect(recipeNames()).toContain('test-recipe')
      const contributed = await assemble(db, store, search, options({ recipe: 'test-recipe' }))
      expect(contributed.sections.map((section) => section.kind)).toEqual(['summaries', 'memories'])
    } finally {
      delete RECIPES['test-recipe']
    }
  })

  it('names every channel that failed or could not run', async () => {
    seedNamespace()
    const queryless = await assemble(db, store, search, options({ recipe: 'qa', query: undefined }))
    expect(queryless.degraded).toEqual([
      { signal: 'memories', reason: 'no query: the fused memory channel did not run' },
      { signal: 'evidence', reason: 'no query: the episode channel did not run' },
    ])
    expect(queryless.trace.layers).toEqual([{ namespace: NS, action: 'skipped', hits: 0 }])
    expect(queryless.sections.find((section) => section.kind === 'summaries')?.items.length).toBeGreaterThan(0)

    const historical = await assemble(
      db,
      store,
      search,
      options({ recipe: 'session-priming', asOf: T0 + 500 })
    )
    expect(historical.degraded).toEqual([
      { signal: 'working', reason: 'as_of read: task briefs are present state' },
    ])
    expect(historical.sections.find((section) => section.kind === 'state')?.items[0].text).toBe(
      'deploy target: the deploy target is staging'
    )

    const broken = new MemorySearch(db, false)
    Object.defineProperty(broken, 'hybridSearch', {
      value: async () => {
        throw new Error('vector channel down')
      },
    })
    const failedSearch = await assemble(
      db,
      store,
      broken,
      options({ recipe: 'session-priming' })
    )
    expect(failedSearch.degraded).toEqual([{ signal: 'memories', reason: 'vector channel down' }])
    expect(failedSearch.sections.find((section) => section.kind === 'memories')?.items).toEqual([])
    expect(failedSearch.sections.find((section) => section.kind === 'working')?.items.length).toBeGreaterThan(0)

    // the fused channel carries its own summary layer for the legacy payload, so a
    // cluster read failure is reported by both signals that read it, and neither is
    // served as a silent empty section
    const brokenClusters = new MemorySearch(db, false)
    Object.defineProperty(brokenClusters, 'getClusters', {
      value: () => {
        throw new Error('cluster read failed')
      },
    })
    const failedClusters = await assemble(
      db,
      store,
      brokenClusters,
      options({ recipe: 'session-priming' })
    )
    expect(failedClusters.degraded).toEqual([
      { signal: 'memories', reason: 'cluster read failed' },
      { signal: 'summaries', reason: 'cluster read failed' },
    ])
    expect(failedClusters.sections.find((section) => section.kind === 'working')?.items.length).toBeGreaterThan(0)
  })
})
