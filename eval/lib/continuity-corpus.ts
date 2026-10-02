// continuity corpus: one synthetic agent workflow, streamed chronologically, probed at
// checkpoints. it is the fixture the continuity suite exists for: the shapes that the
// other suites cannot express — a session restart and a resumed working task, a value
// corrected after it was written, raw evidence that only exists as episodes, a distractor
// namespace holding a twin of the same fact, a budget too small for the evidence, an
// archived row that has to come back, and an episode that has to expire.
//
// one rule shapes every part of it: the gold (answers, evidence ids, forbidden values)
// is built beside the events but never travels with them. the runner receives `fixture`
// (events + probe questions + checkpoints) and the scorer receives `gold`, so a
// controller cannot answer from a label it was handed. every probe's evidence arrives at
// or before its checkpoint, which is what makes a served later event a leak rather than
// a lucky guess.
import type { MemoryType } from '../../src/memory/types.js'
import type { PlanItemStatus } from '../../src/tasks/types.js'
import { rng } from './corpus.js'

/** the same corpus epoch every suite uses, so a run is stable across machines */
export const CONTINUITY_EPOCH = 1_735_689_600_000
export const CONTINUITY_HOUR = 3_600_000
/** the scoring clock: after the last event, so every row is in the past */
export const CONTINUITY_NOW = CONTINUITY_EPOCH + 8 * CONTINUITY_HOUR
/** the runner disposes its harness and reopens the same database after this event */
export const CONTINUITY_RESTART_AFTER_SEQ = 2

export const CONTINUITY_NAMESPACE = '/eval/continuity/release-train'
export const CONTINUITY_STAGING_NAMESPACE = '/eval/continuity/staging-mirror'
export const CONTINUITY_COLD_NAMESPACE = '/eval/continuity/cold-store'

export type ContinuityFamily =
  | 'resume'
  | 'correction'
  | 'evidence'
  | 'namespace'
  | 'budget'
  | 'archive'
  | 'expiry'

/**
 * which shipped read surface the full arm consults for a probe. the single-layer
 * ablation ignores this and reads the memories layer for every probe, and the
 * memory-off control runs the same controller over an empty store.
 */
export type ContinuityLayer =
  | 'memories'
  | 'state'
  | 'evidence'
  | 'task'
  | 'archive'
  | 'expiry'
  | 'close'

export type ContinuityArm = 'full' | 'single-layer' | 'memory-off'

export interface ContinuityMemoryAction {
  kind: 'memory'
  /** corpus-local id, so a case can name its evidence without a db uuid */
  id: string
  content: string
  namespace: string
  type?: MemoryType
  importance?: number
  /** a second write to the same key retires the first through the shipped write path */
  state_key?: string
}

export interface ContinuityEpisodeAction {
  kind: 'episodes'
  namespace: string
  source: string
  /** items ingested under the running task's id are what a close summary cites */
  items: Array<{
    external_id: string
    content: string
    session_id: string
    role?: string
    /** attach the running task id, so linkTaskEpisodes can find this item */
    task?: boolean
    }>
  /** retention ttl for the whole batch, stored as an absolute expiry at the event clock */
  ttl_ms?: number
  /** cite one stored item from one corpus memory, as a distillation path does */
  link?: { memory: string; external_id: string }
}

export interface ContinuityTaskStartAction {
  kind: 'task_start'
  title: string
  goal: string
  plan: string[]
}

export interface ContinuityTaskUpdateAction {
  kind: 'task_update'
  progress?: string[]
  plan?: Array<{ id: string; status: PlanItemStatus }>
  checkpoint?: boolean
}

export interface ContinuityTaskCloseAction {
  kind: 'task_close'
  summary?: string
}

export interface ContinuityColdAction {
  kind: 'cold_store'
  namespace: string
  /** near-identical rows: the shipped prune archives one and keeps the other */
  contents: [string, string]
}

export type ContinuityAction =
  | ContinuityMemoryAction
  | ContinuityEpisodeAction
  | ContinuityTaskStartAction
  | ContinuityTaskUpdateAction
  | ContinuityTaskCloseAction
  | ContinuityColdAction

