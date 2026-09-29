// suite registry: every suite is one entry, so `--suite <name>|all`, the help text and
// the run order come from this list and a new suite is one line here plus its own module.
// `needs` is declared, not enforced: a suite that needs a gateway says so, and the run
// decides whether the caller supplied one.
import { runAbSuite } from './ab.js'
import { runBudgetSuite } from './budget.js'
import { runContradictionSuite } from './contradiction.js'
import { runLongMemEvalSuite } from './longmemeval.js'
import { runLocomoSuite } from './locomo.js'
import { runMemoryAgentBenchSuite } from './memoryagentbench.js'
import { runRetrievalSuite } from './retrieval.js'
import { runStateSuite } from './state.js'
import type { SuiteContext, SuiteOutput } from './types.js'

export interface SuiteEntry {
  name: string
  run: (ctx: SuiteContext) => Promise<SuiteOutput>
  needs?: 'network' | 'llm'
}

export const SUITES: SuiteEntry[] = [
  { name: 'retrieval', run: runRetrievalSuite },
  { name: 'contradiction', run: runContradictionSuite },
  { name: 'budget', run: runBudgetSuite },
  { name: 'ab', run: runAbSuite },
  { name: 'state', run: runStateSuite },
  { name: 'longmemeval', run: runLongMemEvalSuite },
  { name: 'locomo', run: runLocomoSuite },
  { name: 'memoryagentbench', run: runMemoryAgentBenchSuite },
]

export function suiteNames(): string[] {
  return SUITES.map((suite) => suite.name)
}
