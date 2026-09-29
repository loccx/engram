// budget allocation for episode assembly: a policy is the order the reached turns are
// bought in, and the packer charges every turn as it goes, so an order that spreads the
// budget over the sessions (one turn each) and one that deepens the best hits share one
// accounting. rank-greedy is the shipped order, so a recipe that names no policy keeps
// the bytes it served before (arxiv 2609.25913: budgeted evidence completion).
import { classifyQuery, type QueryArchetype } from './search/scoring.js'

/** one turn a hit window reached, with the best hit rank that reached it */
export interface AllocationUnit {
  /** the session the turn belongs to: the group a policy keeps shallow or deep */
  sessionId: string
  /** position inside the session */
  position: number
  /** 0-based hit rank behind the coverage, lower is better */
  rank: number
  /** length of the line this turn renders to, including its role prefix */
  chars: number
  /** author role as stored; null when the corpus carries none */
  role: string | null
}

export interface AllocationContext {
  /** top-ranked hit windows bought before the rest; 0 buys everything through the policy */
  reserveTopHits: number
  /** orders two sessions by date, then id, so rank ties stay deterministic */
  sessionOrder: (a: string, b: string) => number
}

export interface AllocationPolicy {
  name: AllocationPolicyName
  describe: string
  order(units: AllocationUnit[], ctx: AllocationContext): AllocationUnit[]
}

export type AllocationPolicyName = 'rank-greedy' | 'breadth-first' | 'statements-first'

export const DEFAULT_ALLOCATION_POLICY: AllocationPolicyName = 'rank-greedy'

/** what a hit rank is worth: the top hit is 1 and every rank behind it halves */
function rankEvidence(rank: number): number {
  return 1 / (1 + rank)
}

/** evidence a turn buys per character spent, so a short turn outranks a long one at equal rank */
function density(unit: AllocationUnit): number {
  return rankEvidence(unit.rank) / Math.max(1, unit.chars)
}

function byRank(a: AllocationUnit, b: AllocationUnit): number {
  return a.rank - b.rank || a.position - b.position
}

/** units grouped by session, each session's turn list in the order its policy reads it */
function bySession(
  units: AllocationUnit[],
  compare: (a: AllocationUnit, b: AllocationUnit) => number
): Map<string, AllocationUnit[]> {
  const grouped = new Map<string, AllocationUnit[]>()
  for (const unit of units) {
    const list = grouped.get(unit.sessionId)
    if (list) list.push(unit)
    else grouped.set(unit.sessionId, [unit])
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => compare(a, b) || a.position - b.position)
  }
  return grouped
}

function bestRanks(units: AllocationUnit[]): Map<string, number> {
  const best = new Map<string, number>()
  for (const unit of units) {
    const known = best.get(unit.sessionId)
    if (known === undefined || unit.rank < known) best.set(unit.sessionId, unit.rank)
  }
  return best
}

const rankGreedy: AllocationPolicy = {
  name: 'rank-greedy',
  describe:
    'one session at a time, best hit rank first: the budget deepens the top hits before it reaches the rest',
  order: (units, ctx) => {
    const best = bestRanks(units)
    // turns inside a session are read in order, so the session renders as a timeline
    const grouped = bySession(units, () => 0)
    return [...grouped.keys()]
      .sort((a, b) => (best.get(a) ?? 0) - (best.get(b) ?? 0) || ctx.sessionOrder(a, b))
      .flatMap((sessionId) => grouped.get(sessionId) ?? [])
  },
}

// every reached session before any session's second turn: a counting question needs one
// turn per session, so depth is bought round by round and density decides what a session's
// next turn is worth
const breadthFirst: AllocationPolicy = {
  name: 'breadth-first',
  describe: 'the densest turn of every reached session, then each session one turn deeper, round by round',
  order: (units) => {
    const queues = bySession(units, (a, b) => density(b) - density(a))
    const out: AllocationUnit[] = []
    let round = 0
    while (queues.size > 0) {
      const take: AllocationUnit[] = []
      for (const list of queues.values()) {
        const unit = list[round]
        if (unit) take.push(unit)
      }
      take.sort((a, b) => density(b) - density(a) || byRank(a, b))
      out.push(...take)
      for (const [sessionId, list] of [...queues]) {
        if (list.length <= round + 1) queues.delete(sessionId)
      }
      round++
    }
    return out
  },
}