export interface ContinuityEvent {
  seq: number
  id: string
  /** corpus clock, monotonic across events */
  at: number
  session: string
  note: string
  actions: ContinuityAction[]
}

export interface ContinuityProbe {
  id: string
  checkpoint: string
  family: ContinuityFamily
  layer: ContinuityLayer
  query: string
  namespace: string
  budget_chars: number
  /** the last event ingested when this probe runs: the future-leak boundary */
  after_seq: number
  /** the probe's own clock, for a case that reads after time has passed */
  now?: number
  /**
   * which slot surface a state probe reads: `current` asks what is true now and never
   * pulls the replaced value into its own payload, `history` asks for the chain. the
   * question shape, not a label, so the controller may read it.
   */
  state_read?: 'current' | 'history'
  /** read citedEpisodes for this corpus-local memory */
  citations_of?: string
  note: string
}

export interface ContinuityFixture {
  seed: number
  now: number
  namespace: string
  staging_namespace: string
  cold_namespace: string
  restart_after_seq: number
  events: ContinuityEvent[]
  probes: ContinuityProbe[]
  counts: {
    events: number
    probes: number
    by_family: Record<string, number>
  }
}

/** what only the scorer sees: the answer, the evidence and what must not be served */
export interface ContinuityGold {
  probe_id: string
  /**
   * the checks that define this case: every one of them has to hold for a pass. a
   * check the payload cannot answer (no task payload, no archive payload) is false,
   * which is how an arm that never consulted the layer fails the case.
   */
  require: string[]
  answer?: string
  /** corpus-local memory ids that carry the answer */
  memory_ids?: string[]
  /** episode external ids that carry the answer */
  episode_external_ids?: string[]
  /** values that must not be served (a replaced revision, a distractor twin) */
  forbidden?: string[]
  /** the twin value the distractor namespace holds */
  distractor_value?: string
  /** fragments a multi-part case must carry (an unfinished plan item, last progress) */
  required_fragments?: string[]
  citation?: { source: string; external_ids: string[] }
  /**
   * the smallest served-content size this case needs to be fair: the answer must fit
   * at its offset inside the content that carries it. a probe under this budget is
   * reported as insufficient rather than scored as a success or a failure.
   */
  min_chars: number
}

export interface ContinuityFixtureBundle {
  /** everything the controller may see */
  fixture: ContinuityFixture
  /** scorer-only ground truth, keyed by probe id */
  gold: ContinuityGold[]
}

