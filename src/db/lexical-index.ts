// identifier-aware lexical index (migrations 012/015). memories_fts uses
// unicode61, which does not split inside identifiers, so `hybrid search` never
// reached `hybridSearch`. building the normalised text in the triggers costs
// a sqlite step per character per write, so 015 computes it in js (`ident_text`) and
// triggers only copy it; 012's SQL form stays for databases that applied it.

export const MEMORIES_IDENT_FTS = 'memories_ident_fts'
export const MEMORY_ENTITY_FTS = 'memory_entity_fts'

// emits each identifier twice (split words and the `_`/`-`-glued compound), which
// is what lets the query side pass tokens through unchanged. only migration 012
// still calls this, on a schema that has no ident_text column yet.
export function identNormalizeSql(colExpr: string): string {
  return `ifnull((
    WITH RECURSIVE
      s(x) AS (SELECT ifnull(${colExpr}, '')),
      step(i) AS (
        SELECT 1
        UNION ALL
        SELECT i + 1 FROM step, s WHERE i < length(x) + 1
      )
    SELECT lower(trim(trim(group_concat(sp, '')) || ' ' || trim(group_concat(cp, ''))))
    FROM (
      SELECT
        CASE
          WHEN substr(x, i, 1) GLOB '[A-Za-z0-9]' THEN
            CASE
              WHEN i > 1
                   AND substr(x, i, 1) GLOB '[A-Z]'
                   AND (substr(x, i - 1, 1) GLOB '[a-z0-9]'
                        OR (substr(x, i - 1, 1) GLOB '[A-Z]' AND substr(x, i + 1, 1) GLOB '[a-z]'))
                THEN ' ' || substr(x, i, 1)
              ELSE substr(x, i, 1)
            END
          WHEN substr(x, i - 1, 1) GLOB '[A-Za-z0-9]' THEN ' '
          ELSE NULL
        END AS sp,
        CASE
          WHEN substr(x, i, 1) GLOB '[A-Za-z0-9]' THEN substr(x, i, 1)
          WHEN substr(x, i, 1) IN ('_', '-') THEN NULL
          WHEN substr(x, i - 1, 1) GLOB '[A-Za-z0-9]' THEN ' '
          ELSE NULL
        END AS cp
      FROM step, s
    )
  ), '')`
}

/** the write-path normaliser; a test asserts it agrees with identNormalizeSql */
export function normalizeIdentifiers(text: string | null | undefined): string {
  const s = text ?? ''
  const isAlnum = (c: string): boolean => c.length === 1 && /[A-Za-z0-9]/.test(c)
  const split: string[] = []
  const compound: string[] = []
  for (let i = 0; i <= s.length; i++) {
    const c = s[i] ?? ''
    const prev = i > 0 ? s[i - 1] : ''
    const next = s[i + 1] ?? ''
    if (isAlnum(c)) {
      const camelBoundary =
        i > 0 &&
        /[A-Z]/.test(c) &&
        (/[a-z0-9]/.test(prev) || (/[A-Z]/.test(prev) && /[a-z]/.test(next)))
      split.push(camelBoundary ? ` ${c}` : c)
      compound.push(c)
    } else {
      if (isAlnum(prev)) split.push(' ')
      if (c === '_' || c === '-') {
        continue
      }
      if (isAlnum(prev)) compound.push(' ')
    }
  }
  const splitOut = split.join('').trim()
  const compoundOut = compound.join('').trim()
  return `${splitOut} ${compoundOut}`.trim().toLowerCase()
}

// 012's DDL. pure SQL triggers, so any connection that writes a row indexes it,
// with no UDF to register; triggers are dropped and recreated so a re-run
// converges, while the FTS tables use IF NOT EXISTS so rows are never discarded.
export function lexicalIndexDdl(): string {
  const memoriesIdent = identNormalizeSql("new.content || ' ' || new.tags")
  const entityIdent = identNormalizeSql('new.entity_text')
  return `
CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORIES_IDENT_FTS} USING fts5(ident);

DROP TRIGGER IF EXISTS ${MEMORIES_IDENT_FTS}_insert;
CREATE TRIGGER ${MEMORIES_IDENT_FTS}_insert AFTER INSERT ON memories BEGIN
  INSERT INTO ${MEMORIES_IDENT_FTS}(rowid, ident) VALUES (new.rowid, ${memoriesIdent});
END;

DROP TRIGGER IF EXISTS ${MEMORIES_IDENT_FTS}_update;
CREATE TRIGGER ${MEMORIES_IDENT_FTS}_update AFTER UPDATE OF content, tags ON memories BEGIN
  DELETE FROM ${MEMORIES_IDENT_FTS} WHERE rowid = old.rowid;
  INSERT INTO ${MEMORIES_IDENT_FTS}(rowid, ident) VALUES (new.rowid, ${memoriesIdent});
END;

DROP TRIGGER IF EXISTS ${MEMORIES_IDENT_FTS}_delete;
CREATE TRIGGER ${MEMORIES_IDENT_FTS}_delete AFTER DELETE ON memories BEGIN
  DELETE FROM ${MEMORIES_IDENT_FTS} WHERE rowid = old.rowid;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORY_ENTITY_FTS} USING fts5(ident, memory_id UNINDEXED);

DROP TRIGGER IF EXISTS ${MEMORY_ENTITY_FTS}_insert;
CREATE TRIGGER ${MEMORY_ENTITY_FTS}_insert AFTER INSERT ON memory_entities BEGIN
  INSERT INTO ${MEMORY_ENTITY_FTS}(rowid, ident, memory_id)
  VALUES (new.id, ${entityIdent}, new.memory_id);
END;

DROP TRIGGER IF EXISTS ${MEMORY_ENTITY_FTS}_update;
CREATE TRIGGER ${MEMORY_ENTITY_FTS}_update AFTER UPDATE OF entity_text, memory_id ON memory_entities BEGIN
  DELETE FROM ${MEMORY_ENTITY_FTS} WHERE rowid = old.id;
  INSERT INTO ${MEMORY_ENTITY_FTS}(rowid, ident, memory_id)
  VALUES (new.id, ${entityIdent}, new.memory_id);
END;

DROP TRIGGER IF EXISTS ${MEMORY_ENTITY_FTS}_delete;
CREATE TRIGGER ${MEMORY_ENTITY_FTS}_delete AFTER DELETE ON memory_entities BEGIN
  DELETE FROM ${MEMORY_ENTITY_FTS} WHERE rowid = old.id;
END;
`
}

