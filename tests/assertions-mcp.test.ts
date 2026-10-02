import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { tools } from '../src/mcp/tools.js'
import { LOCAL_OWNER, type CallerScope } from '../src/memory/access.js'
import { attachAssertion, registerAssertionSchema } from '../src/memory/assertions/index.js'
import type { AssertionQueryResult } from '../src/memory/assertions/index.js'

const NS = '/synthetic/typed-profile'
const READER: CallerScope = {
  principalId: 'fixture-reader', name: 'fixture-reader', localOwner: false,
  grants: [{ prefix: NS, verbs: ['read'] }],
}

function parsed(result: Awaited<ReturnType<typeof handleTool>>): AssertionQueryResult {
  return JSON.parse(result.content[0].text)
}

beforeEach(() => {
  resetDatabase()
  resetServicesForTests()
  const db = getDatabase(':memory:').db
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)')
    .run('typed-mcp-session', NS, 100)
  registerAssertionSchema(db, {
    schema_id: 'profile.timezone@1', predicate: 'profile.timezone',
    value_schema: { type: 'string', maxLength: 64 },
  })
  for (const [id, namespace, visibility, value] of [
    ['personal', NS, 'personal', 'Europe/Paris'],
    ['shared', NS, 'project', 'Europe/London'],
    ['other-scope', `${NS}/other`, 'project', 'Europe/Berlin'],
  ]) {
    db.prepare(`INSERT INTO memories
      (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, visibility)
      VALUES (?, 'typed-mcp-session', ?, ?, ?, 'note', 0.5, '[]', 100, 100, ?)`)
      .run(id, namespace, namespace, `The fixture timezone is ${value}.`, visibility)
    attachAssertion(db, {
      memory_id: id, schema_id: 'profile.timezone@1', subject: 'person:fixture',
      predicate: 'profile.timezone', value,
    })
  }
})
afterEach(() => {
  resetServicesForTests()
  resetDatabase()
})

describe('query-only structured memory MCP surface', () => {
  it('advertises only a bounded read surface, not authority-changing writes', () => {
    const tool = tools.find((entry) => entry.name === 'query_assertions') as {
      annotations: { readOnlyHint: boolean }
      inputSchema: { properties: { limit: { maximum: number } } }
    } | undefined
    expect(tool?.annotations.readOnlyHint).toBe(true)
    expect(tool?.inputSchema.properties.limit.maximum).toBe(100)
    for (const name of ['register_assertion_schema', 'attach_assertion', 'replace_assertion_representation']) {
      expect(tools.some((entry) => entry.name === name)).toBe(false)
    }
  })

  it('serves exact structured results through the handler with explicit snapshot caveats', async () => {
    const result = await handleTool('query_assertions', {
      namespace: NS, subject: 'person:fixture', predicate: 'profile.timezone', value: 'Europe/Paris',
    }, { caller: LOCAL_OWNER })
    expect(result.isError).not.toBe(true)
    const payload = parsed(result)
    expect(payload.assertions.map((row) => row.memory_id)).toEqual(['personal'])
    expect(payload.representation_history).toBe('current-only')
    expect(payload.evidence_history).toBe('current-visible-links')
    expect(payload.assertions[0].provenance.origin).toBeNull()
  })

  it('intersects exact namespace with authenticated row visibility', async () => {
    const result = await handleTool('query_assertions', { namespace: NS }, { caller: READER })
    expect(result.isError).not.toBe(true)
    expect(parsed(result).assertions.map((row) => row.memory_id)).toEqual(['shared'])
    expect(result.content[0].text).not.toContain('Europe/Paris')
    expect(result.content[0].text).not.toContain('Europe/Berlin')
    const refused = await handleTool('query_assertions', { namespace: '/synthetic' }, { caller: READER })
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).not.toContain('Europe/Paris')
  })

  it('rejects authority flags, conflicting clocks and oversized limits', async () => {
    for (const args of [
      { namespace: NS, trusted: true },
      { namespace: NS, as_of: 100, valid_at: 101 },
      { namespace: NS, limit: 101 },
    ]) {
      expect((await handleTool('query_assertions', args, { caller: LOCAL_OWNER })).isError).toBe(true)
    }
  })

  it('keeps observation cutoff distinct from canonical validity', async () => {
    const earlier = parsed(await handleTool('query_assertions', {
      namespace: NS, observed_before: 99, valid_at: 100,
    }, { caller: LOCAL_OWNER }))
    expect(earlier.assertions).toEqual([])
    const observed = parsed(await handleTool('query_assertions', {
      namespace: NS, observed_before: 100, valid_at: 100,
    }, { caller: LOCAL_OWNER }))
    expect(observed.assertions).toHaveLength(2)
  })

  it('removes typed values when the canonical memory is forgotten', async () => {
    const removed = await handleTool('forget_memory', { id: 'personal' }, { caller: LOCAL_OWNER })
    expect(removed.isError).not.toBe(true)
    const after = parsed(await handleTool('query_assertions', {
      namespace: NS, value: 'Europe/Paris', include_superseded: true, include_archived: true,
    }, { caller: LOCAL_OWNER }))
    expect(after.assertions).toEqual([])
  })

  it('matches canonical scope-local supersession for default and historical exact reads', async () => {
    const db = getDatabase().db
    const edge = db.prepare(`INSERT INTO memory_links
      (source_id, target_id, similarity, link_type, confidence, revision, created_at, judged_at)
      VALUES (?, 'shared', 0.9, 'supersedes', 1, 1, 150, 150)`)
    edge.run('other-scope')
    for (const clock of [{}, { as_of: 200 }]) {
      const canonical = JSON.parse((await handleTool('list_memories', { namespace: NS, ...clock }, { caller: READER })).content[0].text)
      expect(canonical.memories.some((row: { id: string }) => row.id === 'shared')).toBe(true)
      const typed = parsed(await handleTool('query_assertions', { namespace: NS, ...clock }, { caller: READER }))
      expect(typed.assertions.map((row) => row.memory_id)).toEqual(['shared'])
    }
    edge.run('personal')
    for (const clock of [{}, { as_of: 200 }]) {
      const typed = parsed(await handleTool('query_assertions', { namespace: NS, ...clock }, { caller: LOCAL_OWNER }))
      expect(typed.assertions.some((row) => row.memory_id === 'shared')).toBe(false)
      const canonical = JSON.parse((await handleTool('list_memories', { namespace: NS, ...clock }, { caller: LOCAL_OWNER })).content[0].text)
      expect(canonical.memories.some((row: { id: string }) => row.id === 'shared')).toBe(false)
    }
  })
})
