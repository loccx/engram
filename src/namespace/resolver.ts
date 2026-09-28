import { detectProjectPath } from '../session/detector.js'

export interface NamespaceResolutionInputs {
  argsNamespace?: string
  argsProjectPath?: string
  urlNamespace?: string
  urlProject?: string
  envDefault?: string
  cwd?: string
}

export interface ResolvedNamespace {
  namespace: string
  source: 'args.namespace' | 'args.project_path' | 'url.namespace' | 'url.project' | 'env.default' | 'detected.git_root'
}

export async function resolveNamespace(input: NamespaceResolutionInputs = {}): Promise<ResolvedNamespace> {
  const env = input.envDefault ?? process.env.ENGRAM_DEFAULT_NAMESPACE

  if (input.argsNamespace) return { namespace: input.argsNamespace, source: 'args.namespace' }
  if (input.argsProjectPath) return { namespace: input.argsProjectPath, source: 'args.project_path' }
  if (input.urlNamespace) return { namespace: input.urlNamespace, source: 'url.namespace' }
  if (input.urlProject) return { namespace: input.urlProject, source: 'url.project' }
  if (env) return { namespace: env, source: 'env.default' }

  const detected = await detectProjectPath(input.cwd)
  return { namespace: detected, source: 'detected.git_root' }
}
