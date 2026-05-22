⏺ Building Engram from scratch                                                                                                                                              
                                                                                                                                                                          
  The mental model: you're building a local HTTP server that (1) persists notes to SQLite, (2) makes them searchable, and (3) speaks MCP so AI tools can call it. Each step 
  adds one capability.                                                                                                                                                    
                                                                                                                                                                            
  ---                                                                                                                                                                     
  Step 1: The database                                                                                                                                                      
                                                                                                                                                                            
  Everything starts with src/db/init.ts. This is the foundation everything else touches.


```
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

export class DatabaseManager {
readonly db: Database.Database
vectorsAvailable = false

constructor(dbPath?: string) {
    this.db = new Database(resolvedPath)
    this.init()
}

private init(): void {
    this.db.pragma('journal_mode = WAL')   // concurrent reads
    this.db.pragma('foreign_keys = ON')

    // load the vector search extension
    sqliteVec.load(this.db)
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(embedding float[384])`)
    this.vectorsAvailable = true

    this.db.exec(SCHEMA)  // create all tables
}
}
```

  Three things happen on startup: WAL mode (so multiple tools can read simultaneously), loading the sqlite-vec extension (adds vector search to SQLite), and running the
  schema.

  The schema defines five tables. The important ones:

  -- your actual memories
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'note',
    importance REAL NOT NULL DEFAULT 0.5,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    vec_rowid INTEGER   -- points into memory_vectors
  );

  -- full-text search mirror, kept in sync by triggers
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, tags, content=memories, content_rowid=rowid
  );

  -- knowledge graph edges (Zettelkasten links)
  CREATE TABLE IF NOT EXISTS memory_links (
    source_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
    target_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
    similarity REAL NOT NULL
  );

  memories_fts is a virtual table — SQLite maintains it automatically via triggers you define in the schema. Any INSERT/UPDATE/DELETE on memories fires a trigger that keeps
   memories_fts in sync. You never write to it directly.

  vec_rowid is a foreign key into the memory_vectors vec0 table. It's the bridge between the text world and the vector world.

  ---
  Step 2: Storing a memory

  src/memory/store.ts — a class that wraps the DB and handles writes.

  The naive version would just be:
  this.db.prepare(`INSERT INTO memories (...) VALUES (...)`).run(...)

  But we need to also compute and store an embedding. So store() is async:

  async store(input: StoreMemoryInput): Promise<Memory> {
    // 1. write the memory row (sync)
    this.db.prepare(`INSERT INTO memories (...) VALUES (...)`).run(...)
    // FTS5 trigger fires automatically here

    // 2. compute the embedding (async, ~80ms)
    const embedding = await getEmbedding(input.content)

    if (embedding) {
      // 3. insert vector — capture rowid directly from .run()
      //    (can't use SELECT last_insert_rowid() here — FTS5 triggers
      //     fire their own INSERTs and would corrupt that value)
      const info = this.db
        .prepare('INSERT INTO memory_vectors(embedding) VALUES (?)')
        .run(JSON.stringify(Array.from(embedding)))
      const vecRowid = Number(info.lastInsertRowid)

      // 4. link the two tables
      this.db.prepare('UPDATE memories SET vec_rowid = ? WHERE id = ?').run(vecRowid, id)

      // 5. auto-link to semantically similar existing memories
      await this._autoLink(id, vecRowid, embedding)
    }

    return this.getById(id)!
  }

  The _autoLink method is the Zettelkasten part. After inserting the new vector, it searches for existing memories within L2 distance 1.2 (cosine similarity ~0.28) and
  writes edges into memory_links:

  private async _autoLink(newId: string, newVecRowid: number, embedding: Float32Array) {
    const vecResults = this.db.prepare(`
      SELECT knn.rowid, knn.distance, m.id
      FROM (SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? LIMIT 20) knn
      JOIN memories m ON m.vec_rowid = knn.rowid
    `).all(JSON.stringify(Array.from(embedding)))

    for (const { id: targetId, distance } of vecResults.filter(r => r.distance < 1.2)) {
      const sim = Math.max(0, 1 - (distance * distance) / 2)  // L2 → cosine
      insertLink.run(newId, targetId, sim, now)
      insertLink.run(targetId, newId, sim, now)  // bidirectional
    }
  }

  ---
  Step 3: The embedding model

  src/embeddings/pipeline.ts — wraps @huggingface/transformers.

  This is a singleton. You want one model instance shared across all requests, loaded lazily on first use:

  let _pipeline: FeatureExtractionPipeline | null = null
  let _loading: Promise<...> | null = null

  export async function getEmbedding(text: string): Promise<Float32Array | null> {
    if (!_pipeline) {
      if (!_loading) {
        _loading = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })
      }
      _pipeline = await _loading  // all callers await the same promise
    }

    const output = await _pipeline(text.slice(0, 512), { pooling: 'mean', normalize: true })
    return new Float32Array(output.tolist()[0])
  }

  dtype: 'q8' is 8-bit quantization — reduces the model from ~90MB to ~23MB with minimal quality loss. pooling: 'mean' averages the token embeddings into a single 384-dim
  vector. normalize: true makes it a unit vector, which means L2 distance and cosine similarity are mathematically equivalent.

  If the model fails to load (no internet, first run), getEmbedding returns null and the store/search code falls back to FTS5-only. Nothing breaks.

  ---
  Step 4: Searching

  src/memory/search.ts — the most interesting part. hybridSearch() runs three passes:

  Pass 1: FTS5 keyword search
  this.db.prepare(`
    SELECT m.* FROM memories_fts fts
    JOIN memories m ON fts.rowid = m.rowid
    WHERE memories_fts MATCH ?
    ORDER BY fts.rank LIMIT 50
  `).all(safeQuery)

  The query is sanitized by wrapping each token in quotes: "database" "concurrency". This gives FTS5 implicit AND semantics without exposing the caller to FTS5 syntax
  errors.

  Pass 2: Vector semantic search
  this.db.prepare(`
    SELECT m.* FROM
      (SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? LIMIT 50) knn
    JOIN memories m ON m.vec_rowid = knn.rowid
  `).all(JSON.stringify(Array.from(queryEmbedding)))

  sqlite-vec requires the kNN query to be in a subquery with LIMIT — you can't JOIN directly. knn.rowid matches back to memories.vec_rowid.

  Pass 3: Reciprocal Rank Fusion
  const k = 60
  const scores = new Map<string, { rrf: number; memory: Memory }>()

  ftsRows.forEach((m, rank) => {
    scores.set(m.id, { rrf: 1 / (k + rank + 1), memory: m })
  })

  vecRows.forEach((m, rank) => {
    const ex = scores.get(m.id)
    if (ex) ex.rrf += 1 / (k + rank + 1)   // appeared in both → higher score
    else scores.set(m.id, { rrf: 1 / (k + rank + 1), memory: m })
  })

  RRF is simple: a memory ranked #1 in FTS5 gets score 1/61. The same memory ranked #3 in vector search adds another 1/63. A memory appearing in both lists gets a much
  higher combined score than one appearing in just one. The constant k=60 is standard from the original paper — it prevents top-ranked results from dominating too heavily.

  Pass 4: Ebbinghaus decay
  const S = 30 * (memory.importance + 0.3 * Math.log(memory.access_count + 1))
  const R = Math.exp(-tDays / S)
  finalScore = rrf * R * (0.5 + 0.5 * memory.importance)

  S is stability in days. A memory with importance=0.9 and 10 accesses has S ≈ 57 days before decaying to 37%. A throwaway note with importance=0.1 and no accesses has S =
  3 days. The formula comes from MemoryBank (arxiv 2305.10250).

  ---
  Step 5: Sessions

  src/session/detector.ts — one function:

  export async function detectProjectPath(startDir?: string): Promise<string> {
    const gitDir = await findUp('.git', { cwd: startDir ?? process.cwd(), type: 'directory' })
    return gitDir ? dirname(gitDir) : process.cwd()
  }

  find-up walks up the directory tree looking for .git. This is how every git-aware tool (ESLint, Prettier, etc.) finds its project root. If no git repo, falls back to cwd.

  src/session/manager.ts tracks when a tool started/stopped working on a project. It's a thin wrapper around the sessions table — mostly start/end/getCurrentSession
  queries.

  ---
  Step 6: MCP tools

  src/mcp/tools.ts is just data — an array of JSON Schema definitions that tell the AI client what tools exist and what arguments they take:

  {
    name: 'store_memory',
    description: 'Save a memory...',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        importance: { type: 'number', minimum: 0, maximum: 1 },
        ...
      },
      required: ['content']
    }
  }

  src/mcp/handlers.ts is the implementation — a big switch statement that routes tool names to the actual logic:

  export async function handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'store_memory': {
        // detect project, find/create session, call store.store()
      }
      case 'search_memories': {
        // call search.hybridSearch()
      }
      // ... 7 cases total
    }
  }

  All results come back as { content: [{ type: 'text', text: JSON.stringify(data) }] } — that's the MCP response format.

  ---
  Step 7: The HTTP server

  src/server.ts — a Hono app with two routes:

  app.get('/health', (c) => {
    const { count } = db.prepare('SELECT COUNT(*) as count FROM memories').get()
    return c.json({ status: 'ok', uptime: Date.now() - startTime, memoryCount: count })
  })

  app.post('/mcp', async (c) => {
    const { method, params, id } = await c.req.json()

    if (method === 'tools/list') return c.json({ jsonrpc: '2.0', id, result: { tools } })
    if (method === 'tools/call') {
      const result = await handleTool(params.name, params.arguments ?? {})
      return c.json({ jsonrpc: '2.0', id, result })
    }
  })

  That's the entire MCP server. The protocol is just JSON-RPC: the client sends {"method": "tools/call", "params": {"name": "...", "arguments": {...}}}, the server runs the
   tool and returns the result. HTTP instead of stdio means multiple tools connect to the same port simultaneously.

  ---
  Step 8: The daemon and CLI

  src/daemon.ts — starts the server and manages the process lifecycle:

  export async function startDaemon(port = 8888) {
    getDatabase()   // initialize DB and load extensions
    const app = createServer()
    writePid(process.pid)   // write PID file so CLI can find us later

    serve({ fetch: app.fetch, port })

    process.on('SIGTERM', () => { removePid(); process.exit(0) })
    process.on('SIGINT',  () => { removePid(); process.exit(0) })
  }

  src/utils/pid.ts — reads/writes a PID file at ~/Library/Application Support/engram/engram.pid. This is how engram stop finds the running process: read the PID, send
  SIGTERM.

  src/index.ts — Commander CLI that ties everything together:

  program.command('start').action(async (opts) => {
    const { startDaemon } = await import('./daemon.js')
    await startDaemon(parseInt(opts.port))
  })

  program.command('stop').action(() => {
    const pid = readPid()
    process.kill(pid, 'SIGTERM')
  })

  program.command('search <query>').action(async (query) => {
    // POST to /mcp, print results
  })

  ---
  The build order that makes sense

  1. db/init.ts          ← everything depends on this
  2. memory/types.ts     ← shared interfaces
  3. embeddings/pipeline.ts ← embedding model wrapper
  4. memory/store.ts     ← writes (depends on 1, 2, 3)
  5. session/detector.ts ← git root detection
  6. session/manager.ts  ← session lifecycle (depends on 1)
  7. memory/search.ts    ← reads (depends on 1, 2, 3)
  8. mcp/tools.ts        ← JSON Schema definitions (no deps)
  9. mcp/handlers.ts     ← routes tool calls (depends on 4, 6, 7)
  10. server.ts          ← HTTP wrapper (depends on 9)
  11. daemon.ts          ← process lifecycle (depends on 1, 10)
  12. utils/pid.ts       ← PID file helpers
  13. index.ts           ← CLI (depends on 11, 12)

  Each layer only knows about the layers below it. The HTTP server doesn't know about SQLite. The CLI doesn't know about embeddings. This is why you can test the
  store/search logic without starting the server, and why FTS5 fallback works cleanly when embeddings are unavailable.
