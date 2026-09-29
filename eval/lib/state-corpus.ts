// knowledge-update corpora: facts whose value changes over time, in three arms that
// differ only in what the memory layer is told about the change.
//   keyed     — every value carries a state_key, so the write path retires the previous one
//   chained   — no keys; the corpus declares the supersession an adjudicator would write,
//               and backfillChainKeys names the chains afterwards
//   unlinked  — no keys, no links, no closed windows: the status quo before either
// every version is a near-duplicate of the last, so lexical similarity cannot tell them
// apart and only state tracking can.
import { CORPUS_EPOCH } from './harness.js'
import type { Corpus, CorpusMemory, CorpusQuery } from './types.js'

const WEEK = 7 * 86_400_000
const DAY = 86_400_000

export type StateArmName = 'keyed' | 'chained' | 'unlinked'

export interface StateFact {
  subject: string
  attribute: string
  /** oldest first */
  values: string[]
}

export interface StateArm {
  name: StateArmName
  namespace: string
  corpus: Corpus
  facts: StateFact[]
  /** the value index the as-of probes ask about */
  asOfIndex: number
  /** every probe of an as-of question happens at this instant */
  asOf: number
}

const FACTS: StateFact[] = [
  { subject: 'atlas', attribute: 'deploy target', values: ['staging', 'prod-eu', 'prod-us'] },
  { subject: 'orbit', attribute: 'cache ttl', values: ['ten minutes', 'fifteen minutes', 'thirty minutes'] },
  { subject: 'payments', attribute: 'primary region', values: ['us-east-1', 'eu-west-1', 'ap-southeast-2'] },
  { subject: 'ingest', attribute: 'batch size', values: ['250 rows', '500 rows', '1000 rows'] },
  { subject: 'search', attribute: 'embedding model', values: ['bge-small', 'bge-base', 'bge-large'] },
  { subject: 'oncall', attribute: 'rotation length', values: ['one week', 'two weeks', 'three weeks'] },
  { subject: 'public api', attribute: 'rate limit', values: ['60 requests', '120 requests', '300 requests'] },
  { subject: 'audit log', attribute: 'retention window', values: ['30 days', '90 days', '180 days'] },
  { subject: 'alerting', attribute: 'error threshold', values: ['2 percent', '3 percent', '5 percent'] },
  { subject: 'embeddings', attribute: 'model cache dir', values: ['/var/cache/engram', '/srv/cache/engram', '/opt/engram/cache'] },
  { subject: 'worker', attribute: 'concurrency', values: ['4 workers', '8 workers', '16 workers'] },
  { subject: 'sqlite', attribute: 'page size', values: ['4096 bytes', '8192 bytes', '16384 bytes'] },
]

/** value index the as-of probes land on: mid-window, so the boundary cannot decide the answer */
export const STATE_AS_OF_INDEX = 1
/** first n families get an as-of probe */
const AS_OF_FAMILIES = 8
/** first n families get a trajectory probe */
const TRAJECTORY_FAMILIES = 6
/** every family gets a current probe, so the arms are compared on the same questions */
export const STATE_ARM_NAMES: StateArmName[] = ['keyed', 'chained', 'unlinked']

export function stateValueContent(fact: StateFact, value: string): string {
  return `The ${fact.subject} ${fact.attribute} is ${value}.`
}

export function factId(factIndex: number, valueIndex: number): string {
  return `state-f${factIndex}-v${valueIndex}`
}

function armNamespace(name: StateArmName): string {
  return `/eval/state/${name}`
}

/**
 * the scoring clock: after the last change in the corpus, so every value is in the past
 * and the retrieval clock cannot treat the newest ones as scheduled for later
 */
export const STATE_NOW = CORPUS_EPOCH + 4 * WEEK

/** the value index that was true at `at`, or -1 when the fact had not started yet */
export function valueIndexAt(factIndex: number, at: number): number {
  const offset = at - (CORPUS_EPOCH + factIndex * DAY)
  if (offset < 0) return -1
  return Math.min(Math.floor(offset / WEEK), FACTS[0].values.length - 1)
}

function factVersionAt(factIndex: number, valueIndex: number): number {
  return CORPUS_EPOCH + factIndex * DAY + valueIndex * WEEK
}

export function buildStateArm(name: StateArmName): StateArm {
  const namespace = armNamespace(name)
  const asOf = CORPUS_EPOCH + STATE_AS_OF_INDEX * WEEK + Math.floor(WEEK / 2)
  const memories: CorpusMemory[] = []
  const queries: CorpusQuery[] = []

  FACTS.forEach((fact, factIndex) => {
    fact.values.forEach((value, valueIndex) => {
      const at = factVersionAt(factIndex, valueIndex)
      const last = valueIndex === fact.values.length - 1
      const memory: CorpusMemory = {
        id: factId(factIndex, valueIndex),
        namespace,
        content: stateValueContent(fact, value),
        type: 'note',
        created_at: at,
        valid_from: at,
        tags: ['state-probe'],
      }
      if (name === 'keyed') {
        memory.state_key = `${fact.subject} ${fact.attribute}`
        if (!last) memory.valid_until = factVersionAt(factIndex, valueIndex + 1)
      }
      if (name === 'chained') {
        if (!last) {
          memory.superseded_by = factId(factIndex, valueIndex + 1)
          memory.valid_until = factVersionAt(factIndex, valueIndex + 1)
        }
      }
      memories.push(memory)
    })

    const latestId = factId(factIndex, fact.values.length - 1)
    const olderIds = fact.values.slice(0, -1).map((_, i) => factId(factIndex, i))
    queries.push({
      id: `state-current-f${factIndex}`,
      query: `what is the ${fact.subject} ${fact.attribute}?`,
      namespace,
      target_ids: [latestId],
      must_not_retrieve: olderIds,
      kind: 'current',
      latest_target: latestId,
    })

    if (factIndex < AS_OF_FAMILIES) {
      // both directions of wrong are forbidden: a value that had already expired and
      // one that did not exist yet. the valid index differs per fact, because the
      // facts start on different days.
      const validAtIndex = valueIndexAt(factIndex, asOf)
      queries.push({
        id: `state-asof-f${factIndex}`,
        query: `what was the ${fact.subject} ${fact.attribute} back then?`,
        namespace,
        as_of: asOf,
        target_ids: [factId(factIndex, validAtIndex)],
        must_not_retrieve: fact.values
          .map((_, valueIndex) => factId(factIndex, valueIndex))
          .filter((_, valueIndex) => valueIndex !== validAtIndex),
        kind: 'as-of',
      })
    }

    if (factIndex < TRAJECTORY_FAMILIES) {
      queries.push({
        id: `state-trajectory-f${factIndex}`,
        query: `how has the ${fact.subject} ${fact.attribute} changed?`,
        namespace,
        target_ids: fact.values.map((_, valueIndex) => factId(factIndex, valueIndex)),
        kind: 'trajectory',
        search: { include_superseded: true },
      })
    }
  })

  return {
    name,
    namespace,
    corpus: { name: `state-${name}`, seed: 0, memories, queries },
    facts: FACTS,
    asOfIndex: STATE_AS_OF_INDEX,
    asOf,
  }
}

export function buildStateArms(): StateArm[] {
  return STATE_ARM_NAMES.map((name) => buildStateArm(name))
}
