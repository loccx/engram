// per-system scoring: what a system served for a question, in the corpus-local id space,
// plus the cost of serving it. recall here is over the served context, not a k-cut — a
// system that serves the whole haystack covers every target by construction, which is
// what the unbudgeted ceiling means. latency is copied into `timings`, never aggregated.
import { mean, mrr as mrrAt, recallAtK, round3, tokenCost, type TokenizerInfo } from './metrics.js'
import { markdownTable } from './report.js'
import type { MemorySystem, RetrievalResult } from './systems.js'
import type { SystemAggregate, SystemQueryScore, SystemTypeAggregate } from './types.js'

export interface SystemQueryInput {
  system: string
  queryId: string
  kind?: string
  targets: string[]
  /** `${sessionRef}#${turnIndex}` for every message the dataset flags as evidence */
  turnTargets?: string[]
  result: RetrievalResult
  ks: number[]
  tokenizer: TokenizerInfo
}

export function scoreSystemQuery(input: SystemQueryInput): SystemQueryScore {
  const served = input.result.items.map((item, index) => ({
    rank: index + 1,
    ref: item.ref ?? '',
    ...(item.turn === undefined ? {} : { turn: item.turn }),
  }))
  const turnTargets = new Set(input.turnTargets ?? [])
  const attributed = served.some((entry) => entry.turn !== undefined)
  const evidenceTurnHit = attributed
    ? served.some(
        (entry) => entry.turn !== undefined && turnTargets.has(`${entry.ref}#${entry.turn}`)
      )
    : null
  const ranked = served.map((entry) => ({ id: entry.ref }))
  const recall: Record<string, number> = {}
  for (const k of input.ks) {
    recall[`recall@${k}`] = round3(recallAtK(ranked, input.targets, k))
  }
  const cost = tokenCost([input.result.context], input.tokenizer)
  return {
    system: input.system,
    query_id: input.queryId,
    kind: input.kind ?? '',
    targets: input.targets,
    served,
    sessions_represented: new Set(served.map((entry) => entry.ref).filter((ref) => ref !== ''))
      .size,
    evidence_turn_hit: turnTargets.size > 0 ? evidenceTurnHit : null,
    coverage: round3(recallAtK(ranked, input.targets, ranked.length)),
    recall,
    mrr: round3(mrrAt(ranked, input.targets)),
    contextChars: cost.chars,
    contextTokens: cost.tokens,
    retrievalMs: input.result.retrievalMs,
  }
}

export interface AggregateSystemsInput {
  systems: MemorySystem[]
  scores: SystemQueryScore[]
  ks: number[]
}

/** the per-system numbers, over any subset of the questions (all, or one type) */
export function summarizeSystemScores(
  scores: SystemQueryScore[],
  ks: number[]
): SystemTypeAggregate {
  const scored = scores.filter((score) => score.targets.length > 0)
  const recall: Record<string, number> = {}
  for (const k of ks) {
    recall[`recall@${k}`] = round3(mean(scored.map((score) => score.recall[`recall@${k}`] ?? 0)))
  }
  const turnScored = scored.filter((score) => score.evidence_turn_hit !== null)
  return {
    scored: scored.length,
    coverage: round3(mean(scored.map((score) => score.coverage))),
    recall,
    mrr: round3(mean(scored.map((score) => score.mrr))),
    avg_served: round3(mean(scores.map((score) => score.served.length))),
    sessions_per_q: round3(mean(scored.map((score) => score.sessions_represented))),
    evidence_turn_coverage:
      turnScored.length === 0
        ? null
        : round3(mean(turnScored.map((score) => (score.evidence_turn_hit ? 1 : 0)))),
    evidence_turn_scored: turnScored.length,
    avg_context_tokens: round3(mean(scores.map((score) => score.contextTokens))),
  }
}

export function aggregateSystems(input: AggregateSystemsInput): Record<string, SystemAggregate> {
  const out: Record<string, SystemAggregate> = {}
  for (const system of input.systems) {
    const scores = input.scores.filter((score) => score.system === system.name)
    const cost = system.cost()
    const byType: Record<string, SystemTypeAggregate> = {}
    for (const kind of [...new Set(scores.map((score) => score.kind))].sort()) {
      byType[kind] = summarizeSystemScores(
        scores.filter((score) => score.kind === kind),
        input.ks
      )
    }
    out[system.name] = {
      describe: system.describe,
      adapter_kind: system.adapter.kind,
      adapter_config_hash: system.adapter.configHash,
      questions: scores.length,
      ...summarizeSystemScores(scores, input.ks),
      by_question_type: byType,
      write_calls: cost.writeCalls,
      write_tokens: cost.writeTokens,
      stored_vectors: system.storedVectors?.() ?? null,
      lexical_only: system.lexicalOnly === true,
    }
  }
  return out
}

/**
 * `mem 0/53, ep 0/0` — the number that says whether a run's vector channel was in play.
 * a system with no vector channel at all is labelled, so its 0 is not read as a defect.
 */
export function storedVectorsCell(entry: SystemAggregate): string {
  const stored = entry.stored_vectors
  if (!stored) return entry.lexical_only ? 'lexical only' : '-'
  const cells: string[] = []
  if (stored.memories.rows > 0) cells.push(`mem ${stored.memories.vectors}/${stored.memories.rows}`)
  if (stored.episodes.rows > 0) cells.push(`ep ${stored.episodes.vectors}/${stored.episodes.rows}`)
  const body = cells.length > 0 ? cells.join(', ') : 'no rows'
  return entry.lexical_only ? `${body} (lexical only)` : body
}

export function renderSystemsSection(input: {
  systems: Record<string, SystemAggregate>
  ks: number[]
}): string {
  const names = Object.keys(input.systems)
  if (names.length === 0) return ''
  return markdownTable({
    columns: [
      'system',
      'adapter',
      'scored',
      'coverage',
      ...input.ks.map((k) => `recall@${k}`),
      'mrr',
      'served/q',
      'sessions/q',
      'evid-turn cov',
      'ctx tokens/q',
      'store calls',
      'write llm tokens',
      'vectors stored/rows',
    ],
    rows: names.map((name) => {
      const entry = input.systems[name]
      const adapter =
        entry.adapter_config_hash === ''
          ? entry.adapter_kind
          : `${entry.adapter_kind} ${entry.adapter_config_hash.slice(0, 8)}`
      return [
        name,
        adapter,
        entry.scored,
        entry.coverage,
        ...input.ks.map((k) => entry.recall[`recall@${k}`] ?? 0),
        entry.mrr,
        entry.avg_served,
        entry.sessions_per_q,
        entry.evidence_turn_coverage === null ? '-' : entry.evidence_turn_coverage,
        entry.avg_context_tokens,
        entry.write_calls,
        entry.write_tokens ?? '-',
        storedVectorsCell(entry),
      ]
    }),
  })
}