// both "the index is absent" and "the query failed" throw in better-sqlite3, but
// only the second is worth reporting as a degraded branch
export function lexicalIndexTablePresent(
  db: import('better-sqlite3').Database,
  table: string = MEMORIES_IDENT_FTS
): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present: number } | undefined
  return row !== undefined
}

// 015's DDL: same triggers, but they copy the precomputed ident_text.
// ident_text is deliberately not in the UPDATE lists, so filling the derived
// column stays a cheap write; a stale index row is repaired by the backfill.
// ifnull(new.ident_text, '') keeps a row written by a connection that knows
// nothing about ident_text working, just unindexed until the next backfill.
export function lexicalIdentColumnDdl(): string {
  return `
CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORIES_IDENT_FTS} USING fts5(ident);

DROP TRIGGER IF EXISTS ${MEMORIES_IDENT_FTS}_insert;
CREATE TRIGGER ${MEMORIES_IDENT_FTS}_insert AFTER INSERT ON memories BEGIN
  INSERT INTO ${MEMORIES_IDENT_FTS}(rowid, ident) VALUES (new.rowid, ifnull(new.ident_text, ''));
END;

DROP TRIGGER IF EXISTS ${MEMORIES_IDENT_FTS}_update;
CREATE TRIGGER ${MEMORIES_IDENT_FTS}_update AFTER UPDATE OF content, tags ON memories BEGIN
  DELETE FROM ${MEMORIES_IDENT_FTS} WHERE rowid = old.rowid;
  INSERT INTO ${MEMORIES_IDENT_FTS}(rowid, ident) VALUES (new.rowid, ifnull(new.ident_text, ''));
END;

DROP TRIGGER IF EXISTS ${MEMORIES_IDENT_FTS}_delete;
CREATE TRIGGER ${MEMORIES_IDENT_FTS}_delete AFTER DELETE ON memories BEGIN
  DELETE FROM ${MEMORIES_IDENT_FTS} WHERE rowid = old.rowid;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORY_ENTITY_FTS} USING fts5(ident, memory_id UNINDEXED);

DROP TRIGGER IF EXISTS ${MEMORY_ENTITY_FTS}_insert;
CREATE TRIGGER ${MEMORY_ENTITY_FTS}_insert AFTER INSERT ON memory_entities BEGIN
  INSERT INTO ${MEMORY_ENTITY_FTS}(rowid, ident, memory_id)
  VALUES (new.id, ifnull(new.ident_text, ''), new.memory_id);
END;

DROP TRIGGER IF EXISTS ${MEMORY_ENTITY_FTS}_update;
CREATE TRIGGER ${MEMORY_ENTITY_FTS}_update AFTER UPDATE OF entity_text, memory_id ON memory_entities BEGIN
  DELETE FROM ${MEMORY_ENTITY_FTS} WHERE rowid = old.id;
  INSERT INTO ${MEMORY_ENTITY_FTS}(rowid, ident, memory_id)
  VALUES (new.id, ifnull(new.ident_text, ''), new.memory_id);
END;

DROP TRIGGER IF EXISTS ${MEMORY_ENTITY_FTS}_delete;
CREATE TRIGGER ${MEMORY_ENTITY_FTS}_delete AFTER DELETE ON memory_entities BEGIN
  DELETE FROM ${MEMORY_ENTITY_FTS} WHERE rowid = old.id;
END;
`
}

export function lexicalIndexReady(db: import('better-sqlite3').Database): boolean {
  return (
    lexicalIndexTablePresent(db, MEMORIES_IDENT_FTS) &&
    lexicalIndexTablePresent(db, MEMORY_ENTITY_FTS)
  )
}
