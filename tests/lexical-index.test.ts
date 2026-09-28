import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { DatabaseManager } from '../src/db/init.js'
import { runMigrations } from '../src/db/migrations/runner.js'
import { migrations } from '../src/db/migrations/index.js'
import { migration012 } from '../src/db/migrations/012_identifier_lexical_index.js'
import { migration015 } from '../src/db/migrations/015_ident_text_columns.js'
import {
  MEMORIES_IDENT_FTS,
  MEMORY_ENTITY_FTS,
  identNormalizeSql,
  lexicalIdentColumnDdl,
  lexicalIndexDdl,
  lexicalIndexReady,
  normalizeIdentifiers,
} from '../src/db/lexical-index.js'
import { backfillLexicalIndex } from '../src/db/workers/lexical-backfill.js'
import { identSearch } from '../src/memory/search/lexical.js'
import { ftsSearch } from '../src/memory/search/hybrid.js'

const PROJECT = '/work/engram'
const CHILD = '/work/engram/packages/api'

// minimal 011-era schema so migrations 001-011 can run
const BASELINE_FIXTURE = `
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
  CREATE TABLE memory_links (
    source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    similarity REAL NOT NULL,
    link_type TEXT NOT NULL DEFAULT 'semantic',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, target_id)
  );
`

function seedMemory(
  db: Database.Database,
  id: string,
  content: string,
  opts: {
    namespace?: string | null
    tags?: string[]
    createdAt?: number
    validFrom?: number
    validUntil?: number | null
  } = {}
): void {
  const now = opts.createdAt ?? 100
  const namespace = opts.namespace === undefined ? PROJECT : opts.namespace
  const tags = JSON.stringify(opts.tags ?? [])
  db.prepare("INSERT OR IGNORE INTO sessions(id, project_path, started_at) VALUES ('s1', ?, ?)").run(PROJECT, now)
  // ident_text is written by the caller, as every write path does since 015;
  // the trigger only copies the column
  db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, valid_until, ident_text)
     VALUES (?, 's1', ?, ?, ?, 'note', 0.5, ?, ?, ?, ?, ?)`
  ).run(
    id,
    PROJECT,
    namespace,
    content,
    tags,
    now,
    opts.validFrom ?? now,
    opts.validUntil ?? null,
    normalizeIdentifiers(`${content} ${tags}`)
  )
}

function identRow(db: Database.Database, id: string): string | undefined {
  const row = db
    .prepare(
      `SELECT f.ident AS ident FROM ${MEMORIES_IDENT_FTS} f JOIN memories m ON m.rowid = f.rowid WHERE m.id = ?`
    )
    .get(id) as { ident: string } | undefined
  return row?.ident
}

function countIdent(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${MEMORIES_IDENT_FTS}`).get() as { n: number }).n
}

describe('identifier normalisation', () => {
  const cases: Array<[string, string]> = [
    ['hybridSearch', 'hybrid search hybridsearch'],
    ['hybrid_search', 'hybrid search hybridsearch'],
    ['_autoLink', 'auto link autolink'],
    ['pprSearch(db, seeds)', 'ppr search db seeds pprsearch db seeds'],
    ['src/memory/search/hybrid.ts', 'src memory search hybrid ts src memory search hybrid ts'],
    ['HTTPServer', 'http server httpserver'],
    ['memory_entities', 'memory entities memoryentities'],
    ['graph.ts:17-80', 'graph ts 17 80 graph ts 1780'],
    ['already lower', 'already lower already lower'],
    ['  padded  ', 'padded padded'],
    ['ABCdef', 'ab cdef abcdef'],
    ['[WARN] e2e no-op', 'warn e2e no op warn e2e noop'],
    ['', ''],
  ]

  it('normalises camelCase, snake_case, acronyms and paths (JS implementation)', () => {
    for (const [input, expected] of cases) {
      expect(normalizeIdentifiers(input), input).toBe(expected)
    }
  })

  it('the SQL implementation used by the triggers agrees with the JS one character-for-character', () => {
    const db = new Database(':memory:')
    const stmt = db.prepare(`SELECT ${identNormalizeSql('?')} AS v`)
    const corpus: Array<string | null> = [
      ...cases.map(([input]) => input),
      'const stmtInsertEntity = db.prepare(SQL) // hybridSearch',
      'Error: SQLITE_BUSY at src/db/init.ts:61',
      'namespace_subtree + project_path (namespace//scope)',
      'UPPER',
      'a',
      '1',
      '-_-',
      'trailing separator ',
      null,
    ]
    for (const input of corpus) {
      const sql = (stmt.get(input) as { v: string }).v
      expect(sql, JSON.stringify(input)).toBe(normalizeIdentifiers(input))
    }
    db.close()
  })
})

