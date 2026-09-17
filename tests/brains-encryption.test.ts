import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  createReadStream,
  createWriteStream,
  readdirSync,
  existsSync,
  statSync,
} from 'fs'
import { createHash } from 'crypto'
import { pipeline } from 'stream/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createIdentity } from '../src/brains/identity.js'
import { readRecipients, writeRecipients, addRecipient, removeRecipient } from '../src/brains/recipients.js'
import { encryptFileToRecipients, decryptFileWithIdentity } from '../src/brains/encrypt.js'
import { logAudit } from '../src/brains/audit.js'

// Streaming crypto over 24 MiB fixtures legitimately takes seconds. vitest's 5s
// default made these fail under load rather than on a real regression, which is
// the worst kind of red: it trains you to ignore the gate.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/** Hash via stream so the test helper itself never buffers the whole fixture. */
async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** Write `size` bytes in 1 MiB chunks so the fixture is never held in memory. */
async function writeChunked(path: string, size: number): Promise<void> {
  const stream = createWriteStream(path)
  const chunk = Buffer.alloc(1024 * 1024, 3)
  let written = 0
  while (written < size) {
    const remaining = size - written
    const buf = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining)
    if (!stream.write(buf)) await new Promise((resolve) => stream.once('drain', resolve))
    written += buf.length
  }
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })
}

/**
 * Streaming encryption: the brain snapshot is a whole SQLite database, so
 * buffering it costs hundreds of MB of RSS that --max-old-space-size cannot cap.
 */
describe('brains/encryption streaming', { timeout: 60_000 }, () => {
  let dir: string
  let identity: Awaited<ReturnType<typeof createIdentity>>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'engram-encrypt-stream-'))
    identity = await createIdentity()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const recipients = () => [{ pubkey: identity.publicKey, label: null }]

  it('round-trips a large file byte-identically', async () => {
    const SIZE = 24 * 1024 * 1024
    const src = join(dir, 'large.db')
    const enc = join(dir, 'large.db.age')
    const out = join(dir, 'large.out')
    await writeChunked(src, SIZE)

    await encryptFileToRecipients(src, enc, recipients())
    await decryptFileWithIdentity(enc, out, identity)

    expect(statSync(out).size).toBe(SIZE)
    expect(await sha256(out)).toBe(await sha256(src))
  })

  it('does not buffer the file: RSS growth stays well below the file size', async () => {
    const SIZE = 24 * 1024 * 1024
    const src = join(dir, 'big.db')
    const enc = join(dir, 'big.db.age')
    await writeChunked(src, SIZE)

    const before = process.memoryUsage().rss
    await encryptFileToRecipients(src, enc, recipients())
    const growth = process.memoryUsage().rss - before

    // Buffering the plaintext alone would add ~SIZE. The bound is loose so the
    // assertion holds on a busy machine while still failing loudly if the
    // implementation regresses to reading the whole file.
    // Streaming measured ~0.63*SIZE under load (15.8MB on a 25MB input) and ~0.07*SIZE
    // on the large case; buffering is >= 1.0*SIZE because the whole file plus the
    // encoder's copy is resident. 0.8*SIZE keeps a wide margin over the measured
    // streaming cost while still failing if the implementation buffers, and unlike
    // 0.6 does not trip on allocator retention on a busy machine.
    expect(growth).toBeLessThan(SIZE * 0.8)
  })

  it('leaves no output and no temp file when the ciphertext is truncated', async () => {
    const src = join(dir, 'src.bin')
    const enc = join(dir, 'src.age')
    const out = join(dir, 'out.bin')
    writeFileSync(src, Buffer.alloc(512 * 1024, 7))

    await encryptFileToRecipients(src, enc, recipients())
    const full = readFileSync(enc)
    writeFileSync(enc, full.subarray(0, Math.max(16, Math.floor(full.length / 2))))

    await expect(decryptFileWithIdentity(enc, out, identity)).rejects.toThrow()
    expect(existsSync(out)).toBe(false)
    expect(readdirSync(dir).filter((f) => f.includes('.part-'))).toEqual([])
  })

  it('keeps the decrypted output owner-only after streaming', async () => {
    const src = join(dir, 'small.db')
    const enc = join(dir, 'small.db.age')
    const out = join(dir, 'small.out')
    writeFileSync(src, 'secret content')

    await encryptFileToRecipients(src, enc, recipients())
    await decryptFileWithIdentity(enc, out, identity)

    expect(statSync(out).mode & 0o777).toBe(0o600)
    expect(readFileSync(out, 'utf8')).toBe('secret content')
  })

  it('still rejects a non-recipient and an empty recipient list', async () => {
    const src = join(dir, 'x.bin')
    const enc = join(dir, 'x.age')
    const out = join(dir, 'x.out')
    writeFileSync(src, 'payload')

    await expect(encryptFileToRecipients(src, enc, [])).rejects.toThrow(/no recipients/i)

    await encryptFileToRecipients(src, enc, recipients())
    const stranger = await createIdentity()
    await expect(decryptFileWithIdentity(enc, out, stranger)).rejects.toThrow()
    expect(existsSync(out)).toBe(false)
  })
})

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

