import type Database from 'better-sqlite3'
import { BridgeError, StaleLeaseError, assertTransition, canonicalJson, defaultBridgeRuntime, identity, immutable, publicationReceipt, receiptMatches, sealEnvelope, timestamp, verifyEnvelopeIntegrity } from './policy.js'
import type { AbsenceOutcome, BridgeEnvelope, BridgeEvent, BridgePayload, BridgeRuntime, DestinationAdapter, OutboxClaim, OutboxRow, OutboxState, PublicationReceipt, StoredApproval, VerifiedApproval, VisibilityOutcome } from './types.js'

type QueueRecord = {
  envelope_id: string; state: OutboxState; attempt: number; max_attempts: number; lease_owner: string | null
  lease_token: string | null; lease_generation: number; lease_expires_at: number | null; next_attempt_at: number; last_error: string | null
}
export type DeliveryCompletion = Exclude<OutboxState, 'sending' | 'visible' | 'retracted_verified'>
function queueRow(row: QueueRecord): OutboxRow {
  return immutable({ envelopeId: row.envelope_id, state: row.state, attempt: row.attempt, maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner, leaseToken: row.lease_token, leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at, nextAttemptAt: row.next_attempt_at, lastError: row.last_error })
}

export class BridgeStore {
  constructor(private readonly db: Database.Database, readonly runtime: BridgeRuntime = defaultBridgeRuntime) {}

