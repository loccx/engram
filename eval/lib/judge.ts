// longmemeval answer check, ported from xiaowu0162/LongMemEval evaluate_qa.py
// (get_anscheck_prompt, mit) so a score is comparable with published numbers rather
// than a local rubric. upstream calls it the metric model: one prompt per question
// type, one yes/no answer, 'yes' in response.lower() = correct. an id carrying _abs is
// the unanswerable subset and takes the abstention prompt.
import { callChat } from './llm.js'
import type { ChatOptions } from '../../src/llm/client.js'

export const ANSCHECK_SOURCE =
  'xiaowu0162/LongMemEval src/evaluation/evaluate_qa.py get_anscheck_prompt (mit)'
export const ANSCHECK_PROMPT_VERSION = 'longmemeval-anscheck-v1'

/** upstream sends one user message, temperature 0, max_tokens 10 */
export const ANSCHECK_CHAT_OPTIONS: ChatOptions = { temperature: 0, maxTokens: 10 }

export interface JudgePromptTemplate {
  /** the question_type values this template grades */
  types: string[]
  template: string
}

const SHARED_TAIL = 'Is the model response correct? Answer yes or no only.'

function genericBody(): string {
  return (
    'I will give you a question, a correct answer, and a response from a model. ' +
    'Please answer yes if the response contains the correct answer. Otherwise, answer no. ' +
    'If the response is equivalent to the correct answer or contains all the intermediate ' +
    'steps to get the correct answer, you should also answer yes. If the response only ' +
    'contains a subset of the information required by the answer, answer no.'
  )
}

export const JUDGE_PROMPTS: JudgePromptTemplate[] = [
  {
    types: ['single-session-user', 'single-session-assistant', 'multi-session'],
    template: `${genericBody()} \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\n${SHARED_TAIL}`,
  },
  {
    types: ['temporal-reasoning'],
    template: `${genericBody()} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\n${SHARED_TAIL}`,
  },
  {
    types: ['knowledge-update'],
    template:
      'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\n' +
      SHARED_TAIL,
  },
  {
    types: ['single-session-preference'],
    template:
      'I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user\'s personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\n' +
      SHARED_TAIL,
  },
]

export const ABSTENTION_PROMPT = {
  template:
    'I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.',
}

/** as upstream does: the abstention subset is marked in the question id */
export const ABSTENTION_ID_MARKER = '_abs'

export function isAbstentionQuestion(questionId: string): boolean {
  return questionId.includes(ABSTENTION_ID_MARKER)
}

export interface JudgeInput {
  questionId: string
  questionType: string
  question: string
  goldAnswer: string
  predictedAnswer: string
}

export interface JudgePrompt {
  prompt: string
  /** which template graded it, for the artifact: abstention, a type, or generic-fallback */
  template: string
}

/**
 * an unknown question_type takes the generic template and says so, rather than
 * aborting a paid run mid-stream or mislabelling the rubric
 */
export function buildJudgePrompt(input: JudgeInput): JudgePrompt {
  if (isAbstentionQuestion(input.questionId)) {
    return {
      prompt: ABSTENTION_PROMPT.template
        .replace('{}', input.question)
        .replace('{}', input.goldAnswer)
        .replace('{}', input.predictedAnswer),
      template: 'abstention',
    }
  }
  const match = JUDGE_PROMPTS.find((entry) => entry.types.includes(input.questionType))
  const template = match ?? JUDGE_PROMPTS[0]
  return {
    prompt: template.template
      .replace('{}', input.question)
      .replace('{}', input.goldAnswer)
      .replace('{}', input.predictedAnswer),
    template: match ? input.questionType : 'generic-fallback',
  }
}

export interface JudgeVerdict {
  /** the exact prompt sent, so a row can be audited */
  prompt: string
  correct: boolean
  raw: string
  model: string
  template: string
  promptVersion: string
  promptTokens?: number
  completionTokens?: number
}

/** the verdict from the pinned judge model */
export async function judgeVerdict(input: JudgeInput, model: string): Promise<JudgeVerdict> {
  const built = buildJudgePrompt(input)
  const result = await callChat({
    messages: [{ role: 'user', content: built.prompt }],
    options: ANSCHECK_CHAT_OPTIONS,
    model,
  })
  const raw = result.content.trim()
  return {
    prompt: built.prompt,
    correct: raw.toLowerCase().includes('yes'),
    raw,
    model: result.model,
    template: built.template,
    promptVersion: ANSCHECK_PROMPT_VERSION,
    ...(result.promptTokens !== undefined ? { promptTokens: result.promptTokens } : {}),
    ...(result.completionTokens !== undefined ? { completionTokens: result.completionTokens } : {}),
  }
}
