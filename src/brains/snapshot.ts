import Database from 'better-sqlite3'
import { homedir } from 'os'
import { DatabaseManager } from '../db/init.js'
import { EMBEDDING_DIM, MODEL_ID } from '../embeddings/pipeline.js'
import { ENGRAM_VERSION } from '../version.js'
import { notSupersededClause } from '../contradictions/supersession.js'

/**
 * Rewrite a namespace into its portable, owner-relative form before export.
 *
 * A brain is handed to other people, so the owner's filesystem layout is not
 * part of the payload:
 *   /Users/alice/cb            -> ~/cb
 *   /Users/alice/cb//payments  -> ~/cb//payments   (synthetic scope preserved)
 *   /opt/data/proj             -> ext/proj         (non-home path: leaf only)
 *   autonomous-crypto-desk     -> autonomous-crypto-desk  (alias, nothing to leak)
 *
 * The `//scope` suffix survives verbatim so layer/subtree matching keeps working
 * on the follower side.
 */
const HOME_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/\/Users\/[^/\s"'`]+/g, '~'], // macOS
  [/\/home\/[^/\s"'`]+/g, '~'], // Linux
  [/[A-Za-z]:\\?Users\\?[^\\\s"'`]+/g, '~'], // Windows
]

/**
 * Free text can mention the owner's paths too: notes, procedure preconditions
 * and extracted entities are full of them. The privacy decision is to redact
 * the owner prefix everywhere it appears, not only in metadata columns.
 */
export function scrubHomePaths(value: string): string {
  let out = value
  for (const [re, to] of HOME_PATH_PATTERNS) out = out.replace(re, to)
  return out
}

/** Scrub every string field of a row before it enters the snapshot. */
function scrubRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' ? scrubHomePaths(v) : v
  }
  return out
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
    redacted = `ext/${leaf}`
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
   * Include descendant layers of `namespace`: synthetic `<ns>//<scope>`
   * children and deeper path descendants. Default false preserves the
   * historical exact-match behavior, so an existing publish never silently
   * ships more memory than it did before.
   */
  includeScopes?: boolean
  /** Additional exact namespaces to export alongside `namespace`. */
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
  /** The namespace this brain was exported from (as requested). */
  source_namespace: string
  /** Namespaces actually present in the snapshot (JSON array), or null. */
  included_layers: string | null
}

/**
 * Version of the brain snapshot format. Additive bumps only: older engram
 * refuses newer brains (see validateForImport) while newer engram keeps
 * accepting older brains. Bump BOTH write sites when the format changes.
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

  // Pre-migration DB safety: a database written by engram before migrations
  // 006/007 has neither a `shareable` nor a `namespace` column. Such a DB has
  // no shareable-marked memories by definition, so export a safe empty brain
  // instead of crashing. Namespace scoping uses COALESCE(namespace,
  // project_path) matching every read path.
  const shareableCol = sourceColumnExists(sourceDb, 'memories', 'shareable')
  const namespaceCol = sourceColumnExists(sourceDb, 'memories', 'namespace')
  const nsExpr = namespaceCol ? 'COALESCE(namespace, project_path)' : 'project_path'
  const shareableExpr = shareableCol ? 'shareable = 1' : '0 = 1'

  // Layer selection: the requested namespace always, plus any explicit layers.
  // With includeScopes, synthetic `<ns>//<scope>` children and deeper path
  // descendants match too (mirrors the search-side subtree predicate in
  // src/memory/search/hybrid.ts). LIKE wildcards in the namespace are escaped
  // so a namespace containing % or _ cannot match a sibling prefix.
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
    // A correction usually lives in a memory that is not itself shareable, so
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
      // Only structural timing travels. project_path/tool_name/summary are the
      // owner's working context (paths, tooling, free-text narratives) and have
      // no bearing on the shared knowledge.
      const sessions = sourceDb
        .prepare(`SELECT id, started_at, ended_at FROM sessions WHERE id IN (${sessPlaceholders})`)
        .all(...sessionIds.map((s) => s.session_id)) as Array<Record<string, unknown>>
      if (sessions.length > 0) {
        // Column list is explicit: `project_path` is NOT NULL in the snapshot
        // schema, so it must be written, and it carries the redacted namespace
        // rather than the owner's real path.
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
      // A shareable memory whose session row is gone (pruned, imported, or
      // written by an older schema) must not abort the whole export: the
      // memories.session_id FK is NOT NULL, so materialize a minimal row.
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
        // project_path is NOT NULL in the snapshot schema; it carries the same
        // redacted form so no absolute owner path is exposed while the
        // follower's COALESCE(namespace, project_path) read path stays valid.
        if (memCols.includes('project_path') && redacted) row.project_path = redacted
        insertMem.run(...memCols.map((c) => row[c]))
      }
    }

    // The source connection is opened by callers as a plain better-sqlite3
    // handle (publish.ts, cli/brain.ts) and may not have sqlite-vec loaded
    // even though the target does. Probe it first so export degrades to
    // FTS-only instead of throwing "no such module: vec0".
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
      // The manifest is committed in PLAINTEXT to the git remote, so provenance
      // is recorded in redacted form only.
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
