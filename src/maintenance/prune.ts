import type Database from 'better-sqlite3'
import { notSupersededClause } from '../contradictions/supersession.js'
import { logger } from '../utils/logger.js'

// archives near-identical duplicate memories, all but one member of each family.
// grouping is lexical and deterministic: bucket by (namespace, type, text prefix),
// walk in utility order, and a member close enough to a keeper is redundant.
// keeper order: pinned > importance > access_count > link degree > oldest.

export const PRUNE_DEFAULT_SIMILARITY = 0.95
export const PRUNE_DEFAULT_PREFIX_CHARS = 48
export const PRUNE_DEFAULT_SCAN_LIMIT = 20000

export interface PruneOptions {
  namespace?: string
  /** share of the longer text that must be common, character-level, (0,1] */
  threshold?: number
  prefixChars?: number
  // treat every row in a bucket as redundant to its keeper, skipping the ratio
  // test: a burst-written batch shares an opening and diverges afterwards, so it
  // scores far below the threshold. one keeper per bucket still holds.
  clusterPrefix?: boolean
  /** bound on rows examined per run (keeps a lease-safe increment bounded) */
  scanLimit?: number
  now?: number
}

export interface DuplicateMember {
  id: string
  content_chars: number
  importance: number
  access_count: number
  pinned: boolean
  link_degree: number
}

export interface DuplicateGroup {
  key: string
  namespace: string
  type: string
  keeper_id: string
  redundant_ids: string[]
  member_ids: string[]
  /** prefix share of the weakest redundant member against its keeper */
  similarity: number
}

export interface PrunePlan {
  namespace: string | null
  threshold: number
  prefix_chars: number
  scanned: number
  truncated: boolean
  groups: DuplicateGroup[]
  group_count: number
  redundant_rows: number
  keepers: number
}

export interface PruneReport extends PrunePlan {
  archived: number
  links_repointed: number
  links_removed: number
  duration_ms: number
}

interface CandidateRow {
  id: string
  content: string
  namespace: string
  type: string
  importance: number
  access_count: number
  pinned: number
  created_at: number
  last_accessed: number | null
  link_degree: number
}

export function pruneThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.ENGRAM_PRUNE_THRESHOLD ?? '')
  if (!Number.isFinite(n) || n <= 0 || n > 1) return PRUNE_DEFAULT_SIMILARITY
  return n
}

export function prunePrefixChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.ENGRAM_PRUNE_PREFIX_CHARS ?? '', 10)
  if (!Number.isFinite(n) || n < 8) return PRUNE_DEFAULT_PREFIX_CHARS
  return n
}

// the job path carries no per-invocation flags, so `--apply` reads the env
export function pruneClusterPrefix(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ENGRAM_PRUNE_CLUSTER_PREFIX ?? '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

export function prefixSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 1
  return commonPrefixLength(a, b) / longest
}

interface UtilityRow {
  id: string
  importance: number
  access_count: number
  link_degree: number
  pinned: number | boolean
  created_at: number
}

