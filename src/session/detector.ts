import { findUp } from 'find-up'
import { dirname } from 'path'

export async function detectProjectPath(startDir?: string): Promise<string> {
  const cwd = startDir ?? process.cwd()

  const gitDir = await findUp('.git', { cwd, type: 'directory' })
  if (gitDir) {
    return dirname(gitDir)
  }

  // Also check for .git file (worktrees)
  const gitFile = await findUp('.git', { cwd, type: 'file' })
  if (gitFile) {
    return dirname(gitFile)
  }

  return cwd
}
