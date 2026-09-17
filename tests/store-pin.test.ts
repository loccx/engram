import { describe, it, expect } from 'vitest'
import { createTestDb } from './helpers.js'
import { MemoryStore } from '../src/memory/store.js'
import { enrichMemories } from '../src/memory/enrichment.js'
import { StoreMemorySchema } from '../src/mcp/schemas.js'

/**
 * `store_memory` silently dropped `pinned`: the flag was absent from the schema,
 * so a caller passing pinned:true got back pinned:false, tier:'warm'. A standing
 * rule that says "concept memories are written with importance 1.0 AND pinned"
 * therefore could not be satisfied through the tool agents actually use - the
 * likely root cause of 273 concept memories drifting unpinned.
 */
describe('store_memory can write a pinned memory', () => {
  it('accepts pinned in the tool schema (it was absent)', () => {
    expect(StoreMemorySchema.parse({ content: 'x', pinned: true }).pinned).toBe(true)
    // Absent means "not pinned" rather than rejecting the call.
    expect(StoreMemorySchema.parse({ content: 'x' }).pinned).toBe(false)
  })

  it('persists the flag and reports tier "pinned", not "warm"', async () => {
    const { db, vectorsAvailable } = createTestDb()
    db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run('s1', '/p', Date.now())
    const store = new MemoryStore(db, vectorsAvailable)

    const memory = await store.store({ content: 'a permanent construct', session_id: 's1', project_path: '/p' })
    expect(store.setPinned(memory.id, true)).toBe(true)

    const row = db.prepare('SELECT pinned FROM memories WHERE id = ?').get(memory.id) as { pinned: number }
    expect(row.pinned).toBe(1)

    // The tier is the property that matters: importance alone does not survive
    // decay, so 'pinned' is what makes a concept memory permanent.
    Object.assign(memory, { pinned: true })
    const [enriched] = enrichMemories(db, [memory])
    expect(enriched.tier).toBe('pinned')
  })

  it('leaves an unpinned memory unpinned and out of the permanent tier', async () => {
    const { db, vectorsAvailable } = createTestDb()
    db.prepare('INSERT INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run('s1', '/p', Date.now())
    const store = new MemoryStore(db, vectorsAvailable)

    const memory = await store.store({ content: 'an ordinary note', session_id: 's1', project_path: '/p' })
    const row = db.prepare('SELECT pinned FROM memories WHERE id = ?').get(memory.id) as { pinned: number }
    expect(row.pinned).toBe(0)

    const [enriched] = enrichMemories(db, [memory])
    expect(enriched.tier).not.toBe('pinned')
  })
})
