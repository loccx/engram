// principals: the identity a credential resolves to, and the grants that decide which
// namespaces it reaches. a token is generated, shown once and stored only as its sha256,
// so the database never holds a usable credential.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { bearerToken, loadAuthToken, tokensMatch } from './auth.js'
import {
  LOCAL_OWNER,
  VERBS,
  type CallerScope,
  type Grant,
  type Verb,
} from '../memory/access.js'

export const PRINCIPAL_KINDS = ['user', 'agent', 'service'] as const
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number]

export interface PrincipalRow {
  id: string
  name: string
  kind: PrincipalKind
  created_at: number
  disabled_at: number | null
}

export interface PrincipalView extends PrincipalRow {
  grants: Grant[]
  tokens: number
  live_tokens: number
  last_used_at: number | null
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function isKind(value: string): value is PrincipalKind {
  return (PRINCIPAL_KINDS as readonly string[]).includes(value)
}

export function parseVerbs(input: string): Verb[] {
  const parts = input
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  for (const part of new Set(parts)) {
    if (!(VERBS as string[]).includes(part)) {
      throw new Error(`unknown verb "${part}"; expected any of ${VERBS.join(', ')}`)
    }
  }
  if (parts.length === 0) throw new Error('at least one verb is required')
  // canonical order, so a grant written twice in two orders is the same grant
  return VERBS.filter((verb) => parts.includes(verb))
}

export function parsePrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (trimmed === '' || trimmed === '/') return '/'
  const withoutTrailing = trimmed.replace(/\/+$/, '')
  return withoutTrailing.startsWith('/') ? withoutTrailing : `/${withoutTrailing}`
}

export function getPrincipal(db: Database.Database, nameOrId: string): PrincipalRow | null {
  const named = db
    .prepare('SELECT * FROM principals WHERE name = ?')
    .get(nameOrId.trim()) as PrincipalRow | undefined
  if (named) return named
  const byId = db
    .prepare('SELECT * FROM principals WHERE id = ?')
    .get(nameOrId) as PrincipalRow | undefined
  return byId ?? null
}

export function requirePrincipal(db: Database.Database, nameOrId: string): PrincipalRow {
  const principal = getPrincipal(db, nameOrId)
  if (!principal) throw new Error(`no principal named ${nameOrId}`)
  return principal
}

export function hasPrincipals(db: Database.Database): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM principals').get() as { n: number }
  return row.n > 0
}

/**
 * the store has a boundary as soon as one principal can be served: a disabled principal
 * is not one, so disabling every principal returns the install to local-owner mode
 */
export function hasLivePrincipals(db: Database.Database): boolean {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM principals WHERE disabled_at IS NULL')
    .get() as { n: number }
  return row.n > 0
}

export function addPrincipal(
  db: Database.Database,
  name: string,
  kind: string = 'user',
  now: number = Date.now()
): PrincipalRow {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('a principal needs a name')
  if (!isKind(kind)) {
    throw new Error(`unknown kind "${kind}"; expected any of ${PRINCIPAL_KINDS.join(', ')}`)
  }
  const existing = getPrincipal(db, trimmed)
  if (existing) throw new Error(`principal ${trimmed} already exists`)
  const id = randomUUID()
  db.prepare(
    'INSERT INTO principals (id, name, kind, created_at, disabled_at) VALUES (?, ?, ?, ?, NULL)'
  ).run(id, trimmed, kind, now)
  return { id, name: trimmed, kind, created_at: now, disabled_at: null }
}

export function setPrincipalDisabled(
  db: Database.Database,
  nameOrId: string,
  disabled: boolean,
  now: number = Date.now()
): PrincipalRow {
  const principal = requirePrincipal(db, nameOrId)
  db.prepare('UPDATE principals SET disabled_at = ? WHERE id = ?').run(
    disabled ? now : null,
    principal.id
  )
  return { ...principal, disabled_at: disabled ? now : null }
}

/** a grant replaces the verbs on that prefix; it never widens another prefix */
export function grantVerbs(
  db: Database.Database,
  nameOrId: string,
  prefix: string,
  verbs: Verb[],
  now: number = Date.now()
): Grant {
  const principal = requirePrincipal(db, nameOrId)
  const normalized = parsePrefix(prefix)
  db.prepare(
    `INSERT INTO grants (principal_id, namespace_prefix, verbs, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(principal_id, namespace_prefix) DO UPDATE SET verbs = excluded.verbs`
  ).run(principal.id, normalized, verbs.join(','), now)
  return { prefix: normalized, verbs }
}

