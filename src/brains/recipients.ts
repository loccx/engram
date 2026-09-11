import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { isEngramPub } from './keyformat.js'

export interface RecipientEntry {
  pubkey: string
  label: string | null
}

export function readRecipients(path: string): RecipientEntry[] {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n')
  const out: RecipientEntry[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [pub, ...rest] = line.split(/\s+#\s*/)
    const pubkey = pub.trim()
    if (!isEngramPub(pubkey)) continue
    out.push({ pubkey, label: rest.length > 0 ? rest.join(' # ').trim() : null })
  }
  return out
}

export function writeRecipients(path: string, entries: RecipientEntry[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const lines = ['# engram brain recipients (one engram_pub_ per line)']
  for (const e of entries) {
    lines.push(e.label ? `${e.pubkey}  # ${e.label}` : e.pubkey)
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}

export function addRecipient(path: string, pubkey: string, label?: string): { added: boolean } {
  if (!isEngramPub(pubkey)) {
    throw new Error(`Not a valid engram public key: ${pubkey}`)
  }
  const current = readRecipients(path)
  if (current.some((e) => e.pubkey === pubkey)) return { added: false }
  current.push({ pubkey, label: label ?? null })
  writeRecipients(path, current)
  return { added: true }
}

export function removeRecipient(path: string, pubkey: string): { removed: boolean } {
  const current = readRecipients(path)
  const filtered = current.filter((e) => e.pubkey !== pubkey)
  if (filtered.length === current.length) return { removed: false }
  writeRecipients(path, filtered)
  return { removed: true }
}
