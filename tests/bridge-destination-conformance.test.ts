import { describe, it, expect } from 'vitest'
import { destinationConformanceCases, runDestinationConformance } from '../src/bridge/conformance.js'
import type { DestinationConformanceHarness } from '../src/bridge/conformance.js'
import type { DestinationAdapter } from '../src/bridge/index.js'
import { fixtureBridge, fixtureDestination, fixtureLocator } from './fixtures/bridge-core-ports.js'
import { DeterministicDestination } from './fixtures/bridge-destination.js'

const proposal = {
  source: fixtureLocator,
  destination: fixtureDestination,
  purpose: 'destination-conformance',
  policyId: 'fixture-policy',
  policyVersion: 'v1',
}

/** one fresh coordinator, store and adapter per case: no state carries between checks */
function harness(adapter?: (bound: DestinationAdapter) => DestinationAdapter) {
  return async (): Promise<DestinationConformanceHarness> => {
    const fixture = fixtureBridge()
    const bound: DestinationAdapter = new DeterministicDestination(fixtureDestination)
    return {
      coordinator: fixture.coordinator,
      store: fixture.store,
      adapter: adapter ? adapter(bound) : bound,
      proposal,
      grant: (envelope) => fixture.authority.issue(envelope),
    }
  }
}

/** spreading a class instance drops prototype methods; bind them explicitly */
function decorate(bound: DestinationAdapter, overrides: Partial<DestinationAdapter>): DestinationAdapter {
  return {
    adapterId: bound.adapterId,
    capabilities: bound.capabilities.bind(bound),
    publish: bound.publish.bind(bound),
    retract: bound.retract.bind(bound),
    verifyVisibility: bound.verifyVisibility.bind(bound),
    verifyAbsence: bound.verifyAbsence.bind(bound),
    ...overrides,
  }
}

async function runCase(name: string, create: () => Promise<DestinationConformanceHarness>) {
  const testCase = destinationConformanceCases(create).find((candidate) => candidate.name === name)
  if (!testCase) throw new Error(`no case named ${name}`)
  await testCase.run()
}

describe('destination adapter conformance', () => {
  it('passes every case against the conformant destination fixture', async () => {
    const results = await runDestinationConformance(harness())
    expect(results.map((result) => `${result.status}:${result.name}`)).toEqual([
      'passed:publish is acknowledged with a receipt bound to the envelope',
      'passed:a declared-idempotent publish replays to the identical receipt',
      'passed:an envelope addressed to another destination is refused',
      'passed:the adapter does not mutate the envelope it is given',
      'passed:visibility is proven from the destination, never assumed',
      'passed:a retraction is acknowledged and absence is proven',
      'passed:declared capabilities are stable across calls',
    ])
  })

  it('skips the cases a destination declares inapplicable', async () => {
    const results = await runDestinationConformance(
      harness((bound) =>
        decorate(bound, { capabilities: async () => ({ ...(await bound.capabilities()), publish: false }) })
      )
    )
    const skipped = results.filter((result) => result.status === 'skipped').map((result) => result.name)
    expect(skipped).toEqual([
      'publish is acknowledged with a receipt bound to the envelope',
      'a declared-idempotent publish replays to the identical receipt',
      'an envelope addressed to another destination is refused',
      'the adapter does not mutate the envelope it is given',
      'visibility is proven from the destination, never assumed',
      'a retraction is acknowledged and absence is proven',
    ])
    expect(results.filter((result) => result.status === 'failed')).toEqual([])
    expect(results.filter((result) => result.status === 'passed').map((result) => result.name)).toEqual([
      'declared capabilities are stable across calls',
    ])
  })

  it('fails a non-idempotent adapter that declares idempotent publish', async () => {
    let serial = 0
    const create = harness((bound) =>
      decorate(bound, {
        publish: async (envelope, context) => {
          const outcome = await bound.publish(envelope, context)
          if (outcome.status !== 'acknowledged') return outcome
          return {
            status: 'acknowledged',
            publication: { ...outcome.publication, publicationId: `replay-${++serial}` },
          }
        },
      })
    )
    await expect(runCase('a declared-idempotent publish replays to the identical receipt', create)).rejects.toThrow(
      /different receipt/
    )
  })

  it('fails an adapter that accepts an envelope for a foreign destination', async () => {
    const create = harness((bound) =>
      decorate(bound, {
        publish: async (envelope) => ({
          status: 'acknowledged',
          publication: {
            publicationId: 'accepted-foreign',
            version: envelope.envelopeId,
            payloadSha256: envelope.payloadSha256,
            destination: envelope.destination,
          },
        }),
      })
    )
    await expect(runCase('an envelope addressed to another destination is refused', create)).rejects.toThrow(
      /forbidden or rejected/
    )
  })

  it('fails an adapter that mutates the envelope', async () => {
    const create = harness((bound) =>
      decorate(bound, {
        publish: async (envelope, context) => {
          ;(envelope as { purpose: string }).purpose = 'mutated'
          return bound.publish(envelope, context)
        },
      })
    )
    await expect(runCase('the adapter does not mutate the envelope it is given', create)).rejects.toThrow()
  })

  it('fails an adapter that claims visibility without a matching publication', async () => {
    const create = harness((bound) =>
      decorate(bound, {
        verifyVisibility: async (publication) => ({
          status: 'visible',
          publication: { ...publication, publicationId: 'invented' },
        }),
      })
    )
    await expect(runCase('visibility is proven from the destination, never assumed', create)).rejects.toThrow(
      /conflict/
    )
  })
})
