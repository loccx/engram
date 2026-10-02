import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  auditCrossOwnerRead,
  currentCaller,
  currentTool,
  holdsVerb,
  rowVisible,
  visibilityClause,
} from '../access.js'
import { rowToMemory, type MemoryRow } from '../row.js'
import { namespaceFilter, temporalFilter } from '../search/scope.js'
import type {
  AssertionEvidenceRef,
  AssertionQueryResult,
  AttachAssertionInput,
  MemoryAssertion,
  QueryAssertionsInput,
  RegisteredAssertionSchema,
  RegisterAssertionSchemaInput,
  ReplaceAssertionRepresentationInput,
} from './types.js'
import {
  ASSERTION_EVIDENCE_MAX,
  ASSERTION_QUERY_MAX,
  canonicalJson,
  exactText,
  inputKeys,
  schemaId,
  timestamp,
  validateSchema,
  validateValue,
} from './validation.js'

interface SchemaRow {
  schema_id: string
  predicate: string
  value_schema_json: string
  registered_at: number
}

interface AssertionRow {
  memory_id: string
  schema_id: string
  subject: string
  predicate: string
  value_json: string
  observed_at: number
  content_sha256: string
  attached_at: number
  represented_at: number
  representation_version: number
}

const ATTACH_FIELDS = ['memory_id', 'schema_id', 'subject', 'predicate', 'value']

/**
 * this is a host library boundary, not a tool argument. Even a tool served as the local
 * owner cannot register/attach by sending an authority flag. Do not expose these writes
 * through MCP; schema validity proves shape, not agreement with the canonical prose.
 */
function trustedHostWrite(): void {
  if (!currentCaller().localOwner || currentTool() !== '') {
    throw new Error('assertion writes require the trusted local-owner host library, outside tool requests')
  }
}

function contentHash(row: MemoryRow): string {
  return createHash('sha256').update(row.content).digest('hex')
}

function schemaRow(db: Database.Database, id: string): SchemaRow {
  const row = db.prepare('SELECT * FROM memory_assertion_schemas WHERE schema_id = ?').get(id) as SchemaRow | undefined
  if (!row) throw new Error('assertion schema is not registered')
  return row
}

/** only immutable, versioned registrations by trusted local host code. No DB backfill. */
export function registerAssertionSchema(
  db: Database.Database,
  input: RegisterAssertionSchemaInput
): RegisteredAssertionSchema {
  trustedHostWrite()
  inputKeys(input, ['schema_id', 'predicate', 'value_schema'])
  schemaId(input.schema_id)
  exactText(input.predicate, 'predicate')
  const validated = validateSchema(input.value_schema)
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM memory_assertion_schemas WHERE schema_id = ?').get(input.schema_id) as SchemaRow | undefined
    if (existing && (existing.predicate !== input.predicate || existing.value_schema_json !== validated.json)) {
      throw new Error('assertion schema id is immutable; register a new version')
    }
    const registeredAt = existing?.registered_at ?? Date.now()
    if (!existing) {
      db.prepare(
        'INSERT INTO memory_assertion_schemas (schema_id, predicate, value_schema_json, registered_at) VALUES (?, ?, ?, ?)'
      ).run(input.schema_id, input.predicate, validated.json, registeredAt)
    }
    return {
      schema_id: input.schema_id,
      predicate: input.predicate,
      value_schema: validated.schema,
      registered_at: registeredAt,
    }
  }).immediate()
}

function writableMemory(db: Database.Database, id: string): MemoryRow {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
  // a host's store-wide permission does not turn somebody else's personal row into its
  // own. The refusal does not distinguish a missing row from an unreadable one.
  if (!row || !rowVisible(row) || !holdsVerb(currentCaller(), row.namespace ?? row.project_path, 'write')) {
    throw new Error('canonical memory is unavailable to this caller')
  }
  return row
}

function validateAttachment(db: Database.Database, input: AttachAssertionInput): string {
  exactText(input.memory_id, 'memory_id', 192)
  schemaId(input.schema_id)
  exactText(input.subject, 'subject')
  exactText(input.predicate, 'predicate')
  const registered = schemaRow(db, input.schema_id)
  if (registered.predicate !== input.predicate) throw new Error('assertion predicate does not match its registered schema')
  return validateValue(input.value, validateSchema(JSON.parse(registered.value_schema_json)).schema).json
}

