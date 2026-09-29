import type Database from 'better-sqlite3'
import type { Migration } from './types.js'
import { tableExists } from './types.js'

// change signal for the scope-local lexical statistics (src/memory/search/scoped-stats.ts).
// those statistics are recomputed from the rows in the scope rather than stored, so they
// cannot drift; this table only marks *when* a namespace changed, since recomputing on
// every query is the expensive half. the triggers fire on memories, so every writer bumps
// them, not just the ones that go through MemoryStore. only the columns that move a
// statistic are watched: an access-count stamp on a read path is not a corpus change.
export const migration018: Migration = {
  version: 18,
  description: 'Add the namespace write epoch used to invalidate scope-local lexical statistics',
  up(db: Database.Database) {
    if (!tableExists(db, 'scope_write_epoch')) {
      db.exec(`CREATE TABLE scope_write_epoch (
        namespace TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL DEFAULT 0
      )`)
    }

    const bump = (ns: string): string =>
      `INSERT INTO scope_write_epoch(namespace, epoch) VALUES (${ns}, 1)
         ON CONFLICT(namespace) DO UPDATE SET epoch = epoch + 1`

    db.exec(`
DROP TRIGGER IF EXISTS scope_write_epoch_insert;
CREATE TRIGGER scope_write_epoch_insert AFTER INSERT ON memories BEGIN
  ${bump('COALESCE(new.namespace, new.project_path)')};
END;

DROP TRIGGER IF EXISTS scope_write_epoch_update;
CREATE TRIGGER scope_write_epoch_update AFTER UPDATE OF namespace, project_path, content, tags, type, archived_at, valid_from, valid_until ON memories BEGIN
  ${bump('COALESCE(new.namespace, new.project_path)')};
  ${bump('COALESCE(old.namespace, old.project_path)')};
END;

DROP TRIGGER IF EXISTS scope_write_epoch_delete;
CREATE TRIGGER scope_write_epoch_delete AFTER DELETE ON memories BEGIN
  ${bump('COALESCE(old.namespace, old.project_path)')};
END;
`)
  },
}
