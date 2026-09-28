/**
 * http client for the delivery routes. best effort throughout: a hook that cannot reach
 * the daemon must produce nothing rather than an error, so a failure resolves to null.
 */

export const DEFAULT_DAEMON_URL = 'http://localhost:8888'

export interface DaemonCallOptions {
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export function daemonBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGRAM_DAEMON_URL?.trim() || DEFAULT_DAEMON_URL
}

export async function daemonPost<T>(
  path: string,
  body: Record<string, unknown>,
  options: DaemonCallOptions = {}
): Promise<T | null> {
  const base = options.baseUrl ?? DEFAULT_DAEMON_URL
  const doFetch = options.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 1200),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}
