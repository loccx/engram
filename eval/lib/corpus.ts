// seeded, deterministic corpora: every one is a pure function of `seed`
// (mulberry32), so the same seed gives the same memories, queries and hash, and each
// record carries a stable id, the ids its query should retrieve and its namespace.
// five of them exist because one "does it retrieve" corpus cannot see a whole class of
// bugs: paraphrase (no rare token shared with the target, so it measures the semantic
// channel), distractor (near-duplicate decoys, where recall@1 and mrr discriminate),
// temporal-update (revised facts, half the queries historical), cross-namespace (a leak
// test over synthetic `ns//scope` nodes and a sibling) and long-horizon (drift across
// sessions, some superseded).
import type { Corpus, CorpusMemory, CorpusQuery, LabelledPair, PairRelation } from './types.js'
import { CORPUS_EPOCH } from './harness.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** function words, ignored by the lexical-overlap check */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'has',
  'have', 'had', 'not', 'but', 'you', 'your', 'our', 'its', 'it', 'is', 'be', 'been', 'can',
  'will', 'should', 'must', 'when', 'what', 'which', 'where', 'who', 'how', 'why', 'does',
  'did', 'do', 'of', 'to', 'in', 'on', 'at', 'by', 'as', 'an', 'a', 'or', 'if', 'then',
  'than', 'so', 'we', 'they', 'them', 'their', 'there', 'here', 'about', 'after', 'before',
  'long', 'many', 'much', 'more', 'most', 'all', 'any', 'some', 'each', 'every', 'one', 'two',
  'now', 'still', 'also', 'only', 'just', 'over', 'per', 'up', 'out', 'get', 'got', 'use',
  'used', 'using', 'set', 'scheduled', 'default', 'current', 'currently', 'please', 'tell',
  'need', 'want', 'know', 'see', 'make', 'made', 'run', 'runs', 'running',
])

export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
}

/** rare tokens two strings share: not a stopword, not numeric */
export function sharedRareTokens(a: string, b: string): string[] {
  const left = new Set(contentTokens(a))
  return [...new Set(contentTokens(b))].filter((t) => left.has(t)).sort()
}

/** mulberry32 — small, fast, fully specified for a given seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function memory(
  id: string,
  namespace: string,
  content: string,
  opts: Partial<CorpusMemory> = {}
): CorpusMemory {
  return {
    id,
    content,
    namespace,
    created_at: opts.created_at ?? CORPUS_EPOCH,
    ...opts,
  }
}

// paraphrase

interface ParaphraseItem {
  id: string
  statement: string
  paraphrase: string
}

const PARAPHRASE_ITEMS: ParaphraseItem[] = [
  {
    id: 'para-rollback',
    statement: 'The nightly rollback drill starts at 02:30 UTC and finishes in eleven minutes.',
    paraphrase: 'When does the evening emergency-recovery rehearsal begin, and how much time does it need?',
  },
  {
    id: 'para-pool',
    statement: 'The orbit service opens at most 32 simultaneous database sockets.',
    paraphrase: 'How many parallel storage connections can be held open at once?',
  },
  {
    id: 'para-threshold',
    statement: 'Alerting fires only when the error ratio passes three percent for five minutes.',
    paraphrase: 'What level of failing requests triggers a page, and over which measurement window?',
  },
  {
    id: 'para-keyrotation',
    statement: 'Signing keys for the orbit gateway are replaced every ninety days.',
    paraphrase: 'How often do we swap the cryptographic material used to authenticate the edge?',
  },
  {
    id: 'para-cache',
    statement: 'The orbit catalogue keeps expensive lookups in memory for fifteen minutes.',
    paraphrase: 'How long are costly read results kept close at hand before being recomputed?',
  },
  {
    id: 'para-quota',
    statement: 'Each tenant may store at most two hundred gigabytes of attachments.',
    paraphrase: 'What is the ceiling on uploaded files a single paying customer can keep?',
  },
  {
    id: 'para-timeout',
    statement: 'Upstream calls give up after four point five seconds.',
    paraphrase: 'How much time does the client allow a remote dependency before abandoning it?',
  },
  {
    id: 'para-batch',
    statement: 'The reconciliation job groups work into chunks of five hundred invoices.',
    paraphrase: 'How many billing documents are handled in one processing pass?',
  },
  {
    id: 'para-flag',
    statement: 'The staggered-release switch for the new editor stays fully on for all accounts.',
    paraphrase: 'Is the experimental interface exposed to everybody, or only some users?',
  },
  {
    id: 'para-retention',
    statement: 'Audit trails are discarded after seven years.',
    paraphrase: 'How long do we keep the historical record of who changed what?',
  },
]

const PARAPHRASE_NS = '/home/dev/atlas'

function paraphraseCorpus(seed: number): Corpus {
  const random = rng(seed)
  const memories: CorpusMemory[] = []
  const queries: CorpusQuery[] = []

  for (const item of PARAPHRASE_ITEMS) {
    memories.push(memory(item.id, PARAPHRASE_NS, item.statement, { tags: ['fact'] }))
    queries.push({
      id: `q-${item.id}`,
      query: item.paraphrase,
      namespace: PARAPHRASE_NS,
      target_ids: [item.id],
      kind: 'paraphrase',
    })
  }

  // filler rows keep the corpus non-trivial: a retriever that returns nothing
  // scores 0 here, and a retriever that returns everything scores low MRR).
  const topics = ['deployment', 'metrics', 'onboarding', 'incident review', 'cost review']
  for (let i = 0; i < 20; i++) {
    const topic = topics[Math.floor(random() * topics.length)]
    memories.push(
      memory(`para-filler-${i}`, PARAPHRASE_NS, `Weekly ${topic} notes, entry ${i}: nothing actionable.`, {
        created_at: CORPUS_EPOCH - (i + 1) * DAY,
      })
    )
  }

  return { name: 'paraphrase', seed, memories, queries }
}

// distractor

interface DistractorItem {
  id: string
  code: string
  /** the true fact */
  target: string
  /** decoys sharing the code and the query's rare tokens */
  decoys: string[]
  query: string
  family: 'near-duplicate-decoys' | 'context-clue'
}

