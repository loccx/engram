import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { createServer } from '../src/server.js'
import { INTEGRATION_CAPABILITIES, INTEGRATION_HOST } from '../src/delivery/integration.js'
import { ENGRAM_BUILD_SHA, resolveBuildSha } from '../src/version.js'

const NS = '/work/engram'
const OTHER = '/work/other'

interface Json {
  [key: string]: unknown
}

async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await createServer().request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return { status: res.status, json: (await res.json()) as Json }
}

describe('integration routes', () => {
  beforeEach(() => {
    resetDatabase()
    getDatabase(':memory:')
  })

  it('advertises protocol v1 with the capabilities the host negotiates on', async () => {
    const { status, json } = await request('GET', '/delivery/integration/capabilities')
    expect(status).toBe(200)
    expect(json.protocol_version).toBe(1)
    expect(json.capabilities).toEqual([...INTEGRATION_CAPABILITIES])
    expect(json.hosts).toEqual([INTEGRATION_HOST])
  })

  it('reports defaults for a namespace that was never configured', async () => {
    const { status, json } = await request('POST', '/delivery/integration/status', {
      namespace: NS,
      host: INTEGRATION_HOST,
    })
    expect(status).toBe(200)
    expect(json.preferences).toEqual({ recall: false, capture: false, revision: 0 })
    expect(json.can_configure).toBe(true)
    expect(json.last_recall).toBeNull()
    expect(json.last_capture).toBeNull()
  })

  it('writes preferences under the expected revision and reads them back scoped', async () => {
    const write = await request('POST', '/delivery/integration/settings', {
      namespace: NS,
      host: INTEGRATION_HOST,
      recall: true,
      capture: true,
      expected_revision: 0,
    })
    expect(write.status).toBe(200)
    expect(write.json.preferences).toEqual({ recall: true, capture: true, revision: 1 })

    const other = await request('POST', '/delivery/integration/status', { namespace: OTHER, host: INTEGRATION_HOST })
    expect(other.json.preferences).toEqual({ recall: false, capture: false, revision: 0 })

    const reread = await request('POST', '/delivery/integration/status', { namespace: NS, host: INTEGRATION_HOST })
    expect(reread.json.preferences).toEqual({ recall: true, capture: true, revision: 1 })
  })

  it('refuses a stale expected_revision without writing', async () => {
    await request('POST', '/delivery/integration/settings', {
      namespace: NS,
      host: INTEGRATION_HOST,
      recall: true,
      capture: false,
      expected_revision: 0,
    })
    const stale = await request('POST', '/delivery/integration/settings', {
      namespace: NS,
      host: INTEGRATION_HOST,
      recall: false,
      capture: true,
      expected_revision: 0,
    })
    expect(stale.status).toBe(409)
    expect(stale.json.preferences).toEqual({ recall: true, capture: false, revision: 1 })

    const reread = await request('POST', '/delivery/integration/status', { namespace: NS, host: INTEGRATION_HOST })
    expect(reread.json.preferences).toEqual({ recall: true, capture: false, revision: 1 })
  })

  it('rejects a malformed body and an unknown host instead of guessing', async () => {
    const missingRevision = await request('POST', '/delivery/integration/settings', {
      namespace: NS,
      host: INTEGRATION_HOST,
      recall: true,
      capture: false,
    })
    expect(missingRevision.status).toBe(400)

    const wrongHost = await request('POST', '/delivery/integration/settings', {
      namespace: NS,
      host: 'other',
      recall: true,
      capture: false,
      expected_revision: 0,
    })
    expect(wrongHost.status).toBe(400)

    expect((await request('POST', '/delivery/integration/status', { namespace: '' })).status).toBe(400)
  })

  it('records the newest recall and capture receipt per namespace', async () => {
    const recall = await request('POST', '/delivery/integration/receipt', {
      namespace: NS,
      host: INTEGRATION_HOST,
      kind: 'recall',
      at: 1000,
    })
    expect(recall.status).toBe(200)
    expect(recall.json.receipt).toEqual({ at: 1000, status: null })

    await request('POST', '/delivery/integration/receipt', {
      namespace: NS,
      host: INTEGRATION_HOST,
      kind: 'capture',
      at: 2000,
      status: 'stored',
    })
    await request('POST', '/delivery/integration/receipt', {
      namespace: NS,
      host: INTEGRATION_HOST,
      kind: 'capture',
      at: 3000,
      status: 'refused',
    })

    const status = await request('POST', '/delivery/integration/status', { namespace: NS, host: INTEGRATION_HOST })
    expect(status.json.last_recall).toEqual({ at: 1000, status: null })
    expect(status.json.last_capture).toEqual({ at: 3000, status: 'refused' })

    const other = await request('POST', '/delivery/integration/status', { namespace: OTHER, host: INTEGRATION_HOST })
    expect(other.json.last_capture).toBeNull()
  })

  it('reports the release build revision, and null when no installer wrote one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-build-'))
    try {
      expect(resolveBuildSha(dir)).toBeNull()
      writeFileSync(join(dir, 'engram-build.json'), JSON.stringify({ sha: 'a'.repeat(40) }))
      expect(resolveBuildSha(dir)).toBe('a'.repeat(40))
      writeFileSync(join(dir, 'engram-build.json'), JSON.stringify({ sha: 'not-a-revision' }))
      expect(resolveBuildSha(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    const health = await request('GET', '/health')
    expect(health.json.build_sha).toBe(ENGRAM_BUILD_SHA)
  })
})
