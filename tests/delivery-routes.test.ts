import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { createServer } from '../src/server.js'
import { normalizeIdentifiers } from '../src/db/lexical-index.js'
import { renderHook } from '../src/delivery/hook.js'

const NS = '/work/engram'
const CHILD = '/work/engram/packages/api'
const OTHER = '/work/other'

interface DeliveryResponse {
  entries?: Array<{ id: string; type: string; preview?: string; content?: string; matched?: string }>
  error?: string
}

function seed(id: string, content: string, opts: { namespace?: string; type?: string; createdAt?: number } = {}): void {
  const db = getDatabase().db
  const now = opts.createdAt ?? 1000
  db.prepare("INSERT OR IGNORE INTO sessions(id, project_path, started_at) VALUES ('s1', ?, ?)").run(NS, now)
  db.prepare(
    `INSERT INTO memories (id, session_id, project_path, namespace, content, type, importance, tags, created_at, valid_from, ident_text)
     VALUES (?, 's1', ?, ?, ?, ?, 0.5, '[]', ?, ?, ?)`
  ).run(id, opts.namespace ?? NS, opts.namespace ?? NS, content, opts.type ?? 'note', now, now, normalizeIdentifiers(content))
}

async function post(path: string, body: unknown): Promise<{ status: number; json: DeliveryResponse }> {
  const res = await createServer().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as DeliveryResponse }
}

describe('delivery routes', () => {
  beforeEach(() => {
    resetDatabase()
    getDatabase(':memory:')
  })

  it('serves the namespace roster with previews', async () => {
    seed('a', 'a decision worth recalling at session start', { type: 'decision' })

    const { status, json } = await post('/delivery/roster', { namespace: NS })
    expect(status).toBe(200)
    expect(json.entries?.map((entry) => entry.id)).toEqual(['a'])
    expect(json.entries?.[0].preview).toBe('a decision worth recalling at session start')
  })

  it('clips roster previews and keeps the roster scoped to the exact namespace', async () => {
    seed('long', 'x'.repeat(500))
    seed('child', 'a memory stored under a sub-namespace', { namespace: CHILD })
    seed('elsewhere', 'another project', { namespace: OTHER })

    const { json } = await post('/delivery/roster', { namespace: NS })
    const entries = json.entries ?? []
    expect(entries.map((entry) => entry.id)).toEqual(['long'])
    expect(entries[0].preview?.length).toBe(200)
    expect(entries[0].preview?.endsWith('…')).toBe(true)
  })

  it('rejects a roster request without a namespace instead of guessing', async () => {
    const { status, json } = await post('/delivery/roster', {})
    expect(status).toBe(400)
    expect(json.entries).toBeUndefined()
  })

  it('answers a cue with the memories matching the file, sub-namespaces included', async () => {
    seed('a', 'gotcha in src/delivery/hook.ts', { type: 'gotcha' })
    seed('child', 'the api package gotcha for src/delivery/hook.ts', { type: 'bug', namespace: CHILD })
    seed('note', 'note mentioning src/delivery/hook.ts', { type: 'note' })
    seed('elsewhere', 'gotcha about src/delivery/hook.ts', { type: 'gotcha', namespace: OTHER })

    const { status, json } = await post('/delivery/cue', { namespace: NS, path: `${NS}/src/delivery/hook.ts` })
    expect(status).toBe(200)
    expect(json.entries?.map((entry) => entry.id).sort()).toEqual(['a', 'child'])
    expect(json.entries?.[0].content).toContain('hook.ts')
  })

  it('rejects a cue without a path', async () => {
    const { status, json } = await post('/delivery/cue', { namespace: NS })
    expect(status).toBe(400)
    expect(json.error).toContain('path')
  })

  it('answers an unparseable body with 400, not a 500', async () => {
    const { status } = await post('/delivery/roster', 'not json')
    expect(status).toBe(400)
  })
})

/** the hook posts to a daemon over http; here the same payloads go to this server */
function hookFetch(requests: string[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    requests.push(path)
    return createServer().request(path, init)
  }) as unknown as typeof fetch
}

const stateDirs: string[] = []

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-cue-window-'))
  stateDirs.push(dir)
  return dir
}