const DISTRACTOR_ITEMS: DistractorItem[] = [
  {
    id: 'dist-retention',
    code: 'QX-7734',
    target: 'QX-7734 event retention was set to 90 days during the migration freeze.',
    decoys: [
      'QX-7734 event retention was 14 days during the migration freeze rollout plan.',
      'QX-7734 event retention is 45 days according to the migration freeze checklist.',
      'QX-7734 retention for events froze at 365 days before the migration freeze began.',
    ],
    query: 'What retention was agreed for QX-7734 events during the migration freeze?',
    family: 'near-duplicate-decoys',
  },
  {
    id: 'dist-timeout',
    code: 'QX-8891',
    target: 'QX-8891 gateway timeout is 4.5 seconds after the latency budget review.',
    decoys: [
      'QX-8891 gateway timeout is 0.5 seconds after the latency budget review.',
      'QX-8891 gateway timeout is 30 seconds after the latency budget review.',
      'QX-8891 timeout budget review moved the gateway timeout to 12 seconds.',
    ],
    query: 'What gateway timeout did QX-8891 get after the latency budget review?',
    family: 'near-duplicate-decoys',
  },
  {
    id: 'dist-shards',
    code: 'QX-2255',
    target: 'QX-2255 search index uses 12 shards per region.',
    decoys: [
      'QX-2255 search index uses 4 shards per region.',
      'QX-2255 search index uses 24 shards per region.',
      'QX-2255 index shards per region were reduced to 2.',
    ],
    query: 'How many shards per region does the QX-2255 search index use?',
    family: 'near-duplicate-decoys',
  },
  {
    id: 'dist-ratelimit',
    code: 'QX-4410',
    target: 'QX-4410 public API allows 1200 requests per minute per tenant.',
    decoys: [
      'QX-4410 public API allows 600 requests per minute per tenant.',
      'QX-4410 public API allows 60 requests per minute per tenant.',
      'QX-4410 rate limit for the public API is 5000 requests per minute per tenant.',
    ],
    query: 'What request rate does the QX-4410 public API permit per tenant?',
    family: 'near-duplicate-decoys',
  },
  {
    id: 'dist-window',
    code: 'QX-3312',
    target: 'QX-3312 canary windows run for 20 minutes before promotion.',
    decoys: [
      'QX-3312 canary windows run for 5 minutes before promotion.',
      'QX-3312 canary windows run for 60 minutes before promotion.',
      'QX-3312 promotion windows run for 90 minutes after a canary.',
    ],
    query: 'How long is the canary window for QX-3312 before promotion?',
    family: 'near-duplicate-decoys',
  },
  {
    id: 'dist-burst',
    code: 'QX-9021',
    target: 'QX-9021 queue accepts bursts of 8000 messages before shedding load.',
    decoys: [
      'QX-9021 queue accepts bursts of 800 messages before shedding load.',
      'QX-9021 queue accepts bursts of 80000 messages before shedding load.',
      'QX-9021 queue sheds load when bursts exceed 2500 messages.',
    ],
    query: 'What burst size can the QX-9021 queue absorb before it sheds load?',
    family: 'near-duplicate-decoys',
  },
  {
    id: 'dist-clue',
    code: 'QX-1500',
    target: 'QX-1500 snapshot interval is 30 minutes; raised during the invoice reconciliation incident.',
    decoys: [
      'QX-1500 snapshot interval is 30 minutes; set during the new hire onboarding session.',
      'QX-1500 snapshot interval is 30 minutes; set during the conference travel planning.',
      'QX-1500 snapshot interval is 30 minutes; set during the weekend hiking trip.',
    ],
    query: 'Why was the QX-1500 snapshot interval raised to 30 minutes, and during which incident?',
    family: 'context-clue',
  },
  {
    id: 'dist-clue-2',
    code: 'QX-1601',
    target: 'QX-1601 retry ceiling is 7 attempts; it was lifted because of the ledger settlement outage.',
    decoys: [
      'QX-1601 retry ceiling is 7 attempts; it was lifted after the team offsite feedback.',
      'QX-1601 retry ceiling is 7 attempts; it was lifted because of a typo in the docs.',
      'QX-1601 retry ceiling is 7 attempts; it was lifted during a routine dependency bump.',
    ],
    query: 'Why was the QX-1601 retry ceiling raised to 7 attempts, and which outage caused it?',
    family: 'context-clue',
  },
]

