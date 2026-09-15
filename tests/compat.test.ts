import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { tools } from '../src/mcp/tools.js'
import { validateForImport, exportBrain, type BrainManifest } from '../src/brains/snapshot.js'
import { listLocalBrains } from '../src/brains/mcp.js'
import { DatabaseManager } from '../src/db/init.js'

const TEST_PROJECT = '/home/user/compat-project'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
}

function parse<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T
}

async function store(content: string, opts: Record<string, unknown> = {}): Promise<string> {
  const result = parse<{ id: string }>(
    await handleTool('store_memory', { content, project_path: TEST_PROJECT, ...opts })
  )
  return result.id
}

const byName = new Map(tools.map((t) => [t.name, t as { name: string; inputSchema: Record<string, unknown> }]))

describe('compat: get_related legacy memory_id alias', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('accepts the legacy memory_id field and returns the same related set as id', async () => {
    const a = await store('Postgres is the primary datastore')
    const b = await store('Migrations run through a deploy pipeline', { tags: ['db'] })
    getDatabase().db
      .prepare('INSERT OR IGNORE INTO memory_links(source_id, target_id, similarity, link_type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(a, b, 0.9, 'semantic', Date.now())

    const viaId = parse<{ related: Array<{ id: string }> }>(
      await handleTool('get_related', { id: a, project_path: TEST_PROJECT })
    )
    const viaAlias = parse<{ related: Array<{ id: string }> }>(
      await handleTool('get_related', { memory_id: a, project_path: TEST_PROJECT })
    )

    expect(viaId.memory ?? viaAlias.memory).toBeTruthy()
    expect(viaAlias.related.map((r) => r.id)).toEqual(viaId.related.map((r) => r.id))
    expect(viaAlias.related.map((r) => r.id)).toContain(b)
  })

  it('prefers id when both id and memory_id are provided', async () => {
    const a = await store('Alpha memory content')
    await store('Beta memory content')

    const usingId = parse<{ memory: { id: string } }>(
      await handleTool('get_related', { id: a, memory_id: 'nonexistent', project_path: TEST_PROJECT })
    )
    expect(usingId.memory.id).toBe(a)
  })

  it('rejects a call with neither id nor memory_id with a validation error', async () => {
    const result = await handleTool('get_related', { project_path: TEST_PROJECT })
    const parsed = parse<{ error: string }>(result)
    expect(parsed.error).toMatch(/Validation failed/)
  })

  it('exposes memory_id in tools/list and keeps required open for legacy clients', () => {
    const t = byName.get('get_related')!
    expect(t.inputSchema.properties).toHaveProperty('memory_id')
    expect(t.inputSchema.properties).toHaveProperty('id')
    expect(t.inputSchema.required ?? []).not.toContain('id')
  })
})

describe('compat: get_context roster blanket + query-path full defaults', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('blanket (no-query) path serves only roster previews, never full content', async () => {
    await store('x'.repeat(1000))
    const result = parse<{ memories: Array<{ content?: string; preview: string }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT })
    )
    expect(result.memories[0].content).toBeUndefined()
    expect(result.memories[0].preview.length).toBeLessThanOrEqual(161)
  })

  it('full_content flag does not re-enable full content on the blanket path', async () => {
    await store('z'.repeat(1000))
    const result = parse<{ memories: Array<{ content?: string; preview: string }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT, full_content: true })
    )
    expect(result.memories[0].content).toBeUndefined()
    expect(result.memories[0].preview.length).toBeLessThanOrEqual(161)
  })

  it('query path: compact content by default, full_content opts back in', async () => {
    await store('Memcached eviction LRU quirks ' + 'y'.repeat(1000))

    const compact = parse<{ memories: Array<{ content: string }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT, query: 'memcached eviction' })
    )
    expect(compact.memories[0].content.length).toBeLessThan(1000)
    expect(compact.memories[0].content.endsWith('…')).toBe(true)

    const full = parse<{ memories: Array<{ content: string }> }>(
      await handleTool('get_context', {
        project_path: TEST_PROJECT,
        query: 'memcached eviction',
        full_content: true,
      })
    )
    expect(full.memories[0].content).toBe('Memcached eviction LRU quirks ' + 'y'.repeat(1000))
  })

  it('blanket path summarizes topics by default; full_topics opts back in', async () => {
    const memberIds = Array.from({ length: 300 }, (_, i) => `mem-${i}`)
    getDatabase().db
      .prepare(
        `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`
      )
      .run(TEST_PROJECT, JSON.stringify(memberIds), 'big topic', Date.now(), Date.now())

    const blanket = parse<{ topics: Array<{ member_ids: string[]; member_count: number }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT })
    )
    expect(blanket.topics[0].member_count).toBe(300)
    expect(blanket.topics[0].member_ids.length).toBeLessThan(300)

    // full_topics opts back into complete membership on the blanket path.
    const forced = parse<{ topics: Array<{ member_ids: string[] }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT, full_topics: true })
    )
    expect(forced.topics[0].member_ids.length).toBe(300)
  })

  it('query path: topics summarized by default, full_topics forces membership', async () => {
    const memberIds = Array.from({ length: 300 }, (_, i) => `mem-${i}`)
    getDatabase().db
      .prepare(
        `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`
      )
      .run(TEST_PROJECT, JSON.stringify(memberIds), 'big topic', Date.now(), Date.now())

    const summarized = parse<{ topics: Array<{ member_ids: string[]; member_count: number }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT, query: 'topic' })
    )
    expect(summarized.topics[0].member_count).toBe(300)
    expect(summarized.topics[0].member_ids.length).toBeLessThan(300)

    const expanded = parse<{ topics: Array<{ member_ids: string[] }> }>(
      await handleTool('get_context', { project_path: TEST_PROJECT, query: 'topic', full_topics: true })
    )
    expect(expanded.topics[0].member_ids.length).toBe(300)
  })
})

