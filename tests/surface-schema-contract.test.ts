import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { tools } from '../src/mcp/tools.js'
import { SCHEMAS } from '../src/mcp/schemas.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { MemoryStore } from '../src/memory/store.js'

// the schema a client is shown must be the schema the daemon accepts. drift this
// catches: `pinned` was honoured and validated but missing from store_memory's
// advertised properties, so a schema-validating client could not pin at all, and
// `compact_content` was advertised as the truncation opt-in while truncation was
// already the default and the flag never read.

const TEST_PROJECT = '/home/user/surface-contract'

interface Tool {
  name: string
  description: string
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] }
}

// accepted argument names. zod wraps a refined object such as GetRelatedSchema, so
// the shape can be one level down
function acceptedKeys(schema: z.ZodType): string[] {
  let current: unknown = schema
  for (let depth = 0; depth < 5 && current; depth++) {
    const candidate = current as { shape?: Record<string, unknown>; innerType?: () => unknown }
    if (candidate.shape) return Object.keys(candidate.shape)
    if (typeof candidate.innerType === 'function') {
      current = candidate.innerType()
      continue
    }
    break
  }
  throw new Error('could not read the accepted argument names from a tool schema')
}

function parse<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0].text) as T
}

describe('tool surface drift', () => {
  it('every advertised tool has a validating schema, and vice versa', () => {
    const advertised = tools.map((t) => t.name).sort()
    const validated = Object.keys(SCHEMAS).sort()
    expect(advertised).toEqual(validated)
  })

  it('advertised properties are exactly the accepted arguments, for every tool', () => {
    const mismatches: string[] = []
    for (const tool of tools as Tool[]) {
      const shown = Object.keys(tool.inputSchema.properties ?? {}).sort()
      const accepted = acceptedKeys(SCHEMAS[tool.name]).sort()
      const onlyAdvertised = shown.filter((k) => !accepted.includes(k))
      const onlyAccepted = accepted.filter((k) => !shown.includes(k))
      if (onlyAdvertised.length || onlyAccepted.length) {
        mismatches.push(
          `${tool.name}: advertised-only=[${onlyAdvertised}] accepted-only=[${onlyAccepted}]`
        )
      }
    }
    // a property a client is told to send but the validator drops, or an
    // argument the validator accepts but no client can discover, is invisible
    // to schema-validating clients: both directions are failures.
    expect(mismatches).toEqual([])
  })

  it('every required field is an advertised property', () => {
    for (const tool of tools as Tool[]) {
      for (const required of tool.inputSchema.required ?? []) {
        expect(
          Object.prototype.hasOwnProperty.call(tool.inputSchema.properties ?? {}, required),
          `${tool.name}.${required} is required but not advertised`
        ).toBe(true)
      }
    }
  })

  it('store_memory advertises pinned and the handler honours it', async () => {
    const tool = (tools as Tool[]).find((t) => t.name === 'store_memory')!
    expect(tool.inputSchema.properties.pinned).toBeDefined()

    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')

    const stored = parse<{ id: string; pinned: boolean; tier: string }>(
      await handleTool('store_memory', {
        content: 'concept memories are pinned',
        project_path: TEST_PROJECT,
        pinned: true,
      })
    )
    expect(stored.pinned).toBe(true)
    expect(stored.tier).toBe('pinned')

    const unadvertisedPolicy = parse<{ pinned: boolean }>(
      await handleTool('store_memory', {
        content: 'an ordinary note',
        project_path: TEST_PROJECT,
      })
    )
    expect(unadvertisedPolicy.pinned).toBe(false)
  })

  it('compact_content is accepted, is described truthfully, and never changes the query path', async () => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')

    const long = 'Rotation policy ' + 'x'.repeat(1000)
    await handleTool('store_memory', { content: long, project_path: TEST_PROJECT })

    const plain = parse<{ memories: Array<{ content: string }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT, query: 'rotation policy' })
    )
    const compact = parse<{ memories: Array<{ content: string }> }>(
      await handleTool('get_context', {
        project_path: TEST_PROJECT,
        query: 'rotation policy',
        compact_content: true,
      })
    )
    // truncation is the default, so the flag is a compatibility no-op, not an
    // opt-in. (Scores are excluded:
    // the query path touches access counters, which moves the recency/access
    // signals between calls.)
    expect(compact.memories.map((m) => m.content)).toEqual(plain.memories.map((m) => m.content))
    expect(compact.memories[0].content.length).toBeLessThan(long.length)
    expect(compact.memories[0].content.endsWith('…')).toBe(true)

    const full = parse<{ memories: Array<{ content: string }> }>(
      await handleTool('get_context', {
        project_path: TEST_PROJECT,
        query: 'rotation policy',
        full_content: true,
      })
    )
    expect(full.memories[0].content).toBe(long)

    const tool = (tools as Tool[]).find((t) => t.name === 'get_context')!
    const described = (tool.inputSchema.properties.compact_content as { description: string })
      .description
    expect(described).toMatch(/ALREADY the query-path default/)
  })

  it('surfaces a write-time duplicate signal when the store provides one', async () => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')

    const original = MemoryStore.prototype.store
    MemoryStore.prototype.store = async function patched(input) {
      const memory = await original.call(this, input)
      return Object.assign(memory, { possible_duplicates: [{ id: 'dup-1', similarity: 0.99 }] })
    }
    try {
      const withDuplicates = parse<{ possible_duplicates?: unknown[] }>(
        await handleTool('store_memory', { content: 'duplicated fact', project_path: TEST_PROJECT })
      )
      expect(withDuplicates.possible_duplicates).toEqual([{ id: 'dup-1', similarity: 0.99 }])
    } finally {
      MemoryStore.prototype.store = original
    }

    // absent duplicate detection, which a store may simply not return, must not
    // invent it or fail the write.
    const withoutDuplicates = parse<{ id: string; possible_duplicates?: unknown[] }>(
      await handleTool('store_memory', { content: 'unique fact', project_path: TEST_PROJECT })
    )
    expect(withoutDuplicates.id).toBeTruthy()
    expect(withoutDuplicates.possible_duplicates).toBeUndefined()
  })
})

describe('store_memory refusal shape', () => {
  it('comes back as a payload the agent can act on, not a tool failure', async () => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')

    const result = await handleTool('store_memory', {
      // assembled at runtime so no provider-shaped literal lands in the source
      content: `push the branch with ${['gh', 'p_', '0123456789abcdefghijklmnopqrstuvwxyz'].join('')}`,
      project_path: TEST_PROJECT,
    })

    // a refusal is an answer, not a broken tool: isError would read as failure
    // and the reason/hint that tell the agent what to do instead would be lost.
    expect(result.isError).toBeUndefined()
    const refused = parse<{ status: string; reason: string; hint: string; rule: string }>(result)
    expect(refused.status).toBe('rejected')
    expect(refused.rule).toBe('secrets')
    expect(refused.reason).toBeTruthy()
    expect(refused.hint).toBeTruthy()
  })
})

describe('tool annotation honesty', () => {
  it('list_sessions is not marked read-only (it ends idle sessions)', () => {
    const tool = (tools as Tool[]).find((t) => t.name === 'list_sessions')!
    const annotations = (tool as unknown as { annotations: { readOnlyHint: boolean } }).annotations
    expect(annotations.readOnlyHint).toBe(false)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