describe('migration 012', () => {
  const managers: DatabaseManager[] = []
  afterEach(() => {
    while (managers.length) managers.pop()!.close()
  })

  it('applies 012 and records it in the migration ledger', () => {
    // a gap is legitimate: a reserved version can land after a higher one
    const versions = migrations.map((m) => m.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions).toContain(12)
    const mgr = new DatabaseManager(':memory:')
    managers.push(mgr)
    const userVersion = (mgr.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(userVersion).toBeGreaterThanOrEqual(12)
    expect(lexicalIndexReady(mgr.db)).toBe(true)
  })

  it('creates the identifier index and its triggers on a fresh database', () => {
    const mgr = new DatabaseManager(':memory:')
    managers.push(mgr)
    const triggers = mgr.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'memories_ident_fts_%' OR name LIKE 'memory_entity_fts_%')"
      )
      .all() as Array<{ name: string }>
    expect(triggers.map((t) => t.name).sort()).toEqual([
      'memories_ident_fts_delete',
      'memories_ident_fts_insert',
      'memories_ident_fts_update',
      'memory_entity_fts_delete',
      'memory_entity_fts_insert',
      'memory_entity_fts_update',
    ])

    seedMemory(mgr.db, 'm1', 'calls hybridSearch', { tags: ['retrieval'] })
    expect(identRow(mgr.db, 'm1')).toBe(normalizeIdentifiers('calls hybridSearch ["retrieval"]'))
    expect(identRow(mgr.db, 'm1')).toContain('retrieval')

    // since 015 the body copies the precomputed column instead of recomputing
    const triggerSql = (
      mgr.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'memories_ident_fts_insert'")
        .get() as { sql: string }
    ).sql
    expect(triggerSql).toContain('new.ident_text')
  })

  it('is idempotent at the DDL level and never discards indexed rows', () => {
    const mgr = new DatabaseManager(':memory:')
    managers.push(mgr)
    seedMemory(mgr.db, 'm1', 'hybridSearch')
    const before = identRow(mgr.db, 'm1')
    expect(before).toBe('hybrid search hybridsearch')

    expect(() => migration012.up(mgr.db)).not.toThrow()
    expect(() => migration012.up(mgr.db)).not.toThrow()
    expect(identRow(mgr.db, 'm1')).toBe(before)

    seedMemory(mgr.db, 'm2', 'pprSearch')
    expect(identRow(mgr.db, 'm2')).toBe('ppr search pprsearch')

    const ddl = lexicalIndexDdl()
    expect(ddl).toContain(`CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORIES_IDENT_FTS}`)
    expect(ddl).toContain(`CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORY_ENTITY_FTS}`)
  })

  it('leaves memories_fts untouched so its consumers keep working', () => {
    const mgr = new DatabaseManager(':memory:')
    managers.push(mgr)
    const ftsSql = (
      mgr.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get() as { sql: string }
    ).sql
    expect(ftsSql).toContain('content=memories')
    expect(ftsSql).not.toContain('ident')
    seedMemory(mgr.db, 'm1', 'the hybrid search pipeline')
    expect(ftsSearch(mgr.db, 'hybrid search', { project_path: PROJECT }, 10).map((m) => m.id)).toEqual(['m1'])
  })
})

