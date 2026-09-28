import type Database from 'better-sqlite3'
import type { MemoryType } from './types.js'
import { clusterLexicalFamilies, prunePrefixChars, type LexicalMember } from '../maintenance/prune.js'
import { notSupersededClause } from '../contradictions/supersession.js'

// admission: the checks a write must pass before it becomes a row; the write gate
// (store.ts) then reconciles it against its neighbours. a rule that cannot run
// allows the write — nothing here may fail the caller. ENGRAM_ADMISSION picks what
// a rejection means (off, warn, enforce), and only a caller that can act on a
// refusal (an agent) is refused, or the row just vanishes. a credential is refused
// in warn and enforce for every caller: once it is a row it is in the fts index,
// the vectors and every export.
export type AdmissionMode = 'off' | 'warn' | 'enforce'

export const ADMISSION_DEFAULT_MODE: AdmissionMode = 'enforce'

/** an mcp write has an agent on the other end; nothing else does */
export function isAgentWrite(origin: string | undefined): boolean {
  return origin === 'mcp'
}

export function resolveAdmissionMode(env: NodeJS.ProcessEnv = process.env): AdmissionMode {
  const raw = env.ENGRAM_ADMISSION?.trim().toLowerCase()
  return raw === 'off' || raw === 'warn' || raw === 'enforce' ? raw : ADMISSION_DEFAULT_MODE
}

export interface AdmissionInput {
  content: string
  namespace: string
  type: MemoryType
  tags: string[]
}

export interface AdmissionContext {
  db: Database.Database
  now: number
  /** the caller can act on a refusal: an agent wrote this through a tool */
  agent: boolean
}

export type AdmissionVerdict =
  | { action: 'allow' }
  | { action: 'warn'; reason: string; hint: string }
  | { action: 'reject'; reason: string; hint: string; existing_id?: string }

export interface AdmissionRule {
  name: string
  /** warn mode cannot downgrade this rejection */
  alwaysReject?: boolean
  check(input: AdmissionInput, ctx: AdmissionContext): AdmissionVerdict
}

export interface AdmissionWarning {
  rule: string
  reason: string
  hint: string
}

export type AdmissionDecision =
  | { allowed: true; warnings: AdmissionWarning[] }
  | { allowed: false; rule: string; reason: string; hint: string; existing_id?: string }

