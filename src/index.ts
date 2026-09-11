#!/usr/bin/env node
import { Command } from 'commander'
import { readPid, isRunning, removePid } from './utils/pid.js'
import { registerBrainCommands } from './cli/brain.js'
import { ENGRAM_VERSION } from './version.js'

const program = new Command()

program.name('engram').description('Local MCP memory daemon for AI coding tools').version(ENGRAM_VERSION)

program
  .command('start')
  .description('Start the Engram daemon')
  .option('-p, --port <port>', 'Port to listen on', '8888')
  .option('-n, --namespace <namespace>', 'Default namespace when callers do not specify one (overrides git-root detection)')
  .action(async (opts: { port: string; namespace?: string }) => {
    const existingPid = readPid()
    if (existingPid && isRunning(existingPid)) {
      try {
        const res = await fetch(`http://localhost:${opts.port}/health`)
        if (res.ok) {
          console.log(`Engram is already running (PID ${existingPid}) on port ${opts.port}`)
          process.exit(0)
        }
      } catch {
        // requested port isn't serving; fall through to the warning below
      }
      console.log(
        `Engram is already running (PID ${existingPid}), but not responding on port ${opts.port}. ` +
          `Only one engram daemon can run at a time; --port ${opts.port} was ignored. ` +
          `Run \`engram stop\` first if you need to restart on a different port.`
      )
      process.exit(0)
    }

    if (opts.namespace) {
      process.env.ENGRAM_DEFAULT_NAMESPACE = opts.namespace
    }

    const { startDaemon } = await import('./daemon.js')
    await startDaemon(parseInt(opts.port, 10))
  })

program
  .command('stop')
  .description('Stop the Engram daemon')
  .action(() => {
    const pid = readPid()
    if (!pid || !isRunning(pid)) {
      console.log('Engram daemon is not running')
      removePid()
      return
    }
    process.kill(pid, 'SIGTERM')
    removePid()
    console.log(`Engram daemon stopped (PID ${pid})`)
  })

