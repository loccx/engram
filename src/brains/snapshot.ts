import Database from 'better-sqlite3'
import { DatabaseManager } from '../db/init.js'
import { EMBEDDING_DIM, MODEL_ID } from '../embeddings/pipeline.js'
import { ENGRAM_VERSION } from '../version.js'

export interface ExportOptions {
  namespace: string
  outputPath: string
  description?: string
  ownerName?: string
  ownerPubkey?: string
}

export interface ExportResult {
  memoryCount: number
  manifest: BrainManifest
}

export interface BrainManifest {
  schema_version: number
  engram_version: string
  embedding_model: string
  embedding_dim: number
  owner_name: string | null
  owner_pubkey: string | null
  description: string | null
  exported_at: number
  memory_count: number
}

/**
 * Version of the brain snapshot format. Additive bumps only: older engram
 * refuses newer brains (see validateForImport) while newer engram keeps
 * accepting older brains. Bump BOTH write sites when the format changes.
 */
const BRAIN_SCHEMA_VERSION = 6

function sourceColumnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}

export function exportBrain(sourceDb: Database.Database, opts: ExportOptions): ExportResult {
  const manager = new DatabaseManager(opts.outputPath)
  const target = manager.db
  const vectorsAvailable = manager.vectorsAvailable

  target.exec(`
    CREATE TABLE IF NOT EXISTS brain_manifest (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  // Pre-migration DB safety: a database written by engram before migrations
  // 006/007 has neither a `shareable` nor a `namespace` column. Such a DB has
  // no shareable-marked memories by definition, so export a safe empty brain
  // instead of crashing. Namespace scoping uses COALESCE(namespace,
  // project_path) matching every read path.
  const shareableCol = sourceColumnExists(sourceDb, 'memories', 'shareable')
  const namespaceCol = sourceColumnExists(sourceDb, 'memories', 'namespace')
  const nsExpr = namespaceCol ? 'COALESCE(namespace, project_path)' : 'project_path'
  const shareableExpr = shareableCol ? 'shareable = 1' : '0 = 1'

  const tx = target.transaction(() => {
    const shareableIds = sourceDb
      .prepare(`SELECT id FROM memories WHERE ${nsExpr} = ? AND ${shareableExpr}`)
      .all(opts.namespace) as Array<{ id: string }>

    if (shareableIds.length === 0) {
      writeManifest(target, {
        schema_version: BRAIN_SCHEMA_VERSION,
        engram_version: ENGRAM_VERSION,
        embedding_model: MODEL_ID,
        embedding_dim: EMBEDDING_DIM,
        owner_name: opts.ownerName ?? null,
        owner_pubkey: opts.ownerPubkey ?? null,
        description: opts.description ?? null,
        exported_at: Date.now(),
        memory_count: 0,
      })
      return { count: 0 }
    }

    const idList = shareableIds.map((r) => r.id)
    const placeholders = idList.map(() => '?').join(',')

    const sessionIds = sourceDb
      .prepare(
        `SELECT DISTINCT session_id FROM memories WHERE id IN (${placeholders})`
      )
      .all(...idList) as Array<{ session_id: string }>

    if (sessionIds.length > 0) {
      const sessPlaceholders = sessionIds.map(() => '?').join(',')
      const sessions = sourceDb
        .prepare(`SELECT * FROM sessions WHERE id IN (${sessPlaceholders})`)
        .all(...sessionIds.map((s) => s.session_id)) as Array<Record<string, unknown>>
      const sessionCols = sessions.length > 0 ? Object.keys(sessions[0]) : []
      if (sessions.length > 0) {
        const colList = sessionCols.join(',')
        const valPlaceholders = sessionCols.map(() => '?').join(',')
        const insertSess = target.prepare(
          `INSERT OR IGNORE INTO sessions (${colList}) VALUES (${valPlaceholders})`
        )
        for (const s of sessions) {
          insertSess.run(...sessionCols.map((c) => s[c]))
        }
      }
    }

    const memories = sourceDb
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...idList) as Array<Record<string, unknown>>
    if (memories.length > 0) {
      const memCols = Object.keys(memories[0])
      const colList = memCols.join(',')
      const valPlaceholders = memCols.map(() => '?').join(',')
      const insertMem = target.prepare(
        `INSERT INTO memories (${colList}) VALUES (${valPlaceholders})`
      )
      for (const m of memories) {
        insertMem.run(...memCols.map((c) => m[c]))
      }
    }

    if (vectorsAvailable) {
      const vecRowids = memories
        .map((m) => m.vec_rowid as number | null)
        .filter((v): v is number => v !== null && v !== undefined)
      if (vecRowids.length > 0) {
        const vecPlaceholders = vecRowids.map(() => '?').join(',')
        const vecs = sourceDb
          .prepare(`SELECT rowid, embedding FROM memory_vectors WHERE rowid IN (${vecPlaceholders})`)
          .all(...vecRowids) as Array<{ rowid: number; embedding: Buffer }>
        // sqlite-vec's internal PK only accepts an explicit rowid inlined as
        // an integer literal (binding it as a parameter is rejected). Values
        // originate from sourceDb rowids; Number.isSafeInteger guards the
        // literal before interpolation.
        for (const v of vecs) {
          const safeRowid = Number(v.rowid)
          if (!Number.isSafeInteger(safeRowid) || safeRowid <= 0) continue
          target
            .prepare(`INSERT INTO memory_vectors(rowid, embedding) VALUES (${safeRowid}, ?)`)
            .run(v.embedding)
        }
      }
    }

    const links = sourceDb
      .prepare(
        `SELECT * FROM memory_links WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})`
      )
      .all(...idList, ...idList) as Array<Record<string, unknown>>
    if (links.length > 0) {
      const linkCols = Object.keys(links[0])
      const colList = linkCols.join(',')
      const valPlaceholders = linkCols.map(() => '?').join(',')
      const insertLink = target.prepare(
        `INSERT OR IGNORE INTO memory_links (${colList}) VALUES (${valPlaceholders})`
      )
      for (const l of links) {
        insertLink.run(...linkCols.map((c) => l[c]))
      }
    }

    const entitiesExist = sourceDb
      .prepare("SELECT 1 FROM sqlite_master WHERE name='memory_entities'")
      .get()
    if (entitiesExist) {
      const ents = sourceDb
        .prepare(`SELECT * FROM memory_entities WHERE memory_id IN (${placeholders})`)
        .all(...idList) as Array<Record<string, unknown>>
      if (ents.length > 0) {
        const entCols = Object.keys(ents[0]).filter((c) => c !== 'id')
        const colList = entCols.join(',')
        const valPlaceholders = entCols.map(() => '?').join(',')
        const insertEnt = target.prepare(
          `INSERT INTO memory_entities (${colList}) VALUES (${valPlaceholders})`
        )
        for (const e of ents) {
          insertEnt.run(...entCols.map((c) => e[c]))
        }
      }
    }

    writeManifest(target, {
      schema_version: BRAIN_SCHEMA_VERSION,
      engram_version: ENGRAM_VERSION,
      embedding_model: MODEL_ID,
      embedding_dim: EMBEDDING_DIM,
      owner_name: opts.ownerName ?? null,
      owner_pubkey: opts.ownerPubkey ?? null,
      description: opts.description ?? null,
      exported_at: Date.now(),
      memory_count: idList.length,
    })

    return { count: idList.length }
  })

  const result = tx.immediate()

  const manifest = readManifest(target)
  target.close()
  return { memoryCount: result.count, manifest }
}

function writeManifest(db: Database.Database, manifest: BrainManifest): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO brain_manifest(key, value) VALUES (?, ?)')
  for (const [k, v] of Object.entries(manifest)) {
    stmt.run(k, v === null ? '' : String(v))
  }
}

export function readManifest(db: Database.Database): BrainManifest {
  const rows = db.prepare('SELECT key, value FROM brain_manifest').all() as Array<{ key: string; value: string }>
  const m: Record<string, string> = {}
  for (const r of rows) m[r.key] = r.value
  return {
    schema_version: parseInt(m.schema_version ?? '0', 10),
    engram_version: m.engram_version ?? '',
    embedding_model: m.embedding_model ?? '',
    embedding_dim: parseInt(m.embedding_dim ?? '0', 10),
    owner_name: m.owner_name || null,
    owner_pubkey: m.owner_pubkey || null,
    description: m.description || null,
    exported_at: parseInt(m.exported_at ?? '0', 10),
    memory_count: parseInt(m.memory_count ?? '0', 10),
  }
}

export function readManifestFromFile(path: string): BrainManifest {
  const db = new Database(path, { readonly: true })
  try {
    return readManifest(db)
  } finally {
    db.close()
  }
}

export interface ImportValidationError {
  kind: 'schema_version' | 'embedding_model' | 'embedding_dim' | 'corrupt'
  message: string
}

export function validateForImport(manifest: BrainManifest): ImportValidationError | null {
  if (manifest.schema_version === 0) {
    return { kind: 'corrupt', message: 'brain file has no manifest or is corrupt' }
  }
  // Refuse brains from a FUTURE engram: the format is additive, so an older
  // reader must not silently misread a newer snapshot.
  if (manifest.schema_version > BRAIN_SCHEMA_VERSION) {
    return {
      kind: 'schema_version',
      message: `brain was exported with schema ${manifest.schema_version} by a newer engram (${manifest.engram_version || 'unknown'}); local engram supports up to schema ${BRAIN_SCHEMA_VERSION}. Update engram first.`,
    }
  }
  if (manifest.embedding_model !== MODEL_ID) {
    return {
      kind: 'embedding_model',
      message: `brain was published with embedding model "${manifest.embedding_model}", local engram uses "${MODEL_ID}". Embeddings would be useless.`,
    }
  }
  if (manifest.embedding_dim !== EMBEDDING_DIM) {
    return {
      kind: 'embedding_dim',
      message: `brain has embedding dim ${manifest.embedding_dim}, local engram uses ${EMBEDDING_DIM}.`,
    }
  }
  return null
}