  private event(id: string, type: string, detail: unknown = {}): void {
    this.db.prepare('INSERT INTO bridge_events(envelope_id, event_type, created_at, detail_json) VALUES (?, ?, ?, ?)')
      .run(id, type, this.runtime.now(), canonicalJson(detail))
  }
  getEnvelope(id: string): BridgeEnvelope | null {
    const row = this.db.prepare('SELECT * FROM bridge_envelopes WHERE envelope_id = ?').get(id) as {
      envelope_id: string; schema_version: string; operation: string; payload_bytes: string; payload_sha256: string
      idempotency_key: string; target_envelope_id: string | null; supersedes_envelope_id: string | null; created_at: number
    } | undefined
    if (!row) return null
    const sealed = sealEnvelope(JSON.parse(row.payload_bytes) as BridgePayload)
    if (sealed.envelopeId !== row.envelope_id || sealed.schemaVersion !== row.schema_version || sealed.operation !== row.operation
      || sealed.createdAt !== row.created_at || sealed.payloadBytes !== row.payload_bytes || sealed.payloadSha256 !== row.payload_sha256
      || sealed.idempotencyKey !== row.idempotency_key
      || (sealed.operation === 'retract' ? sealed.target.envelopeId : null) !== row.target_envelope_id
      || (sealed.operation === 'publish' ? sealed.supersedesEnvelopeId : null) !== row.supersedes_envelope_id) throw new BridgeError('persisted envelope integrity mismatch')
    return sealed
  }
  insertProposal(envelope: BridgeEnvelope): BridgeEnvelope {
    verifyEnvelopeIntegrity(envelope)
    this.db.transaction(() => {
      if (envelope.operation === 'publish' && envelope.supersedesEnvelopeId) {
        const prior = this.getEnvelope(envelope.supersedesEnvelopeId)
        if (!prior || prior.operation !== 'publish' || prior.requester.principalId !== envelope.requester.principalId
          || canonicalJson(prior.destination) !== canonicalJson(envelope.destination)) throw new BridgeError('invalid supersession target')
      }
      if (envelope.operation === 'retract') {
        const target = this.getEnvelope(envelope.target.envelopeId)
        const receipt = this.getPublication(envelope.target.envelopeId)
        if (!target || target.operation !== 'publish' || !receipt || !receiptMatches(receipt, target)
          || canonicalJson(receipt) !== canonicalJson(envelope.target.publication)
          || canonicalJson(target.snapshot.ref) !== canonicalJson(envelope.target.sourceRef)) throw new BridgeError('invalid retraction target')
        const duplicate = this.db.prepare(`SELECT 1 FROM bridge_envelopes e WHERE e.target_envelope_id = ?
          AND NOT EXISTS (SELECT 1 FROM bridge_events c WHERE c.envelope_id = e.envelope_id AND c.event_type = 'proposal_cancelled')`).get(target.envelopeId)
        if (duplicate) throw new BridgeError('retraction already proposed')
      }
      this.db.prepare(`INSERT INTO bridge_envelopes(envelope_id, schema_version, operation, payload_bytes, payload_sha256, idempotency_key, target_envelope_id, supersedes_envelope_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(envelope.envelopeId, envelope.schemaVersion, envelope.operation, envelope.payloadBytes,
        envelope.payloadSha256, envelope.idempotencyKey, envelope.operation === 'retract' ? envelope.target.envelopeId : null,
        envelope.operation === 'publish' ? envelope.supersedesEnvelopeId : null, envelope.createdAt)
      this.event(envelope.envelopeId, 'proposed', { payloadSha256: envelope.payloadSha256 })
      if (envelope.operation === 'publish' && envelope.supersedesEnvelopeId) this.event(envelope.envelopeId, 'supersedes', { envelopeId: envelope.supersedesEnvelopeId })
    }).immediate()
    return this.getEnvelope(envelope.envelopeId)!
  }
  private proposalCancelled(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM bridge_events WHERE envelope_id = ? AND event_type = 'proposal_cancelled'").get(id)
  }
  cancelProposal(id: string): void {
    this.db.transaction(() => {
      if (!this.getEnvelope(id)) throw new BridgeError('proposal unavailable')
      const row = this.getOutbox(id)
      if (this.hasDeliveryAttempt(id) || row && !['cancelled', 'rejected', 'dead'].includes(row.state)) throw new BridgeError('proposal is active or attempted')
      if (this.proposalCancelled(id)) return
      this.event(id, 'proposal_cancelled')
    }).immediate()
  }
  getApproval(id: string): StoredApproval | null {
    const row = this.db.prepare('SELECT opaque_grant, approval_json FROM bridge_approvals WHERE envelope_id = ?').get(id) as { opaque_grant: string; approval_json: string } | undefined
    if (!row) return null
    const revoked = !!this.db.prepare("SELECT 1 FROM bridge_approval_events WHERE envelope_id = ? AND event_type = 'revoked'").get(id)
    return immutable({ opaqueGrant: row.opaque_grant, approval: JSON.parse(row.approval_json) as VerifiedApproval, revoked })
  }
  // verification is performed by the coordinator; local storage never mints authority.
  saveApproval(id: string, opaqueGrant: string, approval: VerifiedApproval): void {
    this.db.transaction(() => {
      const envelope = this.getEnvelope(id)
      if (this.proposalCancelled(id)) throw new BridgeError('proposal cancelled')
      if (!envelope || approval.bindingSha256 !== envelope.payloadSha256 || approval.requester !== envelope.requester.principalId
        || this.runtime.now() >= approval.expiresAt || !approval.allowedOperations.includes(envelope.operation)) throw new BridgeError('approval binding invalid')
      identity(opaqueGrant)
      identity(approval.approver)
      const current = this.getApproval(id)
      if (current) {
        if (!current.revoked && current.opaqueGrant === opaqueGrant && canonicalJson(current.approval) === canonicalJson(approval)) return
        throw new BridgeError('approval is immutable')
      }
      this.db.prepare('INSERT INTO bridge_approvals(envelope_id, opaque_grant, approval_json, created_at) VALUES (?, ?, ?, ?)')
        .run(id, opaqueGrant, canonicalJson(approval), this.runtime.now())
      this.db.prepare("INSERT INTO bridge_approval_events(envelope_id, event_type, created_at) VALUES (?, 'granted', ?)").run(id, this.runtime.now())
      this.event(id, 'approved', { verifierId: approval.verifierId, grantId: approval.grantId, approver: approval.approver })
    }).immediate()
  }
  revokeApproval(id: string): void {
    this.db.transaction(() => {
      const approval = this.getApproval(id)
      if (!approval) throw new BridgeError('no approval')
      if (approval.revoked) return
      this.db.prepare("INSERT INTO bridge_approval_events(envelope_id, event_type, created_at) VALUES (?, 'revoked', ?)").run(id, this.runtime.now())
      this.event(id, 'approval_revoked')
      const row = this.getOutbox(id)
      if (row?.state === 'queued') {
        const state = this.hasDeliveryAttempt(id) ? 'reconciliation_required' : 'cancelled'
        assertTransition(row.state, state)
        this.db.prepare("UPDATE bridge_outbox SET state = ?, updated_at = ?, last_error = 'approval_revoked' WHERE envelope_id = ? AND state = 'queued'").run(state, this.runtime.now(), id)
        this.event(id, state, { reason: 'approval_revoked' })
      }
    }).immediate()
  }
  enqueue(id: string, maxAttempts = 5): OutboxRow {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new BridgeError('invalid attempt cap')
    return this.db.transaction(() => {
      const envelope = this.getEnvelope(id)
      if (this.proposalCancelled(id)) throw new BridgeError('proposal cancelled')
      const a = this.getApproval(id)
      if (!envelope || !a || a.revoked || this.runtime.now() >= a.approval.expiresAt
        || a.approval.bindingSha256 !== envelope.payloadSha256 || !a.approval.allowedOperations.includes(envelope.operation)) throw new BridgeError('approval required')
      const current = this.getOutbox(id)
      if (current) return current
      this.db.prepare(`INSERT INTO bridge_outbox(envelope_id, state, max_attempts, next_attempt_at, updated_at)
        VALUES (?, 'queued', ?, ?, ?)`).run(id, maxAttempts, this.runtime.now(), this.runtime.now())
      this.event(id, envelope.operation === 'retract' ? 'retract_queued' : 'queued')
      return this.getOutbox(id)!
    }).immediate()
  }
  getOutbox(id: string): OutboxRow | null {
    const row = this.db.prepare('SELECT * FROM bridge_outbox WHERE envelope_id = ?').get(id) as QueueRecord | undefined
    return row ? queueRow(row) : null
  }
  claim(owner: string, leaseMs: number, adapterId: string, requester: string): OutboxClaim | null {
    identity(owner)
    identity(adapterId)
    identity(requester)
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new BridgeError('invalid lease duration')
    return this.db.transaction(() => {
      const now = timestamp(this.runtime.now())
      const token = identity(this.runtime.newId())
      const row = this.db.prepare(`UPDATE bridge_outbox SET state = 'sending', attempt = attempt + 1,
        lease_owner = ?, lease_token = ?, lease_generation = lease_generation + 1, lease_expires_at = ?, updated_at = ?
        WHERE envelope_id = (SELECT q.envelope_id FROM bridge_outbox q JOIN bridge_envelopes e ON e.envelope_id = q.envelope_id
          WHERE ((q.state = 'queued' AND q.next_attempt_at <= ?) OR (q.state = 'sending' AND q.lease_expires_at <= ?))
          AND json_extract(e.payload_bytes, '$.destination.adapterId') = ? AND json_extract(e.payload_bytes, '$.requester.principalId') = ?
          ORDER BY q.next_attempt_at, e.created_at, q.envelope_id LIMIT 1)
        RETURNING *`).get(owner, token, timestamp(now + leaseMs), now, now, now, adapterId, requester) as QueueRecord | undefined
      if (!row) return null
      this.event(row.envelope_id, 'sending', { attempt: row.attempt, generation: row.lease_generation })
      return queueRow(row) as OutboxClaim
    }).immediate()
  }
  owns(claim: OutboxClaim): boolean {
    return !!this.db.prepare(`SELECT 1 FROM bridge_outbox WHERE envelope_id = ? AND state = 'sending'
      AND lease_owner = ? AND lease_token = ? AND lease_generation = ? AND lease_expires_at > ?`)
      .get(claim.envelopeId, claim.leaseOwner, claim.leaseToken, claim.leaseGeneration, this.runtime.now())
  }
  hasDeliveryAttempt(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM bridge_events WHERE envelope_id = ? AND event_type = 'delivery_started'").get(id)
  }
  markDeliveryStarted(claim: OutboxClaim): void {
    this.db.transaction(() => {
      if (!this.owns(claim)) throw new StaleLeaseError('stale delivery start')
      this.event(claim.envelopeId, 'delivery_started', { generation: claim.leaseGeneration, attempt: claim.attempt })
    }).immediate()
  }
  complete(claim: OutboxClaim, state: DeliveryCompletion, reason: string | null = null, receipt: PublicationReceipt | null = null, nextAttemptAt = this.runtime.now()): void {
    assertTransition('sending', state)
    if (state === 'queued' && claim.attempt >= claim.maxAttempts) throw new BridgeError('attempt cap reached')
    this.db.transaction(() => {
      const envelope = receipt || state === 'acknowledged' || state === 'retract_acknowledged' ? this.getEnvelope(claim.envelopeId) : null
      if (receipt && (!envelope || !receiptMatches(receipt, envelope) || !['acknowledged', 'retract_acknowledged', 'reconciliation_required'].includes(state))) throw new BridgeError('invalid delivery receipt')
      if ((state === 'acknowledged' || state === 'retract_acknowledged') && (!envelope || !receipt || !receiptMatches(receipt, envelope)
        || (envelope.operation === 'publish' ? state !== 'acknowledged' : state !== 'retract_acknowledged'))) throw new BridgeError('invalid acknowledgement')
      const result = this.db.prepare(`UPDATE bridge_outbox SET state = ?, next_attempt_at = ?, last_error = ?, receipt_json = ?,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE envelope_id = ? AND state = 'sending' AND lease_owner = ? AND lease_token = ? AND lease_generation = ? AND lease_expires_at > ?`)
        .run(state, timestamp(nextAttemptAt), reason, receipt ? canonicalJson(publicationReceipt(receipt)) : null, this.runtime.now(),
          claim.envelopeId, claim.leaseOwner, claim.leaseToken, claim.leaseGeneration, this.runtime.now())
      if (result.changes !== 1) throw new StaleLeaseError('stale lease completion')
      this.event(claim.envelopeId, state, { reason, receipt })
    }).immediate()
  }
  // uncertain evidence uses the verified attempted bytes, never a repaired or trusted corrupt row.
  completeUncertainDelivery(claim: OutboxClaim, attempted: BridgeEnvelope, receipt: PublicationReceipt | null = null): void {
    verifyEnvelopeIntegrity(attempted)
    if (attempted.envelopeId !== claim.envelopeId || receipt && !receiptMatches(receipt, attempted)) throw new BridgeError('invalid attempted delivery evidence')
    this.db.transaction(() => {
      const started = this.db.prepare(`SELECT 1 FROM bridge_events WHERE envelope_id = ? AND event_type = 'delivery_started'
        AND json_extract(detail_json, '$.generation') = ? AND json_extract(detail_json, '$.attempt') = ?`)
        .get(claim.envelopeId, claim.leaseGeneration, claim.attempt)
      if (!started) throw new BridgeError('no matching delivery start')
      const result = this.db.prepare(`UPDATE bridge_outbox SET state = 'reconciliation_required', last_error = 'integrity_or_internal_failure',
        receipt_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE envelope_id = ? AND state = 'sending' AND lease_owner = ? AND lease_token = ? AND lease_generation = ? AND lease_expires_at > ?`)
        .run(receipt ? canonicalJson(publicationReceipt(receipt)) : null, this.runtime.now(), claim.envelopeId,
          claim.leaseOwner, claim.leaseToken, claim.leaseGeneration, this.runtime.now())
      if (result.changes !== 1) throw new StaleLeaseError('stale uncertain completion')
      this.event(claim.envelopeId, 'reconciliation_required', { reason: 'integrity_or_internal_failure', receipt,
        evidence: 'verified_attempted_envelope', attemptedPayloadSha256: attempted.payloadSha256, attemptedPayloadBytes: attempted.payloadBytes })
    }).immediate()
  }
  getPublication(id: string): PublicationReceipt | null {
    const row = this.db.prepare('SELECT receipt_json FROM bridge_outbox WHERE envelope_id = ?').get(id) as { receipt_json: string | null } | undefined
    return row?.receipt_json ? publicationReceipt(JSON.parse(row.receipt_json)) : null
  }
  events(id: string): readonly BridgeEvent[] {
    const rows = this.db.prepare('SELECT * FROM bridge_events WHERE envelope_id = ? ORDER BY sequence').all(id) as Array<{
      sequence: number; envelope_id: string; event_type: string; created_at: number; detail_json: string
    }>
    return immutable(rows.map((r) => ({ sequence: r.sequence, envelopeId: r.envelope_id, type: r.event_type, at: r.created_at, detail: r.detail_json })))
  }
  private observe(id: string, from: OutboxState, to: OutboxState | null, detail: unknown, receipt: PublicationReceipt): void {
    this.db.transaction(() => {
      const row = this.getOutbox(id)
      if (row?.state !== from || canonicalJson(this.getPublication(id)) !== canonicalJson(receipt)) throw new BridgeError('observation raced with state change')
      if (to && from !== to) {
        assertTransition(from, to)
        this.db.prepare('UPDATE bridge_outbox SET state = ?, updated_at = ? WHERE envelope_id = ? AND state = ?').run(to, this.runtime.now(), id, from)
      }
      this.event(id, to ?? 'reader_observation', detail)
    }).immediate()
  }
  async verifyVisibility(id: string, adapter: DestinationAdapter): Promise<VisibilityOutcome> {
    const envelope = this.getEnvelope(id)
    const row = this.getOutbox(id)
    const receipt = this.getPublication(id)
    if (!envelope || envelope.operation !== 'publish' || !row || !['acknowledged', 'visible'].includes(row.state)
      || !receipt || !receiptMatches(receipt, envelope) || adapter.adapterId !== envelope.destination.adapterId) throw new BridgeError('no readable publication')
    let result: VisibilityOutcome
    try { result = (await adapter.capabilities()).readVisibility === true ? await adapter.verifyVisibility(receipt) : { status: 'unsupported' } }
    catch { result = { status: 'degraded' } }
    const matched = result.status === 'visible' && canonicalJson(result.publication) === canonicalJson(receipt)
    const conflict = result.status === 'visible' && !matched || result.status === 'conflict'
    this.observe(id, row.state, matched ? 'visible' : conflict || result.status === 'unsupported' || row.state === 'visible' ? 'reconciliation_required' : null, result, receipt)
    return immutable(conflict ? { status: 'conflict' } : result)
  }
  async verifyRetraction(id: string, adapter: DestinationAdapter): Promise<AbsenceOutcome> {
    const envelope = this.getEnvelope(id)
    const row = this.getOutbox(id)
    const receipt = this.getPublication(id)
    if (!envelope || envelope.operation !== 'retract' || !row || !['retract_acknowledged', 'retracted_verified'].includes(row.state)
      || !receipt || !receiptMatches(receipt, envelope) || adapter.adapterId !== envelope.destination.adapterId) throw new BridgeError('no acknowledged retraction')
    let result: AbsenceOutcome
    try { result = (await adapter.capabilities()).readAbsence === true ? await adapter.verifyAbsence(receipt) : { status: 'unsupported' } }
    catch { result = { status: 'degraded' } }
    const matched = result.status === 'absent' && canonicalJson(result.publication) === canonicalJson(receipt)
    const conflict = result.status === 'absent' && !matched || result.status === 'conflict'
    this.observe(id, row.state, matched ? 'retracted_verified' : conflict || result.status === 'unsupported' || row.state === 'retracted_verified' ? 'reconciliation_required' : null, result, receipt)
    return immutable(conflict ? { status: 'conflict' } : result)
  }
}
