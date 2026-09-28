import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import {
  ADMISSION_BURST_MIN_DEFAULT,
  ADMISSION_DEFAULT_MODE,
  ADMISSION_RULES,
  admit,
  admissionBurstWindowMs,
  isAgentWrite,
  resolveAdmissionMode,
  type AdmissionContext,
  type AdmissionDecision,
  type AdmissionInput,
  type AdmissionMode,
} from '../src/memory/admission.js'
import {
  MemoryStore,
  setStoreEmbedder,
  type RefusedWrite,
  type StoreResult,
} from '../src/memory/store.js'
import { EMBEDDING_DIM } from '../src/embeddings/pipeline.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { buildCorpus, corpusNames } from '../eval/lib/corpus.js'
import { CORPUS_EPOCH } from '../eval/lib/harness.js'

const NS = '/home/user/admission'
const T0 = CORPUS_EPOCH

function ctx(db: Database.Database, now = T0, agent = true): AdmissionContext {
  return { db, now, agent }
}

function decide(
  content: string,
  db: Database.Database,
  opts: { namespace?: string; type?: AdmissionInput['type']; tags?: string[]; now?: number; mode?: AdmissionMode; agent?: boolean } = {}
): AdmissionDecision {
  const input: AdmissionInput = {
    content,
    namespace: opts.namespace ?? NS,
    type: opts.type ?? 'note',
    tags: opts.tags ?? [],
  }
  return admit(input, ctx(db, opts.now ?? T0, opts.agent ?? true), opts.mode ?? 'enforce')
}

function outcome(decision: AdmissionDecision): 'allow' | 'warn' | 'reject' {
  if (!decision.allowed) return 'reject'
  return decision.warnings.length > 0 ? 'warn' : 'allow'
}

function refusal(decision: AdmissionDecision): Extract<AdmissionDecision, { allowed: false }> {
  if (decision.allowed) throw new Error(`expected a refusal, got ${JSON.stringify(decision)}`)
  return decision
}

function acceptance(decision: AdmissionDecision): Extract<AdmissionDecision, { allowed: true }> {
  if (!decision.allowed) throw new Error(`expected an accepted write, got ${JSON.stringify(decision)}`)
  return decision
}

function refusedWrite(result: StoreResult): RefusedWrite {
  if (result.status !== 'rejected') throw new Error(`expected a refused write, got ${result.status}`)
  return result
}

function familyDb(): Database.Database {
  const { db } = createTestDb()
  for (let i = 0; i < ADMISSION_BURST_MIN_DEFAULT; i++) {
    insertMemory(db, {
      id: `family-${i}`,
      content: `${BURST_PREFIX}, pass ${i} of the sweep.`,
      namespace: NS,
      created_at: T0 + i,
    })
  }
  return db
}

function insertMemory(
  db: Database.Database,
  row: {
    id: string
    content: string
    namespace: string
    type?: string
    importance?: number
    pinned?: boolean
    tags?: string[]
    created_at: number
  }
): void {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    'admission-session',
    row.namespace,
    row.created_at
  )
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, pinned, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test')`
  ).run(
    row.id,
    'admission-session',
    row.namespace,
    row.namespace,
    row.content,
    row.type ?? 'note',
    row.importance ?? 0.5,
    JSON.stringify(row.tags ?? []),
    row.created_at,
    row.created_at,
    row.pinned === true ? 1 : 0
  )
}

// fake credentials are assembled at runtime so no provider-shaped literal ever lands in the source
const fake = (...parts: string[]): string => parts.join('')
const KEY_BLOCK = fake('-----BEGIN RSA ', 'PRIVATE KEY-----')
const AWS_KEY = fake('AK', 'IA', 'IOSFODNN7EXAMPLE')
const GITHUB_TOKEN = fake('gh', 'p_', '0123456789abcdefghijklmnopqrstuvwxyz')
const SLACK_TOKEN = fake('xo', 'xb-', '123456789012-abcdefghijklmo')
const API_KEY = fake('sk', '-', 'abcdefghijklmnopqrstuvwxyz012345')
const GOOGLE_KEY = fake('AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv')
const JWT = fake('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.SflKxwRJSMeKKF2QT4fwpM')

