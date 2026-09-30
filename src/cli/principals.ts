import type { Command } from 'commander'
import { getDatabase } from '../db/init.js'
import {
  addPrincipal,
  grantVerbs,
  issueToken,
  listPrincipals,
  parsePrefix,
  parseVerbs,
  revokeGrant,
  revokeTokens,
  setPrincipalDisabled,
} from '../mcp/principals.js'

/** the store a command operates on: --db wins, else the daemon's own file */
function openStore(db?: string): { db: import('better-sqlite3').Database } {
  return getDatabase(db)
}

function fail(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}

function describeGrants(grants: Array<{ prefix: string; verbs: string[] }>): string {
  if (grants.length === 0) return '(no grants)'
  return grants.map((grant) => `${grant.prefix} [${grant.verbs.join(',')}]`).join(' ')
}

export function registerPrincipalCommands(program: Command): void {
  const principal = program
    .command('principal')
    .description('Principals, their tokens and the namespaces each may reach')

  principal
    .command('add <name>')
    .description('Create a principal')
    .option('--kind <kind>', 'user | agent | service', 'user')
    .option('--db <path>', 'database file (defaults to the daemon database)')
    .action((name: string, opts: { kind: string; db?: string }) => {
      try {
        const principal = addPrincipal(openStore(opts.db).db, name, opts.kind)
        console.log(`Added ${principal.kind} principal ${principal.name} (${principal.id}).`)
        console.log(`Grant a namespace with \`engram principal grant ${principal.name} <prefix> read\`.`)
      } catch (e) {
        fail(e)
      }
    })

  principal
    .command('token <name>')
    .description('Issue a token for a principal and print it once')
    .option('--db <path>', 'database file (defaults to the daemon database)')
    .action((name: string, opts: { db?: string }) => {
      try {
        const issued = issueToken(openStore(opts.db).db, name)
        // the only place a token is ever printed: the store holds its sha256
        console.log(issued.token)
        console.log(`Shown once; ${issued.principal.name} presents it as an HTTP bearer token.`)
      } catch (e) {
        fail(e)
      }
    })

  principal
    .command('grant <name> <prefix> <verbs>')
    .description('Grant verbs (comma-separated: read,write,share,delete) on a namespace prefix')
    .option('--db <path>', 'database file (defaults to the daemon database)')
    .action((name: string, prefix: string, verbs: string, opts: { db?: string }) => {
      try {
        const parsed = parseVerbs(verbs)
        const grant = grantVerbs(openStore(opts.db).db, name, prefix, parsed)
        console.log(`Granted ${grant.verbs.join(',')} on ${grant.prefix} to ${name}.`)
      } catch (e) {
        fail(e)
      }
    })

  principal
    .command('revoke-grant <name> <prefix>')
    .description('Remove one namespace grant')
    .option('--db <path>', 'database file (defaults to the daemon database)')
    .action((name: string, prefix: string, opts: { db?: string }) => {
      try {
        const removed = revokeGrant(openStore(opts.db).db, name, parsePrefix(prefix))
        console.log(removed ? `Revoked ${prefix} from ${name}.` : `No grant on ${prefix} for ${name}.`)
      } catch (e) {
        fail(e)
      }
    })

  principal
    .command('revoke-token <name>')
    .description('Revoke every live token of a principal')
    .option('--db <path>', 'database file (defaults to the daemon database)')
    .action((name: string, opts: { db?: string }) => {
      try {
        const count = revokeTokens(openStore(opts.db).db, name)
        console.log(`Revoked ${count} token(s) for ${name}.`)
      } catch (e) {
        fail(e)
      }
    })

  principal
    .command('disable <name>')
    .description('Disable a principal: its tokens resolve to nothing while the row stays')
    .option('--db <path>', 'database file (defaults to the daemon database)')
    .action((name: string, opts: { db?: string }) => {
      try {
        const disabled = setPrincipalDisabled(openStore(opts.db).db, name, true)
        console.log(`Disabled ${disabled.name}.`)
      } catch (e) {
        fail(e)
      }
    })

  principal
    .command('enable <name>')
    .description('Re-enable a disabled principal')
    .option('--db <path>', 'database file (defaults to the daemon database)')
    .action((name: string, opts: { db?: string }) => {
      try {
        const enabled = setPrincipalDisabled(openStore(opts.db).db, name, false)
        console.log(`Enabled ${enabled.name}.`)
      } catch (e) {
        fail(e)
      }
    })

  principal
    .command('list')
    .description('List principals with their grants and token counts')
    .option('--db <path>', 'database file (defaults to the daemon database)')
    .action((opts: { db?: string }) => {
      try {
        const rows = listPrincipals(openStore(opts.db).db)
        if (rows.length === 0) {
          console.log('No principals: every request is the local owner.')
          return
        }
        for (const row of rows) {
          const state = row.disabled_at === null ? '' : ' (disabled)'
          console.log(
            `${row.name}${state} — kind ${row.kind}, tokens ${row.live_tokens}/${row.tokens} live`
          )
          console.log(`  grants: ${describeGrants(row.grants)}`)
        }
      } catch (e) {
        fail(e)
      }
    })
}
