import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import {
  MemoryStore,
  setStoreEmbedder,
  resolveWriteGateMode,
  resolveWriteGateSimilarity,
  WRITE_GATE_DEFAULT_SIMILARITY,
} from '../src/memory/store.js'
import { EMBEDDING_DIM, MODEL_ID } from '../src/embeddings/pipeline.js'
import type { Memory, MemoryType } from '../src/memory/types.js'
import { enrichMemories } from '../src/memory/enrichment.js'

// write-time reconciliation: an always-insert store accumulates bursts of
// near-identical rows, so these tests pin the three modes, the metadata merge, the
// non-hiding marker and the provenance the gate's own vector probe depends on.

const NS = '/proj'

type GatedMemory = Memory & {
  deduplicated?: boolean
  possible_duplicates?: Array<{ id: string; similarity: number; type: string }>
}

// a deterministic bag-of-words embedder: real embeddings are unavailable without the
// cached model (and slow with it), and the gate's logic has to be testable without
// either
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

function makeStore(db: Database.Database, vectorsAvailable = true): MemoryStore {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    'sess-1',
    NS,
    Date.now()
  )
  return new MemoryStore(db, vectorsAvailable)
}

function countRows(db: Database.Database, content: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM memories WHERE content = ?').get(content) as { n: number }
  ).n
}