program
  .command('status')
  .description('Check daemon status')
  .option('-p, --port <port>', 'Port', '8888')
  .action(async (opts: { port: string }) => {
    const pid = readPid()
    if (!pid || !isRunning(pid)) {
      console.log('Engram daemon is not running')
      process.exit(1)
    }

    try {
      const res = await fetch(`http://localhost:${opts.port}/health`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as Record<string, unknown>
      const uptimeSec = Math.floor((data.uptime as number) / 1000)
      console.log(`Status: ${data.status}`)
      console.log(`PID:    ${pid}`)
      console.log(`Uptime: ${uptimeSec}s`)
      console.log(`Memories: ${data.memoryCount}`)
      console.log(`Sessions: ${data.sessionCount}`)
    } catch {
      console.log(`Daemon is running (PID ${pid}) but health check failed`)
    }
  })

program
  .command('search <query>')
  .description('Search memories')
  .option('-p, --port <port>', 'Port', '8888')
  .option('-l, --limit <limit>', 'Max results', '10')
  .option('-t, --type <type>', 'Filter by memory type')
  .action(async (query: string, opts: { port: string; limit: string; type?: string }) => {
    try {
      const params: Record<string, unknown> = { query, limit: parseInt(opts.limit, 10) }
      if (opts.type) params.type = opts.type

      const res = await fetch(`http://localhost:${opts.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'search_memories', params, id: 1 }),
      })
      const data = await res.json() as { result?: { content?: Array<{ text: string }> }; error?: { message: string } }
      if (data.error) { console.error('Error:', data.error.message); process.exit(1) }

      const results = JSON.parse(data.result?.content?.[0]?.text ?? '[]') as unknown[]
      if (results.length === 0) {
        console.log('No memories found')
      } else {
        console.log(JSON.stringify(results, null, 2))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('Failed to connect to Engram daemon:', msg)
      process.exit(1)
    }
  })

program
  .command('ls')
  .description('List memories')
  .option('-p, --port <port>', 'Port', '8888')
  .option('-l, --limit <limit>', 'Max results', '20')
  .option('-t, --type <type>', 'Filter by memory type')
  .option('--tags <tags>', 'Filter by tags (comma-separated)')
  .action(async (opts: { port: string; limit: string; type?: string; tags?: string }) => {
    try {
      const params: Record<string, unknown> = { limit: parseInt(opts.limit, 10) }
      if (opts.type) params.type = opts.type
      if (opts.tags) params.tags = opts.tags.split(',').map((t) => t.trim())

      const res = await fetch(`http://localhost:${opts.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'list_memories', params, id: 1 }),
      })
      const data = await res.json() as { result?: { content?: Array<{ text: string }> }; error?: { message: string } }
      if (data.error) { console.error('Error:', data.error.message); process.exit(1) }

      const results = JSON.parse(data.result?.content?.[0]?.text ?? '[]') as unknown[]
      if (results.length === 0) {
        console.log('No memories found')
      } else {
        console.log(JSON.stringify(results, null, 2))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('Failed to connect to Engram daemon:', msg)
      process.exit(1)
    }
  })

program
  .command('stats')
  .description('Show usage statistics and estimated context savings')
  .option('-p, --port <port>', 'Port', '8888')
  .option('-n, --namespace <namespace>', 'Filter by namespace')
  .option('--json', 'Output raw JSON')
  .action(async (opts: { port: string; namespace?: string; json?: boolean }) => {
    try {
      const params: Record<string, unknown> = {}
      if (opts.namespace) params.namespace = opts.namespace

      const res = await fetch(`http://localhost:${opts.port}/metrics${opts.namespace ? `?namespace=${encodeURIComponent(opts.namespace)}` : ''}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const stats = await res.json() as Record<string, unknown>

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2))
        return
      }

      const searches = stats.searches as { total: number; hits: number; hit_rate: number }
      const savings = stats.estimated_context_savings as { tokens: number; tokens_realistic: number; estimated_usd_saved: number }

      console.log(`Install ID:       ${stats.install_id}`)
      console.log(`Memories stored:  ${stats.memories_stored}`)
      console.log(`Searches:         ${searches.total} (${searches.hits} hits, ${Math.round(searches.hit_rate * 100)}% hit rate)`)
      console.log(`Context loads:    ${stats.context_loads}`)
      console.log(`Tokens served:    ${(stats.tokens_served as number).toLocaleString()}`)
      console.log(`Results served:   ${stats.results_served}`)
      console.log()
      console.log(`Estimated savings:`)
      console.log(`  Tokens saved:   ~${savings.tokens_realistic.toLocaleString()} (3x multiplier for raw file reads)`)
      console.log(`  USD saved:      ~$${savings.estimated_usd_saved.toFixed(2)} (at Claude Sonnet input pricing)`)

      const perNs = stats.per_namespace as Array<{ namespace: string; tokens_served: number; searches: number; search_hit_rate: number }>
      if (perNs && perNs.length > 0) {
        console.log()
        console.log(`Per namespace:`)
        for (const ns of perNs) {
          console.log(`  ${ns.namespace}: ${ns.tokens_served.toLocaleString()} tokens, ${ns.searches} searches (${Math.round(ns.search_hit_rate * 100)}% hit rate)`)
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('Failed to connect to Engram daemon:', msg)
      process.exit(1)
    }
  })

program
  .command('warm')
  .description('Pre-download and cache the embedding model (~23MB, one-time)')
  .action(async () => {
    console.log('Warming embedding model...')
    const { warmEmbeddings } = await import('./embeddings/pipeline.js')
    const ok = await warmEmbeddings()
    if (ok) {
      console.log('Embedding model ready. Semantic search is now available.')
    } else {
      console.error('Failed to load embedding model. Check your internet connection.')
      process.exit(1)
    }
  })

program
  .command('rebuild-vectors')
  .description('Recompute embeddings for all memories with missing vec_rowid')
  .option('--project <path>', 'Only rebuild for a specific project_path')
  .action(async (opts: { project?: string }) => {
    const { getDatabase } = await import('./db/init.js')
    const { getEmbedding, LINK_DISTANCE_THRESHOLD } = await import('./embeddings/pipeline.js')

    const dbm = getDatabase()
    if (!dbm.vectorsAvailable) {
      console.error('sqlite-vec is not available. Cannot rebuild vectors.')
      process.exit(1)
    }

    const condition = opts.project ? 'AND project_path = ?' : ''
    const params: unknown[] = opts.project ? [opts.project] : []

    const rows = dbm.db
      .prepare(`SELECT id, content FROM memories WHERE vec_rowid IS NULL ${condition}`)
      .all(...params) as Array<{ id: string; content: string }>

    console.log(`Found ${rows.length} memories without embeddings.`)
    if (rows.length === 0) { process.exit(0) }

    let success = 0
    let failed = 0

    for (const row of rows) {
      try {
        const embedding = await getEmbedding(row.content)
        if (!embedding) { failed++; continue }

        const vecInfo = dbm.db
          .prepare('INSERT INTO memory_vectors(embedding) VALUES (?)')
          .run(JSON.stringify(Array.from(embedding)))
        const vecRowid = Number(vecInfo.lastInsertRowid)
        dbm.db.prepare('UPDATE memories SET vec_rowid = ? WHERE id = ?').run(vecRowid, row.id)

        const queryVec = JSON.stringify(Array.from(embedding))
        const neighbors = dbm.db
          .prepare(
            `SELECT knn.rowid, knn.distance, m.id
             FROM (SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? LIMIT 20) knn
             JOIN memories m ON m.vec_rowid = knn.rowid`
          )
          .all(queryVec) as Array<{ rowid: number; distance: number; id: string }>

        const toLink = neighbors.filter(
          (r) => r.id !== row.id && r.distance < LINK_DISTANCE_THRESHOLD
        )
        const now = Date.now()
        const insertLink = dbm.db.prepare(
          `INSERT OR IGNORE INTO memory_links (source_id, target_id, similarity, link_type, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        for (const { id: targetId, distance } of toLink) {
          const sim = Math.max(0, 1 - (distance * distance) / 2)
          insertLink.run(row.id, targetId, sim, 'semantic', now)
          insertLink.run(targetId, row.id, sim, 'semantic', now)
        }

        success++
        if (success % 10 === 0) process.stderr.write(`  ${success}/${rows.length}\n`)
      } catch {
        failed++
      }
    }

    console.log(`Done. ${success} embedded, ${failed} failed.`)
    dbm.close()
  })

registerBrainCommands(program)

program.parse()
