import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import {
  isGitRepo,
  gitInit,
  gitAddFiles,
  gitCommit,
  gitSetRemote,
  gitPush,
  gitCurrentBranch,
} from './git.js'
import { acquireBrainLock } from './lock.js'
import { exportBrain, readManifestFromFile } from './snapshot.js'
import { encryptFileToRecipients } from './encrypt.js'
import { readRecipients } from './recipients.js'
import { logAudit } from './audit.js'

export interface PublishOptions {
  brainName: string
  brainDir: string
  sourceDbPath: string
  namespace: string
  /** also export synthetic //scopes and deeper layers */
  includeScopes?: boolean
  description?: string
  ownerName?: string | null
  ownerPubkey?: string | null
  gitRemote?: string | null
  dryRun: boolean
}

export interface PublishResult {
  memoryCount: number
  recipientCount: number
  committed: boolean
  pushed: boolean
  sha: string | null
}

export async function publishBrain(opts: PublishOptions): Promise<PublishResult> {
  const dbPath = join(opts.brainDir, 'brain.db')
  const encPath = join(opts.brainDir, 'brain.db.age')
  const manifestPath = join(opts.brainDir, 'manifest.json')
  const recipientsPath = join(opts.brainDir, 'recipients.txt')
  const gitignorePath = join(opts.brainDir, '.gitignore')

  // a dry run must not clobber a useful plaintext brain.db (search_brain and
  // get_brain_memory read it), so export into a temp file when one exists: export is
  // not idempotent over a file that already holds the same rows
  const hadExistingDb = existsSync(dbPath)
  const tmpExportPath = join(opts.brainDir, `brain.db.export-${process.pid}.tmp`)
  const exportTarget = hadExistingDb ? tmpExportPath : dbPath

  const source = new Database(opts.sourceDbPath, { readonly: true })
  let memoryCount = 0
  try {
    const result = exportBrain(source, {
      namespace: opts.namespace,
      includeScopes: opts.includeScopes,
      outputPath: exportTarget,
      description: opts.description,
      ownerName: opts.ownerName ?? undefined,
      ownerPubkey: opts.ownerPubkey ?? undefined,
    })
    memoryCount = result.memoryCount
  } finally {
    source.close()
  }

  const recipients = readRecipients(recipientsPath)
  if (recipients.length === 0) {
    // nothing was encrypted: clean up the plaintext this run wrote
    if (hadExistingDb && existsSync(tmpExportPath)) unlinkSync(tmpExportPath)
    else if (!hadExistingDb && existsSync(dbPath)) unlinkSync(dbPath)
    throw new Error(
      `No recipients in ${recipientsPath}. Add some with \`engram brain grant ${opts.brainName} <engram_pub_...>\` before publishing.`
    )
  }

  // on failure too (finally), but leave a pre-existing brain.db alone: it belongs to
  // an earlier export, not to this run
  let encrypted = false
  try {
    await encryptFileToRecipients(exportTarget, encPath, recipients)
    encrypted = true
  } finally {
    if (!encrypted) {
      if (hadExistingDb) {
        if (existsSync(tmpExportPath)) unlinkSync(tmpExportPath)
      } else if (existsSync(dbPath)) {
        unlinkSync(dbPath)
      }
    }
  }

  if (!opts.dryRun) {
    const manifest = readManifestFromFile(exportTarget)
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

    writeFileSync(
      gitignorePath,
      [
        '# engram brain: only ship encrypted snapshot + manifest + recipients',
        'brain.db',
        'brain.db-journal',
        'brain.db-wal',
        'brain.db-shm',
        // the migration runner writes a plaintext <db>.bak.<ts> before applying:
        // without these patterns, `git add -A` can commit an unencrypted copy of the
        // brain to the shared remote
        'brain.db.bak.*',
        '*.bak.*',
        'brain.db.export-*',
        '.cache/',
      ].join('\n') + '\n',
      'utf8'
    )

    // a real publish removes the plaintext db, so search_brain falls back to .cache or
    // asks for a re-export; a dry run keeps it usable over mcp
    if (existsSync(dbPath)) unlinkSync(dbPath)
  }

  if (hadExistingDb && existsSync(tmpExportPath)) unlinkSync(tmpExportPath)

  if (opts.dryRun) {
    return { memoryCount, recipientCount: recipients.length, committed: false, pushed: false, sha: null }
  }

  if (!isGitRepo(opts.brainDir)) {
    gitInit(opts.brainDir)
  }
  // remove transient plaintext, then stage only the encrypted snapshot and its
  // metadata. never `git add -A`: a concurrent publish or a migration sidecar has
  // pushed plaintext rows to a remote before. the allowlist is the guarantee, the
  // sweep is belt and braces.
  for (const stray of readdirSync(opts.brainDir)) {
    if (/^brain\.db\.export-.*\.tmp/.test(stray) || /\.bak\./.test(stray)) {
      try {
        unlinkSync(join(opts.brainDir, stray))
      } catch {
        // best effort; the explicit add below is what protects the remote
      }
    }
  }
  // serialize the mutating section: two publishes would interleave commits and see
  // each other's temp export. released in the finally below, and declared outside the
  // try because they are read after that release.
  let commitResult: { committed: boolean; sha: string | null } = { committed: false, sha: null }
  let pushed = false
  const lock = acquireBrainLock(opts.brainDir)
  try {
  gitAddFiles(opts.brainDir, ['brain.db.age', 'manifest.json', 'recipients.txt', '.gitignore'])
  commitResult = gitCommit(opts.brainDir, `engram brain: publish ${memoryCount} memories`)

  if (opts.gitRemote) {
    gitSetRemote(opts.brainDir, 'origin', opts.gitRemote)
    const branch = gitCurrentBranch(opts.brainDir)
    gitPush(opts.brainDir, 'origin', branch)
    pushed = true
  }

  } finally {
    lock.release()
  }
  logAudit({
    type: 'brain_publish',
    brain: opts.brainName,
    memory_count: memoryCount,
    recipients: recipients.length,
  })

  return {
    memoryCount,
    recipientCount: recipients.length,
    committed: commitResult.committed,
    pushed,
    sha: commitResult.sha,
  }
}
