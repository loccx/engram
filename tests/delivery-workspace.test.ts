import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalWorkspace, findProjectRoot, resolveWorkspaceNamespace } from '../src/delivery/workspace.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'engram-ws-'))
  dirs.push(root)
  const primary = join(root, 'primary')
  mkdirSync(primary)
  git(['init', '-q'], primary)
  writeFileSync(join(primary, 'f.txt'), 'x\n')
  git(['add', '-A'], primary)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], primary)
  return primary
}

describe('workspace namespace', () => {
  it('walks up to the git root from a nested directory', () => {
    const primary = repo()
    const nested = join(primary, 'src/deep')
    mkdirSync(nested, { recursive: true })

    expect(findProjectRoot(nested)).toBe(primary)
    expect(canonicalWorkspace(findProjectRoot(nested))).toBe(canonicalWorkspace(primary))
  })

  it('sends a worktree session to the primary repo, not to an empty branch namespace', () => {
    const primary = repo()
    const worktree = join(primary, '..', 'wt')
    git(['worktree', 'add', '-q', worktree], primary)

    expect(canonicalWorkspace(worktree)).toBe(canonicalWorkspace(primary))
    expect(resolveWorkspaceNamespace(join(worktree, 'src'), {})).toBe(canonicalWorkspace(primary))
  })

  it('keeps the two spellings of one repo on one namespace', () => {
    const primary = repo()
    const worktree = join(primary, '..', 'wt2')
    git(['worktree', 'add', '-q', worktree], primary)

    const fromWorktree = resolveWorkspaceNamespace(worktree, {})
    const fromPrimary = resolveWorkspaceNamespace(primary, {})
    expect(fromWorktree).toBe(fromPrimary)
  })

  it('honours an explicit namespace over detection', () => {
    const primary = repo()
    expect(resolveWorkspaceNamespace(primary, { ENGRAM_DEFAULT_NAMESPACE: '/elsewhere' })).toBe('/elsewhere')
  })

  it('falls back to the starting directory outside a repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-ws-plain-'))
    dirs.push(dir)

    expect(findProjectRoot(dir)).toBe(dir)
    expect(resolveWorkspaceNamespace(dir, {})).toBe(realpathSync(dir))
  })
})