function evidenceRefs(
  db: Database.Database,
  memoryId: string,
  namespace: string,
  observedBefore?: number
): { evidence: AssertionEvidenceRef[]; evidence_truncated: boolean } {
  const visibility = visibilityClause('e')
  const conditions = [
    'me.memory_id = ?',
    'e.namespace = ?',
    visibility.sql,
    '(e.expires_at IS NULL OR e.expires_at > ?)',
  ]
  const params: unknown[] = [memoryId, namespace, ...visibility.params, Date.now()]
  if (observedBefore !== undefined) {
    // later evidence/link observations cannot appear behind an observation cutoff.
    conditions.push('e.ingested_at <= ?', 'me.created_at <= ?')
    params.push(observedBefore, observedBefore)
  }
  params.push(ASSERTION_EVIDENCE_MAX + 1)
  const rows = db.prepare(
    `SELECT e.id AS episode_id, e.session_id, e.source, e.source_instance, e.source_version,
            e.external_id, e.occurred_at, e.ingested_at, me.span_start, me.span_end,
            me.created_at AS linked_at
     FROM memory_episodes me JOIN episodes e ON e.id = me.episode_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY me.created_at ASC, e.id ASC, me.span_start ASC LIMIT ?`
  ).all(...params) as AssertionEvidenceRef[]
  return { evidence: rows.slice(0, ASSERTION_EVIDENCE_MAX), evidence_truncated: rows.length > ASSERTION_EVIDENCE_MAX }
}

function materialize(
  db: Database.Database,
  row: AssertionRow,
  memory: MemoryRow,
  observedBefore?: number
): MemoryAssertion {
  return {
    memory_id: row.memory_id,
    schema_id: row.schema_id,
    subject: row.subject,
    predicate: row.predicate,
    value: JSON.parse(row.value_json) as MemoryAssertion['value'],
    observed_at: row.observed_at,
    attached_at: row.attached_at,
    represented_at: row.represented_at,
    representation_version: row.representation_version,
    memory: rowToMemory(memory),
    provenance: {
      origin: memory.origin ?? null,
      session_id: memory.session_id,
      created_at: memory.created_at,
      owner_principal: memory.owner_principal ?? null,
      visibility: memory.visibility ?? null,
      ...evidenceRefs(db, row.memory_id, memory.namespace ?? memory.project_path, observedBefore),
    },
  }
}

