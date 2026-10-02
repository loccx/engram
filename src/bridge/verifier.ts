import { canonicalJson, identity, immutable, timestamp } from './policy.js'
import type { ApprovalVerdict, ApprovalVerifier, BridgeEnvelope, VerifiedApproval } from './types.js'

export const defaultDenyVerifier: ApprovalVerifier = Object.freeze({
  verifierId: 'default-deny',
  async verify(): Promise<ApprovalVerdict> { return { status: 'denied' } },
  async recheck(): Promise<ApprovalVerdict> { return { status: 'denied' } },
})

// a verdict is authoritative only through the injected trusted verifier boundary.
export function checkedApproval(verdict: ApprovalVerdict, verifier: ApprovalVerifier, envelope: BridgeEnvelope, now: number, original?: VerifiedApproval): VerifiedApproval | null {
  if (verdict.status !== 'verified') return null
  try {
    const a = verdict.approval
    if (a.verifierId !== verifier.verifierId || a.requester !== envelope.requester.principalId
      || a.bindingSha256 !== envelope.payloadSha256 || now >= timestamp(a.expiresAt)
      || !Array.isArray(a.allowedOperations) || !a.allowedOperations.includes(envelope.operation)
      || a.allowedOperations.some((op) => op !== 'publish' && op !== 'retract')) return null
    identity(a.grantId)
    identity(a.approver)
    if (original && canonicalJson(a) !== canonicalJson(original)) return null
    return immutable(JSON.parse(canonicalJson(a)) as VerifiedApproval)
  } catch { return null }
}