describe('migration 015 (precomputed ident_text)', () => {
  const managers: DatabaseManager[] = []
  afterEach(() => {
    while (managers.length) managers.pop()!.close()
  })

  it('adds the columns and switches the triggers to read them, idempotently', () => {
    const mgr = new DatabaseManager(':memory:')
    managers.push(mgr)
    const db = mgr.db

    const columns = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
    expect(columns('memories')).toContain('ident_text')
    expect(columns('memory_entities')).toContain('ident_text')

    for (const name of ['memories_ident_fts', 'memory_entity_fts']) {
      for (const suffix of ['insert', 'update']) {
        const sql = (
          db
            .prepare('SELECT sql FROM sqlite_master WHERE type = \'trigger\' AND name = ?')
            .get(`${name}_${suffix}`) as { sql: string }
        ).sql
        expect(sql, `${name}_${suffix}`).toContain("ifnull(new.ident_text, '')")
      }
    }

    seedMemory(db, 'm1', 'hybridSearch')
    const before = identRow(db, 'm1')
    expect(() => migration015.up(db)).not.toThrow()
    expect(() => migration015.up(db)).not.toThrow()
    expect(identRow(db, 'm1')).toBe(before)
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM ${MEMORIES_IDENT_FTS}`).get()
    ).toEqual({ n: countIdent(db) })

    const ddl = lexicalIdentColumnDdl()
    expect(ddl).toContain(`CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORIES_IDENT_FTS}`)
    expect(ddl).toContain(`CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORY_ENTITY_FTS}`)

    // a stray re-run of 012 restores its expression triggers; 015 is re-runnable
    // and puts the column form back
    migration012.up(db)
    expect(
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_ident_fts_insert'")
          .get() as { sql: string }
      ).sql
    ).not.toContain('new.ident_text')
    migration015.up(db)
    expect(
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_ident_fts_insert'")
          .get() as { sql: string }
      ).sql
    ).toContain('new.ident_text')
  })

  it('no-ops on a database that has 012 but not 015, instead of throwing at boot', async () => {
    const db = new Database(':memory:')
    db.exec(BASELINE_FIXTURE)
    runMigrations(db, ':memory:', migrations.slice(0, 12), () => undefined)
    expect(lexicalIndexReady(db)).toBe(true)

    db.prepare("INSERT INTO sessions (id, project_path, started_at) VALUES ('s1', ?, 1000)").run(PROJECT)
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, content, created_at, tags)
       VALUES ('m1', 's1', ?, 'calls pprSearch here', 1000, '["graph"]')`
    ).run(PROJECT)
    expect(identRow(db, 'm1')).toBe(normalizeIdentifiers('calls pprSearch here ["graph"]'))

    const stats = await backfillLexicalIndex(db, { batchSize: 10, pauseMs: 0 })
    expect(stats).toMatchObject({ memoryIdents: 0, entityIdents: 0, memoryRows: 0, entityRows: 0 })
    db.close()
  })

  it('degrades a row with no ident_text to absent-from-index instead of throwing, then repairs it', async () => {
    const mgr = new DatabaseManager(':memory:')
    managers.push(mgr)
    const db = mgr.db

    // an insert from a writer that knows nothing about the column must succeed,
    // leaving the row simply unindexed
    db.prepare("INSERT INTO sessions (id, project_path, started_at) VALUES ('s1', ?, 100)").run(PROJECT)
    db.prepare(
      `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from)
       VALUES ('legacy', 's1', ?, ?, 'the hybridSearch entry point', 'note', 0.5, '[]', 100, 100)`
    ).run(PROJECT, PROJECT)
    db.prepare(
      "INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at) VALUES ('legacy', 'traverseGraph', 'symbol', 100)"
    ).run()

    expect(identRow(db, 'legacy')).toBe('')
    expect(identSearch(db, 'hybridSearch', { project_path: PROJECT }, 10)).toEqual([])
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM ${MEMORY_ENTITY_FTS} WHERE ${MEMORY_ENTITY_FTS} MATCH 'traverse*'`).get()
    ).toEqual({ n: 0 })

    const stats = await backfillLexicalIndex(db, { batchSize: 10, pauseMs: 0 })
    expect(stats.memoryIdents).toBe(1)
    expect(stats.entityIdents).toBe(1)
    expect(identRow(db, 'legacy')).toBe(normalizeIdentifiers('the hybridSearch entry point []'))
    expect(identSearch(db, 'hybridSearch', { project_path: PROJECT }, 10).map((r) => r.id)).toEqual(['legacy'])
    expect(
      (
        db
          .prepare(`SELECT memory_id FROM ${MEMORY_ENTITY_FTS} WHERE ${MEMORY_ENTITY_FTS} MATCH 'traverse*'`)
          .all() as Array<{ memory_id: string }>
      ).map((r) => r.memory_id)
    ).toEqual(['legacy'])

    const second = await backfillLexicalIndex(db, { batchSize: 10, pauseMs: 0 })
    expect(second).toMatchObject({ memoryIdents: 0, entityIdents: 0, memoryRows: 0, entityRows: 0 })
  })
})

describe('identifier index maintenance (triggers, any connection)', () => {
  it('indexes inserts, re-indexes content and tag updates, and drops on delete', () => {
    const mgr = new DatabaseManager(':memory:')
    const db = mgr.db
    seedMemory(db, 'm1', 'hybridSearch entry point')
    expect(identRow(db, 'm1')).toBe('hybrid search entry point hybridsearch entry point')
    expect(identRow(db, 'm1')).toBe(normalizeIdentifiers('hybridSearch entry point'))

    db.prepare(
      "UPDATE memories SET content = 'vectorSearch entry point', ident_text = ? WHERE id = 'm1'"
    ).run(normalizeIdentifiers('vectorSearch entry point'))
    expect(identRow(db, 'm1')).toContain('vectorsearch')
    expect(identRow(db, 'm1')).not.toContain('hybridsearch')

    const pprTags = JSON.stringify(['PprSearch'])
    db.prepare('UPDATE memories SET tags = ?, ident_text = ? WHERE id = ?').run(
      pprTags,
      normalizeIdentifiers(`vectorSearch entry point ${pprTags}`),
      'm1'
    )
    expect(identRow(db, 'm1')).toContain('pprsearch')

    db.prepare("DELETE FROM memories WHERE id = 'm1'").run()
    expect(identRow(db, 'm1')).toBeUndefined()

    seedMemory(db, 'm2', 'graph walk entry')
    db.prepare(
      "INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at, ident_text) VALUES ('m2', 'traverseGraph', 'function', 1, ?)"
    ).run(normalizeIdentifiers('traverseGraph'))
    const entityIds = db
      .prepare(`SELECT memory_id FROM ${MEMORY_ENTITY_FTS} WHERE ${MEMORY_ENTITY_FTS} MATCH 'traverse*'`)
      .all() as Array<{ memory_id: string }>
    expect(entityIds.map((r) => r.memory_id)).toEqual(['m2'])
    db.prepare('DELETE FROM memory_entities WHERE memory_id = ?').run('m2')
    expect((db.prepare(`SELECT COUNT(*) AS n FROM ${MEMORY_ENTITY_FTS}`).get() as { n: number }).n).toBe(0)
    mgr.close()
  })
})

describe('identifier backfill of pre-existing rows', () => {
  it('is idempotent, bounded in batches, and correct on a seeded database', async () => {
    const db = new Database(':memory:')
    db.exec(BASELINE_FIXTURE)
    runMigrations(db, ':memory:', migrations.slice(0, 11), () => undefined)
    db.prepare("INSERT INTO sessions (id, project_path, started_at) VALUES ('s1', ?, 1000)").run(PROJECT)
    const seeded: Array<[string, string, string]> = [
      ['m1', 'note about hybridSearch in src/memory/search/hybrid.ts', '["retrieval"]'],
      ['m2', 'pprSearch walks the graph', '[]'],
      ['m3', '_autoLink creates semantic edges', '["graph"]'],
      ['m4', 'plain note without identifiers', '[]'],
      ['m5', 'entitySearch over memory_entities', '[]'],
    ]
    for (const [id, content, tags] of seeded) {
      db.prepare(
        `INSERT INTO memories (id, session_id, project_path, content, created_at, tags)
         VALUES (?, 's1', ?, ?, 1000, ?)`
      ).run(id, PROJECT, content, tags)
    }
    db.prepare(
      "INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at) VALUES ('m1', 'src/memory/search/hybrid.ts', 'file_path', 1)"
    ).run()

    const result = runMigrations(db, ':memory:', migrations, () => undefined)
    expect(result.startingVersion).toBe(11)
    const appliedVersions = result.applied.map((m) => m.version)
    expect(appliedVersions).toContain(12)
    expect(appliedVersions.every((v) => v > 11)).toBe(true)
    expect(result.finalVersion).toBeGreaterThanOrEqual(12)
    // the migration does not re-index inline; the bounded worker does
    expect(countIdent(db)).toBe(0)

    const stats = await backfillLexicalIndex(db, { batchSize: 2, pauseMs: 0 })
    expect(stats.memoryRows).toBe(5)
    expect(stats.entityRows).toBe(1)
    expect(stats.batches).toBeGreaterThanOrEqual(4)

    for (const [id, content, tags] of seeded) {
      expect(identRow(db, id), id).toBe(normalizeIdentifiers(`${content} ${tags}`))
    }
    expect(
      (
        db
          .prepare(`SELECT memory_id FROM ${MEMORY_ENTITY_FTS} WHERE ${MEMORY_ENTITY_FTS} MATCH 'hybrid*'`)
          .all() as Array<{ memory_id: string }>
      ).map((r) => r.memory_id)
    ).toEqual(['m1'])

    const second = await backfillLexicalIndex(db, { batchSize: 2, pauseMs: 0 })
    expect(second.memoryRows).toBe(0)
    expect(second.entityRows).toBe(0)
    expect(countIdent(db)).toBe(5)

    seedMemory(db, 'm6', 'laterNote')
    const third = await backfillLexicalIndex(db, { batchSize: 2, pauseMs: 0 })
    expect(third.memoryRows).toBe(0)
    expect(identRow(db, 'm6')).toBe('later note laternote')
    db.close()
  })

  it('no-ops when the index tables are absent instead of throwing', async () => {
    const db = new Database(':memory:')
    db.exec(BASELINE_FIXTURE)
    const stats = await backfillLexicalIndex(db, { batchSize: 10 })
    expect(stats).toMatchObject({ memoryRows: 0, entityRows: 0 })
    db.close()
  })
})

describe('identSearch matching (camelCase / snake_case / dotted path)', () => {
  const managers: DatabaseManager[] = []
  afterEach(() => {
    while (managers.length) managers.pop()!.close()
  })

  function seededDb(): Database.Database {
    const mgr = new DatabaseManager(':memory:')
    managers.push(mgr)
    const db = mgr.db
    seedMemory(db, 'camel', 'the hybridSearch entry point')
    seedMemory(db, 'snake', 'the hybrid_search helper')
    seedMemory(db, 'path', 'see src/memory/search/hybrid.ts for the walk')
    seedMemory(db, 'other', 'unrelated content about caching')
    seedMemory(db, 'foreign', 'hybridSearch in another project', { namespace: '/other/project' })
    return db
  }

  const ids = (db: Database.Database, query: string, options: Record<string, unknown> = {}) =>
    identSearch(db, query, { project_path: PROJECT, ...options }, 10)
      .map((r) => r.id)
      .sort()

  it('matches camelCase, spaced, snake_case and dotted-path queries', () => {
    const db = seededDb()
    expect(ids(db, 'hybridSearch')).toEqual(['camel', 'snake'])
    expect(ids(db, 'hybrid search')).toEqual(['camel', 'path', 'snake'])
    expect(ids(db, 'hybrid_search')).toEqual(['camel', 'snake'])
    expect(ids(db, 'src/memory/search/hybrid.ts')).toEqual(['path'])
    expect(ids(db, 'hybrid.ts')).toEqual(['path'])
    expect(ids(db, 'memory_entities')).toEqual([])
  })

  it('is the difference that fixes the lexical defect: memories_fts misses these queries', () => {
    const db = seededDb()
    const baseline = (query: string) =>
      ftsSearch(db, query, { project_path: PROJECT }, 10)
        .map((r) => r.id)
        .sort()

    // the shipped lexical channel is unchanged and cannot equate the notations
    expect(baseline('hybridSearch')).toEqual(['camel'])
    expect(baseline('hybrid search')).toEqual(['path', 'snake'])
    expect(ids(db, 'hybridSearch')).toEqual(['camel', 'snake'])
    expect(ids(db, 'hybrid search')).toEqual(['camel', 'path', 'snake'])
  })

  it('isolates namespaces and honours validity/supersession/type', () => {
    const db = seededDb()
    expect(ids(db, 'hybridSearch', { namespace_subtree: PROJECT })).toEqual(['camel', 'snake'])
    seedMemory(db, 'child', 'hybridSearch variant in a child scope', { namespace: CHILD })
    expect(ids(db, 'hybridSearch', { namespace_subtree: PROJECT })).toEqual(['camel', 'child', 'snake'])

    // camel expires at 200, so it is gone at as_of 500
    db.prepare("UPDATE memories SET valid_from = 100, valid_until = 200 WHERE id = 'camel'").run()
    expect(ids(db, 'hybridSearch', { as_of: 500 })).toEqual(['snake'])
    expect(ids(db, 'hybridSearch', { as_of: 150 })).toEqual(['camel', 'snake'])
    expect(ids(db, 'hybridSearch', { before: 100 })).toEqual(['camel', 'snake'])

    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at, confidence, judged_at)
       VALUES ('snake', 'camel', 1, 'supersedes', 1, 1, 1)`
    ).run()
    expect(ids(db, 'hybridSearch', { include_superseded: false })).toEqual(['snake'])
    expect(ids(db, 'hybridSearch', { include_superseded: true })).toEqual(['camel', 'snake'])

    db.prepare("UPDATE memories SET type = 'bug' WHERE id = 'camel'").run()
    expect(ids(db, 'hybridSearch', { type: 'bug', include_superseded: true })).toEqual(['camel'])
    expect(identSearch(db, 'hybridSearch', { project_path: PROJECT }, 1)).toHaveLength(1)
    expect(identSearch(db, '   ', { project_path: PROJECT }, 10)).toEqual([])
  })

  it('falls back to OR for long queries, like ftsSearch', () => {
    const db = seededDb()
    const rows = identSearch(
      db,
      'unrelated camelCacheTtl unknownThirdToken',
      { project_path: PROJECT },
      10
    )
    expect(rows.map((r) => r.id)).toContain('other')
  })
})
