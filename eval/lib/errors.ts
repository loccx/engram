// setup errors a run must stop on: a run that silently degrades (no gateway, no pinned
// judge, cost over the ceiling) produces a number nobody can trust, so the message names
// the fix, and the cli prints it alone — the fix is the first thing an operator reads.
export class EvalSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvalSetupError'
  }
}

// data that was never fetched: `--suite all` skips the suite with a note, a named run still stops
export class DatasetMissingError extends EvalSetupError {
  constructor(message: string) {
    super(message)
    this.name = 'DatasetMissingError'
  }
}
