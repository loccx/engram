import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * the version stamped into brain manifests, /health, serverInfo and the cli banner.
 * keep it in sync with package.json: duplicating the string avoids emitting
 * dist/package.json and keeps the dist tree module-shaped.
 */
export const ENGRAM_VERSION = '0.3.0'

/**
 * the source revision an immutable release was built from; the installer writes
 * engram-build.json beside package.json and a plain checkout reports null.
 */
export function resolveBuildSha(
  packageRoot: string = join(dirname(fileURLToPath(import.meta.url)), '..')
): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, 'engram-build.json'), 'utf8')) as {
      sha?: unknown
    }
    return typeof parsed.sha === 'string' && /^[a-f0-9]{40}$/.test(parsed.sha) ? parsed.sha : null
  } catch {
    return null
  }
}

export const ENGRAM_BUILD_SHA = resolveBuildSha()
