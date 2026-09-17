import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The export gate (memories.shareable) is the only thing standing between an
 * agent and publishing the owner's memory. `mark_shareable` writes an audit
 * event; `revise_memory` can set the same flag without going through it, which
 * would leave the spec's only defense blind. These tests pin that every path
 * which flips the flag leaves a record.
 *
 * The real audit log is never touched: the path comes from ENGRAM_AUDIT_LOG,
 * and modules are re-imported after it is set because paths.ts reads it once.
 */
const TEST_PROJECT = '/home/user/audit-project'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
}

type Handlers = typeof import('../src/mcp/handlers.js')
type DbInit = typeof import('../src/db/init.js')

let handleTool: Handlers['handleTool']
let resetServicesForTests: Handlers['resetServicesForTests']
let getDatabase: DbInit['getDatabase']
let resetDatabase: DbInit['resetDatabase']

let tmp: string
let auditPath: string

function parse<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T
}

function readEvents(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return []
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('brains audit trail for shareable flips', () => {
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-audit-'))
    auditPath = join(tmp, 'audit.log')
    process.env.ENGRAM_AUDIT_LOG = auditPath
    vi.resetModules() // paths.ts captured the path at import time
    const handlers = await import('../src/mcp/handlers.js')
    const db = await import('../src/db/init.js')
    handleTool = handlers.handleTool
    resetServicesForTests = handlers.resetServicesForTests
    getDatabase = db.getDatabase
    resetDatabase = db.resetDatabase
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  afterEach(() => {
    delete process.env.ENGRAM_AUDIT_LOG
    rmSync(tmp, { recursive: true, force: true })
  })

  it('revise_memory with shareable=true appends exactly one mark_shareable event', async () => {
    const stored = parse<{ id: string }>(
      await handleTool('store_memory', { content: 'redis caches sessions', project_path: TEST_PROJECT })
    )
    expect(readEvents()).toEqual([]) // nothing is logged merely by storing

    const revised = parse<{ id: string }>(
      await handleTool('revise_memory', {
        id: stored.id,
        content: 'redis caches sessions, trimmed',
        shareable: true,
        reason: 'make publishable',
      })
    )
    expect(revised.id).toBeTruthy()

    const events = readEvents().filter((e) => e.type === 'mark_shareable' || e.type === 'unmark_shareable')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('mark_shareable')
    expect(events[0].namespace).toBe(TEST_PROJECT)
    expect(events[0].memory_id).toBe(revised.id)
    expect(events[0].actor).toBe('mcp')
    expect(typeof events[0].ts).toBe('number')
  })

  it('a content-only revision appends no shareable event', async () => {
    const stored = parse<{ id: string }>(
      await handleTool('store_memory', { content: 'sqlite wal mode', project_path: TEST_PROJECT })
    )
    await handleTool('revise_memory', { id: stored.id, content: 'sqlite WAL mode, clarified' })
    expect(readEvents().filter((e) => String(e.type).includes('shareable'))).toEqual([])
  })

  it('the unmark path still logs unmark_shareable (regression guard)', async () => {
    const stored = parse<{ id: string }>(
      await handleTool('store_memory', { content: 'pg jsonb', project_path: TEST_PROJECT })
    )
    await handleTool('mark_shareable', { id: stored.id, shareable: true })
    await handleTool('mark_shareable', { id: stored.id, shareable: false })

    const events = readEvents().filter((e) => String(e.type).includes('shareable'))
    expect(events.map((e) => e.type)).toEqual(['mark_shareable', 'unmark_shareable'])
    for (const e of events) expect(e.memory_id).toBe(stored.id)
  })

  it('never writes to the real audit log', async () => {
    const stored = parse<{ id: string }>(
      await handleTool('store_memory', { content: 'guard probe', project_path: TEST_PROJECT })
    )
    await handleTool('revise_memory', { id: stored.id, content: 'guard probe v2', shareable: true })
    expect(auditPath.startsWith(tmp)).toBe(true)
    expect(readEvents().length).toBeGreaterThan(0)
  })
})