const DISTRACTOR_NS = '/home/dev/beacon'

function distractorCorpus(seed: number): Corpus {
  const random = rng(seed)
  const memories: CorpusMemory[] = []
  const queries: CorpusQuery[] = []

  for (const item of DISTRACTOR_ITEMS) {
    memories.push(memory(item.id, DISTRACTOR_NS, item.target, { tags: ['fact'] }))
    item.decoys.forEach((decoy, i) => {
      memories.push(
        memory(`${item.id}-decoy-${i + 1}`, DISTRACTOR_NS, decoy, {
          tags: ['fact'],
          created_at: CORPUS_EPOCH + (i + 1) * HOUR,
        })
      )
    })
    queries.push({
      id: `q-${item.id}`,
      query: item.query,
      namespace: DISTRACTOR_NS,
      target_ids: [item.id],
      must_not_retrieve: item.decoys.map((_, i) => `${item.id}-decoy-${i + 1}`),
      kind: item.family,
    })
  }

  for (let i = 0; i < 5; i++) {
    const topic = ['standup', 'retro board', 'sprint review'][Math.floor(random() * 3)]
    memories.push(memory(`dist-filler-${i}`, DISTRACTOR_NS, `Plain ${topic} note ${i}, no decisions.`))
  }

  return { name: 'distractor', seed, memories, queries }
}

// temporal-update

interface TemporalItem {
  id: string
  oldFact: string
  newFact: string
  presentQuery: string
  historicalQuery: string
}

const TEMPORAL_ITEMS: TemporalItem[] = [
  {
    id: 'tmp-deploy-window',
    oldFact: 'The cantilever deploy window is 15 minutes long.',
    newFact: 'The cantilever deploy window is 45 minutes long.',
    presentQuery: 'How long is the cantilever deploy window?',
    historicalQuery: 'How long was the cantilever deploy window in March?',
  },
  {
    id: 'tmp-retries',
    oldFact: 'The ratchet payment retry ceiling is 3 attempts.',
    newFact: 'The ratchet payment retry ceiling is 5 attempts.',
    presentQuery: 'What is the ratchet payment retry ceiling?',
    historicalQuery: 'What was the ratchet payment retry ceiling originally?',
  },
  {
    id: 'tmp-region',
    oldFact: 'The plinth primary region is eu-west-1.',
    newFact: 'The plinth primary region is us-east-2.',
    presentQuery: 'Which region is plinth primary running in?',
    historicalQuery: 'Which region did plinth primary use before the move?',
  },
  {
    id: 'tmp-quorum',
    oldFact: 'The spire quorum size is 3 nodes.',
    newFact: 'The spire quorum size is 2 nodes.',
    presentQuery: 'What is the spire quorum size?',
    historicalQuery: 'What spire quorum size did we run previously?',
  },
  {
    id: 'tmp-license',
    oldFact: 'The falcon license seats are 40.',
    newFact: 'The falcon license seats are 60.',
    presentQuery: 'How many falcon license seats do we have?',
    historicalQuery: 'How many falcon seats did the old contract cover?',
  },
  {
    id: 'tmp-backup',
    oldFact: 'Bastion backups are taken every 6 hours.',
    newFact: 'Bastion backups are taken every 2 hours.',
    presentQuery: 'How often are bastion backups taken?',
    historicalQuery: 'What was the original bastion backup interval?',
  },
]

const TEMPORAL_NS = '/home/dev/cinder'
const REVISION_AT = CORPUS_EPOCH + 90 * DAY

function temporalUpdateCorpus(seed: number): Corpus {
  const random = rng(seed)
  const memories: CorpusMemory[] = []
  const queries: CorpusQuery[] = []

  for (const item of TEMPORAL_ITEMS) {
    memories.push(
      memory(`${item.id}-v1`, TEMPORAL_NS, item.oldFact, {
        created_at: CORPUS_EPOCH,
        valid_from: CORPUS_EPOCH,
        valid_until: REVISION_AT,
        superseded_by: `${item.id}-v2`,
        tags: ['decision'],
      })
    )
    memories.push(
      memory(`${item.id}-v2`, TEMPORAL_NS, item.newFact, {
        created_at: REVISION_AT,
        valid_from: REVISION_AT,
        tags: ['decision'],
      })
    )
    queries.push({
      id: `q-${item.id}-present`,
      query: item.presentQuery,
      namespace: TEMPORAL_NS,
      target_ids: [`${item.id}-v2`],
      must_not_retrieve: [`${item.id}-v1`],
      kind: 'present-state',
    })
    queries.push({
      id: `q-${item.id}-history`,
      query: item.historicalQuery,
      namespace: TEMPORAL_NS,
      target_ids: [`${item.id}-v1`],
      must_not_retrieve: [`${item.id}-v2`],
      as_of: CORPUS_EPOCH + 30 * DAY,
      kind: 'historical',
    })
  }

  for (let i = 0; i < 6; i++) {
    const topic = ['vendor call', 'office logistics', 'release calendar'][Math.floor(random() * 3)]
    memories.push(memory(`tmp-filler-${i}`, TEMPORAL_NS, `Background note about ${topic} ${i}.`))
  }

  return {
    name: 'temporal-update',
    seed,
    memories,
    queries,
    notes: `revision boundary at ${REVISION_AT} (90 days after the corpus epoch)`,
  }
}

