// funnel corpus: one root with several sibling scopes, so a flat (one-bucket) subtree
// read can be compared against a leaf read that ascends to ancestor navigation metadata.
// every record is a pure function of `seed` and the scope count, so the corpus hash is
// stable and two runs with the same header produce the same metrics.
//
// two variants, and the difference between them is the reason the suite exists:
//   `clean`    — the root's cluster summary is genuine navigation metadata, so the guide
//                channel may legitimately carry an excerpt of it.
//   `poisoned` — the root's cluster summary is a parent memory BODY verbatim, which is
//                the documented failure mode: a digest that echoes parent content into a
//                child's context. The suite's leak gate must pass on `clean` and fire on
//                `poisoned`. A gate that only ever sees `clean` is an assertion that
//                always holds; seeing it fire is what makes it a control.
//
// the tree also carries a sibling root (`/home/dev/other`) holding the same marker, so a
// gate that passes because the ascent simply found nothing is distinguishable from one
// that passes because the ascent stayed inside the ancestor chain.
//
// the query is shared, and that is load-bearing. the FTS channel matches its terms
// conjunctively, so a leaf-specific query token would match only that leaf and a flat
// subtree read would return exactly what a scoped read returns — the dilution the funnel
// exists to remove would be invisible. Every memory therefore carries the same shared
// token and every query asks the same question, so the two arms differ only in WHERE the
// question is asked.
import { CORPUS_EPOCH } from './harness.js'
import type { Corpus, CorpusCluster, CorpusMemory, CorpusQuery } from './types.js'

export type FunnelVariant = 'clean' | 'poisoned'

export const FUNNEL_ROOT = '/home/dev/spindle'
export const FUNNEL_SIBLING = '/home/dev/other'

/** the two terms every memory body carries and every query names, so a subtree read has to RANK */
export const FUNNEL_SHARED_TOKEN = 'deploy'
export const FUNNEL_SECOND_TOKEN = 'pipeline'

/** the one question every query asks, in each leaf's own scope */
export const FUNNEL_QUERY = `${FUNNEL_SHARED_TOKEN} ${FUNNEL_SECOND_TOKEN}`

/** appears ONLY inside a memory body, never inside navigation metadata — the leak probe */
export const FUNNEL_BODY_MARKER = 'ZQBODYTRAP'

/** leaves with >= FUNNEL_K_MIN (3) matching hits, and one that is thin by construction */
export const FUNNEL_RICH_LEAVES = ['alpha', 'beta', 'gamma', 'epsilon', 'zeta'] as const
export const FUNNEL_THIN_LEAF = 'delta'

/** the named leaves every scale carries, and the ones the suite probes at every scale */
export const FUNNEL_BASE_LEAVES: string[] = [...FUNNEL_RICH_LEAVES, FUNNEL_THIN_LEAF]

/** how many sibling scopes the base (leak-gate) corpus has */
export const FUNNEL_BASE_SCOPES = FUNNEL_BASE_LEAVES.length

// scope counts the suite sweeps for the scaling curve. the base count stays the leak-gate
// corpus; these are extra points on the same axis, and the same leaf is probed at every one
// so the query set is constant and only the tree size moves.
//
// the base count is the FLOOR, not an arbitrary start: `funnelLeaves` always carries the six
// named leaves (the thin one is load-bearing for the ascent), so a smaller count silently
// returns the base tree and would print two identical rows as though they were two points.
export const FUNNEL_SWEEP_SCOPES = [6, 12, 24, 48] as const

/** one distinctive entity token per named leaf; generated leaves derive theirs */
export const FUNNEL_LEAF_TOKENS: Record<string, string> = {
  alpha: 'alphamesh',
  beta: 'betagate',
  gamma: 'gammawheel',
  epsilon: 'epsilonrail',
  zeta: 'zetabuffer',
  delta: 'deltaclip',
}

