import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import Database from 'better-sqlite3'
import { DatabaseManager } from '../src/db/init.js'
import { EMBEDDING_DIM } from '../src/embeddings/pipeline.js'
import { createIdentity, saveIdentity } from '../src/brains/identity.js'
import { writeRecipients } from '../src/brains/recipients.js'
import { publishBrain } from '../src/brains/publish.js'
import { followBrain } from '../src/brains/follow.js'
import { searchBrain } from '../src/brains/mcp.js'

const gitAvailable = spawnSync('git', ['--version']).status === 0

/**
 * The acceptance path that no test exercised before: publish a shareable layer
 * over a PLAIN sqlite connection (exactly what the CLI does), ship it through a
 * real git remote, follow it as a second identity, and answer a natural-language
 * question from the followed brain.
 *
 * It also pins the defects this path hid for months:
 *   - `no such module: vec0` when the source connection has no extension loaded
 *   - plaintext artifacts committed/pushed by `git add -A`
 *   - absolute owner paths and session narratives travelling in the snapshot
 *   - retracted (superseded) facts shipping as current
 *   - embeddings silently dropped so follower search is lexical-only
 */
describe.skipIf(!gitAvailable)('brains acceptance: publish -> follow -> search', () => {
  const HOME_NS = `${homedir()}/proj`
  const SCOPE_NS = `${HOME_NS}//payments`
  const CANARY = 'CANARY_PLAINTEXT_E2E_2f91'
  const brainName = 'e2ebrain'

  let tmp: string
  let bare: string
  let publisherDir: string
  let followerRoot: string
  let followerDir: string
  let sourceDbPath: string
  let publisherIdentityPath: string
  let followerIdentityPath: string
  let followerPubkey: string
  let publisherPubkey: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-accept-'))
    bare = join(tmp, 'remote.git')
    publisherDir = join(tmp, 'publisher-brain')
    followerRoot = join(tmp, 'follower-brains')
    followerDir = join(followerRoot, brainName)
    sourceDbPath = join(tmp, 'source.db')
    publisherIdentityPath = join(tmp, 'publisher.identity')
    followerIdentityPath = join(tmp, 'follower.identity')

    spawnSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' })
    mkdirSync(publisherDir, { recursive: true })
    mkdirSync(followerRoot, { recursive: true })
    spawnSync('git', ['init', '-b', 'main', publisherDir], { stdio: 'ignore' })
    spawnSync('git', ['-C', publisherDir, 'config', 'user.email', 'e2e@example.com'], { stdio: 'ignore' })
    spawnSync('git', ['-C', publisherDir, 'config', 'user.name', 'e2e'], { stdio: 'ignore' })

    const publisherIdentity = await createIdentity()
    await saveIdentity(publisherIdentity, publisherIdentityPath)
    const followerIdentity = await createIdentity()
    await saveIdentity(followerIdentity, followerIdentityPath)
    followerPubkey = followerIdentity.publicKey
    publisherPubkey = publisherIdentity.publicKey
    writeRecipients(join(publisherDir, 'recipients.txt'), [{ pubkey: followerPubkey, label: 'follower' }])

    // --- source DB: a shareable layer with one embedded memory, one scoped
    // memory, one private memory, and one retracted fact.
    const mgr = new DatabaseManager(sourceDbPath)
    const db = mgr.db
    const now = Date.now()
    db.prepare('INSERT INTO sessions(id, project_path, started_at, summary, tool_name) VALUES (?, ?, ?, ?, ?)').run(
      'sess1',
      HOME_NS,
      now,
      'Resolved and pushed PR #12345 from /Users/secret/path',
      'claude-code'
    )
    const insert = db.prepare(
      `INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable, vec_rowid)
       VALUES (?, 'sess1', ?, ?, ?, 0.8, '[]', ?, 0, ?, ?, ?)`
    )
    insert.run('m-embedded', HOME_NS, `We chose postgres over mysql for billing because of transactional DDL ${CANARY}`, 'decision', now, HOME_NS, 1, null)
    insert.run('m-scope', HOME_NS, 'The payments scope retries webhooks with exponential backoff', 'pattern', now, SCOPE_NS, 1, null)
    insert.run('m-private', HOME_NS, 'private note that must never ship', 'note', now, HOME_NS, 0, null)
    insert.run('m-stale', HOME_NS, 'stale fact the owner retracted', 'decision', now, HOME_NS, 1, null)
    insert.run('m-correction', HOME_NS, 'the correction, not itself shareable', 'decision', now, HOME_NS, 0, null)
    db.prepare(
      `INSERT INTO memory_links(source_id, target_id, similarity, created_at, link_type, confidence)
       VALUES ('m-correction', 'm-stale', 0.9, ?, 'supersedes', 0.95)`
    ).run(now)

    // A real embedding on the shareable memory: the export must carry it.
    const vec = db.prepare('INSERT INTO memory_vectors(embedding) VALUES (?)').run(Buffer.from(new Float32Array(EMBEDDING_DIM).buffer))
    db.prepare('UPDATE memories SET vec_rowid = ? WHERE id = ?').run(Number(vec.lastInsertRowid), 'm-embedded')
    mgr.close()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('ships only encrypted artifacts, keeps layers + embeddings, and answers an NL query', async () => {
    // Plaintext artifacts a naive `git add -A` would commit and push.
    writeFileSync(join(publisherDir, 'brain.db.export-99999.tmp'), `id,content\n1,${CANARY}\n`, 'utf8')
    writeFileSync(join(publisherDir, 'brain.db.bak.1234567890'), `plaintext backup ${CANARY}`, 'utf8')

    const published = await publishBrain({
      brainName,
      brainDir: publisherDir,
      sourceDbPath,
      namespace: HOME_NS,
      ownerPubkey: publisherPubkey,
      includeScopes: true,
      gitRemote: bare,
      dryRun: false,
    })

    // scoped layer included; private and retracted memories excluded
    expect(published.memoryCount).toBe(2)
    expect(published.pushed).toBe(true)

    // ---- the remote carries ONLY encrypted snapshot + metadata
    const tree = spawnSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter(Boolean)
      .sort()
    expect(tree).toEqual(['.gitignore', 'brain.db.age', 'manifest.json', 'recipients.txt'])

    // ---- no plaintext canary anywhere in the pushed history
    const canary = spawnSync('git', ['--git-dir', bare, 'grep', '-l', CANARY, 'main'], { encoding: 'utf8' })
    expect(canary.status).not.toBe(0)

    // ---- the one plaintext file on the remote (manifest.json) leaks no paths
    const manifest = spawnSync('git', ['--git-dir', bare, 'show', 'main:manifest.json'], { encoding: 'utf8' }).stdout
    expect(manifest.includes(homedir())).toBe(false)
    expect(manifest).toContain('"source_namespace": "~/proj"')

    // ---- a second identity follows it
    const followed = await followBrain({
      brainName,
      brainDir: followerDir,
      gitRemote: bare,
      identityPath: followerIdentityPath,
    })
    expect(followed.memoryCount).toBe(2)
    expect(followed.ownerPubkey).toBeTruthy()

    // ---- the followed brain answers a natural-language question
    const hits = await searchBrain(brainName, 'why did we pick postgres over mysql for billing', 5, followerRoot)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].content).toContain('postgres')

    // ---- layers survived redaction, and no owner path leaked into any table
    const cache = join(followerDir, '.cache', 'brain.db')
    const plain = new Database(cache, { readonly: true })
    const namespaces = (plain.prepare('SELECT DISTINCT namespace FROM memories').all() as Array<{ namespace: string }>).map(
      (r) => r.namespace
    )
    expect(namespaces.sort()).toEqual(['~/proj', '~/proj//payments'])
    for (const table of ['memories', 'sessions', 'memory_entities', 'memory_links']) {
      const rows = plain.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value !== 'string') continue
          expect(value.includes(homedir())).toBe(false)
          expect(value.includes('/Users/')).toBe(false)
        }
      }
    }
    plain.close()

    // ---- the retracted fact did not travel
    expect((await searchBrain(brainName, 'retracted', 10, followerRoot)).length).toBe(0)

    // ---- embeddings travelled: the snapshot carries the vector row
    const snap = new DatabaseManager(cache)
    const vectorRows = (snap.db.prepare('SELECT COUNT(*) AS c FROM memory_vectors').get() as { c: number }).c
    expect(vectorRows).toBe(1)
    snap.close()
  })

  it('excludes scoped layers unless includeScopes is set (default does not widen)', async () => {
    const published = await publishBrain({
      brainName,
      brainDir: publisherDir,
      sourceDbPath,
      namespace: HOME_NS,
      gitRemote: bare,
      dryRun: false,
    })
    expect(published.memoryCount).toBe(1)
  })
})