export function revokeGrant(db: Database.Database, nameOrId: string, prefix: string): boolean {
  const principal = requirePrincipal(db, nameOrId)
  const result = db
    .prepare('DELETE FROM grants WHERE principal_id = ? AND namespace_prefix = ?')
    .run(principal.id, parsePrefix(prefix))
  return result.changes > 0
}

export interface IssuedToken {
  /** returned to the caller once, never stored */
  token: string
  token_hash: string
  principal: PrincipalRow
}

export function issueToken(
  db: Database.Database,
  nameOrId: string,
  now: number = Date.now()
): IssuedToken {
  const principal = requirePrincipal(db, nameOrId)
  const token = `enkg_${randomBytes(32).toString('base64url')}`
  const hash = tokenHash(token)
  db.prepare(
    'INSERT INTO principal_tokens (token_hash, principal_id, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, NULL, NULL)'
  ).run(hash, principal.id, now)
  return { token, token_hash: hash, principal }
}

export function revokeTokens(
  db: Database.Database,
  nameOrId: string,
  now: number = Date.now()
): number {
  const principal = requirePrincipal(db, nameOrId)
  const result = db
    .prepare(
      'UPDATE principal_tokens SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL'
    )
    .run(now, principal.id)
  return result.changes
}

export function grantsFor(db: Database.Database, principalId: string): Grant[] {
  const rows = db
    .prepare('SELECT namespace_prefix, verbs FROM grants WHERE principal_id = ? ORDER BY namespace_prefix')
    .all(principalId) as Array<{ namespace_prefix: string; verbs: string }>
  return rows.map((row) => ({
    prefix: row.namespace_prefix,
    verbs: row.verbs
      .split(',')
      .map((verb) => verb.trim())
      .filter((verb): verb is Verb => (VERBS as string[]).includes(verb)),
  }))
}

export function callerScopeFor(db: Database.Database, principal: PrincipalRow): CallerScope {
  return {
    principalId: principal.id,
    name: principal.name,
    localOwner: false,
    grants: grantsFor(db, principal.id),
  }
}

export function listPrincipals(db: Database.Database): PrincipalView[] {
  const rows = db
    .prepare('SELECT * FROM principals ORDER BY name ASC')
    .all() as PrincipalRow[]
  return rows.map((principal) => {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS tokens,
                SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS live,
                MAX(CASE WHEN revoked_at IS NULL THEN last_used_at END) AS used
         FROM principal_tokens WHERE principal_id = ?`
      )
      .get(principal.id) as { tokens: number; live: number | null; used: number | null }
    return {
      ...principal,
      grants: grantsFor(db, principal.id),
      tokens: counts.tokens,
      live_tokens: counts.live ?? 0,
      last_used_at: counts.used ?? null,
    }
  })
}

export interface ResolvedCredential {
  caller: CallerScope
  /** which credential the request arrived with, for the audit trail */
  kind: 'principal' | 'install-token' | 'none'
}

// the credential decides: a live principal token serves as that principal, and the
// install token (env or the 0600 file) serves as the local owner. a revoked or disabled
// principal resolves to nothing rather than falling back to the owner, and a request with
// no credential is the owner only while the store holds no principal: once one exists,
// omitting the token is refused, which is what makes the boundary hold on loopback too.
export function resolveCredential(
  db: Database.Database,
  header: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): ResolvedCredential | null {
  const presented = bearerToken(header)
  if (presented !== null) {
    const principal = livePrincipalForToken(db, presented, now)
    if (principal) return { caller: callerScopeFor(db, principal), kind: 'principal' }
    const install = loadAuthToken(env)
    if (install.token && tokensMatch(presented, install.token)) {
      return { caller: LOCAL_OWNER, kind: 'install-token' }
    }
    return null
  }
  if (hasLivePrincipals(db)) return null
  return { caller: LOCAL_OWNER, kind: 'none' }
}

export function livePrincipalForToken(
  db: Database.Database,
  token: string,
  now: number = Date.now()
): PrincipalRow | null {
  if (token === '') return null
  const hash = tokenHash(token)
  const row = db
    .prepare(
      `SELECT p.* FROM principal_tokens t
       JOIN principals p ON p.id = t.principal_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND p.disabled_at IS NULL`
    )
    .get(hash) as PrincipalRow | undefined
  if (!row) return null
  db.prepare('UPDATE principal_tokens SET last_used_at = ? WHERE token_hash = ?').run(now, hash)
  return row
}

/** true when the presented token is a live principal token, for the http gate */
export function acceptsPrincipalToken(db: Database.Database, header: string | undefined): boolean {
  const presented = bearerToken(header)
  return presented !== null && livePrincipalForToken(db, presented) !== null
}