describe('write gate: modes', () => {
  const originalMode = process.env.ENGRAM_WRITE_GATE
  const originalSim = process.env.ENGRAM_WRITE_GATE_SIM

  beforeEach(() => {
    setStoreEmbedder(fakeEmbedder)
  })

  afterEach(() => {
    setStoreEmbedder(null)
    if (originalMode === undefined) delete process.env.ENGRAM_WRITE_GATE
    else process.env.ENGRAM_WRITE_GATE = originalMode
    if (originalSim === undefined) delete process.env.ENGRAM_WRITE_GATE_SIM
    else process.env.ENGRAM_WRITE_GATE_SIM = originalSim
  })

  it('defaults to merge and reads its knobs from the environment', () => {
    delete process.env.ENGRAM_WRITE_GATE
    expect(resolveWriteGateMode()).toBe('merge')
    process.env.ENGRAM_WRITE_GATE = 'off'
    expect(resolveWriteGateMode()).toBe('off')
    process.env.ENGRAM_WRITE_GATE = 'link'
    expect(resolveWriteGateMode()).toBe('link')
    process.env.ENGRAM_WRITE_GATE = 'nonsense'
    expect(resolveWriteGateMode()).toBe('merge')
    delete process.env.ENGRAM_WRITE_GATE_SIM
    expect(resolveWriteGateSimilarity()).toBe(WRITE_GATE_DEFAULT_SIMILARITY)
    process.env.ENGRAM_WRITE_GATE_SIM = '0.9'
    expect(resolveWriteGateSimilarity()).toBe(0.9)
  })

  it('merge mode: an exact duplicate does not insert a second row', async () => {
    const { db } = createTestDb()
    const store = makeStore(db)
    const content = 'the deploy script must run migrations before restarting the daemon'

    const first = await store.store({
      content,
      session_id: 'sess-1',
      project_path: NS,
      type: 'pattern',
      tags: ['deploy'],
      importance: 0.4,
    })
    const second = (await store.store({
      content,
      session_id: 'sess-1',
      project_path: NS,
      type: 'pattern',
      tags: ['ops'],
      importance: 0.9,
    })) as GatedMemory

    expect(second.deduplicated).toBe(true)
    expect(second.id).toBe(first.id)
    expect(countRows(db, content)).toBe(1)

    // merge mode folds the caller's metadata in instead of losing it
    expect(second.tags.sort()).toEqual(['deploy', 'ops'])
    expect(second.importance).toBe(0.9)
  })

  it('link mode: an exact duplicate is inserted but marked duplicate_of', async () => {
    process.env.ENGRAM_WRITE_GATE = 'link'
    const { db } = createTestDb()
    const store = makeStore(db)
    const content = 'pgbouncer max_client_conn must exceed the pool size'

    const first = await store.store({ content, session_id: 'sess-1', project_path: NS, type: 'note' })
    const second = (await store.store({
      content,
      session_id: 'sess-1',
      project_path: NS,
      type: 'note',
    })) as GatedMemory

    expect(second.deduplicated).toBeUndefined()
    expect(second.id).not.toBe(first.id)
    expect(countRows(db, content)).toBe(2)
    expect(second.possible_duplicates?.map((d) => d.id)).toContain(first.id)

    const link = db
      .prepare(
        `SELECT * FROM memory_links WHERE source_id = ? AND target_id = ? AND link_type = 'duplicate_of'`
      )
      .get(second.id, first.id) as { similarity: number } | undefined
    expect(link).toBeDefined()
    expect(link!.similarity).toBe(1)
  })

  it('off mode: no merge, no link, no payload', async () => {
    process.env.ENGRAM_WRITE_GATE = 'off'
    const { db } = createTestDb()
    const store = makeStore(db)
    const content = 'same content twice with the gate disabled'

    await store.store({ content, session_id: 'sess-1', project_path: NS, type: 'note' })
    const second = (await store.store({
      content,
      session_id: 'sess-1',
      project_path: NS,
      type: 'note',
    })) as GatedMemory

    expect(second.deduplicated).toBeUndefined()
    expect(second.possible_duplicates).toBeUndefined()
    expect(countRows(db, content)).toBe(2)
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM memory_links WHERE link_type = 'duplicate_of'")
          .get() as { n: number }
      ).n
    ).toBe(0)
  })

  it('near-duplicate: a cos>=threshold sibling in the same namespace+type is reported and linked', async () => {
    const { db } = createTestDb()
    const store = makeStore(db)
    const base =
      'none of these findings name a specific recurring manual task in the payment reconciliation service'
    // the same bag of words plus one token: cosine stays above the 0.95 floor while the
    // content differs, which is the near-duplicate case
    const near = `${base} today`

    const first = await store.store({ content: base, session_id: 'sess-1', project_path: NS, type: 'pattern', importance: 0.06 })
    const second = (await store.store({
      content: near,
      session_id: 'sess-1',
      project_path: NS,
      type: 'pattern',
      importance: 0.06,
    })) as GatedMemory

    // a near-duplicate is still stored (the gate reports, it does not guess) but is now
    // visible as a duplicate at write time
    expect(second.id).not.toBe(first.id)
    const flagged = second.possible_duplicates ?? []
    expect(flagged.map((d) => d.id)).toContain(first.id)
    expect(flagged[0].similarity).toBeGreaterThanOrEqual(WRITE_GATE_DEFAULT_SIMILARITY)

    const link = db
      .prepare(
        `SELECT * FROM memory_links WHERE source_id = ? AND target_id = ? AND link_type = 'duplicate_of'`
      )
      .get(second.id, first.id)
    expect(link).toBeDefined()
  })

  it('does not cross namespace or type boundaries', async () => {
    const { db } = createTestDb()
    const store = makeStore(db)
    db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
      'sess-2',
      '/other',
      Date.now()
    )
    const content = 'a fact that exists in two different projects'

    await store.store({ content, session_id: 'sess-1', project_path: NS, type: 'note' })
    const otherNs = (await store.store({
      content,
      session_id: 'sess-2',
      project_path: '/other',
      type: 'note',
    })) as GatedMemory
    const otherType = (await store.store({
      content,
      session_id: 'sess-1',
      project_path: NS,
      type: 'decision',
    })) as GatedMemory

    expect(otherNs.deduplicated).toBeUndefined()
    expect(otherType.deduplicated).toBeUndefined()
    expect(countRows(db, content)).toBe(3)
  })

  it('never merges a memory the caller pinned at store time', async () => {
    const { db } = createTestDb()
    const store = makeStore(db)
    const content = 'pinned concepts must never be collapsed into another row'

    const first = await store.store({ content, session_id: 'sess-1', project_path: NS, type: 'note' })
    const second = (await store.store({
      content,
      session_id: 'sess-1',
      project_path: NS,
      type: 'note',
      pinned: true,
    })) as GatedMemory

    expect(second.deduplicated).toBeUndefined()
    expect(second.id).not.toBe(first.id)
    expect(second.pinned).toBe(true)
    expect(countRows(db, content)).toBe(2)
  })

  it('is inert without vectors (FTS-only installs still insert)', async () => {
    const { db } = createTestDb()
    const store = makeStore(db, false)
    const content = 'no vectors, no reconciliation'
    await store.store({ content, session_id: 'sess-1', project_path: NS, type: 'note' })
    const second = (await store.store({
      content,
      session_id: 'sess-1',
      project_path: NS,
      type: 'note',
    })) as GatedMemory

    expect(second.deduplicated).toBeUndefined()
    expect(countRows(db, content)).toBe(2)
  })

  it('a gated store still returns an enrichable memory', async () => {
    const { db } = createTestDb()
    const store = makeStore(db)
    const stored = await store.store({
      content: 'enrichment must keep working for gated rows',
      session_id: 'sess-1',
      project_path: NS,
      type: 'note',
    })
    const [enriched] = enrichMemories(db, [stored])
    expect(enriched.namespace).toBe(NS)
    expect(enriched.tier).toBeDefined()
    expect(enriched.disputed).toBe(false)
  })
})

