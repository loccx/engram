import { Command } from 'commander'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { ENGRAM_HOME, BRAINS_DIR, IDENTITY_FILE, sanitizeBrainName } from '../brains/paths.js'
import { createIdentity, saveIdentity, loadIdentity, identityExists } from '../brains/identity.js'
import { exportBrain, readManifestFromFile, validateForImport } from '../brains/snapshot.js'
import { addRecipient, removeRecipient, readRecipients } from '../brains/recipients.js'
import { encryptFileToRecipients, decryptFileWithIdentity } from '../brains/encrypt.js'
import { logAudit } from '../brains/audit.js'
import { publishBrain } from '../brains/publish.js'
import { followBrain, refreshBrain } from '../brains/follow.js'
import { getBrainConfig, setBrainConfig } from '../brains/config.js'

export function registerBrainCommands(program: Command): void {
  program
    .command('init')
    .description(`Initialize engram identity (generates ${IDENTITY_FILE})`)
    .option('-f, --force', 'overwrite existing identity', false)
    .action(async (opts: { force: boolean }) => {
      if (identityExists() && !opts.force) {
        const existing = await loadIdentity()
        console.log(`Identity already exists at ${IDENTITY_FILE}`)
        console.log(`Public key: ${existing.publicKey}`)
        console.log(`Use --force to regenerate (destroys access to brains encrypted to old key).`)
        return
      }
      const identity = await createIdentity()
      await saveIdentity(identity)
      console.log(`Created engram identity at ${IDENTITY_FILE}`)
      console.log(`Public key (share this with brain owners): ${identity.publicKey}`)
    })

  program
    .command('whoami')
    .description('Print this engram identity public key')
    .action(async () => {
      if (!identityExists()) {
        console.error(`No identity found. Run \`engram init\` first.`)
        process.exitCode = 1
        return
      }
      const identity = await loadIdentity()
      console.log(identity.publicKey)
    })

  const brain = program.command('brain').description('Manage shareable engram brains')

  brain
    .command('init <name>')
    .description(`Create a new local brain directory (${BRAINS_DIR}/<name>/)`)
    .option('-n, --namespace <namespace>', 'Engram namespace to source memories from', 'default')
    .option('-d, --description <text>', 'Brain description')
    .action((name: string, opts: { namespace: string; description?: string }) => {
      const safe = sanitizeBrainName(name)
      const dir = join(BRAINS_DIR, safe)
      if (existsSync(dir)) {
        console.error(`Brain "${safe}" already exists at ${dir}`)
        process.exitCode = 1
        return
      }
      mkdirSync(dir, { recursive: true })
      setBrainConfig(safe, { namespace: opts.namespace, description: opts.description })
      console.log(`Created brain "${safe}" at ${dir}`)
      console.log(`  namespace: ${opts.namespace}`)
      if (opts.description) console.log(`  description: ${opts.description}`)
      console.log(`Next: run \`engram brain export ${safe}\` to snapshot shareable memories.`)
    })

  brain
    .command('export <name>')
    .description('Export shareable memories from a namespace into the brain snapshot')
    .option('-n, --namespace <namespace>', 'Engram namespace (default: the namespace recorded at brain init)')
    .option('-d, --description <text>', 'Brain description (stored in manifest)')
    .option('--include-scopes', 'Also export descendant layers (<ns>//<scope> and deeper)', false)
    .option('--db <path>', 'Source engram.db path', join(ENGRAM_HOME, 'engram.db'))
    .action(async (name: string, opts: { namespace?: string; description?: string; includeScopes: boolean; db: string }) => {
      const safe = sanitizeBrainName(name)
      const brainDir = join(BRAINS_DIR, safe)
      if (!existsSync(brainDir)) {
        console.error(`Brain "${safe}" not found. Run \`engram brain init ${safe}\` first.`)
        process.exitCode = 1
        return
      }
      if (!existsSync(opts.db)) {
        console.error(`Source engram.db not found at ${opts.db}`)
        process.exitCode = 1
        return
      }
      const config = getBrainConfig(safe)
      const namespace = opts.namespace ?? config?.namespace ?? 'default'
      const identity = identityExists() ? await loadIdentity() : null
      const source = new Database(opts.db, { readonly: true })
      try {
        const outputPath = join(brainDir, 'brain.db')
        // exportBrain cannot re-use a populated target (memories PK insert), so
        // a second `brain export` used to fail outright. Export into a staging
        // file and rename: repeatable, and the swap is atomic.
        const stagingPath = `${outputPath}.staging-${process.pid}`
        let result: ReturnType<typeof exportBrain>
        try {
          result = exportBrain(source, {
            namespace,
            outputPath: stagingPath,
            description: opts.description ?? config?.description,
            ownerPubkey: identity?.publicKey,
            includeScopes: opts.includeScopes,
          })
        } catch (err) {
          if (existsSync(stagingPath)) unlinkSync(stagingPath)
          throw err
        }
        renameSync(stagingPath, outputPath)
        console.log(`Exported ${result.memoryCount} shareable memories to ${outputPath}`)
        console.log(
          `  namespace:  ${result.manifest.source_namespace}${opts.includeScopes ? ' (+ descendant layers)' : ''}`
        )
        console.log(`  embedding_model: ${result.manifest.embedding_model}`)
        console.log(`  owner_pubkey: ${result.manifest.owner_pubkey ?? '(none — run \`engram init\`)'}`)
      } finally {
        source.close()
      }
    })

  brain
    .command('grant <name> <pubkey>')
    .description('Add an engram_pub_ recipient to a brain\'s whitelist')
    .option('-l, --label <text>', 'Friendly label (e.g. recipient name)')
    .action((name: string, pubkey: string, opts: { label?: string }) => {
      const safe = sanitizeBrainName(name)
      const brainDir = join(BRAINS_DIR, safe)
      if (!existsSync(brainDir)) {
        console.error(`Brain "${safe}" not found.`)
        process.exitCode = 1
        return
      }
      const recipientsPath = join(brainDir, 'recipients.txt')
      try {
        const result = addRecipient(recipientsPath, pubkey, opts.label)
        if (result.added) {
          logAudit({ type: 'brain_grant', brain: safe, pubkey })
          console.log(`Granted access to ${pubkey}${opts.label ? ` (${opts.label})` : ''}`)
        } else {
          console.log(`${pubkey} already has access.`)
        }
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
      }
    })

  brain
    .command('revoke <name> <pubkey>')
    .description('Remove an engram_pub_ recipient from a brain\'s whitelist')
    .action((name: string, pubkey: string) => {
      const safe = sanitizeBrainName(name)
      const recipientsPath = join(BRAINS_DIR, safe, 'recipients.txt')
      const result = removeRecipient(recipientsPath, pubkey)
      if (result.removed) {
        logAudit({ type: 'brain_revoke', brain: safe, pubkey })
        console.log(`Revoked access from ${pubkey}.`)
        console.log(`(They retain access to existing snapshots they have decrypted; rotate by re-encrypting.)`)
      } else {
        console.log(`${pubkey} was not in recipients list.`)
      }
    })

  brain
    .command('encrypt <name>')
    .description('Encrypt brain.db to brain.db.age using current recipients whitelist')
    .action(async (name: string) => {
      const safe = sanitizeBrainName(name)
      const brainDir = join(BRAINS_DIR, safe)
      const dbPath = join(brainDir, 'brain.db')
      const recipientsPath = join(brainDir, 'recipients.txt')
      const encPath = join(brainDir, 'brain.db.age')
      if (!existsSync(dbPath)) {
        console.error(`No brain.db at ${dbPath}. Run \`engram brain export ${safe}\` first.`)
        process.exitCode = 1
        return
      }
      const recipients = readRecipients(recipientsPath)
      if (recipients.length === 0) {
        console.error(
          `No recipients in ${recipientsPath}. Add some with \`engram brain grant ${safe} <engram_pub_...>\`.`
        )
        process.exitCode = 1
        return
      }
      try {
        await encryptFileToRecipients(dbPath, encPath, recipients)
        console.log(`Encrypted ${dbPath} → ${encPath} for ${recipients.length} recipient(s).`)
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
      }
    })

  brain
    .command('decrypt <encPath> <outPath>')
    .description('Decrypt a brain.db.age file using local identity')
    .action(async (encPath: string, outPath: string) => {
      if (!existsSync(encPath)) {
        console.error(`File not found: ${encPath}`)
        process.exitCode = 1
        return
      }
      if (!identityExists()) {
        console.error(`No identity at ${IDENTITY_FILE}. Run \`engram init\` first.`)
        process.exitCode = 1
        return
      }
      const identity = await loadIdentity()
      try {
        await decryptFileWithIdentity(encPath, outPath, identity)
        console.log(`Decrypted ${encPath} → ${outPath}`)
      } catch (err) {
        console.error(`Decryption failed: ${(err as Error).message}`)
        console.error(`(You may not be a recipient of this brain.)`)
        process.exitCode = 1
      }
    })

  brain
    .command('publish <name>')
    .description('Snapshot + encrypt + git commit/push (use --confirm to actually push)')
    .option('-n, --namespace <namespace>', 'Engram namespace (default: the namespace recorded at brain init)')
    .option('-d, --description <text>', 'Brain description (stored in manifest)')
    .option('--include-scopes', 'Also export descendant layers (<ns>//<scope> and deeper)', false)
    .option('--db <path>', 'Source engram.db path', join(ENGRAM_HOME, 'engram.db'))
    .option('--remote <url>', 'Git remote URL (e.g. git@github.com:you/brain-work.git)')
    .option('--confirm', 'Actually commit + push (default is dry-run)', false)
    .action(async (name: string, opts: { namespace?: string; description?: string; includeScopes: boolean; db: string; remote?: string; confirm: boolean }) => {
      const safe = sanitizeBrainName(name)
      const brainDir = join(BRAINS_DIR, safe)
      if (!existsSync(brainDir)) {
        console.error(`Brain "${safe}" not found. Run \`engram brain init ${safe}\` first.`)
        process.exitCode = 1
        return
      }
      if (!existsSync(opts.db)) {
        console.error(`Source engram.db not found at ${opts.db}`)
        process.exitCode = 1
        return
      }
      const config = getBrainConfig(safe)
      const namespace = opts.namespace ?? config?.namespace ?? 'default'
      const identity = identityExists() ? await loadIdentity() : null
      try {
        const result = await publishBrain({
          brainName: safe,
          brainDir,
          sourceDbPath: opts.db,
          namespace,
          includeScopes: opts.includeScopes,
          description: opts.description ?? config?.description,
          ownerPubkey: identity?.publicKey ?? null,
          gitRemote: opts.remote ?? null,
          dryRun: !opts.confirm,
        })
        console.log(`Publish ${opts.confirm ? 'COMPLETE' : 'DRY-RUN'}:`)
        console.log(`  namespace:  ${namespace}${opts.includeScopes ? ' (+ descendant layers)' : ''}`)
        console.log(`  memories:   ${result.memoryCount}`)
        console.log(`  recipients: ${result.recipientCount}`)
        console.log(`  committed:  ${result.committed}${result.sha ? ` (${result.sha.slice(0, 8)})` : ''}`)
        console.log(`  pushed:     ${result.pushed}`)
        if (!opts.confirm) {
          console.log(`\nRun with --confirm to commit and push.`)
        }
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
      }
    })

  brain
    .command('follow <name> <gitRemote>')
    .description(`Clone + decrypt + validate a remote brain into ${BRAINS_DIR}/<name>/`)
    .action(async (name: string, gitRemote: string) => {
      const safe = sanitizeBrainName(name)
      const brainDir = join(BRAINS_DIR, safe)
      if (existsSync(brainDir)) {
        console.error(`Brain "${safe}" already exists at ${brainDir}.`)
        process.exitCode = 1
        return
      }
      if (!identityExists()) {
        console.error(`No identity at ${IDENTITY_FILE}. Run \`engram init\` first.`)
        process.exitCode = 1
        return
      }
      mkdirSync(BRAINS_DIR, { recursive: true })
      try {
        const result = await followBrain({ brainName: safe, brainDir, gitRemote })
        console.log(`Followed brain "${safe}":`)
        console.log(`  memories:     ${result.memoryCount}`)
        console.log(`  owner_name:   ${result.ownerName ?? '(unknown)'}`)
        console.log(`  owner_pubkey: ${result.ownerPubkey ?? '(unknown)'}`)
        console.log(`  HEAD:         ${result.sha.slice(0, 8)}`)
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
      }
    })

  brain
    .command('refresh <name>')
    .description('Pull + re-decrypt a followed brain')
    .action(async (name: string) => {
      const safe = sanitizeBrainName(name)
      const brainDir = join(BRAINS_DIR, safe)
      try {
        const result = await refreshBrain({ brainName: safe, brainDir })
        console.log(`Refreshed "${safe}": ${result.updated ? 'updated' : 'no change'} (HEAD ${result.sha.slice(0, 8)}, ${result.memoryCount} memories)`)
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
      }
    })

  brain
    .command('list')
    .description('List local brains (owned + followed)')
    .action(() => {
      if (!existsSync(BRAINS_DIR)) {
        console.log('(no brains)')
        return
      }
      const entries = readdirSync(BRAINS_DIR).filter((n: string) => {
        try {
          return statSync(join(BRAINS_DIR, n)).isDirectory()
        } catch {
          return false
        }
      })
      if (entries.length === 0) {
        console.log('(no brains)')
        return
      }
      for (const name of entries) {
        const dir = join(BRAINS_DIR, name)
        const hasEnc = existsSync(join(dir, 'brain.db.age'))
        const hasManifest = existsSync(join(dir, 'manifest.json'))
        const hasCache = existsSync(join(dir, '.cache', 'brain.db'))
        const recipientsCount = readRecipients(join(dir, 'recipients.txt')).length
        console.log(`  ${name}`)
        console.log(`    encrypted: ${hasEnc}, manifest: ${hasManifest}, decrypted-cache: ${hasCache}, recipients: ${recipientsCount}`)
      }
    })

  brain
    .command('import <path>')
    .description('Preview a brain.db file (validates manifest, prints summary)')
    .action((path: string) => {
      if (!existsSync(path)) {
        console.error(`File not found: ${path}`)
        process.exitCode = 1
        return
      }
      const manifest = readManifestFromFile(path)
      console.log(`Brain manifest:`)
      console.log(`  schema_version:  ${manifest.schema_version}`)
      console.log(`  engram_version:  ${manifest.engram_version}`)
      console.log(`  embedding_model: ${manifest.embedding_model}`)
      console.log(`  embedding_dim:   ${manifest.embedding_dim}`)
      console.log(`  owner_name:      ${manifest.owner_name ?? '(unknown)'}`)
      console.log(`  owner_pubkey:    ${manifest.owner_pubkey ?? '(unknown)'}`)
      console.log(`  description:     ${manifest.description ?? '(none)'}`)
      console.log(`  exported_at:     ${new Date(manifest.exported_at).toISOString()}`)
      console.log(`  memory_count:    ${manifest.memory_count}`)
      const err = validateForImport(manifest)
      if (err) {
        console.error(`\nValidation FAILED (${err.kind}): ${err.message}`)
        process.exitCode = 1
      } else {
        console.log(`\nValidation OK — compatible with local engram.`)
      }
    })
}
