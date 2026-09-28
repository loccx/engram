// config registry (frozen shape, EVAL-CONTRACT.md): EVAL_CONFIGS is the built-in
// baseline merged with every eval/configs/*.ts module exporting `configs`. later work
// adds one file and never edits this one, so parallel branches cannot conflict. a
// config name is a report column header, so it stays a stable identifier, and baseline
// must reproduce shipped defaults exactly: no reranker, no access stamping, no flags.
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { SearchOptions } from '../../src/memory/search.js'

export interface RetrievalConfigPatch {
  /** the report column header; defaults to the registry key */
  label: string
  /** shipped SearchOptions knobs only */
  search?: Partial<SearchOptions>
  /** env-gated feature flags */
  features?: Record<string, boolean | number | string>
  notes?: string
}

export const BASELINE_CONFIG_NAME = 'baseline'

export const BASELINE_CONFIG: RetrievalConfigPatch = {
  label: BASELINE_CONFIG_NAME,
  search: { use_reranker: false, touch: false },
  notes: 'Shipped defaults: no reranker, no access-count stamping, no feature flags.',
}

/** scanned for contributed config modules */
export const CONFIGS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'configs')

export interface ConfigLoadError {
  file: string
  message: string
}

let loadErrors: ConfigLoadError[] = []

/**
 * import every eval/configs/*.ts module, sorted by filename. a broken module is
 * recorded, never fatal: one config's typo must not take the whole harness down
 */
export async function loadConfigs(
  dir: string = CONFIGS_DIR
): Promise<Record<string, RetrievalConfigPatch>> {
  const out: Record<string, RetrievalConfigPatch> = {
    [BASELINE_CONFIG_NAME]: BASELINE_CONFIG,
  }
  const errors: ConfigLoadError[] = []

  let files: string[] = []
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.startsWith('_'))
      .sort()
  } catch {
    loadErrors = errors
    return out
  }

  for (const file of files) {
    const full = join(dir, file)
    try {
      const mod = (await import(pathToFileURL(full).href)) as {
        configs?: Record<string, RetrievalConfigPatch>
      }
      const configs = mod.configs
      if (!configs || typeof configs !== 'object') {
        errors.push({
          file,
          message: 'module does not export `configs: Record<string, RetrievalConfigPatch>`',
        })
        continue
      }
      for (const [name, patch] of Object.entries(configs)) {
        if (!patch || typeof patch !== 'object') {
          errors.push({ file, message: `config "${name}" is not an object` })
          continue
        }
        if (name === BASELINE_CONFIG_NAME) {
          errors.push({
            file,
            message: 'may not redefine `baseline`; baseline is owned by the harness',
          })
          continue
        }
        if (out[name]) {
          errors.push({ file, message: `duplicate config name "${name}"; first definition kept` })
          continue
        }
        out[name] = { ...patch, label: typeof patch.label === 'string' ? patch.label : name }
      }
    } catch (e) {
      errors.push({ file, message: e instanceof Error ? e.message : String(e) })
    }
  }

  loadErrors = errors
  return out
}

loadErrors = []

/**
 * top-level await: config modules are esm ts files, and the contract exposes a
 * synchronous EVAL_CONFIGS
 */
export const EVAL_CONFIGS: Record<string, RetrievalConfigPatch> = await loadConfigs()

export function configLoadErrors(): ConfigLoadError[] {
  return [...loadErrors]
}

export function configNames(): string[] {
  return Object.keys(EVAL_CONFIGS)
}

/**
 * resolve requested config names, keeping the caller's order so the columns stay
 * stable. an unknown name throws: falling back to baseline would mislabel the numbers
 */
export function resolveConfigs(names: string[]): Array<[string, RetrievalConfigPatch]> {
  if (names.length === 0) return [[BASELINE_CONFIG_NAME, BASELINE_CONFIG]]
  const out: Array<[string, RetrievalConfigPatch]> = []
  const unknown: string[] = []
  for (const name of names) {
    const patch = EVAL_CONFIGS[name]
    if (!patch) {
      unknown.push(name)
      continue
    }
    out.push([name, patch])
  }
  if (unknown.length > 0) {
    throw new Error(
      `unknown eval config(s): ${unknown.join(', ')} — known: ${configNames().join(', ')}`
    )
  }
  return out
}

/** the env var a feature key maps to */
export function featureEnvKey(key: string): string {
  if (/^[A-Z][A-Z0-9_]*$/.test(key)) return key
  return `ENGRAM_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

export interface AppliedFeatures {
  /** key → env var actually set, for the header */
  applied: Record<string, string>
  /** key → env var → value, i.e. what to restore */
  restore: () => void
}

/**
 * apply a config's flags to process.env for a run: an UPPER_SNAKE key goes in
 * verbatim, anything else becomes ENGRAM_<KEY> (eval/README.md documents this)
 */
export function applyFeatureFlags(
  features: Record<string, boolean | number | string> | undefined
): AppliedFeatures {
  const applied: Record<string, string> = {}
  const saved: Array<[string, string | undefined]> = []
  if (features) {
    for (const [key, value] of Object.entries(features)) {
      const envKey = featureEnvKey(key)
      saved.push([envKey, process.env[envKey]])
      process.env[envKey] = String(value)
      applied[key] = envKey
    }
  }
  return {
    applied,
    restore: () => {
      for (const [envKey, value] of saved) {
        if (value === undefined) delete process.env[envKey]
        else process.env[envKey] = value
      }
    },
  }
}

/**
 * the SearchOptions for one query: suite defaults, then the config patch. touch:false
 * cannot be overridden, since access stamping makes a run unreproducible.
 */
export function configSearchOptions(
  patch: RetrievalConfigPatch,
  suiteDefaults: SearchOptions
): { options: SearchOptions; warnings: string[] } {
  const warnings: string[] = []
  const requested = patch.search ?? {}
  if (requested.touch === true) {
    warnings.push(`${patch.label}: touch:true ignored (reads must not stamp access counts)`)
  }
  const options: SearchOptions = { ...suiteDefaults, ...requested, touch: false }
  return { options, warnings }
}
