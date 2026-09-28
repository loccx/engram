// streaming reader for a top-level json array of records: the s-split is ~277 MB,
// which JSON.parse cannot hold, so records are cut out of the byte stream by a small
// state machine (depth + string/escape) that understands exactly one shape.
// shared by fetch-datasets (schema, counting) and the longmemeval suite (indexing) so
// both read the file the same way and cannot disagree about where a record starts.
import { createReadStream } from 'node:fs'

export interface ScanOptions {
  /** stop after this many records; default is the end of the file */
  limit?: number
  /** parse each record (default true); false counts only */
  parse?: boolean
  /**
   * every nth record (index % stride === 0). skipped records are not parsed, so an
   * even sample of a large file stays cheap.
   */
  stride?: number
}

/**
 * yields `{ index, value }` per top-level element; `value` is null when parse is off
 */
export async function* scanJsonArray(
  path: string,
  options: ScanOptions = {}
): AsyncGenerator<{ index: number; value: unknown | null }> {
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  const parse = options.parse !== false
  const stride = Math.max(1, Math.floor(options.stride ?? 1))
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })

  let buffer = ''
  let depth = 0
  let inString = false
  let escaped = false
  let outerOpened = false
  let index = 0
  let kept = 0

  try {
    for await (const chunk of stream) {
      const text = chunk as string
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]

        if (!outerOpened) {
          if (ch === '[') {
            outerOpened = true
            continue
          }
          if (/\s/.test(ch)) continue
          // anything else before the outer '[' means this is not a json array
          throw new Error(`${path}: expected a top-level JSON array, found "${ch}"`)
        }

        if (inString) {
          if (depth > 0) buffer += ch
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === '"') inString = false
          continue
        }

        if (ch === '"') {
          inString = true
          if (depth > 0) buffer += ch
          continue
        }

        if (ch === '{' || ch === '[') {
          if (depth === 0) buffer = ''
          depth++
          buffer += ch
          continue
        }

        if (ch === '}' || ch === ']') {
          // at depth 0 this is the outer array's own closer: the end
          if (depth === 0) continue
          depth--
          buffer += ch
          if (depth === 0) {
            const keep = index % stride === 0
            if (keep) {
              yield { index, value: parse ? (JSON.parse(buffer) as unknown) : null }
              kept++
            }
            index++
            buffer = ''
            // limit counts yielded records, never scanned ones: stride 10 with limit 50
            // must yield 50 records, not 5.
            if (kept >= limit) return
          }
          continue
        }

        if (depth > 0) buffer += ch
      }
    }
  } finally {
    stream.destroy()
  }
}

/** first top-level record, or null for an empty array */
export async function readFirstRecord(path: string): Promise<unknown | null> {
  for await (const record of scanJsonArray(path, { limit: 1 })) {
    return record.value
  }
  return null
}

/** how many top-level elements, without parsing them */
export async function countTopLevelElements(path: string): Promise<number> {
  let count = 0
  for await (const _record of scanJsonArray(path, { parse: false })) {
    count++
    void _record
  }
  return count
}

/** sha256 of a file, streamed: a dataset that size must not be buffered */
export async function sha256File(path: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer)
  } finally {
    stream.destroy()
  }
  return hash.digest('hex')
}
