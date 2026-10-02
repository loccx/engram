import { canonicalJson, sha256, verifyEnvelopeIntegrity } from '../../src/bridge/index.js'
import type { AbsenceOutcome, BridgeCoordinator, BridgeEnvelope, DeliveryContext, DeliveryOutcome, DestinationAdapter, DestinationCapabilities, DestinationRef, PublicationReceipt, PublishProposal, VisibilityOutcome } from '../../src/bridge/index.js'

type PublishEnvelope = BridgeEnvelope & { readonly operation: 'publish' }
type RetractEnvelope = BridgeEnvelope & { readonly operation: 'retract' }
export interface SinkRecord {
  readonly envelope: PublishEnvelope
  readonly publication: PublicationReceipt
}
export type ReaderResult =
  | { readonly status: 'found'; readonly record: SinkRecord }
  | { readonly status: 'empty' | 'forbidden' | 'degraded' | 'unsupported' | 'conflict' }
export interface BoundSinkReader {
  readonly destination: DestinationRef
  read(publication: PublicationReceipt): Promise<ReaderResult>
}
export interface DeliveryStep {
  // acceptance, reply, and reader projection are separate deterministic protocol events.
  readonly accept?: boolean
  readonly reply?: DeliveryOutcome['status']
  readonly project?: boolean
  readonly beforeAccept?: () => Promise<void>
  readonly afterAccept?: () => Promise<void>
}
const copy = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)
const address = (p: PublicationReceipt): string => canonicalJson([p.destination, p.publicationId, p.version])

// inert local protocol instrument, deliberately outside production exports. No client or IO.
export class DeterministicDestination implements DestinationAdapter {
  readonly adapterId: string
  readonly destination: DestinationRef
  readonly reader: BoundSinkReader
  caps: DestinationCapabilities = { publish: true, retract: true, readVisibility: true, readAbsence: true, idempotentPublish: true, idempotentRetract: true }
  readerAccess: 'available' | 'forbidden' | 'degraded' | 'unsupported' = 'available'
  readonly calls: { readonly operation: 'publish' | 'retract'; readonly key: string; readonly bytes: string; readonly attempt: number }[] = []
  readonly reads: { readonly destination: DestinationRef; readonly publication: PublicationReceipt; readonly status: ReaderResult['status'] }[] = []
  private readonly accepted = new Map<string, SinkRecord>()
  private readonly projected = new Map<string, SinkRecord>()
  private readonly history = new Map<string, SinkRecord>()
  private readonly tombstones = new Map<string, PublicationReceipt>()
  private readonly keys = new Map<string, { readonly bytes: string; readonly publication: PublicationReceipt }>()
  private readonly steps: Record<'publish' | 'retract', DeliveryStep[]> = { publish: [], retract: [] }

