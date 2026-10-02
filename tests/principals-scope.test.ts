// the boundary suite: two named principals and the local owner over one store. every
// advertised tool is either swept for a leak or named as a store-wide tool no grant can
// cover, so a new tool cannot arrive without a decision here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests, type RequestContext } from '../src/mcp/handlers.js'
import { createServer } from '../src/server.js'
import { tools } from '../src/mcp/tools.js'
import { RECIPES } from '../src/memory/assemble.js'
import { refreshDigest } from '../src/memory/digest.js'
import {
  addPrincipal,
  callerScopeFor,
  getPrincipal,
  grantVerbs,
  issueToken,
  livePrincipalForToken,
  resolveCredential,
  revokeTokens,
  setPrincipalDisabled,
  tokenHash,
} from '../src/mcp/principals.js'
import { LOCAL_OWNER, type CallerScope } from '../src/memory/access.js'

const SHARED = '/home/user/team-project'
const DIGEST_NS = '/home/user/team-project//digest-only'
const A_ONLY = '/home/user/a-only'
const ABOVE = '/home/user'

const MARKER_MEMORY = 'zulu-marker-memory'
const MARKER_ISOLATED = 'zulu-marker-isolated'
const MARKER_SHARED = 'zulu-marker-shared'
const MARKER_EPISODE = 'zulu-marker-episode'
const MARKER_TASK = 'zulu-marker-task'
// everything alice wrote as personal: a project row is shared on purpose and is the
// control that proves the sweep can see a marker at all
const PRIVATE_MARKERS = [MARKER_MEMORY, MARKER_ISOLATED, MARKER_EPISODE, MARKER_TASK]

const MISSING_ID = '00000000-0000-4000-8000-000000000000'

const ADVERTISED = new Set(tools.map((tool) => tool.name))

/** a call spec for a tool another branch adds is skipped here, not failed */
function advertisedCalls(calls: Array<{ tool: string; args: Record<string, unknown> }>) {
  return calls.filter((call) => ADVERTISED.has(call.tool))
}

/** every advertised tool gets these, whatever its schema accepts */
const FORGED_HAND_FULL: Record<string, unknown> = {
  namespace: '/home/user',
  project_path: '/home/user',
  query: 'zulu-marker-memory',
  entity: 'src/leak.ts',
  budget_chars: 2000,
  brain: 'x',
  source: { system: 'host', instance: 'bob' },
  episodes: [{ external_id: 'forged-1', content: 'a forged ingest' }],
  title: 'a forged task',
  goal: 'a forged goal',
  content: 'a forged write',
  threshold: 0.5,
  pinned: true,
  shareable: true,
  include_archived: true,
  limit: 20,
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function parse<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T
}

interface Fixture {
  db: Database.Database
  callerA: CallerScope
  callerB: CallerScope
  tokenA: string
  tokenB: string
  memoryA: string
  memoryIsolated: string
  taskA: string
}

const ALL_VERBS = ['read', 'write', 'share', 'delete'] as const

function makeFixture(): Fixture {
  const db = getDatabase().db
  addPrincipal(db, 'alice', 'agent')
  addPrincipal(db, 'bob', 'agent')
  // alice holds a second namespace bob can never name, which is what a forged argument
  // would have to reach
  for (const [name, prefix] of [
    ['alice', SHARED],
    ['alice', DIGEST_NS],
    ['alice', A_ONLY],
    ['bob', SHARED],
    ['bob', DIGEST_NS],
  ] as const) {
    grantVerbs(db, name, prefix, [...ALL_VERBS])
  }
  const tokenA = issueToken(db, 'alice').token
  const tokenB = issueToken(db, 'bob').token
  const alice = getPrincipal(db, 'alice')
  const bob = getPrincipal(db, 'bob')
  if (!alice || !bob) throw new Error('the fixture principals did not land')
  return {
    db,
    callerA: callerScopeFor(db, alice),
    callerB: callerScopeFor(db, bob),
    tokenA,
    tokenB,
    memoryA: '',
    memoryIsolated: '',
    taskA: '',
  }
}

async function storeAs(caller: CallerScope, args: Record<string, unknown>): Promise<string> {
  const result = await handleTool('store_memory', args, { caller })
  return parse<{ id: string }>(result).id
}