// cross-namespace

const GRID_ROOT = '/home/dev/grid'
const GRID_AUTH = `${GRID_ROOT}//authsvc`
const GRID_BILLING = `${GRID_ROOT}//billingsvc`
const GRID_REPORTS = `${GRID_ROOT}/reports`
const GRID_SIBLING = '/home/dev/other'

const WINDOW_FACTS: Array<{ ns: string; id: string; content: string; scope?: string }> = [
  {
    ns: GRID_ROOT,
    id: 'xn-root',
    content: 'The grid window for digest flushing is 8 seconds at the root level.',
  },
  {
    ns: GRID_ROOT,
    id: 'xn-auth',
    scope: 'authsvc',
    content: 'The grid window for token rotation in authsvc is 15 minutes.',
  },
  {
    ns: GRID_ROOT,
    id: 'xn-billing',
    scope: 'billingsvc',
    content: 'The grid window for invoice settlement retries in billingsvc is 3 attempts.',
  },
  {
    ns: GRID_REPORTS,
    id: 'xn-reports',
    content: 'The grid window for scheduled report generation is 04:00 local time.',
  },
  {
    ns: GRID_SIBLING,
    id: 'xn-other',
    content: 'The grid window for warehouse compactions in the sibling project is 30 minutes.',
  },
]

function crossNamespaceCorpus(seed: number): Corpus {
  const memories: CorpusMemory[] = []
  const queries: CorpusQuery[] = []

  for (const fact of WINDOW_FACTS) {
    const namespace = fact.scope ? `${fact.ns}//${fact.scope}` : fact.ns
    memories.push(
      memory(fact.id, fact.ns, fact.content, { scope: fact.scope, tags: ['fact'] })
    )
    // a second row per namespace, so a scope leak has more than one chance to
    // show up, and so precision@k is not trivially 1.
    memories.push(
      memory(`${fact.id}-variant`, fact.ns, `${fact.content} Confirmed by the window audit.`, {
        scope: fact.scope,
        created_at: CORPUS_EPOCH + DAY,
      })
    )
    queries.push({
      id: `q-${fact.id}-strict`,
      query: 'What is the grid window value?',
      namespace,
      target_ids: [fact.id, `${fact.id}-variant`],
      kind: 'strict-scope',
    })
  }

  // subtree query from the root: descendants, synthetic scopes included, are
  // allowed, the sibling namespace is not.
  queries.push({
    id: 'q-subtree-root',
    query: 'What is the grid window value?',
    namespace: GRID_ROOT,
    // every descendant counts as relevant (`ns/%` and `ns//%`), the sibling does not
    // namespace must never appear.
    target_ids: [
      'xn-root',
      'xn-root-variant',
      'xn-auth',
      'xn-auth-variant',
      'xn-billing',
      'xn-billing-variant',
      'xn-reports',
      'xn-reports-variant',
    ],
    must_not_retrieve: ['xn-other', 'xn-other-variant'],
    kind: 'subtree',
    search: { namespace_subtree: GRID_ROOT },
  })
  queries.push({
    id: 'q-subtree-reports',
    query: 'What is the grid window value?',
    namespace: GRID_REPORTS,
    target_ids: ['xn-reports', 'xn-reports-variant'],
    kind: 'subtree',
    search: { namespace_subtree: GRID_REPORTS },
  })
  // cross-namespace negative: asking from authsvc about billing's value must
  // retrieve authsvc's own fact and nothing from billingsvc.
  queries.push({
    id: 'q-cross-auth-to-billing',
    query: 'What is the grid window for invoice settlement retries?',
    namespace: GRID_AUTH,
    target_ids: ['xn-auth', 'xn-auth-variant'],
    must_not_retrieve: ['xn-billing', 'xn-billing-variant'],
    kind: 'cross-negative',
  })

  return {
    name: 'cross-namespace',
    seed,
    memories,
    queries,
    notes: `namespaces: ${GRID_ROOT}, ${GRID_ROOT}, ${GRID_AUTH}, ${GRID_BILLING}, ${GRID_REPORTS}, ${GRID_SIBLING}`,
  }
}

// long-horizon

interface HorizonFact {
  id: string
  subject: string
  value: string
  laterValue?: string
}

