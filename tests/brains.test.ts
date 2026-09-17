import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { DatabaseManager } from '../src/db/init.js'
import {
  ageIdentityToEngramPriv,
  ageRecipientToEngramPub,
  engramPrivToAgeIdentity,
  engramPubToAgeRecipient,
  isEngramPriv,
  isEngramPub,
} from '../src/brains/keyformat.js'
import { createIdentity, saveIdentity, loadIdentity, identityExists } from '../src/brains/identity.js'
import { exportBrain, readManifestFromFile, validateForImport } from '../src/brains/snapshot.js'
import { sanitizeBrainName } from '../src/brains/paths.js'
import { generateIdentity, identityToRecipient } from 'age-encryption'

describe('brains/keyformat', () => {
  it('round-trips real age recipient → engram_pub → age recipient', async () => {
    const ageId = await generateIdentity()
    const ageRecipient = await identityToRecipient(ageId)
    const engramPub = ageRecipientToEngramPub(ageRecipient)
    expect(isEngramPub(engramPub)).toBe(true)
    expect(engramPub.startsWith('engram_pub_')).toBe(true)
    expect(engramPubToAgeRecipient(engramPub)).toBe(ageRecipient)
  })

  it('round-trips real age identity → engram_priv → age identity', async () => {
    const ageId = await generateIdentity()
    const engramPriv = ageIdentityToEngramPriv(ageId)
    expect(isEngramPriv(engramPriv)).toBe(true)
    expect(engramPriv.startsWith('engram_priv_')).toBe(true)
    expect(engramPrivToAgeIdentity(engramPriv)).toBe(ageId)
  })

  it('rejects non-engram-prefixed strings', () => {
    expect(isEngramPub('age1abc')).toBe(false)
    expect(isEngramPriv('AGE-SECRET-KEY-1abc')).toBe(false)
    expect(() => engramPubToAgeRecipient('not_a_key')).toThrow()
    expect(() => engramPrivToAgeIdentity('not_a_key')).toThrow()
  })
})

describe('brains/identity', () => {
  let tmp: string
  let idPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-identity-'))
    idPath = join(tmp, 'identity')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('creates, saves, and loads identity with matching public key', async () => {
    const identity = await createIdentity()
    expect(identity.privateKey.startsWith('engram_priv_')).toBe(true)
    expect(identity.publicKey.startsWith('engram_pub_')).toBe(true)

    await saveIdentity(identity, idPath)
    expect(existsSync(idPath)).toBe(true)

    if (process.platform !== 'win32') {
      const mode = statSync(idPath).mode & 0o777
      expect(mode).toBe(0o600)
    }

    const loaded = await loadIdentity(idPath)
    expect(loaded.privateKey).toBe(identity.privateKey)
    expect(loaded.publicKey).toBe(identity.publicKey)
  })

  it('identityExists returns false when missing, true when present', async () => {
    expect(identityExists(idPath)).toBe(false)
    const id = await createIdentity()
    await saveIdentity(id, idPath)
    expect(identityExists(idPath)).toBe(true)
  })

  it('loadIdentity throws clear error when file is missing', async () => {
    await expect(loadIdentity(idPath)).rejects.toThrow(/No engram identity/)
  })
})

describe('brains/paths sanitizeBrainName', () => {
  it('accepts safe names', () => {
    expect(sanitizeBrainName('my-brain')).toBe('my-brain')
    expect(sanitizeBrainName('Brain_v1')).toBe('Brain_v1')
    expect(sanitizeBrainName('abc123')).toBe('abc123')
  })

  it('rejects path traversal and shell injection attempts', () => {
    expect(() => sanitizeBrainName('../escape')).toThrow()
    expect(() => sanitizeBrainName('a/b')).toThrow()
    expect(() => sanitizeBrainName('a;rm -rf')).toThrow()
    expect(() => sanitizeBrainName('a.b')).toThrow()
    expect(() => sanitizeBrainName('')).toThrow()
  })
})

