// requester identity is supplied by a trusted host, not by bridge request arguments.
export interface BridgeRequester { readonly principalId: string }
export interface SourceLocator {
  readonly provider: string
  readonly namespace: string
  readonly sourceId: string
}
export interface SourceRef extends SourceLocator { readonly revision: string }
export interface SourceEvidence {
  readonly provider: string
  readonly evidenceId: string
  readonly revision: string
  readonly uri: string | null
  readonly excerpt: string | null
}
export interface SourceSnapshot {
  readonly ref: SourceRef
  readonly content: string
  readonly contentType: string
  readonly tags: readonly string[]
  readonly provenance: readonly SourceEvidence[]
  readonly contentSha256: string
  readonly projectionSha256: string
  readonly capturedAt: number
}
export type SourceReadResult =
  | { readonly status: 'available'; readonly snapshot: SourceSnapshot }
  | { readonly status: 'not_found' | 'forbidden' | 'degraded' | 'changed' | 'retired' }
// source implementations bind authorization context at construction, including share checks.
export interface SourcePort {
  readonly provider: string
  readonly requester: BridgeRequester
  resolveCurrent(locator: SourceLocator): Promise<SourceReadResult>
  readExact(ref: SourceRef): Promise<SourceReadResult>
}
export interface DestinationRef {
  readonly adapterId: string
  readonly scope: string
  readonly reader: string
}
export type BridgeOperation = 'publish' | 'retract'
export interface PublicationReceipt {
  readonly publicationId: string
  readonly version: string
  readonly payloadSha256: string
  readonly destination: DestinationRef
}
export interface RetractionTarget {
  readonly envelopeId: string
  readonly sourceRef: SourceRef
  readonly publication: PublicationReceipt
}
export interface EnvelopeBase {
  readonly schemaVersion: 'bridge.payload/v1'
  readonly envelopeId: string
  readonly destination: DestinationRef
  readonly purpose: string
  readonly policyId: string
  readonly policyVersion: string
  readonly requester: BridgeRequester
  readonly createdAt: number
}
export type BridgePayload = EnvelopeBase & (
  | { readonly operation: 'publish'; readonly snapshot: SourceSnapshot; readonly supersedesEnvelopeId: string | null }
  | { readonly operation: 'retract'; readonly target: RetractionTarget; readonly reason: string }
)
export type BridgeEnvelope = BridgePayload & {
  readonly payloadBytes: string
  readonly payloadSha256: string
  readonly idempotencyKey: string
}
export interface VerifiedApproval {
  readonly verifierId: string
  readonly grantId: string
  readonly approver: string
  readonly requester: string
  readonly bindingSha256: string
  readonly expiresAt: number
  readonly allowedOperations: readonly BridgeOperation[]
}
export type ApprovalVerdict =
  | { readonly status: 'verified'; readonly approval: VerifiedApproval }
  | { readonly status: 'denied' | 'unavailable' }
export interface ApprovalCheck {
  readonly envelope: BridgeEnvelope
  readonly opaqueGrant: string
  readonly now: number
}
export interface ApprovalVerifier {
  readonly verifierId: string
  verify(input: ApprovalCheck): Promise<ApprovalVerdict>
  recheck(input: ApprovalCheck & { readonly approval: VerifiedApproval }): Promise<ApprovalVerdict>
}
export interface DestinationCapabilities {
  readonly publish: boolean
  readonly retract: boolean
  readonly readVisibility: boolean
  readonly readAbsence: boolean
  readonly idempotentPublish: boolean
  readonly idempotentRetract: boolean
}
export type DeliveryOutcome =
  | { readonly status: 'acknowledged'; readonly publication: PublicationReceipt }
  | { readonly status: 'pending' | 'forbidden' | 'degraded' | 'rejected' | 'conflict' | 'unsupported' | 'ambiguous' }
export type VisibilityOutcome =
  | { readonly status: 'visible'; readonly publication: PublicationReceipt }
  | { readonly status: 'empty' | 'forbidden' | 'degraded' | 'pending' | 'unsupported' | 'conflict' }
export type AbsenceOutcome =
  | { readonly status: 'absent'; readonly publication: PublicationReceipt }
  | { readonly status: 'present' | 'forbidden' | 'degraded' | 'pending' | 'unsupported' | 'conflict' }
export interface DeliveryContext { readonly idempotencyKey: string; readonly attempt: number }
// adapters attest observations for the bound reader; an empty/auth failure is not a proof.
export interface DestinationAdapter {
  readonly adapterId: string
  capabilities(): Promise<DestinationCapabilities>
  publish(envelope: BridgeEnvelope & { readonly operation: 'publish' }, context: DeliveryContext): Promise<DeliveryOutcome>
  retract(envelope: BridgeEnvelope & { readonly operation: 'retract' }, context: DeliveryContext): Promise<DeliveryOutcome>
  verifyVisibility(publication: PublicationReceipt): Promise<VisibilityOutcome>
  verifyAbsence(publication: PublicationReceipt): Promise<AbsenceOutcome>
}
export type OutboxState = 'queued' | 'sending' | 'acknowledged' | 'visible' | 'retract_acknowledged'
  | 'retracted_verified' | 'reconciliation_required' | 'conflict' | 'rejected' | 'dead' | 'cancelled'
export interface OutboxRow {
  readonly envelopeId: string
  readonly state: OutboxState
  readonly attempt: number
  readonly maxAttempts: number
  readonly leaseOwner: string | null
  readonly leaseToken: string | null
  readonly leaseGeneration: number
  readonly leaseExpiresAt: number | null
  readonly nextAttemptAt: number
  readonly lastError: string | null
}
export interface OutboxClaim extends OutboxRow {
  readonly state: 'sending'
  readonly leaseOwner: string
  readonly leaseToken: string
  readonly leaseExpiresAt: number
}
export interface StoredApproval {
  readonly opaqueGrant: string
  readonly approval: VerifiedApproval
  readonly revoked: boolean
}
export interface BridgeEvent {
  readonly sequence: number
  readonly envelopeId: string
  readonly type: string
  readonly at: number
  readonly detail: string
}
export interface PublishProposal {
  readonly source: SourceLocator
  readonly destination: DestinationRef
  readonly purpose: string
  readonly policyId: string
  readonly policyVersion: string
  readonly supersedesEnvelopeId?: string
}
export interface RetractionProposal {
  readonly targetEnvelopeId: string
  readonly purpose: string
  readonly policyId: string
  readonly policyVersion: string
  readonly reason: string
}
export interface BridgeRuntime {
  readonly now: () => number
  readonly random: () => number
  readonly newId: () => string
}
