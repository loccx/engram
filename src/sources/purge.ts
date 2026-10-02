import type Database from 'better-sqlite3'
import { prefixCovers } from '../memory/access.js'

export interface SourceAuthority {
  id: string
  namespace: string
  owner_principal: string | null
}

/** only exact-scope, exact-owner provenance can authorize canonical deletion. */
export function sourcePurgePlan(db: Database.Database, authority: SourceAuthority, episodeIds: string[]): {
  memoryIds: Set<string>
  episodeRows: Array<{ id: string; vec_rowid: number | null }>
} {
  const memoryIds = new Set<string>()
  const episodeRows: Array<{ id: string; vec_rowid: number | null }> = []
  const seeds = db.prepare(`SELECT m.id FROM memory_episodes me JOIN memories m ON m.id = me.memory_id
    WHERE me.episode_id = ? AND COALESCE(m.namespace, m.project_path) = ? AND m.owner_principal IS ?`)
  for (const id of episodeIds) {
    const row = db.prepare(`SELECT id, vec_rowid FROM episodes
      WHERE id = ? AND namespace = ? AND owner_principal IS ? AND source_instance = ?
        AND source_revision_id IN (SELECT id FROM source_revisions WHERE connection_id = ?)`)
      .get(id, authority.namespace, authority.owner_principal, authority.id, authority.id) as
      { id: string; vec_rowid: number | null } | undefined
    if (!row) continue
    episodeRows.push(row)
    for (const seed of seeds.all(id, authority.namespace, authority.owner_principal) as Array<{ id: string }>) {
      memoryIds.add(seed.id)
    }
  }
  // a manual successor may have copied the text without inheriting its citations.
  // semantic/contradiction edges and foreign-owned revisions are not deletion authority.
  const successors = db.prepare(`SELECT m.id FROM memory_links ml JOIN memories m ON m.id = ml.source_id
    WHERE ml.target_id = ? AND ml.link_type = 'supersedes' AND ml.revision > 0
      AND COALESCE(m.namespace, m.project_path) = ? AND m.owner_principal IS ?`)
  const frontier = [...memoryIds]
  for (let i = 0; i < frontier.length; i++) {
    for (const row of successors.all(frontier[i], authority.namespace, authority.owner_principal) as Array<{ id: string }>) {
      if (!memoryIds.has(row.id)) { memoryIds.add(row.id); frontier.push(row.id) }
    }
  }
  return { memoryIds, episodeRows }
}

/** execute the plan inside the caller's lifecycle transaction. */
export function purgeSourceEvidence(
  db: Database.Database,
  authority: SourceAuthority,
  episodeIds: string[],
  removeText: boolean,
  now: number
): number {
  const { memoryIds, episodeRows } = sourcePurgePlan(db, authority, episodeIds)
  const hasTable = (name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  const memoryVectors = hasTable('memory_vectors')
  const episodeVectors = hasTable('episode_vectors')
  const sessions = new Set<string>()
  for (const id of memoryIds) {
    const row = db.prepare('SELECT session_id, vec_rowid FROM memories WHERE id = ?').get(id) as
      { session_id: string; vec_rowid: number | null }
    sessions.add(row.session_id)
    if (row.vec_rowid !== null && memoryVectors) db.prepare('DELETE FROM memory_vectors WHERE rowid = ?').run(row.vec_rowid)
    db.prepare(`INSERT INTO source_events(connection_id, kind, memory_id, created_at) VALUES (?, 'purged', ?, ?)`)
      .run(authority.id, id, now)
    // mutation payloads are not assumed metadata-only on migrated stores.
    db.prepare(`UPDATE memory_events SET payload = '{"redacted":"source-lifecycle"}' WHERE memory_id = ?`).run(id)
    db.prepare(`INSERT INTO memory_events(memory_id, event_type, origin, occurred_at, payload)
      VALUES (?, 'deleted', 'source-lifecycle', ?, '{}')`).run(id, now)
    db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }
  for (const session of sessions) {
    db.prepare('UPDATE sessions SET summary = NULL WHERE id = ? AND owner_principal IS ?')
      .run(session, authority.owner_principal)
  }
  if (episodeRows.length > 0 || memoryIds.size > 0) {
    const affectedNamespaces = new Set([authority.namespace])
    // cached prose can contain removed text even when other members remain. Never
    // merely prune the member ids while retaining a precomputed summary.
    const clusters = db.prepare('SELECT id, project_path, member_ids FROM memory_clusters').all() as
      Array<{ id: number; project_path: string; member_ids: string }>
    for (const cluster of clusters) {
      let contains = false
      try {
        const members: unknown = JSON.parse(cluster.member_ids)
        contains = Array.isArray(members) && members.some((id) => memoryIds.has(id))
      } catch { contains = true } // malformed provenance cannot prove the cached prose safe
      if (contains || prefixCovers(cluster.project_path, authority.namespace)) {
        db.prepare('DELETE FROM memory_clusters WHERE id = ?').run(cluster.id)
        affectedNamespaces.add(cluster.project_path)
      }
    }
    const digests = db.prepare('SELECT namespace FROM project_digests').all() as Array<{ namespace: string }>
    for (const digest of digests) {
      if ([...affectedNamespaces].some((namespace) => prefixCovers(digest.namespace, namespace))) {
        db.prepare('DELETE FROM project_digests WHERE namespace = ?').run(digest.namespace)
      }
    }
    const jobs = db.prepare('SELECT id, target_key FROM maintenance_jobs').all() as Array<{ id: number; target_key: string }>
    for (const job of jobs) {
      const target = job.target_key.replace(/^(?:navtree|nav|promote|prune|retention):/, '')
      if (target === '' || target === '*' || target === 'global' || target.startsWith('episodes:')
        || [...affectedNamespaces].some((namespace) => prefixCovers(target, namespace)) || memoryIds.has(target)) {
        db.prepare(`UPDATE maintenance_jobs SET result_json = '{"redacted":"source-lifecycle"}', last_error = NULL WHERE id = ?`).run(job.id)
      }
    }
    const nodes = db.prepare('SELECT path FROM namespace_nodes').all() as Array<{ path: string }>
    for (const node of nodes) {
      if ([...affectedNamespaces].some((namespace) => prefixCovers(node.path, namespace))) {
        db.prepare('UPDATE namespace_nodes SET digest = NULL, digest_source_hash = NULL WHERE path = ?').run(node.path)
      }
    }
  }
  for (const row of episodeRows) {
    if (removeText) {
      if (row.vec_rowid !== null && episodeVectors) db.prepare('DELETE FROM episode_vectors WHERE rowid = ?').run(row.vec_rowid)
      db.prepare('DELETE FROM episodes WHERE id = ?').run(row.id)
    } else {
      db.prepare("UPDATE episodes SET source_state = 'superseded' WHERE id = ?").run(row.id)
    }
  }
  return memoryIds.size
}
