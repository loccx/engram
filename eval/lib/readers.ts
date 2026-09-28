// reader registry: a reader turns one question plus its haystack sessions into the
// context an llm answers from, so adding one is a new entry in READERS and nothing else
// changes. the three shipped readers are the comparison set: engram (recall_context,
// the system under test), full-context (every session, the ceiling) and naive-rag
// (lexical top-k, the floor). the prompt lives here too, and its version is stamped on
// every row.
import { latencyMsAsync, type TokenizerInfo } from './metrics.js'
import { EvalSetupError } from './errors.js'
import type { EvalHarness } from './harness.js'

export const READER_PROMPT_VERSION = 'longmemeval-reader-v2'
/**
 * context budget for the budgeted readers, in characters (~8k tokens), sized next to
 * the published frontier reference so an accuracy number can be read against it; the
 * report always shows the tokens per question that were really used
 */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 32_000
/** `naive-rag` chunk size in characters. */
export const NAIVE_CHUNK_CHARS = 600
export const DEFAULT_READER_NAMES = ['engram', 'full-context', 'naive-rag']

export const READER_SYSTEM_PROMPT =
  'You answer a question about a user\'s own past using only the provided memory excerpts. ' +
  'If the excerpts do not contain the answer, reply exactly "I don\'t know". ' +
  'Answer in at most 20 words. No preamble.'

export function buildReaderUserPrompt(input: {
  question: string
  questionDate?: string
  blocks: string[]
}): string {
  return [
    input.questionDate ? `Current date: ${input.questionDate}` : '',
    'Memory excerpts (ranked):',
    input.blocks.map((c, i) => `[${i + 1}] ${c}`).join('\n'),
    '',
    `Question: ${input.question}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export interface ReaderInput {
  question: string
  questionDate?: string
  namespace: string
  /** haystack session texts in file order, one indexed memory per session */
  sessions: string[]
  harness: EvalHarness
  tokenizer: TokenizerInfo
  budgetChars: number
  topK: number
}

export interface ReaderContext {
  blocks: string[]
  chars: number
  tokens: number
  /** wall-clock ms spent retrieving, 0 for a reader that retrieves nothing */
  retrievalMs: number
  note: string
}

export interface ReaderSpec {
  name: string
  description: string
  build(input: ReaderInput): Promise<ReaderContext>
}

function measure(blocks: string[], retrievalMs: number, tokenizer: TokenizerInfo, note: string): ReaderContext {
  const text = blocks.join('\n\n')
  return { blocks, chars: text.length, tokens: tokenizer.count(text), retrievalMs, note }
}

export const engramReader: ReaderSpec = {
  name: 'engram',
  description: 'engram retrieval (recall_context, strict character budget)',
  async build(input) {
    const { ms, value } = await latencyMsAsync(() =>
      input.harness.runRecall({
        query: input.question,
        project_path: input.namespace,
        budget_chars: input.budgetChars,
        limit: input.topK,
        mode: 'fused',
      })
    )
    const blocks = [
      ...(value.digest ? [value.digest] : []),
      ...value.memories.map((m) => m.content),
      ...value.topics.flatMap((t) => (t.summary ? [t.summary] : [])),
    ]
    const note =
      `used=${value.budget.used_chars}/${value.budget.total_chars} chars, ` +
      `memories=${value.memories.length}, dropped=${value.dropped.memories}`
    return measure(blocks, ms, input.tokenizer, note)
  },
}

export const fullContextReader: ReaderSpec = {
  name: 'full-context',
  description: 'every haystack session, no retrieval (unbudgeted ceiling)',
  async build(input) {
    return measure(input.sessions, 0, input.tokenizer, `${input.sessions.length} sessions, no budget`)
  },
}

export const naiveRagReader: ReaderSpec = {
  name: 'naive-rag',
  description: 'lexical top-k chunks over the sessions, packed to the budget',
  async build(input) {
    const chunks = chunkText(input.sessions, NAIVE_CHUNK_CHARS)
    const { ms, value: ranked } = await latencyMsAsync(async () =>
      rankChunks(chunks, input.question, input.topK)
    )
    const blocks: string[] = []
    let used = 0
    for (const rank of ranked) {
      const chunk = chunks[rank.index]
      if (used + chunk.length > input.budgetChars) break
      blocks.push(chunk)
      used += chunk.length
    }
    const note = `chunks=${chunks.length}, kept=${blocks.length}, used=${used}/${input.budgetChars} chars`
    return measure(blocks, ms, input.tokenizer, note)
  },
}

export const READERS: ReaderSpec[] = [engramReader, fullContextReader, naiveRagReader]

export function readerNames(): string[] {
  return READERS.map((r) => r.name)
}

export function resolveReaders(names?: string[]): ReaderSpec[] {
  if (!names || names.length === 0) return [...READERS]
  const out: ReaderSpec[] = []
  const unknown: string[] = []
  for (const name of names) {
    const found = READERS.find((r) => r.name === name)
    if (found) out.push(found)
    else unknown.push(name)
  }
  if (unknown.length > 0) {
    throw new EvalSetupError(
      `unknown reader(s): ${unknown.join(', ')} — known: ${readerNames().join(', ')}`
    )
  }
  return out
}

/** chunks of at most `size` characters, cut at line breaks */
export function chunkText(sessions: string[], size: number): string[] {
  const chunks: string[] = []
  let current = ''
  const flush = (): void => {
    if (current.length > 0) chunks.push(current)
    current = ''
  }
  for (const session of sessions) {
    for (const line of session.split('\n')) {
      if (line.length > size) {
        flush()
        for (let i = 0; i < line.length; i += size) chunks.push(line.slice(i, i + size))
        continue
      }
      if (current.length > 0 && current.length + line.length + 1 > size) flush()
      current = current.length === 0 ? line : `${current}\n${line}`
    }
    flush()
  }
  flush()
  return chunks
}

/** query terms: lowercase alphanumeric words of two characters or more */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

export interface ChunkRank {
  index: number
  score: number
}

/**
 * plain lexical ranking: the query terms' frequency in the chunk, ties by file order. no
 * idf, no fusion, no reranking — this is the naive comparison.
 */
export function rankChunks(chunks: string[], query: string, topK: number): ChunkRank[] {
  const terms = queryTerms(query)
  const scored = chunks.map((chunk, index) => {
    const lower = chunk.toLowerCase()
    let score = 0
    for (const term of terms) {
      let at = lower.indexOf(term)
      while (at !== -1) {
        score++
        at = lower.indexOf(term, at + term.length)
      }
    }
    return { index, score }
  })
  scored.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
  return scored.slice(0, Math.max(0, topK))
}
