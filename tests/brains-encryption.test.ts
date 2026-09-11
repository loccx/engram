import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createIdentity } from '../src/brains/identity.js'
import { readRecipients, writeRecipients, addRecipient, removeRecipient } from '../src/brains/recipients.js'
import { encryptFileToRecipients, decryptFileWithIdentity } from '../src/brains/encrypt.js'
import { logAudit } from '../src/brains/audit.js'

describe('brains/recipients', () => {
  let tmp: string
  let recipientsPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-recipients-'))
    recipientsPath = join(tmp, 'recipients.txt')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns empty array when file does not exist', () => {
    expect(readRecipients(recipientsPath)).toEqual([])
  })

  it('round-trips entries with and without labels', async () => {
    const id1 = await createIdentity()
    const id2 = await createIdentity()
    writeRecipients(recipientsPath, [
      { pubkey: id1.publicKey, label: 'alice' },
      { pubkey: id2.publicKey, label: null },
    ])
    const read = readRecipients(recipientsPath)
    expect(read).toEqual([
      { pubkey: id1.publicKey, label: 'alice' },
      { pubkey: id2.publicKey, label: null },
    ])
  })

  it('skips comments, blank lines, and invalid keys', async () => {
    const id1 = await createIdentity()
    writeFileSync(
      recipientsPath,
      `# header comment\n\n${id1.publicKey}  # alice\nnot_a_real_key\n\n`,
      'utf8'
    )
    const read = readRecipients(recipientsPath)
    expect(read).toEqual([{ pubkey: id1.publicKey, label: 'alice' }])
  })

  it('addRecipient is idempotent', async () => {
    const id = await createIdentity()
    expect(addRecipient(recipientsPath, id.publicKey).added).toBe(true)
    expect(addRecipient(recipientsPath, id.publicKey).added).toBe(false)
    expect(readRecipients(recipientsPath)).toHaveLength(1)
  })

  it('addRecipient rejects invalid keys', () => {
    expect(() => addRecipient(recipientsPath, 'not_a_key')).toThrow(/not a valid engram/i)
  })

  it('removeRecipient returns false when missing', async () => {
    const id = await createIdentity()
    expect(removeRecipient(recipientsPath, id.publicKey).removed).toBe(false)
    addRecipient(recipientsPath, id.publicKey)
    expect(removeRecipient(recipientsPath, id.publicKey).removed).toBe(true)
    expect(readRecipients(recipientsPath)).toEqual([])
  })
})

describe('brains/encrypt', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-encrypt-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('round-trips encrypt → decrypt with a single recipient', async () => {
    const alice = await createIdentity()
    const plainPath = join(tmp, 'plain.bin')
    const encPath = join(tmp, 'enc.age')
    const outPath = join(tmp, 'out.bin')
    const payload = Buffer.from('hello engram brains 🧠', 'utf8')
    writeFileSync(plainPath, payload)

    await encryptFileToRecipients(plainPath, encPath, [
      { pubkey: alice.publicKey, label: null },
    ])
    expect(existsSync(encPath)).toBe(true)
    const enc = readFileSync(encPath)
    expect(enc.length).toBeGreaterThan(payload.length)
    expect(enc.equals(payload)).toBe(false)

    await decryptFileWithIdentity(encPath, outPath, alice)
    expect(readFileSync(outPath).equals(payload)).toBe(true)
  })

  it('round-trips encrypt → decrypt with multiple recipients (each can decrypt)', async () => {
    const alice = await createIdentity()
    const bob = await createIdentity()
    const plainPath = join(tmp, 'plain.bin')
    const encPath = join(tmp, 'enc.age')
    const payload = Buffer.from('shared brain content', 'utf8')
    writeFileSync(plainPath, payload)

    await encryptFileToRecipients(plainPath, encPath, [
      { pubkey: alice.publicKey, label: 'a' },
      { pubkey: bob.publicKey, label: 'b' },
    ])

    const aliceOut = join(tmp, 'a.bin')
    const bobOut = join(tmp, 'b.bin')
    await decryptFileWithIdentity(encPath, aliceOut, alice)
    await decryptFileWithIdentity(encPath, bobOut, bob)
    expect(readFileSync(aliceOut).equals(payload)).toBe(true)
    expect(readFileSync(bobOut).equals(payload)).toBe(true)
  })

  it('rejects encryption when recipients list is empty', async () => {
    const plainPath = join(tmp, 'plain.bin')
    writeFileSync(plainPath, 'x')
    await expect(
      encryptFileToRecipients(plainPath, join(tmp, 'enc.age'), [])
    ).rejects.toThrow(/no recipients/i)
  })

  it('writes decrypted output with owner-only file mode (0600)', async () => {
    const alice = await createIdentity()
    const plainPath = join(tmp, 'plain.bin')
    const encPath = join(tmp, 'enc.age')
    const outPath = join(tmp, 'out.bin')
    writeFileSync(plainPath, Buffer.from('private brain content'))

    await encryptFileToRecipients(plainPath, encPath, [
      { pubkey: alice.publicKey, label: null },
    ])
    await decryptFileWithIdentity(encPath, outPath, alice)

    expect(readFileSync(outPath).toString()).toBe('private brain content')
    if (process.platform !== 'win32') {
      expect(statSync(outPath).mode & 0o777).toBe(0o600)
    }
  })

  it('non-recipient cannot decrypt', async () => {
    const alice = await createIdentity()
    const eve = await createIdentity()
    const plainPath = join(tmp, 'plain.bin')
    const encPath = join(tmp, 'enc.age')
    writeFileSync(plainPath, Buffer.from('secret'))

    await encryptFileToRecipients(plainPath, encPath, [
      { pubkey: alice.publicKey, label: null },
    ])

    await expect(decryptFileWithIdentity(encPath, join(tmp, 'out'), eve)).rejects.toThrow()
  })
})

describe('brains/audit', () => {
  let tmp: string
  let logPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-audit-'))
    logPath = join(tmp, 'audit.log')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('appends one JSON line per event', () => {
    logAudit({ type: 'brain_grant', brain: 'work', pubkey: 'engram_pub_a' }, logPath)
    logAudit({ type: 'brain_revoke', brain: 'work', pubkey: 'engram_pub_b' }, logPath)
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const e1 = JSON.parse(lines[0])
    const e2 = JSON.parse(lines[1])
    expect(e1.type).toBe('brain_grant')
    expect(e1.brain).toBe('work')
    expect(typeof e1.ts).toBe('number')
    expect(e2.type).toBe('brain_revoke')
  })

  it('preserves prior entries on subsequent calls', () => {
    logAudit({ type: 'mark_shareable', namespace: 'work', memory_id: 'm1', actor: 'user' }, logPath)
    const before = readFileSync(logPath, 'utf8')
    logAudit({ type: 'mark_shareable', namespace: 'work', memory_id: 'm2', actor: 'user' }, logPath)
    const after = readFileSync(logPath, 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.length).toBeGreaterThan(before.length)
  })
})
