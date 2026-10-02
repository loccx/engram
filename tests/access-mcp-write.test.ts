import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { addPrincipal, callerScopeFor, getPrincipal, grantVerbs } from '../src/mcp/principals.js'
import { LOCAL_OWNER, withCaller, type CallerScope } from '../src/memory/access.js'
import { linkMemoryEpisode } from '../src/memory/episodes.js'
import { createSourceConnection, sourceHash, syncSourcePage, type SourceConnector } from '../src/sources/index.js'

vi.mock('../src/llm/client.js', () => ({ isLlmConfigured: () => false }))
const NS = '/synthetic/mutation-responses'
const ID = 'shared-mutation-fixture'
const CONTENT = 'Previously unseen synthetic canonical content belongs to the fixture owner.'
const TAG = 'previously-unseen-fixture-tag'
let owner: CallerScope
let reader: CallerScope
let writer: CallerScope
const parsed = (result: Awaited<ReturnType<typeof handleTool>>) => JSON.parse(result.content[0].text)

beforeEach(() => {
  resetServicesForTests()
  resetDatabase()
  const db = getDatabase(':memory:').db
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden in mutation fixtures') }))
  for (const name of ['fixture-owner', 'fixture-mutator']) {
    addPrincipal(db, name, 'agent')
    grantVerbs(db, name, NS, ['read', 'write', 'delete'])
  }
  owner = callerScopeFor(db, getPrincipal(db, 'fixture-owner')!)
  reader = callerScopeFor(db, getPrincipal(db, 'fixture-mutator')!)
  writer = { ...reader, grants: [{ prefix: NS, verbs: ['write'] }] }
  db.prepare('INSERT INTO sessions(id, project_path, started_at) VALUES (?, ?, 100)').run('mutation-session', NS)
  db.prepare(`INSERT INTO memories
    (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, owner_principal, visibility)
    VALUES (?, 'mutation-session', ?, ?, ?, 'note', 0.5, ?, 100, 100, ?, 'project')`)
    .run(ID, NS, NS, CONTENT, JSON.stringify([TAG]), owner.principalId)
})
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  resetServicesForTests()
  resetDatabase()
})

const mutations = [
  { tool: 'update_memory', args: { importance: 0.75 }, field: 'importance', expected: 0.75 },
  { tool: 'set_pin', args: { pinned: true }, field: 'pinned', expected: 1 },
  { tool: 'unarchive_memory', args: {}, field: 'archived_at', expected: null },
]

describe('canonical mutation response authority', () => {
  it.each(mutations)('$tool acknowledges write-only mutation without returning prior data', async ({ tool, args, field, expected }) => {
    const db = getDatabase().db
    if (tool === 'unarchive_memory') db.prepare('UPDATE memories SET archived_at = 200 WHERE id = ?').run(ID)
    expect((await handleTool('get_memory', { id: ID, include_archived: true }, { caller: writer })).isError).toBe(true)
    const result = await handleTool(tool, { id: ID, ...args }, { caller: writer })
    expect(result.isError).not.toBe(true)
    expect(parsed(result)).toEqual({ success: true, id: ID })
    expect(result.content[0].text).not.toContain(CONTENT)
    expect(result.content[0].text).not.toContain(TAG)
    const row = db.prepare('SELECT importance, pinned, archived_at FROM memories WHERE id = ?').get(ID) as Record<string, unknown>
    expect(row[field]).toBe(expected)
    expect((await handleTool('get_memory', { id: ID }, { caller: writer })).isError).toBe(true)
  })

  it.each(mutations)('$tool retains the existing full response for a readable shared row', async ({ tool, args }) => {
    if (tool === 'unarchive_memory') getDatabase().db.prepare('UPDATE memories SET archived_at = 200 WHERE id = ?').run(ID)
    const result = await handleTool(tool, { id: ID, ...args }, { caller: reader })
    expect(result.isError).not.toBe(true)
    expect(parsed(result).success).toBe(true)
    expect(parsed(result).memory.content).toBe(CONTENT)
    expect(parsed(result).memory.tags).toEqual([TAG])
  })

  it('rechecks visibility after a metadata mutation makes the row unreadable', async () => {
    const result = await handleTool('update_memory', { id: ID, visibility: 'personal' }, { caller: reader })
    expect(result.isError).not.toBe(true)
    expect(parsed(result)).toEqual({ success: true, id: ID })
    expect((await handleTool('get_memory', { id: ID }, { caller: reader })).isError).toBe(true)
    expect(getDatabase().db.prepare('SELECT owner_principal FROM memories WHERE id = ?').get(ID)).toEqual({ owner_principal: owner.principalId })
  })

  it('does not return inherited unreadable tags or prose through a write-only revision', async () => {
    const result = await handleTool('revise_memory', { id: ID, content: 'New synthetic content supplied by the fixture writer.' }, { caller: writer })
    expect(result.isError).not.toBe(true)
    const value = parsed(result)
    expect(Object.keys(value).sort()).toEqual(['id', 'previous_id'])
    expect(value.id).not.toBe(ID)
    expect(value.previous_id).toBe(ID)
    expect(result.content[0].text).not.toContain(CONTENT)
    expect(result.content[0].text).not.toContain(TAG)
  })

  it('retains readable canonical revision responses', async () => {
    const content = 'Readable synthetic revision content supplied by the fixture mutator.'
    const result = await handleTool('revise_memory', { id: ID, content }, { caller: reader })
    expect(result.isError).not.toBe(true)
    expect(parsed(result).memory.content).toBe(content)
    expect(parsed(result).memory.tags).toEqual([TAG])
    expect(parsed(result).version).toBeGreaterThan(1)
  })
})

