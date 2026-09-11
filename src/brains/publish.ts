import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import {
  isGitRepo,
  gitInit,
  gitAddAll,
  gitCommit,
  gitSetRemote,
  gitPush,
  gitCurrentBranch,
} from './git.js'
import { exportBrain, readManifestFromFile } from './snapshot.js'
import { encryptFileToRecipients } from './encrypt.js'
import { readRecipients } from './recipients.js'
import { logAudit } from './audit.js'

export interface PublishOptions {
  brainName: string
  brainDir: string
  sourceDbPath: string
  namespace: string
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

  // A dry-run must not destroy a useful pre-existing plaintext brain.db
  // (MCP search_brain / get_brain_memory depend on it). When one exists,
  // export into a throwaway temp file instead of clobbering it — export is
  // not idempotent over a file that already contains the same rows.
  const hadExistingDb = existsSync(dbPath)
  const tmpExportPath = join(opts.brainDir, `brain.db.export-${process.pid}.tmp`)
  const exportTarget = hadExistingDb ? tmpExportPath : dbPath

  const source = new Database(opts.sourceDbPath, { readonly: true })
  let memoryCount = 0
  try {
    const result = exportBrain(source, {
      namespace: opts.namespace,
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
    // Nothing was encrypted: clean up any plaintext this run wrote.
    if (hadExistingDb && existsSync(tmpExportPath)) unlinkSync(tmpExportPath)
    else if (!hadExistingDb && existsSync(dbPath)) unlinkSync(dbPath)
    throw new Error(
      `No recipients in ${recipientsPath}. Add some with \`engram brain grant ${opts.brainName} <engram_pub_...>\` before publishing.`
    )
  }

  // Encryption failure must clean up the plaintext this run exported,
  // deterministically (finally). A pre-existing brain.db is preserved: it
  // belongs to a previous (useful) export, not to this failed run.
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
        '.cache/',
      ].join('\n') + '\n',
      'utf8'
    )

    // Real publish removes the plaintext DB; search_brain then falls back to
    // the .cache copy or tells the user to re-export. Dry-runs keep it so the
    // owned brain stays usable for MCP access.
    if (existsSync(dbPath)) unlinkSync(dbPath)
  }

  if (hadExistingDb && existsSync(tmpExportPath)) unlinkSync(tmpExportPath)

  if (opts.dryRun) {
    return { memoryCount, recipientCount: recipients.length, committed: false, pushed: false, sha: null }
  }

  if (!isGitRepo(opts.brainDir)) {
    gitInit(opts.brainDir)
  }
  gitAddAll(opts.brainDir)
  const commitResult = gitCommit(opts.brainDir, `engram brain: publish ${memoryCount} memories`)

  let pushed = false
  if (opts.gitRemote) {
    gitSetRemote(opts.brainDir, 'origin', opts.gitRemote)
    const branch = gitCurrentBranch(opts.brainDir)
    gitPush(opts.brainDir, 'origin', branch)
    pushed = true
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
