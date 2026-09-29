// episodes: raw turn- or chunk-granularity evidence beside the curated memories.
// a long session is thousands of turns, so the evidence lives here and `memories`
// keeps its size, its bm25 statistics and its digests. rows are immutable and
// idempotent on (source, external_id), which is what makes a re-sent or partial
// batch safe. a derived memory cites the episode it came from through
// memory_episodes, and the read path is src/memory/episode-context.ts.
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  getEmbedding,
  getEmbeddings,
  MODEL_ID,
  EMBEDDING_DIM,
  type EmbeddingMode,
} from '../embeddings/pipeline.js'
import { admit, isAgentWrite, type AdmissionWarning } from './admission.js'
import { logger } from '../utils/logger.js'

export type EpisodeVisibility = 'personal' | 'project' | 'team' | 'org'
export type EpisodeRetention = 'durable' | 'session' | 'ephemeral'

/** one episode as stored */
export interface Episode {
  id: string
  namespace: string
  session_id: string
  task_id: string | null
  source: string
  source_instance: string | null
  source_version: string | null
  external_id: string
  author: string | null
  role: string | null
  occurred_at: number | null
  ingested_at: number
  content_type: string
  content: string
  uri: string | null
  turn_index: number | null
  parent_external_id: string | null
  chunk_index: number | null
  chunk_of: number | null
  visibility: string
  retention: string
  expires_at: number | null
  provenance_json: string
  embed_state: string
}

/** one item of an ingest batch, the episode half of the R3 §5 envelope */
export interface IngestEpisodeItem {
  external_id: string
  content: string
  session_id?: string
  task_id?: string
  author?: string
  role?: string
  occurred_at?: number
  content_type?: string
  uri?: string
  /** position inside the session, for the chronological assembly */
  turn_index?: number
  parent_external_id?: string
  chunk_index?: number
  chunk_of?: number
  provenance?: Record<string, unknown>
}

export interface IngestEpisodesInput {
  namespace: string
  /** the source system that produced the evidence, e.g. a host agent, an adk runtime, custom */
  source: string
  source_instance?: string
  source_version?: string
  visibility?: EpisodeVisibility
  retention?: EpisodeRetention
  /** retention ttl; stored as an absolute expiry */
  ttl_ms?: number
  items: IngestEpisodeItem[]
  /** 'mcp' for a tool call: only an agent write can be refused by a warn-mode rule */
  origin?: string
  now?: number
  /** false when sqlite-vec is unavailable: the row is written without a vector */
  vectorsAvailable?: boolean
  /**
   * true writes the rows before their vectors exist: the lexical index is live at once,
   * embed_state stays 'stale' and the maintenance pass embeds the backlog. what a host
   * agent streaming a session wants; a caller that needs the vector by return does not.
   */
  deferVectors?: boolean
  /**
   * embed in one forward pass per chunk instead of one call per item: faster on a big
   * batch, but a padded row shifts (min cosine 0.97), so it is off by default and a
   * stored vector is what getEmbedding returns for that text.
   */
  batchEmbeddings?: boolean
}

export type EpisodeIngestItemResult =
  | { external_id: string; status: 'ingested' | 'duplicate'; id: string }
  | { external_id: string; status: 'rejected'; rule: string; reason: string; hint: string }

export interface EpisodeIngestResult {
  namespace: string
  source: string
  ingested: number
  duplicates: number
  rejected: number
  items: EpisodeIngestItemResult[]
  /** admission warnings, on items that were still written */
  warnings: AdmissionWarning[]
  ms: number
}

/** one call's ceiling: a caller streaming a session sends batches, not the session */
export const EPISODE_BATCH_MAX = 2000

/** the vec0 table exists only when sqlite-vec loaded (src/db/init.ts) */
export function episodeVectorsAvailable(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'episode_vectors'"
    )
    .get() as { present: number } | undefined
  return row !== undefined
}

/** document and query both go through one injectable hook, as the store's does */
export type EpisodeEmbedder = (
  text: string,
  mode: EmbeddingMode
) => Promise<Float32Array | null>

/** ingest embeds a batch of documents in one call, in input order */
export type EpisodeBatchEmbedder = (
  texts: string[],
  mode: EmbeddingMode
) => Promise<Array<Float32Array | null>>

let episodeEmbedder: EpisodeEmbedder = (text, mode) => getEmbedding(text, mode)
/** null: ingest batches through getEmbeddings. a stubbed single hook takes over, so a
 * caller that fakes one text at a time is not bypassed by the batch path */
let episodeBatchHook: EpisodeBatchEmbedder | null = null

