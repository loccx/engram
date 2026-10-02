import { BridgeError, StaleLeaseError, canonicalJson, identity, immutable, normalizeSnapshot, publicationReceipt, receiptMatches, retryDelay, sealEnvelope, verifyEnvelopeIntegrity } from './policy.js'
import { BridgeStore } from './store.js'
import { checkedApproval, defaultDenyVerifier } from './verifier.js'
import type { ApprovalVerdict, ApprovalVerifier, BridgeEnvelope, BridgeRequester, DeliveryOutcome, DestinationAdapter, DestinationCapabilities, OutboxState, PublicationReceipt, PublishProposal, RetractionProposal, SourcePort, StoredApproval } from './types.js'

export interface CoordinatorOptions {
  readonly store: BridgeStore
  readonly requester: BridgeRequester
  readonly source?: SourcePort
  readonly verifier?: ApprovalVerifier
}
export interface DrainOptions {
  readonly owner: string
  readonly maxJobs?: number
  readonly leaseMs?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly jitter?: number
}
export interface DrainResult {
  readonly claimed: number
  readonly completed: readonly { readonly envelopeId: string; readonly state: OutboxState }[]
  readonly staleLeases: number
}

// construction and calls are explicit; neither imports nor opening a store drains work.
export class BridgeCoordinator {
  private readonly store: BridgeStore
  private readonly requester: BridgeRequester
  private readonly source?: SourcePort
  private readonly verifier: ApprovalVerifier
  constructor(options: CoordinatorOptions) {
    this.store = options.store
    this.requester = immutable({ principalId: identity(options.requester.principalId) })
    this.source = options.source
    this.verifier = options.verifier ?? defaultDenyVerifier
    if (this.source) this.checkSourceBinding()
  }
  private checkSourceBinding(): SourcePort {
    if (!this.source || this.source.requester.principalId !== this.requester.principalId) throw new BridgeError('source requester mismatch')
    identity(this.source.provider)
    return this.source
  }
  private ownedEnvelope(id: string): BridgeEnvelope {
    const envelope = this.store.getEnvelope(id)
    if (!envelope || envelope.requester.principalId !== this.requester.principalId) throw new BridgeError('envelope unavailable to requester')
    return envelope
  }
  async proposePublish(input: PublishProposal): Promise<BridgeEnvelope> {
    const source = this.checkSourceBinding()
    if (input.source.provider !== source.provider) throw new BridgeError('source provider mismatch')
    const locator = immutable({ provider: identity(input.source.provider), namespace: identity(input.source.namespace), sourceId: identity(input.source.sourceId) })
    // copy request metadata before awaiting a port so callers cannot race the binding.
    const metadata = JSON.parse(canonicalJson({ destination: input.destination, purpose: input.purpose, policyId: input.policyId,
      policyVersion: input.policyVersion, supersedesEnvelopeId: input.supersedesEnvelopeId ?? null })) as Omit<PublishProposal, 'source'> & { supersedesEnvelopeId: string | null }
    const result = await source.resolveCurrent(locator)
    this.checkSourceBinding()
    if (result.status !== 'available') throw new BridgeError(`source ${result.status}`)
    const snapshot = normalizeSnapshot(result.snapshot)
    if (snapshot.ref.provider !== locator.provider || snapshot.ref.namespace !== locator.namespace || snapshot.ref.sourceId !== locator.sourceId) throw new BridgeError('source locator mismatch')
    return this.store.insertProposal(sealEnvelope({ schemaVersion: 'bridge.payload/v1', envelopeId: this.store.runtime.newId(),
      operation: 'publish', destination: metadata.destination, purpose: metadata.purpose, policyId: metadata.policyId,
      policyVersion: metadata.policyVersion, supersedesEnvelopeId: metadata.supersedesEnvelopeId,
      requester: this.requester, createdAt: this.store.runtime.now(), snapshot }))
  }
  proposeRetraction(input: RetractionProposal): BridgeEnvelope {
    const target = this.ownedEnvelope(input.targetEnvelopeId)
    const publication = this.store.getPublication(target.envelopeId)
    if (target.operation !== 'publish' || !publication || !receiptMatches(publication, target)) throw new BridgeError('target has no exact acknowledgement')
    return this.store.insertProposal(sealEnvelope({ schemaVersion: 'bridge.payload/v1', envelopeId: this.store.runtime.newId(), operation: 'retract',
      destination: target.destination, purpose: input.purpose, policyId: input.policyId, policyVersion: input.policyVersion,
      requester: this.requester, createdAt: this.store.runtime.now(), reason: input.reason,
      target: { envelopeId: target.envelopeId, sourceRef: target.snapshot.ref, publication } }))
  }
  async approve(id: string, opaqueGrant: string): Promise<void> {
    const envelope = this.ownedEnvelope(id)
    identity(opaqueGrant)
    let verdict: ApprovalVerdict
    try { verdict = await this.verifier.verify(immutable({ envelope, opaqueGrant, now: this.store.runtime.now() })) }
    catch { throw new BridgeError('authority unavailable') }
    const approval = checkedApproval(verdict, this.verifier, envelope, this.store.runtime.now())
    if (!approval) throw new BridgeError('authority denied or unavailable')
    this.store.saveApproval(id, opaqueGrant, approval)
  }
  cancelProposal(id: string): void { this.ownedEnvelope(id); this.store.cancelProposal(id) }
  revokeApproval(id: string): void { this.ownedEnvelope(id); this.store.revokeApproval(id) }
  enqueue(id: string, maxAttempts = 5) { this.ownedEnvelope(id); return this.store.enqueue(id, maxAttempts) }
  async verifyVisibility(id: string, adapter: DestinationAdapter) { this.ownedEnvelope(id); return this.store.verifyVisibility(id, adapter) }
  async verifyRetraction(id: string, adapter: DestinationAdapter) { this.ownedEnvelope(id); return this.store.verifyRetraction(id, adapter) }