const HORIZON_FACTS: HorizonFact[] = [
  { id: 'lh-region', subject: 'harbor primary region', value: 'eu-central-1', laterValue: 'us-west-2' },
  { id: 'lh-budget', subject: 'harbor monthly spend cap', value: '4200 dollars', laterValue: '6100 dollars' },
  { id: 'lh-contact', subject: 'harbor escalation contact', value: 'the platform on-call rota', laterValue: 'the sre duty manager' },
  { id: 'lh-vendor', subject: 'harbor log vendor', value: 'cedarworks', laterValue: 'northlight' },
  { id: 'lh-domain', subject: 'harbor api domain', value: 'api.harbor.internal', laterValue: 'edge.harbor.internal' },
  { id: 'lh-schedule', subject: 'harbor maintenance slot', value: 'Sunday 03:00', laterValue: 'Wednesday 02:00' },
  { id: 'lh-threshold', subject: 'harbor disk alert threshold', value: '80 percent', laterValue: '90 percent' },
  { id: 'lh-seat', subject: 'harbor analytics seat count', value: '12 seats', laterValue: '25 seats' },
]

const HORIZON_NS = '/home/dev/harbor'
const HORIZON_SESSIONS = 8

function longHorizonCorpus(seed: number): Corpus {
  const random = rng(seed)
  const memories: CorpusMemory[] = []
  const queries: CorpusQuery[] = []
  const fillerTopics = [
    'daily sync', 'code review', 'customer call', 'sprint planning', 'retro',
    'design review', 'incident follow-up', 'release note',
  ]

  for (let i = 0; i < HORIZON_SESSIONS * 7; i++) {
    const topic = fillerTopics[Math.floor(random() * fillerTopics.length)]
    memories.push(
      memory(`lh-filler-${i}`, HORIZON_NS, `Session ${Math.floor(i / 7) + 1} ${topic} note ${i}: no durable decision.`, {
        created_at: CORPUS_EPOCH + i * 2 * DAY,
      })
    )
  }

  HORIZON_FACTS.forEach((fact, index) => {
    const early = CORPUS_EPOCH + (index + 1) * DAY
    const earlyRow = memory(
      `lh-${fact.id}-early`,
      HORIZON_NS,
      `Early on, the ${fact.subject} was recorded as ${fact.value}.`,
      { created_at: early, valid_from: early }
    )
    memories.push(earlyRow)
    if (fact.laterValue) {
      const later = CORPUS_EPOCH + 60 * DAY + index * DAY
      memories.push(
        memory(`lh-${fact.id}-late`, HORIZON_NS, `Updated: the ${fact.subject} is now ${fact.laterValue}.`, {
          created_at: later,
          valid_from: later,
          tags: ['decision'],
        })
      )
      // the revised value supersedes the earlier one, so the stale row must
      // disappear from present-state reads (staleRate measures that).
      earlyRow.superseded_by = `lh-${fact.id}-late`
      earlyRow.valid_until = later
    }
  })

  for (const fact of HORIZON_FACTS) {
    const hasRevision = fact.laterValue !== undefined
    queries.push({
      id: `q-${fact.id}`,
      query: `What is the ${fact.subject}?`,
      namespace: HORIZON_NS,
      target_ids: [hasRevision ? `lh-${fact.id}-late` : `lh-${fact.id}-early`],
      must_not_retrieve: hasRevision ? [`lh-${fact.id}-early`] : undefined,
      kind: hasRevision ? 'revised-fact' : 'stable-fact',
    })
    queries.push({
      id: `q-${fact.id}-history`,
      query: `What was the original ${fact.subject} recorded as?`,
      namespace: HORIZON_NS,
      target_ids: [`lh-${fact.id}-early`],
      as_of: CORPUS_EPOCH + 30 * DAY,
      kind: 'historical',
    })
  }

  return {
    name: 'long-horizon',
    seed,
    memories,
    queries,
    notes: `${HORIZON_SESSIONS} sessions, ${memories.length} memories, revisions at +60 days or later`,
  }
}

// contradiction

interface ContradictionPairSpec {
  id: string
  relation: PairRelation
  existing: string
  incoming: string
  note?: string
}

