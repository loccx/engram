import { readFileSync, writeFileSync, chmodSync } from 'fs'
import { Encrypter, Decrypter } from 'age-encryption'
import { engramPubToAgeRecipient, engramPrivToAgeIdentity } from './keyformat.js'
import type { EngramIdentity } from './identity.js'
import type { RecipientEntry } from './recipients.js'

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
  const plaintext = readFileSync(sourcePath)
  const encrypter = new Encrypter()
  for (const r of recipients) {
    encrypter.addRecipient(engramPubToAgeRecipient(r.pubkey))
  }
  const ciphertext = await encrypter.encrypt(plaintext)
  writeFileSync(destPath, ciphertext)
}

export async function decryptFileWithIdentity(
  sourcePath: string,
  destPath: string,
  identity: EngramIdentity
): Promise<void> {
  const ciphertext = readFileSync(sourcePath)
  const decrypter = new Decrypter()
  decrypter.addIdentity(engramPrivToAgeIdentity(identity.privateKey))
  const plaintext = await decrypter.decrypt(ciphertext, 'uint8array')
  // Decrypted caches hold another user's private memory content (if the
  // brain was followed) — never leave them world-readable on systems with
  // permissive umasks. mode + best-effort chmod mirror saveIdentity.
  writeFileSync(destPath, Buffer.from(plaintext), { mode: 0o600 })
  try {
    chmodSync(destPath, 0o600)
  } catch {
    /* file mode is best-effort: Windows and some networked filesystems reject chmod */
  }
}