const SECRETS: Array<{ label: string; content: string; marker: string }> = [
  {
    label: 'private key block',
    content: `the deploy key is ${KEY_BLOCK}\nMIIEowIBAAKCAQEA\n-----END RSA ${'PRIVATE'} KEY-----`,
    marker: 'MIIEowIBAAKCAQEA',
  },
  { label: 'aws access key', content: `aws creds ${AWS_KEY} for the backup bucket`, marker: AWS_KEY },
  { label: 'github token', content: `push with ${GITHUB_TOKEN}`, marker: GITHUB_TOKEN.slice(0, 14) },
  { label: 'slack token', content: `the webhook uses ${SLACK_TOKEN}`, marker: SLACK_TOKEN.slice(0, 17) },
  { label: 'api key', content: `OPENAI_KEY=${API_KEY}`, marker: API_KEY.slice(0, 15) },
  { label: 'google api key', content: `maps key ${GOOGLE_KEY}`, marker: GOOGLE_KEY.slice(0, 17) },
  { label: 'json web token', content: `session token ${JWT}`, marker: JWT.slice(0, 20) },
  { label: 'connection string', content: 'DB=postgres://admin:hunter2secret@db.internal:5432/ledger', marker: 'hunter2secret' },
  { label: 'bearer header', content: 'call it with Bearer abcdefghijklmnopqrstuvwxyz012345', marker: 'abcdefghijklmnopqrstuvwxyz012345' },
  { label: 'assigned password', content: 'the bastion password is hunter2vault', marker: 'hunter2vault' },
]

interface FixtureRow {
  content: string
  expect: 'allow' | 'warn' | 'reject'
  why: string
}

const LEGITIMATE: FixtureRow[] = [
  {
    content: 'The nightly rollback drill starts at 02:30 UTC and finishes in eleven minutes.',
    expect: 'allow',
    why: 'ordinary durable fact',
  },
  {
    content: 'engram merges an exact duplicate instead of inserting a second row',
    expect: 'allow',
    why: 'convention',
  },
  {
    content: 'rotate the api key for the relay gateway every ninety days',
    expect: 'allow',
    why: 'names a credential without carrying one',
  },
  {
    content: 'the bastion password rotation is handled by the vault; the value is never written down',
    expect: 'allow',
    why: 'password policy, no value',
  },
  {
    content: 'Ledger settlement retries are capped at 5 attempts after the July outage.',
    expect: 'allow',
    why: 'a value with a number',
  },
  {
    content: 'no issues were found in the rollout of build 2026-09-01',
    expect: 'allow',
    why: 'absence with a concrete build',
  },
  {
    content: 'The queue accepts bursts of 8000 messages before shedding load.',
    expect: 'allow',
    why: 'the word burst is not a burst',
  },
]

const JUNK_AND_NEGATIVE: FixtureRow[] = [
  { content: '', expect: 'reject', why: 'empty' },
  { content: '   \n\t ', expect: 'reject', why: 'whitespace only' },
  { content: '--- ... ---', expect: 'reject', why: 'punctuation only' },
  { content: '[]', expect: 'reject', why: 'markup only' },
  { content: '<div></div>', expect: 'reject', why: 'markup only' },
  { content: 'x'.repeat(30_000), expect: 'reject', why: 'over the length ceiling' },
  { content: 'none of these findings name a specific recurring manual task', expect: 'warn', why: 'absence only' },
  { content: 'nothing found while sweeping the export path', expect: 'warn', why: 'absence only' },
  { content: 'no issues', expect: 'warn', why: 'absence only' },
  { content: 'second', expect: 'warn', why: 'placeholder, too thin' },
]

const BURST_PREFIX = 'The nightly audit re-ran the duplicate scan across the ledger namespace'
const BURST_SIZE = 50

