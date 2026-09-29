// porter stemmer, ported from nltk.stem.PorterStemmer in NLTK_EXTENSIONS mode, which
// is the default the locomo scorer imports (ps = PorterStemmer() in task_eval/evaluation.py).
// the f1 there stems both sides with it, so a score is only comparable if the stems match.
// pool holds nltk's irregular table, kept because the default mode uses it.
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])

const IRREGULAR_FORMS: Record<string, string[]> = {
  sky: ['sky', 'skies'],
  die: ['dying'],
  lie: ['lying'],
  tie: ['tying'],
  news: ['news'],
  inning: ['innings', 'inning'],
  outing: ['outings', 'outing'],
  canning: ['cannings', 'canning'],
  howe: ['howe'],
  proceed: ['proceed'],
  exceed: ['exceed'],
  succeed: ['succeed'],
}

const POOL = new Map<string, string>()
for (const [key, values] of Object.entries(IRREGULAR_FORMS)) {
  for (const value of values) POOL.set(value, key)
}

/** a 'y' counts as a consonant when the letter before it is not one */
export function isConsonant(word: string, index: number): boolean {
  let i = index
  const ch = word[i]
  if (VOWELS.has(ch)) return false
  if (ch === 'y') {
    let negate = false
    while (i > 0 && word[i] === 'y') {
      negate = !negate
      i -= 1
    }
    return !VOWELS.has(word[i]) !== negate
  }
  return true
}

function consonantFlags(word: string): boolean[] {
  const flags: boolean[] = []
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]
    if (VOWELS.has(ch)) flags.push(false)
    else if (ch === 'y') flags.push(i === 0 ? true : !flags[i - 1])
    else flags.push(true)
  }
  return flags
}

/** m in the paper's [C](VC)^m[V]: the number of 'vc' runs */
export function measure(stem: string): number {
  const sequence = consonantFlags(stem)
    .map((isCons) => (isCons ? 'c' : 'v'))
    .join('')
  let count = 0
  let at = sequence.indexOf('vc')
  while (at !== -1) {
    count++
    at = sequence.indexOf('vc', at + 2)
  }
  return count
}

function hasPositiveMeasure(stem: string): boolean {
  return measure(stem) > 0
}

function measureAboveOne(stem: string): boolean {
  return measure(stem) > 1
}

function containsVowel(stem: string): boolean {
  return consonantFlags(stem).some((isCons) => !isCons)
}

function endsDoubleConsonant(word: string): boolean {
  return (
    word.length >= 2 && word[word.length - 1] === word[word.length - 2] && isConsonant(word, word.length - 1)
  )
}

/** *o: the stem ends cvc and the second c is not w, x or y */
function endsCvc(word: string): boolean {
  return (
    (word.length >= 3 &&
      isConsonant(word, word.length - 3) &&
      !isConsonant(word, word.length - 2) &&
      isConsonant(word, word.length - 1) &&
      !['w', 'x', 'y'].includes(word[word.length - 1])) ||
    (word.length === 2 && !isConsonant(word, 0) && isConsonant(word, 1))
  )
}

function replaceSuffix(word: string, suffix: string, replacement: string): string {
  if (suffix === '') return word + replacement
  return word.slice(0, word.length - suffix.length) + replacement
}

interface StemRule {
  suffix: string
  replacement: string
  condition: ((stem: string) => boolean) | null
}

/** the first applicable rule wins, and a failed condition stops the walk */
function applyRuleList(word: string, rules: StemRule[]): string {
  for (const rule of rules) {
    if (rule.suffix === '*d' && endsDoubleConsonant(word)) {
      const stem = word.slice(0, word.length - 2)
      if (rule.condition === null || rule.condition(stem)) return stem + rule.replacement
      return word
    }
    if (word.endsWith(rule.suffix)) {
      const stem = replaceSuffix(word, rule.suffix, '')
      if (rule.condition === null || rule.condition(stem)) return stem + rule.replacement
      return word
    }
  }
  return word
}

