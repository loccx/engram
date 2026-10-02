import Database from 'better-sqlite3'
import { BridgeCoordinator, BridgeStore, canonicalJson, normalizeSnapshot, sha256, snapshotProjection } from '../../src/bridge/index.js'
import { migration026 } from '../../src/db/migrations/026_bridge.js'
import type { AbsenceOutcome, ApprovalCheck, ApprovalVerdict, ApprovalVerifier, BridgeEnvelope, BridgeRuntime, DeliveryContext, DeliveryOutcome, DestinationAdapter, DestinationCapabilities, DestinationRef, PublicationReceipt, SourceLocator, SourcePort, SourceReadResult, SourceRef, SourceSnapshot, VerifiedApproval, VisibilityOutcome } from '../../src/bridge/index.js'

// all identities, grants and content here are inert test fixtures, never live credentials.
export const fixtureRequester = { principalId: 'fixture-requester' }
export const fixtureDestination: DestinationRef = { adapterId: 'fixture-sink', scope: 'fixture-scope', reader: 'fixture-reader' }
export const fixtureLocator: SourceLocator = { provider: 'fixture-source', namespace: 'fixture-namespace', sourceId: 'fixture-memory' }
export class FixtureClock implements BridgeRuntime {
  time = 1000
  serial = 0
  sample = 0.5
  now = () => this.time
  random = () => this.sample
  newId = () => `fixture-id-${++this.serial}`
}
export function fixtureSnapshot(revision = 'opaque-revision-one', content = 'curated inert content'): SourceSnapshot {
  const projection = { ref: { ...fixtureLocator, revision }, content, contentType: 'text/plain', tags: ['fixture'],
    provenance: [{ provider: 'fixture-evidence', evidenceId: 'fixture-e1', revision: 'evidence-v1', uri: null, excerpt: 'inert evidence' }] }
  return normalizeSnapshot({ ...projection, contentSha256: sha256(content), projectionSha256: sha256(snapshotProjection(projection)), capturedAt: 1000 })
}
export class InertSource implements SourcePort {
  readonly provider = fixtureLocator.provider
  readonly requester = fixtureRequester
  snapshot = fixtureSnapshot()
  status: Exclude<SourceReadResult['status'], 'available'> | 'available' = 'available'
  reads = 0
  beforeRead?: () => Promise<void>
  async resolveCurrent(locator: SourceLocator): Promise<SourceReadResult> {
    if (locator.namespace !== this.snapshot.ref.namespace) return { status: 'forbidden' }
    if (locator.sourceId !== this.snapshot.ref.sourceId || locator.provider !== this.provider) return { status: 'not_found' }
    return this.status === 'available' ? { status: 'available', snapshot: this.snapshot } : { status: this.status }
  }
  async readExact(ref: SourceRef): Promise<SourceReadResult> {
    this.reads++
    await this.beforeRead?.()
    if (this.status !== 'available') return { status: this.status }
    return canonicalJson(ref) === canonicalJson(this.snapshot.ref) ? { status: 'available', snapshot: this.snapshot } : { status: 'changed' }
  }
}
export class InertAuthority implements ApprovalVerifier {
  readonly verifierId = 'fixture-authority'
  private readonly grants = new Map<string, VerifiedApproval>()
  private readonly revoked = new Set<string>()
  beforeRecheck?: () => Promise<void>
  issue(envelope: BridgeEnvelope, overrides: Partial<VerifiedApproval> = {}): string {
    const grant = `inert-grant-${this.grants.size + 1}`
    this.grants.set(grant, { verifierId: this.verifierId, grantId: grant, approver: 'fixture-human-authority',
      requester: envelope.requester.principalId, bindingSha256: envelope.payloadSha256, expiresAt: 100_000,
      allowedOperations: [envelope.operation], ...overrides })
    return grant
  }
  revoke(grant: string): void { this.revoked.add(grant) }
  async verify(input: ApprovalCheck): Promise<ApprovalVerdict> {
    const a = this.grants.get(input.opaqueGrant)
    if (!a || this.revoked.has(input.opaqueGrant) || a.bindingSha256 !== input.envelope.payloadSha256
      || a.requester !== input.envelope.requester.principalId || input.now >= a.expiresAt || !a.allowedOperations.includes(input.envelope.operation)) return { status: 'denied' }
    return { status: 'verified', approval: a }
  }
  async recheck(input: ApprovalCheck & { readonly approval: VerifiedApproval }): Promise<ApprovalVerdict> {
    await this.beforeRecheck?.()
    return this.verify(input)
  }
}
export class InertDestination implements DestinationAdapter {
  readonly adapterId = fixtureDestination.adapterId
  caps: DestinationCapabilities = { publish: true, retract: true, readVisibility: true, readAbsence: true, idempotentPublish: true, idempotentRetract: true }
  readonly remote = new Map<string, { bytes: string; publication: PublicationReceipt }>()
  readonly keys = new Map<string, { bytes: string; publication: PublicationReceipt }>()
  readonly calls: { operation: string; key: string; bytes: string; attempt: number }[] = []
  deliveryStatus?: Exclude<DeliveryOutcome['status'], 'acknowledged'>
  visibilityStatus?: Exclude<VisibilityOutcome['status'], 'visible'>
  absenceStatus?: Exclude<AbsenceOutcome['status'], 'absent'>
  acknowledgement?: (receipt: PublicationReceipt) => PublicationReceipt
  observation?: (receipt: PublicationReceipt) => PublicationReceipt
  beforeDelivery?: () => Promise<void>
  async capabilities(): Promise<DestinationCapabilities> { return this.caps }
  remoteKey(p: PublicationReceipt): string { return canonicalJson([p.publicationId, p.version, p.destination.scope, p.destination.reader]) }
  async publish(envelope: BridgeEnvelope & { operation: 'publish' }, context: DeliveryContext): Promise<DeliveryOutcome> {
    return this.deliver(envelope, context)
  }
  async retract(envelope: BridgeEnvelope & { operation: 'retract' }, context: DeliveryContext): Promise<DeliveryOutcome> {
    return this.deliver(envelope, context)
  }
  private async deliver(envelope: BridgeEnvelope, context: DeliveryContext): Promise<DeliveryOutcome> {
    this.calls.push({ operation: envelope.operation, key: context.idempotencyKey, bytes: envelope.payloadBytes, attempt: context.attempt })
    await this.beforeDelivery?.()
    const existing = this.keys.get(context.idempotencyKey)
    if (existing && existing.bytes !== envelope.payloadBytes) return { status: 'conflict' }
    if (this.deliveryStatus && this.deliveryStatus !== 'pending') return { status: this.deliveryStatus }
    let publication: PublicationReceipt
    if (existing) publication = existing.publication
    else {
      publication = envelope.operation === 'publish'
        ? { publicationId: `fixture-publication:${envelope.snapshot.ref.sourceId}`, version: envelope.envelopeId,
          payloadSha256: envelope.payloadSha256, destination: envelope.destination }
        : envelope.target.publication
      this.keys.set(context.idempotencyKey, { bytes: envelope.payloadBytes, publication })
      if (envelope.operation === 'publish') this.remote.set(this.remoteKey(publication), { bytes: envelope.payloadBytes, publication })
      else this.remote.delete(this.remoteKey(publication))
    }
    return this.deliveryStatus === 'pending' ? { status: 'pending' }
      : { status: 'acknowledged', publication: this.acknowledgement?.(publication) ?? publication }
  }
  async verifyVisibility(publication: PublicationReceipt): Promise<VisibilityOutcome> {
    if (this.visibilityStatus) return { status: this.visibilityStatus }
    const found = this.remote.get(this.remoteKey(publication))
    return found ? { status: 'visible', publication: this.observation?.(found.publication) ?? found.publication } : { status: 'empty' }
  }
  async verifyAbsence(publication: PublicationReceipt): Promise<AbsenceOutcome> {
    if (this.absenceStatus) return { status: this.absenceStatus }
    return this.remote.has(this.remoteKey(publication)) ? { status: 'present' }
      : { status: 'absent', publication: this.observation?.(publication) ?? publication }
  }
}
export function fixtureBridge(path = ':memory:', clock = new FixtureClock()) {
  const db = new Database(path)
  db.pragma('foreign_keys = ON')
  migration026.up(db)
  const source = new InertSource()
  const authority = new InertAuthority()
  const destination = new InertDestination()
  const store = new BridgeStore(db, clock)
  const coordinator = new BridgeCoordinator({ store, requester: fixtureRequester, source, verifier: authority })
  return { db, source, authority, destination, store, coordinator, clock }
}
export async function proposed(f: ReturnType<typeof fixtureBridge>) {
  return f.coordinator.proposePublish({ source: fixtureLocator, destination: fixtureDestination, purpose: 'fixture-purpose', policyId: 'fixture-policy', policyVersion: 'v1' })
}
export async function queued(f: ReturnType<typeof fixtureBridge>, maxAttempts = 5) {
  const envelope = await proposed(f)
  const grant = f.authority.issue(envelope)
  await f.coordinator.approve(envelope.envelopeId, grant)
  f.coordinator.enqueue(envelope.envelopeId, maxAttempts)
  return { envelope, grant }
}
export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}
// conformance consumes a supplied inert adapter and exercises the real coordinator/store.
export async function exerciseBridgePath(f: ReturnType<typeof fixtureBridge>, adapter: DestinationAdapter) {
  const { envelope } = await queued(f)
  await f.coordinator.drain(adapter, { owner: 'fixture-drainer' })
  const visibility = await f.coordinator.verifyVisibility(envelope.envelopeId, adapter)
  const retraction = f.coordinator.proposeRetraction({ targetEnvelopeId: envelope.envelopeId, reason: 'fixture-cleanup',
    purpose: 'fixture-retract-purpose', policyId: 'fixture-policy', policyVersion: 'v1' })
  await f.coordinator.approve(retraction.envelopeId, f.authority.issue(retraction))
  f.coordinator.enqueue(retraction.envelopeId)
  await f.coordinator.drain(adapter, { owner: 'fixture-drainer' })
  const absence = await f.coordinator.verifyRetraction(retraction.envelopeId, adapter)
  return { envelope, retraction, visibility, absence }
}