describe('admission rule registry', () => {
  it('is an ordered list of named rules, checked in order', () => {
    expect(ADMISSION_RULES.map((r) => r.name)).toEqual(['secrets', 'junk', 'negative-result', 'burst'])
    expect(ADMISSION_RULES.every((r) => typeof r.check === 'function')).toBe(true)
  })

  it('refuses a burst member by naming the keeper, and points at revise_memory', () => {
    const { db } = createTestDb()
    for (let i = 0; i < ADMISSION_BURST_MIN_DEFAULT; i++) {
      const content = `${BURST_PREFIX}, pass ${i} of the sweep.`
      expect(outcome(decide(content, db))).toBe('allow')
      insertMemory(db, { id: `keeper-${i}`, content, namespace: NS, created_at: T0 + i })
    }

    const decision = refusal(decide(`${BURST_PREFIX}, pass ${ADMISSION_BURST_MIN_DEFAULT} of the sweep.`, db))
    expect(decision.rule).toBe('burst')
    expect(decision.existing_id).toBe('keeper-0')
    expect(decision.hint).toContain('keeper-0')
    expect(decision.hint).toContain('revise_memory')
  })

  it('does not treat a family outside the window, the namespace or the type as a burst', () => {
    const { db } = createTestDb()
    const content = `${BURST_PREFIX}, pass 9 of the sweep.`
    for (let i = 0; i < ADMISSION_BURST_MIN_DEFAULT; i++) {
      insertMemory(db, { id: `old-${i}`, content, namespace: NS, created_at: T0 + i })
    }

    const later = T0 + admissionBurstWindowMs() + 1
    expect(outcome(decide(content, db, { now: later }))).toBe('allow')
    expect(outcome(decide(content, db, { namespace: '/home/user/other' }))).toBe('allow')
    expect(outcome(decide(content, db, { type: 'bug' }))).toBe('allow')
  })

  it('ignores archived and superseded rows when it counts a family', () => {
    const { db } = createTestDb()
    const content = `${BURST_PREFIX}, pass 4 of the sweep.`
    for (let i = 0; i < ADMISSION_BURST_MIN_DEFAULT; i++) {
      insertMemory(db, { id: `archived-${i}`, content, namespace: NS, created_at: T0 + i })
      db.prepare('UPDATE memories SET archived_at = ? WHERE id = ?').run(T0, `archived-${i}`)
    }
    expect(outcome(decide(content, db))).toBe('allow')
  })
})

describe('admission modes', () => {
  const db = familyDb()
  const burstContent = `${BURST_PREFIX}, pass 90 of the sweep.`

  beforeEach(() => {
    delete process.env.ENGRAM_ADMISSION
  })

  afterEach(() => {
    delete process.env.ENGRAM_ADMISSION
  })

  it('off checks nothing at all', () => {
    expect(outcome(decide(burstContent, db, { mode: 'off' }))).toBe('allow')
    expect(outcome(decide(SECRETS[1].content, db, { mode: 'off' }))).toBe('allow')
  })

  it('warn returns a rejection as a warning on an accepted write', () => {
    const decision = acceptance(decide(burstContent, db, { mode: 'warn' }))
    expect(decision.warnings.map((w) => w.rule)).toEqual(['burst'])
  })

  it('warn still refuses a secret', () => {
    expect(refusal(decide(SECRETS[1].content, db, { mode: 'warn' })).rule).toBe('secrets')
  })

  it('enforce degrades to a warning when nobody can act on the refusal', () => {
    const decision = acceptance(decide(burstContent, db, { mode: 'enforce', agent: false }))
    expect(decision.warnings.map((w) => w.rule)).toEqual(['burst'])
  })

  it('only a tool write counts as an agent write', () => {
    expect(isAgentWrite('mcp')).toBe(true)
    expect(isAgentWrite(undefined)).toBe(false)
    expect(isAgentWrite('import')).toBe(false)
    expect(isAgentWrite('revision')).toBe(false)
  })

  it('resolves the mode from the environment and defaults to enforce', () => {
    expect(ADMISSION_DEFAULT_MODE).toBe('enforce')
    expect(resolveAdmissionMode({})).toBe('enforce')
    expect(resolveAdmissionMode({ ENGRAM_ADMISSION: 'off' })).toBe('off')
    expect(resolveAdmissionMode({ ENGRAM_ADMISSION: 'WARN ' })).toBe('warn')
    expect(resolveAdmissionMode({ ENGRAM_ADMISSION: 'maybe' })).toBe('enforce')
  })
})

