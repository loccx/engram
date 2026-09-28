import type { Command } from 'commander'
import type Database from 'better-sqlite3'
import { getDatabase } from '../db/init.js'
import { enqueueMaintenanceJob, runPendingMaintenanceJobs } from '../maintenance/jobs.js'
import {
  planDuplicatePrune,
  prunePrefixChars,
  pruneThreshold,
  type PruneReport,
} from '../maintenance/prune.js'
import { listSupersessionLinks, reverseSupersession } from '../contradictions/reversal.js'
import { logger } from '../utils/logger.js'

// both commands dry-run by default. --apply goes through the durable queue rather
// than archiving inline, so a re-run coalesces and an interrupted run resumes.

export interface PruneCliResult {
  applied: boolean
  report: PruneReport | null
  enqueued_job_id: number | null
}

export async function runPruneCli(
  db: Database.Database,
  opts: { apply?: boolean; namespace?: string; threshold?: number; prefixChars?: number; clusterPrefix?: boolean }
): Promise<PruneCliResult> {
  const planOpts = {
    ...(opts.namespace ? { namespace: opts.namespace } : {}),
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    ...(opts.prefixChars !== undefined ? { prefixChars: opts.prefixChars } : {}),
    ...(opts.clusterPrefix === true ? { clusterPrefix: true } : {}),
  }

  if (!opts.apply) {
    const plan = planDuplicatePrune(db, planOpts)
    return {
      applied: false,
      report: {
        ...plan,
        archived: 0,
        links_repointed: 0,
        links_removed: 0,
        duration_ms: 0,
      },
      enqueued_job_id: null,
    }
  }

  const targetKey = `prune:${opts.namespace ?? '*'}`
  const { id, coalesced } = enqueueMaintenanceJob(db, {
    jobType: 'prune',
    targetKey,
    source: 'cli',
  })
  await runPendingMaintenanceJobs(db, { maxJobs: 5 })
  const row = db
    .prepare('SELECT status, result_json, last_error FROM maintenance_jobs WHERE id = ?')
    .get(id) as { status: string; result_json: string | null; last_error: string | null } | undefined

  if (!row || (row.status !== 'done' && row.status !== 'running')) {
    throw new Error(
      `prune job ${id} did not complete (status ${row?.status ?? 'missing'}` +
        `${row?.last_error ? `: ${row.last_error}` : ''})`
    )
  }
  if (coalesced) logger.debug({ jobId: id, targetKey }, 'prune: coalesced onto an active job')

  let report: PruneReport | null = null
  if (row.result_json) {
    const parsed = JSON.parse(row.result_json) as Omit<PruneReport, 'groups'> & {
      groups: number | PruneReport['groups']
    }
    report = {
      ...(parsed as PruneReport),
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    } as PruneReport
  }
  return { applied: true, report, enqueued_job_id: id }
}

