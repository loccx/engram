import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseManager } from '../src/db/init.js'
import { createIdentity } from '../src/brains/identity.js'
import { writeRecipients } from '../src/brains/recipients.js'
import { publishBrain } from '../src/brains/publish.js'

// Toggleable encryption failure to exercise the deterministic cleanup path.
const state = vi.hoisted(() => ({ failEncrypt: false }))

vi.mock('../src/brains/encrypt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/brains/encrypt.js')>()
  return {
    ...actual,
    encryptFileToRecipients: async (sourcePath: string, destPath: string, recipients: unknown[]) => {
      if (state.failEncrypt) throw new Error('encryption boom (test)')
      return actual.encryptFileToRecipients(
        sourcePath,
        destPath,
        recipients as Parameters<typeof actual.encryptFileToRecipients>[2]
      )
    },
  }
})

describe('brains/publish dry-run safety', () => {
  let tmp: string
  let brainDir: string
  let sourceDbPath: string
  let alice: Awaited<ReturnType<typeof createIdentity>>

  beforeEach(async () => {
    state.failEncrypt = false
    tmp = mkdtempSync(join(tmpdir(), 'engram-publish-'))
    brainDir = join(tmp, 'brain-work')
    mkdirSync(brainDir, { recursive: true })
    alice = await createIdentity()
    writeRecipients(join(brainDir, 'recipients.txt'), [{ pubkey: alice.publicKey, label: 'alice' }])

    sourceDbPath = join(tmp, 'engram.db')
    const mgr = new DatabaseManager(sourceDbPath)
    mgr.db
      .prepare('INSERT INTO sessions(id, project_path, started_at) VALUES (?, ?, ?)')
      .run('s1', '/proj', Date.now())
    mgr.db
      .prepare(
        'INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run('m1', 's1', '/proj', 'shared fact', 'note', 0.5, '[]', Date.now(), 0, 'work', 1)
    mgr.close()
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('dry-run never deletes plaintext brain.db and does not mutate local sidecars', async () => {
    const result = await publishBrain({
      brainName: 'work',
      brainDir,
      sourceDbPath,
      namespace: 'work',
      ownerPubkey: alice.publicKey,
      dryRun: true,
    })

    expect(result.committed).toBe(false)
    expect(result.pushed).toBe(false)
    // The most important contract: search_brain/get_brain_memory keep a
    // usable plaintext db after a dry-run.
    expect(existsSync(join(brainDir, 'brain.db'))).toBe(true)
    // The encrypted artifact is still produced so the pipeline is verified.
    expect(existsSync(join(brainDir, 'brain.db.age'))).toBe(true)
    // No manifest rewrite, no .gitignore mutation, no git repo creation.
    expect(existsSync(join(brainDir, 'manifest.json'))).toBe(false)
    expect(existsSync(join(brainDir, '.gitignore'))).toBe(false)
    expect(existsSync(join(brainDir, '.git'))).toBe(false)
  })

  it('dry-run leaves a pre-existing manifest.json untouched', async () => {
    const prior = { schema_version: 6, exported_at: 123, keep: true }
    writeFileSync(join(brainDir, 'manifest.json'), JSON.stringify(prior))

    await publishBrain({
      brainName: 'work',
      brainDir,
      sourceDbPath,
      namespace: 'work',
      ownerPubkey: alice.publicKey,
      dryRun: true,
    })

    expect(JSON.parse(readFileSync(join(brainDir, 'manifest.json'), 'utf8'))).toEqual(prior)
  })

  it('encryption failure deterministically removes the freshly-exported plaintext brain.db', async () => {
    state.failEncrypt = true
    await expect(
      publishBrain({
        brainName: 'work',
        brainDir,
        sourceDbPath,
        namespace: 'work',
        ownerPubkey: alice.publicKey,
        dryRun: true,
      })
    ).rejects.toThrow(/encryption boom \(test\)/)

    // No orphan plaintext lingers after a failed run.
    expect(existsSync(join(brainDir, 'brain.db'))).toBe(false)
    expect(existsSync(join(brainDir, 'brain.db.age'))).toBe(false)
  })

  it('encryption failure preserves a useful pre-existing plaintext brain.db', async () => {
    // Produce a real, useful pre-existing export (what search_brain reads).
    await publishBrain({
      brainName: 'work',
      brainDir,
      sourceDbPath,
      namespace: 'work',
      ownerPubkey: alice.publicKey,
      dryRun: true,
    })
    expect(existsSync(join(brainDir, 'brain.db'))).toBe(true)

    state.failEncrypt = true
    await expect(
      publishBrain({
        brainName: 'work',
        brainDir,
        sourceDbPath,
        namespace: 'work',
        ownerPubkey: alice.publicKey,
        dryRun: true,
      })
    ).rejects.toThrow(/encryption boom \(test\)/)

    // The pre-existing db is NOT deleted by the failure cleanup.
    expect(existsSync(join(brainDir, 'brain.db'))).toBe(true)
  })
})
