import { createRequire } from 'node:module'

// token estimation for the usage ledger: a real BPE package is used when one is
// importable (the eval harness adds one; engram ships none), otherwise
// ceil(chars/4) and the stats payload says which. resolution is sync + cached.
export interface TokenEstimator {
  name: string
  /** false when the count is the chars/4 heuristic */
  exact: boolean
  count(text: string): number
}

// preference order; a missing package costs one failed require per process
const CANDIDATE_PACKAGES = ['gpt-tokenizer', 'js-tiktoken', '@dqbd/tiktoken'] as const

const CHARS_PER_TOKEN = 4

function fallbackEstimator(): TokenEstimator {
  return {
    name: 'chars/4',
    exact: false,
    count: (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN),
  }
}

function adapt(name: string, mod: Record<string, unknown>): TokenEstimator | null {
  try {
    if (name === 'gpt-tokenizer' && typeof mod.encode === 'function') {
      const encode = mod.encode as (text: string) => number[]
      return { name: 'gpt-tokenizer', exact: true, count: (t) => encode(t).length }
    }
    if (name === 'js-tiktoken' && typeof mod.getEncoding === 'function') {
      const encoding = (mod.getEncoding as (n: string) => { encode(t: string): number[] })(
        'o200k_base'
      )
      return { name: 'js-tiktoken/o200k_base', exact: true, count: (t) => encoding.encode(t).length }
    }
    if (name === '@dqbd/tiktoken' && typeof mod.get_encoding === 'function') {
      const encoding = (mod.get_encoding as (n: string) => { encode(t: string): number[] })(
        'cl100k_base'
      )
      return { name: '@dqbd/tiktoken/cl100k_base', exact: true, count: (t) => encoding.encode(t).length }
    }
  } catch {
    // present but unusable (bad API shape): try the next candidate
  }
  return null
}

let _estimator: TokenEstimator | null = null

/** cached for this process; never throws, falls back to chars/4 */
export function getTokenEstimator(): TokenEstimator {
  if (_estimator) return _estimator
  const require = createRequire(import.meta.url)
  for (const candidate of CANDIDATE_PACKAGES) {
    try {
      const mod = require(candidate) as Record<string, unknown>
      const adapted = adapt(candidate, mod)
      if (adapted) {
        _estimator = adapted
        return _estimator
      }
    } catch {
      // not installed (the normal case): try the next candidate
    }
  }
  _estimator = fallbackEstimator()
  return _estimator
}

/** chars_per_token is present only for the heuristic */
export function tokenizerLabel(): { name: string; exact: boolean; chars_per_token?: number } {
  const estimator = getTokenEstimator()
  return estimator.exact
    ? { name: estimator.name, exact: true }
    : { name: estimator.name, exact: false, chars_per_token: CHARS_PER_TOKEN }
}

/** test seam: the next call re-probes the packages */
export function resetTokenEstimatorForTests(): void {
  _estimator = null
}