  constructor(destination: DestinationRef) {
    this.destination = freeze(copy(destination))
    this.adapterId = destination.adapterId
    this.reader = this.bindReader(this.destination)
  }
  async capabilities(): Promise<DestinationCapabilities> { return copy(this.caps) }
  script(operation: 'publish' | 'retract', ...steps: DeliveryStep[]): void { this.steps[operation].push(...steps) }
  acceptedPublications(): readonly SinkRecord[] { return freeze(copy([...this.accepted.values()])) }
  get idempotencyEntries(): number { return this.keys.size }
  bindReader(destination: DestinationRef): BoundSinkReader {
    // this binding represents host-supplied principal context, not request arguments.
    const bound = freeze(copy(destination))
    return Object.freeze({ destination: bound, read: async (publication: PublicationReceipt) => {
      let result: ReaderResult
      if (!same(bound, this.destination) || !same(publication.destination, bound)) result = { status: 'forbidden' }
      else if (this.readerAccess !== 'available') result = { status: this.readerAccess }
      else {
        const found = this.projected.get(address(publication))
        const known = this.history.get(address(publication))
        if (known && !same(known.publication, publication)) result = { status: 'conflict' }
        else result = found ? { status: 'found', record: found } : { status: 'empty' }
      }
      this.reads.push(freeze(copy({ destination: bound, publication, status: result.status })))
      return freeze(copy(result))
    } })
  }
  projectPublication(publication: PublicationReceipt): void {
    const record = this.accepted.get(address(publication))
    if (!record || !same(record.publication, publication)) throw new Error('no exact accepted publication')
    this.projected.set(address(publication), record)
  }
  projectRetraction(publication: PublicationReceipt): void {
    if (!same(this.tombstones.get(address(publication)) ?? null, publication)) throw new Error('no exact retraction')
    this.projected.delete(address(publication))
  }
  async publish(envelope: PublishEnvelope, context: DeliveryContext): Promise<DeliveryOutcome> { return this.deliver(envelope, context) }
  async retract(envelope: RetractEnvelope, context: DeliveryContext): Promise<DeliveryOutcome> { return this.deliver(envelope, context) }
  private async deliver(input: BridgeEnvelope, context: DeliveryContext): Promise<DeliveryOutcome> {
    const envelope = freeze(copy(input))
    const key = context.idempotencyKey
    this.calls.push(freeze({ operation: envelope.operation, key, bytes: envelope.payloadBytes, attempt: context.attempt }))
    const existing = this.keys.get(key)
    if (existing && existing.bytes !== envelope.payloadBytes) return { status: 'conflict' }
    try { verifyEnvelopeIntegrity(envelope) } catch { return { status: 'rejected' } }
    if (!same(envelope.destination, this.destination)) return { status: 'forbidden' }
    if (key !== envelope.idempotencyKey) return { status: 'rejected' }
    if (!(envelope.operation === 'publish' ? this.caps.publish : this.caps.retract)) return { status: 'unsupported' }
    const step = this.steps[envelope.operation].shift() ?? {}
    await step.beforeAccept?.()
    let publication = existing?.publication
    const accept = step.accept ?? (step.reply === undefined || step.reply === 'acknowledged' || step.reply === 'pending')
    if (!publication && accept) {
      if (envelope.operation === 'publish') {
        const { provider, namespace, sourceId } = envelope.snapshot.ref
        publication = freeze({ publicationId: `inert:${sha256(canonicalJson([provider, namespace, sourceId]))}`, version: envelope.envelopeId,
          payloadSha256: envelope.payloadSha256, destination: this.destination })
        const record = freeze({ envelope: envelope as PublishEnvelope, publication })
        this.accepted.set(address(publication), record)
        this.history.set(address(publication), record)
        if (step.project !== false) this.projected.set(address(publication), record)
      } else {
        publication = envelope.target.publication
        const known = this.history.get(address(publication))
        if (!known || !same(known.publication, publication) || known.envelope.envelopeId !== envelope.target.envelopeId
          || !same(known.envelope.snapshot.ref, envelope.target.sourceRef)) return { status: 'conflict' }
        this.accepted.delete(address(publication))
        this.tombstones.set(address(publication), publication)
        if (step.project !== false) this.projected.delete(address(publication))
      }
      this.keys.set(key, freeze({ bytes: envelope.payloadBytes, publication }))
    }
    await step.afterAccept?.()
    const reply = step.reply ?? 'acknowledged'
    if (reply !== 'acknowledged') return { status: reply }
    return publication ? { status: 'acknowledged', publication } : { status: 'ambiguous' }
  }
  async verifyVisibility(publication: PublicationReceipt): Promise<VisibilityOutcome> {
    if (!this.caps.readVisibility) return { status: 'unsupported' }
    const result = await this.reader.read(publication)
    if (result.status !== 'found') return { status: result.status }
    // proof is derived from retrieved bytes, never from a supplied receipt or local outbox state.
    const { record } = result
    try { verifyEnvelopeIntegrity(record.envelope) } catch { return { status: 'conflict' } }
    return same(record.publication, publication) && record.envelope.payloadSha256 === publication.payloadSha256
      ? { status: 'visible', publication: record.publication } : { status: 'conflict' }
  }
  async verifyAbsence(publication: PublicationReceipt): Promise<AbsenceOutcome> {
    if (!this.caps.readAbsence) return { status: 'unsupported' }
    const result = await this.reader.read(publication)
    if (result.status === 'found') return { status: 'present' }
    if (result.status !== 'empty') return { status: result.status }
    const tombstone = this.tombstones.get(address(publication))
    // an empty delayed publication or a made-up receipt is not verified cleanup.
    return tombstone && same(tombstone, publication) ? { status: 'absent', publication: tombstone } : { status: 'pending' }
  }
}

export type ConformanceStage = 'publish-acknowledged' | 'publish-observed' | 'retract-acknowledged' | 'retract-observed'
export interface DestinationConformanceInput {
  readonly coordinator: BridgeCoordinator
  readonly adapter: DestinationAdapter
  readonly proposal: PublishProposal
  // explicit inert authority injection; this helper does not mint or trust human authority.
  readonly grant: (envelope: BridgeEnvelope) => string | Promise<string>
  readonly script?: (stage: ConformanceStage, envelope: BridgeEnvelope) => void | Promise<void>
}
// reusable driver uses only public coordinator calls, not low-level completion or gold states.
export async function exerciseDestinationConformance(input: DestinationConformanceInput) {
  const { coordinator, adapter } = input
  const envelope = await coordinator.proposePublish(input.proposal)
  await coordinator.approve(envelope.envelopeId, await input.grant(envelope))
  coordinator.enqueue(envelope.envelopeId)
  const publishDrain = await coordinator.drain(adapter, { owner: 'inert-conformance' })
  await input.script?.('publish-acknowledged', envelope)
  const visibility = await coordinator.verifyVisibility(envelope.envelopeId, adapter)
  await input.script?.('publish-observed', envelope)
  const retraction = coordinator.proposeRetraction({ targetEnvelopeId: envelope.envelopeId, reason: 'inert conformance cleanup',
    purpose: input.proposal.purpose, policyId: input.proposal.policyId, policyVersion: input.proposal.policyVersion })
  await coordinator.approve(retraction.envelopeId, await input.grant(retraction))
  coordinator.enqueue(retraction.envelopeId)
  const retractDrain = await coordinator.drain(adapter, { owner: 'inert-conformance' })
  await input.script?.('retract-acknowledged', retraction)
  const absence = await coordinator.verifyRetraction(retraction.envelopeId, adapter)
  await input.script?.('retract-observed', retraction)
  return { envelope, retraction, publishDrain, retractDrain, visibility, absence }
}
