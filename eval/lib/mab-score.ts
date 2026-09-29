// memoryagentbench scoring for the Conflict_Resolution split (the paper's selective
// forgetting competency: factconsolidation_sh / _mh pools at 6k/32k/64k/262k).
// score is the official substring_exact_match from utils/eval_other_utils.py, and the
// prompts are the official factconsolidation ones from utils/templates.py, framed the
// way agent.py frames a retrieval agent (_handle_bm25_rag). the hub release is mit.
export const MAB_SCORER_NAME = 'memoryagentbench-substring-exact-match'
export const MAB_SCORER_VERSION = 'mab-eval-v1'
export const MAB_SCORER_SOURCE =
  'HUST-AI-HYZ/MemoryAgentBench utils/eval_other_utils.py substring_exact_match_score (MIT)'
export const MAB_PROMPT_VERSION = 'mab-factconsolidation-v1'
export const MAB_PROMPT_SOURCE =
  'HUST-AI-HYZ/MemoryAgentBench utils/templates.py BASE_TEMPLATES.factconsolidation + agent.py _handle_bm25_rag (MIT)'

export const MAB_SYSTEM_MESSAGE =
  'You are a helpful assistant that can read the context and memorize it for future retrieval.'

export const MAB_QUERY_TEMPLATE =
  'Pretend you are a knowledge management system. Each fact in the knowledge pool is provided ' +
  'with a serial number at the beginning, and the newer fact has larger serial number. \n' +
  ' You need to solve the conflicts of facts in the knowledge pool by finding the newest fact ' +
  'with larger serial number. You need to answer a question based on this rule. You should give ' +
  'a very concise answer without saying other words for the question **only** from the knowledge ' +
  'pool you have memorized rather than the real facts in real world. \n\n' +
  'For example:\n\n [Knowledge Pool] \n\n Question: Based on the provided Knowledge Pool, what is ' +
  'the name of the current president of Russia? \nAnswer: Donald Trump \n\n' +
  ' Now Answer the Question: Based on the provided Knowledge Pool, {question} \nAnswer:'

/** python string.punctuation */
const PUNCTUATION = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''))

export function normalizeAnswer(text: string): string {
  const stripped = [...text.toLowerCase()].filter((ch) => !PUNCTUATION.has(ch)).join('')
  const withoutArticles = stripped.replace(/\b(a|an|the)\b/g, ' ')
  return withoutArticles.split(/\s+/).filter(Boolean).join(' ')
}

/**
 * normalized ground truth is a substring of the normalized prediction. an answer that
 * normalizes to nothing (a bare article) matches anything, exactly as the official
 * `'' in prediction` does.
 */
export function substringExactMatch(prediction: string, groundTruth: string): boolean {
  return normalizeAnswer(prediction).includes(normalizeAnswer(groundTruth))
}

/**
 * best score over the ground-truth answers of one question; the official helper takes a
 * string, a list or a list of lists and flattens whatever it is given, so this does too
 */
export function scoreOverAnswers(prediction: string, answers: string | string[] | string[][]): number {
  const flat = Array.isArray(answers)
    ? (answers as unknown[]).flat(2).map((answer) => String(answer))
    : [String(answers)]
  let best = 0
  for (const answer of flat) {
    if (substringExactMatch(prediction, answer)) best = 1
  }
  return best
}

export interface MabFact {
  serial: number
  text: string
  /** the line as it appears in the pool, serial number included */
  line: string
}

/** the pool is a numbered list, and the serial number is the recency order the prompt uses */
export function parseFactPool(context: string): MabFact[] {
  const facts: MabFact[] = []
  for (const raw of context.split('\n')) {
    const line = raw.trim()
    const match = line.match(/^(\d+)\.\s*(.+)$/)
    if (!match) continue
    facts.push({ serial: Number.parseInt(match[1], 10), text: match[2], line })
  }
  return facts
}

/**
 * the released split ships no evidence or decoy labels, so the target is derived with the
 * pool's own rule: the newest fact (largest serial number) that states one of the gold
 * answers. an outdated fact states a different object, so it never matches.
 */
export function newestFactWithAnswer(facts: MabFact[], answers: string[]): MabFact | null {
  const wanted = answers.filter((answer) => answer.trim() !== '')
  let best: MabFact | null = null
  for (const fact of facts) {
    const lower = fact.text.toLowerCase()
    if (!wanted.some((answer) => lower.includes(answer.toLowerCase()))) continue
    if (best === null || fact.serial > best.serial) best = fact
  }
  return best
}

export interface MabRow {
  source: string
  question_type: string
  context: string
  questions: string[]
  answers: string[][]
  qa_pair_ids: string[]
}

export interface MabTargetStats {
  questions: number
  /** the newest answer-carrying fact was found */
  withTarget: number
  /** several facts carry the answer, so the derived target is a choice, not a lookup */
  multipleCandidates: number
  unscorable: number
  facts: number
}

export function emptyTargetStats(): MabTargetStats {
  return { questions: 0, withTarget: 0, multipleCandidates: 0, unscorable: 0, facts: 0 }
}

export function answerCandidates(facts: MabFact[], answers: string[]): MabFact[] {
  const wanted = answers.filter((answer) => answer.trim() !== '')
  return facts.filter((fact) => {
    const lower = fact.text.toLowerCase()
    return wanted.some((answer) => lower.includes(answer.toLowerCase()))
  })
}
