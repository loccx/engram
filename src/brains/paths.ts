import envPaths from 'env-paths'
import { mkdirSync } from 'fs'
import { join } from 'path'

/**
 * one root for all brain state, so it can be backed up, synced, or wiped with a
 * single rm -rf: env-paths('engram')/brains, the same prefix the sqlite db uses
 */
const paths = envPaths('engram')

export const ENGRAM_HOME = paths.data
export const IDENTITY_FILE = join(ENGRAM_HOME, 'identity')
export const BRAINS_CONFIG_FILE = join(ENGRAM_HOME, 'brains-config.json')
/** overridable so tests never append to the real audit log */
export const AUDIT_LOG_FILE = process.env.ENGRAM_AUDIT_LOG ?? join(ENGRAM_HOME, 'audit.log')
export const BRAINS_DIR = join(ENGRAM_HOME, 'brains')

export function brainDir(name: string): string {
  return join(BRAINS_DIR, sanitizeBrainName(name))
}

export function brainCacheDir(name: string): string {
  return join(brainDir(name), '.cache')
}

export function brainSnapshotPath(name: string, encrypted: boolean): string {
  return join(brainDir(name), encrypted ? 'snapshot.brain.age' : 'snapshot.brain')
}

export function brainRecipientsPath(name: string): string {
  return join(brainDir(name), 'recipients.txt')
}

export function brainManifestPath(name: string): string {
  return join(brainDir(name), 'manifest.json')
}

export function brainDecryptedCachePath(name: string): string {
  return join(brainCacheDir(name), 'decrypted.brain')
}

export function ensureEngramHome(): void {
  mkdirSync(ENGRAM_HOME, { recursive: true })
  mkdirSync(BRAINS_DIR, { recursive: true })
}

export function ensureBrainDir(name: string): string {
  const dir = brainDir(name)
  mkdirSync(dir, { recursive: true })
  mkdirSync(brainCacheDir(name), { recursive: true })
  return dir
}

/**
 * filename-safe characters only: a name becomes a directory and a git remote, so
 * `brain follow ../../../etc/passwd` must not become a path traversal
 */
export function sanitizeBrainName(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Brain name "${name}" is invalid. Allowed: letters, digits, hyphen, underscore.`
    )
  }
  return name
}
