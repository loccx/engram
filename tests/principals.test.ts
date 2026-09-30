// the principal store itself: tokens, grants, verbs, and the credential gate the http
// surface uses. the enforcement suite is tests/principals-scope.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { resetServicesForTests } from '../src/mcp/handlers.js'
import { createServer } from '../src/server.js'
import { authorizeRequest } from '../src/mcp/auth.js'
import { tools } from '../src/mcp/tools.js'
import { localOwnerScope, toolAccess } from '../src/memory/access.js'
import {
  addPrincipal,
  getPrincipal,
  grantVerbs,
  grantsFor,
  hasPrincipals,
  issueToken,
  listPrincipals,
  livePrincipalForToken,
  parsePrefix,
  parseVerbs,
  revokeGrant,
  revokeTokens,
  setPrincipalDisabled,
} from '../src/mcp/principals.js'

const NS = '/home/user/principal-store'
const OTHER = '/home/user/other-project'

describe('principal store', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  afterEach(() => {
    resetDatabase()
    resetServicesForTests()
  })

  it('reports no principals on a store that never had one', () => {
    expect(hasPrincipals(getDatabase().db)).toBe(false)
    expect(localOwnerScope().localOwner).toBe(true)
  })

  it('creates a principal once and rejects a duplicate name', () => {
    const db = getDatabase().db
    const created = addPrincipal(db, 'alice', 'agent')
    expect(created.kind).toBe('agent')
    expect(created.disabled_at).toBeNull()
    expect(getPrincipal(db, 'alice')?.id).toBe(created.id)
    expect(getPrincipal(db, created.id)?.name).toBe('alice')
    expect(() => addPrincipal(db, 'alice')).toThrow(/already exists/)
    expect(() => addPrincipal(db, 'bob', 'robot')).toThrow(/unknown kind/)
    expect(hasPrincipals(db)).toBe(true)
  })

  it('parses verbs and prefixes strictly', () => {
    expect(parseVerbs('read,write')).toEqual(['read', 'write'])
    expect(parseVerbs('read write delete share')).toEqual(['read', 'write', 'share', 'delete'])
    expect(parseVerbs('read,read')).toEqual(['read'])
    expect(() => parseVerbs('admin')).toThrow(/unknown verb/)
    expect(() => parseVerbs('')).toThrow(/at least one verb/)
    expect(parsePrefix('/a/b/')).toBe('/a/b')
    expect(parsePrefix('a/b')).toBe('/a/b')
    expect(parsePrefix('/')).toBe('/')
  })

  it('replaces the verbs on one prefix and leaves the others alone', () => {
    const db = getDatabase().db
    addPrincipal(db, 'alice')
    grantVerbs(db, 'alice', NS, ['read', 'write'])
    grantVerbs(db, 'alice', OTHER, ['read'])
    grantVerbs(db, 'alice', NS, ['read'])
    const grants = grantsFor(db, getPrincipal(db, 'alice')!.id)
    // listed by prefix, and the second grant on NS replaced its verbs
    expect(grants).toEqual([
      { prefix: OTHER, verbs: ['read'] },
      { prefix: NS, verbs: ['read'] },
    ])
    expect(revokeGrant(db, 'alice', OTHER)).toBe(true)
    expect(revokeGrant(db, 'alice', OTHER)).toBe(false)
    expect(grantsFor(db, getPrincipal(db, 'alice')!.id)).toEqual([{ prefix: NS, verbs: ['read'] }])
  })

  it('issues a token that is only ever stored hashed, and stamps its use', () => {
    const db = getDatabase().db
    addPrincipal(db, 'alice')
    const issued = issueToken(db, 'alice')
    expect(issued.token.startsWith('enkg_')).toBe(true)
    const stored = db.prepare('SELECT * FROM principal_tokens').get() as {
      token_hash: string
      last_used_at: number | null
      revoked_at: number | null
    }
    expect(stored.token_hash).not.toBe(issued.token)
    expect(stored.last_used_at).toBeNull()

    const principal = livePrincipalForToken(db, issued.token)
    expect(principal?.name).toBe('alice')
    const used = db.prepare('SELECT last_used_at FROM principal_tokens').get() as {
      last_used_at: number | null
    }
    expect(used.last_used_at).not.toBeNull()

    expect(livePrincipalForToken(db, `${issued.token}x`)).toBeNull()
    // a token that was never issued resolves to nothing at all
    expect(livePrincipalForToken(db, ['enkg', 'never', 'issued'].join('_'))).toBeNull()
  })

  it('stops resolving a token once it is revoked or its principal is disabled', () => {
    const db = getDatabase().db
    addPrincipal(db, 'alice')
    const first = issueToken(db, 'alice').token
    const second = issueToken(db, 'alice').token
    expect(revokeTokens(db, 'alice')).toBe(2)
    expect(livePrincipalForToken(db, first)).toBeNull()
    expect(livePrincipalForToken(db, second)).toBeNull()
    expect(revokeTokens(db, 'alice')).toBe(0)

    const third = issueToken(db, 'alice').token
    setPrincipalDisabled(db, 'alice', true)
    expect(livePrincipalForToken(db, third)).toBeNull()
    setPrincipalDisabled(db, 'alice', false)
    expect(livePrincipalForToken(db, third)?.name).toBe('alice')
  })

  it('lists principals with their grants and live token count', () => {
    const db = getDatabase().db
    addPrincipal(db, 'alice', 'agent')
    addPrincipal(db, 'bob', 'service')
    grantVerbs(db, 'alice', NS, ['read', 'write'])
    issueToken(db, 'alice')
    issueToken(db, 'alice')
    const listed = listPrincipals(db)
    expect(listed.map((row) => row.name)).toEqual(['alice', 'bob'])
    expect(listed[0].grants).toEqual([{ prefix: NS, verbs: ['read', 'write'] }])
    expect(listed[0].live_tokens).toBe(2)
    expect(listed[1].grants).toEqual([])
    expect(listed[1].live_tokens).toBe(0)
  })

  it('asks for a verb for every advertised tool, and only a store-wide one for the rest', () => {
    const storeWide = new Set([
      'get_maintenance_status',
      'run_pending_maintenance',
      'list_brains',
      'search_brain',
      'get_brain_memory',
    ])
    for (const tool of tools) {
      const access = toolAccess(tool.name)
      if (storeWide.has(tool.name)) {
        expect({ [tool.name]: access }).toEqual({ [tool.name]: 'owner' })
      } else {
        expect({ [tool.name]: access }).not.toEqual({ [tool.name]: 'owner' })
      }
    }
  })
})