  private localApproval(envelope: BridgeEnvelope): StoredApproval | null {
    const a = this.store.getApproval(envelope.envelopeId)
    if (!a || a.revoked || a.approval.verifierId !== this.verifier.verifierId || a.approval.requester !== this.requester.principalId
      || a.approval.bindingSha256 !== envelope.payloadSha256 || this.store.runtime.now() >= a.approval.expiresAt
      || !a.approval.allowedOperations.includes(envelope.operation)) return null
    return a
  }
  private async sourceStatus(envelope: BridgeEnvelope): Promise<'valid' | 'invalid' | 'degraded'> {
    // cleanup targets the immutable remote receipt, not a mutable or surviving source row.
    if (envelope.operation === 'retract') {
      const target = this.store.getEnvelope(envelope.target.envelopeId)
      const receipt = this.store.getPublication(envelope.target.envelopeId)
      return target && target.operation === 'publish' && receipt && receiptMatches(receipt, target)
        && canonicalJson(receipt) === canonicalJson(envelope.target.publication)
        && canonicalJson(target.snapshot.ref) === canonicalJson(envelope.target.sourceRef) ? 'valid' : 'invalid'
    }
    try {
      const source = this.checkSourceBinding()
      if (source.provider !== envelope.snapshot.ref.provider) return 'invalid'
      const result = await source.readExact(envelope.snapshot.ref)
      this.checkSourceBinding()
      if (result.status !== 'available') return result.status === 'degraded' ? 'degraded' : 'invalid'
      let snapshot
      try { snapshot = normalizeSnapshot(result.snapshot) }
      catch { return 'invalid' }
      return canonicalJson(snapshot.ref) === canonicalJson(envelope.snapshot.ref)
        && snapshot.contentSha256 === envelope.snapshot.contentSha256 && snapshot.projectionSha256 === envelope.snapshot.projectionSha256 ? 'valid' : 'invalid'
    } catch { return 'degraded' }
  }
  private async authorityStatus(envelope: BridgeEnvelope): Promise<'valid' | 'invalid' | 'degraded'> {
    const a = this.localApproval(envelope)
    if (!a) return 'invalid'
    try {
      const result = await this.verifier.recheck(immutable({ envelope, opaqueGrant: a.opaqueGrant, approval: a.approval, now: this.store.runtime.now() }))
      if (!this.localApproval(envelope)) return 'invalid'
      if (result.status === 'unavailable') return 'degraded'
      return checkedApproval(result, this.verifier, envelope, this.store.runtime.now(), a.approval) ? 'valid' : 'invalid'
    } catch { return 'degraded' }
  }
  async drain(adapter: DestinationAdapter, options: DrainOptions): Promise<DrainResult> {
    const maxJobs = options.maxJobs ?? 10
    const leaseMs = options.leaseMs ?? 30_000
    const baseDelay = options.baseDelayMs ?? 1000
    const maxDelay = options.maxDelayMs ?? 60_000
    const jitter = options.jitter ?? 0.25
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 1000) throw new BridgeError('invalid drain limit')
    // validate retry settings before claiming any work, without consuming injected randomness.
    retryDelay(1, baseDelay, maxDelay, jitter, () => 0)
    const completed: { envelopeId: string; state: OutboxState }[] = []
    let claimed = 0
    let staleLeases = 0
    for (let i = 0; i < maxJobs; i++) {
      const claim = this.store.claim(options.owner, leaseMs, adapter.adapterId, this.requester.principalId)
      if (!claim) break
      claimed++
      const finish = (state: Parameters<BridgeStore['complete']>[1], reason: string | null = null, receipt: Parameters<BridgeStore['complete']>[3] = null, nextAt?: number) => {
        this.store.complete(claim, state, reason, receipt, nextAt)
        completed.push({ envelopeId: claim.envelopeId, state })
      }
      const defer = (reason: string, uncertain: boolean, idempotent: boolean) => {
        if (uncertain && !idempotent) finish('reconciliation_required', reason)
        else if (claim.attempt >= claim.maxAttempts) finish(uncertain ? 'reconciliation_required' : 'dead', reason)
        else finish('queued', reason, null, this.store.runtime.now() + retryDelay(claim.attempt, baseDelay, maxDelay, jitter, this.store.runtime.random))
      }
      let attemptedEnvelope: BridgeEnvelope | null = null
      let actualReceipt: PublicationReceipt | null = null
      try {
        if (!this.store.owns(claim)) throw new StaleLeaseError('expired claim')
        let envelope = this.ownedEnvelope(claim.envelopeId)
        verifyEnvelopeIntegrity(envelope)
        const previouslyAttempted = this.store.hasDeliveryAttempt(envelope.envelopeId)
        let capabilities: DestinationCapabilities
        try { capabilities = await adapter.capabilities() }
        catch { defer('capabilities_unavailable', this.store.hasDeliveryAttempt(envelope.envelopeId), false); continue }
        if (!this.store.owns(claim)) throw new StaleLeaseError('expired claim')
        const idempotent = envelope.operation === 'publish' ? capabilities.idempotentPublish === true : capabilities.idempotentRetract === true
        if ((envelope.operation === 'publish' ? capabilities.publish : capabilities.retract) !== true || claim.attempt > 1 && !idempotent) {
          finish('reconciliation_required', 'unsupported_operation_or_safe_retry'); continue
        }
        if (claim.attempt > claim.maxAttempts) { finish('reconciliation_required', 'attempt_cap_after_takeover'); continue }
        const source = await this.sourceStatus(envelope)
        if (source !== 'valid') {
          if (source === 'degraded') defer('source_degraded', this.store.hasDeliveryAttempt(envelope.envelopeId), idempotent)
          else finish(this.store.hasDeliveryAttempt(envelope.envelopeId) ? 'reconciliation_required' : 'rejected', 'source_stale_or_forbidden')
          continue
        }
        // authority is rechecked after the initial asynchronous source wait.
        const authority = await this.authorityStatus(envelope)
        if (authority !== 'valid') {
          if (authority === 'degraded') defer('authority_unavailable', this.store.hasDeliveryAttempt(envelope.envelopeId), idempotent)
          else finish(this.store.hasDeliveryAttempt(envelope.envelopeId) ? 'reconciliation_required' : 'rejected', 'approval_invalid')
          continue
        }
        // source can change during the authority wait; this final observation is not cross-system atomicity.
        const finalSource = await this.sourceStatus(envelope)
        if (finalSource !== 'valid') {
          if (finalSource === 'degraded') defer('source_degraded', this.store.hasDeliveryAttempt(envelope.envelopeId), idempotent)
          else finish(this.store.hasDeliveryAttempt(envelope.envelopeId) ? 'reconciliation_required' : 'rejected', 'source_stale_or_forbidden')
          continue
        }
        // no asynchronous waits separate these local guards from delivery start.
        if (!this.store.owns(claim)) throw new StaleLeaseError('expired claim')
        envelope = this.ownedEnvelope(claim.envelopeId)
        verifyEnvelopeIntegrity(envelope)
        if (adapter.adapterId !== envelope.destination.adapterId || envelope.operation === 'publish' && this.checkSourceBinding().provider !== envelope.snapshot.ref.provider) {
          finish('reconciliation_required', 'port_binding_changed'); continue
        }
        if (!this.localApproval(envelope)) { finish(this.store.hasDeliveryAttempt(envelope.envelopeId) ? 'reconciliation_required' : 'rejected', 'approval_invalid'); continue }
        let result: DeliveryOutcome
        try {
          const context = immutable({ idempotencyKey: envelope.idempotencyKey, attempt: claim.attempt })
          this.store.markDeliveryStarted(claim)
          attemptedEnvelope = envelope
          result = envelope.operation === 'publish' ? await adapter.publish(envelope, context) : await adapter.retract(envelope, context)
        } catch { result = { status: 'ambiguous' } }
        actualReceipt = result.status === 'acknowledged' && receiptMatches(result.publication, envelope) ? publicationReceipt(result.publication) : null
        if (!this.store.owns(claim)) throw new StaleLeaseError('stale remote completion')
        // in-flight retirement/revocation cannot be rolled back by a local state change.
        const sourceAfter = await this.sourceStatus(envelope)
        const authorityAfter = await this.authorityStatus(envelope)
        // authority waits can age the source observation; remote authority can still change during this final wait.
        const finalSourceAfter = await this.sourceStatus(envelope)
        // these synchronous guards fence local completion, not distributed changes after the observations.
        if (!this.store.owns(claim)) throw new StaleLeaseError('stale postflight completion')
        envelope = this.ownedEnvelope(claim.envelopeId)
        verifyEnvelopeIntegrity(envelope)
        if (adapter.adapterId !== envelope.destination.adapterId || envelope.operation === 'publish' && this.checkSourceBinding().provider !== envelope.snapshot.ref.provider) {
          finish('reconciliation_required', 'port_binding_changed', actualReceipt); continue
        }
        const approvalAfter = this.localApproval(envelope)
        if (sourceAfter !== 'valid' || authorityAfter !== 'valid' || finalSourceAfter !== 'valid') {
          finish('reconciliation_required', 'source_or_authority_changed_inflight', actualReceipt); continue
        }
        if (!approvalAfter) { finish('reconciliation_required', 'approval_invalid', actualReceipt); continue }
        if (result.status === 'acknowledged') {
          if (!actualReceipt) finish('reconciliation_required', 'ack_binding_mismatch')
          else finish(envelope.operation === 'publish' ? 'acknowledged' : 'retract_acknowledged', null, actualReceipt)
        } else if (result.status === 'conflict') finish('conflict', 'destination_conflict')
        else if (result.status === 'rejected' || result.status === 'forbidden') finish(previouslyAttempted ? 'reconciliation_required' : 'rejected', result.status)
        else if (result.status === 'pending' || result.status === 'degraded') defer(result.status, true, idempotent)
        else finish('reconciliation_required', result.status)
      } catch (error) {
        if (error instanceof StaleLeaseError) staleLeases++
        else {
          // corrupt state and unknown failures are not evidence that a remote side effect is absent.
          try {
            if (attemptedEnvelope) {
              this.store.completeUncertainDelivery(claim, attemptedEnvelope, actualReceipt)
              completed.push({ envelopeId: claim.envelopeId, state: 'reconciliation_required' })
            } else finish('reconciliation_required', 'integrity_or_internal_failure')
          }
          catch (completionError) { if (completionError instanceof StaleLeaseError) staleLeases++; else throw completionError }
        }
      }
    }
    return immutable({ claimed, completed, staleLeases })
  }
}
