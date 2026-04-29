import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import envPaths from 'env-paths'

const paths = envPaths('engram')
const pidFile = join(paths.data, 'engram.pid')

export function writePid(pid: number): void {
  mkdirSync(paths.data, { recursive: true })
  writeFileSync(pidFile, String(pid), 'utf8')
}

export function readPid(): number | null {
  try {
    const raw = readFileSync(pidFile, 'utf8').trim()
    const pid = parseInt(raw, 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

export function removePid(): void {
  try {
    unlinkSync(pidFile)
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
