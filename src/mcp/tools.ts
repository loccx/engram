
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
      'One durable fact: the why, and where it applies. Worth saving: a decision with its reason, a convention, a gotcha, a value that will not change next week. Not worth saving: session narration, what was NOT found ("no issues", "nothing new"), a secret or credential value, a pasted file, or a near-identical second row. If something changed, call revise_memory on the existing memory instead of adding another. Answers with status stored | deduplicated | rejected: a rejection carries reason and hint, and warnings/conflicts ride along on an accepted write.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            'The fact to store, in full sentences, with the reason it holds. Refused when it carries a secret or joins a burst of near-identical rows; warned when the whole claim is an absence or when it is too thin to be a memory.',
        },
        type: { ...memoryTypeEnum, default: 'note' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        importance: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Importance 0.0–1.0 (affects Ebbinghaus decay rate)',
        },
        pinned: {
          type: 'boolean',
          default: false,
          description:
            'Persist as permanent (tier "pinned"): never decays via Ebbinghaus, always surfaces in get_context, and is protected from contradiction adjudication. Default false. Was accepted by the validator but never advertised, so schema-validating clients could not pin at all.',
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
        state_key: {
          type: 'string',
          description:
            'Slot key for a single-valued fact: a subject+attribute such as "atlas deploy target", or any caller key. Writing the same key again retires the previous value (closes its validity window and links the new row over it), so recall, search and as_of reads serve the current value without waiting for contradiction adjudication. Normalised: trimmed, whitespace collapsed, lowercased. Read the slot back with get_state; the retired values stay queryable with their windows.',
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
    name: 'ingest_episodes',
    description:
      'Ingest raw evidence — one turn or chunk per item — instead of curating it into a memory. Episodes are immutable, deduplicated on (source, external_id), accept partial batches, and are searched by their own channel; a derived memory cites them through memory_episodes. Use it for transcripts, tool output and documents whose detail matters later; keep store_memory for the durable point. Admission runs here too: an item carrying a credential is refused, and the response names the shape, never the value. No llm runs on this path.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'object',
          properties: {
            system: { type: 'string', description: 'Source system, e.g. claude-code, codex, adk, custom' },
            instance: { type: 'string', description: 'Which install of it, e.g. host:user' },
            version: { type: 'string', description: 'Source version' },
          },
          required: ['system'],
          description: 'Where the evidence came from; with external_id it is the idempotency key',
        },
        episodes: {
          type: 'array',
          minItems: 1,
          maxItems: 2000,
          description: 'The evidence itself, in source order; a partial batch is accepted',
          items: {
            type: 'object',
            properties: {
              external_id: {
                type: 'string',
                description: 'The source system\'s own id for this turn or chunk; re-sending it is a no-op',
              },
              content: { type: 'string', description: 'The text as it should be served' },
              session_id: { type: 'string', description: 'Conversation or run this turn belongs to' },
              task_id: { type: 'string', description: 'Task this evidence belongs to, when one is open' },
              author: { type: 'string', description: 'Actor that produced it (user, agent, tool)' },
              role: { type: 'string', description: 'Message role, when the source has one' },
              occurred_at: {
                type: 'number',
                description: 'Unix ms when it happened; the session date in a served timeline',
              },
              content_type: { type: 'string', description: 'Mime type (default text/plain)' },
              uri: { type: 'string', description: 'Where it lives, for a document or a file' },
              turn_index: {
                type: 'number',
                description: 'Position inside the session, so the timeline can be rebuilt in order',
              },
              parent_external_id: { type: 'string', description: 'Item this one derives from' },
              provenance: {
                type: 'object',
                description: 'url, repo, commit, path, tool_call_id — whatever locates the source',
              },
              chunk: {
                type: 'object',
                properties: {
                  index: { type: 'number', description: 'Chunk position, 0-based' },
                  of: { type: 'number', description: 'Chunk count, so a partial ingest is visible' },
                  parent_external_id: {
                    type: 'string',
                    description: 'The whole this chunk was cut from; never lose the whole',
                  },
                },
                description: 'Present when the source sends pre-chunked content',
              },
            },
            required: ['external_id', 'content'],
          },
        },
        namespace: namespaceField,
        project_path: projectPathField,
        permissions: {
          type: 'object',
          properties: {
            visibility: {
              type: 'string',
              enum: ['personal', 'project', 'team', 'org'],
              description: 'Who may read it (default personal)',
            },
            retention: {
              type: 'string',
              enum: ['durable', 'session', 'ephemeral'],
              description: 'How long it is kept (default durable)',
            },
            ttl_ms: { type: 'number', description: 'With retention, an expiry in ms from now' },
          },
          description: 'Permissions and retention for the whole batch',
        },
        defer_vectors: {
          type: 'boolean',
          description:
            'Write the rows and their fts index now and leave embed_state stale, instead of computing embeddings before this call returns (default false). Use it when the caller must not wait on the local model; the maintenance queue embeds the backlog. A search before then ranks these rows lexically and reports the evidence channel as degraded.',
        },
        batch_embeddings: {
          type: 'boolean',
          description:
            'Embed the batch in one forward pass per chunk instead of one call per item (default false). Faster on large batches, but NOT the same vectors: the tokenizer pads every row to the longest in its chunk, which moves the rows that got padded (min cosine ~0.97 vs the single-call vector). Leave it off when stored vectors must match a one-call embedding.',
        },
      },
      required: ['source', 'episodes'],
    },
    annotations: {
      title: 'Ingest episodes',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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
        budget_chars: {
          type: 'number',
          minimum: 50,
          description:
            'Strict content-character budget for the result set. Results are packed in rank order (digest and topics are not part of this path) and long content is truncated to fit, with budget/dropped/truncated reported in the response. Omitting it returns up to `limit` results unchanged.',
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
      'Get memories for the current namespace. With a query, scopes retrieval through hybrid FTS5+vector search and returns full content; funnel scope (default for path-shaped namespaces) searches the deepest namespace first, then ascends thin ancestor nav layers for guide excerpts when the leaf is thin. Without a query, returns a compact roster only — id, type, importance, tags, and a ~160-char preview; full content requires a query or get_memory. The roster also carries `memory_health` (duplicate groups, never-accessed count, stale digests, thin scopes, namespaces with no digest) and any empty/weak result set carries `miss` (which scope holds the memories). Pass budget_chars to pack the whole payload to a strict character budget. Hides superseded memories by default.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: projectPathField,
        namespace: namespaceField,
        query: {
          type: 'string',
          description: 'Scope results to this task/topic via hybrid search and receive full content. Omitting it degrades the response to a compact roster (previews only).',
        },
        limit: { type: 'number', description: 'Max memories to return (default: 8; semantic top-8 is the lean default)' },
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
            'Query path only: truncate long content to ~400 chars + ellipsis. Truncation is ALREADY the query-path default, so this flag never changes the result — it is accepted for backward compatibility (the previous description claimed the opposite, which is the drift this corrects). Pass full_content=true for untruncated content. Ignored on the blanket (no-query) path, which is always a roster, and ignored when budget_chars is set (the budget decides truncation).',
        },
        budget_chars: {
          type: 'number',
          minimum: 50,
          description:
            'Strict content-character budget. When set, digest + memories + topics are packed to the budget with the same deterministic packer as recall_context (digest first, then top-ranked memories, then topics), and the response adds budget/dropped/truncated so starvation is visible. Omitting it keeps the default shape: full content (truncated at ~400 chars unless full_content) on the query path, roster previews on the no-query path.',
        },
        compact_topics: {
          type: 'boolean',
          description:
            'No-op: topics are summarized to a 5-id sample + member_count by default on both paths. Accepted for backward compatibility.',
        },
        full_content: {
          type: 'boolean',
          description:
            'Query path: serve untruncated content. Has no effect on the blanket (no-query) path, which never serves full content, or when budget_chars is set.',
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
    description:
      'Close a session with an optional summary. Pass session_id to close a specific session, or omit it to close the CURRENT session for this namespace (namespace/project_path resolution, or the connection default) — previously an id was required, which the agent could only scrape out of store_memory\'s payload, so sessions never ended. Closing a session enqueues its end-of-session maintenance (digest, cluster, importance, adjudication, plus navigation digests). Sessions are also ended automatically once genuinely idle (see list_sessions).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to end. Omit to end the current session for this namespace.',
        },
        summary: { type: 'string', description: 'Summary of what was accomplished' },
        project_path: projectPathField,
        namespace: namespaceField,
      },
      required: [],
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
    name: 'list_sessions',
    description:
      'List sessions for a namespace, newest first, including the id of the current one so it can be passed to end_session. Also ends sessions that have been idle for longer than ENGRAM_SESSION_IDLE_MS (default 12h) with no memory write, and enqueues their end-of-session maintenance — the sweep that makes the maintenance gated on end_session actually run.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: projectPathField,
        namespace: namespaceField,
        limit: { type: 'number', default: 20, maximum: 200, description: 'Max sessions to return (default 20)' },
        active_only: {
          type: 'boolean',
          default: false,
          description: 'Return only sessions that have not ended yet.',
        },
      },
    },
    annotations: {
      title: 'List sessions',
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
      'Usage statistics: search hit rate, tokens served, estimated context savings in USD, and the query-level retrieval ledger. `tokenizer` states which estimator produced the token counts (an exact tokenizer when one is importable, otherwise chars/4) and `estimated_context_savings.assumptions` states what the money figure assumes. Supports namespace and time-range filters. Use for cross-instance aggregation via install_id.',
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
      'Search within a specific followed/owned brain using natural language or keywords. Multi-word queries match precisely when possible and fall back to ranked partial matches. Caller must name the brain explicitly; cross-brain access is never implicit.',
    inputSchema: {
      type: 'object',
      properties: {
        brain: { type: 'string', description: 'Brain name (as shown by list_brains)' },
        query: { type: 'string', description: 'Natural-language question or keywords; FTS5 operators are treated as plain terms' },
        limit: { type: 'number', default: 10, maximum: 50, description: 'Max results (default 10, max 50)' },
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
      'Mark a local memory as shareable (or unshareable) so it will be included in the next brain snapshot. Default for every memory is NOT shareable. Scoped to the current project namespace and recorded in the local audit log for prompt-injection defense.',
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
        state_key: {
          type: 'string',
          description: 'Slot key (default: the predecessor\'s key, so a revision stays in its slot).',
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
    name: 'get_state',
    description:
      'The current value of state slots (single-valued facts that change over time): without key, every slot in the namespace, most recently updated first; with key, that slot alone. Each slot reports current (value, valid_from, superseded_at) and prior, so a caller can say "this was X until <date>, now Y". Slots come from an explicit state_key on store_memory / revise_memory and from every supersession chain, so nothing else has to be keyed for this to answer. Pass include_superseded=true for the full trajectory (every value with its window and the reason it was retired), or as_of for the value that was current at that time. This answers "what is true now"; search_memories answers "what was said".',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: projectPathField,
        namespace: namespaceField,
        key: {
          type: 'string',
          description: 'Slot key to read. Omit to list every slot in the namespace.',
        },
        as_of: {
          type: 'number',
          description:
            'Unix timestamp (ms). Historical view: the value current at that instant (valid_from <= as_of <= valid_until, both inclusive) with supersession judged after as_of ignored.',
        },
        include_superseded: {
          type: 'boolean',
          default: false,
          description:
            'Add each slot\'s trajectory: every value valid at the read time, oldest first, with its window and the reason it was retired.',
        },
        limit: {
          type: 'number',
          default: 20,
          maximum: 100,
          description: 'Max slots returned when no key is given (default 20)',
        },
      },
      required: [],
    },
    annotations: {
      title: 'Get state',
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
    name: 'assemble_context',
    description:
      'One assembled read: named sections (working task briefs, current state heads, fused memories, digests and cluster summaries, and an evidence channel that passes memories through until episode snippets land) packed into a single character budget, with per-section accounting, the channels and layers searched, and every channel that failed or could not run. A recipe picks the sections and their budget shares: default (the recall_context contract), session-priming (working and state first) and qa (memories and evidence heavy). Read-only and repeatable: no access stamping, no digest refresh, no generated text. Deterministic for the same store and inputs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Retrieval query feeding the fused memory channel. Without it the working, state and summary sections still assemble; the memories and evidence sections report that the channel did not run.',
        },
        budget_chars: {
          type: 'number',
          minimum: 50,
          description: 'Strict content-character budget across every section (default 4000)',
        },
        recipe: {
          type: 'string',
          description:
            'Named recipe: default | session-priming | qa, or a recipe added to the registry. Default is `default`.',
        },
        as_of: {
          type: 'number',
          description:
            'Unix timestamp (ms). Historical view (see search_memories.as_of). Present-state text is omitted: task briefs cannot be reconstructed and report it in degraded; the digest summary is dropped; state heads are the values true at as_of.',
        },
        project_path: projectPathField,
        namespace: namespaceField,
      },
    },
    annotations: {
      title: 'Assemble context',
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
    name: 'task_start',
    description:
      'Open a working-state task for this namespace: the goal, an optional plan with per-item status, artifacts and open questions. Working state lives beside memories, never inside them — no search returns it, it survives compaction, and task_update records every change as an event. Use it for work that outlives one context window; use store_memory for durable facts.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line naming the work' },
        goal: { type: 'string', description: 'What done looks like, with the constraint that matters' },
        plan: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked'] },
                },
                required: ['text'],
              },
            ],
          },
          description: 'Ordered steps; each becomes an item with a stable id (p1, p2, …) that task_update addresses',
        },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files, branches or outputs this task owns — the paths a fresh session needs',
        },
        open_questions: { type: 'array', items: { type: 'string' }, description: 'Unresolved questions to carry across a handoff' },
        session_id: { type: 'string', description: 'Host session id (optional)' },
        author: { type: 'string', description: 'Attribution recorded on the event log (optional)' },
        project_path: projectPathField,
        namespace: namespaceField,
      },
      required: ['title', 'goal'],
    },
    annotations: {
      title: 'Start task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'task_update',
    description:
      'Apply a delta to a task: set status, mark plan items done or active by id, append progress notes, artifacts and open questions, resolve a question. Deltas append rather than replace, and the applied delta is written to the append-only event log with its author. Answers with the applied delta, so an update that changed nothing is visible as such.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id from task_start or task_get' },
        status: { type: 'string', enum: ['open', 'blocked', 'done', 'abandoned'], description: 'Task status; done and abandoned stamp closed_at' },
        title: { type: 'string' },
        goal: { type: 'string' },
        plan: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'An existing plan item (p1, p2, …); omit to append a new step' },
              text: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked'] },
            },
          },
          description: 'Plan deltas: an entry with an id updates that item, an entry without one appends',
        },
        progress: { type: 'array', items: { type: 'string' }, description: 'Progress notes to append, each dated and attributed' },
        artifacts: { type: 'array', items: { type: 'string' }, description: 'Artifacts to add; a duplicate value is ignored' },
        open_questions: { type: 'array', items: { type: 'string' }, description: 'Questions to add' },
        resolved_questions: { type: 'array', items: { type: 'string' }, description: 'Questions to remove, matched by exact text' },
        author: { type: 'string', description: 'Attribution recorded on the event log (optional)' },
        project_path: projectPathField,
        namespace: namespaceField,
      },
      required: ['id'],
    },
    annotations: {
      title: 'Update task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'task_get',
    description:
      'Read working state. With an id: that task and, on request, its event log. Without one: the tasks for the namespace, newest first, filtered by status (open and blocked by default). Never a search — this is how a resumed or compacted session finds out what it was doing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id; without it the namespace list is returned' },
        status: { type: 'string', enum: ['open', 'blocked', 'done', 'abandoned'], description: 'Filter the list (with no id)' },
        limit: { type: 'number', default: 5, maximum: 50, description: 'Max tasks in the list (with no id)' },
        include_events: { type: 'boolean', default: false, description: 'Include the append-only event log (with an id)' },
        project_path: projectPathField,
        namespace: namespaceField,
      },
    },
    annotations: {
      title: 'Get task',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'task_close',
    description:
      'Finish a task and write one summary memory through the normal store path, so the write is admitted, embedded and linked like any other fact. The task keeps its plan, progress notes and event log. Idempotent: a task that is already done or abandoned is returned unchanged and no second memory is written.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id' },
        status: { type: 'string', enum: ['done', 'abandoned'], default: 'done', description: 'How it ended' },
        summary: { type: 'string', description: 'Extra line for the summary memory, e.g. the outcome that is worth remembering' },
        author: { type: 'string', description: 'Attribution recorded on the event log (optional)' },
        project_path: projectPathField,
        namespace: namespaceField,
      },
      required: ['id'],
    },
    annotations: {
      title: 'Close task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'task_handoff',
    description:
      'Render one bounded, deterministic brief for a task and log the handoff: goal, plan with status, recent progress, open questions, artifacts. for=subagent trims to the unfinished work (the parent keeps the history); for=new-session carries the fuller state so a fresh session can resume. Pass budget_chars to fit a host context limit.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id' },
        for: { type: 'string', enum: ['subagent', 'new-session'], default: 'subagent', description: 'Who the brief is for' },
        budget_chars: { type: 'number', minimum: 80, description: 'Cap on the brief in characters (default 900)' },
        author: { type: 'string', description: 'Attribution recorded on the event log (optional)' },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Hand off task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'session_start',
    description:
      'One priming call for a session beside a long-horizon harness: standing rules, the open task briefs (what was in flight, what step is active, what is unresolved), the pinned-fact digest and the namespace roster, packed into one character budget. Call it at session start and after a compaction.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Host session id: a task opened under it is preferred over the newest one' },
        budget_chars: { type: 'number', minimum: 200, description: 'Cap for the whole payload (default 2400)' },
        project_path: projectPathField,
        namespace: namespaceField,
      },
    },
    annotations: {
      title: 'Start session',
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
