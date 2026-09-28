import { chmodSync, createReadStream, createWriteStream, existsSync, renameSync, unlinkSync } from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { Encrypter, Decrypter } from 'age-encryption'
import { engramPubToAgeRecipient, engramPrivToAgeIdentity } from './keyformat.js'
import type { EngramIdentity } from './identity.js'
import type { RecipientEntry } from './recipients.js'

/**
 * stream to destPath in a sibling temp file (0600), renamed only once complete, so
 * publish never leaves plaintext on disk and a failed refresh never leaves a
 * half-decrypted cache that looks valid. callers depend on both properties.
 */
async function writeWebStreamToFile(web: ReadableStream<Uint8Array>, destPath: string): Promise<void> {
  const tmpPath = `${destPath}.part-${process.pid}`
  if (existsSync(tmpPath)) unlinkSync(tmpPath)
  try {
    await pipeline(Readable.fromWeb(web as unknown as import('stream/web').ReadableStream), createWriteStream(tmpPath, { mode: 0o600 }))
    try {
      renameSync(tmpPath, destPath)
    } catch (renameErr) {
      // windows cannot rename over an existing file, so remove first and rename;
      // without it, re-publishing a snapshot fails there
      try {
        unlinkSync(destPath)
      } catch {
        /* destination may not exist */
      }
      try {
        renameSync(tmpPath, destPath)
      } catch {
        throw renameErr
      }
    }
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
  // streamed on purpose: peak memory follows the cipher's chunk size, not the file
  // size. a snapshot is a whole sqlite db and its buffers sit outside the js heap,
  // so --max-old-space-size cannot cap them
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
  // the header is processed before this promise resolves, so a wrong identity or a
  // bad header fails here, a truncated payload fails mid-pipe, and neither is
  // renamed into place
  const source = Readable.toWeb(createReadStream(sourcePath)) as unknown as ReadableStream<Uint8Array>
  const plaintext = await decrypter.decrypt(source)
  // a decrypted cache holds another user's private content: never leave it
  // world-readable on a permissive umask (mode + best-effort chmod, as saveIdentity)
  await writeWebStreamToFile(plaintext, destPath)
  try {
    chmodSync(destPath, 0o600)
  } catch {
    /* file mode is best-effort: Windows and some networked filesystems reject chmod */
  }
}
