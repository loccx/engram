// byte identity of the read path: routing recall_context through the assembly module
// must not move one byte of the payload recall_context has always returned. the fixture
// was captured from the recall path before the routing, over the corpus
// tests/fixtures/recall-golden-cases.ts seeds again, and holds the exact json string.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemorySearch } from '../src/memory/search.js'
import { MemoryStore } from '../src/memory/store.js'
import { recallContext, type RecallOptions } from '../src/memory/recall.js'
import { recallViaAssemble } from '../src/memory/assemble.js'
import { createTestDb } from './helpers.js'
import { GOLDEN_NAMESPACE, GOLDEN_NOW, seedGoldenCorpus } from './fixtures/recall-golden-cases.js'

interface GoldenCase {
  name: string
  options: Omit<RecallOptions, 'project_path' | 'now'>
  payload: string
}

interface GoldenFixture {
  namespace: string
  now: number
  cases: GoldenCase[]
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'recall-golden.json'), 'utf8')
) as GoldenFixture

describe('recall golden', () => {
  it('replays every captured payload byte-for-byte through the assembly read path', async () => {
    expect(fixture.namespace).toBe(GOLDEN_NAMESPACE)
    expect(fixture.now).toBe(GOLDEN_NOW)
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10)

    const { db } = createTestDb()
    seedGoldenCorpus(db)
    const store = new MemoryStore(db, false)
    const search = new MemorySearch(db, false)

    for (const golden of fixture.cases) {
      const options: RecallOptions = {
        project_path: GOLDEN_NAMESPACE,
        now: GOLDEN_NOW,
        ...golden.options,
      }
      const direct = await recallContext(db, store, search, options)
      expect({ [golden.name]: JSON.stringify(direct) }).toEqual({ [golden.name]: golden.payload })
      const assembled = await recallViaAssemble(db, store, search, options)
      expect({ [golden.name]: JSON.stringify(assembled) }).toEqual({ [golden.name]: golden.payload })
    }
  })
})
