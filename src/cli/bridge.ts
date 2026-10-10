import type { Command } from 'commander'
import { getDatabase } from '../db/init.js'
import { OUTBOX_STATES, readBridgeStatus, type BridgeStatus } from '../bridge/status.js'

/** compact age for an operator: seconds under a minute, then minutes, hours, days */
export function formatAge(ms: number | null): string {
  if (ms === null) return 'none'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function renderBridgeStatus(status: BridgeStatus): string {
  const active = OUTBOX_STATES.filter((state) => status.outbox.byState[state] > 0).map(
    (state) => `${status.outbox.byState[state]} ${state}`
  )
  return [
    `envelopes          ${status.envelopes.total} (publish ${status.envelopes.publish}, retract ${status.envelopes.retract})`,
    `outbox             ${status.outbox.total === 0 ? 'empty' : active.join(' · ')}`,
    `oldest unfinished  ${formatAge(status.outbox.oldestUnfinishedAgeMs)}`,
    `last error         ${status.outbox.lastError ? `${status.outbox.lastError.envelopeId}: ${status.outbox.lastError.message}` : 'none'}`,
  ].join('\n')
}

export function registerBridgeCommands(program: Command): void {
  const bridge = program.command('bridge').description('Inspect the governed export bridge (read-only)')

  bridge
    .command('status')
    .description('Show outbox counts, the oldest unfinished export and the last error')
    .option('--json', 'print the status as json')
    .action((opts: { json?: boolean }) => {
      const status = readBridgeStatus(getDatabase().db)
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2))
        return
      }
      console.log(renderBridgeStatus(status))
    })
}
