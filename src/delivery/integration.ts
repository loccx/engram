import type Database from 'better-sqlite3'

/**
 * host-facing automatic-memory protocol. a host reads capabilities once, then reads
 * status and writes settings per repository; receipts are the host's report of the
 * last recall/capture it performed. all of it is local and namespace-scoped.
 */
export const INTEGRATION_PROTOCOL_VERSION = 1
export const INTEGRATION_HOST = 'default'
export const INTEGRATION_CAPABILITIES = [
  'settings',
  'bounded-recall',
  'selective-capture',
  'capture-receipts',
] as const
export type IntegrationReceiptKind = 'recall' | 'capture'

export interface IntegrationPreferences {
  recall: boolean
  capture: boolean
  revision: number
}

export interface IntegrationReceipt {
  at: number
  status: string | null
}

export interface IntegrationStatus {
  protocol_version: number
  preferences: IntegrationPreferences
  can_configure: boolean
  last_recall: IntegrationReceipt | null
  last_capture: IntegrationReceipt | null
}

/** off until a host turns it on: automatic memory is opt-in per repository */
export const DEFAULT_INTEGRATION_PREFERENCES: IntegrationPreferences = Object.freeze({
  recall: false,
  capture: false,
  revision: 0,
})

interface PreferenceRow {
  recall: number
  capture: number
  revision: number
}

interface ReceiptRow {
  kind: string
  at: number
  status: string | null
}

export function readIntegrationPreferences(
  db: Database.Database,
  namespace: string,
  host: string = INTEGRATION_HOST
): IntegrationPreferences {
  const row = db
    .prepare('SELECT recall, capture, revision FROM integration_preferences WHERE namespace = ? AND host = ?')
    .get(namespace, host) as PreferenceRow | undefined
  return row
    ? { recall: row.recall === 1, capture: row.capture === 1, revision: row.revision }
    : { ...DEFAULT_INTEGRATION_PREFERENCES }
}

export function readIntegrationReceipts(
  db: Database.Database,
  namespace: string,
  host: string = INTEGRATION_HOST
): { last_recall: IntegrationReceipt | null; last_capture: IntegrationReceipt | null } {
  const rows = db
    .prepare('SELECT kind, at, status FROM integration_receipts WHERE namespace = ? AND host = ?')
    .all(namespace, host) as ReceiptRow[]
  const receipt = (kind: IntegrationReceiptKind): IntegrationReceipt | null => {
    const row = rows.find((candidate) => candidate.kind === kind)
    return row ? { at: row.at, status: row.status } : null
  }
  return { last_recall: receipt('recall'), last_capture: receipt('capture') }
}

export function integrationStatus(
  db: Database.Database,
  namespace: string,
  canConfigure: boolean,
  host: string = INTEGRATION_HOST
): IntegrationStatus {
  return {
    protocol_version: INTEGRATION_PROTOCOL_VERSION,
    preferences: readIntegrationPreferences(db, namespace, host),
    can_configure: canConfigure,
    ...readIntegrationReceipts(db, namespace, host),
  }
}

/**
 * compare-and-swap on the revision: a stale expected_revision writes nothing and
 * returns the current row, which the route reports as a conflict.
 */
export function writeIntegrationPreferences(
  db: Database.Database,
  namespace: string,
  host: string,
  next: { recall: boolean; capture: boolean },
  expectedRevision: number,
  now: number
): { ok: true; preferences: IntegrationPreferences } | { ok: false; preferences: IntegrationPreferences } {
  const current = readIntegrationPreferences(db, namespace, host)
  if (current.revision !== expectedRevision) return { ok: false, preferences: current }
  const revision = current.revision + 1
  db.prepare(
    `INSERT INTO integration_preferences (namespace, host, recall, capture, revision, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(namespace, host) DO UPDATE SET
       recall = excluded.recall,
       capture = excluded.capture,
       revision = excluded.revision,
       updated_at = excluded.updated_at`
  ).run(namespace, host, next.recall ? 1 : 0, next.capture ? 1 : 0, revision, now)
  return { ok: true, preferences: { recall: next.recall, capture: next.capture, revision } }
}

export function recordIntegrationReceipt(
  db: Database.Database,
  namespace: string,
  host: string,
  kind: IntegrationReceiptKind,
  at: number,
  status: string | null
): IntegrationReceipt {
  db.prepare(
    `INSERT INTO integration_receipts (namespace, host, kind, at, status)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(namespace, host, kind) DO UPDATE SET at = excluded.at, status = excluded.status`
  ).run(namespace, host, kind, at, status)
  return { at, status }
}