describe('brains/snapshot', () => {
  let tmp: string
  let outPath: string
  let sourceMgr: DatabaseManager

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-snapshot-'))
    outPath = join(tmp, 'brain.db')
    sourceMgr = new DatabaseManager(':memory:')
    sourceMgr.db
      .prepare(
        'INSERT INTO sessions(id, project_path, started_at) VALUES (?, ?, ?)'
      )
      .run('sess1', '/proj', Date.now())
  })
  afterEach(() => {
    sourceMgr.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function insertMemory(id: string, namespace: string, shareable: 0 | 1, content = 'hello'): void {
    sourceMgr.db
      .prepare(
        'INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, 'sess1', '/proj', content, 'note', 0.5, '[]', Date.now(), 0, namespace, shareable)
  }

  it('exports only shareable memories from the requested namespace', () => {
    insertMemory('m1', 'work', 1)
    insertMemory('m2', 'work', 0)
    insertMemory('m3', 'personal', 1)
    insertMemory('m4', 'work', 1)

    const result = exportBrain(sourceMgr.db, { namespace: 'work', outputPath: outPath })
    expect(result.memoryCount).toBe(2)

    const target = new Database(outPath, { readonly: true })
    const rows = target.prepare('SELECT id FROM memories ORDER BY id').all() as Array<{ id: string }>
    target.close()
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm4'])
  })

  it('writes a complete manifest', () => {
    insertMemory('m1', 'work', 1)
    exportBrain(sourceMgr.db, {
      namespace: 'work',
      outputPath: outPath,
      description: 'test brain',
      ownerName: 'alice',
      ownerPubkey: 'engram_pub_xxx',
    })

    const manifest = readManifestFromFile(outPath)
    expect(manifest.memory_count).toBe(1)
    expect(manifest.description).toBe('test brain')
    expect(manifest.owner_name).toBe('alice')
    expect(manifest.owner_pubkey).toBe('engram_pub_xxx')
    expect(manifest.schema_version).toBe(7)
    expect(manifest.embedding_model).toBe('nomic-ai/nomic-embed-text-v1.5')
    expect(manifest.embedding_dim).toBe(768)
  })

  it('produces empty but valid brain when no shareable memories exist', () => {
    insertMemory('m1', 'work', 0)
    const result = exportBrain(sourceMgr.db, { namespace: 'work', outputPath: outPath })
    expect(result.memoryCount).toBe(0)
    const manifest = readManifestFromFile(outPath)
    expect(manifest.memory_count).toBe(0)
    expect(validateForImport(manifest)).toBeNull()
  })

  it('does NOT include memories from other namespaces even if shareable', () => {
    insertMemory('m1', 'work', 1)
    insertMemory('m2', 'personal', 1)
    const result = exportBrain(sourceMgr.db, { namespace: 'work', outputPath: outPath })
    expect(result.memoryCount).toBe(1)
  })

  it('filters memory_links to only links between exported memories', () => {
    insertMemory('m1', 'work', 1)
    insertMemory('m2', 'work', 1)
    insertMemory('m3', 'work', 0)
    sourceMgr.db
      .prepare(
        'INSERT INTO memory_links(source_id, target_id, similarity, link_type, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('m1', 'm2', 0.9, 'semantic', Date.now())
    sourceMgr.db
      .prepare(
        'INSERT INTO memory_links(source_id, target_id, similarity, link_type, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('m1', 'm3', 0.8, 'semantic', Date.now())

    exportBrain(sourceMgr.db, { namespace: 'work', outputPath: outPath })

    const target = new Database(outPath, { readonly: true })
    const links = target.prepare('SELECT source_id, target_id FROM memory_links').all()
    target.close()
    expect(links).toEqual([{ source_id: 'm1', target_id: 'm2' }])
  })

  it('validateForImport rejects mismatched embedding model', () => {
    const bad = {
      schema_version: 6,
      engram_version: '0.2.0',
      embedding_model: 'other-model',
      embedding_dim: 768,
      owner_name: null,
      owner_pubkey: null,
      description: null,
      exported_at: Date.now(),
      memory_count: 1,
      source_namespace: 'work',
      included_layers: null,
    }
    const err = validateForImport(bad)
    expect(err?.kind).toBe('embedding_model')
  })

  it('validateForImport rejects corrupt (no manifest)', () => {
    const bad = {
      schema_version: 0,
      engram_version: '',
      embedding_model: '',
      embedding_dim: 0,
      owner_name: null,
      owner_pubkey: null,
      description: null,
      exported_at: 0,
      memory_count: 0,
      source_namespace: '',
      included_layers: null,
    }
    const err = validateForImport(bad)
    expect(err?.kind).toBe('corrupt')
  })

  it('includes synthetic scope layers only when includeScopes is set', () => {
    insertMemory('m1', 'work', 1)
    insertMemory('m2', 'work//payments', 1)
    insertMemory('m3', 'work/child', 1)
    insertMemory('m4', 'workshop', 1) // sibling prefix must never match
    insertMemory('m5', 'personal', 1)

    const exactPath = join(tmp, 'brain-exact.db')
    const exact = exportBrain(sourceMgr.db, { namespace: 'work', outputPath: exactPath })
    expect(exact.memoryCount).toBe(1)

    const layeredPath = join(tmp, 'brain-layers.db')
    const layered = exportBrain(sourceMgr.db, {
      namespace: 'work',
      outputPath: layeredPath,
      includeScopes: true,
    })
    expect(layered.memoryCount).toBe(3)

    const target = new Database(layeredPath, { readonly: true })
    const ids = target.prepare('SELECT id FROM memories ORDER BY id').all() as Array<{ id: string }>
    target.close()
    expect(ids.map((r) => r.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('records source_namespace and the included layers in the manifest', () => {
    insertMemory('m1', 'work', 1)
    insertMemory('m2', 'work//payments', 1)
    const layeredPath = join(tmp, 'brain-layers-manifest.db')
    exportBrain(sourceMgr.db, { namespace: 'work', outputPath: layeredPath, includeScopes: true })

    const manifest = readManifestFromFile(layeredPath)
    expect(manifest.source_namespace).toBe('work')
    expect(JSON.parse(manifest.included_layers ?? '[]')).toEqual(['work', 'work//payments'])
  })

  it('exports when the source connection has no sqlite-vec loaded', () => {
    const srcPath = join(tmp, 'plain-source.db')
    const mgr = new DatabaseManager(srcPath)
    mgr.db
      .prepare('INSERT INTO sessions(id, project_path, started_at) VALUES (?, ?, ?)')
      .run('sess1', '/proj', Date.now())
    mgr.db
      .prepare(
        'INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable, vec_rowid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run('m1', 'sess1', '/proj', 'hello', 'note', 0.5, '[]', Date.now(), 0, 'work', 1, 1)
    mgr.close()

    // Mirrors publish.ts / cli/brain.ts: a plain better-sqlite3 handle with no
    // sqlite-vec extension. The vector copy must degrade, not throw
    // "no such module: vec0".
    const plain = new Database(srcPath, { readonly: true })
    const vecPath = join(tmp, 'brain-novec.db')
    const result = exportBrain(plain, { namespace: 'work', outputPath: vecPath })
    plain.close()
    expect(result.memoryCount).toBe(1)
  })

  it('materializes a missing session row instead of aborting the export', () => {
    sourceMgr.db.pragma('foreign_keys = OFF')
    try {
      sourceMgr.db
        .prepare(
          'INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run('m1', 'ghost-session', '/proj', 'orphan', 'note', 0.5, '[]', Date.now(), 0, 'work', 1)
    } finally {
      sourceMgr.db.pragma('foreign_keys = ON')
    }

    const ghostPath = join(tmp, 'brain-ghost.db')
    const result = exportBrain(sourceMgr.db, { namespace: 'work', outputPath: ghostPath })
    expect(result.memoryCount).toBe(1)

    const target = new Database(ghostPath, { readonly: true })
    const row = target.prepare('SELECT id FROM sessions WHERE id = ?').get('ghost-session') as
      | { id: string }
      | undefined
    target.close()
    expect(row?.id).toBe('ghost-session')
  })
})
