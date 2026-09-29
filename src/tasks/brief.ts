import { HANDOFF_AUDIENCES, type Brief, type HandoffAudience, type HandoffBrief, type Task } from './types.js'

/**
 * rendering working state for a context window. the output is a pure function of the
 * stored task and the budget — no clock, no ids, no host — so the same task renders the
 * same bytes on every hook, every session and every test.
 */

export const DEFAULT_BRIEF_CHARS = 1200
export const DEFAULT_HANDOFF_CHARS = 900
const LAST_PROGRESS_NOTES = 5
const SUBAGENT_PROGRESS_NOTES = 1

type SectionName = 'plan' | 'progress' | 'questions' | 'artifacts'

interface Section {
  name: SectionName
  lines: string[]
}

interface AudienceRecipe {
  lead: (task: Task) => string
  plan: 'all' | 'unfinished'
  progress: number
  /** priority order: whatever runs out of budget first is the last entry */
  order: SectionName[]
}

const RECIPES: Record<HandoffAudience, AudienceRecipe> = {
  subagent: {
    lead: (task) => `engram task brief for a subagent: ${task.title} is open, do the next step and report back`,
    plan: 'unfinished',
    progress: SUBAGENT_PROGRESS_NOTES,
    order: ['plan', 'questions', 'progress', 'artifacts'],
  },
  'new-session': {
    lead: (task) => `engram task brief for a new session: ${task.title} is open, resume from here`,
    plan: 'all',
    progress: LAST_PROGRESS_NOTES,
    order: ['plan', 'progress', 'questions', 'artifacts'],
  },
}

const HEADINGS: Record<SectionName, string> = {
  plan: 'plan:',
  progress: 'progress:',
  questions: 'open questions:',
  artifacts: 'artifacts:',
}

function dayOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function planLines(task: Task, mode: 'all' | 'unfinished'): string[] {
  const items = mode === 'all' ? task.plan : task.plan.filter((item) => item.status !== 'done')
  return items.map((item) => `- [${item.status}] ${item.text}`)
}

function progressLines(task: Task, count: number): string[] {
  return task.progress
    .slice(-count)
    .map((note) => `- ${dayOf(note.created_at)} ${note.text}`)
}

function sectionsFor(task: Task, recipe: { plan: 'all' | 'unfinished'; progress: number }): Section[] {
  const lines: Record<SectionName, string[]> = {
    plan: planLines(task, recipe.plan),
    progress: progressLines(task, recipe.progress),
    questions: task.open_questions.map((question) => `- ${question}`),
    artifacts: task.artifacts.map((artifact) => `- ${artifact}`),
  }
  return (Object.keys(lines) as SectionName[]).map((name) => ({
    name,
    lines: lines[name].length > 0 ? [HEADINGS[name], ...lines[name]] : [],
  }))
}

/** how a line landing in the remaining room went: clipped means it consumed the rest */
type Fit = 'ok' | 'clipped' | 'full'

function render(header: string[], sections: Section[], budgetChars: number): Brief {
  const budget = Math.max(0, Math.floor(budgetChars))
  const lines: string[] = []
  const omitted: string[] = []

  const room = (): number => budget - (lines.length === 0 ? 0 : lines.join('\n').length + 1)

  const pushLine = (line: string): Fit => {
    const free = room()
    if (free <= 0) return 'full'
    if (line.length <= free) {
      lines.push(line)
      return 'ok'
    }
    if (free <= 2) return 'full'
    lines.push(`${line.slice(0, free - 1)}…`)
    return 'clipped'
  }

  let headerWritten = true
  for (const line of header) {
    if (pushLine(line) !== 'ok') {
      headerWritten = false
      break
    }
  }

  for (let index = 0; index < sections.length; index++) {
    const section = sections[index]
    if (!headerWritten) {
      omitted.push(section.name)
      continue
    }
    let complete = true
    let outOfRoom = false
    for (const line of section.lines) {
      const fit = pushLine(line)
      if (fit === 'full') {
        complete = false
        outOfRoom = true
        break
      }
      if (fit === 'clipped') {
        complete = false
        break
      }
    }
    if (!complete) omitted.push(section.name)
    if (outOfRoom) {
      for (const rest of sections.slice(index + 1)) omitted.push(rest.name)
      break
    }
  }

  if (omitted.length > 0) {
    const trailer = `(+${omitted.join(', ')} omitted)`
    if (trailer.length <= room()) lines.push(trailer)
  }

  const text = lines.join('\n')
  return { text, budget_chars: budget, used_chars: text.length, omitted }
}

export function brief(task: Task, budgetChars: number = DEFAULT_BRIEF_CHARS): Brief {
  const sections = sectionsFor(task, { plan: 'all', progress: LAST_PROGRESS_NOTES })
  return render(headerLines(task), sections, budgetChars)
}

function headerLines(task: Task, lead?: string): string[] {
  const lines = [`[${task.status}] ${task.title}`, `goal: ${task.goal}`]
  return lead ? [lead, ...lines] : lines
}

export function handoff(
  task: Task,
  audience: HandoffAudience,
  budgetChars: number = DEFAULT_HANDOFF_CHARS
): HandoffBrief {
  const recipe = RECIPES[audience]
  if (!recipe) {
    throw new Error(`Engram: unknown handoff audience "${audience}"; use ${HANDOFF_AUDIENCES.join('|')}`)
  }
  const sections = sectionsFor(task, recipe)
  const ordered = recipe.order.map((name) => sections.find((section) => section.name === name)!)
  const rendered = render(headerLines(task, recipe.lead(task)), ordered, budgetChars)
  return { ...rendered, task_id: task.id, for: audience }
}