export function setEpisodeEmbedder(embedder: EpisodeEmbedder | null): void {
  episodeEmbedder = embedder ?? ((text, mode) => getEmbedding(text, mode))
  // one text at a time, in order: a stub that answers a single text must not turn into
  // a fan-out of concurrent model calls because the ingest path asked for a batch
  episodeBatchHook = embedder
    ? async (texts, mode) => {
        const out: Array<Float32Array | null> = []
        for (const text of texts) out.push(await embedder(text, mode))
        return out
      }
    : null
}

/** inject the batch path itself, to count calls or hand back precomputed vectors */
export function setEpisodeBatchEmbedder(embedder: EpisodeBatchEmbedder | null): void {
  episodeBatchHook = embedder
}

export function embedEpisodeText(
  text: string,
  mode: EmbeddingMode
): Promise<Float32Array | null> {
  return episodeEmbedder(text, mode)
}

const INGEST_COLUMNS = [
  'id',
  'namespace',
  'session_id',
  'task_id',
  'source',
  'source_instance',
  'source_version',
  'external_id',
  'author',
  'role',
  'occurred_at',
  'ingested_at',
  'content_type',
  'content',
  'uri',
  'turn_index',
  'parent_external_id',
  'chunk_index',
  'chunk_of',
  'visibility',
  'retention',
  'expires_at',
  'provenance_json',
] as const

/** one statement per batch, one transaction for the batch */
function insertEpisodes(
  db: Database.Database,
  rows: Array<Array<unknown>>,
  embeddings: Array<Float32Array | null>
): void {
  const placeholders = INGEST_COLUMNS.map(() => '?').join(', ')
  const insert = db.prepare(
    `INSERT OR IGNORE INTO episodes (${INGEST_COLUMNS.join(', ')}) VALUES (${placeholders})`
  )
  // prepared on first use: episode_vectors exists only where sqlite-vec loaded
  let recordVector: Database.Statement | null = null
  let insertVector: Database.Statement | null = null
  const tx = db.transaction(() => {
    rows.forEach((row, index) => {
      const info = insert.run(...row)
      if (info.changes === 0) return
      const embedding = embeddings[index]
      if (!embedding) return
      if (!recordVector || !insertVector) {
        recordVector = db.prepare(
          "UPDATE episodes SET vec_rowid = ?, embedding_model = ?, embedding_dim = ?, embed_state = 'fresh' WHERE id = ?"
        )
        insertVector = db.prepare('INSERT INTO episode_vectors(embedding) VALUES (?)')
      }
      const vecRowid = insertVector.run(Buffer.from(embedding.buffer)).lastInsertRowid as number
      recordVector.run(vecRowid, MODEL_ID, EMBEDDING_DIM, row[0] as string)
    })
  })
  tx()
}

/** existing ids for a batch of keys, chunked so the IN list stays small */
function existingIds(
  db: Database.Database,
  source: string,
  externalIds: string[]
): Map<string, string> {
  const found = new Map<string, string>()
  const CHUNK = 400
  for (let i = 0; i < externalIds.length; i += CHUNK) {
    const chunk = externalIds.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `SELECT external_id, id FROM episodes WHERE source = ? AND external_id IN (${placeholders})`
      )
      .all(source, ...chunk) as Array<{ external_id: string; id: string }>
    for (const row of rows) found.set(row.external_id, row.id)
  }
  return found
}

/**
 * write a batch of evidence, without an llm on the path: admission first (a credential is
 * refused here too), then one insert transaction. an episode already stored under the same
 * (source, external_id) is left alone, so a re-sent session or its delta costs nothing.
 */
