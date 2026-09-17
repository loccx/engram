import { describe, it, expect } from 'vitest'
import { resolveCorsOrigin } from '../src/server.js'
import { resolveBindHost } from '../src/daemon.js'

/**
 * The daemon has no authentication, so its network surface is pinned here:
 * loopback by default, and no wildcard CORS.
 */
describe('daemon exposure defaults', () => {
  it('binds loopback unless explicitly opted in', () => {
    expect(resolveBindHost({} as NodeJS.ProcessEnv)).toBe('127.0.0.1')
    expect(resolveBindHost({ ENGRAM_ALLOW_NONLOCAL: '1' } as NodeJS.ProcessEnv)).toBe('0.0.0.0')
    expect(resolveBindHost({ ENGRAM_ALLOW_NONLOCAL: '0' } as NodeJS.ProcessEnv)).toBe('127.0.0.1')
    expect(resolveBindHost({ ENGRAM_ALLOW_NONLOCAL: 'true' } as NodeJS.ProcessEnv)).toBe('127.0.0.1')
  })

  it('reflects only localhost origins, never a wildcard', () => {
    expect(resolveCorsOrigin('http://localhost:5173')).toBe('http://localhost:5173')
    expect(resolveCorsOrigin('http://127.0.0.1:8888')).toBe('http://127.0.0.1:8888')
    expect(resolveCorsOrigin('http://evil.example')).toBeUndefined()
    expect(resolveCorsOrigin('https://attacker.test:443')).toBeUndefined()
    expect(resolveCorsOrigin('null')).toBeUndefined()
    expect(resolveCorsOrigin('not a url')).toBeUndefined()
    expect(resolveCorsOrigin(undefined)).toBeUndefined()
  })
})
