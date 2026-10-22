import type { ProbeRecord, ProbeSession, Repair } from './types.js'

export type Author = 'you' | 'agent' | 'tool' | 'shell'

export interface Entry {
  id: string
  kind: 'decision' | 'agent' | 'failure' | 'shell' | 'devbox'
  author: Author
  at: number
  text: string
  session: string
  turn?: number
}

export type Bound = 'max' | 'min' | 'exact'

export interface Found {
  subject: string
  bound: Bound
  value: number
  shown: string
  index: number
  end: number
  replacing: boolean
}

export interface Limit {
  id: string
  key: string
  subject: string
  bound: Bound
  value: number
  shown: string
  replacing: boolean
  recordId: string
  author: Author
  at: number
  session: string
  sentence: string
  reason?: string
  pasted?: true
}

export interface Held {
  key: string
  subject: string
  bound: Bound
  limit: Limit
  replaced: Limit[]
  also: Limit[]
  decided?: boolean
}

export interface Conflict {
  key: string
  subject: string
  bound: Bound
  limits: Limit[]
  decided?: Limit
}

export interface Rule {
  recordId: string
  author: Author
  at: number
  session: string
  sentence: string
  reason?: string
  pasted?: true
}

export interface Constraints {
  holds: Held[]
  conflicts: Conflict[]
  suggestions: Limit[]
  rules: Rule[]
  reasons?: Rule[]
  references?: Rule[]
}

const COUNTED: Record<string, string> = {
  attempt: 'attempts',
  attempts: 'attempts',
  try: 'attempts',
  tries: 'attempts',
  retry: 'retries',
  retries: 'retries',
  times: 'times',
  request: 'requests',
  requests: 'requests',
  worker: 'workers',
  workers: 'workers',
  thread: 'threads',
  threads: 'threads',
  file: 'files',
  files: 'files',
  item: 'items',
  items: 'items',
  line: 'lines',
  lines: 'lines',
  percent: 'percent',
  '%': 'percent',
  kb: 'KB',
  mb: 'MB',
  gb: 'GB',
}
const COUNTS = new Set(Object.values(COUNTED))

const DURATION: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  min: 60000,
  mins: 60000,
  minute: 60000,
  minutes: 60000,
  h: 3600000,
  hr: 3600000,
  hrs: 3600000,
  hour: 3600000,
  hours: 3600000,
}

const TIMING = ['timeout', 'deadline', 'backoff', 'delay', 'interval', 'budget', 'ttl', 'wait', 'latency', 'sleep']
const WORDS = new Map<string, RegExp>()
const word = (w: string) => WORDS.get(w) ?? WORDS.set(w, new RegExp(`\\b${w}s?\\b`, 'i')).get(w)!

const UNIT =
  '(attempts?|tries|try|retries|retry|times|requests?|workers?|threads?|files?|items?|lines?|percent|%|kb|mb|gb|milliseconds?|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|h|s)(?![a-z])'
const NUM = '(\\d+(?:\\.\\d+)?)'
const BOUNDS: Array<[string, Bound]> = [
  ['at most', 'max'],
  ['no more than', 'max'],
  ['not more than', 'max'],
  ['maximum of', 'max'],
  ['maximum', 'max'],
  ['max', 'max'],
  ['up to', 'max'],
  ['limited to', 'max'],
  ['limit to', 'max'],
  ['capped at', 'max'],
  ['capped to', 'max'],
  ['cap at', 'max'],
  ['at least', 'min'],
  ['no fewer than', 'min'],
  ['no less than', 'min'],
  ['minimum of', 'min'],
  ['minimum', 'min'],
  ['exactly', 'exact'],
  ['allow only', 'max'],
  ['allow', 'max'],
  ['permit only', 'max'],
  ['permit', 'max'],
]
const TRAILING: Array<[string, Bound]> = [
  ['at most', 'max'],
  ['maximum', 'max'],
  ['max', 'max'],
  ['or fewer', 'max'],
  ['or less', 'max'],
  ['at least', 'min'],
  ['minimum', 'min'],
  ['or more', 'min'],
]
const words = (pairs: Array<[string, Bound]>) => pairs.map(([w]) => w.replace(/ /g, '\\s+')).join('|')
const boundOf = (pairs: Array<[string, Bound]>, phrase: string): Bound =>
  pairs.find(([w]) => w === phrase.toLowerCase().replace(/\s+/g, ' '))?.[1] ?? 'max'

const LEADING_RE = new RegExp(`\\b(${words(BOUNDS)})\\s+${NUM}\\s*${UNIT}`, 'gi')
const TRAILING_RE = new RegExp(`\\b${NUM}\\s*${UNIT}\\s+(${words(TRAILING)})\\b`, 'gi')
const CAP_RE = new RegExp(`\\b(?:limit|cap)\\s+(?:the\\s+)?(?:total\\s+)?(?:number\\s+of\\s+)?([a-z]+)\\s+(?:to|at)\\s+${NUM}(?:\\s*${UNIT})?`, 'gi')
const CHANGE_RE = new RegExp(`\\b(?:([a-z]+)\\s+(?:limit\\s+)?)?from\\s+${NUM}\\s*(?:${UNIT})?\\s+to\\s+${NUM}(?:\\s*${UNIT})?`, 'gi')
const TRY_RE = new RegExp(`\\b(?:try|tries|attempt|attempts)\\b(?:\\s+[a-z]+){0,3}?\\s+${NUM}\\s*times\\b`, 'gi')
const REPLACING_RE =
  /\binstead\b|\breplac(?:e|es|ed|ing)\b|\brather than\b|\bno longer\b|\bfrom\s+\d+(?:\.\d+)?\s*[a-z%]*\s+to\s+\d|\bchang(?:e|es|ed|ing)\b.*\bto\s+\d|\bupdat(?:e|es|ed|ing)\b.*\bto\s+\d|\bnot\s+\d+\s*[a-z]*\s+any\s?more\b/i
const SUGGEST_RE = new RegExp(
  `\\b(?:rais(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|lower(?:s|ed|ing)?|reduc(?:e|es|ed|ing)|set(?:s|ting)?|bump(?:s|ed|ing)?|extend(?:s|ed|ing)?|chang(?:e|es|ed|ing)|cut(?:s|ting)?|shorten(?:s|ed|ing)?|lengthen(?:s|ed|ing)?)\\s+(?:the\\s+)?(?:[a-z-]+\\s+){0,2}?([a-z]+)\\s+to\\s+${NUM}(?:\\s*${UNIT})?`,
  'gi',
)
const RULE_RE = /\b(?:never|do not|don['\u2019]t|must not|mustn['\u2019]t|only|must|always|(?:on|with|use|keep|against) the same)\b/i
const PASTED_CHARS = 600
const PASTED_LINES = 10
const PASTED_LONG = 1500
const REASON_RE = /\b(?:because|so that|due to)\b\s*(.+?)[\s.!?]*$/i
const NEXT_REASON_RE = /^(?:this is |that['\u2019]s |that is )?because\b\s*(.+?)[\s.!?]*$|^the reason (?:is|being)\s+(.+?)[\s.!?]*$/i

function timingIn(sentence: string, start: number, end: number): string | undefined {
  const within = (cut: RegExp) => {
    const cuts = [...sentence.matchAll(cut)].map((b) => b.index)
    const part = sentence.slice(Math.max(0, ...cuts.filter((i) => i < start)), Math.min(sentence.length, ...cuts.filter((i) => i >= end)))
    return TIMING.find((w) => word(w).test(part)) ?? (/\btim(?:e|es|ed|ing) out\b/i.test(part) ? 'timeout' : undefined)
  }
  return within(/(?<!\b(?:e\.g|i\.e|etc|vs))[.!?]\s/gi)
}

function measure(unit: string | undefined, sentence: string, start = 0, end = sentence.length, noun = ''): { subject: string; factor: number } | null {
  if (!unit) return null
  const u = unit.toLowerCase()
  if (u in COUNTED) return { subject: COUNTED[u], factor: 1 }
  if (u in DURATION) {
    const named = noun.toLowerCase().replace(/s$/, '')
    const timing = TIMING.includes(named) ? named : timingIn(sentence, start, end)
    return { subject: timing ?? 'duration', factor: DURATION[u] }
  }
  return null
}

const CARDINAL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
const TENS: Record<string, number> = { thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const CARDINAL_RE = new RegExp(`\\b(?:${[...CARDINAL, ...Object.keys(TENS)].join('|')})\\b`, 'gi')
const digitized = (t: string) =>
  t.replace(/\bhalf an? (minute|hour)\b/gi, (w, u: string) => (u.toLowerCase() === 'minute' ? '30 seconds' : '30 minutes').padEnd(w.length)).replace(CARDINAL_RE, (w) => {
    const n = String(TENS[w.toLowerCase()] ?? CARDINAL.indexOf(w.toLowerCase()))
    return n.padEnd(w.length)
  })

const wordEnd = (text: string, end: number) => {
  while (end < text.length && /\w/.test(text[end]) && /\w/.test(text[end - 1] ?? '')) end++
  return end
}

export function limitsIn(text: string): Found[] {
  const sentence = digitized(text)
  const replacing = REPLACING_RE.test(sentence)
  const found: Found[] = []
  const add = (index: number, matched: string, bound: Bound, value: number, m: { subject: string; factor: number }) => {
    const end = wordEnd(text, index + matched.length)
    found.push({ subject: m.subject, bound, value: value * m.factor, shown: text.slice(index, end).trim(), index, end, replacing })
  }
  for (const m of sentence.matchAll(LEADING_RE)) {
    const unit = measure(m[3], sentence, m.index, m.index + m[0].length)
    if (unit) add(m.index, m[0], boundOf(BOUNDS, m[1]), Number(m[2]), unit)
  }
  for (const m of sentence.matchAll(TRAILING_RE)) {
    const unit = measure(m[2], sentence, m.index, m.index + m[0].length)
    if (unit) add(m.index, m[0], boundOf(TRAILING, m[3]), Number(m[1]), unit)
  }
  for (const m of sentence.matchAll(CAP_RE)) {
    const noun = m[1].toLowerCase()
    const unit = noun in COUNTED ? { subject: COUNTED[noun], factor: 1 } : TIMING.includes(noun.replace(/s$/, '')) ? measure(m[3], sentence, m.index, m.index + m[0].length, noun) : null
    if (unit) add(m.index, m[0], 'max', Number(m[2]), unit)
  }
  for (const m of sentence.matchAll(CHANGE_RE)) {
    const noun = m[1]?.toLowerCase()
    const unit = measure(m[5] ?? m[3], sentence, m.index, m.index + m[0].length) ?? (noun && noun in COUNTED ? { subject: COUNTED[noun], factor: 1 } : null)
    if (unit) add(m.index + (m[1] ? m[0].indexOf('from') : 0), m[1] ? m[0].slice(m[0].indexOf('from')) : m[0], 'max', Number(m[4]), unit)
  }
  for (const m of sentence.matchAll(TRY_RE)) add(m.index, m[0], 'max', Number(m[1]), { subject: 'attempts', factor: 1 })
  found.sort((a, b) => a.index - b.index || b.end - a.end)
  return found.filter((f, i) => !found.slice(0, i).some((g) => f.index < g.end && g.index < f.end))
}

function suggestedIn(text: string): Found[] {
  const sentence = digitized(text)
  const out: Found[] = []
  for (const m of sentence.matchAll(SUGGEST_RE)) {
    const noun = m[1].toLowerCase()
    const unit = m[3]?.toLowerCase()
    const timing = noun.replace(/s$/, '')
    const kind = noun in COUNTED ? { subject: COUNTED[noun], factor: 1 } : TIMING.includes(timing) && unit && unit in DURATION ? { subject: timing, factor: DURATION[unit] } : null
    const end = wordEnd(text, m.index + m[0].length)
    if (kind) out.push({ subject: kind.subject, bound: 'max', value: Number(m[2]) * kind.factor, shown: text.slice(m.index, end).trim(), index: m.index, end, replacing: false })
  }
  return out
}

export function sentencesOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[。！？])/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/))
    .map((s) => s.trim())
    .filter(Boolean)
}

