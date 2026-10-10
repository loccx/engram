import { canonicalJson } from './policy.js'
import type { BridgeCoordinator, DrainResult } from './outbox.js'
import type { BridgeStore } from './store.js'
import type {
  BridgeEnvelope,
  DestinationAdapter,
  DestinationCapabilities,
  PublishProposal,
} from './types.js'

/**
 * destination adapter conformance: a host runs these cases against its adapter and
 * gets a report, so the contract is checked without reading this repository's tests.
 * cases are framework-agnostic; `run` throws on violation.
 */
export interface DestinationConformanceHarness {
  readonly coordinator: BridgeCoordinator
  readonly store: BridgeStore
  readonly adapter: DestinationAdapter
  /** a publish proposal whose destination is the one the adapter is bound to */
  readonly proposal: PublishProposal
  /** the host's inert authority injection for conformance runs */
  readonly grant: (envelope: BridgeEnvelope) => string | Promise<string>
}

export interface DestinationConformanceCase {
  readonly name: string
  /** false when the adapter's declared capabilities make the case inapplicable */
  applicable(capabilities: DestinationCapabilities): boolean
  /** throws with a precise message when the adapter breaks the contract */
  run(): Promise<void>
}

export type ConformanceStatus = 'passed' | 'failed' | 'skipped'
export interface ConformanceResult {
  readonly name: string
  readonly status: ConformanceStatus
  readonly detail: string
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function proposeApproveEnqueue(harness: DestinationConformanceHarness): Promise<BridgeEnvelope> {
  const envelope = await harness.coordinator.proposePublish(harness.proposal)
  await harness.coordinator.approve(envelope.envelopeId, await harness.grant(envelope))
  harness.coordinator.enqueue(envelope.envelopeId)
  return envelope
}

function completedState(drain: DrainResult, envelopeId: string): string {
  const entry = drain.completed.find((candidate) => candidate.envelopeId === envelopeId)
  assert(entry, `the coordinator did not complete ${envelopeId}`)
  return entry.state
}

export function destinationConformanceCases(
  create: () => Promise<DestinationConformanceHarness>
): readonly DestinationConformanceCase[] {
  return [
    {
      name: 'publish is acknowledged with a receipt bound to the envelope',
      applicable: (capabilities) => capabilities.publish,
      async run() {
        const harness = await create()
        const envelope = await proposeApproveEnqueue(harness)
        const drain = await harness.coordinator.drain(harness.adapter, { owner: 'conformance' })
        const state = completedState(drain, envelope.envelopeId)
        assert(state === 'acknowledged', `expected acknowledged, saw ${state}`)
        const receipt = harness.store.getPublication(envelope.envelopeId)
        assert(receipt, 'no publication receipt was recorded')
        assert(
          same(receipt.destination, envelope.destination),
          `receipt destination ${canonicalJson(receipt.destination)} does not match the envelope`
        )
        assert(receipt.payloadSha256 === envelope.payloadSha256, 'receipt payload hash does not match the envelope')
      },
    },
    {
      name: 'a declared-idempotent publish replays to the identical receipt',
      applicable: (capabilities) => capabilities.publish && capabilities.idempotentPublish,
      async run() {
        const harness = await create()
        const envelope = await harness.coordinator.proposePublish(harness.proposal)
        assert(envelope.operation === 'publish', 'a publish proposal produced a non-publish envelope')
        const context = { idempotencyKey: envelope.idempotencyKey, attempt: 1 }
        const first = await harness.adapter.publish(envelope, context)
        const second = await harness.adapter.publish(envelope, context)
        assert(
          first.status === 'acknowledged' && second.status === 'acknowledged',
          `expected two acknowledgements, saw ${first.status}/${second.status}`
        )
        assert(same(first.publication, second.publication), 'a replayed delivery returned a different receipt')
      },
    },
    {
      name: 'an envelope addressed to another destination is refused',
      applicable: (capabilities) => capabilities.publish,
      async run() {
        const harness = await create()
        const foreign: PublishProposal = {
          ...harness.proposal,
          destination: {
            ...harness.proposal.destination,
            adapterId: `${harness.proposal.destination.adapterId}-foreign`,
          },
        }
        const envelope = await harness.coordinator.proposePublish(foreign)
        assert(envelope.operation === 'publish', 'a publish proposal produced a non-publish envelope')
        const outcome = await harness.adapter.publish(envelope, {
          idempotencyKey: envelope.idempotencyKey,
          attempt: 1,
        })
        assert(
          outcome.status === 'forbidden' || outcome.status === 'rejected',
          `expected forbidden or rejected for a foreign destination, saw ${outcome.status}`
        )
      },
    },
    {
      name: 'the adapter does not mutate the envelope it is given',
      applicable: (capabilities) => capabilities.publish,
      async run() {
        const harness = await create()
        const envelope = await harness.coordinator.proposePublish(harness.proposal)
        assert(envelope.operation === 'publish', 'a publish proposal produced a non-publish envelope')
        const before = canonicalJson(envelope)
        await harness.adapter.publish(envelope, { idempotencyKey: envelope.idempotencyKey, attempt: 1 })
        assert(canonicalJson(envelope) === before, 'the adapter mutated the envelope')
      },
    },
    {
      name: 'visibility is proven from the destination, never assumed',
      applicable: (capabilities) => capabilities.publish,
      async run() {
        const harness = await create()
        const capabilities = await harness.adapter.capabilities()
        const envelope = await proposeApproveEnqueue(harness)
        await harness.coordinator.drain(harness.adapter, { owner: 'conformance' })
        const outcome = await harness.coordinator.verifyVisibility(envelope.envelopeId, harness.adapter)
        if (!capabilities.readVisibility) {
          assert(outcome.status === 'unsupported', `declared readVisibility=false but saw ${outcome.status}`)
          return
        }
        assert(outcome.status === 'visible', `expected visible, saw ${outcome.status}`)
        const receipt = harness.store.getPublication(envelope.envelopeId)
        assert(
          receipt && same(outcome.publication, receipt),
          'visibility was not proven for the exact acknowledged receipt'
        )
      },
    },
    {
      name: 'a retraction is acknowledged and absence is proven',
      applicable: (capabilities) => capabilities.publish && capabilities.retract,
      async run() {
        const harness = await create()
        const capabilities = await harness.adapter.capabilities()
        const envelope = await proposeApproveEnqueue(harness)
        await harness.coordinator.drain(harness.adapter, { owner: 'conformance' })
        const retraction = harness.coordinator.proposeRetraction({
          targetEnvelopeId: envelope.envelopeId,
          reason: 'conformance cleanup',
          purpose: harness.proposal.purpose,
          policyId: harness.proposal.policyId,
          policyVersion: harness.proposal.policyVersion,
        })
        await harness.coordinator.approve(retraction.envelopeId, await harness.grant(retraction))
        harness.coordinator.enqueue(retraction.envelopeId)
        const drain = await harness.coordinator.drain(harness.adapter, { owner: 'conformance' })
        const state = completedState(drain, retraction.envelopeId)
        assert(state === 'retract_acknowledged', `expected retract_acknowledged, saw ${state}`)
        const outcome = await harness.coordinator.verifyRetraction(retraction.envelopeId, harness.adapter)
        if (!capabilities.readAbsence) {
          assert(outcome.status === 'unsupported', `declared readAbsence=false but saw ${outcome.status}`)
          return
        }
        assert(outcome.status === 'absent', `expected absent, saw ${outcome.status}`)
      },
    },
    {
      name: 'declared capabilities are stable across calls',
      applicable: () => true,
      async run() {
        const harness = await create()
        const first = await harness.adapter.capabilities()
        const second = await harness.adapter.capabilities()
        assert(same(first, second), 'capabilities changed between calls')
      },
    },
  ]
}

/** run every applicable case and report; the caller decides what a failure means */
export async function runDestinationConformance(
  create: () => Promise<DestinationConformanceHarness>
): Promise<readonly ConformanceResult[]> {
  const results: ConformanceResult[] = []
  for (const testCase of destinationConformanceCases(create)) {
    let capabilities: DestinationCapabilities
    try {
      capabilities = await (await create()).adapter.capabilities()
    } catch (error) {
      results.push({ name: testCase.name, status: 'failed', detail: `capabilities failed: ${message(error)}` })
      continue
    }
    if (!testCase.applicable(capabilities)) {
      results.push({ name: testCase.name, status: 'skipped', detail: 'not applicable to the declared capabilities' })
      continue
    }
    try {
      await testCase.run()
      results.push({ name: testCase.name, status: 'passed', detail: '' })
    } catch (error) {
      results.push({ name: testCase.name, status: 'failed', detail: message(error) })
    }
  }
  return results
}