function step1a(word: string): string {
  if (word.endsWith('ies') && word.length === 4) return replaceSuffix(word, 'ies', 'ie')
  return applyRuleList(word, [
    { suffix: 'sses', replacement: 'ss', condition: null },
    { suffix: 'ies', replacement: 'i', condition: null },
    { suffix: 'ss', replacement: 'ss', condition: null },
    { suffix: 's', replacement: '', condition: null },
  ])
}

function step1b(word: string): string {
  if (word.endsWith('ied')) {
    return word.length === 4 ? replaceSuffix(word, 'ied', 'ie') : replaceSuffix(word, 'ied', 'i')
  }
  if (word.endsWith('eed')) {
    const stem = replaceSuffix(word, 'eed', '')
    return measure(stem) > 0 ? `${stem}ee` : word
  }

  let intermediate = ''
  let succeeded = false
  for (const suffix of ['ed', 'ing']) {
    if (word.endsWith(suffix)) {
      const candidate = replaceSuffix(word, suffix, '')
      if (containsVowel(candidate)) {
        intermediate = candidate
        succeeded = true
        break
      }
    }
  }
  if (!succeeded) return word

  const last = intermediate[intermediate.length - 1]
  return applyRuleList(intermediate, [
    { suffix: 'at', replacement: 'ate', condition: null },
    { suffix: 'bl', replacement: 'ble', condition: null },
    { suffix: 'iz', replacement: 'ize', condition: null },
    { suffix: '*d', replacement: last, condition: () => !['l', 's', 'z'].includes(last) },
    { suffix: '', replacement: 'e', condition: (stem) => measure(stem) === 1 && endsCvc(stem) },
  ])
}

function step1c(word: string): string {
  return applyRuleList(word, [
    {
      suffix: 'y',
      replacement: 'i',
      condition: (stem) => stem.length > 1 && isConsonant(stem, stem.length - 1),
    },
  ])
}

const STEP2_BASE_RULES: StemRule[] = [
  { suffix: 'ational', replacement: 'ate', condition: hasPositiveMeasure },
  { suffix: 'tional', replacement: 'tion', condition: hasPositiveMeasure },
  { suffix: 'enci', replacement: 'ence', condition: hasPositiveMeasure },
  { suffix: 'anci', replacement: 'ance', condition: hasPositiveMeasure },
  { suffix: 'izer', replacement: 'ize', condition: hasPositiveMeasure },
  { suffix: 'bli', replacement: 'ble', condition: hasPositiveMeasure },
  { suffix: 'alli', replacement: 'al', condition: hasPositiveMeasure },
  { suffix: 'entli', replacement: 'ent', condition: hasPositiveMeasure },
  { suffix: 'eli', replacement: 'e', condition: hasPositiveMeasure },
  { suffix: 'ousli', replacement: 'ous', condition: hasPositiveMeasure },
  { suffix: 'ization', replacement: 'ize', condition: hasPositiveMeasure },
  { suffix: 'ation', replacement: 'ate', condition: hasPositiveMeasure },
  { suffix: 'ator', replacement: 'ate', condition: hasPositiveMeasure },
  { suffix: 'alism', replacement: 'al', condition: hasPositiveMeasure },
  { suffix: 'iveness', replacement: 'ive', condition: hasPositiveMeasure },
  { suffix: 'fulness', replacement: 'ful', condition: hasPositiveMeasure },
  { suffix: 'ousness', replacement: 'ous', condition: hasPositiveMeasure },
  { suffix: 'aliti', replacement: 'al', condition: hasPositiveMeasure },
  { suffix: 'iviti', replacement: 'ive', condition: hasPositiveMeasure },
  { suffix: 'biliti', replacement: 'ble', condition: hasPositiveMeasure },
  { suffix: 'fulli', replacement: 'ful', condition: hasPositiveMeasure },
]

