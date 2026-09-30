import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import envPaths from 'env-paths'

const paths = envPaths('engram')

export const TOKEN_ENV = 'ENGRAM_AUTH_TOKEN'
export const TOKEN_FILE_ENV = 'ENGRAM_AUTH_TOKEN_FILE'
export const TOKEN_FILE_NAME = 'auth.token'

/**
 * resolved here rather than imported from db/init: the hook path calls this and must not
 * pull sqlite and the embedding pipeline in with it
 */
function dataDir(env: NodeJS.ProcessEnv): string {
  const override = env.ENGRAM_DATA_DIR?.trim()
  return override ? override : paths.data
}

export function resolveTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TOKEN_FILE_ENV]?.trim()
  return override ? override : join(dataDir(env), TOKEN_FILE_NAME)
}

export type TokenSource = 'env' | 'file' | 'none'

export interface TokenLookup {
  token: string | null
  source: TokenSource
  path?: string
  error?: string
}

/** the env var wins; the file is accepted only when it is not readable by anyone else */
export function loadAuthToken(env: NodeJS.ProcessEnv = process.env): TokenLookup {
  const fromEnv = env[TOKEN_ENV]
  if (fromEnv !== undefined) {
    const token = fromEnv.trim()
    if (token === '') return { token: null, source: 'none', error: `${TOKEN_ENV} is set but empty` }
    return { token, source: 'env' }
  }

  const path = resolveTokenFile(env)
  let mode: number
  try {
    mode = statSync(path).mode
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { token: null, source: 'none', path }
    return { token: null, source: 'none', path, error: `token file ${path} is not readable` }
  }
  if ((mode & 0o077) !== 0) {
    return {
      token: null,
      source: 'none',
      path,
      error: `token file ${path} is group/world readable; chmod 600 ${path}`,
    }
  }
  const token = readFileSync(path, 'utf8').trim()
  if (token === '') return { token: null, source: 'none', path, error: `token file ${path} is empty` }
  return { token, source: 'file', path }
}

/** equal-length digests, so the compare leaks neither length nor a matching prefix */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

export interface AuthDecision {
  allowed: boolean
  status: 401 | 500
  message: string
}

/**
 * `accept` is the store's own credential check (a live principal token); a presented
 * token that it accepts is allowed even with no install token configured
 */
export function authorizeRequest(
  header: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  accept?: (presented: string) => boolean
): AuthDecision {
  const lookup = loadAuthToken(env)
  const presented = bearerToken(header)
  if (presented !== null && accept?.(presented) === true) {
    return { allowed: true, status: 401, message: '' }
  }
  if (lookup.error) return { allowed: false, status: 500, message: lookup.error }
  if (!lookup.token) {
    // a presented credential the store rejected is an auth failure, not a misconfigured
    // install; without one, a non-loopback bind with no token at all still is
    if (accept && presented !== null) {
      return { allowed: false, status: 401, message: 'unauthorized: bearer token rejected' }
    }
    return { allowed: false, status: 500, message: 'no bearer token configured; run `engram auth token`' }
  }
  if (presented === null) {
    return { allowed: false, status: 401, message: 'unauthorized: a bearer token is required' }
  }
  if (!tokensMatch(presented, lookup.token)) {
    return { allowed: false, status: 401, message: 'unauthorized: bearer token rejected' }
  }
  return { allowed: true, status: 401, message: '' }
}

/** the token as an outbound header, for the local clients that talk to the daemon */
export function authHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const { token } = loadAuthToken(env)
  return token ? { authorization: `Bearer ${token}` } : {}
}

export function requiresAuth(hostname: string): boolean {
  return !['127.0.0.1', '::1', 'localhost'].includes(hostname)
}

export interface AuthRequirement {
  required: boolean
  token: string | null
  source?: TokenSource
  path?: string
  error?: string
}

/** a non-loopback bind without a token is refused, not warned about */
export function resolveAuthRequirement(
  hostname: string,
  env: NodeJS.ProcessEnv = process.env
): AuthRequirement {
  if (!requiresAuth(hostname)) return { required: false, token: null }
  const lookup = loadAuthToken(env)
  if (lookup.error) return { required: true, token: null, error: lookup.error }
  if (!lookup.token) {
    return {
      required: true,
      token: null,
      error:
        `binding ${hostname} requires a bearer token. Run \`engram auth token\` ` +
        `or set ${TOKEN_ENV}.`,
    }
  }
  return { required: true, token: lookup.token, source: lookup.source, path: lookup.path }
}

export function writeTokenFile(
  path: string,
  options: { force?: boolean; token?: string } = {}
): { path: string; token: string } {
  if (!options.force && existsSync(path)) {
    throw new Error(`${path} already exists; pass --force to replace it`)
  }
  const token = options.token?.trim() || randomBytes(32).toString('base64url')
  mkdirSync(dirname(path), { recursive: true })
  // the mode arg is masked by the umask, so set it explicitly afterwards
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return { path, token }
}
