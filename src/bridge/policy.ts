import { createHash, randomUUID } from 'node:crypto'
import type { BridgeEnvelope, BridgePayload, BridgeRuntime, DestinationRef, OutboxState, PublicationReceipt, SourceRef, SourceSnapshot } from './types.js'

export class BridgeError extends Error {}
export class StaleLeaseError extends BridgeError {}
export const defaultBridgeRuntime: BridgeRuntime = { now: Date.now, random: Math.random, newId: randomUUID }
export function sha256(bytes: string): string { return createHash('sha256').update(bytes, 'utf8').digest('hex') }

// canonical json rejects values json would silently erase or coerce.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new BridgeError('invalid json array')
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  throw new BridgeError('invalid json value')
}
export function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(immutable)
    Object.freeze(value)
  }
  return value
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) throw new BridgeError('invalid projection fields')
  return value as Record<string, unknown>
}
export function identity(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new BridgeError('missing identity')
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new BridgeError('invalid text')
  return value
}
export function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new BridgeError('invalid timestamp')
  return value
}
export function sourceRef(value: unknown): SourceRef {
  const r = object(value, ['provider', 'namespace', 'sourceId', 'revision'])
  return { provider: identity(r.provider), namespace: identity(r.namespace), sourceId: identity(r.sourceId), revision: identity(r.revision) }
}
export function destinationRef(value: unknown): DestinationRef {
  const d = object(value, ['adapterId', 'scope', 'reader'])
  return { adapterId: identity(d.adapterId), scope: identity(d.scope), reader: identity(d.reader) }
}
export function snapshotProjection(snapshot: Pick<SourceSnapshot, 'ref' | 'content' | 'contentType' | 'tags' | 'provenance'>): string {
  return canonicalJson({ ref: snapshot.ref, content: snapshot.content, contentType: snapshot.contentType, tags: snapshot.tags, provenance: snapshot.provenance })
}
export function normalizeSnapshot(value: unknown): SourceSnapshot {
  const s = object(value, ['ref', 'content', 'contentType', 'tags', 'provenance', 'contentSha256', 'projectionSha256', 'capturedAt'])
  if (!Array.isArray(s.tags) || !Array.isArray(s.provenance)) throw new BridgeError('invalid snapshot collections')
  const snapshot: SourceSnapshot = {
    ref: sourceRef(s.ref), content: text(s.content), contentType: identity(s.contentType),
    tags: s.tags.map(text), provenance: s.provenance.map((value) => {
      const p = object(value, ['provider', 'evidenceId', 'revision', 'uri', 'excerpt'])
      return { provider: identity(p.provider), evidenceId: identity(p.evidenceId), revision: identity(p.revision),
        uri: p.uri === null ? null : text(p.uri), excerpt: p.excerpt === null ? null : text(p.excerpt) }
    }),
    contentSha256: identity(s.contentSha256), projectionSha256: identity(s.projectionSha256), capturedAt: timestamp(s.capturedAt),
  }
  if (sha256(snapshot.content) !== snapshot.contentSha256 || sha256(snapshotProjection(snapshot)) !== snapshot.projectionSha256) throw new BridgeError('snapshot hash mismatch')
  return immutable(snapshot)
}
export function publicationReceipt(value: unknown): PublicationReceipt {
  const p = object(value, ['publicationId', 'version', 'payloadSha256', 'destination'])
  return immutable({ publicationId: identity(p.publicationId), version: identity(p.version), payloadSha256: identity(p.payloadSha256), destination: destinationRef(p.destination) })
}
function normalizePayload(value: unknown): BridgePayload {
  const op = (value as { operation?: unknown } | null)?.operation
  const baseKeys = ['schemaVersion', 'envelopeId', 'operation', 'destination', 'purpose', 'policyId', 'policyVersion', 'requester', 'createdAt']
  const p = object(value, [...baseKeys, ...(op === 'publish' ? ['snapshot', 'supersedesEnvelopeId'] : ['target', 'reason'])])
  if (p.schemaVersion !== 'bridge.payload/v1') throw new BridgeError('unsupported schema')
  const requester = object(p.requester, ['principalId'])
  const base = { schemaVersion: 'bridge.payload/v1' as const, envelopeId: identity(p.envelopeId), destination: destinationRef(p.destination),
    purpose: identity(p.purpose), policyId: identity(p.policyId), policyVersion: identity(p.policyVersion),
    requester: { principalId: identity(requester.principalId) }, createdAt: timestamp(p.createdAt) }
  if (op === 'publish') return { ...base, operation: op, snapshot: normalizeSnapshot(p.snapshot),
    supersedesEnvelopeId: p.supersedesEnvelopeId === null ? null : identity(p.supersedesEnvelopeId) }
  if (op !== 'retract') throw new BridgeError('invalid operation')
  const t = object(p.target, ['envelopeId', 'sourceRef', 'publication'])
  const target = { envelopeId: identity(t.envelopeId), sourceRef: sourceRef(t.sourceRef), publication: publicationReceipt(t.publication) }
  if (canonicalJson(target.publication.destination) !== canonicalJson(base.destination)) throw new BridgeError('retraction route mismatch')
  return { ...base, operation: op, target, reason: identity(p.reason) }
}
export function computeIdempotencyKey(operation: string, envelopeId: string, payloadSha256: string): string {
  return sha256(canonicalJson([operation, envelopeId, payloadSha256]))
}
export function sealEnvelope(payload: BridgePayload): BridgeEnvelope {
  const normalized = normalizePayload(payload)
  const payloadBytes = canonicalJson(normalized)
  const payloadSha256 = sha256(payloadBytes)
  return immutable({ ...normalized, payloadBytes, payloadSha256, idempotencyKey: computeIdempotencyKey(normalized.operation, normalized.envelopeId, payloadSha256) })
}
export function verifyEnvelopeIntegrity(envelope: BridgeEnvelope): void {
  const { payloadBytes, payloadSha256, idempotencyKey, ...payload } = envelope
  const sealed = sealEnvelope(payload)
  if (sealed.payloadBytes !== payloadBytes || sealed.payloadSha256 !== payloadSha256 || sealed.idempotencyKey !== idempotencyKey) throw new BridgeError('envelope integrity mismatch')
}
export function receiptMatches(receipt: PublicationReceipt, envelope: BridgeEnvelope): boolean {
  try {
    const normalized = publicationReceipt(receipt)
    if (envelope.operation === 'retract') return canonicalJson(normalized) === canonicalJson(envelope.target.publication)
    return normalized.payloadSha256 === envelope.payloadSha256 && canonicalJson(normalized.destination) === canonicalJson(envelope.destination)
  } catch { return false }
}
export const transitions: Readonly<Record<OutboxState, readonly OutboxState[]>> = {
  queued: ['sending', 'cancelled', 'reconciliation_required'],
  sending: ['queued', 'acknowledged', 'retract_acknowledged', 'reconciliation_required', 'conflict', 'rejected', 'dead', 'cancelled'],
  acknowledged: ['visible', 'reconciliation_required'], visible: ['reconciliation_required'],
  retract_acknowledged: ['retracted_verified', 'reconciliation_required'], retracted_verified: ['reconciliation_required'],
  reconciliation_required: [], conflict: [], rejected: [], dead: [], cancelled: [],
}
export function assertTransition(from: OutboxState, to: OutboxState): void {
  if (!transitions[from].includes(to)) throw new BridgeError(`invalid transition ${from} -> ${to}`)
}
export function retryDelay(attempt: number, base: number, cap: number, jitter: number, random: () => number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isFinite(base) || base <= 0 || !Number.isFinite(cap) || cap < base
    || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new BridgeError('invalid retry policy')
  const sample = random()
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new BridgeError('invalid randomness')
  return Math.max(1, Math.floor(Math.min(cap, base * 2 ** Math.min(30, attempt - 1)) * (1 - jitter + jitter * sample)))
}
