import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import {
  parseNamespacePath,
  ensureNode,
  getNode,
  deepestKnownPrefix,
  ancestors,
  children,
  setNodeDigest,
  refreshNodeCounts,
  backfillTree,
  ancestorPaths,
} from '../src/namespace/tree.js'

describe('parseNamespacePath', () => {
  it('treats deep absolute paths as depth = segment count', () => {
    const p = parseNamespacePath('/Users/locc/git/research/hive')
    expect(p.isPathShaped).toBe(true)
    expect(p.realPath).toBeNull()
    expect(p.scope).toBeNull()
    expect(p.depth).toBe(5)
    expect(p.parentPath).toBe('/Users/locc/git/research')
  })

  it('parents a top-level absolute path at the fs root', () => {
    const p = parseNamespacePath('/a')
    expect(p.parentPath).toBe('/')
    expect(p.depth).toBe(1)
    expect(parseNamespacePath('/').parentPath).toBeNull()
    expect(parseNamespacePath('/').depth).toBe(0)
  })

  it('collapses ~ roots to depth 0', () => {
    expect(parseNamespacePath('~').depth).toBe(0)
    expect(parseNamespacePath('~').parentPath).toBeNull()
    const nested = parseNamespacePath('~/x/y')
    expect(nested.isPathShaped).toBe(true)
    expect(nested.depth).toBe(2)
    expect(nested.parentPath).toBe('~/x')
  })

  it('parses synthetic // scopes with the real path as parent', () => {
    const p = parseNamespacePath('/Users/locc/cb//payments')
    expect(p.isPathShaped).toBe(true)
    expect(p.realPath).toBe('/Users/locc/cb')
    expect(p.scope).toBe('payments')
    expect(p.parentPath).toBe('/Users/locc/cb')
    expect(p.depth).toBe(4)
  })

  it('treats non-path namespaces as depth-0 roots without parents', () => {
    const p = parseNamespacePath('autonomous-crypto-desk')
    expect(p.isPathShaped).toBe(false)
    expect(p.parentPath).toBeNull()
    expect(p.depth).toBe(0)
    expect(ancestorPaths('autonomous-crypto-desk')).toEqual([])
  })

  it('roots a synthetic scope over a non-path base', () => {
    const p = parseNamespacePath('desk//trading')
    expect(p.isPathShaped).toBe(false)
    expect(p.realPath).toBe('desk')
    expect(p.scope).toBe('trading')
    expect(p.parentPath).toBe('desk')
    expect(p.depth).toBe(1)
  })

  it('ancestorPaths walks root-first for deep paths', () => {
    expect(ancestorPaths('/a/b/c')).toEqual(['/', '/a', '/a/b'])
  })
})

