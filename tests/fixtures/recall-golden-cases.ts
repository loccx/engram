// the store and the inputs behind the recall golden fixture. the fixture holds the
// payload the recall path returned before context assembly became the single read path,
// so byte identity is provable from the committed file alone: this module describes the
// store and the inputs, never the expected output.
import type Database from 'better-sqlite3'
import type { RecallOptions } from '../../src/memory/recall.js'

export const GOLDEN_NAMESPACE = '/golden/recall'
/** one fixed clock for every case: recency decay reads it */
export const GOLDEN_NOW = 1_760_000_000_000
const T0 = GOLDEN_NOW - 30 * 24 * 60 * 60 * 1000

export interface GoldenCase {
  name: string
  options: Omit<RecallOptions, 'project_path' | 'now'>
}

export const GOLDEN_CASES: GoldenCase[] = [
  {
    name: 'fused-default',
    options: { query: 'kafka consumer lag', budget_chars: 2400, limit: 10 },
  },
  { name: 'fused-small-budget', options: { query: 'kafka consumer lag', budget_chars: 320, limit: 10 } },
  { name: 'fused-tiny-budget', options: { query: 'kafka and redis', budget_chars: 50, limit: 10 } },
  { name: 'hybrid-mode', options: { query: 'redis failover', budget_chars: 1200, mode: 'hybrid' } },
  { name: 'entity-mode', options: { query: 'kafka.Consumer', budget_chars: 900, mode: 'entity' } },
  {
    name: 'graph-mode',
    options: { query: 'unused', budget_chars: 1400, mode: 'graph', seed_id: 'gold-entity-1' },
  },
  { name: 'as-of-read', options: { query: 'golden service port', budget_chars: 2200, as_of: T0 + 500 } },
  { name: 'min-trust-floor', options: { query: 'golden fixture', budget_chars: 1600, min_trust: 0.55 } },
  { name: 'candidate-limit', options: { query: 'golden fixture', budget_chars: 4000, limit: 2 } },
  { name: 'no-match', options: { query: 'zzz nothing matches zzz', budget_chars: 800 } },
  { name: 'superseded-hidden', options: { query: 'golden service port', budget_chars: 1000 } },
]

function insertMemory(
  db: Database.Database,
  id: string,
  content: string,
  opts: {
    importance?: number
    pinned?: boolean
    type?: string
    tags?: string[]
    validFrom?: number
    validUntil?: number | null
  } = {}
): void {
  db.prepare(
    `INSERT INTO memories
       (id, session_id, project_path, namespace, content, type, importance, tags, created_at,
        valid_from, valid_until, access_count, pinned)
     VALUES (?, 'golden-session', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    id,
    GOLDEN_NAMESPACE,
    GOLDEN_NAMESPACE,
    content,
    opts.type ?? 'note',
    opts.importance ?? 0.5,
    JSON.stringify(opts.tags ?? []),
    opts.validFrom ?? T0,
    opts.validFrom ?? T0,
    opts.validUntil ?? null,
    opts.pinned === true ? 1 : 0
  )
}

const LONG_REDIS_NOTE =
  'the cache warm-up job for the golden fixture walks every redis key in the resolver ' +
  'namespace and rewrites the ones whose ttl is below an hour; it runs after the deploy ' +
  'window closes, never during it, because a warm-up against a half-rolled cluster ' +
  'drops the shard map and every reader reconnects with a cold local cache. the job ' +
  'reports its progress to the ops channel and leaves a marker row behind so a second ' +
  'run in the same window exits early instead of racing the first.'

export function seedGoldenCorpus(db: Database.Database): void {
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_path, started_at) VALUES (?, ?, ?)').run(
    'golden-session',
    GOLDEN_NAMESPACE,
    T0
  )

  insertMemory(db, 'gold-pin-1', 'the golden fixture deploys from the staging cluster at 09:00 utc', {
    importance: 0.95,
    pinned: true,
    type: 'decision',
    tags: ['deploy'],
  })
  insertMemory(db, 'gold-pin-2', 'golden fixture rollback is one command: golden rollback --to previous', {
    importance: 0.9,
    pinned: true,
    type: 'convention',
  })
  insertMemory(db, 'gold-note-1', 'kafka consumer lag spiked after the rebalance; the tuning notes live in ops/kafka.md', {
    importance: 0.7,
  })
  insertMemory(db, 'gold-note-2', 'kafka topic golden-events has 12 partitions and a 7 day retention', {
    importance: 0.5,
  })
  insertMemory(db, 'gold-note-3', LONG_REDIS_NOTE, { importance: 0.6, tags: ['redis'] })
  insertMemory(db, 'gold-note-4', 'the redis cluster fails over in 30 seconds with automatic promotion', {
    importance: 0.45,
  })
  insertMemory(db, 'gold-super-1', 'the golden service listens on port 8080', {
    importance: 0.6,
    validFrom: T0 - 10_000,
    validUntil: T0 + 10_000,
  })
  insertMemory(db, 'gold-super-2', 'the golden service listens on port 9090', {
    importance: 0.6,
    validFrom: T0 + 10_000,
  })
  insertMemory(db, 'gold-entity-1', 'kafka.Consumer.commitSync throws when the group rebalances mid-batch', {
    importance: 0.65,
    type: 'gotcha',
  })
  insertMemory(db, 'gold-note-9', 'the deploy window for the golden fixture is 09:00-11:30 utc', {
    importance: 0.55,
  })
  for (let i = 1; i <= 8; i++) {
    insertMemory(
      db,
      `gold-filler-${i}`,
      `golden fixture filler ${i}: the checklist item ${i} is owned by the on-call rotation`,
      { importance: 0.3 + i * 0.01 }
    )
  }

  db.prepare(
    'INSERT INTO memory_entities (memory_id, entity_text, entity_type, created_at) VALUES (?, ?, ?, ?)'
  ).run('gold-entity-1', 'kafka.Consumer', 'symbol', T0)

  const link = db.prepare(
    `INSERT INTO memory_links (source_id, target_id, similarity, link_type, created_at, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  link.run('gold-entity-1', 'gold-note-1', 0.9, 'similar', T0, null)
  link.run('gold-entity-1', 'gold-note-2', 0.82, 'similar', T0, null)
  link.run('gold-note-1', 'gold-note-2', 0.8, 'similar', T0, null)
  link.run('gold-super-2', 'gold-super-1', 1, 'supersedes', T0 + 10_000, 1)

  const cluster = db.prepare(
    `INSERT INTO memory_clusters (project_path, member_ids, summary, is_extractive, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`
  )
  cluster.run(
    GOLDEN_NAMESPACE,
    JSON.stringify(['gold-note-1', 'gold-note-2', 'gold-filler-1']),
    'kafka tuning for the golden fixture: consumer lag, partitions and retention',
    T0,
    T0
  )
  cluster.run(
    GOLDEN_NAMESPACE,
    JSON.stringify(['gold-note-3', 'gold-note-4']),
    'redis failover and the warm-up job that must not overlap it',
    T0,
    T0
  )

  // a fixed digest row, so the fixture never depends on the digest builder or an llm
  db.prepare(
    `INSERT INTO project_digests (namespace, content, source_hash, updated_at) VALUES (?, ?, NULL, ?)`
  ).run(
    GOLDEN_NAMESPACE,
    '- [decision] the golden fixture deploys from the staging cluster at 09:00 utc\n' +
      '- [convention] golden fixture rollback is one command: golden rollback --to previous',
    T0
  )
}