/** the synthetic workflow, as a pure function of the seed */
export function buildContinuityFixture(seed: number): ContinuityFixtureBundle {
  const random = rng(seed)
  // one seed-derived token rides in the distractor namespace only: the seed changes the
  // twin's tag, never the target's answer
  const mirrorTag = `m${Math.floor(random() * 900 + 100)}`
  const T = CONTINUITY_EPOCH
  const H = CONTINUITY_HOUR

  const events: ContinuityEvent[] = [
    {
      seq: 1,
      id: 'e1-window-v1-and-task',
      at: T + 1 * H,
      session: 'ct-s1',
      note: 'session 1: the first value of the deploy window, the task and its first evidence',
      actions: [
        {
          kind: 'memory',
          id: 'deploy-window-v1',
          content: 'release-train deploy window: 09:00-11:30 utc',
          namespace: CONTINUITY_NAMESPACE,
          type: 'note',
          importance: 0.7,
          state_key: 'release-train.deploy_window',
        },
        {
          kind: 'task_start',
          title: 'release-train cutover',
          goal: 'Move the release-train service onto the new ledger without downtime',
          plan: [
            'drain the ledger queue',
            'flip the release-train service read-only',
            'run the release smoke suite',
          ],
        },
        {
          kind: 'episodes',
          namespace: CONTINUITY_NAMESPACE,
          source: 'release-train-agent',
          items: [
            {
              external_id: 'ct-s1-t1',
              content: 'the ledger queue drain is the first step of the release-train cutover',
              session_id: 'ct-s1',
              role: 'assistant',
              task: true,
            },
            {
              external_id: 'ct-s1-t2',
              content: 'the release-train service is flipped read-only before the smoke suite runs',
              session_id: 'ct-s1',
              role: 'assistant',
              task: true,
            },
          ],
        },
      ],
    },
    {
      seq: 2,
      id: 'e2-task-progress',
      at: T + 2 * H,
      session: 'ct-s2',
      note: 'session 2: progress on the task, then the process restarts',
      actions: [
        {
          kind: 'task_update',
          progress: ['drained the ledger queue at 08:40 utc'],
          plan: [
            { id: 'p1', status: 'done' },
            { id: 'p2', status: 'active' },
          ],
          checkpoint: true,
        },
        {
          kind: 'episodes',
          namespace: CONTINUITY_NAMESPACE,
          source: 'release-train-agent',
          items: [
            {
              external_id: 'ct-s2-t1',
              content: 'the ledger queue drain finished; the release-train service is next',
              session_id: 'ct-s2',
              role: 'assistant',
              task: true,
            },
          ],
        },
      ],
    },
    {
      seq: 3,
      id: 'e3-raw-evidence-and-distractor',
      at: T + 3 * H,
      session: 'ct-s3',
      note: 'session 3: raw evidence that is never distilled into a memory, plus the distractor namespace',
      actions: [
        {
          kind: 'episodes',
          namespace: CONTINUITY_NAMESPACE,
          source: 'release-train-agent',
          items: [
            {
              external_id: 'ct-s3-t1',
              content:
                'the release smoke suite is run with the command pnpm smoke:release against the staging url',
              session_id: 'ct-s3',
              role: 'assistant',
            },
            {
              external_id: 'ct-s3-t2',
              content: 'the smoke suite writes its report to artifacts/release-smoke.json',
              session_id: 'ct-s3',
              role: 'assistant',
            },
          ],
        },
        {
          kind: 'memory',
          id: 'staging-window',
          content: `staging-mirror deploy window: 02:00-04:00 utc (mirror ${mirrorTag})`,
          namespace: CONTINUITY_STAGING_NAMESPACE,
          type: 'note',
          importance: 0.5,
        },
      ],
    },
    {
      seq: 4,
      id: 'e4-window-correction',
      at: T + 4 * H,
      session: 'ct-s4',
      note: 'session 4: the window is corrected; the new value cites the turn it came from',
      actions: [
        {
          kind: 'memory',
          id: 'deploy-window-v2',
          content:
            'release-train deploy window: 13:00-15:00 utc (moved after the ledger import)',
          namespace: CONTINUITY_NAMESPACE,
          type: 'note',
          importance: 0.7,
          state_key: 'release-train.deploy_window',
        },
        {
          kind: 'episodes',
          namespace: CONTINUITY_NAMESPACE,
          source: 'release-train-agent',
          items: [
            {
              external_id: 'ct-s4-t1',
              content:
                'the release-train deploy window moved to 13:00-15:00 utc after the ledger import',
              session_id: 'ct-s4',
              role: 'assistant',
            },
          ],
          link: { memory: 'deploy-window-v2', external_id: 'ct-s4-t1' },
        },
      ],
    },
    {
      seq: 5,
      id: 'e5-cold-rows',
      at: T + 5 * H,
      session: 'ct-s5',
      note: 'session 5: two near-identical rows the shipped prune turns into one archived row',
      actions: [
        {
          kind: 'cold_store',
          namespace: CONTINUITY_COLD_NAMESPACE,
          contents: [
            'cold archive note: the release-train smoke report is mirrored to the artifact store (replica a)',
            'cold archive note: the release-train smoke report is mirrored to the artifact store (replica b)',
          ],
        },
      ],
    },
    {
      seq: 6,
      id: 'e6-expiring-evidence',
      at: T + 6 * H,
      session: 'ct-s6',
      note: 'session 6: one episode that expires within the hour, one that stays',
      actions: [
        {
          kind: 'episodes',
          namespace: CONTINUITY_NAMESPACE,
          source: 'release-train-agent',
          // the ttl belongs to the ingest call, so the expiring evidence is its own batch
          ttl_ms: 1 * H,
          items: [
            {
              external_id: 'ct-s6-expiring',
              content: 'the interim rollback contact is the release-train on-call rotation',
              session_id: 'ct-s6a',
              role: 'assistant',
            },
          ],
        },
        {
          kind: 'episodes',
          namespace: CONTINUITY_NAMESPACE,
          source: 'release-train-agent',
          items: [
            {
              external_id: 'ct-s6-durable',
              content: 'the release-train rollback runbook lives at docs/runbooks/release-train.md',
              session_id: 'ct-s6b',
              role: 'assistant',
            },
          ],
        },
      ],
    },
    {
      seq: 7,
      id: 'e7-task-close',
      at: T + 7 * H,
      session: 'ct-s7',
      note: 'session 7: the task closes and writes the one durable summary the close path allows',
      actions: [
        {
          kind: 'task_close',
          summary: 'closed after the release-train smoke suite was scheduled',
        },
      ],
    },
  ]

  const probes: ContinuityProbe[] = [
    {
      // one probe per payload: the restart is checked by the brief it produces, so the
      // task that survives it and the work it carries are the same case
      id: 'resume-brief',
      checkpoint: 'post-restart',
      family: 'resume',
      layer: 'task',
      query: 'release-train cutover',
      namespace: CONTINUITY_NAMESPACE,
      budget_chars: 900,
      after_seq: 2,
      note: 'after the restart the open task is still the one the previous session worked on, and its new-session handoff carries the goal, the unfinished plan item and the last progress note',
    },
    {
      id: 'evidence-command',
      checkpoint: 'after-evidence',
      family: 'evidence',
      layer: 'evidence',
      query: 'what command runs the release smoke suite',
      namespace: CONTINUITY_NAMESPACE,
      budget_chars: 1200,
      after_seq: 3,
      note: 'the smoke-suite command exists only as an episode',
    },
    {
      id: 'namespace-window',
      checkpoint: 'after-evidence',
      family: 'namespace',
      layer: 'memories',
      query: 'release-train deploy window',
      namespace: CONTINUITY_NAMESPACE,
      budget_chars: 800,
      after_seq: 3,
      note: 'the target namespace answers with its own value, never the staging twin',
    },
    {
      id: 'namespace-staging-control',
      checkpoint: 'after-evidence',
      family: 'namespace',
      layer: 'memories',
      query: 'staging-mirror deploy window',
      namespace: CONTINUITY_STAGING_NAMESPACE,
      budget_chars: 800,
      after_seq: 3,
      note: 'the twin is retrievable in its own namespace, so the isolation probe is not vacuous',
    },
    {
      id: 'budget-sufficient',
      checkpoint: 'after-evidence',
      family: 'budget',
      layer: 'memories',
      query: 'release-train deploy window',
      namespace: CONTINUITY_NAMESPACE,
      budget_chars: 120,
      after_seq: 3,
      note: 'the same question under a small budget that still fits the evidence',
    },
    {
      id: 'budget-tight',
      checkpoint: 'after-correction',
      family: 'budget',
      layer: 'memories',
      query: 'what is the release-train deploy window now',
      namespace: CONTINUITY_NAMESPACE,
      budget_chars: 40,
      after_seq: 4,
      note: 'a budget below the answer offset: reported as insufficient, not scored',
    },
    {
      id: 'state-current',
      checkpoint: 'after-correction',
      family: 'correction',
      layer: 'state',
      state_read: 'current',
      query: 'what is the release-train deploy window now',
      namespace: CONTINUITY_NAMESPACE,
      budget_chars: 800,
      after_seq: 4,
      note: 'the slot layer reports the corrected value and never the replaced one',
    },
    {
      id: 'state-history',
      checkpoint: 'after-correction',
      family: 'correction',
      layer: 'state',
      state_read: 'history',
      query: 'what was the release-train deploy window before the ledger import',
      namespace: CONTINUITY_NAMESPACE,
      budget_chars: 800,
      after_seq: 4,
      note: 'the replaced value is still readable as history',
    },
    {
      id: 'citation-source',
      checkpoint: 'after-correction',
      family: 'evidence',
      layer: 'evidence',
      query: 'where does the release-train deploy window come from',
      namespace: CONTINUITY_NAMESPACE,
      budget_chars: 800,
      after_seq: 4,
      citations_of: 'deploy-window-v2',
      note: 'the corrected value cites the episode it was distilled from',
    },
    {
      id: 'archive-restore',
      checkpoint: 'after-archive',
      family: 'archive',
      layer: 'archive',
      query: 'release-train smoke report artifact store',
      namespace: CONTINUITY_COLD_NAMESPACE,
      budget_chars: 800,
      after_seq: 5,
      note: 'a pruned row is hidden by id and by search, then restored',
    },
    {
      id: 'expiry-sweep',
      checkpoint: 'after-expiry',
      family: 'expiry',
      layer: 'expiry',
      query: 'release-train rollback runbook',
      namespace: CONTINUITY_NAMESPACE,
      budget_chars: 800,
      after_seq: 6,
      // 90 minutes after the ingest: the ttl episode has expired, the durable one has not
      now: T + 6 * H + 90 * 60_000,
      note: 'expired evidence is not served and the sweep removes exactly it',
    },
    {
      // the close payload answers both halves at once: a finished task is not offered
      // as open work again, and the one memory it wrote cites the evidence behind it
      id: 'close-summary',
      checkpoint: 'after-close',
      family: 'resume',
      layer: 'close',
      query: 'release-train cutover task summary',
      namespace: CONTINUITY_NAMESPACE,
      budget_chars: 1200,
      after_seq: 7,
      note: 'the close writes one summary memory that cites the task evidence, and the task is no longer open',
    },
  ]

  const byFamily: Record<string, number> = {}
  for (const probe of probes) byFamily[probe.family] = (byFamily[probe.family] ?? 0) + 1

  const fixture: ContinuityFixture = {
    seed,
    now: CONTINUITY_NOW,
    namespace: CONTINUITY_NAMESPACE,
    staging_namespace: CONTINUITY_STAGING_NAMESPACE,
    cold_namespace: CONTINUITY_COLD_NAMESPACE,
    restart_after_seq: CONTINUITY_RESTART_AFTER_SEQ,
    events,
    probes,
    counts: { events: events.length, probes: probes.length, by_family: byFamily },
  }

  return { fixture, gold: buildGold(fixture, mirrorTag) }
}

