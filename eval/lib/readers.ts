// reader layer over the memory-system registry: a reader turns one system's retrieval
// into the numbered context blocks an llm answers from, and carries the adapter identity
// onto every row. the prompt lives here with its version, so an accuracy number is only
// comparable with rows that used the same prompt.
import type { TokenizerInfo } from './metrics.js'
import type { MemorySystem, RetrievalResult } from './systems.js'

export const READER_PROMPT_VERSION = 'longmemeval-reader-v2'
/**
 * context budget for the budgeted systems, in characters (~8k tokens), sized next to the
 * published frontier reference so an accuracy number can be read against it; the report
 * always shows the tokens per question that were really used
 */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 32_000

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
  budgetChars: number
  tokenizer: TokenizerInfo
  /** the system's own retrieval for this question, so the reader scores what it serves */
  retrieved: RetrievalResult
}

export interface ReaderContext {
  blocks: string[]
  chars: number
  tokens: number
  /** wall-clock ms spent retrieving; 0 for a system that retrieves nothing */
  retrievalMs: number
  note: string
  system: string
  adapterKind: string
  adapterConfigHash: string
}

export interface ReaderSpec {
  name: string
  description: string
  build(input: ReaderInput): Promise<ReaderContext>
}

export function readerFor(system: MemorySystem): ReaderSpec {
  return {
    name: system.name,
    description: system.describe,
    async build(input) {
      const text = input.retrieved.context
      return {
        blocks: input.retrieved.blocks,
        chars: text.length,
        tokens: input.tokenizer.count(text),
        retrievalMs: input.retrieved.retrievalMs,
        note: input.retrieved.note,
        system: system.name,
        adapterKind: system.adapter.kind,
        adapterConfigHash: system.adapter.configHash,
      }
    },
  }
}
