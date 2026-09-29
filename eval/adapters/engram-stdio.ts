#!/usr/bin/env node
// engram's tool surface over mcp stdio, for the eval adapter: the daemon endpoint scopes
// by `?project=` and reads the machine's own data dir, while an eval run needs the db
// paths it passes in the environment. dispatch is the daemon's own, so this adapter
// answers both protocol revisions over stdio.
import { createInterface } from 'node:readline'
import { dispatchRpc } from '../../src/mcp/dispatch.js'

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let request: unknown
  try {
    request = JSON.parse(text) as unknown
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`
    )
    return
  }

  const id = request && typeof request === 'object' ? (request as { id?: unknown }).id : null
  dispatchRpc(request)
    .then((outcome) => {
      if (outcome.body) process.stdout.write(`${JSON.stringify(outcome.body)}\n`)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32603, message: 'Internal error', data: message },
        })}\n`
      )
    })
})

lines.on('close', () => {
  process.exit(0)
})
