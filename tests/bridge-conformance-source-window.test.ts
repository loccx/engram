import { expect, it } from 'vitest'
import { deferred, fixtureBridge, fixtureDestination, fixtureSnapshot, queued } from './fixtures/bridge-core-ports.js'
import { DeterministicDestination } from './fixtures/bridge-destination.js'

// preventable pre-send stale-source window, not an unavoidable post-final-check race.
// this falsifier fails on baseline d8aa9d4 and passes on the corrected core; core fixes belong to its owner.
it('must not publish a source that changed while the authority recheck awaited', async () => {
  const f = fixtureBridge(), sink = new DeterministicDestination(fixtureDestination)
  try {
    await queued(f)
    const entered = deferred(), release = deferred()
    f.authority.beforeRecheck = async () => { entered.resolve(); await release.promise; f.authority.beforeRecheck = undefined }
    const pending = f.coordinator.drain(sink, { owner: 'inert-source-window' })
    await entered.promise
    f.source.snapshot = fixtureSnapshot('changed-at-authority-await', 'source invalidated before IO')
    release.resolve()
    await pending
    expect(sink.calls.filter((call) => call.operation === 'publish')).toHaveLength(0)
    expect(sink.acceptedPublications()).toHaveLength(0)
  } finally { if (f.db.open) f.db.close() }
})
