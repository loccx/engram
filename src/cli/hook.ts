import type { Command } from 'commander'
import { HOOK_EVENTS, HOOK_TIMEOUT_MS, runHookProcess } from '../delivery/hook.js'

/**
 * the host runs this as a subprocess, so it must never throw, hang or exit non-zero:
 * a failed hook pollutes a session, while a missing cue costs one memory lookup
 */

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    let raw = ''
    const done = () => {
      clearTimeout(timer)
      process.stdin.off('data', onData)
      process.stdin.off('end', done)
      process.stdin.off('error', done)
      resolve(raw)
    }
    const onData = (chunk: Buffer | string) => {
      raw += chunk
    }
    const timer = setTimeout(done, timeoutMs)
    timer.unref?.()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.on('end', done)
    process.stdin.on('error', done)
  })
}

export function registerHookCommands(program: Command): void {
  program
    .command('hook <event>')
    .description(`Host hook entry point (${HOOK_EVENTS.join(', ')}); reads the host payload on stdin`)
    .option('--host <host>', 'output format for this host (claude-code, or omit for plain text)')
    .action(async (event: string, opts: { host?: string }) => {
      try {
        const stdin = await readStdin(HOOK_TIMEOUT_MS)
        const out = await runHookProcess(event, { host: opts.host, stdin })
        if (out) process.stdout.write(`${out}\n`)
      } catch {
        // fail open: nothing on stdout, exit 0
      }
    })
}