/**
 * memories per rich leaf; the thin leaf gets one, which cannot reach FUNNEL_K_MIN. bounded
 * because `store_memory` refuses a burst: 5 memories in one namespace opening with the same
 * 48 characters make the next write a rejection, and every body below leads with its own token.
 */
export const FUNNEL_RICH_LEAF_MEMORIES = 12

/** the scope count the suite probes at every scale, so query count stays constant */
export const FUNNEL_PROBE_SCOPES = FUNNEL_BASE_SCOPES

export function funnelLeafPath(leaf: string): string {
  return `${FUNNEL_ROOT}//${leaf}`
}

export function funnelLeafToken(leaf: string): string {
  return FUNNEL_LEAF_TOKENS[leaf] ?? `${leaf}tok`
}

/** `count` sibling scopes: the named ones first, then generated ones */
export function funnelLeaves(count: number): string[] {
  const leaves = [...FUNNEL_BASE_LEAVES]
  for (let i = leaves.length; i < count; i++) {
    leaves.push(`scope${String(i).padStart(2, '0')}`)
  }
  return leaves
}

const HOUR = 3_600_000

function memory(
  id: string,
  namespace: string,
  content: string,
  opts: Partial<CorpusMemory> = {}
): CorpusMemory {
  return {
    id,
    namespace,
    content,
    created_at: CORPUS_EPOCH,
    type: 'note',
    ...opts,
  }
}

// a deterministic value in [0, 1) for one memory, from the seed alone. the corpus has to be a
// pure function of the seed, so this is the only randomness available.
function memoryStrength(seed: number, leaf: string, i: number): number {
  let h = 2166136261 >>> 0
  for (const ch of `${seed}:${leaf}:${i}`) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h / 4294967296
}

/** the term a sense-distractor repeats: it matches the query tokens but names another subject */
const FUNNEL_DISTRACTOR_SUBJECT = 'sales'

// a leaf's own body. it leads with the leaf token and index so no two bodies share a
// 48-character prefix (the burst guard above), and carries the shared token so a subtree read
// has to rank rather than match.
//
// relevance VARIES, and that is the point. with one body shape for every leaf the BM25 scores
// tie across scopes, the tie-break is stable, and a subtree read returns the same top-k
// however large the tree grows, so no scaling curve is derivable. term frequency spreads the
// score, so the top-k is genuinely contested and a bigger tree crowds the queried leaf out.
//
// the three shapes are deliberately close in LENGTH. a long distractor body was tried and
// reverted: it moved the flat read's served chars the wrong way, because a length-penalised
// body never reaches the top-k while the short ones it displaces do, so flat served less than
// funnel and the suite's own content contract failed.
function leafBody(seed: number, leaf: string, i: number): string {
  const strength = memoryStrength(seed, leaf, i)
  const phrase = `the ${FUNNEL_SHARED_TOKEN} ${FUNNEL_SECOND_TOKEN}`
  const lead = `${funnelLeafToken(leaf)} release ${i}:`
  if (strength < 0.34) {
    // strong: the phrase repeats, so term frequency lifts it above an ordinary body
    return `${lead} ${phrase}, ${phrase} and ${phrase} are recorded in this scope's runbook.`
  }
  if (strength < 0.8) {
    return (
      `${lead} ${phrase} records rollback notes, operator sign-off and the canary window, ` +
      `filed against this scope's own release train.`
    )
  }
  // sense distractor: the same query tokens name another subject, so it matches weakly
  return (
    `${lead} ${phrase} is mentioned in passing while this scope tracks ` +
    `${FUNNEL_DISTRACTOR_SUBJECT} quotas and renewal dates.`
  )
}

/**
 * the parent body. it matches the same query as every leaf (it carries the shared token)
 * and carries the marker, so it is a genuine trap: if the ascent ever served a body
 * instead of navigation metadata, this is the body it would serve.
 */
