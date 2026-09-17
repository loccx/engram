/**
 * Memory store cleanup: dedupe, drift-namespace removal, ephemeral-junk purge.
 *
 * Tiers (all use store.delete for full cascade: FTS trigger, vectors, links):
 *   1. exact-dup   — same content text; keep highest access_count, then oldest
 *                    (the original). Cross-namespace copies collapse into the
 *                    highest-access row, killing batch-import muddle.
 *   2. fleet-junk  — ephemeral fleet/prfix CI status notes older than 14d.
 *   3. drift       — namespaces that can no longer receive memories: a path
 *                    that does not exist on disk, or a known stale alias.
 *   4. stale-lean  — importance <= 0.3, older than 60d, access_count <= 1.
 *
 * Usage: npx tsx scripts/cleanup-memory.ts [--execute] [--tier=1,2,3,4]
 * Without --execute prints the plan only.
 */
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { MemoryStore } from '../src/memory/store.js'
import { existsSync } from 'fs'

const EXECUTE = process.argv.includes('--execute')
const tierArg = process.argv.find((a) => a.startsWith('--tier='))
const TIERS = tierArg ? tierArg.split('=')[1].split(',').map(Number) : [1, 2, 3, 4]

// Alias namespaces are not paths, so they cannot be checked against the
// filesystem. These are known import accidents.
const STALE_ALIASES = ['research', 'hlmm']

type Row = { id: string; namespace: string; content: string }