const CONTRADICTION_PAIRS: ContradictionPairSpec[] = [
  {
    id: 'cx-datastore',
    relation: 'contradicts',
    existing: 'The ledger service keeps its primary datastore in Postgres 15.',
    incoming: 'The ledger service primary datastore is DynamoDB; Postgres is no longer used for it.',
    note: 'same subject, mutually exclusive',
  },
  {
    id: 'cx-retention',
    relation: 'contradicts',
    existing: 'Ledger receipts are never deleted, retention is unlimited.',
    incoming: 'Ledger receipts are deleted after 18 months; nothing beyond that is kept.',
    note: 'same subject, mutually exclusive',
  },
  {
    id: 'cx-clock',
    relation: 'contradicts',
    existing: 'Ledger settlement runs on a UTC wall clock.',
    incoming: 'Ledger settlement uses a monotonic counter and ignores the wall clock entirely.',
    note: 'same subject, mutually exclusive',
  },
  {
    id: 'cx-signing',
    relation: 'contradicts',
    existing: 'Ledger entries are signed with HMAC-SHA1.',
    incoming: 'Ledger entry signing was moved to Ed25519; HMAC-SHA1 is gone.',
    note: 'same subject, mutually exclusive',
  },
  {
    id: 'cx-retries',
    relation: 'updates',
    existing: 'Ledger settlement retries are capped at 3 attempts.',
    incoming: 'Ledger settlement retries are capped at 5 attempts now.',
    note: 'same subject, refined value',
  },
  {
    id: 'cx-batch',
    relation: 'updates',
    existing: 'Ledger reconciliation batches run every 4 hours.',
    incoming: 'Ledger reconciliation batches now run every 90 minutes.',
    note: 'same subject, refined cadence',
  },
  {
    id: 'cx-owner',
    relation: 'updates',
    existing: 'Ledger escalation goes to the payments platform team.',
    incoming: 'Ledger escalation now goes to the settlement reliability group.',
    note: 'same subject, refined owner',
  },
  {
    id: 'cx-partition',
    relation: 'updates',
    existing: 'Ledger settlement is partitioned by merchant id.',
    incoming: 'Ledger settlement is partitioned by settlement date and merchant id.',
    note: 'same subject, refined key',
  },
  {
    id: 'cx-duplicate-a',
    relation: 'duplicate',
    existing: 'Ledger fee rounding uses banker rounding to two decimals.',
    incoming: 'Ledger fee rounding uses banker rounding to two decimals.',
    note: 'identical content',
  },
  {
    id: 'cx-duplicate-b',
    relation: 'duplicate',
    existing: 'Ledger exports are encrypted with age before leaving the cluster.',
    incoming: 'Ledger exports are encrypted with age before leaving the cluster.',
    note: 'identical content',
  },
  {
    id: 'cx-duplicate-c',
    relation: 'duplicate',
    existing: 'Ledger idempotency keys expire after 24 hours.',
    incoming: 'Ledger idempotency keys expire after 24 hours.',
    note: 'identical content',
  },
  {
    id: 'cx-duplicate-d',
    relation: 'duplicate',
    existing: 'Ledger settlement emits a Prometheus counter per batch.',
    incoming: 'Ledger settlement emits a Prometheus counter per batch.',
    note: 'identical content',
  },
  {
    id: 'cx-unrelated-datastore',
    relation: 'unrelated',
    existing: 'The ledger service keeps its primary datastore in Postgres 15.',
    incoming: 'Ledger service dashboards are refreshed every 15 seconds.',
    note: 'same topic vocabulary, different subject',
  },
  {
    id: 'cx-unrelated-retries',
    relation: 'unrelated',
    existing: 'Ledger settlement retries are capped at 3 attempts.',
    incoming: 'Ledger settlement reports are emailed to finance at 3 attempts thresholds.',
    note: 'same topic vocabulary, different subject',
  },
  {
    id: 'cx-unrelated-batch',
    relation: 'unrelated',
    existing: 'Ledger reconciliation batches run every 4 hours.',
    incoming: 'Ledger reconciliation runbook lives in the payments wiki, section 4.',
    note: 'same topic vocabulary, different subject',
  },
  {
    id: 'cx-unrelated-partition',
    relation: 'unrelated',
    existing: 'Ledger settlement is partitioned by merchant id.',
    incoming: 'Ledger settlement merchants are billed on the first working day.',
    note: 'same topic vocabulary, different subject',
  },
]

const CONTRADICTION_NS = '/home/dev/ledger'

function contradictionCorpus(seed: number): Corpus {
  const memories: CorpusMemory[] = []
  const pairs: LabelledPair[] = []
  const queries: CorpusQuery[] = []

  CONTRADICTION_PAIRS.forEach((spec, index) => {
    const existingId = `${spec.id}-existing`
    const incomingId = `${spec.id}-incoming`
    memories.push(
      memory(existingId, CONTRADICTION_NS, spec.existing, {
        created_at: CORPUS_EPOCH + index * HOUR,
        tags: ['decision'],
      })
    )
    memories.push(
      memory(incomingId, CONTRADICTION_NS, spec.incoming, {
        created_at: CORPUS_EPOCH + 30 * DAY + index * HOUR,
        tags: ['decision'],
      })
    )
    pairs.push({
      id: spec.id,
      namespace: CONTRADICTION_NS,
      candidate_id: existingId,
      new_id: incomingId,
      relation: spec.relation,
      note: spec.note,
    })
    queries.push({
      id: `q-${spec.id}`,
      query: spec.incoming,
      namespace: CONTRADICTION_NS,
      target_ids: [incomingId, existingId],
      kind: `pair-${spec.relation}`,
    })
  })

  memories.push(
    memory('cx-filler-1', CONTRADICTION_NS, 'Ledger weekly ops note: nothing durable happened.'),
    memory('cx-filler-2', CONTRADICTION_NS, 'Ledger parking lot: revisit the analytics schema later.')
  )

  return { name: 'contradiction', seed, memories, queries, pairs }
}

// budget

const BUDGET_NS = '/home/dev/relay'