describe('brains/encryption', () => {
  let tmp: string
  let srcPath: string
  let encPath: string
  let outPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-encrypt-'))
    srcPath = join(tmp, 'brain.db')
    encPath = join(tmp, 'brain.db.age')
    outPath = join(tmp, 'brain.out')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('round-trips encrypt → decrypt with a single recipient', async () => {
    const id = await createIdentity()
    writeFileSync(srcPath, 'a snapshot of memories')
    await encryptFileToRecipients(srcPath, encPath, [{ pubkey: id.publicKey, label: null }])
    expect(existsSync(encPath)).toBe(true)
    await decryptFileWithIdentity(encPath, outPath, id)
    expect(readFileSync(outPath, 'utf8')).toBe('a snapshot of memories')
  })

  it('round-trips encrypt → decrypt with multiple recipients (each can decrypt)', async () => {
    const alice = await createIdentity()
    const bob = await createIdentity()
    writeFileSync(srcPath, 'multi recipient payload')
    await encryptFileToRecipients(srcPath, encPath, [
      { pubkey: alice.publicKey, label: 'alice' },
      { pubkey: bob.publicKey, label: 'bob' },
    ])
    await decryptFileWithIdentity(encPath, outPath, alice)
    expect(readFileSync(outPath, 'utf8')).toBe('multi recipient payload')
    await decryptFileWithIdentity(encPath, outPath, bob)
    expect(readFileSync(outPath, 'utf8')).toBe('multi recipient payload')
  })

  it('rejects encryption when recipients list is empty', async () => {
    writeFileSync(srcPath, 'x')
    await expect(encryptFileToRecipients(srcPath, encPath, [])).rejects.toThrow(/no recipients/i)
  })

  it('writes decrypted output with owner-only file mode (0600)', async () => {
    const id = await createIdentity()
    writeFileSync(srcPath, 'secret')
    await encryptFileToRecipients(srcPath, encPath, [{ pubkey: id.publicKey, label: null }])
    await decryptFileWithIdentity(encPath, outPath, id)
    expect(statSync(outPath).mode & 0o777).toBe(0o600)
  })

  it('non-recipient cannot decrypt', async () => {
    const id = await createIdentity()
    const stranger = await createIdentity()
    writeFileSync(srcPath, 'secret')
    await encryptFileToRecipients(srcPath, encPath, [{ pubkey: id.publicKey, label: null }])
    await expect(decryptFileWithIdentity(encPath, outPath, stranger)).rejects.toThrow()
  })
})

describe('brains/audit', () => {
  let tmp: string
  let auditPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-audit-'))
    auditPath = join(tmp, 'audit.log')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('appends one JSON line per event', () => {
    logAudit({ type: 'mark_shareable', namespace: '/p', memory_id: 'm1', actor: 'test' }, auditPath)
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0])
    expect(entry.type).toBe('mark_shareable')
    expect(entry.memory_id).toBe('m1')
    expect(typeof entry.ts).toBe('number')
  })

  it('preserves prior entries on subsequent calls', () => {
    logAudit({ type: 'mark_shareable', namespace: '/p', memory_id: 'm1', actor: 'test' }, auditPath)
    logAudit({ type: 'brain_publish', brain: 'b', memory_count: 3, recipients: 1 }, auditPath)
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).memory_id).toBe('m1')
    expect(JSON.parse(lines[1]).brain).toBe('b')
  })
})