/** everything principal a wrote before any read is attempted */
async function seed(fx: Fixture): Promise<void> {
  fx.memoryA = await storeAs(fx.callerA, {
    project_path: SHARED,
    content: `${MARKER_MEMORY} deploys from the staging cluster; the notes live in src/leak.ts`,
    type: 'gotcha',
    importance: 0.9,
  })
  fx.memoryIsolated = await storeAs(fx.callerA, {
    project_path: A_ONLY,
    content: `${MARKER_ISOLATED} is written outside bob's grant`,
    importance: 0.9,
  })
  await storeAs(fx.callerA, {
    project_path: SHARED,
    content: `${MARKER_SHARED} is a project fact every reader of the namespace may see`,
    visibility: 'project',
    importance: 0.8,
  })
  await storeAs(fx.callerA, {
    project_path: DIGEST_NS,
    content: `${MARKER_MEMORY} pinned so the digest has an input`,
    pinned: true,
    importance: 0.9,
  })
  await handleTool(
    'ingest_episodes',
    {
      project_path: SHARED,
      source: { system: 'host', instance: 'alice' },
      episodes: [
        {
          external_id: 'turn-1',
          content: `user: ${MARKER_EPISODE} what happened to the deploy`,
          session_id: 'alice-session',
          turn_index: 0,
        },
      ],
    },
    { caller: fx.callerA }
  )
  const task = await handleTool(
    'task_start',
    { project_path: SHARED, title: `${MARKER_TASK} ship the deploy`, goal: 'a task only alice may read' },
    { caller: fx.callerA }
  )
  fx.taskA = parse<{ task: { id: string } }>(task).task.id
}

async function callAs(
  caller: CallerScope,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await handleTool(name, args, { caller })
  return result.content[0].text
}

function leaks(text: string): string[] {
  return PRIVATE_MARKERS.filter((marker) => text.includes(marker))
}

/** every namespace-addressed read, with the arguments a caller would really send */
const NAMESPACE_READS: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'search_memories', args: { query: `${MARKER_MEMORY} ${MARKER_EPISODE}` } },
  { tool: 'search_memories', args: { query: MARKER_ISOLATED } },
  { tool: 'search_memories', args: { query: MARKER_SHARED } },
  { tool: 'search_by_entity', args: { entity: 'src/leak.ts' } },
  { tool: 'get_context', args: {} },
  { tool: 'get_context', args: { query: MARKER_MEMORY } },
  { tool: 'get_context', args: { query: MARKER_EPISODE } },
  { tool: 'get_context', args: { query: MARKER_MEMORY, strict_scope: false } },
  { tool: 'get_context', args: { query: MARKER_MEMORY, scope: 'funnel' } },
  { tool: 'get_context', args: { query: 'zzzz-no-match', strict_scope: false } },
  { tool: 'get_context', args: { budget_chars: 4000 } },
  { tool: 'get_context', args: { query: MARKER_MEMORY, budget_chars: 4000 } },
  { tool: 'list_memories', args: { limit: 50 } },
  { tool: 'list_memories', args: { limit: 50, include_archived: true } },
  { tool: 'search_memories', args: { query: MARKER_MEMORY, include_archived: true } },
  { tool: 'delete_episodes', args: { source: 'host', external_ids: ['turn-1'] } },
  { tool: 'recall_context', args: { query: MARKER_MEMORY, budget_chars: 4000 } },
  { tool: 'recall_context', args: { query: MARKER_EPISODE, budget_chars: 4000 } },
  { tool: 'get_state', args: {} },
  { tool: 'query_assertions', args: {} },
  { tool: 'session_start', args: {} },
  { tool: 'list_sessions', args: {} },
  { tool: 'consolidate_memories', args: { threshold: 0.5 } },
  { tool: 'get_stats', args: {} },
  { tool: 'task_get', args: {} },
  { tool: 'get_maintenance_status', args: {} },
]

const OWNER_ONLY_TOOLS = [
  'get_maintenance_status',
  'run_pending_maintenance',
  'list_brains',
  'search_brain',
  'get_brain_memory',
]

