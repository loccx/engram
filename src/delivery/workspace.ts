import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function findProjectRoot(start: string): string {
  let dir = resolve(start)
  for (;;) {
    // .git is a directory in a normal checkout and a file in a worktree
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(start)
    dir = parent
  }
}

/**
 * a worktree's `.git` file points into the primary repo, so scope to the primary tree or
 * every branch gets its own empty namespace. both paths are then realpath'd, since git
 * reports the primary repo by its real path and one repo would otherwise be spelled twice.
 */
export function canonicalWorkspace(root: string): string {
  try {
    const dotGit = join(root, '.git')
    if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return realpath(root)
    const commonDir = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!commonDir) return realpath(root)
    const primary = dirname(resolve(root, commonDir))
    return primary && existsSync(join(primary, '.git')) ? realpath(primary) : realpath(root)
  } catch {
    return root
  }
}

function realpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** a hook's cwd: an explicit default wins, then the git root */
export function resolveWorkspaceNamespace(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ENGRAM_DEFAULT_NAMESPACE?.trim()
  if (explicit) return explicit
  return canonicalWorkspace(findProjectRoot(cwd || process.cwd()))
}
