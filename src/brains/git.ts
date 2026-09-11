import { spawnSync } from 'child_process'

export interface GitResult {
  stdout: string
  stderr: string
  ok: boolean
  code: number
}

export function git(args: string[], cwd: string): GitResult {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ok: r.status === 0,
    code: r.status ?? -1,
  }
}

export function gitOrThrow(args: string[], cwd: string): string {
  const r = git(args, cwd)
  if (!r.ok) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.code}):\n${r.stderr.trim() || r.stdout.trim()}`)
  }
  return r.stdout
}

export function isGitRepo(cwd: string): boolean {
  return git(['rev-parse', '--git-dir'], cwd).ok
}

export function gitInit(cwd: string): void {
  gitOrThrow(['init', '-b', 'main'], cwd)
}

export function gitAddAll(cwd: string): void {
  gitOrThrow(['add', '-A'], cwd)
}

export function gitCommit(cwd: string, message: string): { committed: boolean; sha: string | null } {
  const status = gitOrThrow(['status', '--porcelain'], cwd)
  if (status.trim() === '') {
    return { committed: false, sha: null }
  }
  gitOrThrow(['commit', '-m', message], cwd)
  const sha = gitOrThrow(['rev-parse', 'HEAD'], cwd).trim()
  return { committed: true, sha }
}

export function gitSetRemote(cwd: string, name: string, url: string): void {
  const remotes = gitOrThrow(['remote'], cwd)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (remotes.includes(name)) {
    gitOrThrow(['remote', 'set-url', name, url], cwd)
  } else {
    gitOrThrow(['remote', 'add', name, url], cwd)
  }
}

export function gitPush(cwd: string, remote: string, branch: string): void {
  gitOrThrow(['push', '-u', remote, branch], cwd)
}

export function gitClone(url: string, dest: string): void {
  gitOrThrow(['clone', url, dest], process.cwd())
}

export function gitPull(cwd: string): { updated: boolean; sha: string } {
  const before = gitOrThrow(['rev-parse', 'HEAD'], cwd).trim()
  gitOrThrow(['pull', '--ff-only'], cwd)
  const after = gitOrThrow(['rev-parse', 'HEAD'], cwd).trim()
  return { updated: before !== after, sha: after }
}

export function gitHeadSha(cwd: string): string {
  return gitOrThrow(['rev-parse', 'HEAD'], cwd).trim()
}

export function gitCurrentBranch(cwd: string): string {
  return gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim()
}
