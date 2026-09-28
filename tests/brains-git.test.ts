import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import Database from 'better-sqlite3'
import { DatabaseManager } from '../src/db/init.js'
import { createIdentity, saveIdentity } from '../src/brains/identity.js'
import { writeRecipients } from '../src/brains/recipients.js'
import { publishBrain } from '../src/brains/publish.js'
import { followBrain, refreshBrain } from '../src/brains/follow.js'

const gitAvailable = spawnSync('git', ['--version']).status === 0

describe.skipIf(!gitAvailable)('brains/git e2e', () => {
  let tmp: string
  let bareRepo: string
  let publisherDir: string
  let publisherDbPath: string
  let followerDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-git-e2e-'))
    bareRepo = join(tmp, 'bare-remote.git')
    publisherDir = join(tmp, 'publisher-brain')
    followerDir = join(tmp, 'follower-brain')
    spawnSync('git', ['init', '--bare', '-b', 'main', bareRepo], { stdio: 'ignore' })

    publisherDbPath = join(tmp, 'engram.db')
    const mgr = new DatabaseManager(publisherDbPath)
    mgr.db.prepare('INSERT INTO sessions(id, project_path, started_at) VALUES (?, ?, ?)').run('s1', '/p', Date.now())
    mgr.db
      .prepare(
        'INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run('m1', 's1', '/p', 'shared memory one', 'note', 0.5, '[]', Date.now(), 0, 'work', 1)
    mgr.db
      .prepare(
        'INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run('m2', 's1', '/p', 'private memory two', 'note', 0.5, '[]', Date.now(), 0, 'work', 0)
    mgr.close()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  async function setupPublisherBrain(recipientPubkeys: string[]): Promise<void> {
    const fs = await import('fs')
    fs.mkdirSync(publisherDir, { recursive: true })
    writeRecipients(
      join(publisherDir, 'recipients.txt'),
      recipientPubkeys.map((p) => ({ pubkey: p, label: null }))
    )
    spawnSync('git', ['init', '-b', 'main', publisherDir], { stdio: 'ignore' })
    spawnSync('git', ['-C', publisherDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' })
    spawnSync('git', ['-C', publisherDir, 'config', 'user.name', 'test'], { stdio: 'ignore' })
  }

  it('publish → follow → refresh full cycle with single recipient', async () => {
    const alice = await createIdentity()
    const aliceHome = join(tmp, 'alice-home')
    const aliceIdPath = join(aliceHome, 'identity')
    await saveIdentity(alice, aliceIdPath)

    await setupPublisherBrain([alice.publicKey])

    const publishResult = await publishBrain({
      brainName: 'work',
      brainDir: publisherDir,
      sourceDbPath: publisherDbPath,
      namespace: 'work',
      description: 'test',
      ownerPubkey: alice.publicKey,
      gitRemote: bareRepo,
      dryRun: false,
    })
    expect(publishResult.memoryCount).toBe(1)
    expect(publishResult.recipientCount).toBe(1)
    expect(publishResult.committed).toBe(true)
    expect(publishResult.pushed).toBe(true)
    expect(existsSync(join(publisherDir, 'brain.db.age'))).toBe(true)
    expect(existsSync(join(publisherDir, 'manifest.json'))).toBe(true)
    expect(existsSync(join(publisherDir, 'brain.db'))).toBe(false)

    const origHome = process.env.ENGRAM_IDENTITY_OVERRIDE
    process.env.ENGRAM_IDENTITY_OVERRIDE = aliceIdPath
    try {
      const { loadIdentity } = await import('../src/brains/identity.js')
      const id = await loadIdentity(aliceIdPath)
      expect(id.publicKey).toBe(alice.publicKey)

      const followIdentity = async () => loadIdentity(aliceIdPath)
      const followResult = await followBrainWithCustomIdentity(
        { brainName: 'work', brainDir: followerDir, gitRemote: bareRepo },
        followIdentity
      )
      expect(followResult.memoryCount).toBe(1)
      expect(followResult.ownerPubkey).toBe(alice.publicKey)
      expect(existsSync(join(followerDir, '.cache', 'brain.db'))).toBe(true)
    } finally {
      if (origHome === undefined) delete process.env.ENGRAM_IDENTITY_OVERRIDE
      else process.env.ENGRAM_IDENTITY_OVERRIDE = origHome
    }
  })

  it('non-recipient cannot decrypt brain (follow fails)', async () => {
    const alice = await createIdentity()
    const eve = await createIdentity()
    const eveIdPath = join(tmp, 'eve-id')
    await saveIdentity(eve, eveIdPath)

    await setupPublisherBrain([alice.publicKey])

    await publishBrain({
      brainName: 'work',
      brainDir: publisherDir,
      sourceDbPath: publisherDbPath,
      namespace: 'work',
      ownerPubkey: alice.publicKey,
      gitRemote: bareRepo,
      dryRun: false,
    })

    const { loadIdentity } = await import('../src/brains/identity.js')
    await expect(
      followBrainWithCustomIdentity(
        { brainName: 'work', brainDir: followerDir, gitRemote: bareRepo },
        () => loadIdentity(eveIdPath)
      )
    ).rejects.toThrow(/decryption failed|not a recipient/i)
  })

  it('refresh detects no change when remote HEAD did not move', async () => {
    const alice = await createIdentity()
    const aliceIdPath = join(tmp, 'alice-id')
    await saveIdentity(alice, aliceIdPath)
    await setupPublisherBrain([alice.publicKey])

    await publishBrain({
      brainName: 'work',
      brainDir: publisherDir,
      sourceDbPath: publisherDbPath,
      namespace: 'work',
      ownerPubkey: alice.publicKey,
      gitRemote: bareRepo,
      dryRun: false,
    })

    const { loadIdentity } = await import('../src/brains/identity.js')
    await followBrainWithCustomIdentity(
      { brainName: 'work', brainDir: followerDir, gitRemote: bareRepo },
      () => loadIdentity(aliceIdPath)
    )
    const refreshResult = await refreshBrainWithCustomIdentity(
      { brainName: 'work', brainDir: followerDir },
      () => loadIdentity(aliceIdPath)
    )
    expect(refreshResult.updated).toBe(false)
    expect(refreshResult.memoryCount).toBe(1)
  })
})

async function followBrainWithCustomIdentity(
  opts: { brainName: string; brainDir: string; gitRemote: string },
  identityLoader: () => Promise<{ privateKey: string; publicKey: string }>
): Promise<{ memoryCount: number; ownerPubkey: string | null; sha: string }> {
  const { gitClone, gitHeadSha } = await import('../src/brains/git.js')
  const { decryptFileWithIdentity } = await import('../src/brains/encrypt.js')
  const { readManifestFromFile, validateForImport } = await import('../src/brains/snapshot.js')
  const fs = await import('fs')
  const { join } = await import('path')

  if (fs.existsSync(opts.brainDir)) throw new Error('exists')
  gitClone(opts.gitRemote, opts.brainDir)
  const sha = gitHeadSha(opts.brainDir)
  const encPath = join(opts.brainDir, 'brain.db.age')
  const cacheDir = join(opts.brainDir, '.cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const cachedDb = join(cacheDir, 'brain.db')
  const identity = await identityLoader()
  try {
    await decryptFileWithIdentity(encPath, cachedDb, identity)
  } catch (err) {
    throw new Error(`Decryption failed: ${(err as Error).message}. You may not be a recipient.`)
  }
  const manifest = readManifestFromFile(cachedDb)
  const v = validateForImport(manifest)
  if (v) throw new Error(`Validation failed: ${v.message}`)
  return { memoryCount: manifest.memory_count, ownerPubkey: manifest.owner_pubkey, sha }
}

async function refreshBrainWithCustomIdentity(
  opts: { brainName: string; brainDir: string },
  identityLoader: () => Promise<{ privateKey: string; publicKey: string }>
): Promise<{ updated: boolean; memoryCount: number; sha: string }> {
  const { gitPull } = await import('../src/brains/git.js')
  const { decryptFileWithIdentity } = await import('../src/brains/encrypt.js')
  const { readManifestFromFile } = await import('../src/brains/snapshot.js')
  const fs = await import('fs')
  const { join } = await import('path')

  const pull = gitPull(opts.brainDir)
  const cachedDb = join(opts.brainDir, '.cache', 'brain.db')
  if (!pull.updated && fs.existsSync(cachedDb)) {
    const target = new Database(cachedDb, { readonly: true })
    const count = (target.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c
    target.close()
    return { updated: false, memoryCount: count, sha: pull.sha }
  }
  const encPath = join(opts.brainDir, 'brain.db.age')
  if (fs.existsSync(cachedDb)) fs.unlinkSync(cachedDb)
  const identity = await identityLoader()
  await decryptFileWithIdentity(encPath, cachedDb, identity)
  const manifest = readManifestFromFile(cachedDb)
  return { updated: true, memoryCount: manifest.memory_count, sha: pull.sha }
}