function step2(word: string): string {
  // alli is tried before the bli rule and the result goes through step 2 again
  if (word.endsWith('alli') && hasPositiveMeasure(replaceSuffix(word, 'alli', ''))) {
    return step2(replaceSuffix(word, 'alli', 'al'))
  }
  const rules: StemRule[] = [...STEP2_BASE_RULES]
  // the 'l' of logi -> log stays with the stem, so short stems like geo work; the
  // condition looks at word minus 'ogi', which is why it is built per word
  rules.push({
    suffix: 'logi',
    replacement: 'log',
    condition: () => hasPositiveMeasure(word.slice(0, word.length - 3)),
  })
  return applyRuleList(word, rules)
}

function step3(word: string): string {
  return applyRuleList(word, [
    { suffix: 'icate', replacement: 'ic', condition: hasPositiveMeasure },
    { suffix: 'ative', replacement: '', condition: hasPositiveMeasure },
    { suffix: 'alize', replacement: 'al', condition: hasPositiveMeasure },
    { suffix: 'iciti', replacement: 'ic', condition: hasPositiveMeasure },
    { suffix: 'ical', replacement: 'ic', condition: hasPositiveMeasure },
    { suffix: 'ful', replacement: '', condition: hasPositiveMeasure },
    { suffix: 'ness', replacement: '', condition: hasPositiveMeasure },
  ])
}

function step4(word: string): string {
  return applyRuleList(word, [
    { suffix: 'al', replacement: '', condition: measureAboveOne },
    { suffix: 'ance', replacement: '', condition: measureAboveOne },
    { suffix: 'ence', replacement: '', condition: measureAboveOne },
    { suffix: 'er', replacement: '', condition: measureAboveOne },
    { suffix: 'ic', replacement: '', condition: measureAboveOne },
    { suffix: 'able', replacement: '', condition: measureAboveOne },
    { suffix: 'ible', replacement: '', condition: measureAboveOne },
    { suffix: 'ant', replacement: '', condition: measureAboveOne },
    { suffix: 'ement', replacement: '', condition: measureAboveOne },
    { suffix: 'ment', replacement: '', condition: measureAboveOne },
    { suffix: 'ent', replacement: '', condition: measureAboveOne },
    {
      suffix: 'ion',
      replacement: '',
      condition: (stem) => measure(stem) > 1 && ['s', 't'].includes(stem[stem.length - 1]),
    },
    { suffix: 'ou', replacement: '', condition: measureAboveOne },
    { suffix: 'ism', replacement: '', condition: measureAboveOne },
    { suffix: 'ate', replacement: '', condition: measureAboveOne },
    { suffix: 'iti', replacement: '', condition: measureAboveOne },
    { suffix: 'ous', replacement: '', condition: measureAboveOne },
    { suffix: 'ive', replacement: '', condition: measureAboveOne },
    { suffix: 'ize', replacement: '', condition: measureAboveOne },
  ])
}

/** step 5a tries both conditions, so it cannot go through the rule list */
function step5a(word: string): string {
  if (word.endsWith('e')) {
    const stem = replaceSuffix(word, 'e', '')
    if (measure(stem) > 1) return stem
    if (measure(stem) === 1 && !endsCvc(stem)) return stem
  }
  return word
}

function step5b(word: string): string {
  return applyRuleList(word, [
    { suffix: 'll', replacement: 'l', condition: () => measure(word.slice(0, -1)) > 1 },
  ])
}

export function stem(word: string): string {
  const lower = word.toLowerCase()
  const pooled = POOL.get(lower)
  if (pooled !== undefined) return pooled
  if (word.length <= 2) return lower

  let stemmed = step1a(lower)
  stemmed = step1b(stemmed)
  stemmed = step1c(stemmed)
  stemmed = step2(stemmed)
  stemmed = step3(stemmed)
  stemmed = step4(stemmed)
  stemmed = step5a(stemmed)
  stemmed = step5b(stemmed)
  return stemmed
}
