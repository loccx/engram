// locomo scoring, ported from snap-research/locomo task_eval/evaluation.py: f1 over
// normalized and porter-stemmed tokens, comma-split partial f1 for the multi-hop
// category, the ';' truncation for open-domain answers, and a keyword refusal check for
// the adversarial category. the reader prompts are ported from task_eval/gpt_utils.py.
// the repo is cc by-nc 4.0, which is why no locomo bytes are ever committed.
import { stem } from './porter-stemmer.js'

export const LOCOMO_SCORER_NAME = 'locomo-official-f1'
export const LOCOMO_SCORER_VERSION = 'locomo-eval-v1'
export const LOCOMO_SCORER_SOURCE = 'snap-research/locomo task_eval/evaluation.py eval_question_answering (CC BY-NC 4.0)'
export const LOCOMO_PROMPT_VERSION = 'locomo-qa-v1'
export const LOCOMO_PROMPT_SOURCE = 'snap-research/locomo task_eval/gpt_utils.py QA_PROMPT / QA_PROMPT_CAT_5 (CC BY-NC 4.0)'
export const LOCOMO_REFUSAL = 'Not mentioned in the conversation'

/**
 * the paper's five reasoning types; the ids come from the official scorer's branches
 * (1 splits on commas, 3 truncates lists, 5 checks for a refusal), so the names are
 * mapped here rather than read from the file
 */
export const LOCOMO_CATEGORY_NAMES: Record<number, string> = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
}

export const LOCOMO_QA_PROMPT =
  '\nBased on the above context, write an answer in the form of a short phrase for the ' +
  'following question. Answer with exact words from the context whenever possible.\n\n' +
  'Question: {} Short answer:\n'

export const LOCOMO_QA_PROMPT_CAT_5 =
  '\nBased on the above context, answer the following question.\n\nQuestion: {} Short answer:\n'

export interface LocomoQa {
  question: string
  answer?: string
  adversarial_answer?: string
  evidence?: string[]
  category: number
}

/** the released adversarial rows carry only `adversarial_answer`; `answer` is absent */
export function goldAnswer(qa: LocomoQa): string {
  return qa.answer ?? qa.adversarial_answer ?? ''
}

/** python string.punctuation */
const PUNCTUATION = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''))

export function normalizeAnswer(text: string): string {
  const withoutCommas = text.split(',').join('')
  const lowered = withoutCommas.toLowerCase()
  const stripped = [...lowered].filter((ch) => !PUNCTUATION.has(ch)).join('')
  const withoutArticles = stripped.replace(/\b(a|an|the|and)\b/g, ' ')
  return withoutArticles.split(/\s+/).filter(Boolean).join(' ')
}

/** multiset token f1 over stemmed tokens */
export function f1Score(prediction: string, groundTruth: string): number {
  const predicted = normalizeAnswer(prediction).split(/\s+/).filter(Boolean).map(stem)
  const expected = normalizeAnswer(groundTruth).split(/\s+/).filter(Boolean).map(stem)
  if (predicted.length === 0 || expected.length === 0) return 0
  const counts = new Map<string, number>()
  for (const token of predicted) counts.set(token, (counts.get(token) ?? 0) + 1)
  let same = 0
  for (const token of expected) {
    const available = counts.get(token) ?? 0
    if (available > 0) {
      counts.set(token, available - 1)
      same++
    }
  }
  if (same === 0) return 0
  const precision = same / predicted.length
  const recall = same / expected.length
  return (2 * precision * recall) / (precision + recall)
}

/** both sides split on commas; the mean over ground-truth parts of the best match */
export function f1Multi(prediction: string, groundTruth: string): number {
  const predictions = prediction.split(',').map((part) => part.trim())
  const truths = groundTruth.split(',').map((part) => part.trim())
  const scores = truths.map((truth) => Math.max(...predictions.map((part) => f1Score(part, truth))))
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

export interface LocomoScore {
  /** f1 for categories 1-4, 0/1 for the adversarial category */
  score: number
  detail: string
}

/** the official per-category branch, including its refusal keyword check */
export function scoreLocomo(prediction: string, qa: LocomoQa): LocomoScore {
  const gold = goldAnswer(qa)
  const category = qa.category
  if (category === 5) {
    const refused =
      prediction.toLowerCase().includes('no information available') ||
      prediction.toLowerCase().includes('not mentioned')
    return { score: refused ? 1 : 0, detail: refused ? 'refusal' : 'answered-adversarial' }
  }
  if (category === 1) {
    return { score: f1Multi(prediction, gold), detail: 'f1-partial (comma split)' }
  }
  if (category === 2 || category === 3 || category === 4) {
    const answer = category === 3 ? gold.split(';')[0].trim() : gold
    return { score: f1Score(prediction, answer), detail: `f1${category === 3 ? ' (first list item)' : ''}` }
  }
  // the official scorer raises on an unknown category; a silent fallback would hide a
  // changed file behind a plausible number
  throw new Error(`locomo: category ${category} is not one of the five scored types`)
}

/** the category-5 item turns into a two-option choice, as the official reader gets it */
export function cat5Question(qa: LocomoQa, flip: boolean): string {
  const correct = LOCOMO_REFUSAL
  const other = qa.adversarial_answer ?? ''
  const a = flip ? other : correct
  const b = flip ? correct : other
  return `${qa.question} Select the correct answer: (a) ${a} (b) ${b}. `
}

/**
 * a/b answers map back to the option text before scoring, so the refusal keyword check
 * sees the literal string the official harness compares against
 */
export function cat5Answer(prediction: string, qa: LocomoQa, flip: boolean): string {
  const trimmed = prediction.trim().toLowerCase()
  const a = flip ? (qa.adversarial_answer ?? '') : LOCOMO_REFUSAL
  const b = flip ? LOCOMO_REFUSAL : (qa.adversarial_answer ?? '')
  if (trimmed.length === 1) return trimmed.includes('a') ? a : b
  if (trimmed.length === 3) return trimmed.includes('(a)') ? a : b
  return prediction
}

/** stable 50/50 option order: the official run draws at random, a run here must not */
export function cat5Flip(questionId: string, seed: number): boolean {
  let hash = 2166136261
  const input = `${seed}:${questionId}`
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(hash ^ input.charCodeAt(i), 16777619) >>> 0
  }
  return (hash & 1) === 1
}