function main() {
  const dbm = getDatabase()
  const db = dbm.db
  // vectorsAvailable=false: this script never writes embeddings.
  const store = new MemoryStore(db, false, undefined, undefined)
  const now = Date.now()
  const plan: Array<{ tier: number; id: string; why: string; ns: string }> = []

  // ---- Tier 1: exact duplicates (same content; cross-namespace collapse) ----
  if (TIERS.includes(1)) {
    const groups = db
      .prepare(
        `SELECT content, COUNT(*) AS n
         FROM memories
         GROUP BY content
         HAVING COUNT(*) > 1`
      )
      .all() as Array<{ content: string; n: number }>
    for (const g of groups) {
      const rows = db
        .prepare(
          `SELECT id, COALESCE(namespace, project_path) AS namespace, content,
                  (access_count IS NULL) AS acc_null, access_count, created_at,
                  pinned, importance
           FROM memories WHERE content = ?`
        )
        .all(g.content) as Array<
        Row & { acc_null: number; access_count: number; created_at: number; pinned: number; importance: number }
      >
      // Keep the strongest row: pinned, then importance, then access_count, then
      // oldest. A pinned row is never the victim.
      const sorted = [...rows].sort((a, b) => {
        if ((b.pinned ?? 0) !== (a.pinned ?? 0)) return (b.pinned ?? 0) - (a.pinned ?? 0)
        if ((b.importance ?? 0) !== (a.importance ?? 0)) return (b.importance ?? 0) - (a.importance ?? 0)
        const aa = a.acc_null ? -1 : a.access_count
        const bb = b.acc_null ? -1 : b.access_count
        if (bb !== aa) return bb - aa
        return a.created_at - b.created_at
      })
      for (const dup of sorted.slice(1)) {
        if ((dup.pinned ?? 0) === 1) continue
        plan.push({ tier: 1, id: dup.id, why: 'exact-dup', ns: dup.namespace })
      }
    }
  }

  // ---- Tier 2: fleet/prfix ephemeral CI notes older than 14d ----
  if (TIERS.includes(2)) {
    const cutoff = now - 14 * 86400000
    const rows = db
      .prepare(
        `SELECT id, COALESCE(namespace, project_path) AS namespace FROM memories
         WHERE created_at < ?
           AND (content LIKE '[fleet/%' OR content LIKE 'Fleet task prfix%'
                OR content LIKE '%fleet workflow finished%')`
      )
      .all(cutoff) as Row[]
    for (const r of rows) plan.push({ tier: 2, id: r.id, why: 'fleet-ephemeral', ns: r.namespace })
  }

  // ---- Tier 3: drift aliases ----
  if (TIERS.includes(3)) {
    for (const ns of STALE_ALIASES) {
      const rows = db
        .prepare(
          `SELECT id, COALESCE(namespace, project_path) AS namespace FROM memories
           WHERE COALESCE(namespace, project_path) = ?`
        )
        .all(ns) as Row[]
      for (const r of rows) plan.push({ tier: 3, id: r.id, why: 'drift-alias', ns })
    }
  }

  // Orphaned namespaces are reported, never planned. An absolute namespace whose
  // directory no longer exists is usually a project that moved, not junk: hive's
  // 2,995 memories outlived their path, and deleting them would discard knowledge.
  // So this class is surfaced for a human decision instead of entering the plan.
  const orphans = (
    db.prepare(`SELECT DISTINCT COALESCE(namespace, project_path) AS ns FROM memories`).all() as Array<{
      ns: string
    }>
  )
    .map((r) => r.ns)
    .filter((ns) => ns.startsWith('/') && !existsSync(ns))

  // ---- Tier 4: stale low-value ----
  if (TIERS.includes(4)) {
    const cutoff = now - 60 * 86400000
    const rows = db
      .prepare(
        `SELECT id, COALESCE(namespace, project_path) AS namespace FROM memories
         WHERE created_at < ? AND importance <= 0.3
           AND (access_count IS NULL OR access_count <= 1)
           AND pinned = 0`
      )
      .all(cutoff) as Row[]
    for (const r of rows) plan.push({ tier: 4, id: r.id, why: 'stale-low-value', ns: r.namespace })
  }

  // Applied after every tier so none can bypass it: a pinned memory is never
  // deleted, and one row is never planned twice (two tiers can select one row).
  const pinnedIds = new Set(
    (db.prepare('SELECT id FROM memories WHERE pinned = 1').all() as Array<{ id: string }>).map((r) => r.id)
  )
  const seenIds = new Set<string>()
  const safePlan = plan.filter((p) => {
    if (pinnedIds.has(p.id)) return false
    if (seenIds.has(p.id)) return false
    seenIds.add(p.id)
    return true
  })
  plan.length = 0
  plan.push(...safePlan)

  const byTier = new Map<number, number>()
  for (const p of plan) byTier.set(p.tier, (byTier.get(p.tier) ?? 0) + 1)
  const total = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
  console.log(`current total: ${total.n}`)
  for (const t of [1, 2, 3, 4]) console.log(`tier ${t}: ${byTier.get(t) ?? 0}`)
  console.log(`plan total: ${plan.length} ${EXECUTE ? 'EXECUTING' : '(dry run)'}`)

  if (orphans.length > 0) {
    const count = db.prepare(
      `SELECT COUNT(*) AS n FROM memories WHERE COALESCE(namespace, project_path) = ?`
    )
    console.log(`orphaned namespaces (report-only, never planned): ${orphans.length}`)
    for (const ns of orphans.slice(0, 10)) {
      console.log(`  ${ns} (${(count.get(ns) as { n: number }).n})`)
    }
  }

  if (!EXECUTE) {
    for (const p of plan.slice(0, 40)) console.log(`  [t${p.tier}] ${p.why} ${p.ns} ${p.id}`)
    return
  }

  let ok = 0
  let fail = 0
  for (const p of plan) {
    try {
      if (store.delete(p.id)) ok++
      else fail++
    } catch (e) {
      fail++
      console.error(`  delete failed ${p.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
  console.log(`deleted: ${ok}, failed: ${fail}, remaining: ${after.n} (was ${total.n})`)
}

// Fresh handle per invocation: no cached test-mode globals.
resetDatabase()
try {
  main()
} finally {
  resetDatabase()
}
