import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import envPaths from 'env-paths'

const paths = envPaths('engram')

/**
 * env-paths data dir unless ENGRAM_DATA_DIR points elsewhere, so an isolated instance
 * cannot clobber a running daemon's pid file. the resolver stays local: importing db/init
 * from utils for one string is the wrong direction. read per call.
 */
export function resolvePidFile(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.ENGRAM_DATA_DIR?.trim()
  return join(override ? override : paths.data, 'engram.pid')
}

export function writePid(pid: number): void {
  const pidFile = resolvePidFile()
  mkdirSync(dirname(pidFile), { recursive: true })
  writeFileSync(pidFile, String(pid), 'utf8')
}

export function readPid(): number | null {
  try {
    const raw = readFileSync(resolvePidFile(), 'utf8').trim()
    const pid = parseInt(raw, 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

export function removePid(): void {
  try {
    unlinkSync(resolvePidFile())
  } catch {
    // ignore
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
