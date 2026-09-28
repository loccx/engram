import type Database from 'better-sqlite3'
import { chatJson, isLlmConfigured } from '../llm/client.js'
import { parseNamespacePath } from '../namespace/tree.js'

/**
 * llm scope inference for store_memory routing, over existing synthetic sibling scopes
 * only: the model picks a candidate token or null, so an unknown token falls through to
 * the project root. every failure is downgraded, since routing must never fail a store.
 */

export interface ScopeInferenceResult {
  scope: string | null
  via: 'inferred' | 'unavailable'
}

export interface ScopeCandidate {
  token: string
  digest: string
}

const DIGEST_PREVIEW_CHARS = 80

const SYSTEM_PROMPT = `You classify which known project scope a developer note belongs to.

Reply with ONLY a JSON object in exactly this shape: {"scope":"<token>"} or {"scope":null}.
Choose a scope token ONLY from the candidate list provided. Return null when no
candidate clearly fits or when you are unsure. Never invent a token.`

export function scopeCandidates(db: Database.Database, projectPath: string): ScopeCandidate[] {
  const rows = db
    .prepare(
      `SELECT path, digest FROM namespace_nodes
       WHERE parent_path = ? AND is_synthetic = 1
       ORDER BY memory_count DESC, path ASC`
    )
    .all(projectPath) as Array<{ path: string; digest: string | null }>

  const candidates: ScopeCandidate[] = []
  for (const row of rows) {
    const token = parseNamespacePath(row.path).scope ?? ''
    if (!token) continue
    candidates.push({ token, digest: (row.digest ?? '').slice(0, DIGEST_PREVIEW_CHARS) })
  }
  return candidates
}

export async function inferScope(
  db: Database.Database,
  projectPath: string,
  content: string
): Promise<ScopeInferenceResult> {
  const unavailable: ScopeInferenceResult = { scope: null, via: 'unavailable' }

  if (process.env.ENGRAM_SCOPE_INFERENCE === '0') return unavailable
  if (!isLlmConfigured()) return unavailable

  const candidates = scopeCandidates(db, projectPath)
  if (candidates.length === 0) return unavailable

  const lines = candidates.map((c) => `- ${c.token}: ${c.digest}`).join('\n')
  const userPrompt = `Candidates (token: summary):\n${lines}\n\nMemory content:\n${content}\n\nReturn the best scope token or null.`

  try {
    const { data } = await chatJson<{ scope?: unknown }>(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      // the hot path: cap inference well below the client default, so a slow or hung
      // llm cannot stall a scoped store; a failure degrades to root routing
      { temperature: 0, maxTokens: 32, timeoutMs: 4000 }
    )

    const token = typeof data?.scope === 'string' ? data.scope.trim() : ''
    if (!token) return unavailable
    if (!candidates.some((c) => c.token === token)) return unavailable
    return { scope: token, via: 'inferred' }
  } catch {
    return unavailable
  }
}
