import Database from 'better-sqlite3'
import { homedir } from 'os'
import { DatabaseManager } from '../db/init.js'
import { EMBEDDING_DIM, MODEL_ID } from '../embeddings/pipeline.js'
import { ENGRAM_VERSION } from '../version.js'
import { notSupersededClause } from '../contradictions/supersession.js'
import * as sqliteVec from 'sqlite-vec'

/**
 * turn a namespace into its portable, owner-relative form before export: a home path
 * becomes `~/cb`, a non-home path keeps its leaf under `ext/`, and the `//` suffix
 * survives verbatim so layer matching still works on the reader
 */
const HOME_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/\/Users\/[^/\s"'`]+/g, '~'], // macOS
  [/\/home\/[^/\s"'`]+/g, '~'], // Linux
  [/[A-Za-z]:\\?Users\\?[^\\\s"'`]+/g, '~'], // Windows
]

/**
 * notes, preconditions and entities mention the owner's paths too, so the prefix
 * is redacted everywhere it appears, not only in metadata columns
 */
export function scrubHomePaths(value: string, home: string = homedir()): string {
  let out = value
  // custom homes (containers, service accounts and relocated profiles) need the same
  // protection as /Users and /home. Match the directory, never a sibling prefix.
  // regex case folding is conservative; it does not normalize unicode or cover every
  // locale-specific expansion of a path component.
  const root = home.replace(/[/\\]+$/, '')
  if (root.length > 1 && !/^[A-Za-z]:$/.test(root)) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const ownerPath = new RegExp(
      '(?<![\\w/\\\\.-])' + escaped + '(?=$|[/\\\\\\s"\'`\\]\\)}]|[.,;:!?](?=$|[\\s"\'`\\]\\)}]))',
      'gi'
    )
    out = out.replace(ownerPath, '~')
  }
  for (const [re, to] of HOME_PATH_PATTERNS) out = out.replace(re, to)
  return out
}

/** every string field, before the row enters the snapshot */
function scrubRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' ? scrubHomePaths(v) : v
  }
  return out
}

/**
 * short stable digest, so two foreign roots that share a leaf name stay distinct
 * (/work/a/payments vs /home/b/payments) and the same root always maps to the same
 * value across snapshots
 */
function shortHash(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function redactNamespace(ns: string, home: string = homedir()): string {
  if (!ns) return ns
  const scopeIdx = ns.indexOf('//')
  const base = scopeIdx === -1 ? ns : ns.slice(0, scopeIdx)
  const scope = scopeIdx === -1 ? '' : ns.slice(scopeIdx)
  let redacted: string
  if (base === home || base.startsWith(home.endsWith('/') ? home : home + '/')) {
    const rel = base.slice(home.length).replace(/^\/+/, '')
    redacted = rel ? `~/${rel}` : '~'
  } else if (base === '~' || base.startsWith('~/')) {
    redacted = base
  } else if (base.startsWith('/')) {
    const leaf = base.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? 'root'
    redacted = `ext/${leaf}-${shortHash(base)}`
  } else {
    redacted = base
  }
  return redacted + scope
}

export interface ExportOptions {
  namespace: string
  outputPath: string
  description?: string
  ownerName?: string
  ownerPubkey?: string
  /**
   * also export synthetic `<ns>//<scope>` children and deeper descendants; false
   * (the default) ships exactly what an exact match always shipped
   */
  includeScopes?: boolean
  /** extra exact namespaces to export */
  layers?: string[]
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
  /** the namespace the export was asked for */
  source_namespace: string
  /** namespaces present in the snapshot (json array), or null */
  included_layers: string | null
}

/**
 * snapshot format version: an older engram refuses a newer brain while a newer one
 * keeps reading older brains, so bumps are additive. bump both write sites.
 */
const BRAIN_SCHEMA_VERSION = 7

function sourceTableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  return row !== undefined
}

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

  // a db from before migrations 006/007 has no shareable or namespace column, so it
  // has no shareable memories by definition: export an empty brain instead of
  // crashing. scoping uses COALESCE(namespace, project_path), as every read does.
  const shareableCol = sourceColumnExists(sourceDb, 'memories', 'shareable')
  const namespaceCol = sourceColumnExists(sourceDb, 'memories', 'namespace')
  const nsExpr = namespaceCol ? 'COALESCE(namespace, project_path)' : 'project_path'
  const shareableExpr = shareableCol ? 'shareable = 1' : '0 = 1'

  // the requested namespace always, plus any explicit layers; with includeScopes,
  // synthetic `<ns>//<scope>` children and deeper descendants match too (the same
  // predicate the search side uses). LIKE wildcards are escaped so a namespace
  // containing % or _ cannot match a sibling prefix.
  const escapeLike = (ns: string) => ns.replace(/[\\%_]/g, '\\$&')
  const layerPredicates: string[] = []
  const layerParams: unknown[] = []
  for (const layer of [opts.namespace, ...(opts.layers ?? [])]) {
    layerPredicates.push(`${nsExpr} = ?`)
    layerParams.push(layer)
    if (opts.includeScopes) {
      layerPredicates.push(`${nsExpr} LIKE ? ESCAPE '\\'`)
      layerParams.push(`${escapeLike(layer)}//%`)
      layerPredicates.push(`${nsExpr} LIKE ? ESCAPE '\\'`)
      layerParams.push(`${escapeLike(layer)}/%`)
    }
  }

  const tx = target.transaction(() => {
    // a correction usually lives in a memory that is not shareable itself, so
    // without this predicate the retraction would not travel and a follower
    // would keep reading the stale fact as current. Pre-migration sources have
    // no link table at all, so the clause is conditional.
    const supersessionExpr = sourceTableExists(sourceDb, 'memory_links')
      ? ` AND ${notSupersededClause('memories.id')}`
      : ''
    const shareableIds = sourceDb
      .prepare(
        `SELECT id FROM memories WHERE (${layerPredicates.join(' OR ')}) AND ${shareableExpr}${supersessionExpr}`
      )
      .all(...layerParams) as Array<{ id: string }>

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
        source_namespace: redactNamespace(opts.namespace),
        included_layers: null,
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
      // count and timing travel; project_path, tool_name and summary are the owner's
      // working context and say nothing about the shared knowledge
      const sessions = sourceDb
        .prepare(`SELECT id, started_at, ended_at FROM sessions WHERE id IN (${sessPlaceholders})`)
        .all(...sessionIds.map((s) => s.session_id)) as Array<Record<string, unknown>>
      if (sessions.length > 0) {
        // project_path is NOT NULL in the snapshot schema, so it is written explicitly
        // and carries the redacted namespace, not the owner's path
        const insertSess = target.prepare(
          `INSERT OR IGNORE INTO sessions (id, project_path, started_at, ended_at) VALUES (?, ?, ?, ?)`
        )
        const sessionNs = redactNamespace(opts.namespace)
        for (const s of sessions) {
          insertSess.run(
            String(s.id),
            sessionNs,
            Number(s.started_at ?? Date.now()),
            s.ended_at == null ? null : Number(s.ended_at)
          )
        }
      }
      // a shareable memory whose session row is gone (pruned, imported, older schema)
      // must not abort the export; session_id is NOT NULL, so write a minimal one
      const foundSessions = new Set(sessions.map((s) => String(s.id)))
      const missingSessions = sessionIds
        .map((s) => s.session_id)
        .filter((id) => !foundSessions.has(id))
      if (missingSessions.length > 0) {
        const insertMissing = target.prepare(
          `INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)`
        )
        const placeholderNs = redactNamespace(opts.namespace)
        for (const id of missingSessions) insertMissing.run(id, placeholderNs, Date.now())
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
        const row = scrubRow({ ...m })
        const raw =
          typeof row.namespace === 'string' && row.namespace
            ? row.namespace
            : typeof row.project_path === 'string'
              ? row.project_path
              : ''
        const redacted = raw ? redactNamespace(raw) : ''
        if (memCols.includes('namespace') && redacted) row.namespace = redacted
        // the redacted form again: no owner path leaks, and the reader's
        // the reader's COALESCE(namespace, project_path) still resolves the row
        if (memCols.includes('project_path') && redacted) row.project_path = redacted
        insertMem.run(...memCols.map((c) => row[c]))
      }
    }

    // callers open the source as a plain better-sqlite3 handle with nothing loaded
    // (publish.ts, cli/brain.ts), so load sqlite-vec here or no embedding travels and
    // the probe throws "no such module: vec0"; without the extension it degrades to fts
    try {
      sqliteVec.load(sourceDb)
    } catch {
      /* extension unavailable: vectors stay behind, export still succeeds */
    }
    let sourceVectorsAvailable = vectorsAvailable
    if (sourceVectorsAvailable) {
      try {
        sourceDb.prepare('SELECT rowid FROM memory_vectors LIMIT 1').get()
      } catch {
        sourceVectorsAvailable = false
      }
    }
    if (sourceVectorsAvailable) {
      const vecRowids = memories
        .map((m) => m.vec_rowid as number | null)
        .filter((v): v is number => v !== null && v !== undefined)
      if (vecRowids.length > 0) {
        const vecPlaceholders = vecRowids.map(() => '?').join(',')
        const vecs = sourceDb
          .prepare(`SELECT rowid, embedding FROM memory_vectors WHERE rowid IN (${vecPlaceholders})`)
          .all(...vecRowids) as Array<{ rowid: number; embedding: Buffer }>
        // vec0's internal pk wants an integer literal inline (a bound parameter is
        // rejected). the values come from source rowids and Number.isSafeInteger
        // guards the interpolation.
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
          const row = scrubRow(e)
          insertEnt.run(...entCols.map((c) => row[c]))
        }
      }
    }

    const includedLayers = (
      sourceDb
        .prepare(`SELECT DISTINCT ${nsExpr} AS ns FROM memories WHERE id IN (${placeholders})`)
        .all(...idList) as Array<{ ns: string }>
    )
      .map((r) => r.ns)
      .filter((ns): ns is string => typeof ns === 'string' && ns.length > 0)
      .map((ns) => redactNamespace(ns))
      .sort()

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
      // the manifest is committed in plaintext, so provenance is recorded redacted only
      source_namespace: redactNamespace(opts.namespace),
      included_layers: JSON.stringify(includedLayers),
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
    source_namespace: m.source_namespace || '',
    included_layers: m.included_layers || null,
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
  // refuse a brain from a newer engram: the format is additive, so an older reader
  // would misread a newer snapshot
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