export function utilityRank(a: UtilityRow, b: UtilityRow): number {
  const aPinned = a.pinned === true || a.pinned === 1 ? 1 : 0
  const bPinned = b.pinned === true || b.pinned === 1 ? 1 : 0
  if (aPinned !== bPinned) return bPinned - aPinned
  if (a.importance !== b.importance) return b.importance - a.importance
  if (a.access_count !== b.access_count) return b.access_count - a.access_count
  if (a.link_degree !== b.link_degree) return b.link_degree - a.link_degree
  if (a.created_at !== b.created_at) return a.created_at - b.created_at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export interface LexicalMember extends UtilityRow {
  content: string
  namespace: string
  type: string
}

export interface LexicalCluster {
  key: string
  namespace: string
  type: string
  /** the row a prune or retention pass must keep */
  keeper: LexicalMember
  members: LexicalMember[]
  /** members that share enough text with the keeper to be redundant */
  redundant: Array<{ member: LexicalMember; similarity: number }>
}

export interface LexicalClusterOptions {
  prefixChars?: number
  threshold?: number
  clusterPrefix?: boolean
}

// prune archives each cluster's redundant members, retention counts them as
// interference; both rely on one keeper per cluster
export function clusterLexicalFamilies(
  members: LexicalMember[],
  opts: LexicalClusterOptions = {}
): LexicalCluster[] {
  const prefixChars = opts.prefixChars ?? PRUNE_DEFAULT_PREFIX_CHARS
  const threshold = opts.threshold ?? PRUNE_DEFAULT_SIMILARITY

  const buckets = new Map<string, LexicalMember[]>()
  for (const row of members) {
    const key = `${row.namespace}\u0000${row.type}\u0000${row.content.slice(0, prefixChars)}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }

  const clusters: LexicalCluster[] = []
  for (const [key, bucket] of buckets) {
    const ordered = [...bucket].sort(utilityRank)
    const found: LexicalCluster[] = []
    for (const member of ordered) {
      if (opts.clusterPrefix === true && found.length > 0) {
        // the bucket already proves a shared opening
        const cluster = found[0]
        cluster.members.push(member)
        cluster.redundant.push({
          member,
          similarity: prefixSimilarity(member.content, cluster.keeper.content),
        })
        continue
      }
      let best: { cluster: LexicalCluster; similarity: number } | null = null
      for (const cluster of found) {
        const similarity = prefixSimilarity(member.content, cluster.keeper.content)
        if (!best || similarity > best.similarity) best = { cluster, similarity }
      }
      if (best && best.similarity >= threshold) {
        best.cluster.members.push(member)
        best.cluster.redundant.push({ member, similarity: best.similarity })
      } else {
        found.push({
          key,
          namespace: member.namespace,
          type: member.type,
          keeper: member,
          members: [member],
          redundant: [],
        })
      }
    }
    clusters.push(...found)
  }
  return clusters
}

/** per-row interference view over the same clustering (retention input) */
export function lexicalFamilyIndex(
  members: LexicalMember[],
  opts: LexicalClusterOptions = {}
): { siblings: Map<string, number>; keepers: Set<string> } {
  const siblings = new Map<string, number>()
  const keepers = new Set<string>()
  for (const cluster of clusterLexicalFamilies(members, opts)) {
    keepers.add(cluster.keeper.id)
    for (const member of cluster.members) siblings.set(member.id, cluster.members.length - 1)
  }
  return { siblings, keepers }
}

function loadCandidates(db: Database.Database, opts: PruneOptions): { rows: CandidateRow[]; truncated: boolean } {
  const scanLimit = opts.scanLimit ?? PRUNE_DEFAULT_SCAN_LIMIT
  const where = [`${notSupersededClause('memories.id')}`]
  const params: unknown[] = []
  if (opts.namespace) {
    where.push('COALESCE(namespace, project_path) = ?')
    params.push(opts.namespace)
  }
  const rows = db
    .prepare(
      `SELECT id, content, COALESCE(namespace, project_path) AS namespace, type, importance,
              access_count, pinned, created_at, last_accessed,
              (SELECT COUNT(*) FROM memory_links ml
                WHERE ml.source_id = memories.id OR ml.target_id = memories.id) AS link_degree
       FROM memories
       WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .all(...params, scanLimit + 1) as CandidateRow[]
  const truncated = rows.length > scanLimit
  return { rows: truncated ? rows.slice(0, scanLimit) : rows, truncated }
}

/** plan only, never mutates, so it is safe to run without --apply */
export function planDuplicatePrune(db: Database.Database, opts: PruneOptions = {}): PrunePlan {
  const threshold = opts.threshold ?? pruneThreshold()
  const prefixChars = opts.prefixChars ?? prunePrefixChars()
  const { rows, truncated } = loadCandidates(db, opts)

  const clusterPrefix = opts.clusterPrefix ?? pruneClusterPrefix()
  const clusters = clusterLexicalFamilies(rows, { prefixChars, threshold, clusterPrefix })

  const groups: DuplicateGroup[] = []
  let redundantRows = 0
  let keepers = 0
  for (const cluster of clusters) {
    keepers++
    for (const entry of cluster.redundant) {
      redundantRows++
      groups.push({
        key: cluster.key,
        namespace: cluster.namespace,
        type: cluster.type,
        keeper_id: cluster.keeper.id,
        redundant_ids: [entry.member.id],
        member_ids: cluster.members.map((m) => m.id),
        similarity: Number(entry.similarity.toFixed(6)),
      })
    }
  }

  return {
    namespace: opts.namespace ?? null,
    threshold,
    prefix_chars: prefixChars,
    scanned: rows.length,
    truncated,
    groups,
    group_count: new Set(groups.map((g) => `${g.namespace}\u0000${g.type}\u0000${g.keeper_id}`)).size,
    redundant_rows: redundantRows,
    keepers,
  }
}

interface ArchivePair {
  redundantId: string
  keeperId: string
}

export interface ApplyPruneOptions extends PruneOptions {
  /** cap on members archived in one run (lease-safe increment) */
  maxArchive?: number
}

// one transaction per member, so an interrupted run leaves a resumable state
export function applyDuplicatePrune(
  db: Database.Database,
  plan: PrunePlan,
  opts: ApplyPruneOptions = {}
): { archived: number; links_repointed: number; links_removed: number } {
  const now = opts.now ?? Date.now()
  const maxArchive = opts.maxArchive ?? 5000
  const pairs: ArchivePair[] = []
  for (const group of plan.groups) {
    for (const redundantId of group.redundant_ids) {
      if (redundantId === group.keeper_id) continue
      pairs.push({ redundantId, keeperId: group.keeper_id })
    }
  }

  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO memory_links
       (source_id, target_id, similarity, link_type, created_at, confidence, reason,
        decider_model, prompt_version, judged_at, revision)
     SELECT ?, target_id, similarity, link_type, created_at, confidence, reason,
            decider_model, prompt_version, judged_at, revision
     FROM memory_links
     WHERE source_id = ? AND target_id != ?`
  )
  const insertLinkInbound = db.prepare(
    `INSERT OR IGNORE INTO memory_links
       (source_id, target_id, similarity, link_type, created_at, confidence, reason,
        decider_model, prompt_version, judged_at, revision)
     SELECT source_id, ?, similarity, link_type, created_at, confidence, reason,
            decider_model, prompt_version, judged_at, revision
     FROM memory_links
     WHERE target_id = ? AND source_id != ?`
  )
  const deleteLinks = db.prepare('DELETE FROM memory_links WHERE source_id = ? OR target_id = ?')
  const archive = db.prepare('UPDATE memories SET archived_at = ? WHERE id = ? AND archived_at IS NULL')

  let archived = 0
  let repointed = 0
  let removed = 0

  const applyOne = db.transaction((pair: ArchivePair) => {
    const stillOpen = db
      .prepare('SELECT archived_at FROM memories WHERE id = ?')
      .get(pair.redundantId) as { archived_at: number | null } | undefined
    if (!stillOpen || stillOpen.archived_at !== null) return
    const info = archive.run(now, pair.redundantId)
    if (info.changes === 0) return
    archived++
    repointed += insertLink.run(pair.keeperId, pair.redundantId, pair.keeperId).changes
    repointed += insertLinkInbound.run(pair.keeperId, pair.redundantId, pair.keeperId).changes
    removed += deleteLinks.run(pair.redundantId, pair.redundantId).changes
  })

  for (const pair of pairs) {
    if (archived >= maxArchive) break
    try {
      applyOne(pair)
    } catch (err) {
      logger.warn({ err, memoryId: pair.redundantId }, 'prune: archiving a duplicate failed; continuing')
    }
  }

  return { archived, links_repointed: repointed, links_removed: removed }
}

// replanned every run: archived rows leave the scan, so a retry rediscovers the rest
export function runDuplicatePrune(db: Database.Database, opts: ApplyPruneOptions = {}): PruneReport {
  const t0 = Date.now()
  const plan = planDuplicatePrune(db, opts)
  const applied = applyDuplicatePrune(db, plan, opts)
  return {
    ...plan,
    ...applied,
    duration_ms: Date.now() - t0,
  }
}
