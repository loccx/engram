import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { createServer } from '../src/server.js'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'


const execFileAsync = promisify(execFile)
const TEST_PROJECT = '/home/user/cli-project'

let server: Server
let port: number
let tmpDir: string
let cliClientDbPath: string

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', join(process.cwd(), 'src', 'index.ts'), ...args],
    {
      cwd: process.cwd(),
      // the CLI is a pure HTTP client here: the db path must never be created
      env: { ...process.env, ENGRAM_DB_PATH: cliClientDbPath, ENGRAM_DATA_DIR: tmpDir },
      timeout: 30_000,
    }
  )
  return { stdout: result.stdout, stderr: result.stderr }
}

describe('CLI against an isolated daemon', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'engram-cli-'))
    cliClientDbPath = join(tmpDir, 'must-not-be-created.db')
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
    await handleTool('store_memory', {
      content: 'Rotation policy: deploys run from the release branch only',
      project_path: TEST_PROJECT,
      type: 'decision',
      tags: ['deploy'],
    })
    server = serve({ fetch: createServer().fetch, port: 0 })
    await once(server, 'listening')
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    server.close()
    resetDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('engram search returns the memories (tools/call envelope, object payload)', async () => {
    const { stdout } = await runCli([
      'search',
      'rotation policy',
      '--port',
      String(port),
      '--namespace',
      TEST_PROJECT,
    ])
    const parsed = JSON.parse(stdout) as Array<{ content: string; namespace: string }>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].content).toContain('Rotation policy')
    expect(parsed[0].namespace).toBe(TEST_PROJECT)
  })

  it('engram ls returns the memory list', async () => {
    const { stdout } = await runCli([
      'ls',
      '--port',
      String(port),
      '--tags',
      'deploy',
      '--namespace',
      TEST_PROJECT,
    ])
    const parsed = JSON.parse(stdout) as Array<{ content: string; type: string }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0].type).toBe('decision')
  })

  it('applies the type filter it advertises', async () => {
    const { stdout } = await runCli([
      'ls',
      '--port',
      String(port),
      '--type',
      'note',
      '--namespace',
      TEST_PROJECT,
    ])
    expect(stdout).toContain('No memories found')
  })

  it('reports no results rather than a parse error for a miss', async () => {
    // an empty namespace, so a hit cannot be a consolation match
    const { stdout } = await runCli([
      'search',
      'zzz-nothing-matches-zzz',
      '--port',
      String(port),
      '--namespace',
      '/home/user/cli-empty',
    ])
    expect(stdout).toContain('No memories found')
    expect(stdout).toContain('no results in /home/user/cli-empty')
  })

  it('never touches the local database (the CLI is a client, not a daemon)', () => {
    expect(existsSync(cliClientDbPath)).toBe(false)
  })
})
