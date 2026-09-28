# contributing

## gates

run all four before committing; they must be green.

```
npx tsc --noEmit
npx tsc --noEmit -p eval/tsconfig.json
npx vitest run
npm run eval -- --assert
```

`--assert` checks the pinned retrieval and budget thresholds, so a ranking regression fails there even when every unit test passes. a green suite is not evidence that a feature works: add the end-to-end path to `tests/` before trusting one.

## comments

default is no comment — names, types and small functions carry the meaning. write one when a reader would otherwise get it wrong:

- a non-obvious constraint (`// sqlite-vec only honors the scope if the filter is inside the knn scan`)
- a dependency gotcha, or a reason something that looks wrong is right
- a pointer to the module or the document that owns the rule

format: lowercase, casual, short, usually one line. never narrate history, quote a benchmark number, or name a branch, pull request or session. don't restate a signature, restate the code, or write a section banner. docblocks go on exported api only, one line, and only when the name is not enough. in tests the test name says the behaviour: keep a comment only for genuinely surprising setup.

## code

- small modules with one job. new behaviour goes in a new module behind a clear seam, not another branch in a 900-line function.
- extension points are data: a registry (or array) of `{ name, ... }` entries that a contributor extends by adding one entry.
- no dead code, commented-out code, or speculative options nobody reads.
- no new runtime dependency without a measured reason.
- fail loud at boundaries with a message that names the fix; never swallow an error into `[]`.
- keep behaviour deterministic (rowid tie-breaks, injected clocks) — the eval harness depends on it.

## adding an extension point

two moves: add an entry to a registry, add a test that proves it is wired in.

the registry lives next to the behaviour it configures and is the only file a new variant touches. `eval/configs/*.ts` is the model: one module per improvement, exporting `configs`; `eval/lib/registry.ts` merges every module in the directory, so two contributors never edit a shared list. the retrieval channels (ident, entity) follow the same shape — a channel is an entry, and `tests/wiring.test.ts` proves the shipped search path reads it, not just the channel function. a variant that is not reachable from a shipped path is inert no matter how well it measures.

## commits

conventional, lowercase subject, body says why. no attribution trailers.
