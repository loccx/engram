import type Database from 'better-sqlite3'
import type { Migration } from './types.js'

// 018 watches the memories table, which is not the whole counted set. a statistic is
// recomputed only when the epoch of the scope moves, so any write that can change which
// rows a scope serves has to move it, wherever the write lands:
//
//   memory_links  a `supersedes` link at or above the read threshold hides a row through
//                 notSupersededClause without touching it; deleting the link or amending
//                 its confidence/judged_at brings the row back. the source side is never
//                 read by that filter, so only the target's namespace moves. a link below
//                 the threshold costs the scope one recompute, which is the cheap side of
//                 getting this wrong.
//   memory_entities  the entity channel counts matching rows of memory_entity_fts per
//                 memory, so an entity written outside a memory insert moves that
//                 channel's df.
//   episodes      the evidence layer is its own corpus: the episode channel's statistics
//                 count the scope's episodes, and no memories write reports an episode.
//
// embeddings and access stamps are deliberately absent: they move no statistic.
export const migration020: Migration = {
  version: 20,
  description: 'Bump the scope write epoch on every write that changes what a scope can serve',
  up(db: Database.Database) {
    // the epoch row is keyed by the coalesced namespace, so a lookup by row id is enough
    const bump = (nsExpr: string): string =>
      `INSERT INTO scope_write_epoch(namespace, epoch) VALUES (${nsExpr}, 1)
         ON CONFLICT(namespace) DO UPDATE SET epoch = epoch + 1`

    const bumpOfMemory = (idExpr: string): string =>
      `INSERT INTO scope_write_epoch(namespace, epoch)
         SELECT COALESCE(m.namespace, m.project_path), 1
         FROM memories m WHERE m.id = ${idExpr}
         ON CONFLICT(namespace) DO UPDATE SET epoch = epoch + 1`

    db.exec(`
DROP TRIGGER IF EXISTS scope_write_epoch_links_insert;
CREATE TRIGGER scope_write_epoch_links_insert AFTER INSERT ON memory_links
WHEN new.link_type = 'supersedes' BEGIN
  ${bumpOfMemory('new.target_id')};
END;

DROP TRIGGER IF EXISTS scope_write_epoch_links_update;
CREATE TRIGGER scope_write_epoch_links_update AFTER UPDATE ON memory_links
WHEN new.link_type = 'supersedes' OR old.link_type = 'supersedes' BEGIN
  ${bumpOfMemory('new.target_id')};
  ${bumpOfMemory('old.target_id')};
END;

DROP TRIGGER IF EXISTS scope_write_epoch_links_delete;
CREATE TRIGGER scope_write_epoch_links_delete AFTER DELETE ON memory_links
WHEN old.link_type = 'supersedes' BEGIN
  ${bumpOfMemory('old.target_id')};
END;

DROP TRIGGER IF EXISTS scope_write_epoch_entities_insert;
CREATE TRIGGER scope_write_epoch_entities_insert AFTER INSERT ON memory_entities BEGIN
  ${bumpOfMemory('new.memory_id')};
END;

DROP TRIGGER IF EXISTS scope_write_epoch_entities_update;
CREATE TRIGGER scope_write_epoch_entities_update AFTER UPDATE OF entity_text, memory_id ON memory_entities BEGIN
  ${bumpOfMemory('new.memory_id')};
  ${bumpOfMemory('old.memory_id')};
END;

DROP TRIGGER IF EXISTS scope_write_epoch_entities_delete;
CREATE TRIGGER scope_write_epoch_entities_delete AFTER DELETE ON memory_entities BEGIN
  ${bumpOfMemory('old.memory_id')};
END;

DROP TRIGGER IF EXISTS scope_write_epoch_episodes_insert;
CREATE TRIGGER scope_write_epoch_episodes_insert AFTER INSERT ON episodes BEGIN
  ${bump('new.namespace')};
END;

DROP TRIGGER IF EXISTS scope_write_epoch_episodes_update;
CREATE TRIGGER scope_write_epoch_episodes_update AFTER UPDATE OF namespace, content ON episodes BEGIN
  ${bump('new.namespace')};
  ${bump('old.namespace')};
END;

DROP TRIGGER IF EXISTS scope_write_epoch_episodes_delete;
CREATE TRIGGER scope_write_epoch_episodes_delete AFTER DELETE ON episodes BEGIN
  ${bump('old.namespace')};
END;
`)
  },
}