function budgetCorpus(seed: number): Corpus {
  const memories: CorpusMemory[] = []

  // pinned facts become the digest section of the recall budget
  const pinnedFacts = [
    'Relay release train leaves every Thursday at 16:00 UTC.',
    'Relay production credentials live in the sealed vault, never in env files.',
    'Relay on-call escalation is the incident commander rota.',
  ]
  pinnedFacts.forEach((content, i) => {
    memories.push(
      memory(`budget-pinned-${i}`, BUDGET_NS, content, { pinned: true, importance: 1, type: 'decision' })
    )
  })

  // one long target plus shorter siblings, so a small budget has to choose
  memories.push(
    memory(
      'budget-long-target',
      BUDGET_NS,
      'The relay canary policy: ten percent of traffic for thirty minutes, then fifty percent for another thirty minutes, then full rollout; ' +
        'abort automatically if the error ratio exceeds one percent or p99 latency exceeds eight hundred milliseconds during either stage.',
      { importance: 0.9, type: 'decision' }
    )
  )
  for (let i = 0; i < 12; i++) {
    memories.push(
      memory(`budget-filler-${i}`, BUDGET_NS, `Relay canary note ${i}: canary rollout observation, stage details pending.`, {
        created_at: CORPUS_EPOCH + (i + 1) * HOUR,
      })
    )
  }

  const clusters = [
    {
      namespace: BUDGET_NS,
      member_ids: ['budget-long-target'],
      summary: 'Relay canary policy: staged traffic percentages, abort thresholds and observation windows.',
      created_at: CORPUS_EPOCH,
    },
    {
      namespace: BUDGET_NS,
      member_ids: pinnedFacts.map((_, i) => `budget-pinned-${i}`),
      summary: 'Relay operational rules: release train cadence, credential handling and escalation route.',
      created_at: CORPUS_EPOCH,
    },
  ]

  const queries: CorpusQuery[] = [
    {
      id: 'q-budget-canary',
      query: 'What is the relay canary policy for traffic percentages and abort thresholds?',
      namespace: BUDGET_NS,
      target_ids: ['budget-long-target'],
      kind: 'long-target',
    },
    {
      id: 'q-budget-release',
      query: 'When does the relay release train leave?',
      namespace: BUDGET_NS,
      target_ids: ['budget-pinned-0'],
      kind: 'pinned-target',
    },
    {
      id: 'q-budget-escalation',
      query: 'Who handles relay escalation during an incident?',
      namespace: BUDGET_NS,
      target_ids: ['budget-pinned-2'],
      kind: 'pinned-target',
    },
  ]

  return {
    name: 'budget',
    seed,
    memories,
    queries,
    clusters,
    notes: `${pinnedFacts.length} pinned facts (digest) + ${clusters.length} clusters (topics)`,
  }
}

// assembly

// cross-notation

/**
 * identifier notation bridging: a memory storing `hybridSearch` indexes one token that a
 * query written `hybrid_search` cannot reach, since unicode61 does not split on a camel
 * boundary. item prose avoids every token of its own query, so only the bridge can hit.
 */
interface NotationItem {
  id: string
  /** the identifier as the memory stores it */
  stored: string
  /** the same identifier in another notation, as the query */
  query: string
  kind: 'camel-to-snake' | 'snake-to-camel' | 'camel-to-spaced' | 'prose-notation'
  /** prose with no token of `query` in it */
  context: string
  decoy?: { id: string; content: string }
}

const NOTATION_NS = '/home/dev/notation'

const NOTATION_ITEMS: NotationItem[] = [
  {
    id: 'xn-fuse',
    stored: 'hybridSearch',
    query: 'hybrid_search',
    kind: 'camel-to-snake',
    context: 'fuses the lexical and vector evidence before the cross-encoder window is applied.',
    decoy: {
      id: 'xn-fuse-decoy',
      content: 'A hybrid of two ranking signals was proposed and never adopted.',
    },
  },
  {
    id: 'xn-knn',
    stored: 'scopedKnnScan',
    query: 'scoped knn scan',
    kind: 'camel-to-spaced',
    context: 'pushes the namespace predicate into the vector index instead of filtering afterwards.',
    decoy: {
      id: 'xn-knn-decoy',
      content: 'The vector index was benchmarked once and left untouched for two quarters.',
    },
  },
  {
    id: 'xn-ident-table',
    stored: 'memories_ident_fts',
    query: 'memoriesIdentFts',
    kind: 'snake-to-camel',
    context: 'carries normalised text so that lookups do not depend on the query notation.',
  },
  {
    id: 'xn-write-gate',
    stored: 'resolveWriteGateMode',
    query: 'what picks the behaviour for an identical write',
    kind: 'prose-notation',
    context: 'is consulted by the store before a row is inserted, and reads its value from the environment.',
  },
  {
    id: 'xn-backfill',
    stored: 'backfillLexicalIndex',
    query: 'backfill lexical index',
    kind: 'camel-to-spaced',
    context: 'fills the derived column in bounded batches at daemon startup so a large store is not blocked.',
  },
  {
    id: 'xn-archive',
    stored: 'archived_at',
    query: 'archivedAt',
    kind: 'snake-to-camel',
    context: 'marks a row that a prune pass retired, and every read path filters on it.',
  },
  {
    id: 'xn-retention',
    stored: 'retentionMaxScore',
    query: 'retention_max_score',
    kind: 'camel-to-snake',
    context: 'bounds how many rows a clearance pass may retire per boot.',
    decoy: {
      id: 'xn-retention-decoy',
      content: 'A retention policy for the event ledger was discussed and not implemented.',
    },
  },
  {
    id: 'xn-entity-table',
    stored: 'memory_entity_fts',
    query: 'memoryEntityFts',
    kind: 'snake-to-camel',
    context: 'holds one row per extracted symbol, joined back through its owning row id.',
  },
  {
    id: 'xn-rerank-alpha',
    stored: 'rerankBlendAlpha',
    query: 'rerank blend alpha',
    kind: 'camel-to-spaced',
    context: 'weights the cross-encoder against the fused result instead of replacing it.',
  },
  {
    id: 'xn-probe',
    stored: 'lexicalIndexTablePresent',
    query: 'how do we tell a missing identifier table apart from a broken query',
    kind: 'prose-notation',
    context: 'separates a missing index from a genuine failure so the response does not claim a degradation.',
  },
]

