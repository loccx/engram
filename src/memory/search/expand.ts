// variants are *additional* lists fused with the primary query, never a
// replacement for it. deterministic heuristics run always; the LLM tier only
// when useLlm and ENGRAM_LLM_* are set, and it must never throw into a search.

export const DEFAULT_MAX_VARIANTS = 4
const LLM_VARIANT_MAX_CHARS = 300

export interface ExpandQueryOptions {
  maxVariants?: number
  /** needs ENGRAM_LLM_BASE_URL + ENGRAM_LLM_API_KEY; without them only the offline tier runs */
  useLlm?: boolean
}

/** also used for per-term bm25 normalisation */
export function queryTokens(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean)
}

function normalizeKey(variant: string): string {
  return variant.trim().toLowerCase().replace(/\s+/g, ' ')
}

function unquote(variant: string): string {
  return variant.startsWith('"') && variant.endsWith('"') && variant.length > 1
    ? variant.slice(1, -1)
    : variant
}

/** `hybridSearch` should also reach a memory that says "hybrid search" */
function splitIdentifiers(query: string): string | null {
  const tokens = queryTokens(query)
  let changed = false
  const out = tokens.map((token) => {
    if (!/[_.\-/:]/.test(token) && !/[a-z0-9][A-Z]/.test(token)) return token
    const parts = token
      .split(/[_.\-/:]+/)
      .flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])/))
      .filter(Boolean)
    if (parts.length < 2) return token
    changed = true
    return parts.join(' ')
  })
  return changed ? out.join(' ') : null
}

/** db-free idf proxy: no handle to consult document frequency, so structure + length */
function rareTokens(query: string): string | null {
  const tokens = queryTokens(query)
  const rare = tokens.filter(
    (t) => /[A-Z_./:\d]/.test(t) || unquote(t).length >= 9
  )
  if (rare.length === 0 || rare.length === tokens.length) return null
  return rare.join(' ')
}

function phraseVariant(query: string): string | null {
  const tokens = queryTokens(query)
  if (tokens.length < 2) return null
  return `"${tokens.join(' ').replace(/"/g, '""')}"`
}

/** exported so tests can assert the offline tier without the LLM branch */
export function expandQueryDeterministic(
  query: string,
  maxVariants: number = DEFAULT_MAX_VARIANTS
): string[] {
  const trimmed = query.trim()
  if (!trimmed || maxVariants <= 0) return []
  const base = normalizeKey(trimmed)
  const candidates = [
    splitIdentifiers(trimmed),
    phraseVariant(trimmed),
    rareTokens(trimmed),
  ]
  const out: string[] = []
  const seen = new Set<string>([base])
  for (const c of candidates) {
    if (!c) continue
    const key = normalizeKey(c)
    if (key === base || seen.has(key)) continue
    seen.add(key)
    out.push(c)
    if (out.length >= maxVariants) break
  }
  return out
}

// returns [] on any failure: the primary list is already a complete answer, so an
// expansion outage must not surface as a search failure
async function expandQueryWithLlm(query: string, budget: number): Promise<string[]> {
  if (budget <= 0) return []
  try {
    const { isLlmConfigured, chatJson } = await import('../../llm/client.js')
    if (!isLlmConfigured()) return []
    const { data } = await chatJson<{ hypothetical?: string; sub_queries?: string[] }>(
      [
        {
          role: 'system',
          content:
            'You expand a search query for a local memory store. Reply with JSON only: ' +
            '{"hypothetical": "<a one-sentence answer that the query is likely asking for>", ' +
            '"sub_queries": ["<short keyword query>", "<short keyword query>"]}. ' +
            'No commentary, no markdown.',
        },
        { role: 'user', content: query },
      ],
      { temperature: 0, maxTokens: 256, timeoutMs: 4000 }
    )
    const raw: string[] = []
    if (typeof data?.hypothetical === 'string') raw.push(data.hypothetical)
    if (Array.isArray(data?.sub_queries)) {
      for (const s of data.sub_queries) if (typeof s === 'string') raw.push(s)
    }
    const out: string[] = []
    for (const s of raw) {
      const cleaned = s.trim().replace(/\s+/g, ' ').slice(0, LLM_VARIANT_MAX_CHARS)
      if (cleaned) out.push(cleaned)
      if (out.length >= budget) break
    }
    return out
  } catch {
    return []
  }
}

export async function expandQuery(
  query: string,
  opts: ExpandQueryOptions = {}
): Promise<string[]> {
  const maxVariants = opts.maxVariants ?? DEFAULT_MAX_VARIANTS
  const deterministic = expandQueryDeterministic(query, maxVariants)
  if (!opts.useLlm || maxVariants <= 0) return deterministic

  const llm = await expandQueryWithLlm(query, maxVariants - deterministic.length)
  if (llm.length === 0) return deterministic

  const out = [...deterministic]
  const seen = new Set<string>([normalizeKey(query), ...out.map(normalizeKey)])
  for (const variant of llm) {
    const key = normalizeKey(variant)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(variant)
    if (out.length >= maxVariants) break
  }
  return out
}