describe('embedding provenance at store time', () => {
  const originalMode = process.env.ENGRAM_WRITE_GATE

  beforeEach(() => {
    setStoreEmbedder(fakeEmbedder)
  })

  afterEach(() => {
    setStoreEmbedder(null)
    if (originalMode === undefined) delete process.env.ENGRAM_WRITE_GATE
    else process.env.ENGRAM_WRITE_GATE = originalMode
  })

  it('writes embedding_model, embedding_dim and an honest embed_state', async () => {
    const { db } = createTestDb()
    const store = makeStore(db)
    const stored = await store.store({
      content: 'provenance makes staleness detectable after a model change',
      session_id: 'sess-1',
      project_path: NS,
      type: 'note',
    })

    const row = db
      .prepare('SELECT embedding_model, embedding_dim, embed_state, vec_rowid FROM memories WHERE id = ?')
      .get(stored.id) as {
      embedding_model: string | null
      embedding_dim: number | null
      embed_state: string
      vec_rowid: number | null
    }
    // rows can hold a vector with embedding_model null while embed_state claims 'fresh'
    
    expect(row.embedding_model).toBe(MODEL_ID)
    expect(row.embedding_dim).toBe(EMBEDDING_DIM)
    expect(row.embed_state).toBe('fresh')
    expect(row.vec_rowid).not.toBeNull()
  })

  it('a change of model makes the row detectable as stale (provenance is what snapshot reads)', async () => {
    const { db } = createTestDb()
    const store = makeStore(db)
    const stored = await store.store({
      content: 'the model id is the only way to notice a re-embed is needed',
      session_id: 'sess-1',
      project_path: NS,
      type: 'note',
    })
    const row = db
      .prepare('SELECT embedding_model FROM memories WHERE id = ?')
      .get(stored.id) as { embedding_model: string }
    // staleness compares the recorded model with the running one, so without a recorded
    // model there is nothing to compare
    db.prepare("UPDATE memories SET embed_state = 'stale' WHERE embedding_model != ?").run(MODEL_ID)
    const stale = (
      db.prepare("SELECT COUNT(*) AS n FROM memories WHERE embed_state = 'stale'").get() as {
        n: number
      }
    ).n
    expect(row.embedding_model).toBe(MODEL_ID)
    expect(stale).toBe(0)

    db.prepare("UPDATE memories SET embed_state = 'stale' WHERE embedding_model != ?").run('other-model')
    const staleAfter = (
      db.prepare("SELECT COUNT(*) AS n FROM memories WHERE embed_state = 'stale'").get() as {
        n: number
      }
    ).n
    expect(staleAfter).toBe(1)
  })
})

describe('write gate thresholds', () => {
  it('respects ENGRAM_WRITE_GATE_SIM so operators can loosen or tighten it', async () => {
    delete process.env.ENGRAM_WRITE_GATE
    process.env.ENGRAM_WRITE_GATE_SIM = '0.999'
    setStoreEmbedder(fakeEmbedder)
    const { db } = createTestDb()
    const store = makeStore(db)
    try {
      await store.store({
        content: 'threshold high enough that a near neighbour is not flagged',
        session_id: 'sess-1',
        project_path: NS,
        type: 'note' as MemoryType,
      })
      const second = (await store.store({
        content: 'threshold high enough that a near neighbour is not flagged today',
        session_id: 'sess-1',
        project_path: NS,
        type: 'note' as MemoryType,
      })) as GatedMemory
      expect(second.possible_duplicates ?? []).toEqual([])
    } finally {
      setStoreEmbedder(null)
      delete process.env.ENGRAM_WRITE_GATE_SIM
    }
  })
})