function reasonFor(sentences: string[], i: number): string | undefined {
  const same = REASON_RE.exec(sentences[i])?.[1] ?? /(?:因为|由[于於]|为了|為了)(.+?)[。！？]*$/.exec(sentences[i])?.[1]
  if (same) return same
  const next = sentences[i + 1] ? NEXT_REASON_RE.exec(sentences[i + 1]) : null
  return next ? (next[1] ?? next[2]) : undefined
}

function replaces(limit: Limit, previous: Limit[]): boolean {
  if (!limit.replacing) return false
  const prior = new RegExp(`(?:instead of|from)\\s+${NUM}(?:\\s*${UNIT})?`, 'i').exec(digitized(limit.sentence))
  if (!prior) return true
  const unit = prior[2] ?? new RegExp(`${NUM}\\s*${UNIT}`, 'i').exec(limit.shown)?.[2]
  const scale = measure(unit, limit.sentence)?.factor
  return scale !== undefined && previous.some((p) => p.value === Number(prior[1]) * scale)
}

export function constraints(entries: Entry[], decisions: Record<string, string> = {}, session = entries[0]?.session): Constraints {
  const ordered = [...entries].sort((a, b) => a.at - b.at)
  const held = new Map<string, Held>()
  const conflicts = new Map<string, Conflict>()
  const order: string[] = []
  const suggestions: Limit[] = []
  const rules: Rule[] = []
  const reasons: Rule[] = []
  const references: Rule[] = []
  for (const entry of ordered) {
    if (entry.kind !== 'decision' && entry.kind !== 'agent') continue
    const sentences = sentencesOf(entry.text)
    const pasted = entry.text.length > PASTED_LONG || (entry.text.length > PASTED_CHARS && entry.text.split('\n').filter((l) => l.trim()).length >= PASTED_LINES)
    let n = 0
    sentences.forEach((sentence, i) => {
      const found = limitsIn(sentence)
      if (entry.author === 'agent') found.push(...suggestedIn(sentence).filter((g) => !found.some((f) => f.index < g.end && g.index < f.end)))
      const reason = reasonFor(sentences, i)
      const source: Rule = { recordId: entry.id, author: entry.author, at: entry.at, session: entry.session, sentence, ...(reason ? { reason } : {}), ...(pasted ? { pasted: true } : {}) }
      const scoped = /^(?:for|in|on)\s+(?!now\b|this conversation\b)[^,;:]+[,;:]/i.test(sentence)
      const untranslated = /[\u3400-\u9fff]/.test(sentence)
      if (entry.session !== session || scoped || untranslated) {
        if (entry.author === 'you' && (found.length || RULE_RE.test(sentence) || reason || untranslated)) references.push(source)
        if (entry.session === session && entry.author === 'you' && reason) reasons.push(source)
        return
      }
      if (entry.author === 'you' && reason && found.length === 0) reasons.push(source)
      if (found.length === 0) {
        if (entry.author === 'you' && RULE_RE.test(sentence)) {
          rules.push({ recordId: entry.id, author: entry.author, at: entry.at, session: entry.session, sentence, ...(reason ? { reason } : {}), ...(pasted ? { pasted: true } : {}) })
        }
        return
      }
      for (const f of found) {
        const limit: Limit = {
          id: `${entry.id}#${n++}`,
          key: `${f.subject}|${f.bound}`,
          subject: f.subject,
          bound: f.bound,
          value: f.value,
          shown: f.shown,
          replacing: f.replacing,
          recordId: entry.id,
          author: entry.author,
          at: entry.at,
          session: entry.session,
          sentence,
          ...(reason ? { reason } : {}),
          ...(pasted ? { pasted: true } : {}),
        }
        if (entry.author === 'agent') {
          suggestions.push(limit)
          continue
        }
        const now = held.get(limit.key)
        const open = conflicts.get(limit.key)
        if (!now && !open) {
          order.push(limit.key)
          held.set(limit.key, { key: limit.key, subject: limit.subject, bound: limit.bound, limit, replaced: [], also: [] })
        } else if (now && now.limit.value === limit.value) {
          now.also.push(now.limit)
          now.limit = limit
        } else if (now && replaces(limit, [now.limit])) {
          now.replaced.push(...now.also, now.limit)
          now.also = []
          now.limit = limit
        } else if (now) {
          held.delete(limit.key)
          conflicts.set(limit.key, { key: limit.key, subject: limit.subject, bound: limit.bound, limits: [now.limit, limit] })
        } else if (open && replaces(limit, open.limits)) {
          conflicts.delete(limit.key)
          held.set(limit.key, { key: limit.key, subject: limit.subject, bound: limit.bound, limit, replaced: open.limits, also: [] })
        } else if (open) {
          open.limits.push(limit)
        }
      }
    })
  }
  const holds: Held[] = []
  const open: Conflict[] = []
  for (const key of order) {
    const h = held.get(key)
    if (h) holds.push(h)
    const c = conflicts.get(key)
    if (!c) continue
    const decided = c.limits.find((l) => l.id === decisions[key])
    if (decided) {
      c.decided = decided
      holds.push({ key, subject: c.subject, bound: c.bound, limit: decided, replaced: c.limits.filter((l) => l !== decided), also: [], decided: true })
    }
    open.push(c)
  }
  return { holds, conflicts: open, suggestions, rules, reasons, references }
}

export interface Brief {
  leftAt?: number
  why?: { reason?: string; sentence: string; at: number; session: string; recordId: string }
  stopped?: Entry
  updated?: { at: number; key: string; from: Limit; to: Limit }
  since?: Entry
  failing?: Entry
  suggestions: Limit[]
  unexplained: Held[]
  holds: Held[]
  rules: Rule[]
  reasons?: Rule[]
  references?: Rule[]
}

const newest = <T extends { at: number }>(xs: T[]): T | undefined => xs.reduce<T | undefined>((a, b) => (!a || b.at >= a.at ? b : a), undefined)

export const VISIT_GAP = 30 * 60

export const leftOf = (w: { seenAt?: number; lookedAt?: number }, now: number): number | undefined => (w.lookedAt !== undefined && now - w.lookedAt > VISIT_GAP ? w.lookedAt : w.seenAt)

export const latestOf = (repairs: Repair[], keep: (r: Repair) => boolean = () => true) => repairs.reduce<Repair | undefined>((best, r) => (keep(r) && (!best || r.sentAt > best.sentAt) ? r : best), undefined)
export const actedAt = (repairs: Repair[]): number | undefined => latestOf(repairs, wentOut)?.sentAt