export function registerLifecycleCommands(program: Command): void {
  program
    .command('prune-duplicates')
    .description(
      'Archive redundant near-identical memories (dry run by default; --apply archives via the durable job queue)'
    )
    .option('--apply', 'archive redundant members instead of only reporting them', false)
    .option('--threshold <ratio>', `share of the longer text that must be shared (default ${pruneThreshold()})`)
    .option('--prefix-chars <n>', `prefix length used to bucket candidates (default ${prunePrefixChars()})`)
    .option(
      '--cluster-prefix',
      'treat every row sharing the bucket prefix as redundant (for burst-written batches)',
      false
    )
    .option('--namespace <namespace>', 'limit to one namespace')
    .option('--json', 'print the full report as JSON', false)
    .option('--db <path>', 'engram.db path')
    .action(
      async (opts: {
        apply: boolean
        threshold?: string
        prefixChars?: string
        namespace?: string
        json: boolean
        db?: string
        clusterPrefix: boolean
      }) => {
        const threshold = opts.threshold ? Number.parseFloat(opts.threshold) : undefined
        const prefixChars = opts.prefixChars ? Number.parseInt(opts.prefixChars, 10) : undefined
        const dbm = getDatabase(opts.db)
        const result = await runPruneCli(dbm.db, {
          apply: opts.apply,
          namespace: opts.namespace,
          threshold: Number.isFinite(threshold) ? threshold : undefined,
          prefixChars: Number.isFinite(prefixChars) ? prefixChars : undefined,
          clusterPrefix: opts.clusterPrefix,
        })
        const report = result.report
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }
        if (!report) {
          console.log('No report produced.')
          return
        }
        console.log(`${result.applied ? 'Applied' : 'Dry run'} — duplicate prune`)
        console.log(`  namespace:        ${report.namespace ?? '(all)'}`)
        console.log(`  memories scanned: ${report.scanned}${report.truncated ? ' (truncated)' : ''}`)
        console.log(`  keepers:          ${report.keepers}`)
        console.log(`  redundant rows:   ${report.redundant_rows}`)
        console.log(`  archived:         ${report.archived}`)
        console.log(`  links repointed:  ${report.links_repointed}`)
        console.log(`  links removed:    ${report.links_removed}`)
        console.log(`  threshold/prefix: ${report.threshold} / ${report.prefix_chars} chars`)
        const sample = report.groups.slice(0, 5)
        for (const group of sample) {
          console.log(
            `  e.g. keep ${group.keeper_id} ← archive ${group.redundant_ids.join(', ')} (${group.type}, sim ${group.similarity})`
          )
        }
        if (!result.applied && report.redundant_rows > 0) {
          console.log('Re-run with --apply to archive them (reversible: unarchive <id>).')
        }
        dbm.close()
      }
    )

  program
    .command('reverse-supersession')
    .description('Remove a supersedes link and restore the hidden memory (reverses a false-positive adjudication)')
    .requiredOption('--target <id>', 'memory id the supersedes link points at')
    .option('--source <id>', 'only remove the link written by this source (default: all sources)')
    .option('--keep-valid-until', 'do not reopen the target validity window', false)
    .option('--keep-archived', 'do not un-archive the target', false)
    .option('--list', 'only list the supersedes links pointing at the target', false)
    .option('--json', 'print JSON', false)
    .option('--db <path>', 'engram.db path')
    .action(
      (opts: {
        target: string
        source?: string
        keepValidUntil: boolean
        keepArchived: boolean
        list: boolean
        json: boolean
        db?: string
      }) => {
        const dbm = getDatabase(opts.db)
        if (opts.list) {
          const links = listSupersessionLinks(dbm.db, opts.target)
          if (opts.json) {
            console.log(JSON.stringify(links, null, 2))
          } else if (links.length === 0) {
            console.log('No supersedes links point at that memory.')
          } else {
            for (const link of links) {
              console.log(
                `${link.source_id} → ${link.target_id} (confidence ${link.confidence ?? 'n/a'}, ${link.reason ?? 'no reason'})`
              )
            }
          }
          dbm.close()
          return
        }
        const result = reverseSupersession(dbm.db, {
          targetId: opts.target,
          sourceId: opts.source,
          clearValidUntil: !opts.keepValidUntil,
          unarchive: !opts.keepArchived,
        })
        if (opts.json) console.log(JSON.stringify(result, null, 2))
        else {
          console.log(`Removed ${result.links_removed} supersedes link(s) pointing at ${opts.target}`)
          console.log(`  validity window reopened: ${result.valid_until_cleared}`)
          console.log(`  un-archived:              ${result.unarchived}`)
          console.log(`  adjudication pinned off:  ${result.adjudication_state_cleared} row(s)`)
        }
        dbm.close()
      }
    )

  program
    .command('unarchive <id>')
    .description('Restore an archived memory (reverses prune/retention archiving)')
    .option('--db <path>', 'engram.db path')
    .action((id: string, opts: { db?: string }) => {
      const dbm = getDatabase(opts.db)
      const info = dbm.db
        .prepare('UPDATE memories SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL')
        .run(id)
      console.log(
        info.changes > 0 ? `Un-archived ${id}` : `Nothing to do: ${id} is not archived (or does not exist)`
      )
      dbm.close()
    })
}