const SECRET_SHAPES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'a private key block', pattern: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/ },
  { label: 'an aws access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'a github token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { label: 'a slack token', pattern: /\bxox[abpros]-[A-Za-z0-9-]{10,}/ },
  { label: 'an api key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { label: 'a google api key', pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { label: 'a json web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
  {
    label: 'credentials in a connection string',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/i,
  },
  { label: 'an authorization header', pattern: /\bauthorization\s*:\s*\S{16,}/i },
  { label: 'a bearer token', pattern: /\bbearer\s+[A-Za-z0-9\-._~+/]{16,}/i },
  {
    // a keyword on its own is no evidence: "rotate the api key every 90 days"
    // stays admissible, so the value must be a single token that looks like one
    label: 'a password or key with its value',
    pattern:
      /\b(?:api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|secret|token|passw(?:or)?d|passwd|pwd)\b\s*(?:[:=]|\bis\b)\s*["']?(?:[A-Za-z0-9!@#$%^&*_+-]{16,}|[A-Za-z0-9!@#$%^&*_+-]*\d[A-Za-z0-9!@#$%^&*_+-]{4,})/i,
  },
]

const secretsRule: AdmissionRule = {
  name: 'secrets',
  alwaysReject: true,
  check(input) {
    const haystack = [input.content, ...input.tags].join('\n')
    const shape = SECRET_SHAPES.find((s) => s.pattern.test(haystack))
    if (!shape) return { action: 'allow' }
    // the reason names the shape, never the match: this text is stored and
    // echoed, and the point is to keep the value out of the corpus
    return {
      action: 'reject',
      reason: `content carries what looks like ${shape.label}`,
      hint: 'store where the credential lives and how it rotates, never the value itself',
    }
  },
}

const JUNK_MIN_ALNUM = 8
const JUNK_MAX_CHARS_DEFAULT = 24_000

function admissionMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.ENGRAM_ADMISSION_MAX_CHARS ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : JUNK_MAX_CHARS_DEFAULT
}

const junkRule: AdmissionRule = {
  name: 'junk',
  check(input) {
    // <div></div> carries letters; markup is stripped before counting
    const text = input.content.replace(/<[^>]*>/g, ' ')
    const alnum = text.replace(/[^a-z0-9]/gi, '').length
    if (alnum === 0) {
      return {
        action: 'reject',
        reason: 'there is no statement here: empty, punctuation or markup only',
        hint: 'write the fact in one sentence, or skip the write',
      }
    }
    const maxChars = admissionMaxChars()
    if (input.content.length > maxChars) {
      return {
        action: 'reject',
        reason: `content is ${input.content.length} characters, over the ${maxChars} character ceiling`,
        hint: 'store the durable point and the path to the file, not the file',
      }
    }
    if (alnum < JUNK_MIN_ALNUM) {
      return {
        action: 'warn',
        reason: `content is ${alnum} characters of text, too thin to be a memory`,
        hint: 'a memory is a sentence someone can act on, not a placeholder',
      }
    }
    return { action: 'allow' }
  },
}

const ABSENCE_CLAIMS = [
  /\bnone of (?:these|those|the|them)\b/i,
  /\bnothing (?:found|to report|to add|to note|actionable|came of|durable|notable|new|changed|happened)\b/i,
  /\bno (?:new |further |additional )?(?:issues?|findings?|problems?|bugs?|errors?|failures?|regressions?|decisions?|changes?|results?|blockers?|actions?|action items?|information|evidence)\b/i,
  /\bno (?:durable|useful|actionable|relevant|specific|notable) (?:[\w-]+ ){0,2}(?:decision|finding|result|change|information|evidence|task|action)\b/i,
  /\b(?:could not|couldn't|unable to) (?:find|reproduce|confirm|locate|identify)\b/i,
  /\bnot (?:found|reproducible|applicable|an issue|reproduced)\b/i,
  /\bno (?:further )?(?:action|investigation) (?:needed|required|necessary)\b/i,
]

const negativeResultRule: AdmissionRule = {
  name: 'negative-result',
  // warn rather than reject: the pattern reads the claim, not the intent, and a
  // store that refuses "no issues in the nightly drill" loses a real fact
  check(input) {
    // a digit or a code span means something concrete was asserted anyway
    if (/\d|`/.test(input.content)) return { action: 'allow' }
    if (!ABSENCE_CLAIMS.some((p) => p.test(input.content))) return { action: 'allow' }
    return {
      action: 'warn',
      reason: 'the whole claim is an absence: what was not found teaches a later session nothing',
      hint: 'record what you checked and the durable conclusion, or skip the write',
    }
  },
}

export const ADMISSION_BURST_MIN_DEFAULT = 5
const ADMISSION_BURST_WINDOW_MS_DEFAULT = 7 * 24 * 3_600_000
const BURST_SCAN_LIMIT = 200

function admissionBurstMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.ENGRAM_ADMISSION_BURST_MIN ?? '', 10)
  return Number.isFinite(n) && n >= 2 ? n : ADMISSION_BURST_MIN_DEFAULT
}

export function admissionBurstWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.ENGRAM_ADMISSION_BURST_WINDOW_MS ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : ADMISSION_BURST_WINDOW_MS_DEFAULT
}

interface BurstFamily {
  size: number
  keeper: LexicalMember
}

/**
 * the prefix family the write would join, or null: same bucket and one-keeper rule
 * as the prune job, so both agree on which family a burst belongs to
 */
function burstFamily(input: AdmissionInput, ctx: AdmissionContext): BurstFamily | null {
  const prefixChars = prunePrefixChars()
  const prefix = input.content.slice(0, prefixChars)
  const rows = ctx.db
    .prepare(
      `SELECT id, content, COALESCE(namespace, project_path) AS namespace, type, importance,
              access_count, pinned, created_at,
              (SELECT COUNT(*) FROM memory_links ml
                WHERE ml.source_id = memories.id OR ml.target_id = memories.id) AS link_degree
       FROM memories
       WHERE COALESCE(namespace, project_path) = ?
         AND type = ?
         AND created_at >= ?
         AND substr(content, 1, ?) = ?
         AND ${notSupersededClause('memories.id')}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .all(
      input.namespace,
      input.type,
      ctx.now - admissionBurstWindowMs(),
      prefixChars,
      prefix,
      BURST_SCAN_LIMIT
    ) as Array<LexicalMember & { created_at: number }>
  if (rows.length === 0) return null
  const [family] = clusterLexicalFamilies(rows, { prefixChars, clusterPrefix: true })
  if (!family) return null
  return { size: family.members.length, keeper: family.keeper }
}

const burstRule: AdmissionRule = {
  name: 'burst',
  check(input, ctx) {
    const family = burstFamily(input, ctx)
    if (!family || family.size < admissionBurstMin()) return { action: 'allow' }
    return {
      action: 'reject',
      reason: `${family.size} memories in ${input.namespace} already open with the same ${prunePrefixChars()} characters`,
      hint: `${family.keeper.id} holds that family — call revise_memory on it if this adds something, or skip the write`,
      existing_id: family.keeper.id,
    }
  },
}

export const ADMISSION_RULES: AdmissionRule[] = [
  secretsRule,
  junkRule,
  negativeResultRule,
  burstRule,
]

export function admit(
  input: AdmissionInput,
  ctx: AdmissionContext,
  mode: AdmissionMode = resolveAdmissionMode()
): AdmissionDecision {
  if (mode === 'off') return { allowed: true, warnings: [] }
  const enforcing = mode === 'enforce' && ctx.agent
  const warnings: AdmissionWarning[] = []
  for (const rule of ADMISSION_RULES) {
    const verdict = rule.check(input, ctx)
    if (verdict.action === 'allow') continue
    if (verdict.action === 'reject' && (enforcing || rule.alwaysReject === true)) {
      return {
        allowed: false,
        rule: rule.name,
        reason: verdict.reason,
        hint: verdict.hint,
        existing_id: verdict.existing_id,
      }
    }
    warnings.push({ rule: rule.name, reason: verdict.reason, hint: verdict.hint })
  }
  return { allowed: true, warnings }
}