/** id-addressed calls, each run twice: the real id and an id that cannot exist */
const ID_CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'get_memory', args: {} },
  { tool: 'get_memory', args: { include_archived: true } },
  { tool: 'unarchive_memory', args: {} },
  { tool: 'get_related', args: {} },
  { tool: 'get_memory_history', args: {} },
  { tool: 'update_memory', args: { importance: 0.2 } },
  { tool: 'set_pin', args: { pinned: true } },
  { tool: 'mark_shareable', args: { shareable: true } },
  { tool: 'revise_memory', args: { content: 'a revision that must not land', reason: 'test' } },
  { tool: 'forget_memory', args: {} },
]

const TASK_ID_CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'task_get', args: {} },
  { tool: 'task_update', args: { status: 'blocked' } },
  { tool: 'task_handoff', args: {} },
  { tool: 'task_close', args: {} },
]

describe('principals: the enforced scope', () => {
  let fx: Fixture

  beforeEach(async () => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    fx = makeFixture()
    await seed(fx)
  })

  afterEach(() => {
    resetDatabase()
    resetServicesForTests()
  })

  it('refuses a delete outside the grant, even of a row the caller could otherwise see', async () => {
    // a shared row is visible to any reader, so only the namespace grant stops the delete
    await handleTool(
      'ingest_episodes',
      {
        project_path: A_ONLY,
        source: { system: 'host', instance: 'alice' },
        permissions: { visibility: 'project' },
        episodes: [{ external_id: 'shared-turn', content: 'a shared turn bob has no grant on' }],
      },
      { caller: fx.callerA }
    )
    const countIn = (ns: string): number =>
      (fx.db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE namespace = ?').get(ns) as { n: number }).n
    expect(countIn(A_ONLY)).toBe(1)

    for (const args of [{ namespace: A_ONLY }, { namespace: A_ONLY, source: 'host' }, { namespace: ABOVE, subtree: true }]) {
      const result = await handleTool('delete_episodes', args, { caller: fx.callerB })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).not.toContain('episodes":')
    }
    expect(countIn(A_ONLY)).toBe(1)
  })

  it('answers an unarchive of a row bob may not reach exactly as a missing id', async () => {
    fx.db.prepare('UPDATE memories SET archived_at = ? WHERE id = ?').run(Date.now(), fx.memoryA)
    const reached = parse<Record<string, unknown>>(
      await handleTool('unarchive_memory', { id: fx.memoryA }, { caller: fx.callerB })
    )
    const missing = parse<Record<string, unknown>>(
      await handleTool('unarchive_memory', { id: MISSING_ID }, { caller: fx.callerB })
    )
    expect({ ...reached, id: 'x' }).toEqual({ ...missing, id: 'x' })
    const row = fx.db.prepare('SELECT archived_at FROM memories WHERE id = ?').get(fx.memoryA) as {
      archived_at: number | null
    }
    expect(row.archived_at).not.toBeNull()
  })

  it('decides every advertised tool: swept, checked by id, or store-wide', () => {
    // delete_episodes and unarchive_memory are decided here too: the call specs carry
    // their names, so the sweep picks them up the moment the branch that adds them lands
    const decided = new Set([
      ...NAMESPACE_READS.map((call) => call.tool),
      ...ID_CALLS.map((call) => call.tool),
      ...TASK_ID_CALLS.map((call) => call.tool),
      ...OWNER_ONLY_TOOLS,
      'store_memory',
      'ingest_episodes',
      'task_start',
      'end_session',
      'assemble_context',
      'recall_context',
    ])
    const undecided = tools.map((tool) => tool.name).filter((name) => !decided.has(name))
    expect(undecided).toEqual([])
  })

  it('leaks nothing to bob through any advertised tool, handed a forged scope', async () => {
    const leaked: string[] = []
    for (const tool of tools) {
      for (const args of [
        { namespace: '/home/user' },
        { project_path: '/home/user', query: 'zulu-marker-memory', budget_chars: 2000 },
        { ...FORGED_HAND_FULL, id: fx.memoryA },
      ]) {
        const result = await handleTool(tool.name, args, { caller: fx.callerB })
        const found = leaks(result.content[0].text)
        if (found.length > 0) {
          leaked.push(`${tool.name} ${JSON.stringify(args).slice(0, 120)}: ${found.join(',')}`)
        }
      }
    }
    expect(leaked).toEqual([])
    // the sweep handed out real ids, so prove nothing was mutated or removed
    const alice = fx.db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ? AND owner_principal IS NOT NULL')
      .get(fx.memoryA) as { n: number }
    expect(alice.n).toBe(1)
    const episodes = fx.db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE external_id = 'turn-1'")
      .get() as { n: number }
    expect(episodes.n).toBe(1)
    const tasks = fx.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
    expect(tasks.n).toBe(1)
  })

  it('serves bob none of alice rows through any namespace-addressed read', async () => {
    const found: string[] = []
    for (const call of advertisedCalls(NAMESPACE_READS)) {
      const text = await callAs(fx.callerB, call.tool, { project_path: SHARED, ...call.args })
      const leaked = leaks(text)
      if (leaked.length > 0) found.push(`${call.tool} ${JSON.stringify(call.args)}: ${leaked.join(',')}`)
    }
    expect(found).toEqual([])
  })

  it('serves alice her own rows, so the sweep is not vacuously empty', async () => {
    const search = await callAs(fx.callerA, 'search_memories', {
      project_path: SHARED,
      query: MARKER_MEMORY,
    })
    expect(search).toContain(MARKER_MEMORY)
    const roster = await callAs(fx.callerA, 'list_memories', { project_path: SHARED, limit: 50 })
    expect(roster).toContain(MARKER_MEMORY)
    const episodes = await callAs(fx.callerA, 'assemble_context', {
      project_path: SHARED,
      query: MARKER_EPISODE,
      recipe: 'qa',
      budget_chars: 4000,
    })
    expect(episodes).toContain(MARKER_EPISODE)
    // the shared row is the control: it is written by alice and read by bob
    const shared = await callAs(fx.callerB, 'search_memories', {
      project_path: SHARED,
      query: MARKER_SHARED,
    })
    expect(shared).toContain(MARKER_SHARED)
  })

  it('refuses a namespace outside the grant, and a parent that would widen it', async () => {
    for (const namespace of [A_ONLY, ABOVE, '/']) {
      const refused = await callAs(fx.callerB, 'search_memories', {
        namespace,
        query: MARKER_ISOLATED,
      })
      const parsed = JSON.parse(refused) as { error?: string; results?: unknown[] }
      expect(parsed.error).toBeDefined()
      expect(parsed.error).toContain(namespace)
      expect(parsed.error).not.toContain('alice')
      expect(parsed.results).toBeUndefined()
    }

    // the same forgery on every other namespace-addressed tool
    for (const tool of [
      'get_context',
      'list_memories',
      'get_state',
      'recall_context',
      'assemble_context',
      'task_get',
      'search_by_entity',
    ]) {
      const args: Record<string, unknown> =
        tool === 'get_context'
          ? { namespace: ABOVE, query: 'anything', budget_chars: 2000 }
          : tool === 'recall_context'
            ? { namespace: ABOVE, query: 'anything', budget_chars: 2000 }
            : tool === 'assemble_context'
              ? { namespace: ABOVE, query: 'anything', budget_chars: 2000 }
              : tool === 'search_by_entity'
                ? { namespace: ABOVE, entity: 'x' }
                : { namespace: ABOVE }
      const text = await callAs(fx.callerB, tool, args)
      expect(text).toContain('not covered by this credential')
      expect(leaks(text)).toEqual([])
    }

    // a forged project_path is the same argument by another name
    const viaPath = await callAs(fx.callerB, 'list_memories', { project_path: A_ONLY })
    expect(viaPath).toContain('not covered by this credential')
  })

  it('keeps the funnel inside the grant: no guide or trace above the granted prefix', async () => {
    const text = await callAs(fx.callerB, 'get_context', {
      project_path: SHARED,
      query: 'zzzz-no-match-at-all',
      scope: 'funnel',
    })
    const parsed = JSON.parse(text) as {
      guide?: Array<{ namespace: string }>
      scope_trace?: Array<{ namespace: string }>
    }
    expect(parsed.guide ?? []).toEqual([])
    for (const entry of parsed.scope_trace ?? []) {
      expect(entry.namespace.startsWith(SHARED)).toBe(true)
    }
    expect(leaks(text)).toEqual([])
  })

  it('answers an id bob may not reach exactly as an id that does not exist', async () => {
    for (const call of advertisedCalls(ID_CALLS)) {
      const real = await callAs(fx.callerB, call.tool, { id: fx.memoryA, ...call.args })
      const fake = await callAs(fx.callerB, call.tool, { id: MISSING_ID, ...call.args })
      // the answers differ only in the id the caller supplied
      expect({ [call.tool]: real.split(fx.memoryA).join('ID') }).toEqual({
        [call.tool]: fake.split(MISSING_ID).join('ID'),
      })
      expect(leaks(real)).toEqual([])
    }
    for (const call of advertisedCalls(TASK_ID_CALLS)) {
      const real = await callAs(fx.callerB, call.tool, { id: fx.taskA, ...call.args })
      const fake = await callAs(fx.callerB, call.tool, { id: MISSING_ID, ...call.args })
      expect({ [call.tool]: real.split(fx.taskA).join('ID') }).toEqual({
        [call.tool]: fake.split(MISSING_ID).join('ID'),
      })
    }
    // the far side still works: alice reaches her own rows by id
    const mine = await callAs(fx.callerA, 'get_memory', { id: fx.memoryA })
    expect(mine).toContain(MARKER_MEMORY)
    const herTask = await callAs(fx.callerA, 'task_get', { id: fx.taskA })
    expect(herTask).toContain(MARKER_TASK)
  })

  it('defaults a named principal write to personal and keeps it from the other principals', async () => {
    const id = await storeAs(fx.callerB, {
      project_path: SHARED,
      content: 'bob keeps this to himself for now',
      importance: 0.9,
    })
    const row = fx.db
      .prepare('SELECT owner_principal, visibility FROM memories WHERE id = ?')
      .get(id) as { owner_principal: string | null; visibility: string | null }
    const bob = fx.callerB.principalId
    expect(row.owner_principal).toBe(bob)
    expect(row.visibility).toBe('personal')

    const aliceSearch = await callAs(fx.callerA, 'search_memories', {
      project_path: SHARED,
      query: 'bob keeps this to himself',
    })
    expect(aliceSearch).not.toContain('bob keeps this to himself')
    const ownSearch = await callAs(fx.callerB, 'search_memories', {
      project_path: SHARED,
      query: 'bob keeps this to himself',
    })
    expect(ownSearch).toContain('bob keeps this to himself')
    // the local owner is not a superuser over a named principal's private rows
    const ownerRoster = await callAs(LOCAL_OWNER, 'list_memories', { project_path: SHARED, limit: 50 })
    expect(ownerRoster).not.toContain('bob keeps this to himself')
    expect(ownerRoster).not.toContain(MARKER_MEMORY)
  })

  it('shares a project row with every reader of the namespace', async () => {
    const bobSearch = await callAs(fx.callerB, 'search_memories', {
      project_path: SHARED,
      query: MARKER_SHARED,
    })
    expect(bobSearch).toContain(MARKER_SHARED)
    const ownerSearch = await callAs(LOCAL_OWNER, 'search_memories', {
      project_path: SHARED,
      query: MARKER_SHARED,
    })
    expect(ownerSearch).toContain(MARKER_SHARED)
  })

  it('withholds a digest, topic or nav line built from another principal rows', async () => {
    await refreshDigest(fx.db, DIGEST_NS)
    const digestNsOnlyA = DIGEST_NS

    const asAlice = JSON.parse(
      await callAs(fx.callerA, 'get_context', { project_path: digestNsOnlyA })
    ) as { digest: string; degraded?: string[] }
    expect(asAlice.digest).toContain(MARKER_MEMORY)

    const asBob = JSON.parse(
      await callAs(fx.callerB, 'get_context', { project_path: digestNsOnlyA })
    ) as { digest: string; degraded?: string[] }
    expect(asBob.digest).toBe('')
    expect(asBob.degraded?.join(' ')).toContain('withheld')

    // fail closed: the local owner is served a digest only when it owns every row in it
    const asOwner = JSON.parse(
      await callAs(LOCAL_OWNER, 'get_context', { project_path: digestNsOnlyA })
    ) as { digest: string }
    expect(asOwner.digest).toBe('')

    // the assembled read carries the same withholding, named rather than silent
    const assembled = JSON.parse(
      await callAs(fx.callerB, 'assemble_context', {
        project_path: digestNsOnlyA,
        recipe: 'session-priming',
      })
    ) as { sections: Array<{ kind: string; items: Array<{ id: string }> }>; degraded: unknown[] }
    const summaries = assembled.sections.find((section) => section.kind === 'summaries')
    expect(summaries?.items ?? []).toEqual([])
  })

  it('runs every recipe for bob with nothing of alice in the payload', async () => {
    for (const recipe of Object.keys(RECIPES)) {
      const call = await handleTool(
        'assemble_context',
        { project_path: SHARED, query: MARKER_MEMORY, recipe },
        { caller: fx.callerB }
      )
      const leaked = leaks(call.content[0].text)
      expect({ [recipe]: leaked }).toEqual({ [recipe]: [] })
    }
  })

  it('keeps alice episode out of every bob read while alice still gets it', async () => {
    const bob = await callAs(fx.callerB, 'assemble_context', {
      project_path: SHARED,
      query: MARKER_EPISODE,
      recipe: 'qa',
      budget_chars: 4000,
    })
    expect(bob).not.toContain(MARKER_EPISODE)
    const alice = await callAs(fx.callerA, 'assemble_context', {
      project_path: SHARED,
      query: MARKER_EPISODE,
      recipe: 'qa',
      budget_chars: 4000,
    })
    expect(alice).toContain(MARKER_EPISODE)
    // the store holds one row, so the withholding is a read rule and not a write rule
    const rows = fx.db
      .prepare('SELECT COUNT(*) AS n FROM episodes WHERE content LIKE ?')
      .get(`%${MARKER_EPISODE}%`) as { n: number }
    expect(rows.n).toBe(1)
  })

  it('answers end_session from bob without ending alice session', async () => {
    const open = fx.db
      .prepare('SELECT id, owner_principal FROM sessions WHERE ended_at IS NULL')
      .all() as Array<{ id: string; owner_principal: string | null }>
    expect(open.length).toBeGreaterThan(0)

    const ended = JSON.parse(
      await callAs(fx.callerB, 'end_session', { project_path: SHARED })
    ) as { ended: boolean }
    expect(ended.ended).toBe(false)
    const still = fx.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL')
      .get() as { n: number }
    expect(still.n).toBe(open.length)
  })

  it('answers end_session by id from bob without ending alice session', async () => {
    const aSession = fx.db
      .prepare('SELECT id, owner_principal FROM sessions WHERE owner_principal IS NOT NULL')
      .get() as { id: string; owner_principal: string }
    expect(aSession.owner_principal).toBe(fx.callerA.principalId)

    const answer = await callAs(fx.callerB, 'end_session', {
      project_path: SHARED,
      session_id: aSession.id,
    })
    expect(answer).toContain('not found')
    const still = fx.db
      .prepare('SELECT ended_at FROM sessions WHERE id = ?')
      .get(aSession.id) as { ended_at: number | null }
    expect(still.ended_at).toBeNull()

    // alice can close her own
    const hers = await callAs(fx.callerA, 'end_session', {
      project_path: SHARED,
      session_id: aSession.id,
    })
    expect(JSON.parse(hers).ended).toBe(true)
  })

  it('serves the delivery cue route alice row to alice and not to bob', async () => {
    const app = createServer({})
    const cue = async (token: string) => {
      const res = await app.request('/delivery/cue', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ namespace: SHARED, path: 'src/leak.ts' }),
      })
      return (await res.json()) as { entries?: Array<{ id: string }>; error?: string }
    }
    expect((await cue(fx.tokenA)).entries?.length ?? 0).toBeGreaterThan(0)
    expect((await cue(fx.tokenB)).entries ?? []).toEqual([])

    const roster = await app.request('/delivery/roster', {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.tokenB}`, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: SHARED }),
    })
    const body = (await roster.json()) as { entries: Array<{ preview: string }> }
    expect(body.entries.map((entry) => entry.preview).join(' ')).not.toContain(MARKER_MEMORY)

    const forged = await app.request('/delivery/roster', {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.tokenB}`, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: A_ONLY }),
    })
    expect(forged.status).toBe(403)
  })

  it('records one audit row for a read that returned another principal row', async () => {
    const before = (fx.db.prepare('SELECT COUNT(*) AS n FROM read_audit').get() as { n: number }).n
    await callAs(fx.callerB, 'search_memories', { project_path: SHARED, query: MARKER_SHARED })
    const rows = fx.db
      .prepare('SELECT principal_id, namespace, tool, ids_json, channel FROM read_audit')
      .all() as Array<{
      principal_id: string | null
      namespace: string
      tool: string
      ids_json: string
      channel: string
    }>
    expect(rows.length).toBe(before + 1)
    const row = rows[rows.length - 1]
    expect(row.principal_id).toBe(fx.callerB.principalId)
    expect(row.namespace).toBe(SHARED)
    expect(row.tool).toBe('search_memories')
    expect(row.channel).toBe('hybrid')
    expect(JSON.parse(row.ids_json).length).toBeGreaterThan(0)
  })

  it('resolves a credential to a principal, and a revoked or disabled one to nothing', () => {
    const asBob = resolveCredential(fx.db, `Bearer ${fx.tokenB}`)
    expect(asBob?.kind).toBe('principal')
    expect(asBob?.caller.principalId).toBe(fx.callerB.principalId)
    expect(livePrincipalForToken(fx.db, fx.tokenB)).not.toBeNull()

    revokeTokens(fx.db, 'bob')
    expect(resolveCredential(fx.db, `Bearer ${fx.tokenB}`)).toBeNull()
    expect(livePrincipalForToken(fx.db, fx.tokenB)).toBeNull()

    // a disabled principal is refused even with a live token
    const fresh = issueToken(fx.db, 'bob').token
    setPrincipalDisabled(fx.db, 'bob', true)
    expect(resolveCredential(fx.db, `Bearer ${fresh}`)).toBeNull()

    // a request that presents nothing is refused while a principal exists: omitting the
    // token is not a way back in as the owner
    expect(resolveCredential(fx.db, undefined, {})).toBeNull()

    // the install credential is still the local owner
    const installToken = ['install', 'token', 'fixture'].join('-')
    const install = resolveCredential(fx.db, `Bearer ${installToken}`, {
      ENGRAM_AUTH_TOKEN: installToken,
    })
    expect(install?.kind).toBe('install-token')
    expect(install?.caller.localOwner).toBe(true)
  })

  it('stores the token only as its own sha256', () => {
    const rows = fx.db.prepare('SELECT token_hash FROM principal_tokens').all() as Array<{
      token_hash: string
    }>
    expect(rows.length).toBe(2)
    const hashes = new Set(rows.map((row) => row.token_hash))
    expect(hashes.has(tokenHash(fx.tokenA))).toBe(true)
    expect(hashes.has(tokenHash(fx.tokenB))).toBe(true)
    for (const hash of hashes) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
      expect(hash).not.toContain(fx.tokenA)
      expect(hash).not.toContain(fx.tokenB)
    }
  })

  it('serves a store-wide tool only to the local owner', async () => {
    for (const tool of OWNER_ONLY_TOOLS) {
      const args: Record<string, unknown> =
        tool === 'search_brain'
          ? { brain: 'x', query: 'y' }
          : tool === 'get_brain_memory'
            ? { brain: 'x', id: 'y' }
            : {}
      const asBob = await handleTool(tool, args, { caller: fx.callerB })
      expect(asBob.isError).toBe(true)
      expect(asBob.content[0].text).toContain('not covered by a namespace grant')
    }
  })
})

