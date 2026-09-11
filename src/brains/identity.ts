import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { generateIdentity, identityToRecipient } from 'age-encryption'
import { IDENTITY_FILE } from './paths.js'
import {
  ageIdentityToEngramPriv,
  engramPrivToAgeIdentity,
  ageRecipientToEngramPub,
  isEngramPriv,
} from './keyformat.js'

export interface EngramIdentity {
  privateKey: string
  publicKey: string
}

export async function createIdentity(): Promise<EngramIdentity> {
  const ageIdentity = await generateIdentity()
  const ageRecipient = await identityToRecipient(ageIdentity)
  return {
    privateKey: ageIdentityToEngramPriv(ageIdentity),
    publicKey: ageRecipientToEngramPub(ageRecipient),
  }
}

export async function saveIdentity(identity: EngramIdentity, path: string = IDENTITY_FILE): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, identity.privateKey + '\n', { encoding: 'utf8' })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* file mode is best-effort: Windows and some networked filesystems reject chmod */
  }
}

export async function loadIdentity(path: string = IDENTITY_FILE): Promise<EngramIdentity> {
  if (!existsSync(path)) {
    throw new Error(
      `No engram identity found at ${path}. Run \`engram init\` to create one.`
    )
  }
  const content = readFileSync(path, 'utf8')
  const privLine = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && isEngramPriv(l))
  if (!privLine) {
    throw new Error(`Identity file at ${path} does not contain an engram_priv_ key`)
  }
  const ageIdentity = engramPrivToAgeIdentity(privLine)
  const ageRecipient = await identityToRecipient(ageIdentity)
  return {
    privateKey: privLine,
    publicKey: ageRecipientToEngramPub(ageRecipient),
  }
}

export function identityExists(path: string = IDENTITY_FILE): boolean {
  return existsSync(path)
}