export function briefOf(entries: Entry[], c: Constraints, session: string, leftAt?: number, acted?: number): Brief {
  const before = (at: number) => leftAt === undefined || at <= leftAt
  const after = (at: number) => leftAt === undefined || at > leftAt
  const live = c.holds.filter((h) => !h.decided)
  const yours = [...live.map((h) => h.limit), ...c.rules, ...(c.reasons ?? [])].filter((x) => x.author === 'you')
  const mine = yours.some((x) => !x.pasted) ? yours.filter((x) => !x.pasted) : yours
  const reasons = mine.filter((x) => x.reason)
  const kept = mine.filter((x) => before(x.at)).sort((a, b) => b.at - a.at || b.sentence.length - a.sentence.length)[0]
  const why = newest(reasons.filter((x) => before(x.at))) ?? (leftAt === undefined ? undefined : kept) ?? newest(reasons)
  const agentSaid = entries.filter((e) => e.session === session && e.kind === 'agent')
  const held = new Map(c.holds.map((h) => [h.key, h.limit.value]))
  const suggested = new Map<string, Limit>()
  for (const s of c.suggestions.filter((x) => acted === undefined || x.at > acted)) {
    if (held.get(s.key) === s.value) suggested.delete(s.key)
    else suggested.set(s.key, s)
  }
  const updated = newest(live.filter((h) => h.replaced.length > 0).map((h) => ({ at: h.limit.at, key: h.key, from: h.replaced[h.replaced.length - 1], to: h.limit })))
  const stopped = newest(agentSaid.filter((e) => before(e.at)))
  const since = leftAt === undefined ? undefined : newest(agentSaid.filter((e) => after(e.at)))
  const failing = newest(entries.filter((e) => e.kind === 'failure' && (acted === undefined || e.at > acted)))
  return {
    ...(leftAt === undefined ? {} : { leftAt }),
    ...(why ? { why: { ...(why.reason ? { reason: why.reason } : {}), sentence: why.sentence, at: why.at, session: why.session, recordId: why.recordId } } : {}),
    ...(stopped ? { stopped } : {}),
    ...(updated ? { updated } : {}),
    ...(since ? { since } : {}),
    ...(failing ? { failing } : {}),
    suggestions: [...suggested.values()],
    unexplained: live.filter((h) => !h.limit.reason),
    holds: live,
    rules: c.rules,
    references: c.references,
  }
}

const firstLine = (text: string) => text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
const clipped = (text: string, n = 160) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

export const spoken = (text: string, brief: Brief): string =>
  sentencesOf(text.replace(/^\s*\[devbox result [^\]]*\]\s*/, ''))
    .filter((s) => !brief.suggestions.some((g) => s.includes(g.sentence)))
    .join(' ')

const pairs = (t: string) => {
  const w = t.toLowerCase().match(/[a-z]+/g) ?? []
  return w.slice(1).map((x, i) => `${w[i]} ${x}`)
}

export const checkedRule = (check: string | undefined, rules: Rule[]): Rule | undefined => {
  const words = check ? pairs(firstLine(check)) : []
  return words.length ? rules.find((r) => pairs(r.sentence).some((p) => words.includes(p))) : undefined
}

const BREAK = /[:;,]\s|\s—\s|\s[-–]\s(?!\d)/g

