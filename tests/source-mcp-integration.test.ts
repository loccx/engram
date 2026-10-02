import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { attachAssertion, registerAssertionSchema } from '../src/memory/assertions/index.js'
import { linkMemoryEpisode } from '../src/memory/episodes.js'
import { MemoryStore } from '../src/memory/store.js'
import { refreshDigest } from '../src/memory/digest.js'
import { createSourceConnection, readSourceGeneration, revokeSourceConnection, sourceHash, syncSourcePage, type SourceConnector } from '../src/sources/index.js'

const completion = vi.hoisted(() => ({ enabled: false, revoke: null as null | (() => void) }))
vi.mock('../src/llm/client.js', () => ({
  isLlmConfigured: () => completion.enabled,
  chat: async () => {
    completion.revoke?.()
    return { content: 'obsolete synthetic summary must not be restored' }
  },
}))
const NS = '/synthetic/source-mcp'
const parse = (result: Awaited<ReturnType<typeof handleTool>>) => JSON.parse(result.content[0].text)
class InertConnector implements SourceConnector {
  readonly provider = 'fixture'
  readonly account_hash = sourceHash('inert-account')
  readonly scope_hash: string
  revision = 1
  constructor(scope = 'inert-permission-scope') { this.scope_hash = sourceHash(scope) }
  async changes(_cursor: string | null, _limit: number): Promise<unknown> {
    return { next_cursor: String(this.revision), changes: [{
      kind: 'upsert', external_id: 'fixture-profile', revision: `revision-${this.revision}`,
      content: `Synthetic timezone observation ${this.revision}: Europe/Paris.`,
    }] }
  }
}

beforeEach(() => {
  resetServicesForTests()
  resetDatabase()
  getDatabase(':memory:')
  completion.enabled = false
  completion.revoke = null
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden in inert integration fixtures') }))
})
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  resetServicesForTests()
  resetDatabase()
})

async function setup() {
  const db = getDatabase().db
  const connector = new InertConnector()
  const connection = createSourceConnection(db, connector, { namespace: NS })
  await syncSourcePage(db, connection.id, connector)
  const result = await handleTool('store_memory', {
    namespace: NS, content: 'The synthetic fixture uses Europe/Paris as its timezone.', pinned: true,
  })
  expect(result.isError).not.toBe(true)
  const id: string = parse(result).id
  const episode = db.prepare("SELECT id FROM episodes WHERE source_state = 'current'").get() as { id: string }
  linkMemoryEpisode(db, { memory_id: id, episode_id: episode.id, span_start: null, span_end: null })
  registerAssertionSchema(db, { schema_id: 'fixture.timezone@1', predicate: 'fixture.timezone', value_schema: { type: 'string' } })
  const attach = (memoryId: string) => attachAssertion(db, {
    memory_id: memoryId, schema_id: 'fixture.timezone@1', subject: 'fixture-person',
    predicate: 'fixture.timezone', value: 'Europe/Paris',
  })
  attach(id)
  return { db, connector, connection, id, attach }
}

describe('source lifecycle composed with canonical MCP and typed reads', () => {
  it('serves typed evidence then purges canonical revisions and sidecars on source replacement', async () => {
    const { db, connector, connection, id, attach } = await setup()
    const current = parse(await handleTool('query_assertions', { namespace: NS, subject: 'fixture-person' }))
    expect(current.assertions).toHaveLength(1)
    expect(current.assertions[0].provenance.evidence).toHaveLength(1)
    const revised = await new MemoryStore(db, false).revise({ id, content: 'Revised synthetic timezone claim remains Europe/Paris.' })
    expect(revised).not.toBeNull()
    attach(revised!.memory.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_assertions').get()).toEqual({ n: 2 })
    connector.revision++
    await syncSourcePage(db, connection.id, connector)
    expect(db.prepare('SELECT id FROM memories WHERE id IN (?, ?)').all(id, revised!.memory.id)).toEqual([])
    expect(parse(await handleTool('query_assertions', { namespace: NS })).assertions).toEqual([])
    expect(db.prepare('SELECT * FROM memory_assertions').all()).toEqual([])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('makes MCP forget sticky across a new permission-scope connection before losing citations', async () => {
    const { db, id, connection } = await setup()
    const revised = await new MemoryStore(db, false).revise({ id, content: 'Current manual synthetic timezone revision is Europe/Paris.' })
    const result = await handleTool('forget_memory', { id: revised!.memory.id })
    expect(result.isError).not.toBe(true)
    expect(parse(result).success).toBe(true)
    expect(db.prepare('SELECT * FROM memory_assertions').all()).toEqual([])
    expect(db.prepare('SELECT * FROM episodes').all()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_forget_barriers').get()).toEqual({ n: 1 })
    const changedScope = new InertConnector('new-inert-permission-scope')
    const next = createSourceConnection(db, changedScope, { namespace: NS })
    expect(next.id).not.toBe(connection.id)
    expect(await syncSourcePage(db, next.id, changedScope)).toMatchObject({ upserted: 0, skipped: 1 })
    expect(db.prepare('SELECT * FROM episodes').all()).toEqual([])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('uses the real transactional source epoch to fence an asynchronous digest completion', async () => {
    const { db, connection } = await setup()
    const before = readSourceGeneration(db)
    db.prepare('DELETE FROM project_digests WHERE namespace = ?').run(NS)
    completion.enabled = true
    completion.revoke = () => { revokeSourceConnection(db, connection.id) }
    const result = await refreshDigest(db, NS, { budgetChars: 8 })
    expect(readSourceGeneration(db)).toBeGreaterThan(before)
    expect(result.content).toBe('')
    expect(db.prepare('SELECT * FROM project_digests').all()).toEqual([])
    expect(parse(await handleTool('query_assertions', { namespace: NS })).assertions).toEqual([])
  })
})
