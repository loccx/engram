import { AUDIT_LOG_FILE } from '../brains/paths.js'

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
        scope: {
          type: 'string',
          description:
            'Optional: store into a synthetic scope namespace `<project>//<scope>` (single path segment, ≤64 chars, no "/"). When omitted, routing is: word-boundary mention of an existing sibling scope, then LLM inference over existing scopes, then the project root. Response reports the effective namespace, routed_scope, and routed_via (explicit|mention|inferred|root).',
        },
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
        as_of: {
          type: 'number',
          description:
            'Unix timestamp (ms). Historical view: returns facts valid at this exact time (valid_from <= as_of <= valid_until — both boundaries inclusive) with time-aware supersession, so facts superseded after as_of still appear. Prefer over the legacy `before` field.',
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
      'Get memories for the current namespace. With a query, scopes retrieval through hybrid FTS5+vector search and returns full content; funnel scope (default for path-shaped namespaces) searches the deepest namespace first, then ascends thin ancestor nav layers for guide excerpts when the leaf is thin. Without a query, returns a compact roster only — id, type, importance, tags, and a ~160-char preview; full content requires a query or get_memory. Hides superseded memories by default.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: projectPathField,
        namespace: namespaceField,
        query: {
          type: 'string',
          description: 'Scope results to this task/topic via hybrid search and receive full content. Omitting it degrades the response to a compact roster (previews only).',
        },
        limit: { type: 'number', description: 'Max memories to return (default: 20)' },
        scope: {
          type: 'string',
          enum: ['leaf', 'funnel'],
          description:
            'Retrieval scope. funnel (default for path-shaped namespaces): search the deepest scope first, then ascend thin ancestor nav layers for guide excerpts only when the leaf yields few or weak hits. leaf: search the single namespace only.',
        },
        strict_scope: {
          type: 'boolean',
          description:
            'When false, the leaf search expands to the namespace subtree (namespace/* and namespace//* descendants). Default true restricts to the exact namespace; sibling namespaces are never included.',
        },
        before: {
          type: 'number',
          description: 'Unix timestamp (ms). Restrict context to facts valid at/before this time.',
        },
        as_of: {
          type: 'number',
          description:
            'Unix timestamp (ms). Historical view with time-aware supersession (see search_memories.as_of). Present-state digest and topic summaries are omitted and reported through as_of_limitations. Prefer over the legacy `before` field.',
        },
        compact_content: {
          type: 'boolean',
          description:
            'Query path only: truncate long content to ~400 chars + ellipsis. Without this flag, the query path returns full content. Ignored on the blanket (no-query) path, which is always a roster.',
        },
        compact_topics: {
          type: 'boolean',
          description:
            'No-op: topics are summarized to a 5-id sample + member_count by default on both paths. Accepted for backward compatibility.',
        },
        full_content: {
          type: 'boolean',
          description:
            'Legacy alias: keeps the query path on untruncated content. Has no effect on the blanket (no-query) path, which never serves full content.',
        },
        full_topics: {
          type: 'boolean',
          description:
            'Forces complete cluster member_ids on both paths. Topics are summarized by default otherwise.',
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
        as_of: {
          type: 'number',
          description: 'Unix timestamp (ms). Historical view (see search_memories.as_of).',
        },
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
        id: { type: 'string', description: 'Memory ID to find related memories for' },
        memory_id: {
          type: 'string',
          description:
            'Deprecated alias for id, retained for backward compatibility with pre-rename clients. When both are set, id wins.',
        },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        depth: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          description: 'Graph traversal depth (default: 1, max: 5). Use 2+ for multi-hop knowledge discovery.',
        },
        include_superseded: includeSupersededField,
      },
      required: [],
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
        as_of: {
          type: 'number',
          description: 'Unix timestamp (ms). Historical view (see search_memories.as_of).',
        },
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
    name: 'get_memory',
    description:
      'Fetch a single memory by ID with its full enriched payload (entities, links, importance signals).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID' },
        as_of: {
          type: 'number',
          description:
            'Unix timestamp (ms). When set, returns the member of the explicit manual revision chain (supersedes links with revision > 0) that was current at that time, respecting when each revision link was judged, instead of the literal row.',
        },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Get memory',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'update_memory',
    description:
      'Patch a memory in place. Supported fields: type, importance, tags, valid_until. Setting importance flips importance_source to "user" and prevents LLM rescoring.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to patch' },
        type: { ...memoryTypeEnum },
        importance: { type: 'number', minimum: 0, maximum: 1, description: 'New importance 0.0–1.0' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tag list' },
        valid_until: {
          type: ['number', 'null'],
          description: 'Unix timestamp (ms) when this fact stops being valid. Pass null to clear.',
        },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Update memory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'set_pin',
    description:
      'Pin or unpin a memory. Pinned memories always surface in get_context, never decay via Ebbinghaus, and are protected from contradiction adjudication.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID' },
        pinned: { type: 'boolean', description: 'true = pin, false = unpin' },
      },
      required: ['id', 'pinned'],
    },
    annotations: {
      title: 'Set pin state',
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
  {
    name: 'list_brains',
    description:
      'List local engram brains (owned + followed). Returns name, memory count, owner, embedding model, description, and whether the decrypted cache is present.',
    inputSchema: { type: 'object', properties: {} },
    annotations: {
      title: 'List brains',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'search_brain',
    description:
      'Full-text search within a specific followed/owned brain. Caller must name the brain explicitly; cross-brain access is never implicit.',
    inputSchema: {
      type: 'object',
      properties: {
        brain: { type: 'string', description: 'Brain name (as shown by list_brains)' },
        query: { type: 'string', description: 'FTS5 query string' },
        limit: { type: 'number', default: 10, description: 'Max results (default 10)' },
      },
      required: ['brain', 'query'],
    },
    annotations: {
      title: 'Search a specific brain',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'get_brain_memory',
    description: 'Fetch a single memory by ID from a named brain.',
    inputSchema: {
      type: 'object',
      properties: {
        brain: { type: 'string', description: 'Brain name' },
        id: { type: 'string', description: 'Memory ID' },
      },
      required: ['brain', 'id'],
    },
    annotations: {
      title: 'Get brain memory',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'mark_shareable',
    description:
      `Mark a local memory as shareable (or unshareable) so it will be included in the next brain snapshot. Default for every memory is NOT shareable. Writes to ${AUDIT_LOG_FILE} for prompt-injection defense.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to flag' },
        shareable: { type: 'boolean', default: true, description: 'true to mark shareable, false to revoke' },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Mark memory shareable',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'revise_memory',
    description:
      'Append-only content revision: creates a NEW memory row linked to the original by a deterministic confidence=1 supersedes edge, closes the predecessor\'s validity window, and returns the version number. History and audit events are preserved; content is never edited in place. The predecessor keeps its pinned status OFF so digests always track current content. Shareable is never inherited — pass shareable=true to opt the revision into brain export.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to revise' },
        content: { type: 'string', description: 'New content (min 1 char)' },
        reason: { type: 'string', description: 'Why the revision was made (stored on the supersedes link)' },
        type: { ...memoryTypeEnum },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags (default: inherit from predecessor)' },
        session_id: { type: 'string', description: 'Session for the revision (default: predecessor\'s session)' },
        shareable: {
          type: 'boolean',
          description: 'Explicit opt-in to mark the revision shareable. NEVER inherited from the predecessor.',
        },
      },
      required: ['id', 'content'],
    },
    annotations: {
      title: 'Revise memory (append-only)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'get_memory_history',
    description:
      'Audit a memory\'s whole supersession chain: versions oldest-first plus the supersedes links between them. This is the BROAD audit view (not recall): it spans ALL supersedes edges — manual revisions AND LLM-adjudicated contradictions, confidence-agnostic — so chain members can include unrelated adjudicated memories. Optional as_of filters the returned versions to facts valid at that time; the links list still shows every edge found.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID — any member of the chain works' },
        as_of: {
          type: 'number',
          description: 'Unix timestamp (ms). Filter chain members to facts valid at this time.',
        },
        limit: { type: 'number', default: 50, maximum: 500, description: 'Max versions returned (default 50)' },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Get memory history',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'recall_context',
    description:
      'Progressive recall with a strict character budget. Digest text, memory content, and topic summaries are packed deterministically (digest first, then top-ranked memories, then topics) and the payload reports budget usage, drops, and truncations. Read-only and repeatable: hybrid search never stamps last_accessed here. Modes: fused (hybrid + digest + topics), hybrid, entity (query as entity name), graph (PPR walk from seed_id). Content characters are the budget unit; JSON transport overhead is not charged. When as_of is set, the present-state digest and topic summary text are omitted (flagged via as_of_limitations) because neither is reconstructable at that time; topic member_ids remain filtered to facts valid at as_of.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query (entity text in entity mode)' },
        budget_chars: { type: 'number', minimum: 50, description: 'Strict content-character budget' },
        mode: {
          type: 'string',
          enum: ['fused', 'hybrid', 'graph', 'entity'],
          default: 'fused',
          description: 'Retrieval mode (default merged hybrid+digest+topics)',
        },
        seed_id: { type: 'string', description: 'Required for graph mode: starting memory id' },
        limit: { type: 'number', default: 10, maximum: 100, description: 'Candidate cap per branch' },
        min_trust: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0,
          description: 'Minimum composite trust score (pinned memories bypass)',
        },
        project_path: projectPathField,
        namespace: namespaceField,
        as_of: {
          type: 'number',
          description:
            'Unix timestamp (ms). Historical view (see search_memories.as_of). Present-state digest and topic summary text are omitted in historical results and flagged via as_of_limitations; topic member_ids stay filtered to facts valid at as_of.',
        },
      },
      required: ['query', 'budget_chars'],
    },
    annotations: {
      title: 'Progressive recall',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'get_maintenance_status',
    description:
      'Read-only view of the durable maintenance job queue: counts by status/type plus recent jobs. Maintenance jobs run in safe shadow mode — they inspect state and record summaries into result_json but never write canonical memories, digests, clusters, importance, or contradiction links.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 20, maximum: 200, description: 'Recent jobs to return' },
      },
    },
    annotations: {
      title: 'Maintenance status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'run_pending_maintenance',
    description:
      'Bounded run of pending maintenance jobs (lease-based claim, shadow mode only — see get_maintenance_status). Returns claimed/done/failed counts. Safe to run at any time; shadow handlers never mutate canonical state.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 20, maximum: 100, description: 'Max jobs to claim this run' },
      },
    },
    annotations: {
      title: 'Run pending maintenance',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
]