describe('canonical deletion and source ownership composition', () => {
  it.each(['local-owner', 'named-deleter'])('preserves ordinary shared-memory deletion for $0', async (kind) => {
    const caller = kind === 'local-owner' ? LOCAL_OWNER : { ...reader, grants: [{ prefix: NS, verbs: ['delete'] as const }] }
    const result = await handleTool('forget_memory', { id: ID }, { caller })
    expect(result.isError).not.toBe(true)
    expect(parsed(result)).toEqual({ success: true, id: ID })
    expect(getDatabase().db.prepare('SELECT id FROM memories WHERE id = ?').get(ID)).toBeUndefined()
    expect(getDatabase().db.prepare('SELECT * FROM source_forget_barriers').all()).toEqual([])
  })

  it('retains exact source-owner authority before establishing a sticky source barrier', async () => {
    const db = getDatabase().db
    const connector: SourceConnector = {
      provider: 'fixture', account_hash: sourceHash('inert-mutation-account'), scope_hash: sourceHash('inert-mutation-scope'),
      changes: async () => ({ next_cursor: '1', changes: [{ kind: 'upsert', external_id: 'fixture-source', revision: '1', content: 'Inert synthetic evidence for the shared canonical fixture.' }] }),
    }
    const connection = withCaller(owner, () => createSourceConnection(db, connector, { namespace: NS }))
    await withCaller(owner, () => syncSourcePage(db, connection.id, connector))
    const episode = db.prepare("SELECT id FROM episodes WHERE source_state = 'current'").get() as { id: string }
    withCaller(owner, () => linkMemoryEpisode(db, { memory_id: ID, episode_id: episode.id, span_start: null, span_end: null }))
    for (const caller of [reader, LOCAL_OWNER]) {
      const result = await handleTool('forget_memory', { id: ID }, { caller })
      expect(result.isError).toBe(true)
      expect(db.prepare('SELECT id FROM memories WHERE id = ?').get(ID)).toBeDefined()
      expect(db.prepare('SELECT id FROM episodes WHERE id = ?').get(episode.id)).toBeDefined()
      expect(db.prepare('SELECT * FROM source_forget_barriers').all()).toEqual([])
    }
    const result = await handleTool('forget_memory', { id: ID }, { caller: owner })
    expect(result.isError).not.toBe(true)
    expect(parsed(result).success).toBe(true)
    expect(db.prepare('SELECT * FROM episodes').all()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_forget_barriers').get()).toEqual({ n: 1 })
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})
