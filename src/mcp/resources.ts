import type Database from 'better-sqlite3'
import { getDigest } from '../memory/digest.js'
import { rosterHits } from '../delivery/roster.js'
import { PROTOCOL_RULES } from '../delivery/protocol.js'
import { authorizeNamespace, currentCaller } from '../memory/access.js'
import { getDatabase } from '../db/init.js'

export interface ResourceEntry {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
}

export interface ResourceTemplateEntry {
  uriTemplate: string
  name: string
  title: string
  description: string
  mimeType: string
}

export interface ResourceRead {
  uri: string
  mimeType: string
  text: string
  ttlMs: number
  cacheScope: 'public' | 'private'
}

export interface ResourceProvider {
  /** the last segment of the uri, after the namespace */
  kind: string
  name: string
  title: string
  description: string
  mimeType: string
  ttlMs: number
  cacheScope: 'public' | 'private'
  read(db: Database.Database, namespace: string): string
}

const digestProvider: ResourceProvider = {
  kind: 'digest',
  name: 'namespace digest',
  title: 'Namespace digest',
  description: 'The pinned-fact digest for a namespace, as markdown. Same text get_context returns.',
  mimeType: 'text/markdown',
  ttlMs: 60_000,
  cacheScope: 'private',
  read: (db, namespace) => {
    const digest = getDigest(db, namespace)
    return digest === '' ? `no digest for ${namespace} yet` : digest
  },
}

const rosterProvider: ResourceProvider = {
  kind: 'roster',
  name: 'recent memories',
  title: 'Recent memories',
  description: 'The short present-state roster for a namespace: type, preview and id per memory.',
  mimeType: 'text/markdown',
  ttlMs: 0,
  cacheScope: 'private',
  read: (db, namespace) => {
    const hits = rosterHits(db, namespace)
    if (hits.length === 0) return `no memories in ${namespace} yet`
    const lines = [`# roster — ${namespace}`, '']
    for (const hit of hits) {
      lines.push(`- [${hit.type}] ${hit.preview}${hit.pinned ? ' (pinned)' : ''} (id ${hit.id})`)
    }
    return lines.join('\n')
  },
}

/** task brief and current state arrive as further providers here */
export const RESOURCE_PROVIDERS: ResourceProvider[] = [digestProvider, rosterProvider]

export const RULES_URI = 'engram://protocol/rules'

const rulesResource: ResourceEntry = {
  uri: RULES_URI,
  name: 'standing rules',
  title: 'Standing rules',
  description: 'How an agent should read and write engram memory in this workspace.',
  mimeType: 'text/markdown',
}

export function resourceList(namespace?: string): ResourceEntry[] {
  const entries = [rulesResource]
  if (!namespace) return entries
  for (const provider of RESOURCE_PROVIDERS) {
    entries.push({
      uri: `engram://${namespace}/${provider.kind}`,
      name: provider.name,
      title: provider.title,
      description: provider.description,
      mimeType: provider.mimeType,
    })
  }
  return entries
}

export function listResourceTemplates(): ResourceTemplateEntry[] {
  return RESOURCE_PROVIDERS.map((provider) => ({
    uriTemplate: `engram://{namespace}/${provider.kind}`,
    name: provider.name,
    title: provider.title,
    description: `${provider.description} {namespace} is the absolute namespace path.`,
    mimeType: provider.mimeType,
  }))
}

export interface ResourceReadOutcome {
  contents: Array<{ uri: string; mimeType: string; text: string }>
  ttlMs?: number
  cacheScope?: 'public' | 'private'
}

export function readResource(uri: string): ResourceReadOutcome | { error: string } {
  if (uri === RULES_URI) {
    return {
      contents: [{ uri, mimeType: rulesResource.mimeType, text: PROTOCOL_RULES }],
      ttlMs: 3_600_000,
      cacheScope: 'public',
    }
  }

  let rest: string
  try {
    rest = decodeURIComponent(uri.replace(/^engram:\/\//, ''))
  } catch {
    return { error: `unreadable resource uri: ${uri}` }
  }
  const separator = rest.lastIndexOf('/')
  const namespace = separator === -1 ? '' : rest.slice(0, separator)
  const kind = separator === -1 ? rest : rest.slice(separator + 1)
  const provider = RESOURCE_PROVIDERS.find((entry) => entry.kind === kind)
  if (!provider || !namespace.startsWith('/')) return { error: `unknown resource: ${uri}` }
  // a uri names a namespace like any argument does, so the credential still decides
  const refusal = authorizeNamespace(currentCaller(), namespace, 'read')
  if (refusal) return { error: refusal }

  return {
    contents: [{ uri, mimeType: provider.mimeType, text: provider.read(getDatabase().db, namespace) }],
    ttlMs: provider.ttlMs,
    cacheScope: provider.cacheScope,
  }
}