export function funnelTrapBody(): string {
  return (
    `The ${FUNNEL_SHARED_TOKEN} ${FUNNEL_SECOND_TOKEN} escalation path is owned by the root ` +
    `on-call, and ${FUNNEL_BODY_MARKER} is recorded only in this parent memory body.`
  )
}

/** genuine navigation metadata: names the scopes, carries the query tokens, carries no body */
function cleanRootSummary(leaves: string[]): string {
  return (
    `Scope index for the ${FUNNEL_SHARED_TOKEN} pipeline tree: ` +
    leaves.map((leaf) => `${leaf} (${funnelLeafToken(leaf)})`).join(', ') +
    '. Each scope holds its own release records; read a scope directly.'
  )
}

export function buildFunnelCorpus(
  seed: number,
  variant: FunnelVariant,
  scopeCount: number = FUNNEL_BASE_SCOPES
): Corpus {
  const leaves = funnelLeaves(scopeCount)
  const memories: CorpusMemory[] = []
  const clusters: CorpusCluster[] = []

  // one rich leaf per scope, plus the thin one
  for (const leaf of leaves) {
    const count = leaf === FUNNEL_THIN_LEAF ? 1 : FUNNEL_RICH_LEAF_MEMORIES
    for (let i = 0; i < count; i++) {
      memories.push(
        memory(`funnel-${leaf}-${i}`, funnelLeafPath(leaf), leafBody(seed, leaf, i), {
          // spread the clock so ranking has a stable order to fall back on
          created_at: CORPUS_EPOCH + i * HOUR,
          importance: 0.6,
        })
      )
    }
  }

  // the parent body that must never reach the guide
  memories.push(
    memory('funnel-root-trap', FUNNEL_ROOT, funnelTrapBody(), {
      created_at: CORPUS_EPOCH + 100 * HOUR,
      importance: 0.9,
      type: 'decision',
    })
  )
  // the same marker in a SIBLING root, so "nothing was found" cannot mask a leak
  memories.push(
    memory('funnel-sibling-trap', FUNNEL_SIBLING, funnelTrapBody(), {
      created_at: CORPUS_EPOCH + 100 * HOUR,
      importance: 0.9,
      type: 'decision',
    })
  )

  // nav layer: the root cluster is the only legitimate guide source
  clusters.push({
    namespace: FUNNEL_ROOT,
    member_ids: leaves.map((leaf) => `funnel-${leaf}-0`),
    summary: variant === 'poisoned' ? funnelTrapBody() : cleanRootSummary(leaves),
    created_at: CORPUS_EPOCH,
  })
  // a sibling cluster that shares the query tokens: the ascent must never consult it
  clusters.push({
    namespace: FUNNEL_SIBLING,
    member_ids: ['funnel-sibling-trap'],
    summary: funnelTrapBody(),
    created_at: CORPUS_EPOCH,
  })

  // the same question asked inside each probed leaf's own scope
  const probed = leaves.slice(0, FUNNEL_PROBE_SCOPES)
  const queries: CorpusQuery[] = probed.map((leaf) => ({
    id: `q-funnel-${leaf}`,
    query: FUNNEL_QUERY,
    namespace: funnelLeafPath(leaf),
    target_ids: Array.from(
      { length: leaf === FUNNEL_THIN_LEAF ? 1 : FUNNEL_RICH_LEAF_MEMORIES },
      (_, i) => `funnel-${leaf}-${i}`
    ),
    kind: leaf === FUNNEL_THIN_LEAF ? 'thin-leaf' : 'rich-leaf',
  }))

  return {
    name: `funnel-${variant}-${scopeCount}`,
    seed,
    notes:
      `${leaves.length} sibling scopes under ${FUNNEL_ROOT} ` +
      `(${leaves.length - 1} rich, 1 thin), plus the sibling root ${FUNNEL_SIBLING}; ` +
      `variant=${variant}, probed=${probed.length}`,
    memories,
    queries,
    clusters,
  }
}