describe('admission fixture: precision and recall', () => {
  it('refuses every bad write on the fixture and loses no legitimate one', () => {
    const { db } = createTestDb()
    const rows: FixtureRow[] = [...LEGITIMATE, ...JUNK_AND_NEGATIVE]
    for (const secret of SECRETS) {
      rows.push({ content: secret.content, expect: 'reject', why: `secret: ${secret.label}` })
    }

    const misses: string[] = []
    const falseRefusals: string[] = []
    const rank = { allow: 0, warn: 1, reject: 2 } as const
    let refused = 0
    let caught = 0
    let mustCatch = 0

    for (const row of rows) {
      const decision = decide(row.content, db)
      const actual = outcome(decision)
      if (actual === 'reject') refused++
      if (row.expect !== 'allow') {
        mustCatch++
        if (rank[actual] >= rank[row.expect]) caught++
        else misses.push(`${row.why}: expected ${row.expect}, got ${actual}`)
      }
      if (row.expect === 'allow' && actual === 'reject') falseRefusals.push(row.why)
    }

    const recall = caught / mustCatch
    const precision = 1 - falseRefusals.length / Math.max(refused, 1)
    console.log(
      `ADMISSION_FIXTURE ${JSON.stringify({
        rows: rows.length,
        refused,
        mustCatch,
        caught,
        misses: misses.length,
        falseRefusals: falseRefusals.length,
        precision: Number(precision.toFixed(3)),
        recall: Number(recall.toFixed(3)),
      })}`
    )

    expect({ misses, falseRefusals }).toEqual({ misses: [], falseRefusals: [] })
    expect(recall).toBe(1)
    expect(precision).toBe(1)
  })

  it('never echoes a matched credential in the reason or the hint', () => {
    const { db } = createTestDb()
    for (const secret of SECRETS) {
      const decision = refusal(decide(secret.content, db))
      expect(decision.reason).not.toContain(secret.marker)
      expect(decision.hint).not.toContain(secret.marker)
    }
  })

  it('catches a fifty row burst after the family is established', () => {
    const { db } = createTestDb()
    let refused = 0
    let seated = 0
    for (let i = 0; i < BURST_SIZE; i++) {
      const content = `${BURST_PREFIX}, pass ${i} of the sweep.`
      const decision = decide(content, db)
      if (decision.allowed) {
        seated++
        insertMemory(db, { id: `burst-${i}`, content, namespace: NS, created_at: T0 + i })
      } else {
        refused++
        expect(refusal(decision).existing_id).toBe('burst-0')
      }
    }
    console.log(`ADMISSION_BURST ${JSON.stringify({ rows: BURST_SIZE, seated, refused })}`)
    expect(seated).toBe(ADMISSION_BURST_MIN_DEFAULT)
    expect(refused).toBe(BURST_SIZE - ADMISSION_BURST_MIN_DEFAULT)
  })
})

describe('admission over the eval corpora', () => {
  it('refuses no memory of any corpus, in enforce mode', () => {
    const report: Array<{ corpus: string; memories: number; refused: number; warnings: number }> = []
    const refusedRows: string[] = []

    for (const name of corpusNames()) {
      const corpus = buildCorpus(name, 7)
      const { db } = createTestDb()
      const rows = [...corpus.memories].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      let warnings = 0

      for (const memory of rows) {
        const namespace = memory.scope ? `${memory.namespace}//${memory.scope}` : memory.namespace
        const decision = decide(memory.content, db, {
          namespace,
          type: memory.type ?? 'note',
          tags: memory.tags ?? [],
          now: memory.created_at,
        })
        if (!decision.allowed) refusedRows.push(`${name}/${memory.id}: ${decision.reason}`)
        else warnings += decision.warnings.length
        insertMemory(db, {
          id: memory.id,
          content: memory.content,
          namespace,
          type: memory.type,
          importance: memory.importance,
          pinned: memory.pinned,
          tags: memory.tags,
          created_at: memory.created_at,
        })
      }

      report.push({ corpus: name, memories: rows.length, refused: refusedRows.filter((r) => r.startsWith(`${name}/`)).length, warnings })
    }

    console.log(`ADMISSION_CORPORA ${JSON.stringify(report)}`)
    expect(refusedRows).toEqual([])
    expect(report.reduce((n, r) => n + r.memories, 0)).toBeGreaterThan(350)
  })
})

