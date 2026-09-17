import envPaths from 'env-paths'
import { mkdirSync } from 'fs'
import { join } from 'path'

/**
 * All engram-brains user state lives under a single root directory so users
 * can back it up, sync it across machines, or wipe it with one `rm -rf`.
 *
 * macOS:   ~/Library/Application Support/engram-nodejs/brains/
 * Linux:   $XDG_DATA_HOME/engram-nodejs/brains/  (defaults to ~/.local/share/...)
 * Windows: %APPDATA%/engram-nodejs/Data/brains/
 *
 * We reuse env-paths('engram') — the same prefix used by the SQLite DB — so
 * everything engram owns lives in one place.
 */
const paths = envPaths('engram')

export const ENGRAM_HOME = paths.data
export const IDENTITY_FILE = join(ENGRAM_HOME, 'identity')
export const BRAINS_CONFIG_FILE = join(ENGRAM_HOME, 'brains-config.json')
/** Overridable so tests never append to the real ~/…/engram-nodejs/audit.log. */
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
 * Brain names live on disk as directory names and in git remotes. Whitelist
 * filename-safe characters only; reject everything else so we never produce
 * a path traversal vector when a user types `engram brain follow ../../../etc/passwd`.
 */
export function sanitizeBrainName(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Brain name "${name}" is invalid. Allowed: letters, digits, hyphen, underscore.`
    )
  }
  return name
}