// a reply is the long turn that fills the budget, while an aggregation question is
// answered from what was stated
const statementsFirst: AllocationPolicy = {
  name: 'statements-first',
  describe: 'the reached statement turns before any reply, one session at a time and best rank first',
  order: (units) => {
    const byStatement = (list: AllocationUnit[]): AllocationUnit[] =>
      [...list].sort(
        (a, b) => Number(b.role === 'user') - Number(a.role === 'user') || byRank(a, b)
      )
    return byStatement(units)
  },
}

/** the registry: adding a policy is one entry here plus a test */
export const ALLOCATION_POLICIES: Record<string, AllocationPolicy> = {
  [rankGreedy.name]: rankGreedy,
  [breadthFirst.name]: breadthFirst,
  [statementsFirst.name]: statementsFirst,
}

export function allocationPolicyNames(): string[] {
  return Object.keys(ALLOCATION_POLICIES)
}

export function allocationPolicyOf(name: string): AllocationPolicy {
  const policy = ALLOCATION_POLICIES[name]
  if (!policy) {
    throw new Error(
      `engram: unknown allocation policy "${name}"; known: ${allocationPolicyNames().join(', ')}`
    )
  }
  return policy
}

/**
 * reserve first, then the policy's own order over what is left: the question's own best
 * evidence is bought before a cheap turn from a session that only mentions the item
 */
export function orderAllocation(
  name: AllocationPolicyName | undefined,
  units: AllocationUnit[],
  ctx: AllocationContext
): AllocationUnit[] {
  const policy = allocationPolicyOf(name ?? DEFAULT_ALLOCATION_POLICY)
  const reserve = Math.max(0, ctx.reserveTopHits)
  if (reserve === 0) return policy.order(units, ctx)
  return [
    ...policy.order(units.filter((unit) => unit.rank < reserve), ctx),
    ...policy.order(units.filter((unit) => unit.rank >= reserve), ctx),
  ]
}

/** one policy, and the reserve it buys ahead */
export interface AllocationChoice {
  policy: AllocationPolicyName
  /** top-ranked hit windows bought before the rest; absent buys everything through the policy */
  reserveTopHits?: number
}

/** how a recipe allocates the evidence budget: one choice per query archetype */
export interface RecipeAllocation {
  /** the choice an archetype the map does not name is served by */
  default: AllocationChoice
  /** per query archetype overrides, so one class of question can spend the budget differently */
  archetypes?: Partial<Record<QueryArchetype, AllocationChoice>>
}

export interface ResolvedAllocation {
  policy: AllocationPolicyName
  reserveTopHits: number
}

export function allocationForQuery(
  allocation: RecipeAllocation,
  query: string
): ResolvedAllocation {
  const choice = allocation.archetypes?.[classifyQuery(query)] ?? allocation.default
  return { policy: choice.policy, reserveTopHits: choice.reserveTopHits ?? 0 }
}

export interface AllocationPackInput {
  /** units in buy order */
  units: AllocationUnit[]
  /** the line a session's group opens with, e.g. its date stamp; charged once */
  headerOf: (sessionId: string) => string
  budgetChars: number
}

export interface AllocationGroup {
  sessionId: string
  units: AllocationUnit[]
}

export interface AllocationPackResult {
  /** opened groups, in buy order */
  groups: AllocationGroup[]
  /** every unit bought, in buy order */
  kept: AllocationUnit[]
  usedChars: number
  /** sessions a hit reached that bought nothing */
  skippedSessions: number
}

/**
 * buy the ordered units: a group opens (its header and separator charged) with its first
 * bought turn, a turn that does not fit is skipped so a shorter one behind it can still
 * pay, and a session that bought nothing counts as skipped.
 */
export function packAllocation(input: AllocationPackInput): AllocationPackResult {
  const groups: AllocationGroup[] = []
  const open = new Map<string, AllocationGroup>()
  const reached = new Set<string>()
  const skipped = new Set<string>()
  const kept: AllocationUnit[] = []
  let used = 0
  for (const unit of input.units) {
    if (!reached.has(unit.sessionId)) {
      reached.add(unit.sessionId)
      skipped.add(unit.sessionId)
    }
    const group = open.get(unit.sessionId)
    const opening = group === undefined
    const header = opening ? input.headerOf(unit.sessionId).length : 0
    const separator = opening && groups.length > 0 ? 2 : 0
    const charge = header + separator + unit.chars + 1
    if (used + charge > input.budgetChars) continue
    if (opening) {
      const opened: AllocationGroup = { sessionId: unit.sessionId, units: [unit] }
      open.set(unit.sessionId, opened)
      groups.push(opened)
    } else {
      group.units.push(unit)
    }
    skipped.delete(unit.sessionId)
    kept.push(unit)
    used += charge
  }
  return { groups, kept, usedChars: used, skippedSessions: skipped.size }
}