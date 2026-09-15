import { describe, it, expect, beforeEach } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { ensureNode, setNodeDigest } from '../src/namespace/tree.js'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
}

function parse<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T
}

async function storeAt(ns: string, content: string): Promise<void> {
  await handleTool('store_memory', { content, project_path: ns })
}

interface TraceEntry {
  namespace: string
  depth: number
  hits?: number
  action: 'searched' | 'skipped' | 'guide_only'
}

interface GuideEntry {
  namespace: string
  kind: string
  excerpt: string
}

function ancestorSet(path: string): Set<string> {
  // The tree ancestors of `path`, root-first (plus the node itself excluded).
  const root = path.startsWith('~') ? '~' : '/'
  const withoutRoot = path.slice(root.length)
  const segments = withoutRoot.split('/').filter((s) => s.length > 0)
  const out = new Set<string>([root])
  for (let i = 1; i < segments.length; i++) {
    out.add(root + segments.slice(0, i).join('/'))
  }
  return out
}

describe('get_context funnel retrieval', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('invariant 1: strict results only from the node\u2019s own namespace', async () => {
    const child = '/home/user/proj/child'
    await storeAt('/home/user/proj', 'zebra parent auth fact')
    await storeAt(child, 'zebra child auth fact')
    await storeAt('/home/user/other', 'zebra sibling auth fact')

    const result = parse<{ memories: Array<{ namespace: string }> }>(
      await handleTool('get_context', { namespace: child, query: 'zebra auth' })
    )

    expect(result.memories.length).toBeGreaterThan(0)
    for (const m of result.memories) {
      expect(m.namespace).toBe(child)
    }
  })

  it('invariant 4: strict_scope=false reaches descendants, never siblings', async () => {
    const parent = '/home/user/proj'
    await storeAt(parent, 'falcon parent note')
    await storeAt(`${parent}/child`, 'falcon child note')
    await storeAt(`${parent}/child/deep`, 'falcon grandchild note')
    await storeAt('/home/user/other', 'falcon sibling note')

    const result = parse<{ memories: Array<{ namespace: string }> }>(
      await handleTool('get_context', { namespace: parent, query: 'falcon', strict_scope: false })
    )

    const namespaces = new Set(result.memories.map((m) => m.namespace))
    expect(namespaces.has(parent)).toBe(true)
    expect(namespaces.has(`${parent}/child`)).toBe(true)
    expect(namespaces.has(`${parent}/child/deep`)).toBe(true)
    expect(namespaces.has('/home/user/other')).toBe(false)
  })

  it('invariant 2: ascent touches only ancestors, never siblings', async () => {
    const child = '/home/user/proj/child'
    await storeAt(child, 'unrelated leaf memory about potatoes')
    // Parent nav layer matches the query; leaf does not.
    ensureNode(globalDb(), child)
    setNodeDigest(globalDb(), '/home/user/proj', 'PBKDF2 rounds config lives here', null)

    const result = parse<{ scope_trace: TraceEntry[]; guide: GuideEntry[] }>(
      await handleTool('get_context', { namespace: child, query: 'pbkdf2' })
    )

    const allowed = ancestorSet(child)
    allowed.add(child)
    for (const entry of result.scope_trace) {
      expect(allowed.has(entry.namespace)).toBe(true)
    }
    for (const g of result.guide) {
      expect(allowed.has(g.namespace)).toBe(true)
    }
    // Leaf was thin (0 memory hits) so a parent digest guide hit propagated up.
    expect(result.guide.some((g) => g.kind === 'digest' && g.namespace === '/home/user/proj')).toBe(true)
  })

  it('invariant 3: non-path namespaces skip tree machinery (no scope_trace/guide)', async () => {
    await storeAt('autonomous-crypto-desk', 'non path namespace memory')

    const result = parse<Partial<{ scope_trace: unknown; guide: unknown }> & { memories: unknown[] }>(
      await handleTool('get_context', {
        namespace: 'autonomous-crypto-desk',
        query: 'non path namespace',
      })
    )

    expect(result.memories.length).toBeGreaterThan(0)
    expect(result.scope_trace).toBeUndefined()
    expect(result.guide).toBeUndefined()
  })

  it('invariant 5: scope_trace is deepest-first and ends at the depth-0 root', async () => {
    const child = '/home/user/proj/child'
    await storeAt(child, 'thin leaf with no matches for this query')

    const result = parse<{ scope_trace: TraceEntry[] }>(
      await handleTool('get_context', { namespace: child, query: 'nothing will match this' })
    )

    expect(result.scope_trace.length).toBeGreaterThan(1)
    expect(result.scope_trace[0].namespace).toBe(child)
    expect(result.scope_trace[0].action).toBe('searched')

    const depths = result.scope_trace.map((e) => e.depth)
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]).toBeLessThan(depths[i - 1])
    }
    expect(depths[depths.length - 1]).toBe(0)
  })

  it('skipped-ascend when the leaf is rich (>=K_MIN hits and >=THETA score)', async () => {
    const child = '/home/user/proj/child'
    await storeAt(child, 'keystone deployment uses blue green strategy')
    await storeAt(child, 'keystone deploy rollback is fast')
    await storeAt(child, 'keystone deploy requires migra check')

    const result = parse<{ scope_trace: TraceEntry[]; guide?: GuideEntry[] }>(
      await handleTool('get_context', { namespace: child, query: 'keystone deployment' })
    )

    expect(result.scope_trace[0].action).toBe('searched')
    expect(result.scope_trace[0].hits).toBeGreaterThanOrEqual(3)
    for (const entry of result.scope_trace.slice(1)) {
      expect(entry.action).toBe('skipped')
    }
    expect(result.guide).toBeUndefined()
  })

  it('thin leaf ascends and emits parent digest guide excerpts (<=240 chars)', async () => {
    const child = '/home/user/proj/child'
    await storeAt(child, 'leaf memory that will not match the query below')
    ensureNode(globalDb(), child)
    const longDigest = 'A'.repeat(600) + ' postgres vacuum tuning threshold'
    setNodeDigest(globalDb(), '/home/user/proj', longDigest, null)

    const result = parse<{ scope_trace: TraceEntry[]; guide: GuideEntry[] }>(
      await handleTool('get_context', { namespace: child, query: 'postgres vacuum' })
    )

    const digestGuides = result.guide.filter((g) => g.kind === 'digest')
    expect(digestGuides.length).toBeGreaterThan(0)
    for (const g of digestGuides) {
      expect(g.excerpt.length).toBeLessThanOrEqual(240)
      expect(g.excerpt.toLowerCase()).toContain('vacuum')
    }
    // The leaf yields no result for this query, so the parent is guide_only.
    expect(
      result.scope_trace.some((e) => e.namespace === '/home/user/proj' && e.action === 'guide_only')
    ).toBe(true)
  })

  it('invariant 4b: LIKE wildcards in namespaces cannot match sibling prefixes', async () => {
    // _ is a LIKE single-char wildcard; without ESCAPE, /proj_b would match
    // /projXb and leak the sibling's memories.
    await storeAt('/home/user/proj_b', 'underscore namespace secret about truffles')
    await storeAt('/home/user/projXb', 'sibling namespace note about truffles')

    const strict = parse<{ memories: Array<{ namespace: string }> }>(
      await handleTool('get_context', { namespace: '/home/user/proj_b', query: 'truffles' })
    )
    expect(strict.memories.length).toBe(1)
    expect(strict.memories[0].namespace).toBe('/home/user/proj_b')

    const subtree = parse<{ memories: Array<{ namespace: string }> }>(
      await handleTool('get_context', {
        namespace: '/home/user/proj_b',
        query: 'truffles',
        strict_scope: false,
      })
    )
    const namespaces = new Set(subtree.memories.map((m) => m.namespace))
    expect(namespaces.has('/home/user/projXb')).toBe(false)
    expect(namespaces.has('/home/user/proj_b')).toBe(true)
  })

  it('deepestKnownPrefix resolves tilde-root intermediate paths', async () => {
    const deep = '~/work/proj_a/inner'
    ensureNode(globalDb(), deep)
    // Intermediate tilde path must resolve (was ~proj_a before the slash fix).
    const result = parse<{ scope_trace: TraceEntry[] }>(
      await handleTool('get_context', { namespace: deep, query: 'anything' })
    )
    expect(result.scope_trace[0].namespace).toBe(deep)
  })
})


function globalDb() {
  return getDatabase().db
}
