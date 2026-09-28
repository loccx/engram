import { describe, it, expect, beforeEach } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { createServer } from '../src/server.js'
import { normalizeIdentifiers } from '../src/db/lexical-index.js'

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