/** an empty token is no token, so the hook reaches the loopback server as its owner */
const HOOK_ENV: NodeJS.ProcessEnv = { ENGRAM_DEFAULT_NAMESPACE: NS, ENGRAM_AUTH_TOKEN: '' }
const SESSION = { cwd: NS, session_id: 'session-a' }
const EDIT = { ...SESSION, tool_name: 'Edit', tool_input: { file_path: `${NS}/src/delivery/hook.ts` } }
const CUE = 'the retry loop in src/delivery/hook.ts double-counts on abort'

describe('cue continuity across a compaction', () => {
  beforeEach(() => {
    resetDatabase()
    getDatabase(':memory:')
  })

  afterEach(() => {
    for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('re-delivers the cue the compaction dropped, once per window', async () => {
    seed('m1', CUE, { type: 'gotcha' })
    const options = { env: HOOK_ENV, stateDir: stateDir(), fetchImpl: hookFetch() }

    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')
    expect(await renderHook('pre-tool-use', EDIT, options)).toBe('')

    await renderHook('post-compact', SESSION, options)

    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')
    expect(await renderHook('pre-tool-use', EDIT, options)).toBe('')
  })

  it('opens one window for the boundary pair a single compaction reports', async () => {
    seed('m1', CUE, { type: 'gotcha' })
    const options = { env: HOOK_ENV, stateDir: stateDir(), fetchImpl: hookFetch() }

    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')

    await renderHook('post-compact', SESSION, options)
    await renderHook('session-start', { ...SESSION, source: 'compact' }, options)

    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')
    expect(await renderHook('pre-tool-use', EDIT, options)).toBe('')
  })

  it('leaves the window alone for a source that did not rebuild the context', async () => {
    seed('m1', CUE, { type: 'gotcha' })
    const requests: string[] = []
    const options = { env: HOOK_ENV, stateDir: stateDir(), fetchImpl: hookFetch(requests) }

    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')
    const cuesBefore = requests.filter((path) => path === '/delivery/cue').length

    await renderHook('session-start', { ...SESSION, source: 'startup' }, options)

    expect(await renderHook('pre-tool-use', EDIT, options)).toBe('')
    expect(requests.filter((path) => path === '/delivery/cue').length).toBe(cuesBefore + 1)
  })

  it('reopens only the window of the session that compacted', async () => {
    seed('m1', CUE, { type: 'gotcha' })
    const options = { env: HOOK_ENV, stateDir: stateDir(), fetchImpl: hookFetch() }
    const other = { ...EDIT, session_id: 'session-b' }

    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')
    expect(await renderHook('pre-tool-use', other, options)).toContain('double-counts')

    await renderHook('post-compact', SESSION, options)

    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')
    expect(await renderHook('pre-tool-use', other, options)).toBe('')
  })

  it('re-delivers for a second compaction that closes inside the pair delay', async () => {
    seed('m1', CUE, { type: 'gotcha' })
    const options = { env: HOOK_ENV, stateDir: stateDir(), fetchImpl: hookFetch() }

    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')

    await renderHook('post-compact', SESSION, options)
    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')

    await renderHook('post-compact', SESSION, options)
    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')
    expect(await renderHook('pre-tool-use', EDIT, options)).toBe('')
  })

  it('re-delivers for a second compaction the host reports as a session start', async () => {
    seed('m1', CUE, { type: 'gotcha' })
    const options = { env: HOOK_ENV, stateDir: stateDir(), fetchImpl: hookFetch() }
    const compacted = { ...SESSION, source: 'compact' }

    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')

    await renderHook('session-start', compacted, options)
    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')

    await renderHook('session-start', compacted, options)
    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')
    expect(await renderHook('pre-tool-use', EDIT, options)).toBe('')
  })

  it('re-delivers when a second session start follows the pair of the first compaction', async () => {
    seed('m1', CUE, { type: 'gotcha' })
    const options = { env: HOOK_ENV, stateDir: stateDir(), fetchImpl: hookFetch() }
    const compacted = { ...SESSION, source: 'compact' }

    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')

    await renderHook('post-compact', SESSION, options)
    await renderHook('session-start', compacted, options)
    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')
    expect(await renderHook('pre-tool-use', EDIT, options)).toBe('')

    await renderHook('session-start', compacted, options)
    expect(await renderHook('pre-tool-use', EDIT, options)).toContain('double-counts')
  })
})
