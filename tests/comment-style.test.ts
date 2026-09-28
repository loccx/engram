import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// tune the rules here rather than in the assertion below
const RULES = {
  // a comment may open with a backtick, a number or a symbol; only a leading letter
  // counts, and it must be lowercase
  checkLeadingLetter: true,
  // a run of 4+ of these characters is a section banner, not a comment
  bannerRun: /(-{4,}|={4,}|\*{4,}|#{4,})/,
  // a /* */ block may carry at most this many content lines
  maxDocblockLines: 3,
  // history, process and tooling words that date a comment instead of explaining it
  banned: [
    [/\bpreviously\b/i, 'previously'],
    [/\bused to\b/i, 'used to'],
    [/\bno longer\b/i, 'no longer'],
    [/\bwas changed\b/i, 'was changed'],
    [/\blanes?\b/i, 'lane'],
    [/\bpr\s*#\s*\d+/i, 'pr #'],
    [/\bthis pr\b/i, 'this pr'],
    [/\brefactor(ed|ing)?\b/i, 'refactor(ed)'],
    [/\brewrit(e|es|ten|ing)\b/i, 'rewrite'],
    [/\bmeasured\b/i, 'measured'],
    [/\bbenchmark(ed|ing|s)?\b/i, 'benchmark'],
    [/\bwe\b/i, 'we'],
    [/\bour\b/i, 'our'],
    [/\bclaude\b/i, 'claude'],
    [/\bgpt\b/i, 'gpt'],
    [/llm-generated/i, 'llm-generated'],
  ],
} as const


const ROOT = join(import.meta.dirname, '..')

function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', '*.ts', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
}

/** shell comments: a line whose first non-space character is #, shebang excluded */
function shellCommentsOf(source: string): Comment[] {
  const out: Comment[] = []
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('#') || trimmed.startsWith('#!')) return
    // keep later `#` fragments out of the check: only the comment line itself counts
    out.push({ line: index + 1, text: `// ${trimmed.replace(/^#+\s?/, '')}` })
  })
  return out
}

interface Comment {
  line: number
  text: string
}

/**
 * every comment in a file, with string contents excluded: the parser's ranges cover
 * attached comments and the scanner adds a comment alone in a block. a scanner hit inside
 * a string or template is the scanner losing track of a template, so that is dropped.
 */
function commentsOf(file: string, source: string): Comment[] {
  const kind = file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const ranges: Array<readonly [number, number]> = []

  const push = (found: readonly ts.CommentRange[] | undefined) => {
    for (const r of found ?? []) ranges.push([r.pos, r.end])
  }
  const visit = (node: ts.Node) => {
    push(ts.getLeadingCommentRanges(source, node.getFullStart()))
    push(ts.getTrailingCommentRanges(source, node.end))
    ts.forEachChild(node, visit)
  }
  visit(sf)

  const stringRanges: Array<[number, number]> = []
  const STRINGY = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateExpression,
    ts.SyntaxKind.RegularExpressionLiteral,
  ])
  const collectStrings = (node: ts.Node) => {
    if (STRINGY.has(node.kind)) stringRanges.push([node.getStart(sf), node.end])
    ts.forEachChild(node, collectStrings)
  }
  collectStrings(sf)
  const inString = ([start, end]: readonly [number, number]) =>
    stringRanges.some(([s, e]) => start >= s && end <= e)

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source)
  let token = scanner.scan()
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    const isComment =
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    if (isComment) {
      const range = [scanner.getTokenPos(), scanner.getTextPos()] as const
      if (!inString(range) && !ranges.some(([s, e]) => s === range[0] && e === range[1])) {
        ranges.push(range)
      }
    }
    token = scanner.scan()
  }

  const out: Comment[] = []
  const seen = new Set<string>()
  for (const [start, end] of ranges) {
    const text = source.slice(start, end)
    if (!text.startsWith('//') && !text.startsWith('/*')) continue
    const line = sf.getLineAndCharacterOfPosition(start).line + 1
    const key = `${line}:${text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ line, text })
  }
  return out.sort((a, b) => a.line - b.line)
}

function contentLines(text: string): string[] {
  const body = text.startsWith('//')
    ? text.slice(2)
    : text.replace(/^\/\*+/, '').replace(/\*+\/$/, '')
  return body
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd())
    .filter((line) => line.trim().length > 0)
}

function problemsWith(comment: Comment): string[] {
  const problems: string[] = []
  const lines = contentLines(comment.text)

  const opens = (lines[0] ?? '').trim()
  const first = opens[0] ?? ''
  if (RULES.checkLeadingLetter && first >= 'A' && first <= 'Z') {
    problems.push(`starts uppercase: ${opens.slice(0, 70)}`)
  }

  for (const line of lines) {
    if (RULES.bannerRun.test(line)) {
      problems.push(`banner: ${line.trim().slice(0, 70)}`)
      break
    }
  }

  for (const line of lines) {
    for (const [pattern, name] of RULES.banned) {
      if (pattern.test(line)) {
        problems.push(`banned word "${name}": ${line.trim().slice(0, 70)}`)
        break
      }
    }
  }

  if (comment.text.startsWith('/*') && lines.length > RULES.maxDocblockLines) {
    problems.push(`docblock of ${lines.length} lines (max ${RULES.maxDocblockLines})`)
  }

  return problems
}

function trackedShellScripts(): string[] {
  return execFileSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
}

describe('comment style', () => {
  const files = trackedSources()

  it('covers the tracked sources', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('keeps every comment lowercase, casual and free of history', () => {
    const failures: string[] = []
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      for (const comment of commentsOf(file, source)) {
        for (const problem of problemsWith(comment)) {
          failures.push(`${file}:${comment.line}: ${problem}`)
        }
      }
    }
    for (const file of trackedShellScripts()) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      for (const comment of shellCommentsOf(source)) {
        for (const problem of problemsWith(comment)) {
          failures.push(`${file}:${comment.line}: ${problem}`)
        }
      }
    }
    expect(failures.join('\n')).toBe('')
  })
})
