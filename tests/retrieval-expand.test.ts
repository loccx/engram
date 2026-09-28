import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'

const mockState = vi.hoisted(() => ({
  llmConfigured: false,
  llmJson: null as unknown,
  llmThrows: false,
  chatCalls: 0,
  fetchCalls: 0,
}))

vi.mock('../src/llm/client.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    isLlmConfigured: () => mockState.llmConfigured,
    chatJson: vi.fn(async () => {
      mockState.chatCalls += 1
      if (mockState.llmThrows) throw new Error('llm exploded')
      return { data: mockState.llmJson, raw: { content: '{}' } }
    }),
  }
})

import { createTestDb } from './helpers.js'
import {
  expandQuery,
  expandQueryDeterministic,
  DEFAULT_MAX_VARIANTS,
} from '../src/memory/search/expand.js'
import { MemorySearch } from '../src/memory/search.js'
import type { SearchDiagnostics } from '../src/memory/search/hybrid.js'

const NS = '/proj/expand'
const SESSION = 'expand-session'

function seedMemories(db: Database.Database, contents: string[]): string[] {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    SESSION,
    NS,
    Date.now()
  )
  const stmt = db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags,
       created_at, valid_from, access_count)
     VALUES (?, ?, ?, ?, ?, 'note', 0.5, '[]', ?, ?, 0)`
  )
  return contents.map((content, i) => {
    const id = `e${String(i).padStart(3, '0')}`
    const now = Date.now()
    stmt.run(id, SESSION, NS, NS, content, now, now)
    return id
  })
}

describe('expandQuery deterministic tier', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', () => {
      mockState.fetchCalls += 1
      throw new Error('network access in the deterministic tier')
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('splits camelCase, snake_case, kebab and dotted identifiers', () => {
    expect(expandQueryDeterministic('hybridSearch fusion')).toContain('hybrid Search fusion')
    expect(expandQueryDeterministic('memory_vectors table')).toContain('memory vectors table')
    expect(expandQueryDeterministic('rerank-blend config')).toContain('rerank blend config')
    expect(expandQueryDeterministic('src.memory.search')).toContain('src memory search')
  })

  it('adds a quoted-phrase variant for multi-token queries', () => {
    expect(expandQueryDeterministic('retrieval quality')).toContain('"retrieval quality"')
    expect(expandQueryDeterministic('retrieval')).not.toContain('"retrieval"')
  })

  it('extracts rare tokens by structure and length', () => {
    const variants = expandQueryDeterministic('how does the memory_vectors knn query behave')
    expect(variants).toContain('memory_vectors')
  })

  it('never returns the original query and never duplicates a variant', () => {
    for (const q of [
      'hybridSearch',
      'retrieval quality',
      'memory_vectors knn',
      'a b c d',
      'how do I make the search better',
    ]) {
      const variants = expandQueryDeterministic(q)
      expect(variants.length).toBeLessThanOrEqual(DEFAULT_MAX_VARIANTS)
      expect(new Set(variants.map((v) => v.toLowerCase())).size).toBe(variants.length)
      expect(variants).not.toContain(q)
      expect(variants.every((v) => v.trim().length > 0)).toBe(true)
    }
  })

  it('respects maxVariants and returns [] for an empty query', () => {
    expect(expandQueryDeterministic('memory_vectors knn hybridSearch', 1)).toHaveLength(1)
    expect(expandQueryDeterministic('memory_vectors knn hybridSearch', 0)).toEqual([])
    expect(expandQueryDeterministic('   ')).toEqual([])
  })

  it('is deterministic across calls and makes no network call when the LLM tier is off', async () => {
    mockState.llmConfigured = true // configured, but useLlm is false
    const first = await expandQuery('memory_vectors knn hybridSearch')
    const second = await expandQuery('memory_vectors knn hybridSearch')
    expect(first).toEqual(second)
    expect(first).toEqual(expandQueryDeterministic('memory_vectors knn hybridSearch'))
    expect(mockState.chatCalls).toBe(0)
    expect(mockState.fetchCalls).toBe(0)
  })
})

describe('expandQuery LLM tier', () => {
  beforeEach(() => {
    mockState.llmConfigured = false
    mockState.llmJson = null
    mockState.llmThrows = false
    mockState.chatCalls = 0
  })

  it('runs the deterministic tier alone when the LLM is not configured', async () => {
    const variants = await expandQuery('memory_vectors knn', { useLlm: true })
    expect(variants).toEqual(expandQueryDeterministic('memory_vectors knn'))
    expect(mockState.chatCalls).toBe(0)
  })

  it('appends the hypothetical answer and sub-queries when configured', async () => {
    mockState.llmConfigured = true
    mockState.llmJson = {
      hypothetical: 'vec0 pushes the rowid set into the KNN scan',
      sub_queries: ['scoped knn rowid filter', 'sqlite-vec prefilter'],
    }
    const variants = await expandQuery('memory_vectors knn', { useLlm: true })
    expect(mockState.chatCalls).toBe(1)
    expect(variants).toContain('vec0 pushes the rowid set into the KNN scan')
    expect(variants.indexOf('vec0 pushes the rowid set into the KNN scan')).toBeGreaterThan(0)
    expect(variants).toHaveLength(DEFAULT_MAX_VARIANTS)
  })

  it('caps the combined variant list at maxVariants', async () => {
    mockState.llmConfigured = true
    mockState.llmJson = { hypothetical: 'h1', sub_queries: ['s1', 's2', 's3'] }
    const variants = await expandQuery('memory_vectors knn', { useLlm: true, maxVariants: 2 })
    expect(variants).toHaveLength(2)
  })

  it('never throws when the LLM fails, and degrades to the deterministic tier', async () => {
    mockState.llmConfigured = true
    mockState.llmThrows = true
    const variants = await expandQuery('memory_vectors knn', { useLlm: true })
    expect(variants).toEqual(expandQueryDeterministic('memory_vectors knn'))
  })

  it('ignores malformed LLM payloads', async () => {
    mockState.llmConfigured = true
    mockState.llmJson = { hypothetical: 42, sub_queries: 'not-an-array' }
    const variants = await expandQuery('memory_vectors knn', { useLlm: true })
    expect(variants).toEqual(expandQueryDeterministic('memory_vectors knn'))
  })

  it('a failing LLM never surfaces as a search failure', async () => {
    mockState.llmConfigured = true
    mockState.llmThrows = true
    const db = createTestDb().db
    seedMemories(db, ['memory_vectors knn notes'])
    const search = new MemorySearch(db, false)
    const diagnostics: SearchDiagnostics = { degraded: [] }
    const results = await search.hybridSearch('memory_vectors knn', {
      project_path: NS,
      touch: false,
      expand: true,
      expand_use_llm: true,
      diagnostics,
    })
    expect(results.length).toBeGreaterThan(0)
    expect(diagnostics.degraded).toEqual([])
  })
})

describe('expansion wiring', () => {
  let db: Database.Database
  let splitOnly: string

  beforeEach(() => {
    db = createTestDb().db
    const [_compound, split] = seedMemories(db, [
      'the hybridSearch entry point fuses the lists',
      'the hybrid search entry point fuses the lists',
    ])
    splitOnly = split
  })

  it('adds the expansion variants as extra lists only when expand is set', async () => {
    const search = new MemorySearch(db, false)
    const withoutExpand = await search.hybridSearch('hybridSearch', {
      project_path: NS,
      touch: false,
      limit: 10,
    })
    const withExpand = await search.hybridSearch('hybridSearch', {
      project_path: NS,
      touch: false,
      limit: 10,
      expand: true,
    })
    expect(withoutExpand.map((r) => r.id)).not.toContain(splitOnly)
    expect(withExpand.map((r) => r.id)).toContain(splitOnly)
  })

  it('reports a failing expander instead of failing the search', async () => {
    const expandMod = await import('../src/memory/search/expand.js')
    const spy = vi.spyOn(expandMod, 'expandQuery').mockRejectedValueOnce(new Error('boom'))
    try {
      const search = new MemorySearch(db, false)
      const diagnostics: SearchDiagnostics = { degraded: [] }
      const results = await search.hybridSearch('hybridSearch entry', {
        project_path: NS,
        touch: false,
        expand: true,
        diagnostics,
      })
      expect(results.length).toBeGreaterThan(0)
      expect(diagnostics.degraded).toContain('expansion')
    } finally {
      spy.mockRestore()
    }
  })
})