describe('principals: an unauthenticated request once a principal exists', () => {
  const DELIVERY_ROUTES = [
    '/delivery/roster',
    '/delivery/cue',
    '/delivery/task-brief',
    '/delivery/task-checkpoint',
    '/delivery/task-progress',
    '/delivery/session-end',
  ]

  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetDatabase()
    resetServicesForTests()
  })

  function body(namespace: string): Record<string, unknown> {
    return { namespace, path: 'src/leak.ts', text: 'a progress note', summary: 'a summary' }
  }

  it('refuses /mcp and every delivery route with no credential, and serves them without principals', async () => {
    const db = getDatabase().db
    const installToken = ['install', 'token', 'fixture'].join('-')
    vi.stubEnv('ENGRAM_AUTH_TOKEN', installToken)
    const app = createServer({})

    const mcp = (header?: string) =>
      app.request('/mcp', {
        method: 'POST',
        headers: header ? { authorization: header, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'search_memories',
            arguments: { project_path: '/home/user/team-project', query: 'zulu-marker-memory' },
          },
        }),
      })

    // no principal in the store: no credential is the local owner, as it always was
    const openStore = await mcp()
    expect(openStore.status).toBe(200)
    for (const route of DELIVERY_ROUTES) {
      const res = await app.request(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body('/home/user/team-project')),
      })
      expect({ [route]: res.status }).toEqual({ [route]: 200 })
    }

    addPrincipal(db, 'alice')
    grantVerbs(db, 'alice', '/home/user/team-project', [...ALL_VERBS])

    const refused = await mcp()
    expect(refused.status).toBe(401)
    expect(await refused.text()).not.toContain(MARKER_MEMORY)

    for (const route of DELIVERY_ROUTES) {
      const res = await app.request(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body('/home/user/team-project')),
      })
      const text = await res.text()
      expect({ [route]: res.status }).toEqual({ [route]: 401 })
      expect({ [route]: text }).toEqual({ [route]: expect.not.stringContaining('entries') })
    }

    // the store-wide metrics counters are the local owner's too
    const metricsAnon = await app.request('/metrics')
    expect(metricsAnon.status).toBe(401)
    const metricsScoped = await app.request(
      `/metrics?namespace=${encodeURIComponent('/home/user/team-project')}`
    )
    expect(metricsScoped.status).toBe(401)
    const metricsForged = await app.request(
      `/metrics?namespace=${encodeURIComponent(A_ONLY)}`,
      { headers: { authorization: `Bearer ${(await issueToken(db, 'alice')).token}` } }
    )
    expect(metricsForged.status).toBe(403)

    // the install token is the way back in, and the caller is the local owner
    const asOwner = await mcp(`Bearer ${installToken}`)
    expect(asOwner.status).toBe(200)
    const metricsOwner = await app.request('/metrics', {
      headers: { authorization: `Bearer ${installToken}` },
    })
    expect(metricsOwner.status).toBe(200)

    // a disabled principal's token is refused
    const token = issueToken(db, 'alice').token
    expect((await mcp(`Bearer ${token}`)).status).toBe(200)
    setPrincipalDisabled(db, 'alice', true)
    expect((await mcp(`Bearer ${token}`)).status).toBe(401)
  })

  it('returns to local-owner mode when every principal is disabled', () => {
    const db = getDatabase().db
    addPrincipal(db, 'alice')
    expect(resolveCredential(db, undefined, {})).toBeNull()
    setPrincipalDisabled(db, 'alice', true)
    expect(resolveCredential(db, undefined, {})?.caller.localOwner).toBe(true)
  })
})

