import { appendFileSync, existsSync, chmodSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { logger } from '../utils/logger.js'
import { AUDIT_LOG_FILE, ensureEngramHome } from './paths.js'

export type AuditEvent =
  | { type: 'mark_shareable'; namespace: string; memory_id: string; actor: string }
  | { type: 'unmark_shareable'; namespace: string; memory_id: string; actor: string }
  | { type: 'brain_publish'; brain: string; memory_count: number; recipients: number }
  | { type: 'brain_grant'; brain: string; pubkey: string }
  | { type: 'brain_revoke'; brain: string; pubkey: string }
  | { type: 'brain_follow'; brain: string; git_remote: string }
  | { type: 'brain_refresh'; brain: string; memory_count: number }
  | { type: 'brain_unfollow'; brain: string }

/**
 * appending to the audit log must never abort the operation it audits: create the
 * parent directory when there is one and swallow a write failure with a warning.
 * losing an audit line is bad; losing the publish is worse.
 */
export function logAudit(event: AuditEvent, path: string = AUDIT_LOG_FILE): void {
  const entry = JSON.stringify({ ts: Date.now(), ...event }) + '\n'
  const existedBefore = existsSync(path)
  try {
    ensureEngramHome()
    const dir = dirname(path)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(path, entry, 'utf8')
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path, type: event.type },
      'audit: could not append the event; the operation continues'
    )
    return
  }
  if (!existedBefore) {
    try {
      chmodSync(path, 0o600)
    } catch {
      // file mode is best effort: windows and some networked filesystems reject chmod
    }
  }
}