/** attach once to an existing row, or return an identical attachment without altering it. */
export function attachAssertion(db: Database.Database, input: AttachAssertionInput): MemoryAssertion {
  trustedHostWrite()
  inputKeys(input, ATTACH_FIELDS)
  return db.transaction(() => {
    const memory = writableMemory(db, input.memory_id)
    const json = validateAttachment(db, input)
    const existing = db.prepare('SELECT * FROM memory_assertions WHERE memory_id = ?').get(input.memory_id) as AssertionRow | undefined
    if (existing) {
      if (existing.schema_id !== input.schema_id || existing.subject !== input.subject ||
        existing.predicate !== input.predicate || existing.value_json !== json || existing.content_sha256 !== contentHash(memory)) {
        throw new Error('assertion already attached; use representation CAS or a new canonical revision for claim changes')
      }
      return materialize(db, existing, memory)
    }
    timestamp(memory.created_at, 'canonical created_at')
    const now = Date.now()
    db.prepare(
      `INSERT INTO memory_assertions
       (memory_id, schema_id, subject, predicate, value_json, observed_at, content_sha256,
        attached_at, represented_at, representation_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(input.memory_id, input.schema_id, input.subject, input.predicate, json, memory.created_at, contentHash(memory), now, now)
    const row = db.prepare('SELECT * FROM memory_assertions WHERE memory_id = ?').get(input.memory_id) as AssertionRow
    return materialize(db, row, memory)
  }).immediate()
}

/**
 * explicit schema-only representation CAS. Subject/predicate/value and observation time
 * are immutable: a changed claim must first become a new canonical memory revision.
 */
export function replaceAssertionRepresentation(
  db: Database.Database,
  input: ReplaceAssertionRepresentationInput
): MemoryAssertion {
  trustedHostWrite()
  inputKeys(input, [...ATTACH_FIELDS, 'expected_representation_version'])
  timestamp(input.expected_representation_version, 'expected_representation_version')
  if (input.expected_representation_version < 1) throw new Error('expected_representation_version must be positive')
  return db.transaction(() => {
    const memory = writableMemory(db, input.memory_id)
    const json = validateAttachment(db, input)
    const existing = db.prepare('SELECT * FROM memory_assertions WHERE memory_id = ?').get(input.memory_id) as AssertionRow | undefined
    if (!existing || existing.representation_version !== input.expected_representation_version) {
      throw new Error('assertion representation CAS conflict')
    }
    if (existing.subject !== input.subject || existing.predicate !== input.predicate || existing.value_json !== json || existing.content_sha256 !== contentHash(memory)) {
      throw new Error('assertion claim changes require a new canonical revision')
    }
    if (existing.schema_id === input.schema_id) return materialize(db, existing, memory)
    db.prepare(
      `UPDATE memory_assertions SET schema_id = ?, represented_at = ?, representation_version = representation_version + 1
       WHERE memory_id = ? AND representation_version = ?`
    ).run(input.schema_id, Date.now(), input.memory_id, input.expected_representation_version)
    const row = db.prepare('SELECT * FROM memory_assertions WHERE memory_id = ?').get(input.memory_id) as AssertionRow
    return materialize(db, row, memory)
  }).immediate()
}

/**
 * bounded exact lookup, never FTS or LLM interpretation. The caller is request context, not input data.
 * canonical namespace/visibility, archive and supersession predicates are reused; valid_at is the existing inclusive as_of semantics.
 * observed_before is independent. Defaults deliberately match canonical retrieval (no implicit as_of).
 */
export function queryAssertions(db: Database.Database, input: QueryAssertionsInput): AssertionQueryResult {
  inputKeys(input, [
    'namespace', 'subject', 'predicate', 'schema_id', 'value', 'as_of', 'valid_at',
    'observed_before', 'include_superseded', 'include_archived', 'limit',
  ])
  exactText(input.namespace, 'namespace', 4096)
  if (!holdsVerb(currentCaller(), input.namespace, 'read')) {
    throw new Error(`namespace ${input.namespace} is not covered by this credential for "read"`)
  }
  for (const key of ['as_of', 'valid_at', 'observed_before'] as const) {
    if (input[key] !== undefined) timestamp(input[key], key)
  }
  if (input.as_of !== undefined && input.valid_at !== undefined && input.as_of !== input.valid_at) {
    throw new Error('valid_at and as_of must agree when both are supplied')
  }
  for (const key of ['include_superseded', 'include_archived'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} must be boolean`)
  }
  const limit = input.limit ?? 20
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ASSERTION_QUERY_MAX) {
    throw new Error(`assertion limit must be 1..${ASSERTION_QUERY_MAX}`)
  }
  const scope = namespaceFilter('m', { project_path: input.namespace })
  const temporal = temporalFilter('m', {
    project_path: input.namespace,
    as_of: input.valid_at ?? input.as_of,
    include_superseded: input.include_superseded,
    include_archived: input.include_archived,
  })
  const conditions = [scope.sql]
  const params: unknown[] = [...scope.params]
  if (temporal.sql) {
    conditions.push(temporal.sql)
    params.push(...temporal.params)
  }
  for (const key of ['subject', 'predicate', 'schema_id'] as const) {
    if (input[key] === undefined) continue
    if (key === 'schema_id') schemaId(input[key])
    else exactText(input[key], key)
    conditions.push(`a.${key} = ? COLLATE BINARY`)
    params.push(input[key])
  }
  if (Object.hasOwn(input, 'value')) {
    conditions.push('a.value_json = ? COLLATE BINARY')
    params.push(canonicalJson(input.value))
  }
  if (input.observed_before !== undefined) {
    conditions.push('a.observed_at <= ?')
    params.push(input.observed_before)
  }
  params.push(limit)
  // one read snapshot: a concurrent canonical forget/visibility change cannot split
  // the authorized join from loading its canonical provenance or evidence references.
  const assertions = db.transaction(() => {
    const rows = db.prepare(
      `SELECT a.* FROM memory_assertions a JOIN memories m ON m.id = a.memory_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.observed_at DESC, a.memory_id ASC LIMIT ?`
    ).all(...params) as AssertionRow[]
    const loadMemory = db.prepare('SELECT * FROM memories WHERE id = ?')
    return rows.map((row) => {
      const memory = loadMemory.get(row.memory_id) as MemoryRow
      return materialize(db, row, memory, input.observed_before)
    })
  }).deferred()
  auditCrossOwnerRead(db, { tool: 'query_assertions', namespace: input.namespace, ids: assertions.map((row) => row.memory_id) })
  return { assertions, representation_history: 'current-only', evidence_history: 'current-visible-links' }
}