describe('principals: no principals is the local owner', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  afterEach(() => {
    resetDatabase()
    resetServicesForTests()
  })

  it('serves a principal-free store with no credential at all, as it always did', async () => {
    const stored = await handleTool('store_memory', {
      project_path: SHARED,
      content: 'the single-user install writes and reads with no credential',
    })
    expect(parse<{ status: string }>(stored).status).toBe('stored')
    const read = await handleTool('get_context', { project_path: SHARED, query: 'single-user' })
    expect(read.content[0].text).toContain('single-user install writes and reads')
    const row = getDatabase().db
      .prepare('SELECT owner_principal, visibility FROM memories')
      .get() as { owner_principal: string | null; visibility: string | null }
    expect(row.owner_principal).toBeNull()
    expect(row.visibility).toBeNull()
  })

  it('treats the install token as the local owner credential', () => {
    const env = { ENGRAM_AUTH_TOKEN: ['tok', 'install', 'fixture'].join('-') }
    const resolved = resolveCredential(getDatabase().db, `Bearer ${env.ENGRAM_AUTH_TOKEN}`, env)
    expect(resolved?.kind).toBe('install-token')
    expect(resolved?.caller.localOwner).toBe(true)
    expect(resolveCredential(getDatabase().db, `Bearer ${['nope'].join('')}`, env)).toBeNull()
    // with no principal to be a boundary, even nothing at all is the owner
    expect(resolveCredential(getDatabase().db, undefined, env)?.caller.localOwner).toBe(true)
  })
})