describe('namespace tree storage', () => {
  let db: Database.Database

  beforeEach(() => {
    ;({ db } = createTestDb())
    // memories.session_id has an FK to sessions; satisfy it once for all rows.
    db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run('s', '/', 0)
  })

  it('ensureNode creates the full ancestor chain in one call', () => {
    ensureNode(db, '/a/b/c')
    expect(getNode(db, '/')).not.toBeNull()
    expect(getNode(db, '/a')?.parent_path).toBe('/')
    expect(getNode(db, '/a/b')?.parent_path).toBe('/a')
    expect(getNode(db, '/a/b/c')?.depth).toBe(3)
    expect(getNode(db, '/a/b/c')?.is_synthetic).toBe(false)
  })

  it('ensureNode is idempotent', () => {
    const first = ensureNode(db, '/a/b')
    const second = ensureNode(db, '/a/b')
    expect(second).toEqual(first)
    expect(children(db, '/').length).toBe(1)
  })

  it('ensureNode marks synthetic scopes and parents them at the real path', () => {
    ensureNode(db, '/a/b//payments')
    const node = getNode(db, '/a/b//payments')
    expect(node?.is_synthetic).toBe(true)
    expect(node?.real_path).toBe('/a/b')
    expect(node?.parent_path).toBe('/a/b')
    expect(getNode(db, '/a/b')?.is_synthetic).toBe(false)
  })

  it('ensureNode stores non-path namespaces as parentless roots', () => {
    const node = ensureNode(db, 'autonomous-crypto-desk')
    expect(node.parent_path).toBeNull()
    expect(node.depth).toBe(0)
    expect(node.is_synthetic).toBe(false)
    expect(node.real_path).toBeNull()
  })

  it('deepestKnownPrefix returns the longest stored prefix', () => {
    ensureNode(db, '/a/b/c')
    // Only some ancestors were materialized explicitly; deepestKnownPrefix must
    // consult the table, not the parse rules.
    expect(deepestKnownPrefix(db, '/a/b/c/d/e')?.path).toBe('/a/b/c')
    expect(deepestKnownPrefix(db, '/a/x/y')?.path).toBe('/a')
  })

  it('deepestKnownPrefix prefers a synthetic node over its real path', () => {
    ensureNode(db, '/a/b')
    ensureNode(db, '/a/b//payments')
    expect(deepestKnownPrefix(db, '/a/b//payments')?.path).toBe('/a/b//payments')
  })

  it('deepestKnownPrefix returns null when nothing is stored', () => {
    expect(deepestKnownPrefix(db, '/nope/nothing')).toBeNull()
  })

  it('ancestors returns existing nodes root-first and skips unknown ones', () => {
    ensureNode(db, '/a/b/c')
    const chain = ancestors(db, '/a/b/c')
    expect(chain.map((n) => n.path)).toEqual(['/', '/a', '/a/b'])
  })

  it('ancestors of a synthetic node include the real path', () => {
    ensureNode(db, '/a/b//payments')
    const chain = ancestors(db, '/a/b//payments')
    expect(chain.map((n) => n.path)).toEqual(['/', '/a', '/a/b'])
  })

  it('ancestors of a non-path namespace are empty', () => {
    ensureNode(db, 'desk')
    expect(ancestors(db, 'desk')).toEqual([])
  })

  it('children lists direct descendants only', () => {
    ensureNode(db, '/a/b/c')
    ensureNode(db, '/a/d')
    const kids = children(db, '/a')
    expect(kids.map((n) => n.path).sort()).toEqual(['/a/b', '/a/d'])
    expect(children(db, '/a/b').map((n) => n.path)).toEqual(['/a/b/c'])
    expect(children(db, '/nope')).toEqual([])
  })

  it('setNodeDigest upserts digest fields even before the node exists', () => {
    setNodeDigest(db, '/a/b', 'condensed digest', 'hash-1')
    // digest_source_hash is storage metadata, deliberately not exposed on the
    // NamespaceNode interface — assert through the raw row.
    const row = db
      .prepare('SELECT digest, digest_source_hash FROM namespace_nodes WHERE path = ?')
      .get('/a/b') as { digest: string; digest_source_hash: string | null }
    expect(row.digest).toBe('condensed digest')
    expect(row.digest_source_hash).toBe('hash-1')
  })

  it('refreshNodeCounts counts non-superseded memories and children', () => {
    const insert = db.prepare(
      `INSERT INTO memories (id, session_id, project_path, content, type, importance, tags, created_at)
       VALUES (?, ?, ?, ?, 'note', 0.5, '[]', ?)`
    )
    insert.run('m1', 's', '/a/b', 'memory one', 100)
    insert.run('m2', 's', '/a/b', 'memory two', 200)
    // Superseding link with high confidence removes m1 from the count.
    db.prepare(
      `INSERT INTO memory_links (source_id, target_id, similarity, link_type, confidence, created_at)
       VALUES ('m2', 'm1', 0.9, 'supersedes', 0.95, 300)`
    ).run()
    ensureNode(db, '/a/b/c')
    ensureNode(db, '/a/b')

    refreshNodeCounts(db, '/a/b')
    const node = getNode(db, '/a/b')
    expect(node?.memory_count).toBe(1)
    expect(node?.child_count).toBe(1)
    expect(node?.last_activity_at).toBe(200)
  })

  it('refreshNodeCounts zeroes counts for empty namespaces', () => {
    ensureNode(db, '/empty/leaf')
    refreshNodeCounts(db, '/empty/leaf')
    const node = getNode(db, '/empty/leaf')
    expect(node?.memory_count).toBe(0)
    expect(node?.child_count).toBe(0)
    expect(node?.last_activity_at).toBeNull()
  })

  it('backfillTree ensures a node per distinct memory namespace', () => {
    const insert = db.prepare(
      `INSERT INTO memories (id, session_id, project_path, content, type, importance, tags, created_at)
       VALUES (?, ?, ?, ?, 'note', 0.5, '[]', 1)`
    )
    insert.run('m1', 's', '/x/y', 'one')
    insert.run('m2', 's', '/x/y', 'two')
    insert.run('m3', 's', '/x/z', 'three')
    insert.run('m4', 's', 'flat-ns', 'four')

    const ensured = backfillTree(db)
    // Three distinct namespaces: /x/y, /x/z, flat-ns.
    expect(ensured).toBe(3)
    expect(getNode(db, '/x/y')?.memory_count).toBe(2)
    expect(getNode(db, '/x/z')?.memory_count).toBe(1)
    expect(getNode(db, 'flat-ns')?.memory_count).toBe(1)
  })

  it('backfillTree counts memory_count against namespace overrides', () => {
    const insert = db.prepare(
      `INSERT INTO memories (id, session_id, project_path, content, type, importance, tags, created_at, namespace)
       VALUES (?, ?, ?, ?, 'note', 0.5, '[]', 1, ?)`
    )
    insert.run('m1', 's', '/ignored', 'one', '/real/ns')
    backfillTree(db)
    expect(getNode(db, '/real/ns')?.memory_count).toBe(1)
    // The namespace override wins: /ignored only held fallback project_path, so
    // backfill never materializes a node for it.
    expect(getNode(db, '/ignored')).toBeNull()
  })
})
