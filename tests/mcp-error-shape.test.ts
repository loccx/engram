import { describe, it, expect, beforeEach } from 'vitest'
import { getDatabase, resetDatabase } from '../src/db/init.js'
import { handleTool, resetServicesForTests } from '../src/mcp/handlers.js'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const PROJECT = '/home/user/mcp-error-shape'

describe('MCP tool result error shape', () => {
  beforeEach(() => {
    resetDatabase()
    resetServicesForTests()
    getDatabase(':memory:')
  })

  it('sets isError on validation failures so clients can distinguish them', async () => {
    const result = (await handleTool('store_memory', {}, { urlProject: PROJECT })) as ToolResult
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toMatch(/validation failed/i)
  })

  it('does not set isError on successful results', async () => {
    const result = (await handleTool('get_stats', {}, { urlProject: PROJECT })) as ToolResult
    expect(result.isError).toBeUndefined()
  })

  it('mark_shareable is scoped to the namespace the client is connected to', async () => {
    await handleTool('store_memory', { content: 'belongs to project a', project_path: '/ns/a' }, { urlProject: '/ns/a' })

    const context = JSON.parse(
      (await handleTool('get_context', { project_path: '/ns/a' }, { urlProject: '/ns/a' })).content[0].text
    ) as { memories: Array<{ id: string }> }
    const id = context.memories[0]?.id
    expect(id).toBeTruthy()

    const denied = (await handleTool('mark_shareable', { id }, { urlProject: '/ns/b' })) as ToolResult
    expect(denied.isError).toBe(true)
    expect(denied.content[0].text).toMatch(/outside the caller/i)

    const allowed = (await handleTool('mark_shareable', { id }, { urlProject: '/ns/a' })) as ToolResult
    expect(allowed.isError).toBeUndefined()
  })

  it('mark_shareable keeps legacy behavior when the request declares no namespace', async () => {
    await handleTool('store_memory', { content: 'legacy caller memory', project_path: '/ns/legacy' })
    const context = JSON.parse(
      (await handleTool('get_context', { project_path: '/ns/legacy' })).content[0].text
    ) as { memories: Array<{ id: string }> }
    const id = context.memories[0]?.id
    expect(id).toBeTruthy()

    const result = (await handleTool('mark_shareable', { id })) as ToolResult
    expect(result.isError).toBeUndefined()
  })
})