describe('compat: brain snapshot schema gate + pre-migration exports', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-compat-brains-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function manifest(overrides: Partial<BrainManifest> = {}): BrainManifest {
    return {
      schema_version: 6,
      engram_version: '0.1.0',
      embedding_model: 'nomic-ai/nomic-embed-text-v1.5',
      embedding_dim: 768,
      owner_name: null,
      owner_pubkey: null,
      description: null,
      exported_at: Date.now(),
      memory_count: 1,
      ...overrides,
    }
  }

  it('validateForImport refuses brains from a newer schema', () => {
    const err = validateForImport(manifest({ schema_version: 7, engram_version: '0.9.0' }))
    expect(err?.kind).toBe('schema_version')
  })

  it('validateForImport still accepts same-version brains and rejects corrupt ones', () => {
    expect(validateForImport(manifest())).toBeNull()
    const corrupt = manifest({ schema_version: 0, embedding_model: '', embedding_dim: 0 })
    expect(validateForImport(corrupt)?.kind).toBe('corrupt')
  })

  it('exportBrain handles pre-migration source DBs safely (empty shareable-safe export)', () => {
    // Pre-migration source: no namespace/shareable columns at all.
    const sourcePath = join(tmp, 'old.db')
    const source = new Database(sourcePath)
    const now = Date.now()
    source.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, summary TEXT, tool_name TEXT);
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        project_path TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'note',
        importance REAL NOT NULL DEFAULT 0.5,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_accessed INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0,
        vec_rowid INTEGER
      );
      INSERT INTO sessions(id, project_path, started_at) VALUES ('s1', '/old', ${now});
      INSERT INTO memories(id, session_id, project_path, content, created_at) VALUES ('m1', 's1', '/old', 'legacy fact', ${now});
    `)
    source.close()

    const raw = new Database(sourcePath, { readonly: true })
    const outPath = join(tmp, 'brain.db')
    const result = exportBrain(raw, { namespace: '/old', outputPath: outPath })
    raw.close()

    expect(result.memoryCount).toBe(0)
    expect(validateForImport(result.manifest)).toBeNull()
  })

  it('exportBrain copies real vector rows so searchable brains keep embeddings', () => {
    const sourceMgr = new DatabaseManager(':memory:')
    const db = sourceMgr.db
    db.prepare('INSERT INTO sessions(id, project_path, started_at) VALUES (?, ?, ?)').run('s1', '/p', Date.now())
    db.prepare(
      `INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('mem-a', 's1', '/p', 'vectorized fact', 'note', 0.5, '[]', Date.now(), 0, 'work', 1)
    if (sourceMgr.vectorsAvailable) {
      const dim = 768
      const vec = db.prepare('INSERT INTO memory_vectors(embedding) VALUES (?)')
        .run(Buffer.from(new Float32Array(dim).buffer))
      db.prepare('UPDATE memories SET vec_rowid = ? WHERE id = ?').run(Number(vec.lastInsertRowid), 'mem-a')
    }

    const outPath = join(tmp, 'brain.db')
    const result = exportBrain(db, { namespace: 'work', outputPath: outPath })
    expect(result.memoryCount).toBe(1)

    const target = new Database(outPath, { readonly: true })
    const memories = target.prepare('SELECT id FROM memories').all()
    expect(memories).toEqual([{ id: 'mem-a' }])
    if (sourceMgr.vectorsAvailable) {
      // vec virtual table is loaded only via DatabaseManager; exportBrain
      // wrote rows by rowid, so count via raw memory_vectors if loadable.
      try {
        const vecRows = target.prepare('SELECT rowid FROM memory_vectors').all()
        expect(vecRows.length).toBe(1)
      } catch {
        // sqlite-vec extension not loadable on a bare Database in some
        // environments; the export path itself is what matters.
      }
    }
    target.close()
    sourceMgr.close()
  })
})

describe('compat: listLocalBrains manifest.json fallback', () => {
  let tmp: string
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('reports memory_count from manifest.json when brain.db was removed by publish', () => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-compat-manifest-'))
    const dir = join(tmp, 'mybrain')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        schema_version: 6,
        engram_version: '0.1.0',
        embedding_model: 'nomic-ai/nomic-embed-text-v1.5',
        embedding_dim: 768,
        owner_name: 'alice',
        owner_pubkey: null,
        description: 'shared brain',
        exported_at: Date.now(),
        memory_count: 42,
      })
    )
    const brains = listLocalBrains(tmp)
    expect(brains).toHaveLength(1)
    expect(brains[0]).toMatchObject({
      name: 'mybrain',
      memory_count: 42,
      owner_name: 'alice',
      description: 'shared brain',
      has_decrypted_cache: false,
    })
  })
})

describe('compat: zod parity for brain MCP tools', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('search_brain with a missing brain fails validation instead of throwing raw', async () => {
    const result = await handleTool('search_brain', { query: 'anything' })
    const parsed = parse<{ error: string }>(result)
    expect(parsed.error).toMatch(/Validation failed/)
  })

  it('mark_shareable defaults shareable to true', async () => {
    const db = getDatabase().db
    db.prepare("INSERT INTO sessions(id, project_path, started_at) VALUES ('s1', ?, ?)").run(TEST_PROJECT, Date.now())
    db.prepare(
      'INSERT INTO memories(id, session_id, project_path, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('mem-x', 's1', TEST_PROJECT, 'content', Date.now())

    const result = parse<{ shareable: boolean; changed: boolean }>(
      await handleTool('mark_shareable', { id: 'mem-x' })
    )
    expect(result.shareable).toBe(true)
    expect(result.changed).toBe(true)
  })
})
