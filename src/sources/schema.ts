import { createHash } from 'node:crypto'
import { z } from 'zod'

export const SOURCE_PAGE_MAX = 200
export const SOURCE_PAGE_BYTES_MAX = 512_000
const identifier = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/)
const cursor = z.string().min(1).max(2048).regex(/^[^\u0000-\u001f\u007f]+$/)

/** a host hashes its effective upstream scope; neither tokens nor account config go in SQLite. */
export const SourceBindingSchema = z.strictObject({
  provider: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  account_hash: z.string().regex(/^[a-f0-9]{64}$/),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
})
export const SourceConnectionSchema = z.strictObject({
  namespace: z.string().min(1).max(1024).regex(/^\/[^\u0000-\u001f\u007f]*$/),
})
export const SourcePositionSchema = z.strictObject({
  cursor: cursor.nullable(),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
const upsert = z.strictObject({
  kind: z.literal('upsert'),
  external_id: identifier,
  revision: identifier,
  content: z.string().min(1).max(24_000),
  occurred_at: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
})
const deletion = z.strictObject({ kind: z.literal('delete'), external_id: identifier })
export const SourcePageSchema = z.strictObject({
  next_cursor: cursor.nullable(),
  changes: z.array(z.discriminatedUnion('kind', [upsert, deletion])).max(SOURCE_PAGE_MAX),
}).superRefine((page, ctx) => {
  const seen = new Set<string>()
  for (const change of page.changes) {
    if (seen.has(change.external_id)) {
      ctx.addIssue({ code: 'custom', message: 'one change per external identity per page' })
    }
    seen.add(change.external_id)
  }
})

export type SourceBinding = z.infer<typeof SourceBindingSchema>
export type SourcePosition = z.infer<typeof SourcePositionSchema>
export type SourcePage = z.infer<typeof SourcePageSchema>
export type SourceChange = SourcePage['changes'][number]

/** inline text is the changes/fetch equivalent; the core never calls an upstream itself. */
export interface SourceConnector extends SourceBinding {
  readonly provider: string
  readonly account_hash: string
  readonly scope_hash: string
  changes(cursor: string | null, limit: number): Promise<unknown>
}

/** sort object keys recursively; array order is the ordered upstream change stream. */
export function sourceHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, v]) => [key, canonical(v)]))
    }
    return input
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
