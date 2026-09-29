import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { createServer } from '../src/server.js'
import {
  authorizeRequest,
  bearerToken,
  loadAuthToken,
  requiresAuth,
  resolveAuthRequirement,
  resolveTokenFile,
  TOKEN_ENV,
  TOKEN_FILE_ENV,
  tokensMatch,
  writeTokenFile,
} from '../src/mcp/auth.js'

// every token here is a fixture: nothing in this file reads a real credential
const DUMMY = 'dummy-token-0001'
const OTHER = 'dummy-token-0002'

const dirs: string[] = []
const saved = new Map<string, string | undefined>()

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-auth-test-'))
  dirs.push(dir)
  return dir
}

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('auth token resolution', () => {
  it('prefers the environment and never invents a token', () => {
    const dir = tempDir()
    writeTokenFile(join(dir, 'auth.token'), { token: OTHER })
    setEnv(TOKEN_ENV, DUMMY)
    setEnv(TOKEN_FILE_ENV, join(dir, 'auth.token'))
    expect(loadAuthToken()).toEqual({ token: DUMMY, source: 'env' })

    setEnv(TOKEN_ENV, undefined)
    expect(loadAuthToken()).toEqual({ token: OTHER, source: 'file', path: join(dir, 'auth.token') })

    setEnv(TOKEN_FILE_ENV, join(dir, 'missing.token'))
    expect(loadAuthToken()).toEqual({ token: null, source: 'none', path: join(dir, 'missing.token') })
  })

  it('refuses a token file anyone else can read', () => {
    const dir = tempDir()
    const path = join(dir, 'auth.token')
    writeTokenFile(path, { token: DUMMY })
    expect(loadAuthToken({ [TOKEN_FILE_ENV]: path }).source).toBe('file')

    chmodSync(path, 0o644)
    const lookup = loadAuthToken({ [TOKEN_FILE_ENV]: path })
    expect(lookup.token).toBeNull()
    expect(lookup.error).toContain('chmod 600')
  })

  it('rejects an empty environment token instead of accepting a blank secret', () => {
    const lookup = loadAuthToken({ [TOKEN_ENV]: '  ' })
    expect(lookup.token).toBeNull()
    expect(lookup.error).toContain(TOKEN_ENV)
  })

  it('resolves the token file from the data dir unless it is overridden', () => {
    expect(resolveTokenFile({ ENGRAM_DATA_DIR: '/tmp/en' })).toBe(join('/tmp/en', 'auth.token'))
    expect(
      resolveTokenFile({ ENGRAM_DATA_DIR: '/tmp/en', [TOKEN_FILE_ENV]: '/tmp/other/tok' })
    ).toBe('/tmp/other/tok')
  })
})

describe('bearer checks', () => {
  it('compares equal tokens without throwing on different lengths', () => {
    expect(tokensMatch(DUMMY, DUMMY)).toBe(true)
    expect(tokensMatch(DUMMY, OTHER)).toBe(false)
    expect(tokensMatch('short', DUMMY)).toBe(false)
    expect(tokensMatch(`${DUMMY}x`, DUMMY)).toBe(false)
  })

  it('parses a bearer header case-insensitively and rejects other schemes', () => {
    expect(bearerToken(`Bearer ${DUMMY}`)).toBe(DUMMY)
    expect(bearerToken(`bearer ${DUMMY}`)).toBe(DUMMY)
    expect(bearerToken('Token x')).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
  })

  it('allows only the configured token, and never echoes it', () => {
    const env = { [TOKEN_ENV]: DUMMY }
    expect(authorizeRequest(`Bearer ${DUMMY}`, env).allowed).toBe(true)

    const missing = authorizeRequest(undefined, env)
    expect(missing.allowed).toBe(false)
    expect(missing.status).toBe(401)
    expect(missing.message).not.toContain(DUMMY)

    const wrong = authorizeRequest(`Bearer ${OTHER}`, env)
    expect(wrong.allowed).toBe(false)
    expect(wrong.status).toBe(401)
    expect(wrong.message).not.toContain(OTHER)

    const unconfigured = authorizeRequest(`Bearer ${DUMMY}`, {})
    expect(unconfigured.allowed).toBe(false)
    expect(unconfigured.message).toContain('engram auth token')
  })

  it('requires a token off loopback only', () => {
    expect(requiresAuth('127.0.0.1')).toBe(false)
    expect(requiresAuth('::1')).toBe(false)
    expect(requiresAuth('localhost')).toBe(false)
    expect(requiresAuth('0.0.0.0')).toBe(true)
    expect(requiresAuth('10.0.0.5')).toBe(true)
  })

  it('refuses a non-loopback bind with no usable token and names the fix', () => {
    const dir = tempDir()
    const env = { ENGRAM_DATA_DIR: dir }
    const missing = resolveAuthRequirement('0.0.0.0', env)
    expect(missing.required).toBe(true)
    expect(missing.token).toBeNull()
    expect(missing.error).toContain('engram auth token')

    const loopback = resolveAuthRequirement('127.0.0.1', env)
    expect(loopback).toEqual({ required: false, token: null })

    const configured = resolveAuthRequirement('0.0.0.0', { ...env, [TOKEN_ENV]: DUMMY })
    expect(configured.error).toBeUndefined()
    expect(configured.token).toBe(DUMMY)
    expect(configured.source).toBe('env')
  })
})

describe('daemon http surface', () => {
  beforeEach(() => {
    resetDatabase()
    getDatabase(':memory:')
  })

  it('stays open on loopback and needs the bearer token off it', async () => {
    setEnv(TOKEN_ENV, DUMMY)

    const open = createServer()
    expect((await open.request('/health')).status).toBe(200)

    const guarded = createServer({ requireAuth: true })
    const anonymous = await guarded.request('/health')
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer')

    const wrong = await guarded.request('/health', { headers: { authorization: `Bearer ${OTHER}` } })
    expect(wrong.status).toBe(401)

    const allowed = await guarded.request('/health', {
      headers: { authorization: `Bearer ${DUMMY}` },
    })
    expect(allowed.status).toBe(200)
    expect((await allowed.json()) as { status: string }).toMatchObject({ status: 'ok' })

    const mcp = await guarded.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(mcp.status).toBe(401)
  })

  it('answers a broken token configuration with the fix, not a silent pass', async () => {
    const dir = tempDir()
    const path = join(dir, 'auth.token')
    writeFileSync(path, `${DUMMY}\n`)
    chmodSync(path, 0o644)
    setEnv(TOKEN_ENV, undefined)
    setEnv(TOKEN_FILE_ENV, path)

    const res = await createServer({ requireAuth: true }).request('/health')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('chmod 600')
    expect(body.error).not.toContain(DUMMY)
  })
})

describe('token file', () => {
  it('writes 0600, refuses to clobber, and replaces with force', () => {
    const dir = tempDir()
    const path = join(dir, 'nested', 'auth.token')
    const first = writeTokenFile(path, { token: DUMMY })
    expect(first.token).toBe(DUMMY)
    expect(readFileSync(path, 'utf8')).toBe(`${DUMMY}\n`)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    expect(() => writeTokenFile(path, { token: OTHER })).toThrow(/already exists/)
    expect(readFileSync(path, 'utf8')).toBe(`${DUMMY}\n`)

    writeTokenFile(path, { token: OTHER, force: true })
    expect(readFileSync(path, 'utf8')).toBe(`${OTHER}\n`)

    const generated = writeTokenFile(join(dir, 'generated', 'auth.token'))
    expect(generated.token.length).toBeGreaterThan(20)
    expect(existsSync(generated.path)).toBe(true)
  })
})
