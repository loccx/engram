import { bech32 } from 'bech32'

const ENGRAM_PUB_HRP = 'engrampub'
const ENGRAM_PRIV_HRP = 'engrampriv'
const ENGRAM_PUB_PREFIX = 'engram_pub_'
const ENGRAM_PRIV_PREFIX = 'engram_priv_'

const AGE_PUB_PREFIX = 'age1'
const AGE_PRIV_PREFIX = 'AGE-SECRET-KEY-1'
const AGE_PUB_HRP = 'age'
const AGE_PRIV_HRP = 'age-secret-key-'

const MAX_BECH32_LEN = 1023

function bech32Decode(encoded: string): { hrp: string; bytes: Uint8Array } {
  const decoded = bech32.decode(encoded, MAX_BECH32_LEN)
  const bytes = Uint8Array.from(bech32.fromWords(decoded.words))
  return { hrp: decoded.prefix, bytes }
}

function bech32Encode(hrp: string, bytes: Uint8Array): string {
  return bech32.encode(hrp, bech32.toWords(Array.from(bytes)), MAX_BECH32_LEN)
}

export function ageRecipientToEngramPub(ageRecipient: string): string {
  if (!ageRecipient.startsWith(AGE_PUB_PREFIX)) {
    throw new Error(`Not an age recipient: ${ageRecipient}`)
  }
  const { hrp, bytes } = bech32Decode(ageRecipient)
  if (hrp !== AGE_PUB_HRP) {
    throw new Error(`Expected age HRP, got "${hrp}"`)
  }
  return ENGRAM_PUB_PREFIX + bech32Encode(ENGRAM_PUB_HRP, bytes).slice(ENGRAM_PUB_HRP.length + 1)
}

export function engramPubToAgeRecipient(engramPub: string): string {
  if (!engramPub.startsWith(ENGRAM_PUB_PREFIX)) {
    throw new Error(`Not an engram public key: ${engramPub}`)
  }
  const bech = ENGRAM_PUB_HRP + '1' + engramPub.slice(ENGRAM_PUB_PREFIX.length)
  const { hrp, bytes } = bech32Decode(bech)
  if (hrp !== ENGRAM_PUB_HRP) {
    throw new Error(`Expected engrampub HRP, got "${hrp}"`)
  }
  return bech32Encode(AGE_PUB_HRP, bytes)
}

export function ageIdentityToEngramPriv(ageIdentity: string): string {
  const upper = ageIdentity.toUpperCase()
  if (!upper.startsWith(AGE_PRIV_PREFIX)) {
    throw new Error('Not an age identity (must start with AGE-SECRET-KEY-1)')
  }
  const { hrp, bytes } = bech32Decode(upper.toLowerCase())
  if (hrp !== AGE_PRIV_HRP) {
    throw new Error(`Expected age-secret-key HRP, got "${hrp}"`)
  }
  return ENGRAM_PRIV_PREFIX + bech32Encode(ENGRAM_PRIV_HRP, bytes).slice(ENGRAM_PRIV_HRP.length + 1)
}

export function engramPrivToAgeIdentity(engramPriv: string): string {
  if (!engramPriv.startsWith(ENGRAM_PRIV_PREFIX)) {
    throw new Error('Not an engram private key (must start with engram_priv_)')
  }
  const bech = ENGRAM_PRIV_HRP + '1' + engramPriv.slice(ENGRAM_PRIV_PREFIX.length)
  const { hrp, bytes } = bech32Decode(bech)
  if (hrp !== ENGRAM_PRIV_HRP) {
    throw new Error(`Expected engrampriv HRP, got "${hrp}"`)
  }
  const ageBech = bech32Encode(AGE_PRIV_HRP, bytes)
  return ageBech.toUpperCase()
}

export function isEngramPub(s: string): boolean {
  if (!s.startsWith(ENGRAM_PUB_PREFIX)) return false
  try {
    engramPubToAgeRecipient(s)
    return true
  } catch {
    return false
  }
}

export function isEngramPriv(s: string): boolean {
  if (!s.startsWith(ENGRAM_PRIV_PREFIX)) return false
  try {
    engramPrivToAgeIdentity(s)
    return true
  } catch {
    return false
  }
}