function crossNotationCorpus(seed: number): Corpus {
  const random = rng(seed)
  const memories: CorpusMemory[] = []
  const queries: CorpusQuery[] = []

  for (const item of NOTATION_ITEMS) {
    memories.push(
      memory(item.id, NOTATION_NS, `The \`${item.stored}\` symbol ${item.context}`, { tags: ['code'] })
    )
    if (item.decoy) {
      memories.push(memory(item.decoy.id, NOTATION_NS, item.decoy.content, { tags: ['note'] }))
    }
    queries.push({
      id: `q-${item.id}`,
      query: item.query,
      namespace: NOTATION_NS,
      target_ids: [item.id],
      kind: item.kind,
    })
  }

  const topics = ['release notes', 'vendor review', 'budget sync', 'design critique', 'onboarding']
  for (let i = 0; i < 20; i++) {
    const topic = topics[Math.floor(random() * topics.length)]
    memories.push(
      memory(`xn-filler-${i}`, NOTATION_NS, `Weekly ${topic}, entry ${i}: no decision recorded.`, {
        created_at: CORPUS_EPOCH - (i + 1) * DAY,
      })
    )
  }

  // a sibling namespace must never leak into a notation query
  memories.push(
    memory('xn-foreign', '/home/dev/other-notation', 'The `hybridSearch` symbol fuses evidence for a different project.', {
      tags: ['code'],
    })
  )

  return { name: 'cross-notation', seed, memories, queries }
}

export function buildCorpus(name: string, seed: number): Corpus {
  switch (name) {
    case 'paraphrase':
      return paraphraseCorpus(seed)
    case 'distractor':
      return distractorCorpus(seed)
    case 'temporal-update':
      return temporalUpdateCorpus(seed)
    case 'cross-namespace':
      return crossNamespaceCorpus(seed)
    case 'long-horizon':
      return longHorizonCorpus(seed)
    case 'contradiction':
      return contradictionCorpus(seed)
    case 'cross-notation':
      return crossNotationCorpus(seed)
    case 'budget':
      return budgetCorpus(seed)
    case 'mixed':
      return mixedCorpus(seed)
    default:
      throw new Error(
        `unknown corpus "${name}" — known: ${corpusNames().join(', ')}`
      )
  }
}

export function corpusNames(): string[] {
  return [
    'cross-notation',
    'paraphrase',
    'distractor',
    'temporal-update',
    'cross-namespace',
    'long-horizon',
    'contradiction',
    'budget',
    'mixed',
  ]
}

/** every retrieval corpus as one fixed corpus, for a config sweep */
export function mixedCorpus(seed: number): Corpus {
  const parts = [
    paraphraseCorpus(seed),
    distractorCorpus(seed),
    temporalUpdateCorpus(seed),
    longHorizonCorpus(seed),
  ]
  return {
    name: 'mixed',
    seed,
    memories: parts.flatMap((p) => p.memories),
    queries: parts.flatMap((p) => p.queries),
    notes: 'paraphrase + distractor + temporal-update + long-horizon, fixed for config sweeps',
  }
}

/**
 * lexical-overlap audit: a paraphrase query must share no rare
 * token with their target, otherwise the corpus silently becomes a lexical
 * lookup test. Exposed so a test can fail loudly instead of trusting the text.
 */
export function lexicalOverlapViolations(corpus: Corpus): Array<{
  query: string
  target: string
  shared: string[]
}> {
  const byId = new Map(corpus.memories.map((m) => [m.id, m]))
  const violations: Array<{ query: string; target: string; shared: string[] }> = []
  for (const q of corpus.queries) {
    if (q.kind !== 'paraphrase') continue
    for (const targetId of q.target_ids) {
      const target = byId.get(targetId)
      if (!target) continue
      const shared = sharedRareTokens(q.query, target.content)
      if (shared.length > 0) violations.push({ query: q.id, target: targetId, shared })
    }
  }
  return violations
}
