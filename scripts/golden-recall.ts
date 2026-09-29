// regenerate the recall golden fixture the assemble byte-identity test reads:
//
//   npx tsx scripts/golden-recall.ts
//
// the file records the exact json the recall path returned for every case, so the
// fixture has to be written with the path under test when it changes on purpose. an
// accidental change is a test failure, not a regeneration.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemorySearch } from '../src/memory/search.js'
import { MemoryStore } from '../src/memory/store.js'
import { recallContext } from '../src/memory/recall.js'
import {
  GOLDEN_CASES,
  GOLDEN_NAMESPACE,
  GOLDEN_NOW,
  seedGoldenCorpus,
} from '../tests/fixtures/recall-golden-cases.js'
import { createTestDb } from '../tests/helpers.js'

const FIXTURE_PATH = join(import.meta.dirname, '..', 'tests', 'fixtures', 'recall-golden.json')

async function main(): Promise<void> {
  const { db } = createTestDb()
  seedGoldenCorpus(db)
  const store = new MemoryStore(db, false)
  const search = new MemorySearch(db, false)

  const cases: Array<{ name: string; options: unknown; payload: string }> = []
  for (const golden of GOLDEN_CASES) {
    const payload = await recallContext(db, store, search, {
      project_path: GOLDEN_NAMESPACE,
      now: GOLDEN_NOW,
      ...golden.options,
    })
    cases.push({ name: golden.name, options: golden.options, payload: JSON.stringify(payload) })
  }

  const fixture = {
    note: 'captured from the recall path; regenerate with scripts/golden-recall.ts',
    namespace: GOLDEN_NAMESPACE,
    now: GOLDEN_NOW,
    cases,
  }
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`)
  process.stdout.write(`${FIXTURE_PATH}: ${cases.length} cases\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