describe('the http credential gate', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetDatabase()
    resetServicesForTests()
  })

  it('accepts a live principal token with no install token configured, and rejects a revoked one', () => {
    const db = getDatabase().db
    addPrincipal(db, 'alice')
    const token = issueToken(db, 'alice').token
    const accept = (presented: string) => livePrincipalForToken(db, presented) !== null

    expect(authorizeRequest(`Bearer ${token}`, {}, accept).allowed).toBe(true)
    revokeTokens(db, 'alice')
    expect(authorizeRequest(`Bearer ${token}`, {}, accept).allowed).toBe(false)
    expect(authorizeRequest(`Bearer ${token}`, {}, accept).status).toBe(401)
    // with no credential presented at all the install is still misconfigured, not denied
    expect(authorizeRequest(undefined, {}, accept).status).toBe(500)
  })

  it('binds the principal on the mcp route, so a write over http is hers', async () => {
    vi.stubEnv('ENGRAM_AUTH_TOKEN', ['install', 'token', 'fixture'].join('-'))
    const db = getDatabase().db
    addPrincipal(db, 'alice')
    grantVerbs(db, 'alice', NS, ['read', 'write'])
    const token = issueToken(db, 'alice').token
    const app = createServer({})

    const callTool = (header: string | undefined, name: string, args: Record<string, unknown>) =>
      app.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(header ? { authorization: header } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      })

    const written = await callTool(`Bearer ${token}`, 'store_memory', {
      project_path: NS,
      content: 'alice writes over http and keeps it to herself',
      importance: 0.9,
    })
    expect(written.status).toBe(200)
    const row = db
      .prepare('SELECT owner_principal, visibility FROM memories')
      .get() as { owner_principal: string | null; visibility: string | null }
    expect(row.owner_principal).not.toBeNull()
    expect(row.visibility).toBe('personal')

    const hers = (await (
      await callTool(`Bearer ${token}`, 'search_memories', {
        project_path: NS,
        query: 'keeps it to herself',
      })
    ).json()) as { result: { content: Array<{ text: string }> } }
    expect(hers.result.content[0].text).toContain('keeps it to herself')

    // the local owner holds the install token, and a named principal's private row is
    // not hers to read either
    const owners = (await (
      await callTool(
        `Bearer ${['install', 'token', 'fixture'].join('-')}`,
        'search_memories',
        { project_path: NS, query: 'keeps it to herself' }
      )
    ).json()) as { result: { content: Array<{ text: string }> } }
    expect(owners.result.content[0].text).not.toContain('keeps it to herself')
  })

  it('answers 401 on a revoked token and serves a live one through the mcp route', async () => {
    // an install token is configured here so a rejected credential is an auth failure on
    // this machine's own filesystem state rather than a missing configuration
    vi.stubEnv('ENGRAM_AUTH_TOKEN', ['install', 'token', 'fixture'].join('-'))
    const db = getDatabase().db
    addPrincipal(db, 'alice')
    grantVerbs(db, 'alice', NS, ['read', 'write'])
    const token = issueToken(db, 'alice').token
    const app = createServer({ requireAuth: true })

    const call = (header: string) =>
      app.request('/mcp', {
        method: 'POST',
        headers: { authorization: header, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })

    const served = await call(`Bearer ${token}`)
    expect(served.status).toBe(200)
    const payload = (await served.json()) as { result?: { tools?: unknown[] } }
    expect((payload.result?.tools?.length ?? 0)).toBeGreaterThan(0)

    revokeTokens(db, 'alice')
    const refused = await call(`Bearer ${token}`)
    expect(refused.status).toBe(401)

    const anonymous = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(anonymous.status).toBe(401)
  })
})
