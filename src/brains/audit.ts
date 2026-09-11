import { appendFileSync, existsSync, chmodSync } from 'fs'
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

export function logAudit(event: AuditEvent, path: string = AUDIT_LOG_FILE): void {
  ensureEngramHome()
  const existedBefore = existsSync(path)
  const entry = JSON.stringify({ ts: Date.now(), ...event }) + '\n'
  appendFileSync(path, entry, 'utf8')
  if (!existedBefore) {
    try {
      chmodSync(path, 0o600)
    } catch {
      /* file mode is best-effort; Windows and some networked filesystems reject chmod */
    }
  }
}
