import type { Command } from 'commander'
import { statSync } from 'node:fs'
import {
  loadAuthToken,
  resolveTokenFile,
  TOKEN_ENV,
  writeTokenFile,
} from '../mcp/auth.js'

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Bearer token for a non-loopback bind')

  auth
    .command('token')
    .description('Write the daemon bearer token (0600) to the data dir')
    .option('--force', 'replace an existing token file')
    .option('--print', 'print the token, for a client that cannot read the file')
    .action((opts: { force?: boolean; print?: boolean }) => {
      const path = resolveTokenFile()
      try {
        const { token } = writeTokenFile(path, { force: opts.force === true })
        console.log(`Wrote ${path} (0600).`)
        if (opts.print) console.log(token)
        console.log(
          `A daemon bound with ENGRAM_ALLOW_NONLOCAL=1 requires it on every request; ` +
            `set ${TOKEN_ENV} for clients that cannot read that file.`
        )
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        console.error(message)
        process.exit(1)
      }
    })

  auth
    .command('status')
    .description('Report where a token comes from and whether it is usable')
    .action(() => {
      const path = resolveTokenFile()
      const lookup = loadAuthToken()
      if (lookup.error) {
        console.log(`Token: unusable — ${lookup.error}`)
        process.exit(1)
      }
      if (!lookup.token) {
        console.log(`Token: none. Run \`engram auth token\` to create ${path}, or set ${TOKEN_ENV}.`)
        return
      }
      if (lookup.source === 'env') {
        console.log(`Token: from ${TOKEN_ENV}`)
        return
      }
      const mode = (statSync(path).mode & 0o777).toString(8).padStart(3, '0')
      console.log(`Token: ${path} (mode ${mode})`)
    })
}
