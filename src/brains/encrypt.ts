import { chmodSync, createReadStream, createWriteStream, existsSync, renameSync, unlinkSync } from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { Encrypter, Decrypter } from 'age-encryption'
import { engramPubToAgeRecipient, engramPrivToAgeIdentity } from './keyformat.js'
import type { EngramIdentity } from './identity.js'
import type { RecipientEntry } from './recipients.js'

/**
 * Write a web ReadableStream to `destPath` without buffering the whole file, and
 * without ever leaving a partial file behind: bytes land in a sibling temp file
 * (created 0600) and only a fully-written stream is renamed into place.
 *
 * Callers depend on both properties. Publish must not leave plaintext on disk,
 * and a failed refresh must not leave a half-decrypted cache that looks valid
 * and would then be served to a follower as if it were complete.
 */
async function writeWebStreamToFile(web: ReadableStream<Uint8Array>, destPath: string): Promise<void> {
  const tmpPath = `${destPath}.part-${process.pid}`
  if (existsSync(tmpPath)) unlinkSync(tmpPath)
  try {
    await pipeline(Readable.fromWeb(web as unknown as import('stream/web').ReadableStream), createWriteStream(tmpPath, { mode: 0o600 }))
    renameSync(tmpPath, destPath)
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        /* best effort: the rename below must not run on a partial file anyway */
      }
    }
    throw err
  }
}

export async function encryptFileToRecipients(
  sourcePath: string,
  destPath: string,
  recipients: RecipientEntry[]
): Promise<void> {
  if (recipients.length === 0) {
    throw new Error(
      `Cannot encrypt: no recipients. Add at least one with \`engram brain grant <name> <engram_pub_...>\`.`
    )
  }
  const encrypter = new Encrypter()
  for (const r of recipients) {
    encrypter.addRecipient(engramPubToAgeRecipient(r.pubkey))
  }
  // Streamed: peak memory scales with the cipher's chunk size, not the file size.
  // A brain snapshot is a whole SQLite database, so buffering it whole costs
  // several hundred MB of RSS that --max-old-space-size cannot cap (external
  // buffers), and grows with every namespace a user shares.
  const source = Readable.toWeb(createReadStream(sourcePath)) as unknown as ReadableStream<Uint8Array>
  const ciphertext = await encrypter.encrypt(source)
  await writeWebStreamToFile(ciphertext, destPath)
}

export async function decryptFileWithIdentity(
  sourcePath: string,
  destPath: string,
  identity: EngramIdentity
): Promise<void> {
  const decrypter = new Decrypter()
  decrypter.addIdentity(engramPrivToAgeIdentity(identity.privateKey))
  // The header is processed before this promise resolves, so a wrong identity or
  // a malformed header fails here; a truncated payload fails during the pipe.
  // Either way no partial file is renamed into place.
  const source = Readable.toWeb(createReadStream(sourcePath)) as unknown as ReadableStream<Uint8Array>
  const plaintext = await decrypter.decrypt(source)
  // Decrypted caches hold another user's private memory content (if the brain was
  // followed) — never leave them world-readable on systems with permissive umasks.
  // mode + best-effort chmod mirror saveIdentity.
  await writeWebStreamToFile(plaintext, destPath)
  try {
    chmodSync(destPath, 0o600)
  } catch {
    /* file mode is best-effort: Windows and some networked filesystems reject chmod */
  }
}