function fakeEmbedder(text: string): Promise<Float32Array> {
  const v = new Float32Array(EMBEDDING_DIM)
  for (const token of text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)) {
    let h = 2166136261
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    v[Math.abs(h) % EMBEDDING_DIM] += 1
  }
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return Promise.resolve(v)
}

function vectorStore(): { db: Database.Database; store: MemoryStore } {
  const { db } = createTestDb()
  db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    'admission-session',
    NS,
    T0
  )
  return { db, store: new MemoryStore(db, true) }
}

describe('store wiring', () => {
  beforeEach(() => {
    setStoreEmbedder(fakeEmbedder)
  })

  afterEach(() => {
    setStoreEmbedder(null)
  })

  it('refuses a secret before the insert and writes no row', async () => {
    const { db, store } = vectorStore()
    const result = await store.store({
      content: SECRETS[7].content,
      session_id: 'admission-session',
      project_path: NS,
      origin: 'mcp',
    })

    expect(refusedWrite(result).reason).not.toContain(SECRETS[7].marker)
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(0)
  })

  it('refuses a burst member from a tool write but never from an import', async () => {
    const { db, store } = vectorStore()
    const content = (i: number): string => `${BURST_PREFIX}, pass ${i} of the sweep.`

    for (let i = 0; i < ADMISSION_BURST_MIN_DEFAULT; i++) {
      const stored = await store.store({
        content: content(i),
        session_id: 'admission-session',
        project_path: NS,
        origin: 'mcp',
      })
      expect(stored.status).toBe('stored')
    }

    const refused = await store.store({
      content: content(99),
      session_id: 'admission-session',
      project_path: NS,
      origin: 'mcp',
    })
    expect(refusedWrite(refused).rule).toBe('burst')
    expect(refusedWrite(refused).existing_id).toBeTruthy()

    const imported = await store.store({
      content: content(99),
      session_id: 'admission-session',
      project_path: NS,
      origin: 'import',
    })
    expect(imported.status).toBe('stored')
    expect(imported.warnings?.map((w) => w.rule)).toEqual(['burst'])
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(
      ADMISSION_BURST_MIN_DEFAULT + 1
    )
  })

  it('reports a merge as deduplicated and a fresh row as stored', async () => {
    const { store } = vectorStore()
    const content = 'engram reports a write status on every store'

    const first = await store.store({ content, session_id: 'admission-session', project_path: NS })
    const second = await store.store({ content, session_id: 'admission-session', project_path: NS })

    expect(first.status).toBe('stored')
    expect(second.status).toBe('deduplicated')
    expect(second.deduplicated).toBe(true)
    expect(second.id).toBe(first.id)
  })

  it('rides a warning along on an accepted write', async () => {
    const { store } = vectorStore()
    const stored = await store.store({
      content: 'none of these findings name a specific recurring manual task',
      session_id: 'admission-session',
      project_path: NS,
      origin: 'mcp',
    })

    expect(stored.status).toBe('stored')
    expect(stored.warnings?.map((w) => w.rule)).toEqual(['negative-result'])
  })

  it('returns contradiction candidates inline, with a duplicate hint when the pair is one', async () => {
    const { db, store } = vectorStore()
    const base = 'Ledger settlement retries are capped at 3 attempts during the reconciliation window'
    const first = await store.store({ content: base, session_id: 'admission-session', project_path: NS })
    const second = await store.store({
      content: `${base} today`,
      session_id: 'admission-session',
      project_path: NS,
    })

    expect(second.status).toBe('stored')
    expect(second.conflicts?.length).toBeGreaterThan(0)
    expect(second.conflicts!.length).toBeLessThanOrEqual(3)
    const conflict = second.conflicts?.find((c) => c.id === first.id)
    expect(conflict).toBeDefined()
    expect(conflict?.preview).toContain('Ledger settlement retries')
    expect(conflict?.relation_hint).toBe('duplicate')

    // a retired row is not a conflict any more
    db.prepare('UPDATE memories SET archived_at = ? WHERE id = ?').run(T0, first.id)
    const third = await store.store({
      content: `${base} after the outage`,
      session_id: 'admission-session',
      project_path: NS,
    })
    expect(third.status).toBe('stored')
    expect(third.conflicts!.some((c) => c.id === first.id)).toBe(false)
  })
})