export async function ingestEpisodes(
  db: Database.Database,
  input: IngestEpisodesInput
): Promise<EpisodeIngestResult> {
  const startedAt = Date.now()
  const now = input.now ?? startedAt
  const namespace = input.namespace
  const agent = isAgentWrite(input.origin)
  const visibility = input.visibility ?? 'personal'
  const retention = input.retention ?? 'durable'
  const expiresAt =
    typeof input.ttl_ms === 'number' && input.ttl_ms > 0 ? now + input.ttl_ms : null

  // one slot per requested item, so the answer lines up with the batch it was sent
  const results: Array<EpisodeIngestItemResult | null> = input.items.map(() => null)
  const warnings: AdmissionWarning[] = []
  const rows: Array<Array<unknown>> = []
  const embeddings: Array<Float32Array | null> = []
  const pending: Array<{ item: IngestEpisodeItem; index: number }> = []

  input.items.forEach((item, index) => {
    const externalId = item.external_id
    if (externalId === undefined || externalId === null || `${externalId}` === '') {
      results[index] = {
        external_id: '',
        status: 'rejected',
        rule: 'envelope',
        reason: 'the item has no external_id, so it cannot be deduplicated',
        hint: 'send the source system\'s own id for the turn or chunk',
      }
      return
    }
    const content = typeof item.content === 'string' ? item.content : ''
    if (content === '') {
      results[index] = {
        external_id: `${externalId}`,
        status: 'rejected',
        rule: 'envelope',
        reason: 'the item has no content',
        hint: 'a chunk with text it can be retrieved by, or skip it',
      }
      return
    }
    const admission = admit({ content, namespace, type: 'note', tags: [] }, { db, now, agent })
    if (!admission.allowed) {
      results[index] = {
        external_id: `${externalId}`,
        status: 'rejected',
        rule: admission.rule,
        reason: admission.reason,
        hint: admission.hint,
      }
      return
    }
    warnings.push(...admission.warnings)
    pending.push({ item, index })
  })

  const known = existingIds(
    db,
    input.source,
    pending.map(({ item }) => `${item.external_id}`)
  )
  const fresh: Array<{ item: IngestEpisodeItem; index: number }> = []
  for (const entry of pending) {
    const existing = known.get(`${entry.item.external_id}`)
    if (existing) {
      results[entry.index] = { external_id: `${entry.item.external_id}`, status: 'duplicate', id: existing }
      continue
    }
    fresh.push(entry)
  }

  // every vector of the batch is computed before the insert transaction opens: a model
  // call inside a write transaction would block every other writer on this database
  const vectors = new Map<number, Float32Array | null>()
  if (input.vectorsAvailable === true && input.deferVectors !== true && fresh.length > 0) {
    if (input.batchEmbeddings === true) {
      try {
        const embedBatch = episodeBatchHook ?? ((texts, mode) => getEmbeddings(texts, mode))
        const embedded = await embedBatch(fresh.map(({ item }) => item.content), 'document')
        fresh.forEach(({ index }, position) => vectors.set(index, embedded[position] ?? null))
      } catch (err) {
        logger.debug({ err }, 'episode embedding failed; the rows are indexed lexically only')
      }
    } else {
      // one call per item, in order: the stored vector is the one getEmbedding returns
      for (const { item, index } of fresh) {
        try {
          vectors.set(index, await episodeEmbedder(item.content, 'document'))
        } catch (err) {
          logger.debug({ err }, 'episode embedding failed; the row is indexed lexically only')
        }
      }
    }
  }

  for (const { item, index } of fresh) {
    const id = randomUUID()
    rows.push([
      id,
      namespace,
      item.session_id ?? `${input.source}:${item.external_id}`,
      item.task_id ?? null,
      input.source,
      input.source_instance ?? null,
      input.source_version ?? null,
      `${item.external_id}`,
      item.author ?? null,
      item.role ?? null,
      item.occurred_at ?? null,
      now,
      item.content_type ?? 'text/plain',
      item.content,
      item.uri ?? null,
      item.turn_index ?? null,
      item.parent_external_id ?? null,
      item.chunk_index ?? null,
      item.chunk_of ?? null,
      visibility,
      retention,
      expiresAt,
      JSON.stringify(item.provenance ?? {}),
    ])
    embeddings.push(vectors.get(index) ?? null)
    results[index] = { external_id: `${item.external_id}`, status: 'ingested', id }
  }

  if (rows.length > 0) insertEpisodes(db, rows, embeddings)

  const items = results.filter((entry): entry is EpisodeIngestItemResult => entry !== null)
  return {
    namespace,
    source: input.source,
    ingested: items.filter((item) => item.status === 'ingested').length,
    duplicates: items.filter((item) => item.status === 'duplicate').length,
    rejected: items.filter((item) => item.status === 'rejected').length,
    items,
    warnings,
    ms: Date.now() - startedAt,
  }
}

export interface EpisodeNamespaceScope {
  /** the whole namespace, or the node itself with `namespace_subtree` */
  namespace?: string
  /** the node and everything below it */
  namespace_subtree?: string
  /** with namespace_subtree: the node's own rows stay (a child-namespace teardown) */
  exclude_namespace?: string
}

/**
 * the namespace predicate for the episodes table. episodes carry only `namespace`, and
 * the escaping tracks src/memory/search/scope.ts: `_` and `%` are LIKE wildcards, so a
 * sibling namespace must not match.
 */
export function episodeNamespaceFilter(
  scope: EpisodeNamespaceScope,
  alias = ''
): {
  sql: string
  params: string[]
} {
  const col = alias === '' ? 'namespace' : `${alias}.namespace`
  if (scope.namespace_subtree) {
    const ns = scope.namespace_subtree
    const esc = ns.replace(/[\\%_]/g, '\\$&')
    const sql = `(${col} = ? OR ${col} LIKE ? ESCAPE '\\' OR ${col} LIKE ? ESCAPE '\\')`
    const params = [ns, `${esc}/%`, `${esc}//%`]
    if (scope.exclude_namespace) {
      return { sql: `(${sql} AND ${col} <> ?)`, params: [...params, scope.exclude_namespace] }
    }
    return { sql, params }
  }
  if (scope.namespace) {
    return { sql: `${col} = ?`, params: [scope.namespace] }
  }
  return { sql: '', params: [] }
}

