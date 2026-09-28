// append-only jsonl checkpoint: one line per answered (question, reader) pair, so an
// interrupted run resumes where it died instead of re-paying for every earlier call.
// a row keyed differently (other models, other prompt versions, other dataset bytes) is
// ignored rather than reused: resuming across a change would mix two runs into one
// number. a corrupt line fails loud, or a truncated run aggregates as complete.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface CheckpointLine {
  key: string
  question_id: string
  reader: string
  at?: string
  [field: string]: unknown
}

export class JsonlCheckpoint<T extends CheckpointLine> {
  constructor(readonly path: string) {}

  /** every line in file order; throws on a line that is not json */
  load(): T[] {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      return []
    }
    const out: T[] = []
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line === '') continue
      try {
        out.push(JSON.parse(line) as T)
      } catch (e) {
        throw new Error(
          `${this.path}:${i + 1} is not valid json (${e instanceof Error ? e.message : String(e)}) — ` +
            'fix or delete the checkpoint before rerunning'
        )
      }
    }
    return out
  }

  append(line: T): void {
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, `${JSON.stringify(line)}\n`, 'utf8')
  }
}
