import type Database from 'better-sqlite3'

function lifecycleAvailable(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_lifecycle_meta'").get() !== undefined
}

/** 0 on pre-lifecycle stores. Compare the snapshot again AFTER any async derivation. */
export function readSourceGeneration(db: Database.Database): number {
  if (!lifecycleAvailable(db)) return 0
  return (db.prepare('SELECT generation FROM source_lifecycle_meta WHERE singleton = 1').get() as { generation: number }).generation
}

/** internal: caller must hold the materialization/purge transaction. */
export function advanceSourceGeneration(db: Database.Database): void {
  db.prepare('UPDATE source_lifecycle_meta SET generation = generation + 1 WHERE singleton = 1').run()
}

// canonical claims dependent on managed evidence, plus same-owner/scope manual successors.
// foreign provenance never grants authority. This host maintenance guard returns ids only,
// and [] on pre-lifecycle stores; it is not an agent-selectable authorization context.
export function sourceDerivedMemoryIds(db: Database.Database): string[] {
  if (!lifecycleAvailable(db)) return []
  const rows = db.prepare(`WITH RECURSIVE derived(id, namespace, owner_principal) AS (
    SELECT m.id, COALESCE(m.namespace, m.project_path), m.owner_principal
    FROM memories m JOIN memory_episodes me ON me.memory_id = m.id JOIN episodes e ON e.id = me.episode_id
    JOIN source_revisions sr ON sr.id = e.source_revision_id AND sr.episode_id = e.id
    JOIN source_connections sc ON sc.id = sr.connection_id
    WHERE COALESCE(m.namespace, m.project_path) = e.namespace AND m.owner_principal IS e.owner_principal
      AND e.namespace = sc.namespace AND e.owner_principal IS sc.owner_principal AND e.source_instance = sc.id
    UNION
    SELECT m.id, COALESCE(m.namespace, m.project_path), m.owner_principal
    FROM derived d JOIN memory_links ml ON ml.target_id = d.id JOIN memories m ON m.id = ml.source_id
    WHERE ml.link_type = 'supersedes' AND ml.revision > 0
      AND COALESCE(m.namespace, m.project_path) = d.namespace AND m.owner_principal IS d.owner_principal
  ) SELECT DISTINCT id FROM derived ORDER BY id`).all() as Array<{ id: string }>
  return rows.map((row) => row.id)
}
