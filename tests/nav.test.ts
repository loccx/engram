import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { resetLlmConfigForTests } from '../src/llm/client.js'
import { refreshNavDigest, childRoster, NAV_DIGEST_BUDGET_CHARS } from '../src/memory/nav.js'

const NS = '/work/proj'

// The tree lane owns migration 010; until it lands we materialize the spec DDL
// inline (idempotent either way — the migration uses the same IF NOT EXISTS).
function ensureNamespaceNodesTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS namespace_nodes (
    path TEXT PRIMARY KEY,
    parent_path TEXT,
    depth INTEGER NOT NULL,
    is_synthetic INTEGER NOT NULL DEFAULT 0,
    real_path TEXT,
    digest TEXT,
    digest_source_hash TEXT,
    memory_count INTEGER NOT NULL DEFAULT 0,
    child_count INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER,
    updated_at INTEGER NOT NULL
  )`)
}

function insertNode(
  db: Database.Database,
  path: string,
  opts: {
    parentPath?: string | null
    memoryCount?: number
    childCount?: number
    digest?: string | null
    sourceHash?: string | null
  } = {}
): void {
  db.prepare(
    `INSERT INTO namespace_nodes
       (path, parent_path, depth, is_synthetic, real_path, digest, digest_source_hash,
        memory_count, child_count, last_activity_at, updated_at)
     VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, NULL, ?)`
  ).run(
    path,
    opts.parentPath ?? null,
    path.split('/').filter(Boolean).length,
    opts.digest ?? null,
    opts.sourceHash ?? null,
    opts.memoryCount ?? 0,
    opts.childCount ?? 0,
    Math.floor(Date.now() / 1000)
  )
}

function seedSources(db: Database.Database): void {
  db.prepare(
    `INSERT OR REPLACE INTO project_digests (namespace, content, source_hash, updated_at)
     VALUES (?, ?, NULL, ?)`
  ).run(NS, 'Deploy must run from the release branch\nKeep secrets out of git', Math.floor(Date.now() / 1000))

  db.prepare(
    `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`
  ).run(NS, JSON.stringify(['m1', 'm2']), 'Auth flows use OIDC with PKCE', Date.now() - 1000, Date.now())
  db.prepare(
    `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`
  ).run(NS, JSON.stringify(['m3']), '', Date.now() - 500, Date.now() - 500) // empty summary filtered out

  insertNode(db, NS, { memoryCount: 10 })
  insertNode(db, `${NS}/api`, { parentPath: NS, memoryCount: 9, digest: 'API client conventions and retry policy' })
  insertNode(db, `${NS}/ui`, { parentPath: NS, memoryCount: 7, digest: '' })
  insertNode(db, `${NS}/db`, { parentPath: NS, memoryCount: 5, digest: 'SQLite WAL mode notes' })
  insertNode(db, '/work/proj-sib', { memoryCount: 3 }) // not a child of NS
}

function configureLlm(): void {
  process.env.ENGRAM_LLM_BASE_URL = 'https://gw.test/v1'
  process.env.ENGRAM_LLM_API_KEY = 'test-key'
  process.env.ENGRAM_LLM_MODEL = 'gpt-test'
  resetLlmConfigForTests()
}

function clearLlm(): void {
  delete process.env.ENGRAM_LLM_BASE_URL
  delete process.env.ENGRAM_LLM_API_KEY
  delete process.env.ENGRAM_LLM_MODEL
  resetLlmConfigForTests()
}

function chatResponse(content: string, model = 'gpt-test'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

function nodeDigest(db: Database.Database, path: string): { digest: string | null; sourceHash: string | null } {
  const row = db
    .prepare('SELECT digest, digest_source_hash FROM namespace_nodes WHERE path = ?')
    .get(path) as { digest: string | null; digest_source_hash: string | null } | undefined
  return { digest: row?.digest ?? null, sourceHash: row?.sourceHash ?? row?.digest_source_hash ?? null }
}

describe('nav: thin navigation layer', () => {
  let db: Database.Database

  beforeEach(() => {
    const created = createTestDb()
    db = created.db
    ensureNamespaceNodesTable(db)
    clearLlm()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearLlm()
  })

  it('exports the spec budget constant', () => {
    expect(NAV_DIGEST_BUDGET_CHARS).toBe(1200)
  })

  it('extractive digest includes pinned lines, topic summaries, and child lines, deterministically', async () => {
    seedSources(db)

    const first = await refreshNavDigest(db, NS)
    const second = await refreshNavDigest(db, NS)

    expect(first.changed).toBe(true)
    expect(first.content).toContain('Deploy must run from the release branch')
    expect(first.content).toContain('Keep secrets out of git')
    expect(first.content).toContain('[topic] Auth flows use OIDC with PKCE')
    expect(first.content).toContain('[child /work/proj/api] API client conventions and retry policy')
    expect(first.content).toContain('[child /work/proj/ui] (no digest yet)')
    expect(first.content).not.toContain('proj-sib')

    expect(second.content).toBe(first.content)
    expect(second.changed).toBe(false)
  })

  it('skips the write when the source hash is unchanged', async () => {
    seedSources(db)
    const first = await refreshNavDigest(db, NS)
    expect(first.changed).toBe(true)

    db.prepare('UPDATE namespace_nodes SET digest = ? WHERE path = ?').run('SENTINEL', NS)
    const second = await refreshNavDigest(db, NS)

    expect(second.changed).toBe(false)
    expect(second.content).toBe('SENTINEL') // returned cached, wrote nothing
    expect(nodeDigest(db, NS).digest).toBe('SENTINEL')
  })

  it('packs extractive content within a tight budget', async () => {
    seedSources(db)

    const result = await refreshNavDigest(db, NS, { budgetChars: 120 })

    expect(result.content.length).toBeLessThanOrEqual(120)
    expect(result.content).toContain('…(')
  })

  it('uses the LLM to condense when configured and the source overflows the budget', async () => {
    seedSources(db)
    configureLlm()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(chatResponse('CONDENSED DIGEST'))

    const result = await refreshNavDigest(db, NS, { budgetChars: 120 })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.content).toBe('CONDENSED DIGEST')
    expect(nodeDigest(db, NS).digest).toBe('CONDENSED DIGEST')
  })

  it('falls back to extractive packing when the LLM call fails', async () => {
    seedSources(db)
    configureLlm()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

    const result = await refreshNavDigest(db, NS, { budgetChars: 120 })

    expect(result.changed).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(120)
    expect(result.content).toContain('Deploy must run from the release branch')
  })

  it('stamps updated_at in milliseconds, matching tree.ts (not seconds)', async () => {
    seedSources(db) // inserts NS with no digest, so refreshNavDigest writes one

    await refreshNavDigest(db, NS)

    const row = db
      .prepare('SELECT updated_at FROM namespace_nodes WHERE path = ?')
      .get(NS) as { updated_at: number }
    // A seconds-based stamp (~1.7e9) would fail this; tree.ts writes ms.
    expect(row.updated_at).toBeGreaterThan(1_000_000_000_000)
    expect(Math.abs(Date.now() - row.updated_at)).toBeLessThan(60_000)
  })

  it('is a no-op when the node row does not exist (tree.ensureNode owns creation)', async () => {
    seedSources(db)

    const result = await refreshNavDigest(db, '/work/ghost')

    expect(result).toEqual({ content: '', changed: false })
    const rows = db.prepare('SELECT COUNT(*) AS n FROM namespace_nodes WHERE path = ?').get('/work/ghost') as { n: number }
    expect(rows.n).toBe(0)
  })

  describe('childRoster', () => {
    it('orders by memory_count desc, tolerates empty digests, excludes non-children', () => {
      seedSources(db)

      const roster = childRoster(db, NS)

      expect(roster.map((r) => r.path)).toEqual([`${NS}/api`, `${NS}/ui`, `${NS}/db`])
      expect(roster[0].digest).toBe('API client conventions and retry policy')
      expect(roster[1].digest).toBe('') // empty digest still listed
      expect(roster.some((r) => r.path === '/work/proj-sib')).toBe(false)
    })

    it('caps at 12 entries', () => {
      seedSources(db)
      for (let i = 0; i < 14; i++) {
        insertNode(db, `${NS}/gen-${i}`, { parentPath: NS, memoryCount: i, digest: `digest ${i}` })
      }

      const roster = childRoster(db, NS)

      expect(roster.length).toBe(12)
      expect(roster.every((r) => r.path.startsWith(`${NS}/`))).toBe(true)
    })
  })
})
