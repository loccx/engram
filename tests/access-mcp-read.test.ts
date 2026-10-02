import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { addPrincipal, callerScopeFor, getPrincipal, grantVerbs } from '../src/mcp/principals.js'
import type { CallerScope } from '../src/memory/access.js'
import * as enrichment from '../src/memory/enrichment.js'

const NS = '/synthetic/access-mcp/allowed'
const OTHER = '/synthetic/access-mcp/other'
const HIDDEN = 'fixture-private-hidden-text'
const FOREIGN = 'fixture-outside-query-text'
let caller: CallerScope
let anchor: string
let hidden: string
let foreign: string
let shared: string

function payload(result: Awaited<ReturnType<typeof handleTool>>): Record<string, any> {
  return JSON.parse(result.content[0].text)
}
async function store(scope: CallerScope, namespace: string, content: string, visibility = 'personal'): Promise<string> {
  const result = await handleTool('store_memory', { namespace, content, visibility }, { caller: scope })
  expect(result.isError).not.toBe(true)
  const value = payload(result)
  expect(value.status).not.toBe('rejected')
  return value.id
}

beforeEach(async () => {
  resetDatabase()
  resetServicesForTests()
  const db = getDatabase(':memory:').db
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden in access fixtures') }))
  for (const name of ['fixture-alice', 'fixture-bob']) {
    addPrincipal(db, name, 'agent')
    grantVerbs(db, name, '/synthetic/access-mcp', ['read', 'write', 'delete'])
  }
  const alice = getPrincipal(db, 'fixture-alice')!
  const bob = getPrincipal(db, 'fixture-bob')!
  caller = callerScopeFor(db, alice)
  const otherCaller = callerScopeFor(db, bob)
  anchor = await store(caller, NS, 'alphaScope fixture uses alpha/cache.ts for bounded cache reads.')
  hidden = await store(otherCaller, NS, `${HIDDEN}: private calendar handling is unrelated.`)
  foreign = await store(caller, OTHER, `${FOREIGN}: alphaScope external project policy.`)
  shared = await store(otherCaller, NS, 'alphaScope shared retry policy uses a bounded delay.', 'project')
  db.prepare('UPDATE memories SET created_at = 100, valid_from = 100').run()
  const edge = db.prepare(`INSERT OR REPLACE INTO memory_links
    (source_id, target_id, similarity, link_type, confidence, revision, created_at, judged_at)
    VALUES (?, ?, 0.9, ?, 1, ?, 150, 150)`)
  edge.run(anchor, hidden, 'semantic', 0)
  edge.run(anchor, foreign, 'semantic', 0)
  edge.run(anchor, shared, 'semantic', 0)
  edge.run(hidden, anchor, 'supersedes', 1)
  edge.run(foreign, anchor, 'supersedes', 1)
  edge.run(anchor, hidden, 'conflicts', 0)
  edge.run(anchor, foreign, 'conflicts', 0)
})
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetServicesForTests()
  resetDatabase()
})

describe('access-scoped MCP read composition', () => {
  it('applies anchor scope to one-hop and multi-hop traversal and edge metadata', async () => {
    for (const depth of [1, 3]) {
      const result = await handleTool('get_related', { id: anchor, depth }, { caller })
      expect(result.isError).not.toBe(true)
      const value = payload(result)
      expect(value.memory.conflict_count).toBe(0)
      expect(value.memory.disputed).toBe(false)
      expect(value.memory.supersedes_counts.superseded_by).toBe(0)
      expect(value.related.some((row: { id: string }) => row.id === shared)).toBe(true)
      expect(result.content[0].text).not.toContain(hidden)
      expect(result.content[0].text).not.toContain(foreign)
      expect(result.content[0].text).not.toContain(HIDDEN)
      expect(result.content[0].text).not.toContain(FOREIGN)
    }
  })

  it('does not let inaccessible successors suppress a narrow search or expose counts', async () => {
    const result = await handleTool('search_memories', { namespace: NS, query: 'alphaScope' }, { caller })
    expect(result.isError).not.toBe(true)
    const value = payload(result)
    const found = value.results.find((row: { id: string }) => row.id === anchor)
    expect(found).toBeDefined()
    expect(found.supersedes_counts.superseded_by).toBe(0)
    expect(found.conflict_count).toBe(0)
    expect(result.content[0].text).not.toContain(HIDDEN)
    expect(result.content[0].text).not.toContain(FOREIGN)
  })

  it('withholds inaccessible history versions and their link endpoints', async () => {
    const result = await handleTool('get_memory_history', { id: anchor, as_of: 200 }, { caller })
    expect(result.isError).not.toBe(true)
    const value = payload(result)
    expect(value.versions.map((row: { id: string }) => row.id)).toEqual([anchor])
    expect(value.links).toEqual([])
    expect(result.content[0].text).not.toContain(hidden)
    expect(result.content[0].text).not.toContain(foreign)
  })

  it('keeps historical by-id reads inside the readable anchor lineage', async () => {
    const result = await handleTool('get_memory', { id: anchor, as_of: 200 }, { caller })
    expect(result.isError).not.toBe(true)
    expect(payload(result).id).toBe(anchor)
    expect(result.content[0].text).not.toContain(HIDDEN)
    expect(result.content[0].text).not.toContain(FOREIGN)
  })

  it('keeps symbolic namespace enrichment leaf-only when strict_scope is false', async () => {
    const db = getDatabase().db
    const enrichmentCall = vi.spyOn(enrichment, 'enrichSearchResults')
    const symbolicCaller: CallerScope = { ...caller, grants: [{ prefix: 'fixture-symbolic', verbs: ['read', 'write'] }] }
    const root = await store(symbolicCaller, 'fixture-symbolic', 'symbolicNeedle synthetic leaf evidence.', 'project')
    const child = await store(symbolicCaller, 'fixture-symbolic/child', 'symbolicNeedle synthetic descendant evidence.', 'project')
    const edge = db.prepare(`INSERT INTO memory_links
      (source_id, target_id, similarity, link_type, confidence, revision, created_at, judged_at)
      VALUES (?, ?, 0.9, ?, 1, ?, 150, 150)`)
    edge.run(root, child, 'conflicts', 0)
    edge.run(child, root, 'supersedes', 1)
    const result = await handleTool('get_context', { namespace: 'fixture-symbolic', query: 'symbolicNeedle', strict_scope: false }, { caller: symbolicCaller })
    expect(result.isError).not.toBe(true)
    const value = payload(result)
    expect(value.memories.map((row: { id: string }) => row.id)).toEqual([root])
    const scope = enrichmentCall.mock.calls.at(-1)?.[4]
    expect(scope).toMatchObject({ project_path: 'fixture-symbolic' })
    expect(scope).not.toHaveProperty('namespace_subtree')
    expect(value.memories[0]).not.toHaveProperty('conflict_count')
    expect(value.memories[0]).not.toHaveProperty('supersedes_counts')
  })
})
