export const MEMORY_TYPES = ['note', 'decision', 'bug', 'pattern', 'gotcha', 'todo', 'procedure'] as const

const memoryTypeEnum = {
  type: 'string' as const,
  enum: [...MEMORY_TYPES],
  description: 'Memory category type',
}

const namespaceField = {
  type: 'string',
  description:
    'Namespace to scope this operation. Precedence: namespace > project_path > URL ?namespace= > URL ?project= > ENGRAM_DEFAULT_NAMESPACE > git root.',
}

const projectPathField = {
  type: 'string',
  description: 'Override project path (default: from URL ?project= or git root). Equivalent to namespace.',
}

const includeSupersededField = {
  type: 'boolean',
  default: false,
  description:
    'Include memories that have been superseded by newer contradicting memories. Default false: stale facts are hidden.',
}

export const tools = [
  {
    name: 'store_memory',
    description:
      'Save a memory in the current session. Computes a local embedding, links to semantically related memories (Zettelkasten), and queues an LLM-backed contradiction check.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory content to store' },
        type: { ...memoryTypeEnum, default: 'note' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        importance: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Importance 0.0–1.0 (affects Ebbinghaus decay rate)',
        },
        session_id: { type: 'string', description: 'Session ID (optional, uses current session)' },
        project_path: projectPathField,
        namespace: namespaceField,
        adjudicate_sync: {
          type: 'boolean',
          default: false,
          description:
            'Wait synchronously (up to 2s) for contradiction adjudication to complete before returning. Default false: adjudication runs in background.',
        },
        procedure_meta: {
          type: 'object',
          description: 'Structured procedure metadata (only for type=procedure)',
          properties: {
            preconditions: { type: 'array', items: { type: 'string' } },
            steps: { type: 'array', items: { type: 'string' } },
            postconditions: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['content'],
    },
    annotations: {
      title: 'Store memory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'search_memories',
    description:
      'Hybrid full-text + semantic search. Combines FTS5 (lexical) and local vector embeddings via Reciprocal Rank Fusion, re-ranked by query archetype + Ebbinghaus decay. Hides superseded memories by default. Set use_reranker=true to refine the top window with a cross-encoder (requires ENGRAM_RERANKER_ENABLED=1; adds ~500-1000ms latency).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        type: { ...memoryTypeEnum },
        project_path: projectPathField,
        namespace: namespaceField,
        before: {
          type: 'number',
          description: 'Unix timestamp (ms). Restrict results to facts valid at/before this time.',
        },
        include_superseded: includeSupersededField,
        use_reranker: {
          type: 'boolean',
          description:
            'Apply bge-reranker-v2-m3 cross-encoder to the top hybrid candidates (default: false; requires ENGRAM_RERANKER_ENABLED=1 to take effect).',
        },
        rerank_top_n: {
          type: 'number',
          description: 'How many top hybrid results to feed the reranker (default: 20, range 2-100).',
        },
      },
      required: ['query'],
    },
    annotations: {
      title: 'Search memories',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'get_context',
    description:
      'Get the most important memories for the current namespace. Call at session start. Ranked by importance × Ebbinghaus retention. Hides superseded memories by default.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: projectPathField,
        namespace: namespaceField,
        limit: { type: 'number', description: 'Max memories to return (default: 20)' },
        before: {
          type: 'number',
          description: 'Unix timestamp (ms). Restrict context to facts valid at/before this time.',
        },
        include_superseded: includeSupersededField,
      },
    },
    annotations: {
      title: 'Get session context',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'search_by_entity',
    description:
      'Find all memories mentioning a specific code entity (file path, function name, class, library, etc). More precise than semantic search for exact symbol lookups.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          description: 'Entity to search for (e.g. "auth.ts", "getUserById", "express")',
        },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        project_path: projectPathField,
        namespace: namespaceField,
        include_superseded: includeSupersededField,
      },
      required: ['entity'],
    },
    annotations: {
      title: 'Search by entity',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'get_related',
    description:
      'Traverse the memory knowledge graph from a starting memory. Depth=1 returns direct links; depth=2+ walks multi-hop connections via recursive CTE. Hides superseded nodes by default.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'Memory ID to find related memories for' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        depth: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          description: 'Graph traversal depth (default: 1, max: 5). Use 2+ for multi-hop knowledge discovery.',
        },
        include_superseded: includeSupersededField,
      },
      required: ['memory_id'],
    },
    annotations: {
      title: 'Get related memories',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'consolidate_memories',
    description:
      'Find near-duplicate memories (cosine similarity above threshold). Returns groups for you to review and merge with forget_memory. Hides superseded memories by default.',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: {
          type: 'number',
          minimum: 0.8,
          maximum: 1.0,
          description: 'Cosine similarity threshold (default: 0.95)',
        },
        project_path: projectPathField,
        namespace: namespaceField,
      },
    },
    annotations: {
      title: 'Find duplicate memories',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'start_session',
    description:
      'Begin a new memory session. Namespace resolved from explicit args, URL params, or git root.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: projectPathField,
        namespace: namespaceField,
        tool_name: { type: 'string', description: 'Calling tool name (e.g. "claude-code")' },
      },
    },
    annotations: {
      title: 'Start session',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'end_session',
    description: 'Close the current session with an optional summary.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID to end' },
        summary: { type: 'string', description: 'Summary of what was accomplished' },
      },
      required: ['session_id'],
    },
    annotations: {
      title: 'End session',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'list_memories',
    description: 'Browse stored memories with optional tag, type, and namespace filters. Hides superseded memories by default.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
        type: { ...memoryTypeEnum },
        limit: { type: 'number', description: 'Max results (default: 20)' },
        project_path: projectPathField,
        namespace: namespaceField,
        include_superseded: includeSupersededField,
      },
    },
    annotations: {
      title: 'List memories',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'forget_memory',
    description: 'Permanently delete a specific memory by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to delete' },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Forget memory',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'pin_memory',
    description:
      'Pin a memory so it always surfaces in get_context, never decays via Ebbinghaus, and is protected from contradiction adjudication. Pinned memories are tier=pinned.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to pin' },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Pin memory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'unpin_memory',
    description:
      'Unpin a memory. It returns to normal Ebbinghaus decay and contradiction adjudication, and its tier is recomputed from importance/access/recency.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to unpin' },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Unpin memory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'get_stats',
    description:
      'Usage statistics: search hit rate, tokens served, estimated context savings in USD. Supports namespace and time-range filters. Use for cross-instance aggregation via install_id.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: namespaceField,
        since: {
          type: 'number',
          description: 'Unix timestamp (ms) to filter events from. Omit for all-time stats.',
        },
      },
    },
    annotations: {
      title: 'Get usage stats',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
]