export function countEpisodes(db: Database.Database, scope: EpisodeNamespaceScope = {}): number {
  const filter = episodeNamespaceFilter(scope)
  const where = filter.sql ? `WHERE ${filter.sql}` : ''
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM episodes ${where}`)
    .get(...filter.params) as { n: number }
  return row.n
}

/**
 * episodes in scope that carry no vector yet — a deferred ingest, or a re-embed that
 * has not run. the read path ranks them lexically, so this is what a caller reports as
 * degraded rather than serving a silently weaker answer.
 */
export function unembeddedEpisodeCount(
  db: Database.Database,
  scope: EpisodeNamespaceScope = {}
): number {
  const filter = episodeNamespaceFilter(scope)
  const predicate = filter.sql ? `(${filter.sql}) AND` : ''
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM episodes WHERE ${predicate} vec_rowid IS NULL`)
    .get(...filter.params) as { n: number }
  return row.n
}

/** drop evidence; the fts rows go with the delete trigger, the vectors by rowid */
export function deleteEpisodes(db: Database.Database, scope: EpisodeNamespaceScope): void {
  const filter = episodeNamespaceFilter(scope)
  if (!filter.sql) throw new Error('deleteEpisodes needs a namespace or a namespace_subtree')
  const ids = (
    db
      .prepare(`SELECT vec_rowid FROM episodes WHERE ${filter.sql} AND vec_rowid IS NOT NULL`)
      .all(...filter.params) as Array<{ vec_rowid: number }>
  ).map((row) => row.vec_rowid)
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM episodes WHERE ${filter.sql}`).run(...filter.params)
    // vec0 has no trigger, so the vectors of the deleted rows are removed here
    for (const vecRowid of ids) {
      db.prepare('DELETE FROM episode_vectors WHERE rowid = ?').run(vecRowid)
    }
  })
  tx()
}

export interface MemoryEpisodeLink {
  memory_id: string
  episode_id: string
  span_start: number | null
  span_end: number | null
}

/** cite the evidence a derived memory came from; idempotent per (memory, episode, span) */
export function linkMemoryEpisode(
  db: Database.Database,
  link: MemoryEpisodeLink,
  now: number = Date.now()
): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_episodes (memory_id, episode_id, span_start, span_end, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(link.memory_id, link.episode_id, link.span_start ?? null, link.span_end ?? null, now)
}

/** the evidence behind one memory, oldest episode first */
export function episodesForMemory(
  db: Database.Database,
  memoryId: string
): Array<MemoryEpisodeLink & { session_id: string; occurred_at: number | null }> {
  return db
    .prepare(
      `SELECT me.memory_id, me.episode_id, me.span_start, me.span_end,
              e.session_id, e.occurred_at
       FROM memory_episodes me
       JOIN episodes e ON e.id = me.episode_id
       WHERE me.memory_id = ?
       ORDER BY e.occurred_at ASC, e.id ASC`
    )
    .all(memoryId) as Array<
    MemoryEpisodeLink & { session_id: string; occurred_at: number | null }
  >
}

/** the stored columns, as better-sqlite3 hands them back */
export interface EpisodeRow {
  id: string
  namespace: string
  session_id: string
  task_id: string | null
  source: string
  source_instance: string | null
  source_version: string | null
  external_id: string
  author: string | null
  role: string | null
  occurred_at: number | null
  ingested_at: number
  content_type: string | null
  content: string
  uri: string | null
  turn_index: number | null
  parent_external_id: string | null
  chunk_index: number | null
  chunk_of: number | null
  visibility: string | null
  retention: string | null
  expires_at: number | null
  provenance_json: string | null
  embed_state: string | null
  vec_rowid?: number | null
}

export function episodeRowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    namespace: row.namespace,
    session_id: row.session_id,
    task_id: row.task_id ?? null,
    source: row.source,
    source_instance: row.source_instance ?? null,
    source_version: row.source_version ?? null,
    external_id: row.external_id,
    author: row.author ?? null,
    role: row.role ?? null,
    occurred_at: row.occurred_at ?? null,
    ingested_at: row.ingested_at,
    content_type: row.content_type ?? 'text/plain',
    content: row.content,
    uri: row.uri ?? null,
    turn_index: row.turn_index ?? null,
    parent_external_id: row.parent_external_id ?? null,
    chunk_index: row.chunk_index ?? null,
    chunk_of: row.chunk_of ?? null,
    visibility: row.visibility ?? 'personal',
    retention: row.retention ?? 'durable',
    expires_at: row.expires_at ?? null,
    provenance_json: row.provenance_json ?? '{}',
    embed_state: row.embed_state ?? 'stale',
  }
}
