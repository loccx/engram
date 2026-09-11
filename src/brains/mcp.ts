import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { BRAINS_DIR, sanitizeBrainName } from './paths.js'
import { readManifestFromFile, type BrainManifest } from './snapshot.js'
import { logAudit } from './audit.js'

export interface BrainSummary {
  name: string
  memory_count: number
  owner_name: string | null
  owner_pubkey: string | null
  embedding_model: string | null
  description: string | null
  has_decrypted_cache: boolean
  exported_at: number | null
}

export function listLocalBrains(brainsDir: string = BRAINS_DIR): BrainSummary[] {
  if (!existsSync(brainsDir)) return []
  const names = readdirSync(brainsDir).filter((n) => {
    try {
      return statSync(join(brainsDir, n)).isDirectory()
    } catch {
      return false
    }
  })
  const out: BrainSummary[] = []
  for (const name of names) {
    const dir = join(brainsDir, name)
    const cachedDb = join(dir, '.cache', 'brain.db')
    const ownedDb = join(dir, 'brain.db')
    const dbForManifest = existsSync(cachedDb) ? cachedDb : existsSync(ownedDb) ? ownedDb : null
    if (!dbForManifest) {
      // Published brains delete brain.db and ship manifest.json beside the
      // encrypted snapshot; fall back to the JSON sidecar so owned+published
      // brains don't report memory_count: 0 and drop their manifest.
      out.push(summaryFromManifestSidecar(name, dir))
      continue
    }
    try {
      const manifest = readManifestFromFile(dbForManifest)
      out.push({
        name,
        memory_count: manifest.memory_count,
        owner_name: manifest.owner_name,
        owner_pubkey: manifest.owner_pubkey,
        embedding_model: manifest.embedding_model,
        description: manifest.description,
        has_decrypted_cache: existsSync(cachedDb),
        exported_at: manifest.exported_at,
      })
    } catch {
      out.push({
        name,
        memory_count: 0,
        owner_name: null,
        owner_pubkey: null,
        embedding_model: null,
        description: null,
        has_decrypted_cache: existsSync(cachedDb),
        exported_at: null,
      })
    }
  }
  return out
}

function summaryFromManifestSidecar(name: string, dir: string): BrainSummary {
  const manifestPath = join(dir, 'manifest.json')
  const empty: BrainSummary = {
    name,
    memory_count: 0,
    owner_name: null,
    owner_pubkey: null,
    embedding_model: null,
    description: null,
    has_decrypted_cache: false,
    exported_at: null,
  }
  if (!existsSync(manifestPath)) return empty
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<BrainManifest>
    return {
      name,
      memory_count: typeof manifest.memory_count === 'number' ? manifest.memory_count : 0,
      owner_name: manifest.owner_name ?? null,
      owner_pubkey: manifest.owner_pubkey ?? null,
      embedding_model: manifest.embedding_model ?? null,
      description: manifest.description ?? null,
      has_decrypted_cache: false,
      exported_at: typeof manifest.exported_at === 'number' ? manifest.exported_at : null,
    }
  } catch {
    return empty
  }
}

export interface BrainSearchResult {
  id: string
  content: string
  type: string
  importance: number
  tags: string
  created_at: number
}

export function searchBrain(
  brainName: string,
  query: string,
  limit: number = 10,
  brainsDir: string = BRAINS_DIR
): BrainSearchResult[] {
  const safe = sanitizeBrainName(brainName)
  const cachedDb = join(brainsDir, safe, '.cache', 'brain.db')
  const ownedDb = join(brainsDir, safe, 'brain.db')
  const dbPath = existsSync(cachedDb) ? cachedDb : existsSync(ownedDb) ? ownedDb : null
  if (!dbPath) {
    throw new Error(`Brain "${safe}" has no decrypted database. Run \`engram brain refresh ${safe}\`.`)
  }
  const db = new Database(dbPath, { readonly: true })
  try {
    const escaped = query.replace(/"/g, '""')
    const rows = db
      .prepare(
        `SELECT m.id, m.content, m.type, m.importance, m.tags, m.created_at
         FROM memories_fts fts
         JOIN memories m ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(`"${escaped}"`, limit) as BrainSearchResult[]
    return rows
  } finally {
    db.close()
  }
}

export function getBrainMemory(
  brainName: string,
  memoryId: string,
  brainsDir: string = BRAINS_DIR
): BrainSearchResult | null {
  const safe = sanitizeBrainName(brainName)
  const cachedDb = join(brainsDir, safe, '.cache', 'brain.db')
  const ownedDb = join(brainsDir, safe, 'brain.db')
  const dbPath = existsSync(cachedDb) ? cachedDb : existsSync(ownedDb) ? ownedDb : null
  if (!dbPath) {
    throw new Error(`Brain "${safe}" has no decrypted database.`)
  }
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db
      .prepare('SELECT id, content, type, importance, tags, created_at FROM memories WHERE id = ?')
      .get(memoryId) as BrainSearchResult | undefined
    return row ?? null
  } finally {
    db.close()
  }
}

export interface MarkShareableResult {
  id: string
  shareable: boolean
  changed: boolean
}

export function markShareable(
  sourceDb: Database.Database,
  memoryId: string,
  shareable: boolean,
  actor: string = 'mcp'
): MarkShareableResult {
  const row = sourceDb
    .prepare(
      'SELECT id, COALESCE(namespace, project_path) AS namespace, shareable FROM memories WHERE id = ?'
    )
    .get(memoryId) as { id: string; namespace: string | null; shareable: number } | undefined
  if (!row) {
    throw new Error(`Memory ${memoryId} not found`)
  }
  const newVal = shareable ? 1 : 0
  if (row.shareable === newVal) {
    return { id: memoryId, shareable, changed: false }
  }
  sourceDb.prepare('UPDATE memories SET shareable = ? WHERE id = ?').run(newVal, memoryId)
  logAudit({
    type: shareable ? 'mark_shareable' : 'unmark_shareable',
    namespace: row.namespace ?? '(none)',
    memory_id: memoryId,
    actor,
  })
  return { id: memoryId, shareable, changed: true }
}
