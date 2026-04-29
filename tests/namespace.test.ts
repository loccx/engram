import { describe, it, expect, afterEach } from 'vitest'
import { resolveNamespace } from '../src/namespace/resolver.js'

describe('resolveNamespace - precedence', () => {
  const originalEnv = process.env.ENGRAM_DEFAULT_NAMESPACE
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ENGRAM_DEFAULT_NAMESPACE
    else process.env.ENGRAM_DEFAULT_NAMESPACE = originalEnv
  })

  it('args.namespace beats everything else', async () => {
    const r = await resolveNamespace({
      argsNamespace: 'arg-ns',
      argsProjectPath: '/path',
      urlNamespace: 'url-ns',
      urlProject: '/url',
      envDefault: 'env-ns',
    })
    expect(r).toEqual({ namespace: 'arg-ns', source: 'args.namespace' })
  })

  it('args.project_path beats url + env', async () => {
    const r = await resolveNamespace({
      argsProjectPath: '/path',
      urlNamespace: 'url-ns',
      urlProject: '/url',
      envDefault: 'env-ns',
    })
    expect(r).toEqual({ namespace: '/path', source: 'args.project_path' })
  })

  it('url.namespace beats url.project + env', async () => {
    const r = await resolveNamespace({
      urlNamespace: 'url-ns',
      urlProject: '/url',
      envDefault: 'env-ns',
    })
    expect(r).toEqual({ namespace: 'url-ns', source: 'url.namespace' })
  })

  it('url.project beats env', async () => {
    const r = await resolveNamespace({
      urlProject: '/url',
      envDefault: 'env-ns',
    })
    expect(r).toEqual({ namespace: '/url', source: 'url.project' })
  })

  it('env default used when no args/url provided', async () => {
    const r = await resolveNamespace({ envDefault: 'env-ns' })
    expect(r).toEqual({ namespace: 'env-ns', source: 'env.default' })
  })

  it('reads ENGRAM_DEFAULT_NAMESPACE from process.env when envDefault not passed', async () => {
    process.env.ENGRAM_DEFAULT_NAMESPACE = 'env-from-process'
    const r = await resolveNamespace({})
    expect(r).toEqual({ namespace: 'env-from-process', source: 'env.default' })
  })

  it('falls back to detected git_root when nothing else provided', async () => {
    delete process.env.ENGRAM_DEFAULT_NAMESPACE
    const r = await resolveNamespace({ cwd: process.cwd() })
    expect(r.source).toBe('detected.git_root')
    expect(r.namespace).toBeTruthy()
    expect(typeof r.namespace).toBe('string')
  })

  it('empty-string args treated as not-provided (falls through)', async () => {
    delete process.env.ENGRAM_DEFAULT_NAMESPACE
    const r = await resolveNamespace({
      argsNamespace: '',
      argsProjectPath: '',
      urlNamespace: '',
      urlProject: '/url',
    })
    expect(r).toEqual({ namespace: '/url', source: 'url.project' })
  })
})