interface ToolPayload {
  status?: string
  reason?: string
  hint?: string
  rule?: string
  existing_id?: string
  warnings?: Array<{ rule: string; reason: string; hint: string }>
  conflicts?: Array<{ id: string; preview: string }>
}

function parse(result: { content: Array<{ type: string; text: string }> }): ToolPayload {
  return JSON.parse(result.content[0].text) as ToolPayload
}

describe('store_memory surface', () => {
  beforeEach(() => {
    delete process.env.ENGRAM_ADMISSION
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  afterEach(() => {
    delete process.env.ENGRAM_ADMISSION
  })

  it('refuses a secret with a reason and a hint, and inserts nothing', async () => {
    const payload = parse(
      await handleTool('store_memory', { content: SECRETS[3].content, project_path: NS })
    )

    expect(payload.status).toBe('rejected')
    expect(payload.rule).toBe('secrets')
    expect(payload.reason).toBeTruthy()
    expect(payload.hint).toBeTruthy()
    expect(JSON.stringify(payload)).not.toContain(SECRETS[3].marker)

    const db = getDatabase().db
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(0)
  })

  it('refuses the burst member the agent would add and names the existing keeper', async () => {
    let keeper = ''
    for (let i = 0; i < ADMISSION_BURST_MIN_DEFAULT; i++) {
      const payload = parse(
        await handleTool('store_memory', {
          content: `${BURST_PREFIX}, pass ${i} of the sweep.`,
          project_path: NS,
        })
      )
      expect(payload.status).toBe('stored')
      if (i === 0) keeper = (payload as { id?: string }).id ?? ''
    }

    const refused = parse(
      await handleTool('store_memory', {
        content: `${BURST_PREFIX}, pass 42 of the sweep.`,
        project_path: NS,
      })
    )
    expect(refused.status).toBe('rejected')
    expect(refused.rule).toBe('burst')
    expect(refused.existing_id).toBe(keeper)
    expect(refused.hint).toContain('revise_memory')
  })

  it('carries warnings on an accepted write and status on every answer', async () => {
    const payload = parse(
      await handleTool('store_memory', {
        content: 'nothing found while sweeping the export path',
        project_path: NS,
      })
    )
    expect(payload.status).toBe('stored')
    expect(payload.warnings?.[0].rule).toBe('negative-result')
    expect(payload.warnings?.[0].hint).toBeTruthy()
  })

  it('stays silent on a write nothing objects to', async () => {
    const payload = parse(
      await handleTool('store_memory', {
        content: 'The relay release train leaves every Thursday at 16:00 UTC.',
        project_path: NS,
      })
    )
    expect(payload.status).toBe('stored')
    expect(payload.warnings).toBeUndefined()
    expect(payload.conflicts).toBeUndefined()
  })

  it('with admission off stores what enforce refuses', async () => {
    process.env.ENGRAM_ADMISSION = 'off'
    const payload = parse(
      await handleTool('store_memory', { content: SECRETS[3].content, project_path: NS })
    )
    expect(payload.status).toBe('stored')
    const db = getDatabase().db
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(1)
  })
})
