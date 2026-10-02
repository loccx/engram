import type { Memory } from '../types.js'

export type AssertionJsonValue =
  | null
  | boolean
  | number
  | string
  | AssertionJsonValue[]
  | { [key: string]: AssertionJsonValue }

/** a strict, local JSON-schema subset: no refs, coercion, defaults or executable validators. */
export type AssertionValueSchema =
  | { type: 'null' }
  | { type: 'boolean'; enum?: boolean[] }
  | { type: 'string'; minLength?: number; maxLength?: number; enum?: string[] }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number; enum?: number[] }
  | { type: 'array'; items: AssertionValueSchema; minItems?: number; maxItems?: number }
  | {
      type: 'object'
      properties: Record<string, AssertionValueSchema>
      required?: string[]
      additionalProperties: false
    }

export interface RegisterAssertionSchemaInput {
  /** an immutable name@version, e.g. profile.timezone@1 or profile.timezone@1.0.0. */
  schema_id: string
  /** the schema has one exact predicate; it confers no truth or authority. */
  predicate: string
  value_schema: AssertionValueSchema
}

export interface RegisteredAssertionSchema extends RegisterAssertionSchemaInput {
  registered_at: number
}

export interface AttachAssertionInput {
  memory_id: string
  schema_id: string
  subject: string
  predicate: string
  value: AssertionJsonValue
}

export interface ReplaceAssertionRepresentationInput extends AttachAssertionInput {
  /** the CAS prevents one host's representation change from overwriting another's. */
  expected_representation_version: number
}

export interface QueryAssertionsInput {
  /** exact namespace, not a caller-controlled expansion of its grants. */
  namespace: string
  subject?: string
  predicate?: string
  schema_id?: string
  /** whole-value, type-sensitive equality; object key order is irrelevant. */
  value?: AssertionJsonValue
  as_of?: number
  /** alias of canonical as_of; not the time the claim was observed. */
  valid_at?: number
  /** inclusive observation cutoff, independent of canonical validity. */
  observed_before?: number
  include_superseded?: boolean
  include_archived?: boolean
  limit?: number
}

/** only existing canonical evidence links that are currently readable are returned. */
export interface AssertionEvidenceRef {
  episode_id: string
  session_id: string
  source: string
  source_instance: string | null
  source_version: string | null
  external_id: string
  occurred_at: number | null
  ingested_at: number
  span_start: number | null
  span_end: number | null
  linked_at: number
}

export interface MemoryAssertion {
  memory_id: string
  schema_id: string
  subject: string
  predicate: string
  value: AssertionJsonValue
  /** inherited from this canonical revision's created_at, never supplied by an agent. */
  observed_at: number
  attached_at: number
  represented_at: number
  representation_version: number
  /** the actual canonical row; the sidecar never substitutes for its claim. */
  memory: Memory
  provenance: {
    origin: string | null
    session_id: string
    created_at: number
    owner_principal: string | null
    visibility: string | null
    evidence: AssertionEvidenceRef[]
    evidence_truncated: boolean
  }
}

export interface AssertionQueryResult {
  assertions: MemoryAssertion[]
  /** as_of/valid_at snapshots canonical validity, not mutable representation metadata. */
  representation_history: 'current-only'
  /** evidence is a live, visibility-filtered projection, not an evidence snapshot. */
  evidence_history: 'current-visible-links'
}