/**
 * the scorer's view. it is built from the same events, but it is a separate value and
 * the runner never receives it: `buildContinuityFixture` returns the two side by side.
 */
function buildGold(fixture: ContinuityFixture, mirrorTag: string): ContinuityGold[] {
  const carrier = contentIndex(fixture)
  const gold: ContinuityGold[] = []

  const push = (entry: Omit<ContinuityGold, 'min_chars'> & { min_chars?: number }): void => {
    const minChars =
      entry.min_chars ??
      minCharsFor(carrier, [
        entry.answer,
        ...(entry.required_fragments ?? []),
      ])
    gold.push({ ...entry, min_chars: minChars })
  }

  push({
    probe_id: 'resume-brief',
    require: ['task_found', 'fragments_present'],
    required_fragments: [
      'release-train cutover',
      'Move the release-train service onto the new ledger without downtime',
      '[active] flip the release-train service read-only',
      'drained the ledger queue at 08:40 utc',
    ],
  })
  push({
    probe_id: 'evidence-command',
    require: ['answer_served', 'evidence_served'],
    answer: 'pnpm smoke:release',
    episode_external_ids: ['ct-s3-t1'],
  })
  push({
    probe_id: 'namespace-window',
    require: ['answer_served', 'evidence_served', 'forbidden_absent', 'distractor_absent', 'namespace_isolated'],
    answer: '09:00-11:30 utc',
    memory_ids: ['deploy-window-v1'],
    distractor_value: '02:00-04:00 utc',
    forbidden: ['02:00-04:00 utc'],
  })
  push({
    probe_id: 'namespace-staging-control',
    require: ['answer_served', 'evidence_served', 'namespace_isolated'],
    answer: '02:00-04:00 utc',
    memory_ids: ['staging-window'],
  })
  push({
    probe_id: 'budget-sufficient',
    require: ['answer_served', 'evidence_served', 'budget_respected'],
    answer: '09:00-11:30 utc',
    memory_ids: ['deploy-window-v1'],
  })
  push({
    probe_id: 'budget-tight',
    // the case is reported, not scored: its only claim is that the payload respected
    // the budget it was given and that the packer's accounting says what it cut
    require: ['budget_respected', 'budget_cut_reported'],
    answer: '13:00-15:00 utc',
    memory_ids: ['deploy-window-v2'],
    // the answer sits at this offset inside the corrected row; a 40-char budget cannot
    // reach the end of it, which is the point of the case
    min_chars: offsetIn(carrier, '13:00-15:00 utc') + 8,
  })
  push({
    probe_id: 'state-current',
    require: ['state_current_contains', 'forbidden_absent'],
    answer: '13:00-15:00 utc',
    memory_ids: ['deploy-window-v2'],
    forbidden: ['09:00-11:30 utc'],
  })
  push({
    probe_id: 'state-history',
    require: ['state_prior_contains', 'history_contains'],
    answer: '09:00-11:30 utc',
    memory_ids: ['deploy-window-v1'],
    required_fragments: ['13:00-15:00 utc'],
  })
  push({
    probe_id: 'citation-source',
    require: ['citation_present', 'citation_correct'],
    answer: 'ct-s4-t1',
    citation: { source: 'release-train-agent', external_ids: ['ct-s4-t1'] },
  })
  push({
    probe_id: 'archive-restore',
    require: [
      'archive_applied',
      'archive_hidden',
      'archive_by_id_hidden',
      'archive_readable_with_flag',
      'archive_restored',
      'archive_restored_served',
    ],
    answer: 'release-train smoke report is mirrored to the artifact store',
  })
  push({
    probe_id: 'expiry-sweep',
    require: [
      'expired_absent_before',
      'durable_served_before',
      'sweep_removed_expired',
      'expired_gone_after',
      'durable_still_served',
    ],
    answer: 'docs/runbooks/release-train.md',
    episode_external_ids: ['ct-s6-durable'],
    forbidden: ['the interim rollback contact is the release-train on-call rotation'],
  })
  push({
    probe_id: 'close-summary',
    require: [
      'no_open_task',
      'summary_found',
      'fragments_present',
      'summary_served',
      'citation_correct',
    ],
    answer: 'run the release smoke suite',
    required_fragments: ['release-train cutover', 'closed after the release-train smoke suite was scheduled'],
    citation: {
      source: 'release-train-agent',
      external_ids: ['ct-s1-t1', 'ct-s1-t2', 'ct-s2-t1'],
    },
  })

  // the distractor's own tag is seed-derived, and the tag is asserted in a test rather
  // than scored: the value under test is the time, which does not move with the seed
  if (!mirrorTag.startsWith('m')) throw new Error('continuity fixture: mirror tag must be seeded')
  return gold
}

/** every content string the fixture writes, so min_chars can be computed from offsets */
function contentIndex(fixture: ContinuityFixture): string[] {
  const out: string[] = []
  for (const event of fixture.events) {
    for (const action of event.actions) {
      if (action.kind === 'memory') out.push(action.content)
      if (action.kind === 'episodes') for (const item of action.items) out.push(item.content)
      if (action.kind === 'cold_store') out.push(...action.contents)
    }
  }
  return out
}

/** the largest end offset of a fragment across the contents that carry it */
function minCharsFor(carrier: string[], fragments: Array<string | undefined>): number {
  let min = 8
  for (const fragment of fragments) {
    if (!fragment) continue
    min = Math.max(min, offsetIn(carrier, fragment) + fragment.length + 4)
  }
  return min
}

/** where the fragment ends inside the content that carries it; 0 when nothing carries it */
function offsetIn(carrier: string[], fragment: string): number {
  let best = 0
  for (const content of carrier) {
    const at = content.indexOf(fragment)
    if (at >= 0) best = Math.max(best, at)
  }
  return best
}