export const clause = (sentence: string) => (/^(?:never|do not|don['\u2019]t)\s+(?:merge|push|deploy)\s*,/i.test(sentence) ? sentence : sentence.split(BREAK)[0]).replace(/[.!]$/, '')

export function clauseRest(sentence: string): string {
  const at = [...sentence.matchAll(BREAK)][0]
  return at ? sentence.slice(at.index + at[0].length).trim().replace(/[.!]$/, '') : ''
}

export const checkName = (text: string) => clipped(firstLine(text).replace(/^(?:FAIL(?:ED)?|ERROR|[✗×])[:\s]+/i, ''), 90)

const seconds = (n: string, unit: string) => Number(n) * (unit.toLowerCase() === 'ms' ? 0.001 : 1)
const apart = (a: number, b: number) => {
  const at = (d: number) => [a, b].map((n) => String(Math.round(n * 10 ** d) / 10 ** d))
  return [1, 2, 3, 4, 5, 6].map(at).find(([x, y]) => x !== y) ?? at(6)
}

export function measured(check: string): string | undefined {
  const m = /expected\s*:?\s*(≤|<=|<|≥|>=|>)\s*([\d.]+)\s*(ms|s)\b[\s\S]*?received\s*:?\s*([\d.]+)\s*(ms|s)\b/i.exec(check)
  if (!m) return undefined
  const [got, bound] = apart(seconds(m[4], m[5]), seconds(m[2], m[3]))
  return `${got} s, ${/[≥>]/.test(m[1]) ? 'minimum' : 'limit'} ${bound} s`
}

type Amount = Pick<Limit, 'subject' | 'value'>
const NOUN: Record<string, string> = { ...COUNTED, time: 'times' }
const ms = (n: number) => `${Math.round(n * 1e3) / 1e3} ms`
const keyOf = (n: number, unit: string) => {
  const u = unit.toLowerCase()
  return Object.hasOwn(DURATION, u) ? ms(n * DURATION[u]) : `${n} ${Object.hasOwn(NOUN, u) ? NOUN[u] : u}`
}
const amounts = (text: string) => {
  const t = digitized(text)
  return [
  ...[...t.matchAll(/(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s*|-)([a-z]+|%)(?![a-z0-9]|-\w)/gi)].map((m) => ({ at: m.index, end: m.index + m[0].length, key: keyOf(Number(m[1].replace(/,/g, '') + (m[2] ?? '')), m[3]) })),
  ...[...t.matchAll(/(?<![\w.,])(\d+(?:\.\d+)?)\s*[-–]\s*\d+(?:\.\d+)?\s*([a-z]+|%)(?![a-z0-9]|-\w)/gi)].map((m) => ({ at: m.index, end: m.index + m[1].length, key: keyOf(Number(m[1]), m[2]) })),
  ]
}
function clauseAt(sentence: string, hit: { at: number; end: number }): string {
  const breaks = [...sentence.matchAll(BREAK)]
  const before = breaks.filter((b) => b.index < hit.at).at(-1)
  const end = breaks.find((b) => b.index >= hit.end)?.index ?? sentence.length
  return sentence.slice(before ? before.index + before[0].length : 0, end).trim().replace(/^(?:and|but)\s+/i, '').replace(/[.!]$/, '')
}

export const sinceLeft = (b: Pick<Brief, 'suggestions' | 'leftAt'>) => b.suggestions.filter((x) => b.leftAt === undefined || x.at > b.leftAt)

export function namedRule(s: Amount, rules: Rule[]): { rule: Rule; clause: string } | undefined {
  const want = COUNTS.has(s.subject) ? `${s.value} ${s.subject}` : ms(s.value)
  const value = String(s.value).replace('.', '\\.')
  const nouns = [s.subject, ...Object.keys(COUNTED).filter((k) => /^[a-z]+$/.test(k) && COUNTED[k] === s.subject)]
  const names = (t: string) => nouns.some((w) => word(w).test(t))
  const bare = (t: string) =>
    COUNTS.has(s.subject)
      ? [...t.matchAll(new RegExp(`\\b(?:${nouns.join('|')})s?\\b(?:\\s+(?:to|at|above|below|under|over|than|more|less|fewer|most|least|max|maximum|minimum|beyond|past|of|stay|stays|remain|exceed)){1,3}\\s+(${value})(?!\\d|[.,:]\\d|\\s*-?\\s*\\d|\\s*[a-z%])`, 'gi'))].map((m) => ({ at: m.index + m[0].length - m[1].length, end: m.index + m[0].length }))
      : []
  const pairs = rules.flatMap((rule) =>
    [
      ...amounts(rule.sentence)
        .filter((a) => a.key === want)
        .map((hit) => ({ at: hit.at, rule, clause: clauseAt(rule.sentence, hit) })),
      ...bare(rule.sentence).map((hit) => ({ at: hit.at, rule, clause: clauseAt(rule.sentence, hit) })),
    ].sort((a, b) => a.at - b.at),
  )
  const other = (t: string) => !COUNTS.has(s.subject) && TIMING.some((w) => w !== s.subject && word(w).test(t))
  return pairs.find((p) => names(p.clause)) ?? pairs.find((p) => !other(p.clause))
}

export const QUESTION_AFTER_REPLY =
  "Using the recorded messages, check the latest reply against the failed check and what I asked: what changed, what was run and its output, and what is still unresolved. Separate facts from guesses, and say what is unknown. Don't change code or run tests."

export const QUESTION_WAITING =
  "Using the recorded messages, say what the agent is waiting for me to decide, the options it gave, and which of my earlier decisions and rules bear on each. Separate facts from guesses, and say what is unknown. Don't change code or run tests."

export const QUESTION_CATCH_UP = "Using the recorded messages, say what changed since I left and what is still open. Separate facts from guesses, and say what is unknown. Don't change code or run tests."

export const QUESTION_START = "Using the recorded messages, explain why the latest check still fails and what was tried since I left. Separate facts from guesses, and say what is unknown. Don't change code or run tests."

export const REPORT_BACK = 'Report back: what you changed, which tests you ran and their output, and what is still unresolved.'

const FIX_DECISION = 'Decision: find and fix why the recorded failure quoted below fails, then rerun the checks that cover it.'

const CHECK_THEN_FIX = 'Decision: check the current revision and rerun the relevant checks first. Only if the recorded failure still occurs, fix its cause and rerun those checks; otherwise report the revision and current test evidence without unnecessary edits.'

export function draftFor(brief: Brief): string {
  const last = brief.since ?? brief.stopped
  const decision = brief.failing ? CHECK_THEN_FIX : last ? 'Decision: pick up from your last message and finish what it leaves open.' : 'Decision: '
  return [
    'Please continue in this conversation.',
    '',
    decision,
    'Follow my decisions and the limits quoted below, not earlier agent suggestions.',
    REPORT_BACK,
  ].join('\n')
}

export interface Issue {
  key: string
  line: number
  text: string
  found: Found
  holds: Held
}

export interface Correction {
  id: string
  before: string
  after: string
}

export interface Basis {
  key: string
  value?: number
  recordId?: string
  undecided?: boolean
}

export interface Difference {
  key: string
  subject: string
  change: 'value' | 'undecided' | 'new' | 'removed' | 'unchecked'
  before?: Basis
  after?: Limit
}

export const wentOut = (r: Repair) => r.state !== 'failed'
export const newerThan = (r: Repair, repairs: Repair[]) => latestOf(repairs, (x) => x.id !== r.id && x.sentAt > r.sentAt && wentOut(x))
export const sentWith = (version: string, repairs: Repair[], except?: string) => latestOf(repairs, (r) => r.id !== except && r.draftVersion === version && wentOut(r))
export const shownAs = (draft: { follows?: number } | null | undefined, version: string, repairs: Repair[]) => {
  const sent = sentWith(version, repairs)
  return sent && !(draft?.follows !== undefined && sent.sentAt <= draft.follows) ? sent : undefined
}

export const LOST = new Set(['other_conversation', 'other_session', 'gone', 'bad_target'])
export const lostAt = (r: Repair) => r.state === 'unknown' && r.reason !== undefined && LOST.has(r.reason)
export const mayHaveLanded = (r: Repair) => r.state === 'held' || r.state === 'unknown'
export const conversationOf = (s: ProbeSession | undefined) => (s?.agent === 'claude' && s.transcript ? s.registry?.sessionId : undefined)
export interface RetryNow {
  version: string
  repairs: Repair[]
  c: Constraints
  conversation?: string
  target?: string
}
export function retryBlock(r: Repair, now: RetryNow): string | undefined {
  const landed = mayHaveLanded(r)
  if (!landed && r.state !== 'failed') return 'not_retryable'
  if (landed && newerThan(r, now.repairs)) return 'superseded'
  if (lostAt(r)) return 'lost'
  if (r.draftVersion !== now.version) return 'draft_changed'
  if (!landed && sentWith(now.version, now.repairs, r.id)) return 'already_sent'
  if (landed && differences(r.basis, now.c).length) return 'basis_changed'
  if (now.conversation === undefined) return 'no_registry'
  const want = landed ? r.target.sessionId : now.target
  if (!want) return 'no_target'
  return want === now.conversation ? undefined : 'other_conversation'
}

export const UNDO_REFUSED = "That line was edited after the change, so Devbox can't undo it safely. Edit it directly; your later edits stay."

const beyondCap = (found: Found, c: Constraints) => {
  const cap = c.holds.find((h) => h.key === 'attempts|max')
  return cap && (found.subject === 'retries' || found.subject === 'times') && found.bound === 'max' && found.value > cap.limit.value ? cap : undefined
}

const within = (value: number, bound: Bound, limit: number) => (bound === 'max' ? value <= limit : bound === 'min' ? value >= limit : value === limit)

function allIssues(text: string, c: Constraints): Issue[] {
  const seen = new Map<string, number>()
  const issues: Issue[] = []
  text.split('\n').forEach((line, i) => {
    const occurrence = seen.get(line) ?? 0
    seen.set(line, occurrence + 1)
    const limits = limitsIn(line)
    const set = suggestions(line).filter((g) => !limits.some((f) => f.index < g.end && g.index < f.end))
    for (const found of [...limits, ...set]) {
      const cap = beyondCap(found, c)
      for (const holds of cap ? [cap] : c.holds.filter((h) => h.subject === found.subject && !within(found.value, h.bound, h.limit.value))) issues.push({ key: `${holds.key}|${holds.limit.value}|${line}|${occurrence}|${found.index}`, line: i, text: line, found, holds })
    }
  })
  return issues
}

export const draftIssues = (text: string, c: Constraints, earlier: string[] = []): Issue[] => allIssues(text, c).filter((issue) => !earlier.includes(issue.text.trim()))

export const keptLines = (text: string, earlier: string[]) => {
  const at = new Map<string, number[]>()
  text.split('\n').forEach((l, i) => earlier.includes(l.trim()) && at.set(l.trim(), [...(at.get(l.trim()) ?? []), i]))
  return [...at].map(([line, lines]) => ({ line, lines }))
}

function unitFor(unit: string, n: number): string {
  if (!unit) return unit
  const plural = COUNTED[unit.toLowerCase()]
  if (plural && SINGULAR[plural]) return n === 1 ? SINGULAR[plural] : plural
  const u = unit.toLowerCase()
  if (n === 1 && u.endsWith('s') && u.slice(0, -1) in DURATION) return unit.slice(0, -1)
  if (n !== 1 && `${u}s` in DURATION) return `${unit}s`
  return unit
}

export function changeIssue(text: string, issue: Issue, id: string): { text: string; correction: Correction } {
  const lines = text.split('\n')
  const before = lines[issue.line]
  const { index, shown, value } = issue.found
  const number = [...digitized(shown).matchAll(/(\d+(?:\.\d+)?)(\s*)([a-z]+)?/gi)].at(-1)
  const factor = number ? value / Number(number[1]) : 1
  const n = issue.holds.limit.value / factor
  const unit = issue.found.subject === issue.holds.subject ? (number?.[3] ?? '') : issue.holds.subject
  const replaced = number ? shown.slice(0, number.index) + `${n}${number[2] ? ' ' : ''}${unitFor(unit, n)}` + shown.slice(number.index + number[0].length) : shown
  const after = before.slice(0, index) + replaced + before.slice(index + shown.length)
  lines[issue.line] = after
  return { text: lines.join('\n'), correction: { id, before, after } }
}

export function undoCorrection(text: string, correction: Correction): { text: string; refused?: string } {
  const lines = text.split('\n')
  const at = lines.flatMap((line, i) => (line === correction.after ? [i] : []))
  if (at.length !== 1) return { text, refused: UNDO_REFUSED }
  lines[at[0]] = correction.before
  return { text: lines.join('\n') }
}

export interface RuleHit {
  key: string
  line: number
  text: string
  shown: string
  rule: Rule
  clause: string
}

const KEEPS_OUT = /\b(?:don['\u2019]t|do not|never|not|no|without|avoid|instead of)\b/i
const keptOut = (line: string, at: number) => {
  const lead = line.slice(0, at)
  const sentence = lead.slice(lead.match(/^.*[.!?:;]\s/)?.[0].length ?? 0)
  if (/\b(?:never|do not|don['\u2019]t)\s+(?:merge|push|deploy)(?:\s*,\s*(?:merge|push|deploy))*\s*,?\s*(?:(?:and|or|nor)\s+)?$/i.test(sentence)) return true
  return KEEPS_OUT.test(lead.slice(lead.match(/^.*(?:[.!?:;,]\s|\s—\s)/)?.[0].length ?? 0))
}
const suggestions = (line: string) => suggestedIn(line).filter((f) => !keptOut(line, f.index))

const OUT_OF_SCOPE = /\b(?:merg(?:e|es|ed|ing)(?!\s+conflicts?\b)|push(?:es|ed|ing)?(?!\s+(?:[\w-]+\s+){0,2}(?:over|past|beyond|above|up|back|through)\b)|deploy(?:s|ed|ing)?)\b/gi
const SET_ASIDE = /\b(?:(?:ignore|disregard|skip|bypass|override|disable)\s+(?:(?:the|my|your|all|any|these|those|this)\s+)?(?:[\w-]+\s+){0,4}?(?:limits?|rules?|constraints?|tests?|checks?)|mark\s+(?:[\w-]+\s+){1,5}?as\s+(?:skipped|pending|todo|flaky)|(?:delete|remove|comment\s+out)\s+(?:(?:the|my|your|all|any|these|those|this|that)\s+)?(?:[\w-]+\s+){0,4}?(?:assertions?|tests?|checks?))\b/gi

export const scopeHits = (text: string) =>
  text.split('\n').flatMap((line, i) =>
    [...(/\bask/i.test(line) ? [] : [...line.matchAll(OUT_OF_SCOPE)].map((m) => ({ m, kind: 'ship' as const }))), ...[...line.matchAll(SET_ASIDE)].map((m) => ({ m, kind: 'ignore' as const }))]
      .filter(({ m }) => !keptOut(line, m.index))
      .map(({ m, kind }) => ({ line: i, shown: m[0], kind })),
  )

const SAME_SETTING: Record<string, string[]> = { timeout: ['deadline'], deadline: ['timeout'] }

function settingRules(s: Found, rules: Rule[]): Array<{ rule: Rule; clause: string }> {
  if (s.subject === 'duration') return []
  const out: Array<{ rule: Rule; clause: string }> = []
  const counted = COUNTS.has(s.subject)
  const nouns = [s.subject, ...(SAME_SETTING[s.subject] ?? []), ...Object.keys(COUNTED).filter((k) => /^[a-z]+$/.test(k) && COUNTED[k] === s.subject)]
  for (const rule of rules)
    for (const a of amounts(rule.sentence)) {
      if (!a.key.endsWith(counted ? ` ${s.subject}` : ' ms') || keptOut(rule.sentence, a.at)) continue
      const clause = clauseAt(rule.sentence, a)
      if (!nouns.some((w) => word(w).test(clause))) continue
      const b = limitsIn(clause).find((f) => f.subject === s.subject)
      const fits = !b ? a.key === (counted ? `${s.value} ${s.subject}` : ms(s.value)) : within(s.value, b.bound, b.value)
      if (!fits && !out.some((x) => x.rule === rule)) out.push({ rule, clause })
    }
  return out
}

const FORBIDS = /\b(?:never|do not|don['\u2019]t|must not|mustn['\u2019]t)\s+(?:ever\s+)?([a-z]+)\s+(?:(?:the|a|an|any|this|that|your|my|our)\s+)?([a-z][\w-]*)/gi
const NOT_THINGS = new Set(['it', 'them', 'that', 'this', 'anything', 'something', 'to', 'be', 'more', 'less', 'than', 'until', 'without', 'unless', 'with', 'on', 'in', 'at', 'for', 'by', 'as', 'up', 'down'])

function forbidden(line: string, rules: Rule[]): Array<{ rule: Rule; clause: string; shown: string }> {
  if (/\bask/i.test(line)) return []
  return rules.flatMap((rule) =>
    [...rule.sentence.matchAll(FORBIDS)].flatMap((r) => {
      const clause = clauseAt(rule.sentence, { at: r.index, end: r.index + r[0].length })
      if (NOT_THINGS.has(r[2].toLowerCase()) || /\d/.test(clause)) return []
      const m = new RegExp(`\\b${r[1].replace(/e$/i, '')}(?:e|es|ed|ing|s)?\\s+(?:[\\w-]+\\s+){0,3}?${r[2]}s?\\b`, 'i').exec(line)
      return m && !keptOut(line, m.index) ? [{ rule, clause, shown: m[0] }] : []
    }),
  )
}

export const exceptionKey = (h: { key: string; text: string }) => `${h.key}\n${h.text}`
export const exceptionLine = (key: string) => (key.includes('\n') ? key.slice(key.lastIndexOf('\n') + 1) : undefined)

export const asideOf = (c: Constraints, keys: string[] = [], text = '') =>
  c.rules.flatMap((rule): Array<{ rule: Rule; key: string; line?: string }> => {
    const k = ruleKey(rule)
    if (keys.includes(k)) return [{ rule, key: k }]
    const lines = text.split('\n')
    return keys.flatMap((x) => {
      const line = exceptionLine(x)
      return x.startsWith(`${k}\n`) && line !== undefined && lines.includes(line) ? [{ rule, key: x, line }] : []
    })
  })

const LOOSEN_RE =
  /\b(?:(?:loosen|relax|rais|increas|extend|lift|bump|doubl|lengthen)(?:e|es|ed|ing|s)?|(?:add|allow|permit|give)(?:s|ed|ing)?\s+(?:(?:it|them)\s+)?(?:(?:one|an?|some|another)\s+)?(?:more|extra|another))\s+(?:(?:the|a|an|its|this|that|our|your|my|total|overall|current)\s+){0,3}([a-z]+)/gi

function loosenedIn(line: string): Found[] {
  if (/\bask/i.test(line)) return []
  const read = [...limitsIn(line), ...suggestedIn(line)]
  return [...line.matchAll(LOOSEN_RE)].flatMap((m) => {
    const noun = m[1].toLowerCase()
    const subject = COUNTED[noun] ?? (TIMING.includes(noun.replace(/s$/, '')) ? noun.replace(/s$/, '') : undefined)
    const end = m.index + m[0].length
    if (!subject || keptOut(line, m.index) || read.some((g) => m.index < g.end && g.index < end)) return []
    return [{ subject, bound: 'max' as const, value: Infinity, shown: m[0], index: m.index, end, replacing: false }]
  })
}

const capFor = (f: Found, c: Constraints) =>
  c.holds.find((h) => !h.decided && h.bound === 'max' && (h.subject === f.subject || (SAME_SETTING[f.subject] ?? []).includes(h.subject))) ?? beyondCap(f, c)

export const limitPushes = (text: string, c: Constraints) =>
  text.split('\n').flatMap((line, i) =>
    loosenedIn(line).flatMap((f) => {
      const holds = capFor(f, c)
      return holds ? [{ line: i, text: line, shown: f.shown, holds }] : []
    }),
  )

export function draftRuleHits(text: string, c: Constraints, setAside: string[] = []): RuleHit[] {
  return text.split('\n').flatMap((line, i) => {
    const read = suggestions(line)
    const limits = limitsIn(line).filter((f) => !keptOut(line, f.index) && !read.some((g) => f.index < g.end && g.index < f.end))
    const amounted = [...read, ...limits].flatMap((found) => {
      if (c.holds.some((h) => h.key === `${found.subject}|${found.bound}`)) return []
      const named = namedRule(found, c.rules)
      return [...(named && KEEPS_OUT.test(named.clause) ? [named] : []), ...settingRules(found, c.rules)].map((h) => ({ ...h, shown: found.shown }))
    })
    const loosened = loosenedIn(line).flatMap((f) => (capFor(f, c) ? [] : settingRules(f, c.rules).map((h) => ({ ...h, shown: f.shown }))))
    return [...amounted, ...loosened, ...forbidden(line, c.rules)]
      .filter((h) => !setAside.includes(ruleKey(h.rule)) && !setAside.includes(`${ruleKey(h.rule)}\n${line}`))
      .filter((h, k, all) => all.findIndex((x) => x.rule === h.rule) === k)
      .map((h) => ({ key: ruleKey(h.rule), line: i, text: line, shown: h.shown, rule: h.rule, clause: h.clause }))
  })
}

const SPELLED = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|hundred|half|a few|a couple of|several|a dozen|second|third|fourth|fifth|sixth'
const SPELLED_RE = new RegExp(`\\b(?:${SPELLED})(?:[\\s-]+(?:${SPELLED}))*\\s+(?:(?:a|an|more|extra|total)\\s+)?${UNIT}`, 'gi')
const ORDINAL = /^(?:second|third|fourth|fifth|sixth)\b/i

const AMOUNT_RE = new RegExp(`\\b${NUM}\\s*${UNIT}`, 'gi')

const RELATIVE_RE = /\b(?:once more|one more (?:time|try|attempt|retry)|another (?:try|attempt|retry)|(?:twice|thrice)(?: more)?)\b/gi

export const evidenceAmounts = (...checks: Array<string | undefined>) => checks.flatMap((t) => (t ? [...amounts(t), ...amounts(measured(t) ?? '')].map((a) => a.key) : []))

export const uncheckedAmounts = (text: string, c?: Constraints, known: string[] = []) => {
  const attempts = c?.holds.some((h) => h.subject === 'attempts')
  const subjects = (t: string) => [...t.matchAll(AMOUNT_RE)].flatMap((m) => measure(m[2], t, m.index, m.index + m[0].length)?.subject ?? [])
  const held = new Set([...(c?.holds.map((h) => h.subject) ?? []), ...(c?.rules.flatMap((r) => subjects(r.sentence)) ?? [])])
  const replaced = new Map(c?.holds.flatMap((h) => h.replaced.map((l) => [COUNTS.has(h.subject) ? `${l.value} ${h.subject}` : ms(l.value), lower(l.shown)] as const)) ?? [])
  const stated = new Set([...known, ...(c?.rules.flatMap((r) => amounts(r.sentence).filter((a) => !keptOut(r.sentence, a.at)).map((a) => a.key)) ?? []), ...(c?.holds.map((h) => (COUNTS.has(h.subject) ? `${h.limit.value} ${h.subject}` : ms(h.limit.value))) ?? [])])
  const ruled = new Set(c?.rules.flatMap((r) => amounts(r.sentence).filter((a) => keptOut(r.sentence, a.at)).map((a) => a.key)) ?? [])
  return text.split('\n').flatMap((line, i) => {
    const read = [...limitsIn(line), ...suggestedIn(line)]
    const restated = (at: number, amount: string) => keptOut(line, at) && ruled.has(amounts(amount)[0]?.key ?? '')
    const overlapsRead = (at: number, end: number) => read.some((f) => at < f.end && f.index < end)
    const placed = [...digitized(line).matchAll(AMOUNT_RE)].filter((m) => {
      const unit = measure(m[2], line, m.index, m.index + m[0].length)
      return unit && held.has(unit.subject) && !stated.has(amounts(m[0])[0]?.key ?? '') && !overlapsRead(m.index, m.index + m[0].length) && !restated(m.index, m[0])
    })
    const found = [
      ...placed.map((m) => ({ at: m.index, end: m.index + m[0].length, shown: line.slice(m.index, m.index + m[0].length), was: replaced.get(amounts(m[0])[0]?.key ?? '') })),
      ...[...line.matchAll(SPELLED_RE)]
        .filter((m) => !overlapsRead(m.index, m.index + m[0].length) && !stated.has(amounts(m[0])[0]?.key ?? '') && !restated(m.index, m[0]))
        .filter((m) => !/(?:requests?|lines?|files?|items?)$/i.test(m[0]) && !(ORDINAL.test(m[0]) && !/\ban?\s+$/i.test(line.slice(0, m.index))))
        .map((m) => ({ at: m.index, end: m.index + m[0].length, shown: m[0] })),
      ...(attempts ? limitsIn(line).filter((f) => (f.subject === 'times' || f.subject === 'retries') && !(c && beyondCap(f, c))).map((f) => ({ at: f.index, end: f.end, shown: f.shown, count: f.value })) : []),
      ...(attempts ? [...line.matchAll(RELATIVE_RE)].map((m) => ({ at: m.index, end: m.index + m[0].length, shown: m[0] })) : []),
    ].sort((a, b) => a.at - b.at)
    return found
      .filter((x, k) => !found.slice(0, k).some((y) => x.at < y.end && y.at < x.end))
      .map((x): { line: number; shown: string; count?: number; was?: string } => ({ line: i, shown: x.shown, ...('count' in x ? { count: Number(x.count) } : {}), ...('was' in x && x.was ? { was: String(x.was) } : {}) }))
  })
}

export const amountKey = (line: string, shown: string) => `${line}|${shown}`
export const amountLine = (key: string) => (key.includes('|') ? key.slice(0, key.lastIndexOf('|')) : undefined)

export const pruned = <D extends { text: string; earlier: string[]; setAside?: string[]; read?: string[] }>(draft: D): D => {
  const lines = draft.text.split('\n')
  return {
    ...draft,
    earlier: keptLines(draft.text, draft.earlier).map((k) => k.line),
    ...(draft.setAside ? { setAside: draft.setAside.filter((k) => { const line = exceptionLine(k); return line === undefined || lines.includes(line) }) } : {}),
    ...(draft.read ? { read: draft.read.filter((k) => { const line = amountLine(k); return line !== undefined && lines.includes(line) }) } : {}),
  }
}

export function draftChecks(draft: { text: string; earlier?: string[]; setAside?: string[]; read?: string[] }, entries: Entry[], c: Constraints) {
  const { text } = draft
  const failures = entries.filter((e) => e.kind === 'failure').map((e) => e.text)
  const lines = text.split('\n')
  const pushes = limitPushes(text, c)
  const unchecked = uncheckedAmounts(text, c, evidenceAmounts(...failures)).filter((u) => !pushes.some((p) => p.line === u.line))
  const confirmed = (u: { line: number; shown: string }) => (draft.read ?? []).includes(amountKey(lines[u.line], u.shown))
  return {
    issues: draftIssues(text, c, draft.earlier),
    kept: keptLines(text, draft.earlier ?? []),
    blockers: draftBlockers(text, c),
    hits: draftRuleHits(text, c, draft.setAside),
    scope: scopeHits(text),
    pushes,
    confirmed: unchecked.filter(confirmed),
    unread: unchecked.filter((u) => !confirmed(u)),
  }
}

const SKIP_ASK = /^(?:please continue in (?:this conversation|[\w-]+)[.!]?$|follow my decisions and the limits quoted below|treat this as evidence to check|do each, or say why not:|latest result \(|the reply to \S+ doesn't seem to cover these)/i
const EARLIER_NOTE = '(Earlier comparison only, not a requirement.)'
const ASK_STOP = new Set(['also', 'what', 'which', 'that', 'this', 'with', 'from', 'your', 'them', 'they', 'then', 'their', 'there', 'about', 'still', 'report', 'back', 'decision', 'please', 'into', 'when', 'have', 'been', 'were', 'will', 'would', 'should', 'could', 'only', 'each', 'just', 'some', 'more', 'than', 'here'])
const NEGATION = /\b(?:never|not|no|nothing|none|neither|nor|without|don['\u2019]t|doesn['\u2019]t|didn['\u2019]t|won['\u2019]t|can['\u2019]t|cannot|isn['\u2019]t|wasn['\u2019]t)\b/g
const stems = (t: string) =>
  (t.toLowerCase().replace(NEGATION, ' nnot ').match(/[a-z]{4,}|\d+/g) ?? []).filter((w) => !ASK_STOP.has(w)).map((w) => w.replace(/(?:ing|ed|es|e|s)$/, '').replace(/([b-df-hj-np-tv-z])\1$/, '$1').slice(0, 5))

export const askedIn = (packet: string) => (packet.includes('\n\n') ? packet.split('\n\nWhat this is based on')[0].split('\n\n').slice(1).join('\n\n').trim() : '')

const ATTACHED = '\nAgent messages from the other sessions in this work, quoted as written and not checked:\n'
export const attachedIn = (packet: string) => {
  const block = packet.split(ATTACHED)[1]?.split('\n\nWhen you finish')[0] ?? ''
  return [...block.matchAll(/(?:^|\n)- (\S+) \(\d{4}-\d\d-\d\d \d\d:\d\dZ\): "([\s\S]*?)"(?=\n- \S+ \(\d{4}-\d\d-\d\d \d\d:\d\dZ\): "|$)/g)].map((m) => ({ from: m[1], text: m[2] }))
}

export const askedLines = (asked: string) =>
  asked
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.endsWith(EARLIER_NOTE))
    .flatMap((l) => (/^report back:/i.test(l) ? [l] : l.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/).filter((x) => !SKIP_ASK.test(x))))
    .flatMap((l) =>
      /^report back:/i.test(l)
        ? l
            .replace(/^report back:\s*/i, '')
            .replace(/\.$/, '')
            .split(/,\s*(?:and\s+)?/)
            .filter((p) => p.trim())
            .map((p) => `Report back: ${p.trim()}`)
        : [l],
    )

const FORMAT_ASK = /^(?:don['\u2019]t|do not|never|separate facts|say what is unknown|facts? (?:vs\.?|versus|or|and) (?:guess|inference|opinion)|please\b|be (?:brief|short)|keep it short|cite\b|(?:point to|quote|name) (?:the )?(?:message|file|line|source|record)s?\b)/i
export const askedParts = (question: string) =>
  question
    .split(/[?;]\s*|\.(?:\s+|$)/)
    .map((p) => p.trim().replace(/^using the recorded messages,\s*/i, ''))
    .filter((p) => p && !FORMAT_ASK.test(p))
    .flatMap((p) => p.split(/,?\s+and\s+/))
    .map((p) => p.trim())
    .filter((p) => p && !FORMAT_ASK.test(p))

const REPORTED: Array<[RegExp, RegExp]> = [
  [/what you changed/i, /\b(?:chang|fix|updat|add|remov|edit|modif|commit|renam|replac)/i],
  [/tests? you ran/i, /\btest/i],
  [/output/i, /\b(?:pass|fail|output|\d+(?:\.\d+)?\s*(?:ms|s)\b)/i],
  [/unresolved/i, /\b(?:unresolved|open (?:questions?|issues?|items?)|still (?:open|unresolved|to do|fail\w*|broken)|left to do|todo|remain\w* (?:open|unresolved|to do)|nothing (?:else )?(?:is )?(?:left|open|unresolved|remains?)|no (?:open|known) (?:issues?|questions?))/i],
]

const replySentences = (reply: string) =>
  reply
    .replace(/^\s*\[devbox result [^\]]*\]\s*/, '')
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

const sharedIn = (words: Set<string>, sentence: Set<string>) => [...words].reduce((n, w) => n + (sentence.has(w) ? (/^\d/.test(w) ? 2 : 1) : 0), 0)

const QUOTED_BASIS = /^- (?:Holds now|Decided for this work|Rule|Latest recorded failure|Recorded failure from before the last repair)\b/
export const contextOf = (packet: string) =>
  new Set(
    (packet.split('\n\nWhat this is based on')[1] ?? '')
      .split('\n')
      .filter((l) => QUOTED_BASIS.test(l))
      .flatMap((l) => (l.match(/"[^"]*"/g) ?? []).flatMap(stems)),
  )
const telling = (line: string, context: Set<string>) => {
  const all = stems(line)
  const own = all.filter((w) => !context.has(w))
  return new Set(own.length > 1 ? own : all)
}
const covers = (words: Set<string>, sentence: Set<string>) => sharedIn(words, sentence) >= Math.min(2, words.size)

const COMMIT_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi

export const unmentioned = (asked: string, reply: string, context = new Set<string>()) => {
  const sentences = replySentences(reply).map((s) => new Set(stems(s)))
  const said = reply.toLowerCase()
  return askedLines(asked).filter((line) => {
    if (/^report back:/i.test(line)) return REPORTED.some(([item, says]) => item.test(line) && !says.test(reply))
    if ((line.match(COMMIT_RE) ?? []).some((id) => !said.includes(id.toLowerCase()))) return true
    const words = telling(line, context)
    return !sentences.some((s) => covers(words, s))
  })
}

export const skippedParts = (line: string, reply: string, context = new Set<string>()) => {
  const parts = /^report back:/i.test(line)
    ? []
    : line
        .replace(/^[-*]\s+/, '')
        .split(/[?;]\s*|\.(?:\s+|$)|,?\s+and\s+/)
        .map((p) => p.trim())
        .filter((p) => stems(p).length)
  const skipped = parts.filter((p) => !partly([p], reply, stems(p).some((w) => !context.has(w)) ? context : undefined)[0])
  return { parts, skipped: parts.length < 2 ? [] : skipped }
}

export const flagNote = (line: string, reply: string, context = new Set<string>(), near?: string) => {
  const { parts, skipped } = skippedParts(line, reply, context)
  const lead = skipped.length && skipped.length < parts.length ? `The reply doesn't seem to mention ${skipped.map((x) => `“${x}”`).join(', ')}` : near || (parts.length > 1 && !skipped.length) ? 'The reply may cover this only in part' : "The reply doesn't seem to mention this"
  return near ? `${lead} · nearest in the reply: “${near}”` : `${lead}.`
}

export const nearestFor = (lines: string[], reply: string, context = new Set<string>(), unique = true) => {
  const sentences = replySentences(reply).map((s) => ({ s, words: new Set(stems(s)) }))
  const pairs = lines
    .flatMap((line, i) => {
      if (/^report back:/i.test(line)) return []
      const words = telling(line, context)
      return sentences.flatMap((x, j) => (covers(words, x.words) ? [{ i, j, n: sharedIn(words, x.words) }] : []))
    })
    .sort((a, b) => b.n - a.n)
  const near: Array<string | undefined> = lines.map(() => undefined)
  const used = new Set<number>()
  for (const x of pairs) {
    if (near[x.i] !== undefined || (unique && used.has(x.j))) continue
    near[x.i] = sentences[x.j].s
    used.add(x.j)
  }
  return near
}

export const attachedGaps = (packet: string, reply: string) => {
  const context = contextOf(packet)
  const said = unmentioned(askedIn(packet), reply, context).map((l) => new Set(stems(l)))
  return attachedIn(packet).map((a) => {
    const open = unmentioned(askedParts(a.text).join('\n'), reply, context)
    const flagged = open.filter((part) => said.some((s) => sharedIn(new Set(stems(part)), s) >= 2))
    return { ...a, missed: open.filter((part) => !flagged.includes(part)), flagged }
  })
}

export const leadAsk = (packet: string, check?: string) => {
  const lines = askedLines(askedIn(packet)).filter((l) => !/^report back:/i.test(l))
  const context = contextOf(packet)
  const lead = (lines.find((l) => /^decision:/i.test(l)) ?? lines.find((l) => stems(l).filter((w) => !context.has(w)).length > 1) ?? lines[0])?.replace(/^- /, '')
  if (lead === CHECK_THEN_FIX.split('. ')[0] + '.') return `Decision: check ${check ? `‘${check}’` : 'the recorded failure'} on the current revision; repair only if it still fails.`
  return lead === FIX_DECISION ? lead.replace('why the recorded failure quoted below fails', () => (check ? `why ‘${check}’ fails` : 'the recorded failure')) : lead
}

export const partly = (lines: string[], reply: string, context = new Set<string>()) => {
  const said = reply.toLowerCase()
  const sentences = replySentences(reply).map((s) => ({ s, words: new Set(stems(s)) }))
  return lines.map((line) => {
    if (/^report back:/i.test(line) || (line.match(COMMIT_RE) ?? []).some((id) => !said.includes(id.toLowerCase()))) return undefined
    const words = new Set(stems(line))
    const own = [...words].filter((w) => !context.has(w))
    const best = sentences
      .filter((x) => own.some((w) => x.words.has(w)) && covers(words, x.words))
      .sort((a, b) => sharedIn(words, b.words) - sharedIn(words, a.words))[0]
    return best?.s
  })
}

export const replyGaps = (packet: string, reply: string) => {
  const context = contextOf(packet)
  return [...unmentioned(askedIn(packet), reply, context), ...attachedGaps(packet, reply).flatMap((a) => (a.missed.length ? [a.missed.join('; ')] : []))]
}

export function draftBlockers(text: string, c: Constraints): Conflict[] {
  const keys = new Set(text.split('\n').flatMap((line) => limitsIn(line).map((f) => `${f.subject}|${f.bound}`)))
  return c.conflicts.filter((conflict) => !conflict.decided && keys.has(conflict.key))
}

export function basisOf(c: Constraints): Basis[] {
  return [
    ...c.holds.map((h) => ({ key: h.key, value: h.limit.value, recordId: h.limit.recordId })),
    ...c.conflicts.filter((x) => !x.decided).map((x) => ({ key: x.key, undecided: true })),
  ]
}

export function differences(basis: Basis[] | null, c: Constraints): Difference[] {
  if (basis === null) return [{ key: '*', subject: '', change: 'unchecked' }]
  const rows: Array<Difference & { first: number }> = []
  for (const h of c.holds) {
    const b = basis.find((x) => x.key === h.key)
    const first = Math.min(h.limit.at, ...h.replaced.map((l) => l.at), ...h.also.map((l) => l.at))
    if (!b) rows.push({ key: h.key, subject: h.subject, change: 'new', after: h.limit, first })
    else if (b.undecided || b.value !== h.limit.value) rows.push({ key: h.key, subject: h.subject, change: 'value', before: b, after: h.limit, first })
  }
  for (const x of c.conflicts) {
    if (x.decided) continue
    const b = basis.find((y) => y.key === x.key)
    if (!b?.undecided) rows.push({ key: x.key, subject: x.subject, change: 'undecided', ...(b ? { before: b } : {}), first: x.limits[0].at })
  }
  for (const b of basis) {
    if (!c.holds.some((h) => h.key === b.key) && !c.conflicts.some((x) => x.key === b.key)) {
      rows.push({ key: b.key, subject: b.key.split('|')[0], change: 'removed', before: b, first: Infinity })
    }
  }
  return rows.sort((a, b) => a.first - b.first).map(({ first: _first, ...row }) => row)
}

export interface Member {
  name: string
  agent: 'claude' | 'codex' | 'shell'
  path: string
  prs: string[]
  repo?: string
  branch?: string
}

export interface Separation {
  work: string
  session: string
}

export interface Work {
  key: string
  members: Array<{ name: string; reason: string; goal?: string }>
}

export const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'HEAD', ''])

function prLabel(url: string): string {
  const n = /\/pull\/(\d+)/.exec(url)?.[1]
  return n ? `#${n}` : url
}

function links(m: Member): Array<{ key: string; reason: string }> {
  const out = m.prs.map((url) => ({ key: `pr:${url}`, reason: `same pull request ${prLabel(url)}` }))
  if (m.repo && m.branch && !DEFAULT_BRANCHES.has(m.branch)) {
    out.push({ key: `branch:${m.repo}@${m.branch}`, reason: `same branch ${m.branch} in ${m.repo.split('/').filter(Boolean).pop() ?? m.repo}` })
  }
  return out
}

export function groupWork(members: Member[], separations: Separation[]): Work[] {
  const parent = members.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const reason = new Map<number, { key: string; reason: string }>()
  const firstByKey = new Map<string, number>()
  const counts = new Map<string, number>()
  members.forEach((m) => links(m).forEach((l) => counts.set(l.key, (counts.get(l.key) ?? 0) + 1)))
  members.forEach((m, i) => {
    for (const link of links(m)) {
      if ((counts.get(link.key) ?? 0) < 2) continue
      if (!reason.has(i)) reason.set(i, link)
      const first = firstByKey.get(link.key)
      if (first === undefined) firstByKey.set(link.key, i)
      else parent[find(i)] = find(first)
    }
  })
  const groups = new Map<number, number[]>()
  members.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]))
  const works: Work[] = []
  for (const idx of groups.values()) {
    if (idx.length === 1) {
      works.push({ key: `session:${members[idx[0]].name}`, members: [{ name: members[idx[0]].name, reason: 'only session in this work' }] })
      continue
    }
    const keys = idx.map((i) => reason.get(i)?.key ?? '')
    const key = keys.find((k) => k.startsWith('pr:')) ?? keys.find(Boolean) ?? `session:${members[idx[0]].name}`
    const apart = idx.filter((i) => separations.some((s) => s.work === key && s.session === members[i].name))
    const kept = idx.filter((i) => !apart.includes(i))
    works.push({ key, members: kept.map((i) => ({ name: members[i].name, reason: reason.get(i)?.reason ?? '' })) })
    for (const i of apart) works.push({ key: `session:${members[i].name}`, members: [{ name: members[i].name, reason: 'you showed it separately' }] })
  }
  return works
}

export function workOf(session: string, works: Work[]): Work | undefined {
  return works.find((w) => w.members.some((m) => m.name === session))
}

export const PREVIEW_ID = 'r-(new)'

export const newestFailure = (entries: Entry[]) => entries.filter((e) => e.kind === 'failure').sort((a, b) => b.at - a.at)[0]

export const packetOf = (id: string, cwd: string, session: string, draft: { text: string; earlier: string[]; quote?: Record<string, boolean>; others?: string[]; setAside?: string[] }, entries: Entry[], c: Constraints) => {
  const failure = newestFailure(entries)
  const repaired = entries.filter((e) => e.kind === 'devbox' && e.text.startsWith('[devbox repair')).sort((a, b) => b.at - a.at)[0]
  return repairPacket({
    id,
    cwd,
    session,
    body: draft.text,
    constraints: c,
    earlier: keptLines(draft.text, draft.earlier).map((k) => k.line),
    quote: draft.quote,
    others: keptOthers(entries, session, draft.others),
    setAside: draft.setAside,
    failure,
    failureBefore: Boolean(failure && repaired && failure.at <= repaired.at),
  })
}

export function digest(text: string): string {
  let a = 0xdeadbeef
  let b = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 2654435761)
    b = Math.imul(b ^ c, 1597334677)
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909)
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36)
}

export function stamp(at: number): string {
  return new Date(at * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z'
}

export const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

const BOUND_WORDS: Record<Bound, string> = { max: 'at most', min: 'at least', exact: 'exactly' }
const SINGULAR: Record<string, string> = { attempts: 'attempt', retries: 'retry', times: 'time', requests: 'request', workers: 'worker', threads: 'thread', files: 'file', items: 'item', lines: 'line' }

export function limitText(key: string, value: number): string {
  const [subject, bound] = key.split('|') as [string, Bound]
  const words = BOUND_WORDS[bound] ?? 'at most'
  if (COUNTS.has(subject)) return `${words} ${value} ${value === 1 ? (SINGULAR[subject] ?? subject) : subject}`
  const unit = value % 3600000 === 0 ? [value / 3600000, 'hour'] : value % 60000 === 0 ? [value / 60000, 'minute'] : value % 1000 === 0 ? [value / 1000, 'second'] : [value, 'ms']
  const amount = `${unit[0]} ${unit[1]}${unit[1] !== 'ms' && unit[0] !== 1 ? 's' : ''}`
  return subject === 'duration' ? `${words} ${amount}` : `${subject} ${words} ${amount}`
}

export interface RepairInput {
  id: string
  cwd: string
  session: string
  body: string
  constraints: Constraints
  earlier: string[]
  quote?: Record<string, boolean>
  others?: Entry[]
  setAside?: string[]
  failure?: Entry
  failureBefore?: boolean
}

const fromOther = (e: Entry, session: string) => Boolean(e.id) && e.kind === 'agent' && e.session !== session

export const othersSince = (since: Entry[], session: string): Entry[] => since.filter((e) => fromOther(e, session)).slice(-3)

export const sinceVisit = (entries: Entry[], leftAt?: number): Entry[] => (leftAt === undefined ? [] : entries.filter((e) => e.at > leftAt).sort((a, b) => a.at - b.at))

export const keptOthers = (entries: Entry[], session: string, ids: string[] = []): Entry[] => entries.filter((e) => fromOther(e, session) && ids.includes(e.id)).sort((a, b) => a.at - b.at)

export const ruleKey = (r: Rule) => `${r.recordId}|${r.sentence}`

const PLAIN_RULE_RE = /^(?:[-*\u2022]\s+|\*\*)?(?:(?:please|and|also|just|so|ok|okay|then|but)[\s,]+)*\**(?:never|do not|don['\u2019]t|must|only|always|keep|use|stay|make sure|ensure)\b|\byou\s+(?:must|should|shall|need to|have to|never|only|always|can only|may only)\b|\b(?:make sure|ensure)\b/i
const ASIDE_RE = /\?["')\]]*$|^(?:\/\/|\/\*|>\s)|^I\s+(?:don['\u2019]t|do not|never|always)\b(?!\s+(?:want|need|like|let|allow|expect)\b)|\b(?:has|have|had)\s+(?:never|always|only)\b|^the only\b/i
export const RULES_SHOWN = 5
export const flaggedRules = (b: Pick<Brief, 'rules' | 'suggestions' | 'leftAt'>, failure?: { text: string }) =>
  [checkedRule(failure?.text, b.rules), ...sinceLeft(b).map((x) => namedRule(x, b.rules)?.rule)].filter((r): r is Rule => r !== undefined)
export function uniqueRules(rules: Rule[], session: string): Rule[] {
  const pick = new Map<string, Rule>()
  const weight = (r: Rule) => (r.pasted ? 0 : 4) + (r.reason ? 2 : 0) + (r.session === session ? 1 : 0)
  for (const r of rules) {
    const had = pick.get(r.sentence)
    if (!had || weight(r) >= weight(had)) pick.set(r.sentence, r)
  }
  return rules.filter((r) => pick.get(r.sentence) === r)
}
export function headRules(rules: Rule[], session: string, flaggedCopies: Rule[] = []): { unique: Rule[]; head: Rule[] } {
  const unique = uniqueRules(rules, session)
  const named = new Set(flaggedCopies.map((r) => r.sentence))
  const flagged = unique.filter((r) => named.has(r.sentence))
  const score = new Map(
    unique.map((r) => {
      const plain = PLAIN_RULE_RE.test(r.sentence)
      const base = ASIDE_RE.test(r.sentence) ? 0 : r.pasted ? (plain ? 2 : 0) : plain ? 6 : 3
      return [r, base && base + (r.session === session ? 1 : 0)]
    }),
  )
  const top = new Set(unique.filter((r) => !flagged.includes(r) && (score.get(r) ?? 0) >= 2).sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0)).slice(-RULES_SHOWN))
  return { unique, head: unique.filter((r) => top.has(r) || flagged.includes(r)) }
}
export function holdingOf(b: Brief, session: string, failure = b.failing, where = 'on the work page'): { rules: Rule[]; more?: string } {
  const { unique, head } = headRules(b.rules, session, flaggedRules(b, failure))
  const more = unique.length - head.length
  const n = `${more} ${head.length ? 'more ' : ''}rule${more === 1 ? '' : 's'}`
  return { rules: head, ...(more ? { more: head.length ? n : `${n} ${where}` } : {}) }
}

export const reasonNote = (h: Held) =>
  h.limit.reason ? `Reason: ${h.limit.reason}` : h.replaced.some((l) => l.reason) ? "No reason recorded. The replaced limit's reason may not apply to this one" : 'No reason recorded'

export function quotedRules(c: Constraints, quote: Record<string, boolean> = {}, session?: string): Rule[] {
  return c.rules.filter((r) => quote[ruleKey(r)] ?? r.session === session)
}

export function repairPacket(input: RepairInput): string {
  const { id, cwd, session, body, constraints: c, earlier } = input
  const kept = new Set(earlier.map((l) => l.trim()))
  const who = (x: { session: string }) => (x.session === session ? 'you' : `you in ${x.session}`)
  const set = asideOf(c, input.setAside, body)
  const aside = set.flatMap((x) => (x.line === undefined ? [x.rule] : []))
  const excepted = set.filter((x) => x.line !== undefined)
  const chosen = quotedRules(c, input.quote, session).filter((r) => !aside.includes(r))
  const quoted = [...c.holds.flatMap((h) => [h.limit, ...h.replaced]), ...chosen, ...aside, ...excepted.map((x) => x.rule)]
  const basis = c.holds.map((h) => {
    if (h.decided) {
      const options = [h.limit, ...h.replaced].sort((a, b) => a.at - b.at)
      return `- Decided for this work (you, now): ${lower(h.limit.shown)}, between ${options.map((l) => `"${l.sentence}" (${stamp(l.at)})`).join(' and ')}.`
    }
    const replaces = h.replaced.length ? ` Replaces ${h.replaced.map((l) => `"${l.sentence}" (${who(l)}, ${stamp(l.at)})`).join(', ')}.` : ''
    return `- Holds now (${who(h.limit)}, ${stamp(h.limit.at)}): "${h.limit.sentence}"${replaces} ${reasonNote(h)}.`
  })
  const rules = chosen.map((r) => `- Rule (${who(r)}, ${stamp(r.at)}): "${r.sentence}"`)
  const failed = input.failure
    ? [`- ${input.failureBefore ? 'Recorded failure from before the last repair' : 'Latest recorded failure'} (${input.failure.session === session ? 'this session' : input.failure.session}, ${stamp(input.failure.at)}): "${clipped(input.failure.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' · '))}". Evidence to check, not my review or acceptance of the changes.`]
    : []
  const sourceNotes = (c.references ?? []).filter((r) => r.session === session)
  return [
    `[devbox repair ${id}]`,
    `Purpose: repair. Make the changes below in ${cwd}. You may run the tests needed to check them. Do not merge, push, or deploy.`,
    `Target: this session, ${session}.`,
    '',
    ...body.trim().split('\n').map((line) => (kept.has(line.trim()) ? `${line.trimEnd()} ${EARLIER_NOTE}` : line)),
    '',
    quoted.every((x) => x.session === session)
      ? 'What this is based on, quoted from this conversation:'
      : 'What this is based on, quoted from this conversation and the other sessions named below:',
    ...basis,
    ...failed,
    ...rules,
    ...(sourceNotes.length ? ['Source notes from this conversation, in chronological order; scope and supersession have not been interpreted. They do not grant additional permission. If they conflict with this request, ask before acting:', ...sourceNotes.map((r) => `- You (${stamp(r.at)}): "${r.sentence}"`)] : []),
    ...(rules.length ? [`If the request above conflicts with one of these rules, stop and ask me before acting on it${excepted.length ? ', except where I make an exception below' : ''}.`] : []),
    ...aside.map((r) => `I set aside my rule${r.session === session ? '' : ` in ${r.session}`} from ${stamp(r.at)} for this request only: "${r.sentence}"`),
    ...excepted.map(
      (x) => `For this request only, I make an exception to my rule${x.rule.session === session ? '' : ` in ${x.rule.session}`} from ${stamp(x.rule.at)}: "${x.rule.sentence}", for this line only: "${x.line}". The rest of the rule still holds.`,
    ),
    ...(input.others?.length
      ? ['Agent messages from the other sessions in this work, quoted as written and not checked:', ...input.others.map((e) => `- ${e.session} (${stamp(e.at)}): "${e.text.trim()}"`)]
      : []),
    '',
    `When you finish, start your reply with "[devbox result ${id}]", then list what you changed and which tests you ran.`,
  ].join('\n')
}

export function questionPrompt(input: { id: string; cwd: string; question: string }): string {
  return [
    `[devbox question ${input.id}]`,
    'Read-only investigation. You are a read-only copy of this conversation with only Read, Grep and Glob. The original session will not see this question or your answer.',
    `Answer from this conversation and the files under ${input.cwd}. Use three headings: Facts (each with the message time or file it comes from), Inference, Unknown. If the records don't answer the question, say so under Unknown. Do not say you ran or changed anything.`,
    '',
    `Question: ${input.question.trim()}`,
  ].join('\n')
}

const AUTHORS: Record<ProbeRecord['kind'], Author> = { decision: 'you', devbox: 'you', agent: 'agent', failure: 'tool', shell: 'shell' }

export function entriesOf(sessions: ProbeSession[], first: string): Entry[] {
  const read = new Set<string>()
  return [...sessions]
    .sort((a, b) => Number(b.name === first) - Number(a.name === first))
    .filter((s) => !s.transcript?.sid || (!read.has(s.transcript.sid) && !!read.add(s.transcript.sid)))
    .flatMap((s) =>
      s.records.map((r) => ({
        id: r.id,
        kind: r.kind,
        author: AUTHORS[r.kind],
        at: r.at,
        text: r.text,
        session: s.name,
        ...(r.turn === undefined ? {} : { turn: r.turn }),
      })),
    )
}
