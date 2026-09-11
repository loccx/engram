import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { gitClone, gitPull, gitHeadSha } from './git.js'
import { decryptFileWithIdentity } from './encrypt.js'
import { readManifestFromFile, validateForImport } from './snapshot.js'
import { loadIdentity } from './identity.js'
import { logAudit } from './audit.js'

export interface FollowOptions {
  brainName: string
  brainDir: string
  gitRemote: string
}

export interface FollowResult {
  memoryCount: number
  ownerName: string | null
  ownerPubkey: string | null
  sha: string
}

export async function followBrain(opts: FollowOptions): Promise<FollowResult> {
  if (existsSync(opts.brainDir)) {
    throw new Error(`Brain dir already exists at ${opts.brainDir}. Use \`engram brain refresh\` instead.`)
  }
  gitClone(opts.gitRemote, opts.brainDir)
  const sha = gitHeadSha(opts.brainDir)
  const result = await decryptAndValidate(opts.brainDir)
  logAudit({ type: 'brain_follow', brain: opts.brainName, git_remote: opts.gitRemote })
  return { ...result, sha }
}

export interface RefreshOptions {
  brainName: string
  brainDir: string
}

export async function refreshBrain(opts: RefreshOptions): Promise<{ updated: boolean; memoryCount: number; sha: string }> {
  if (!existsSync(opts.brainDir)) {
    throw new Error(`Brain dir not found at ${opts.brainDir}. Use \`engram brain follow\` first.`)
  }
  const pullResult = gitPull(opts.brainDir)
  if (!pullResult.updated) {
    const cachedDb = join(opts.brainDir, '.cache', 'brain.db')
    if (existsSync(cachedDb)) {
      const target = new Database(cachedDb, { readonly: true })
      const count = (target.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c
      target.close()
      return { updated: false, memoryCount: count, sha: pullResult.sha }
    }
  }
  const result = await decryptAndValidate(opts.brainDir)
  logAudit({ type: 'brain_refresh', brain: opts.brainName, memory_count: result.memoryCount })
  return { updated: true, memoryCount: result.memoryCount, sha: pullResult.sha }
}

async function decryptAndValidate(brainDir: string): Promise<{ memoryCount: number; ownerName: string | null; ownerPubkey: string | null }> {
  const encPath = join(brainDir, 'brain.db.age')
  if (!existsSync(encPath)) {
    throw new Error(`No brain.db.age in ${brainDir}. Remote may be empty or non-encrypted.`)
  }
  const cacheDir = join(brainDir, '.cache')
  mkdirSync(cacheDir, { recursive: true })
  const cachedDb = join(cacheDir, 'brain.db')
  if (existsSync(cachedDb)) unlinkSync(cachedDb)

  const identity = await loadIdentity()
  try {
    await decryptFileWithIdentity(encPath, cachedDb, identity)
  } catch (err) {
    throw new Error(
      `Decryption failed: ${(err as Error).message}. You may not be a recipient of this brain.`
    )
  }

  const manifest = readManifestFromFile(cachedDb)
  const validationErr = validateForImport(manifest)
  if (validationErr) {
    unlinkSync(cachedDb)
    throw new Error(`Brain validation failed (${validationErr.kind}): ${validationErr.message}`)
  }

  return {
    memoryCount: manifest.memory_count,
    ownerName: manifest.owner_name,
    ownerPubkey: manifest.owner_pubkey,
  }
}
