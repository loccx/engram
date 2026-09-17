import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { BRAINS_CONFIG_FILE } from './paths.js'

/**
 * Per-brain defaults recorded at `engram brain init` time.
 *
 * Before this existed, `brain init -n <namespace>` printed the namespace and
 * threw it away: export/publish fell back to the literal namespace "default"
 * unless the user repeated `-n` every single time, which silently exported the
 * wrong (usually empty) layer.
 */
export interface BrainConfigEntry {
  namespace: string
  description?: string
}

type BrainConfigFile = Record<string, BrainConfigEntry>

export function readBrainConfig(): BrainConfigFile {
  if (!existsSync(BRAINS_CONFIG_FILE)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(BRAINS_CONFIG_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as BrainConfigFile
  } catch {
    return {}
  }
}

export function getBrainConfig(name: string): BrainConfigEntry | undefined {
  return readBrainConfig()[name]
}

export function setBrainConfig(name: string, entry: Partial<BrainConfigEntry>): void {
  const config = readBrainConfig()
  const previous = config[name] ?? { namespace: 'default' }
  config[name] = { ...previous, ...entry }
  mkdirSync(dirname(BRAINS_CONFIG_FILE), { recursive: true })
  writeFileSync(BRAINS_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}
