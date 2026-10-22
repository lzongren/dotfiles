import { describe, expect, it } from 'vitest'
import { basisOf, draftChecks, evidenceAmounts, limitPushes, partly, clause, digest, keptOthers, limitText, namedRule, othersSince, briefOf, changeIssue, checkedRule, measured, constraints, draftFor, spoken, QUESTION_START, differences, draftBlockers, draftIssues, draftRuleHits, entriesOf, headRules, holdingOf, keptLines, uniqueRules, pruned, newerThan, retryBlock, shownAs, uncheckedAmounts, unmentioned, askedLines, attachedIn, replyGaps, nearestFor, contextOf, askedIn, leadAsk, packetOf, scopeHits, exceptionKey, askedParts, groupWork, limitsIn, questionPrompt, quotedRules, repairPacket, ruleKey, undoCorrection, workOf, type Entry, type Member, type Rule } from '../../src/shared/recover.js'
import type { Repair } from '../../src/shared/types.js'

const you = (id: string, at: number, text: string): Entry => ({ id, kind: 'decision', author: 'you', at, text, session: 'fix' })
const agent = (id: string, at: number, text: string): Entry => ({ id, kind: 'agent', author: 'agent', at, text, session: 'fix' })

describe('limitsIn', () => {
  it('reads a bound, a number and a unit', () => {
    expect(limitsIn('HTTP retries are limited to at most 2 attempts.')).toEqual([
      expect.objectContaining({ subject: 'attempts', bound: 'max', value: 2, shown: 'at most 2 attempts' }),
    ])
    expect(limitsIn('Use no more than 3 workers and at least 1 thread')).toEqual([
      expect.objectContaining({ subject: 'workers', bound: 'max', value: 3 }),
      expect.objectContaining({ subject: 'threads', bound: 'min', value: 1 }),
    ])
  })

  it('reads a trailing bound and a limit phrased as a cap', () => {
    expect(limitsIn('2 attempts max, please')).toEqual([expect.objectContaining({ subject: 'attempts', bound: 'max', value: 2 })])
    expect(limitsIn('Cap retries at 4.')).toEqual([expect.objectContaining({ subject: 'retries', bound: 'max', value: 4 })])
  })

  it('keeps retries and attempts apart, because two retries are three attempts', () => {
    const [a, b] = [...limitsIn('at most 2 retries'), ...limitsIn('at most 2 attempts')]
    expect(a.subject).not.toBe(b.subject)
  })

  it('names a duration by the timing word in its sentence and compares it in milliseconds', () => {
    expect(limitsIn('Keep the total timeout at most 10 seconds.')).toEqual([
      expect.objectContaining({ subject: 'timeout', bound: 'max', value: 10000, shown: 'at most 10 seconds' }),
    ])
    expect(limitsIn('Backoff up to 200ms between tries')).toEqual([expect.objectContaining({ subject: 'backoff', value: 200 })])
    expect(limitsIn('at most 5 minutes')).toEqual([expect.objectContaining({ subject: 'duration', value: 300000 })])
  })

  it('names a duration by the noun a cap sets, else the first-listed timing word in its sentence', () => {
    const subjects = (t: string) => limitsIn(t).map((f) => f.subject)
    expect(subjects('The deadline is fine. Allow at most 30 s for the timeout.')).toEqual(['timeout'])
    expect(subjects('the deadline test is flaky. allow at most 30 s for the timeout.')).toEqual(['timeout'])
    expect(subjects('Keep the timeout above the backoff and at most 30 s.')).toEqual(['timeout'])
    expect(subjects('Keep the timeout and the delay at most 30 s.')).toEqual(['timeout'])
    expect(subjects('Rerun with the timeout at most 10 s. Each test should take at most 2 s.')).toEqual(['timeout', 'duration'])
    expect(subjects('Leave the timeout alone and cap the backoff at 2 s.')).toEqual(['backoff'])
    expect(subjects('The timeout must be at least 2 s and at most 30 s.')).toEqual(['timeout', 'timeout'])
    expect(subjects('Wait for CI, then keep the timeout at most 30 s.')).toEqual(['timeout'])
    expect(subjects('Keep the timeout short, e.g. at most 30 s.')).toEqual(['timeout'])
    expect(subjects('The backoff is too long; make it at most 2 s instead.')).toEqual(['backoff'])
    expect(subjects("The backoff is too long; make it at most 2 s so retries don't wait as long.")).toEqual(['backoff'])
    expect(subjects('Change the timeout for each wait from 30 s to 60 s.')).toEqual(['timeout'])
  })

  it('reads a change from one value to another as the new value', () => {
    expect(limitsIn('Change attempts from 2 to 1.')).toEqual([
      expect.objectContaining({ subject: 'attempts', bound: 'max', value: 1, replacing: true }),
    ])
  })

  it('ignores numbers without a known unit or bound', () => {
    expect(limitsIn('PR 184 has 2 reviewers and we saw 3 failures')).toEqual([])
    expect(limitsIn('version 2.1 of the API')).toEqual([])
  })

  it('marks explicit replacement wording', () => {
    expect(limitsIn('At most 1 attempt instead of 2.')[0].replacing).toBe(true)
    expect(limitsIn('This replaces the old rule: at most 1 attempt.')[0].replacing).toBe(true)
    expect(limitsIn('At most 1 attempt.')[0].replacing).toBe(false)
  })
})

describe('constraints', () => {
  it('quotes each limit with its author, time and source', () => {
    const result = constraints([you('u1', 100, 'Retries: at most 2 attempts, because upstream is rate limiting.')])
    expect(result.holds).toEqual([
      expect.objectContaining({
        subject: 'attempts',
        limit: expect.objectContaining({ value: 2, recordId: 'u1', author: 'you', at: 100, reason: 'upstream is rate limiting' }),
        replaced: [],
      }),
    ])
  })

  it('finds the reason in the next sentence, and says when there is none', () => {
    const r = constraints([
      you('u1', 1, 'At most 2 attempts. Because the caller cannot wait longer.'),
      you('u2', 2, 'Keep the total timeout at most 10 seconds.'),
    ])
    expect(r.holds.find((h) => h.subject === 'attempts')?.limit.reason).toBe('the caller cannot wait longer')
    expect(r.holds.find((h) => h.subject === 'timeout')?.limit.reason).toBeUndefined()
  })

  it('lets a later message replace an earlier one only when it says so', () => {
    const r = constraints([
      you('u1', 1, 'At most 2 attempts.'),
      you('u2', 2, 'Upstream got worse: at most 1 attempt instead of 2.'),
    ])
    expect(r.holds).toHaveLength(1)
    expect(r.holds[0].limit).toMatchObject({ value: 1, recordId: 'u2' })
    expect(r.holds[0].replaced).toEqual([expect.objectContaining({ value: 2, recordId: 'u1' })])
    expect(r.conflicts).toEqual([])
  })

  it('shows two values without replacement wording as a conflict, not settled by recency', () => {
    const r = constraints([you('u1', 1, 'Use at most 4 workers.'), you('u2', 2, 'Use at most 8 workers.')])
    expect(r.holds).toEqual([])
    expect(r.conflicts).toEqual([
      expect.objectContaining({ subject: 'workers', limits: [expect.objectContaining({ value: 4 }), expect.objectContaining({ value: 8 })] }),
    ])
  })

  it('resolves a conflict when a later message replaces both explicitly', () => {
    const r = constraints([
      you('u1', 1, 'Use at most 4 workers.'),
      you('u2', 2, 'Use at most 8 workers.'),
      you('u3', 3, 'Use at most 6 workers instead.'),
    ])
    expect(r.conflicts).toEqual([])
    expect(r.holds[0].limit.value).toBe(6)
    expect(r.holds[0].replaced.map((l) => l.value)).toEqual([4, 8])
  })

  it('treats a repeated value as the same constraint, quoting the latest', () => {
    const r = constraints([you('u1', 1, 'At most 2 attempts.'), you('u2', 2, 'Remember, at most 2 attempts.')])
    expect(r.holds).toHaveLength(1)
    expect(r.holds[0].limit.recordId).toBe('u2')
    expect(r.holds[0].also.map((l) => l.recordId)).toEqual(['u1'])
  })

  it('never lets an agent message replace yours, and lists it as a suggestion', () => {
    const r = constraints([you('u1', 1, 'At most 2 attempts.'), agent('a1', 2, 'I suggest at most 3 attempts instead of 2.')])
    expect(r.holds[0].limit).toMatchObject({ value: 2, recordId: 'u1' })
    expect(r.suggestions).toEqual([expect.objectContaining({ value: 3, recordId: 'a1', author: 'agent' })])
  })

  it('keeps different bounds on the same unit apart', () => {
    const r = constraints([you('u1', 1, 'At least 1 worker.'), you('u2', 2, 'At most 8 workers.')])
    expect(r.conflicts).toEqual([])
    expect(r.holds.map((h) => [h.subject, h.bound])).toEqual([
      ['workers', 'min'],
      ['workers', 'max'],
    ])
  })

  it('applies a decision made for this work to a conflict', () => {
    const r = constraints([you('u1', 1, 'Use at most 4 workers.'), you('u2', 2, 'Use at most 8 workers.')], {
      'workers|max': 'u1#0',
    })
    expect(r.conflicts).toEqual([expect.objectContaining({ subject: 'workers', decided: expect.objectContaining({ value: 4 }) })])
    expect(r.holds).toEqual([expect.objectContaining({ subject: 'workers', decided: true, limit: expect.objectContaining({ value: 4 }) })])
  })

  it('lists rules it cannot compare as decisions, so nothing worded that way is lost', () => {
    const r = constraints([you('u1', 1, 'Never merge the PR automatically. Only retry idempotent requests.')])
    expect(r.rules.map((x) => x.sentence)).toEqual(['Never merge the PR automatically.', 'Only retry idempotent requests.'])
  })

  it('reads a rule however it is worded, curly apostrophes included', () => {
    const rules = (text: string) => constraints([you('u1', 1, text)]).rules.map((x) => x.sentence)
    expect(rules('Don\u2019t push to main. You mustn\u2019t merge it.')).toEqual(['Don\u2019t push to main.', 'You mustn\u2019t merge it.'])
  })
})

describe('headRules', () => {
  const rule = (sentence: string, session = 'fix', extra: Partial<Rule> = {}): Rule => ({ recordId: sentence, author: 'you', at: 1, session, sentence, ...extra })

  it('leads with five plainly worded rules, this session\'s first, then fills with the rest you typed', () => {
    const rules = [rule('Never push.'), rule('Only touch src/.', 'review'), rule('Merge it only after CI passes.'), rule('Keep it read-only.'), rule('- Never force-push.'), rule('Make sure tests pass.', 'review'), rule('**Always** rebase.')]
    expect(headRules(rules, 'fix').head.map((r) => r.sentence)).toEqual(['Never push.', 'Keep it read-only.', '- Never force-push.', 'Make sure tests pass.', '**Always** rebase.'])
    expect(headRules([rule('Merge it only after CI passes.'), rule('The PR must not be merged.'), rule("I don't want the agent to push.")], 'fix').head).toHaveLength(3)
  })

  it('keeps questions, code, quotes and pasted text out of the lead unless a check or suggestion names them, and lists a repeated rule once', () => {
    const pasted = rule('The only gap is the connector, we must check it.', 'fix', { pasted: true })
    const noise = [rule("Why don't we allowlist it too?"), rule('// the target must still be allowed.'), rule('> never merge it'), rule("I don't have any concerns."), rule('It has always passed.'), rule('The only gap is the connector.'), pasted]
    expect(headRules(noise, 'fix').head).toEqual([])
    expect(headRules(noise, 'fix', [pasted]).head).toEqual([pasted])
    const banner = rule('Do not click links unless you know the sender.', 'fix', { pasted: true })
    expect(headRules([banner], 'fix').head).toEqual([banner])
    expect(headRules([banner, ...['a', 'b', 'c', 'd', 'e'].map((x) => rule(`Merge ${x} only after CI.`))], 'fix').head).not.toContain(banner)
    const mine = rule('Never push.', 'fix', { recordId: 'u2' })
    expect(headRules([rule('Never push.', 'review'), mine], 'fix').head).toEqual([mine])
    expect(uniqueRules([rule('Never push.', 'review'), mine, rule('Only src/.')], 'fix').map((r) => `${r.session} ${r.sentence}`)).toEqual(['fix Never push.', 'fix Only src/.'])
    const reasoned = rule('Never push.', 'review', { reason: 'CI deploys from it' })
    expect(uniqueRules([reasoned, mine], 'fix')).toEqual([reasoned])
    const typed = rule('We only deploy on Tuesdays.', 'fix', { recordId: 'a' })
    expect(uniqueRules([typed, rule('We only deploy on Tuesdays.', 'fix', { recordId: 'b', pasted: true })], 'fix')).toEqual([typed])
  })

  it("keeps your typed copy, with its reason, when a check names a pasted copy of the same rule", () => {
    const pasted = rule('Never push to main.', 'review', { recordId: 'p1', pasted: true })
    const typed = rule('Never push to main.', 'fix', { recordId: 'u1', reason: 'CI deploys from it' })
    expect(headRules([pasted, typed], 'fix', [pasted]).head).toEqual([typed])
  })

  it('counts the rules it leaves out once each, and says where they are when none lead', () => {
    const e = [you('u1', 1, 'Never push. Never push. Why must we wait?')]
    expect(holdingOf(briefOf(e, constraints(e), 'fix'), 'fix')).toEqual({ rules: [expect.objectContaining({ sentence: 'Never push.' })], more: '1 more rule' })
    const asides = [you('u1', 1, "Why must we wait? I don't have concerns.")]
    expect(holdingOf(briefOf(asides, constraints(asides), 'fix'), 'fix')).toEqual({ rules: [], more: '2 rules on the work page' })
  })

  it('reads a long message as pasted only when it is long and spread over lines', () => {
    const typed = `${'We are fixing the retry budget for the API client today. '.repeat(10)}Merge it only after CI passes.`
    const pasted = `${'> quoted line from the thread\n'.repeat(30)}Merge it only after CI passes.`
    const brief = 'Fix the retry flake.\n- Only touch src/retry.ts\n- The PR must not be merged until CI is green\n- Keep the 10 s deadline\n- Ask before you push\n- Run the suite twice'
    expect(constraints([you('u1', 1, brief.padEnd(450, ' '))]).rules[0].pasted).toBeUndefined()
    expect(constraints([you('u1', 1, typed)]).rules[0].pasted).toBeUndefined()
    expect(constraints([you('u1', 1, pasted)]).rules[0].pasted).toBe(true)
  })

  it("doesn't take a reason from pasted text as yours, and reads a typed message with paragraphs as typed", () => {
    const why = (text: string) => { const e = [you('u1', 1, text)]; return briefOf(e, constraints(e), 'fix').why?.reason }
    const typedToo = (text: string) => { const e = [you('u0', 0, 'Never drop the old path, because callers still use it.'), you('u1', 1, text)]; return briefOf(e, constraints(e), 'fix').why?.reason }
    expect(typedToo(`${'log line\n'.repeat(80)}Deploy must be retried because the token expired.`)).toBe('callers still use it')
    expect(typedToo(`${'log line\n'.repeat(80)}Retry at most 3 times because the upstream rate-limits us.`)).toBe('callers still use it')
    expect(why(`${'Context for the task.\n'.repeat(80)}Keep at most 3 retries because the API rate-limits us.`)).toBe('the API rate-limits us')
    const typed = `${'We spent the morning on the retry flake and found the budget resets twice per call, so every retry ran out early.\n\n'.repeat(5)}The PR must not be merged until CI is green, because CI deploys from it.`
    expect(typed.length).toBeGreaterThan(600)
    expect(why(typed)).toBe('CI deploys from it')
    expect(why('Never merge the PR. That\u2019s because CI deploys from it.')).toBe('CI deploys from it')
  })

  it('flags a draft against a rule written with a curly apostrophe', () => {
    const c = constraints([you('u1', 1, 'Don\u2019t touch the lockfile.')])
    expect(draftRuleHits('Touch the lockfile to fix it.', c)).toHaveLength(1)
  })

  it('shows the rule a failing check names wherever what holds is summed up, however it is worded', () => {
    const e: Entry[] = [you('u1', 1, `${'Background.\n'.repeat(60)}Deploys are only allowed within the 10 second total deadline.`), { id: 'f1', kind: 'failure', author: 'tool', at: 2, text: 'FAIL keeps total deadline', session: 'fix' }]
    const b = briefOf(e, constraints(e), 'fix')
    expect(b.rules[0].pasted).toBe(true)
    expect(holdingOf(b, 'fix').rules.map((r) => r.sentence)).toEqual(['Deploys are only allowed within the 10 second total deadline.'])
    const repaired = { ...b, failing: undefined }
    expect(holdingOf(repaired, 'fix').rules).toEqual([])
    expect(holdingOf(repaired, 'fix', e[1]).rules.map((r) => r.sentence)).toEqual(['Deploys are only allowed within the 10 second total deadline.'])
  })
})

describe('entriesOf', () => {
  const s = (name: string, sid: string | undefined, ids: string[]) => ({ name, pane: '%1', cmd: 'claude', agent: 'claude' as const, path: '/w', records: ids.map((id) => ({ id, kind: 'decision' as const, at: 1, text: 'Never merge.' })), ...(sid ? { transcript: { ino: 1, size: 1, last: ids.at(-1) ?? '', sid } } : {}) })

  it('reads a conversation two sessions share once, as the session named first', () => {
    const read = (first: string) => entriesOf([s('fix', 'c1', ['u1']), s('review', 'c2', ['u2']), s('devbox', 'c1', ['u1'])], first).map((e) => `${e.session}:${e.id}`)
    expect(read('fix')).toEqual(['fix:u1', 'review:u2'])
    expect(read('devbox')).toEqual(['devbox:u1', 'review:u2'])
    expect(entriesOf([s('a', undefined, ['u1']), s('b', undefined, ['u1'])], 'b').map((e) => e.session)).toEqual(['b', 'a'])
  })
})

describe('draft checks', () => {
  const held = constraints([you('u1', 1, 'At most 2 attempts.'), you('u2', 2, 'At most 1 attempt instead of 2.')])
  const draft = 'Fix the retry loop.\nRetry at most 2 attempts per request.\nKeep the total timeout at most 10 seconds.'

  it('flags each line whose limit differs from what holds now', () => {
    const issues = draftIssues(draft, held)
    expect(issues).toEqual([
      expect.objectContaining({ line: 1, text: 'Retry at most 2 attempts per request.', found: expect.objectContaining({ value: 2 }), holds: expect.objectContaining({ subject: 'attempts' }) }),
    ])
    expect(issues[0].holds.limit.value).toBe(1)
  })

  it('changes only that number in that line and records the change', () => {
    const [issue] = draftIssues(draft, held)
    const next = changeIssue(draft, issue, 'c1')
    expect(next.text).toBe('Fix the retry loop.\nRetry at most 1 attempt per request.\nKeep the total timeout at most 10 seconds.')
    expect(next.correction).toEqual({ id: 'c1', before: 'Retry at most 2 attempts per request.', after: 'Retry at most 1 attempt per request.' })
    expect(draftIssues(next.text, held)).toEqual([])
  })

  it('flags a line that raises or sets a held limit to another amount, unless it keeps it out', () => {
    const [issue] = draftIssues('Increase the number of attempts to 3 so the check passes.', held)
    expect(issue).toEqual(expect.objectContaining({ line: 0, found: expect.objectContaining({ value: 3 }) }))
    expect(changeIssue('Increase the number of attempts to 3 so the check passes.', issue, 'c1').text).toBe('Increase the number of attempts to 1 so the check passes.')
    expect(draftIssues("Don't raise the attempts to 3.", held)).toEqual([])
  })

  it('keeps any flagged line you choose as an earlier comparison without changing it', () => {
    const past = 'Fix the retry loop.\nThe old code tried at most 2 attempts per request.'
    const [issue] = draftIssues(past, held)
    expect(draftIssues(past, held, [issue.text.trim()])).toEqual([])
    expect(keptLines(past, [issue.text.trim()]).map((k) => k.line)).toEqual(['The old code tried at most 2 attempts per request.'])
    const [order] = draftIssues(draft, held)
    expect(draftIssues(draft, held, [order.text.trim()])).toEqual([])
    expect(keptLines(draft, [order.text.trim()]).map((k) => k.line)).toEqual([order.text.trim()])
  })

  it('shows a draft as its sent repair unless a follow-up of that send or a later one is open', () => {
    const at = (id: string, sentAt: number, draftVersion: string, state: Repair['state'] = 'replied'): Repair => ({ id, packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: [], version: 'a1', draftVersion, sentAt, state })
    const one = at('r-1', 100, 'v1')
    const two = at('r-2', 200, 'v2')
    expect(shownAs({}, 'v1', [one])).toBe(one)
    expect(shownAs({ follows: 100 }, 'v1', [one])).toBeUndefined()
    expect(shownAs({ follows: 100 }, 'v1', [{ ...one, sentAt: 300 }])?.id).toBe('r-1')
    expect(shownAs({ follows: 100 }, 'v2', [one, two])).toBe(two)
    expect(shownAs({ follows: 200 }, 'v1', [one, two])).toBeUndefined()
    expect(shownAs({}, 'v1', [at('r-1', 100, 'v1', 'failed')])).toBeUndefined()
    expect(newerThan(one, [one, two])).toBe(two)
    expect(newerThan(one, [one, at('r-3', 300, 'v3'), two])?.id).toBe('r-3')
    const failed = at('r-1', 100, 'v1', 'failed')
    const held = at('r-1', 100, 'v1', 'held')
    const none = constraints([])
    const now = (repairs: Repair[], more: Partial<Parameters<typeof retryBlock>[1]> = {}) => ({ version: 'v1', repairs, c: none, conversation: 's1', target: 's1', ...more })
    expect(retryBlock(failed, now([failed]))).toBeUndefined()
    expect(retryBlock(failed, now([failed, at('r-2', 200, 'v1')]))).toBe('already_sent')
    expect(retryBlock(failed, now([failed], { version: 'v2' }))).toBe('draft_changed')
    expect(retryBlock(failed, now([failed], { target: 's2' }))).toBe('other_conversation')
    expect(retryBlock(failed, now([failed], { target: undefined }))).toBe('no_target')
    expect(retryBlock(held, now([held]))).toBeUndefined()
    expect(retryBlock(held, now([held], { version: 'v2' }))).toBe('draft_changed')
    expect(retryBlock(held, now([held, two]))).toBe('superseded')
    expect(retryBlock({ ...held, state: 'unknown', reason: 'gone' }, now([held]))).toBe('lost')
    expect(retryBlock(held, now([held], { c: constraints([you('u1', 1, 'At most 2 attempts.')]) }))).toBe('basis_changed')
    expect(retryBlock(held, now([held], { conversation: undefined }))).toBe('no_registry')
    expect(retryBlock(held, now([held], { conversation: 's2', target: 's2' }))).toBe('other_conversation')
    expect(retryBlock(at('r-1', 100, 'v1'), now([]))).toBe('not_retryable')
    expect(newerThan(one, [one, at('r-2', 200, 'v2', 'failed')])).toBeUndefined()
  })

  it('forgets what was kept, set aside or confirmed for a line once no line has that text', () => {
    const draft = { text: 'Fix a|b.\nIt used at most 2 attempts.', earlier: ['It used at most 2 attempts.', 'Gone.'], setAside: ['u1|Never merge.', 'u1|Never merge.\nFix a|b.', 'u1|Never merge.\nGone.'], read: ['Fix a|b.|three tries', 'Fix a|three tries', 'Gone.|three tries'] }
    expect(pruned(draft)).toEqual({ ...draft, earlier: ['It used at most 2 attempts.'], setAside: ['u1|Never merge.', 'u1|Never merge.\nFix a|b.'], read: ['Fix a|b.|three tries'] })
    expect(pruned({ text: 'Fix it.', earlier: [] })).toEqual({ text: 'Fix it.', earlier: [] })
    expect(pruned({ text: 'Retry twice', earlier: [], read: ['Retry twice.'] }).read).toEqual([])
  })

  it('marks a kept line as an earlier comparison even once it no longer differs from what holds', () => {
    const loose = constraints([you('u1', 1, 'At most 9 attempts.')])
    expect(packetOf('r-1', '/w', 'fix', { text: 'Fix it.\nThe old code tried at most 5 attempts.', earlier: ['The old code tried at most 5 attempts.'] }, [], loose)).toContain('The old code tried at most 5 attempts. (Earlier comparison only, not a requirement.)')
  })

  it('tells identical lines apart for a change, and keeps them together as an earlier comparison', () => {
    const twice = 'It used at most 2 attempts.\nIt used at most 2 attempts.'
    const [first, second] = draftIssues(twice, held)
    expect(first.key).not.toBe(second.key)
    expect(draftIssues(twice, held, [first.text.trim()])).toEqual([])
    expect(keptLines(twice + '\nIt used at most 2 attempts. ', [first.text.trim()])).toEqual([{ line: 'It used at most 2 attempts.', lines: [0, 1, 2] }])
    const changed = changeIssue(twice, second, 'c2')
    expect(changed.text).toBe('It used at most 2 attempts.\nIt used at most 1 attempt.')
  })

  it('changes the new value of a "from X to Y" line, not the old one', () => {
    const r = constraints([you('r1', 0, 'Use at most 2 retries.')])
    const [issue] = draftIssues('Set retries from 3 to 5.', r)
    expect(changeIssue('Set retries from 3 to 5.', issue, 'c4').text).toBe('Set retries from 3 to 2.')
  })

  it('keeps the unit grammatical when the number changes', () => {
    const t = constraints([you('d1', 0, 'Use a timeout of at most 1 second.')])
    const [issue] = draftIssues('Keep the timeout at most 10 seconds.', t)
    expect(changeIssue('Keep the timeout at most 10 seconds.', issue, 'c3').text).toBe('Keep the timeout at most 1 second.')
  })

  it('undoes one change and keeps edits made after it', () => {
    const [issue] = draftIssues(draft, held)
    const { text, correction } = changeIssue(draft, issue, 'c1')
    const edited = `${text}\nAlso add a test for the budget.`
    expect(undoCorrection(edited, correction)).toEqual({
      text: 'Fix the retry loop.\nRetry at most 2 attempts per request.\nKeep the total timeout at most 10 seconds.\nAlso add a test for the budget.',
    })
  })

  it('refuses to undo a line that was edited again, and leaves the text alone', () => {
    const [issue] = draftIssues(draft, held)
    const { text, correction } = changeIssue(draft, issue, 'c1')
    const edited = text.replace('per request', 'per call')
    const result = undoCorrection(edited, correction)
    expect(result).toEqual({ text: edited, refused: expect.stringMatching(/edited/) })
  })

  it('blocks a subject the draft mentions while its values conflict', () => {
    const conflicted = constraints([you('u1', 1, 'At most 4 workers.'), you('u2', 2, 'At most 8 workers.')])
    expect(draftBlockers('Run the suite with at most 4 workers.', conflicted)).toEqual([expect.objectContaining({ subject: 'workers' })])
    expect(draftBlockers('Fix the parser.', conflicted)).toEqual([])
    const timeouts = constraints([you('u1', 1, 'Keep the timeout at most 10 s.'), you('u2', 2, 'Keep the timeout at most 20 s.')])
    expect(draftBlockers('The deadline is fine. Allow at most 30 s for the timeout.', timeouts)).toEqual([expect.objectContaining({ subject: 'timeout' })])
  })
})

describe('draft lines against your rules', () => {
  const c = constraints([you('u0', 1, "Keep the 10 second total deadline. Don't raise it to 30 seconds: callers can't wait longer.")])
  const rule = "Don't raise it to 30 seconds: callers can't wait longer."

  it('flags a line that sets an amount one of your rules names, and quotes the clause that names it', () => {
    expect(draftRuleHits('Fix the budget.\nRaise the total deadline to 30 seconds so the check passes.', c)).toEqual([
      expect.objectContaining({ line: 1, shown: 'Raise the total deadline to 30 seconds', clause: "Don't raise it to 30 seconds", rule: expect.objectContaining({ sentence: rule }) }),
    ])
    expect(draftRuleHits('Set the deadline to 30000 ms.', c)).toHaveLength(1)
    expect(draftRuleHits('Bump the total budget to thirty seconds.', c)).toEqual([expect.objectContaining({ line: 0, shown: 'Bump the total budget to thirty seconds', clause: "Don't raise it to 30 seconds" })])
    expect(draftRuleHits('Raise the total deadline to half a minute.', c)).toEqual([expect.objectContaining({ line: 0, shown: 'Raise the total deadline to half a minute', clause: "Don't raise it to 30 seconds" })])
    expect(draftRuleHits('Let the overall timeout go up to 30000 ms.', c)).toEqual([expect.objectContaining({ line: 0, shown: 'up to 30000 ms', clause: "Don't raise it to 30 seconds" })])
  })

  it('leaves a line that restates the rule, keeps the amount out, or sets an amount no rule names', () => {
    expect(draftRuleHits("Don't raise the deadline to 30 seconds.\nKeep 10 s instead of raising the deadline to 30 seconds.\nSet the backoff to 200 ms.\nRaise the deadline to 20 seconds.", c)).toEqual([])
  })

  it('flags a line that sets a setting your rule fixes at another amount, and leaves one that agrees', () => {
    const kept = constraints([you('u0', 1, "Keep the 10 second total deadline and retry only idempotent requests. Don't raise it to 30 seconds.")])
    expect(draftRuleHits('Increase the total deadline to 15 seconds, then rerun the tests.', kept)).toEqual([
      expect.objectContaining({ line: 0, shown: 'Increase the total deadline to 15 seconds', clause: 'Keep the 10 second total deadline and retry only idempotent requests' }),
    ])
    expect(draftRuleHits('Set the deadline to 10 seconds.', kept)).toEqual([])
  })

  it('flags a line that does what a rule says never to do, unless it keeps it out or asks first', () => {
    const never = constraints([you('u0', 1, 'Never merge the PR without asking me. Never report sample results as full-set conclusions.')])
    expect(draftRuleHits('Fix the budget, then merge the PR once the checks pass.', never)).toEqual([
      expect.objectContaining({ line: 0, shown: 'merge the PR', clause: 'Never merge the PR without asking me' }),
    ])
    expect(draftRuleHits('Raise the deadline to 20 seconds.', constraints([you('u0', 1, "Don't raise the deadline to 30 seconds.")]))).toEqual([])
    expect(draftRuleHits("Don't merge the PR.\nAsk me before you merge the PR.\nReport back: what you changed and what is still unresolved.", never)).toEqual([])
  })

  it('flags a line that loosens what a rule or a limit fixes, even without a number', () => {
    const kept = constraints([you('u0', 1, "Keep the 10 second total deadline and retry only idempotent requests. Don't raise it to 30 seconds."), you('u1', 2, 'At most 2 attempts.')])
    expect(draftRuleHits('Loosen the total deadline until the check passes.', kept)).toEqual([
      expect.objectContaining({ line: 0, shown: 'Loosen the total deadline', clause: 'Keep the 10 second total deadline and retry only idempotent requests' }),
    ])
    expect(limitPushes('Make the budget per request.\nAdd one more retry on top of the current limit.\nGive it another attempt.', kept).map((p) => [p.line, p.shown, p.holds.key])).toEqual([
      [1, 'Add one more retry', 'attempts|max'],
      [2, 'Give it another attempt', 'attempts|max'],
    ])
    expect(draftRuleHits("Don't loosen the total deadline.\nThe old code raised the deadline.\nAsk me before you extend the deadline.\nRaise the total deadline to 30 seconds.", kept).map((h) => [h.line, h.shown])).toEqual([
      [1, 'raised the deadline'],
      [3, 'Raise the total deadline to 30 seconds'],
      [3, 'Raise the total deadline to 30 seconds'],
    ])
    expect(limitPushes("Don't add more retries.\nIncrease the coverage.", kept)).toEqual([])
  })

  it('reads "times out" as the timeout, so a duration on that line meets the deadline rule', () => {
    const kept = constraints([you('u0', 1, 'Keep the 10 second total deadline and retry only idempotent requests.')])
    expect(draftRuleHits('Let the whole request run for up to 25 seconds before it times out.', kept)).toEqual([expect.objectContaining({ line: 0, shown: 'up to 25 seconds' })])
  })

  it('reads push in the git sense only, and asks about an amount even on a line written as history', () => {
    expect(scopeHits('Cut the 200ms backoff if it is what pushes the total over the deadline.\nPush the fix to the branch.')).toEqual([{ line: 1, shown: 'Push', kind: 'ship' }])
    expect(uncheckedAmounts('The old code tried 3 attempts.', constraints([you('u1', 1, 'At most 2 attempts.')])).map((u) => u.shown)).toEqual(['3 attempts'])
  })

  it('reads no line as history: merges, pushes, set-asides, loosened limits and amounts are flagged however they are worded', () => {
    expect(scopeHits('The build was broken. Push the fix to main and deploy it.')).toEqual([
      { line: 0, shown: 'Push', kind: 'ship' },
      { line: 0, shown: 'deploy', kind: 'ship' },
    ])
    const timeout = constraints([you('u0', 1, 'Keep the timeout at most 10 seconds.')])
    expect(limitPushes('It was flaky, extend the timeout.', timeout).map((p) => p.shown)).toEqual(['extend the timeout'])
    expect(scopeHits('Push the changes that were reviewed to main.\nSkip the tests that were flaky.\nEarlier we pushed to main.\nThe fix should be deployed the way it was before.').map((h) => [h.line, h.shown])).toEqual([
      [0, 'Push'],
      [1, 'Skip the tests'],
      [2, 'pushed'],
      [3, 'deployed'],
    ])
    expect(limitPushes('Earlier we would raise the timeout.', timeout).map((p) => p.shown)).toEqual(['raise the timeout'])
    const attempts = constraints([you('u1', 1, 'At most 2 attempts.')])
    expect(uncheckedAmounts('You can take three attempts as we did before.\nRetry the request that was dropped once more.\nGive the old test three attempts.\nThe old code tried 3 attempts.\nYou should give the old test three attempts.\nI want the old test to get three attempts.\nThe test that failed should get three attempts.\nThe request that was dropped should get one more try.', attempts).map((u) => [u.line, u.shown])).toEqual([
      [0, 'three attempts'],
      [1, 'once more'],
      [2, 'three attempts'],
      [3, '3 attempts'],
      [4, 'three attempts'],
      [5, 'three attempts'],
      [6, 'three attempts'],
      [7, 'one more try'],
    ])
    const sent = draftChecks({ text: 'Retry up to 2 times.\nTry once more.', read: ['Try once more.|once more'] }, [], attempts)
    expect([sent.unread.map((u) => u.shown), sent.confirmed.map((u) => u.shown)]).toEqual([['up to 2 times'], ['once more']])
    expect(uncheckedAmounts('It was flaky, so try once more.', constraints([you('u1', 1, 'At most 2 attempts.')])).map((u) => u.shown)).toEqual(['once more'])
  })

  it('checks every line, quoted or drafted, and leaves a merge conflict alone; the drafted lines carry no tool or agent text', () => {
    const named = briefOf([agent('a1', 1, 'Running the tests.'), { id: 'f0', kind: 'failure' as const, author: 'tool' as const, at: 5, text: "FAIL deploy > doesn't push twice", session: 'fix' }], constraints([]), 'fix', 1)
    expect(draftChecks({ text: draftFor(named) }, [named.failing as Entry], constraints([you('u1', 1, 'At most 2 attempts.')]))).toMatchObject({ issues: [], hits: [], scope: [], pushes: [], unread: [] })
    expect(scopeHits('Run "git push --force origin main" when done.\nThen run “npm run deploy” to ship it.').map((h) => [h.line, h.shown])).toEqual([
      [0, 'push'],
      [1, 'deploy'],
    ])
    const drafted = draftFor({ ...briefOf([agent('a1', 5, "I'll push the fix once CI is green.")], constraints([]), 'fix', 1), failing: undefined })
    expect(scopeHits(drafted)).toEqual([])
    expect(scopeHits('Decision: find and fix why "deploy rollback" fails, then rerun the checks that cover it.').map((h) => h.shown)).toEqual(['deploy'])
    expect(scopeHits('Find out why "npm run deploy" fails and rerun it until it passes.\nRestore the previous config before you deploy.\nMerging was what broke it.').map((h) => [h.line, h.shown])).toEqual([
      [0, 'deploy'],
      [1, 'deploy'],
      [2, 'Merging'],
    ])
    expect(scopeHits('Resolve the merge conflict in config.ts.\nThen merge it.')).toEqual([{ line: 1, shown: 'merge', kind: 'ship' }])
  })

  it('lets a draft set a held setting to an amount within its bound', () => {
    const timeout = constraints([you('u0', 1, 'Keep the timeout at most 30 seconds.')])
    expect(draftIssues('Lower the timeout to 10 seconds.', timeout)).toEqual([])
    expect(draftIssues('Keep the timeout at most 10 seconds.', timeout)).toEqual([])
    expect(draftIssues('At least 3 workers.', constraints([you('u0', 1, 'Use at least 2 workers.')]))).toEqual([])
    const floor = constraints([you('u0', 1, 'Keep the timeout at least 10 seconds.')])
    expect(draftIssues('Lower the timeout to 5 seconds.\nKeep the timeout at most 5 seconds.\nKeep the timeout at most 50 seconds.', floor).map((i) => i.line)).toEqual([0, 1])
    expect(draftIssues('Raise the timeout to 45 seconds.', timeout).map((i) => i.found.shown)).toEqual(['Raise the timeout to 45 seconds'])
  })

  it('takes an amount the check itself measured as known, so it needs no confirming', () => {
    const kept = constraints([you('u0', 1, 'Keep the 10 second total deadline and retry only idempotent requests.')])
    const known = evidenceAmounts('FAIL keeps total deadline\nExpected ≤ 10000ms · Received 12641ms')
    expect(uncheckedAmounts('Find where the 12.6 s of the deadline goes.', kept)).toHaveLength(1)
    expect(uncheckedAmounts('Find where the 12.6 s of the deadline goes.', kept, known)).toEqual([])
  })

  it('reads "allow 3 attempts" as a limit, so a draft that allows more than holds is flagged', () => {
    expect(limitsIn('Allow 3 attempts per request.').map((f) => [f.subject, f.bound, f.value, f.shown])).toEqual([['attempts', 'max', 3, 'Allow 3 attempts']])
    expect(limitsIn('Permit only 2 retries.').map((f) => [f.subject, f.bound, f.value])).toEqual([['retries', 'max', 2]])
    expect(draftIssues('Allow 3 attempts for slow calls.', constraints([you('u1', 1, 'At most 2 attempts.')]))).toHaveLength(1)
  })

  it('splits a question into the parts it asks, leaving out how to answer', () => {
    expect(askedParts(QUESTION_START)).toEqual(['explain why the latest check still fails', 'what was tried since I left'])
    expect(askedParts('Why does it take 12.6 s? And did it check the budget reset?')).toEqual(['Why does it take 12.6 s', 'And did it check the budget reset'])
    expect(askedParts('Why does it still take 12.6 s? Facts vs guesses, please.')).toEqual(['Why does it still take 12.6 s'])
    expect(askedParts('Does the budget reset retry a POST? Point to the file and line.')).toEqual(['Does the budget reset retry a POST'])
    expect(unmentioned('Does commit 4be19c2 change src/retry.ts:30 so the budget is per request?', 'src/retry.ts:52 gives each request the full budget.')).toHaveLength(1)
    expect(unmentioned('Does commit 4be19c2 change the budget per request?', 'Commit 4BE19C2 makes the budget per request.')).toEqual([])
  })

  it('finds a line that asks for a merge, push or deploy, which a repair never asks for', () => {
    expect(scopeHits('Merge the PR once the tests pass.\nDo not merge the PR.\nAsk me before you push.\nThe old code pushed twice.\nThen deploy it.')).toEqual([
      { line: 0, shown: 'Merge', kind: 'ship' },
      { line: 3, shown: 'pushed', kind: 'ship' },
      { line: 4, shown: 'deploy', kind: 'ship' },
    ])
    expect(scopeHits('Ignore the limits quoted below.\nSkip the keeps total deadline test.\nDon\'t skip any test.\nDisregard my rules here.')).toEqual([
      { line: 0, shown: 'Ignore the limits', kind: 'ignore' },
      { line: 1, shown: 'Skip the keeps total deadline test', kind: 'ignore' },
      { line: 3, shown: 'Disregard my rules', kind: 'ignore' },
    ])
    expect(scopeHits('If the deadline test still fails, mark it as skipped.\nDisable the keeps total deadline test.\nDon\'t disable any check.')).toEqual([
      { line: 0, shown: 'mark it as skipped', kind: 'ignore' },
      { line: 1, shown: 'Disable the keeps total deadline test', kind: 'ignore' },
    ])
    expect(scopeHits('Delete the failing assertion.\nComment out the deadline test.\nRemove the old retry helper.\nDon\'t remove any test.')).toEqual([
      { line: 0, shown: 'Delete the failing assertion', kind: 'ignore' },
      { line: 1, shown: 'Comment out the deadline test', kind: 'ignore' },
    ])
  })

  it('lists amounts written in words, and retry counts against a held attempt limit, which it does not check', () => {
    expect(uncheckedAmounts('Allow a few attempts.\nFinish in half a minute in total.\nAt most 2 attempts.\nAllow up to three attempts.')).toEqual([
      { line: 0, shown: 'a few attempts' },
      { line: 1, shown: 'half a minute' },
    ])
    expect(limitsIn('Allow up to three attempts.')).toMatchObject([{ subject: 'attempts', bound: 'max', value: 3, shown: 'up to three attempts' }])
    const attempts = constraints([you('u1', 1, 'At most 2 attempts.')])
    expect(uncheckedAmounts('Retry up to 3 times.\nAllow at most 2 retries.', attempts)).toEqual([{ line: 1, shown: 'at most 2 retries', count: 2 }])
    expect(draftIssues('Retry up to 3 times.\nTry each request three times.\nAllow at most 2 retries.', attempts).map((i) => [i.line, i.found.shown, i.holds.key])).toEqual([
      [0, 'up to 3 times', 'attempts|max'],
      [1, 'Try each request three times', 'attempts|max'],
    ])
    expect(uncheckedAmounts('Retry up to 3 times.')).toEqual([])
    expect(uncheckedAmounts('Permit a third try for idempotent requests.')).toEqual([{ line: 0, shown: 'third try' }])
    expect(uncheckedAmounts('After the second failure let it try once more.', attempts)).toEqual([{ line: 0, shown: 'once more' }])
    expect(uncheckedAmounts('After the second failure let it try once more.')).toEqual([])
    expect(uncheckedAmounts('Run the two requests in parallel.', attempts)).toEqual([])
    const deadline = constraints([you('u2', 1, 'Keep the total deadline at most 10 seconds.')])
    expect(uncheckedAmounts('Use 30000 ms as the total deadline budget.\nKeep the deadline at most 10 seconds.', deadline)).toEqual([{ line: 0, shown: '30000 ms' }])
    const ruled = constraints([you('u2', 1, 'Keep the total deadline at most 10 seconds.'), you('u3', 1, "Don't raise it to 30 seconds: callers can't wait longer.")])
    expect(uncheckedAmounts('Keep the deadline; do not raise it to 30 seconds.\nDo not raise it to thirty seconds.\nUse 30 seconds as the total deadline.', ruled)).toEqual([{ line: 2, shown: '30 seconds' }])
    expect(uncheckedAmounts('Use 30000 ms as the total deadline budget.')).toEqual([])
    expect(uncheckedAmounts('Use 30000 ms as the total deadline budget.', constraints([you('u3', 1, 'Keep the 10 second total deadline and retry only idempotent requests.')]))).toEqual([{ line: 0, shown: '30000 ms' }])
  })

  it('lists each amount once, and leaves out ordinals, amounts your rules state and the value that holds now', () => {
    const attempts = constraints([you('u1', 1, 'At most 2 attempts.')])
    expect(uncheckedAmounts('Let slow calls have one more try only if the budget allows.', attempts)).toEqual([{ line: 0, shown: 'one more try' }])
    expect(uncheckedAmounts('Skip the second attempt when the budget is spent.', attempts)).toEqual([])
    expect(uncheckedAmounts('Permit a second try.', attempts)).toEqual([{ line: 0, shown: 'second try' }])
    expect(uncheckedAmounts('Fit 2 attempts and their backoff inside it.', attempts)).toEqual([])
    expect(uncheckedAmounts('Fit 3 attempts inside it.', attempts)).toEqual([{ line: 0, shown: '3 attempts' }])
    const rule = constraints([you('u3', 1, "Keep the 10 second total deadline and retry only idempotent requests. Don't raise it to 30 seconds.")])
    expect(uncheckedAmounts('Keep the 10 second total deadline.', rule)).toEqual([])
    expect(uncheckedAmounts('Use 30 seconds as the total deadline.', rule)).toEqual([{ line: 0, shown: '30 seconds' }])
    expect(uncheckedAmounts('If the first attempt fails, retry twice more.', attempts)).toEqual([{ line: 0, shown: 'twice more' }])
    const replaced = constraints([you('u0', 1, 'At most 3 attempts.'), you('u1', 2, 'At most 2 attempts instead of 3.')])
    expect(uncheckedAmounts('Go back to 3 attempts.', replaced)).toEqual([{ line: 0, shown: '3 attempts', was: 'at most 3 attempts' }])
  })

  it('checks a line against every rule left once one is set aside, and reads more ways to set an amount', () => {
    const both = constraints([you('u0', 1, "Keep the 10 second total deadline and retry only idempotent requests. Don't raise it to 30 seconds.")])
    const hits = draftRuleHits('Raise the total deadline to 30 seconds.', both)
    expect(hits.map((h) => h.clause)).toEqual(["Don't raise it to 30 seconds", 'Keep the 10 second total deadline and retry only idempotent requests'])
    expect(draftRuleHits('Raise the total deadline to 30 seconds.', both, [hits[0].key]).map((h) => h.clause)).toEqual(['Keep the 10 second total deadline and retry only idempotent requests'])
    expect(draftRuleHits('Bump the overall deadline to 30000 ms.', both)).toHaveLength(2)
    expect(draftRuleHits('Extend the deadline to 15 seconds.', both)).toHaveLength(1)
    expect(draftRuleHits('Bump the overall request timeout to 30000 ms.', both)).toHaveLength(2)
    expect(draftRuleHits('Set the overall timeout to 30000 ms.', both).map((h) => h.clause)).toEqual(["Don't raise it to 30 seconds", 'Keep the 10 second total deadline and retry only idempotent requests'])
  })

  it('lets you set the rule aside for this repair, and the message says so instead of quoting it as binding', () => {
    const [hit] = draftRuleHits('Raise the deadline to 30 seconds.', c)
    expect(draftRuleHits('Raise the deadline to 30 seconds.', c, [hit.key])).toEqual([])
    const packet = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Raise the deadline to 30 seconds.', constraints: c, earlier: [], setAside: [hit.key] })
    expect(packet).toContain(`I set aside my rule from 1970-01-01 00:00Z for this request only: "${rule}"`)
    expect(packet).not.toContain(`- Rule (you, 1970-01-01 00:00Z): "${rule}"`)
    expect(packet).not.toContain('If the request above conflicts')
    const two = 'Raise the deadline to 30 seconds.\nThen raise the deadline to 30 seconds again.'
    const [first] = draftRuleHits(two, c)
    expect(draftRuleHits(two, c, [exceptionKey(first)]).map((h) => h.line)).toEqual([1])
    const scoped = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: two, constraints: c, earlier: [], setAside: [exceptionKey(first)] })
    expect(scoped).toContain(`- Rule (you, 1970-01-01 00:00Z): "${rule}"`)
    expect(scoped).toContain(`For this request only, I make an exception to my rule from 1970-01-01 00:00Z: "${rule}", for this line only: "Raise the deadline to 30 seconds.". The rest of the rule still holds.`)
    expect(repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Raise it.', constraints: c, earlier: [], setAside: [exceptionKey(first)] })).not.toContain('exception')
  })

  it('tells the agent to stop and ask on a conflict with a quoted rule, never to follow the request over it', () => {
    const packet = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Fix the budget.', constraints: c, earlier: [] })
    expect(packet).toContain('If the request above conflicts with one of these rules, stop and ask me before acting on it.')
    expect(packet).not.toContain('follow the request')
  })
})

describe('what a reply leaves out', () => {
  const asked = [
    'Please continue in this conversation.',
    '',
    'Decision: cap each attempt by the time left in the budget.',
    'Also check the review finding about budget reset between requests.',
    'Follow my decisions and the limits quoted below, not earlier agent suggestions.',
    'Report back: what you changed, which tests you ran and their output, and what is still unresolved.',
  ].join('\n')

  it('lists every line you asked for, each report-back item on its own, leaving out the lines every draft carries', () => {
    expect(askedLines(asked)).toEqual([
      'Decision: cap each attempt by the time left in the budget.',
      'Also check the review finding about budget reset between requests.',
      'Report back: what you changed',
      'Report back: which tests you ran and their output',
      'Report back: what is still unresolved',
    ])
    expect(askedLines('The old code tried 3 attempts. (Earlier comparison only, not a requirement.)')).toEqual([])
  })

  it('names the lines no sentence of the reply shares two words with, reading negations alike and a shared number as enough', () => {
    const reply = '[devbox result r-1] Capped each attempt by the remaining budget time. Fixed it.'
    expect(unmentioned(asked, reply)).toEqual(['Also check the review finding about budget reset between requests.', 'Report back: which tests you ran and their output', 'Report back: what is still unresolved'])
    expect(unmentioned('Never merge the PR without asking me.', 'I did not merge the PR.')).toEqual([])
    expect(unmentioned('Where did 200ms come from', 'The 200 ms backoff appears in src/retry.ts:41.')).toEqual([])
    expect(unmentioned('Ship it.', 'I shipped it.')).toEqual([])
    expect(unmentioned('Allow up to 2 attempts.\nAdd a test for writes.', 'Now at most 2 attempts.')).toEqual(['Add a test for writes.'])
  })

  it('checks each report-back item for what it has to say, and leaves one it has no check for to you', () => {
    const report = 'Report back: what you changed, which tests you ran and their output, and what is still unresolved.'
    expect(unmentioned(report, 'Fixed the budget decrement. retry.test.ts passes: 9.6 s.')).toEqual(['Report back: what is still unresolved'])
    expect(unmentioned(report, 'Fixed it. Nothing is unresolved; retry.test.ts passes.')).toEqual([])
    expect(unmentioned('Report back: which tests you ran and their output', 'I ran retry.test.ts.')).toEqual(['Report back: which tests you ran and their output'])
    expect(unmentioned('Report back: how it went', 'Done.')).toEqual([])
  })

  it('quotes, for a line the reply seems to mention, the sentence that shares the most of its words, each sentence for one line only', () => {
    const reply = '[devbox result r-1] Fixed the budget decrement so the first attempt counts. retry.test.ts passes.'
    expect(nearestFor(['Fix the budget decrement.', 'Cap each attempt timeout to the time remaining.', 'Report back: what you changed'], reply)).toEqual(['Fixed the budget decrement so the first attempt counts.', undefined, undefined])
    expect(nearestFor(['Fix the budget decrement first.', 'Check the budget decrement.'], 'Fixed the budget decrement first.')).toEqual(['Fixed the budget decrement first.', undefined])
    expect(nearestFor(['Add a test for writes.'], 'Done.')).toEqual([undefined])
  })

  it("doesn't count the words of the limits and rules the repair quoted as the reply mentioning a line", () => {
    const c = constraints([you('u1', 1, 'Keep the 10 second total deadline and retry only idempotent requests.'), you('u2', 1, 'Never merge the PR without asking me.')])
    const packet = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Respect the remaining budget within the 10 second total deadline.\nNever merge the PR.', constraints: c, earlier: [], quote: { [ruleKey(c.rules[0])]: true, [ruleKey(c.rules[1])]: true } })
    const reply = 'I kept the 10 second deadline. Nothing merged.'
    expect(unmentioned(askedIn(packet), reply)).toEqual([])
    expect(unmentioned(askedIn(packet), reply, contextOf(packet))).toEqual(['Respect the remaining budget within the 10 second total deadline.'])
    expect(partly(['Respect the remaining budget within the 10 second total deadline.'], reply, contextOf(packet))).toEqual([undefined])
    expect(partly(['Respect the remaining budget within the 10 second total deadline.'], 'The budget now caps the 10 second deadline.', contextOf(packet))).toEqual(['The budget now caps the 10 second deadline.'])
    expect(replyGaps(packet, reply)).toEqual(['Respect the remaining budget within the 10 second total deadline.'])
    expect(replyGaps(packet, 'The remaining budget now caps each try. Nothing merged.')).toEqual([])
  })

  it('reads each sentence of a line you asked on its own, so a reply that did one part is not counted against the rest', () => {
    const asked = 'Decision: keep the 10 second total deadline. Make retries fit inside it: cap the backoff and check the budget reset. Then rerun the boundary tests.'
    expect(askedLines(asked)).toEqual(['Decision: keep the 10 second total deadline.', 'Make retries fit inside it: cap the backoff and check the budget reset.', 'Then rerun the boundary tests.'])
    expect(unmentioned(asked, 'Fixed the budget decrement. I kept the 10 second deadline.')).toEqual(['Make retries fit inside it: cap the backoff and check the budget reset.', 'Then rerun the boundary tests.'])
  })

  it('sums a repair up by its decision, else by its first line that says more than the limits it quotes', () => {
    const c = constraints([you('u1', 1, 'At most 2 attempts.')])
    const packet = (body: string) => repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body, constraints: c, earlier: [] })
    expect(leadAsk(packet('Keep at most 2 attempts.\nCap the backoff at 100 ms.'))).toBe('Cap the backoff at 100 ms.')
    expect(leadAsk(packet('Keep at most 2 attempts.\nDecision: fix the budget decrement.'))).toBe('Decision: fix the budget decrement.')
    const failure: Entry = { id: 'f1', kind: 'failure', author: 'tool', at: 2, text: 'FAIL keeps total deadline\nExpected ≤ 10000ms · Received 12641ms', session: 'fix' }
    const drafted = draftFor(briefOf([failure], c, 'fix', 1))
    const sent = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: drafted, constraints: c, earlier: [], failure })
    expect(leadAsk(sent, 'keeps total deadline')).toBe('Decision: find and fix why ‘keeps total deadline’ fails, then rerun the checks that cover it.')
    expect(leadAsk(sent)).toBe('Decision: find and fix the recorded failure, then rerun the checks that cover it.')
    expect(leadAsk(sent, "parses '$' amounts")).toBe("Decision: find and fix why ‘parses '$' amounts’ fails, then rerun the checks that cover it.")
    expect(repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Fix it.\nRetry at most 5 attempts. ', constraints: c, earlier: ['Retry at most 5 attempts. '] })).toContain('Retry at most 5 attempts. (Earlier comparison only, not a requirement.)')
  })

  it("leaves a follow-up's opening line out of what you asked", () => {
    expect(askedLines("The reply to r-1 doesn't seem to cover these. Do each, or say why not:\n- Add a test for writes.")).toEqual(['- Add a test for writes.'])
  })

  it('counts what a reply leaves out the same way everywhere: your lines, then each message you attached once, naming its missed parts, and not again when one of your lines already missed it', () => {
    const packet = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Cap each attempt by the time left.\nAdd a test for writes.', constraints: constraints([]), earlier: [], others: [{ ...agent('c1', 1, 'The 200ms backoff has no reason; budget reset needs checking.'), session: 'review' }] })
    expect(replyGaps(packet, 'Capped each attempt by the time left. The 200 ms backoff is jittered now.')).toEqual(['Add a test for writes.', 'budget reset needs checking'])
    expect(replyGaps(packet, 'Done.')).toEqual(['Cap each attempt by the time left.', 'Add a test for writes.', 'The 200ms backoff has no reason; budget reset needs checking'])
    const twice = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Also check the budget reset that review flagged.', constraints: constraints([]), earlier: [], others: [{ ...agent('c1', 1, 'The 200ms backoff has no reason; budget reset needs checking.'), session: 'review' }] })
    expect(replyGaps(twice, 'The 200 ms backoff is jittered now.')).toEqual(['Also check the budget reset that review flagged.'])
  })

  it('reads the other sessions\' messages you attached, one part at a time', () => {
    const packet = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Fix it.', constraints: constraints([]), earlier: [], others: [{ ...agent('c1', 1, 'Two review findings: the 200ms backoff has no reason; budget reset needs checking.'), session: 'review' }] })
    expect(attachedIn(packet)).toEqual([{ from: 'review', text: 'Two review findings: the 200ms backoff has no reason; budget reset needs checking.' }])
    expect(attachedIn('[devbox repair r-1]\n\nFix it.')).toEqual([])
    const long = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Fix it.', constraints: constraints([]), earlier: [], others: [{ ...agent('c1', 1, 'Findings:\n- retry.ts (L42): "foo"\n\n- the backoff has no reason'), session: 'review' }, { ...agent('c2', 2, 'Tests pass.'), session: 'tests' }] })
    expect(attachedIn(long)).toEqual([
      { from: 'review', text: 'Findings:\n- retry.ts (L42): "foo"\n\n- the backoff has no reason' },
      { from: 'tests', text: 'Tests pass.' },
    ])
    expect(unmentioned(askedParts(attachedIn(packet)[0].text).join('\n'), 'The 200 ms backoff is now jittered.')).toEqual(['budget reset needs checking'])
  })
})

describe('differences since the draft was checked', () => {
  const before = constraints([you('u1', 1, 'At most 2 attempts.'), you('u3', 1, 'Total timeout at most 10 seconds.')])

  it('asks nothing when only the wording or the source of the same value changed', () => {
    const restated = constraints([
      you('u1', 1, 'At most 2 attempts.'),
      you('u3', 1, 'Total timeout at most 10 seconds.'),
      you('u4', 5, 'Again: at most 2 attempts.'),
    ])
    expect(differences(basisOf(before), restated)).toEqual([])
  })

  it('lists a changed value with both sources', () => {
    const after = constraints([
      you('u1', 1, 'At most 2 attempts.'),
      you('u3', 1, 'Total timeout at most 10 seconds.'),
      you('u2', 9, 'At most 1 attempt instead of 2.'),
    ])
    expect(differences(basisOf(before), after)).toEqual([
      expect.objectContaining({ key: 'attempts|max', change: 'value', before: expect.objectContaining({ value: 2 }), after: expect.objectContaining({ value: 1, recordId: 'u2' }) }),
    ])
  })

  it('lists a constraint that became undecided, and one that is new', () => {
    const after = constraints([
      you('u1', 1, 'At most 2 attempts.'),
      you('u3', 1, 'Total timeout at most 10 seconds.'),
      you('u5', 9, 'At most 3 attempts.'),
      you('u6', 9, 'At most 4 workers.'),
    ])
    expect(differences(basisOf(before), after).map((d) => [d.key, d.change])).toEqual([
      ['attempts|max', 'undecided'],
      ['workers|max', 'new'],
    ])
  })

  it('treats a draft saved without a basis as needing one check', () => {
    expect(differences(null, before)).toEqual([expect.objectContaining({ change: 'unchecked' })])
  })
})

describe('grouping sessions into work', () => {
  const pr = 'https://github.com/acme/api/pull/184'
  const m = (name: string, extra: Partial<Member> = {}): Member => ({ name, agent: 'claude', path: `/w/${name}`, prs: [], ...extra })

  it('groups sessions that name the same pull request, and says why', () => {
    const works = groupWork([m('code', { prs: [pr] }), m('review', { prs: [pr] }), m('docs')], [])
    const work = works.find((w) => w.members.length === 2)
    expect(work?.key).toBe(`pr:${pr}`)
    expect(work?.members).toEqual([
      { name: 'code', reason: 'same pull request #184' },
      { name: 'review', reason: 'same pull request #184' },
    ])
    expect(works.find((w) => w.members[0].name === 'docs')?.members).toHaveLength(1)
  })

  it('groups sessions on the same branch of the same repository', () => {
    const works = groupWork(
      [m('code', { repo: '/w/api', branch: 'fix/retry' }), m('tests', { agent: 'shell', repo: '/w/api', branch: 'fix/retry' })],
      [],
    )
    expect(works).toHaveLength(1)
    expect(works[0].members.map((x) => x.reason)).toEqual(['same branch fix/retry in api', 'same branch fix/retry in api'])
  })

  it('never groups by folder name, default branches, or a missing branch', () => {
    const works = groupWork(
      [
        m('a', { path: '/w/one/api', repo: '/w/one/api', branch: 'main' }),
        m('b', { path: '/w/two/api', repo: '/w/two/api', branch: 'main' }),
        m('c', { path: '/w/one/api', repo: '/w/one/api' }),
        m('d', { agent: 'shell', path: '/w/three/api', repo: '/w/three/api', branch: 'fix/retry' }),
        m('e', { path: '/w/one/api', repo: '/w/one/api', branch: 'fix/retry' }),
      ],
      [],
    )
    expect(works.map((w) => w.members.length)).toEqual([1, 1, 1, 1, 1])
  })

  it('shows a session separately after you separate it, and back again after undo', () => {
    const members = [m('code', { prs: [pr] }), m('review', { prs: [pr] })]
    const apart = groupWork(members, [{ work: `pr:${pr}`, session: 'review' }])
    expect(apart.map((w) => w.members.map((x) => x.name))).toEqual([['code'], ['review']])
    expect(apart[1].members[0].reason).toBe('you showed it separately')
    expect(groupWork(members, []).map((w) => w.members.length)).toEqual([2])
  })

  it('finds the work a session belongs to', () => {
    const works = groupWork([m('code', { prs: [pr] }), m('review', { prs: [pr] })], [])
    expect(workOf('review', works)?.key).toBe(`pr:${pr}`)
    expect(workOf('missing', works)).toBeUndefined()
  })
})

describe('prompt contracts', () => {
  const t0 = Date.parse('2026-10-16T10:00:00Z') / 1000
  const records = [
    you('u1', t0, 'At most 2 attempts.'),
    you('u2', t0 + 300, 'At most 1 attempt instead of 2, because upstream is rate limiting.'),
    you('u3', t0 + 400, 'Keep the total timeout at most 10 seconds. Never merge the PR automatically.'),
  ]
  const c = constraints(records)

  it('builds the repair packet with purpose, scope, target, evidence and the reply marker', () => {
    const packet = repairPacket({
      id: 'r-7f3a',
      cwd: '/work/api',
      session: 'fix',
      body: 'Retry at most 1 attempt per request.\nThe old code retried at most 2 attempts.',
      constraints: c,
      earlier: ['The old code retried at most 2 attempts.'],
      quote: { [ruleKey(c.rules[0])]: true },
    })
    expect(packet).toBe(
      [
        '[devbox repair r-7f3a]',
        'Purpose: repair. Make the changes below in /work/api. You may run the tests needed to check them. Do not merge, push, or deploy.',
        'Target: this session, fix.',
        '',
        'Retry at most 1 attempt per request.',
        'The old code retried at most 2 attempts. (Earlier comparison only, not a requirement.)',
        '',
        'What this is based on, quoted from this conversation:',
        '- Holds now (you, 2026-10-16 10:05Z): "At most 1 attempt instead of 2, because upstream is rate limiting." Replaces "At most 2 attempts." (you, 2026-10-16 10:00Z). Reason: upstream is rate limiting.',
        '- Holds now (you, 2026-10-16 10:06Z): "Keep the total timeout at most 10 seconds." No reason recorded.',
        '- Rule (you, 2026-10-16 10:06Z): "Never merge the PR automatically."',
        'If the request above conflicts with one of these rules, stop and ask me before acting on it.',
        '',
        'When you finish, start your reply with "[devbox result r-7f3a]", then list what you changed and which tests you ran.',
      ].join('\n'),
    )
  })

  it("quotes the other sessions' latest agent messages as written and not checked, after what the repair is based on", () => {
    const review = { ...agent('c1', t0 + 30, 'Two review findings: the backoff has no recorded reason.'), session: 'review' }
    const since = [agent('a1', t0 + 10, 'Budget done.'), review, { ...you('u9', t0 + 40, 'Ship it.'), session: 'review' }]
    expect(othersSince(since, 'fix')).toEqual([review])
    const blank = { ...review, id: '' }
    expect(othersSince([blank], 'fix')).toEqual([])
    const tests = { ...agent('d1', t0 + 20, 'Suite green.'), session: 'tests' }
    const work = [review, blank, tests, agent('a1', t0 + 10, 'Mine.'), { ...you('c9', t0 + 50, 'A decision.'), session: 'review' }]
    expect(keptOthers(work, 'fix', ['c1', '', 'a1', 'c9', 'd1'])).toEqual([tests, review])
    const packet = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Add the cursor.', constraints: c, earlier: [], others: othersSince(since, 'fix') })
    expect(packet).toContain(
      ['Agent messages from the other sessions in this work, quoted as written and not checked:', '- review (2026-10-16 10:00Z): "Two review findings: the backoff has no recorded reason."', ''].join('\n'),
    )
    expect(repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Add the cursor.', constraints: c, earlier: [] })).not.toContain('other sessions in this work')
  })

  it("quotes the target session's rules unless you untick them, and another session's only when you tick them", () => {
    const mixed = constraints([you('u1', t0, 'At most 50 items per page. Never commit.'), { ...you('t1', t0 + 60, 'Only touch files under test/.'), session: 'tests' }])
    const [never, tests] = mixed.rules
    expect(quotedRules(mixed, {}, 'fix').map((r) => r.sentence)).toEqual(['Never commit.'])
    expect(quotedRules(mixed, { [ruleKey(never)]: false, [ruleKey(tests)]: true }, 'fix').map((r) => r.sentence)).toEqual(['Only touch files under test/.'])
    const plain = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Add the cursor.', constraints: mixed, earlier: [] })
    expect(plain).toContain('What this is based on, quoted from this conversation:')
    expect(plain).toContain('- Rule (you, 2026-10-16 10:00Z): "Never commit."')
    expect(plain).toContain('If the request above conflicts with one of these rules')
    expect(plain).not.toContain('Only touch files under test/.')
    const bare = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Add the cursor.', constraints: mixed, earlier: [], quote: { [ruleKey(never)]: false } })
    expect(bare).not.toContain('If the request above conflicts')
    const packet = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Add the cursor.', constraints: mixed, earlier: [], quote: { [ruleKey(tests)]: true } })
    expect(packet).toContain('What this is based on, quoted from this conversation and the other sessions named below:')
    expect(packet).toContain('- Holds now (you, 2026-10-16 10:00Z): "At most 50 items per page."')
    expect(packet).toContain('- Rule (you in tests, 2026-10-16 10:01Z): "Only touch files under test/."')
  })

  it('says an older reason may not carry over to the limit that replaced it', () => {
    const c = constraints([you('u1', t0, 'At most 2 attempts, because upstream is rate limiting.'), you('u2', t0 + 60, 'At most 1 attempt instead of 2.')])
    const packet = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Use 1 attempt.', constraints: c, earlier: [] })
    expect(packet).toContain("No reason recorded. The replaced limit's reason may not apply to this one.")
  })

  it('quotes every rule you leave ticked, however many there are', () => {
    const many = constraints([you('u1', t0, Array.from({ length: 12 }, (_, i) => `Never edit file${i}.js.`).join(' '))])
    expect(many.rules).toHaveLength(12)
    const packet = repairPacket({ id: 'r-1', cwd: '/w', session: 'fix', body: 'Fix it.', constraints: many, earlier: [], quote: Object.fromEntries(many.rules.map((r) => [ruleKey(r), true])) })
    expect(packet.split('\n').filter((l) => l.startsWith('- Rule ('))).toHaveLength(12)
  })

  it('states a value you decided for this work as your decision now, not as recovered history', () => {
    const split = constraints([you('w1', t0, 'At most 4 workers.'), you('w2', t0 + 60, 'At most 8 workers.')], { 'workers|max': 'w1#0' })
    const packet = repairPacket({ id: 'r-1', cwd: '/w', session: 's', body: 'Run with at most 4 workers.', constraints: split, earlier: [] })
    expect(packet).not.toContain('newer than these rules')
    expect(packet).toContain('- Decided for this work (you, now): at most 4 workers, between "At most 4 workers." (2026-10-16 10:00Z) and "At most 8 workers." (2026-10-16 10:01Z).')
  })

  it('builds the read-only question prompt', () => {
    expect(questionPrompt({ id: 'q-1', cwd: '/work/api', question: 'Why 200 ms backoff?' })).toBe(
      [
        '[devbox question q-1]',
        'Read-only investigation. You are a read-only copy of this conversation with only Read, Grep and Glob. The original session will not see this question or your answer.',
        'Answer from this conversation and the files under /work/api. Use three headings: Facts (each with the message time or file it comes from), Inference, Unknown. If the records don\'t answer the question, say so under Unknown. Do not say you ran or changed anything.',
        '',
        'Question: Why 200 ms backoff?',
      ].join('\n'),
    )
  })
})

describe('what constraints are read from', () => {
  it('skips what Devbox itself sent, so quoted earlier values never become new constraints', () => {
    const r = constraints([
      you('u1', 1, 'At most 1 attempt.'),
      { id: 'd1', kind: 'devbox', author: 'you', at: 2, session: 'fix', text: '[devbox repair r-1]\nEarlier comparison only, not a requirement: "retried at most 2 attempts instead"' },
      { id: 'f1', kind: 'failure', author: 'tool', at: 3, session: 'fix', text: 'expected at most 3 attempts' },
    ])
    expect(r.holds.map((h) => h.limit.value)).toEqual([1])
    expect(r.conflicts).toEqual([])
  })
})

describe('the brief', () => {
  const t = (iso: string) => Date.parse(iso) / 1000
  const tool = (id: string, at: number, text: string, session = 'fix'): Entry => ({ id, kind: 'failure', author: 'tool', at, text, session })
  const records = [
    you('u0', t('2026-10-15T18:24:00Z'), "Keep the total deadline at most 10 seconds, because callers can't wait longer. At most 3 attempts. Never merge the PR without asking me."),
    agent('a0', t('2026-10-15T18:26:00Z'), 'Plan set: fix the budget decrement first, then the boundary tests.'),
    you('u1', t('2026-10-17T16:20:00Z'), 'At most 2 attempts instead of 3, because we need to ease pressure on upstream.'),
    agent('a1', t('2026-10-17T16:40:00Z'), 'Budget decrement done. Running the boundary tests.'),
    tool('f1', t('2026-10-18T09:41:00Z'), 'FAIL keeps total deadline\nExpected <= 10000ms, received 12641ms', 'tests'),
    agent('a2', t('2026-10-18T09:44:00Z'), 'Total deadline still fails at 12.6 s. I suggest raising the deadline to 30 seconds.'),
  ]
  const left = t('2026-10-15T18:30:00Z')

  it('quotes why, where you stopped, the last explicit change and what came after you left', () => {
    const brief = briefOf(records, constraints(records), 'fix', left)
    expect(brief.leftAt).toBe(left)
    expect(brief.why).toMatchObject({ reason: "callers can't wait longer", recordId: 'u0', sentence: "Keep the total deadline at most 10 seconds, because callers can't wait longer." })
    expect(brief.stopped).toMatchObject({ id: 'a0' })
    expect(brief.updated).toMatchObject({ from: { recordId: 'u0', value: 3 }, to: { recordId: 'u1', value: 2 } })
    expect(brief.since).toMatchObject({ id: 'a2' })
    expect(brief.failing).toMatchObject({ id: 'f1', session: 'tests' })
  })

  it("keeps the agent's suggestion apart from what you set, and lists limits with no recorded reason", () => {
    const brief = briefOf(records, constraints(records), 'fix', left)
    expect(brief.suggestions).toEqual([expect.objectContaining({ key: 'deadline|max', value: 30000, recordId: 'a2' })])
    expect(constraints([you('u9', 0, 'I suggest raising the deadline to 30 seconds.')]).holds).toEqual([])
    expect(brief.unexplained).toEqual([])
    const bare = [you('u0', 0, 'At most 3 attempts.')]
    expect(briefOf(bare, constraints(bare), 'fix', 10).unexplained).toEqual([expect.objectContaining({ key: 'attempts|max' })])
  })

  it('quotes the decision you left in force when no reason was recorded before you left, treats a first visit as everything before, and keeps a failure you saw until a repair goes out', () => {
    const later = records.map((r) => (r.id === 'u0' ? { ...r, text: 'Keep the total deadline at most 10 seconds. Never merge the PR: it needs my review first. At most 3 attempts.' } : r))
    const why = briefOf(later, constraints(later), 'fix', left).why
    expect(why).toMatchObject({ sentence: 'Never merge the PR: it needs my review first.', recordId: 'u0' })
    expect(why?.reason).toBeUndefined()
    const none = records.filter((r) => r.id !== 'u0')
    expect(briefOf(none, constraints(none), 'fix', left).why).toMatchObject({ reason: 'we need to ease pressure on upstream', recordId: 'u1' })
    const first = briefOf(records, constraints(records), 'fix', undefined)
    expect(first.leftAt).toBeUndefined()
    expect(first.stopped).toMatchObject({ id: 'a2' })
    expect(first.since).toBeUndefined()
    expect(first.failing).toMatchObject({ id: 'f1' })
    expect(briefOf(records, constraints(records), 'fix', t('2026-10-18T10:00:00Z')).failing).toMatchObject({ id: 'f1' })
    expect(briefOf(records, constraints(records), 'fix', t('2026-10-18T10:00:00Z'), t('2026-10-18T09:50:00Z')).failing).toBeUndefined()
  })

  it("drops the agent's flagged suggestion from what it said since you left, and the result tag a reply starts with", () => {
    const brief = briefOf(records, constraints(records), 'fix', left)
    expect(spoken(brief.since?.text ?? '', brief)).toBe('Total deadline still fails at 12.6 s.')
    expect(spoken('I suggest raising the deadline to 30 seconds.', brief)).toBe('')
    expect(spoken('[devbox result r-1] Fixed the budget.', brief)).toBe('Fixed the budget.')
  })

  it('stops counting a suggestion as news once a repair went out after it', () => {
    expect(briefOf(records, constraints(records), 'fix', left, t('2026-10-18T09:50:00Z')).suggestions).toEqual([])
    expect(briefOf(records, constraints(records), 'fix', left, t('2026-10-18T09:40:00Z')).suggestions).toHaveLength(1)
  })

  it('reads a measured value and its bound from a failing check, in seconds', () => {
    expect(measured('FAIL keeps total deadline\nExpected ≤ 10000ms · Received 12641ms')).toBe('12.6 s, limit 10 s')
    expect(measured('FAIL x\nExpected <= 10000ms, received 12641ms')).toBe('12.6 s, limit 10 s')
    expect(measured('FAIL x\nExpected >= 2s · Received 1.5s')).toBe('1.5 s, minimum 2 s')
    expect(measured('FAIL x\nExpected ≤ 10000ms · Received 10041ms')).toBe('10.04 s, limit 10 s')
    expect(measured('FAIL x\nExpected <= 50ms · Received 72ms')).toBe('0.07 s, limit 0.05 s')
    expect(measured('FAIL x\nExpected < 20ms, received 40ms')).toBe('0.04 s, limit 0.02 s')
    expect(measured('FAIL x\nExpected < 0.5ms · Received 0.8ms')).toBe('0.0008 s, limit 0.0005 s')
    expect(measured('FAIL x\nExpected <= 10000ms · Received 10000.3ms')).toBe('10.0003 s, limit 10 s')
    expect(measured('FAIL x\nExpected: 3 · Received: 4')).toBeUndefined()
    expect(measured('FAIL retry.test.ts')).toBeUndefined()
  })

  it("pairs an agent suggestion with the clause of your rule that names the same amount, by the suggestion's parsed value, never across settings", () => {
    const c = constraints([you('u1', 1, "Don't raise it to 30 seconds. Keep the 30 seconds warmup. Never use more than 4 workers.")])
    const s = (value: number, subject = 'deadline') => ({ subject, value })
    const q = (value: number, subject: string, sentence: string) => namedRule(s(value, subject), [{ ...c.rules[0], sentence }])?.clause
    expect(namedRule(s(30000), c.rules)?.rule.sentence).toBe("Don't raise it to 30 seconds.")
    expect(namedRule(s(45000), c.rules)).toBeUndefined()
    expect(q(30000, 'deadline', "Don't raise it to 30000 ms.")).toBe("Don't raise it to 30000 ms")
    expect(q(30000, 'deadline', 'Never go above 0.5 minutes.')).toBe('Never go above 0.5 minutes')
    expect(q(3000, 'deadline', 'Never go above 13 seconds.')).toBeUndefined()
    expect(q(30000, 'deadline', 'Never lower it to 10 seconds.')).toBeUndefined()
    expect(q(2000, 'wait', 'Never wait more than 5,000 ms.')).toBeUndefined()
    expect(q(5000, 'wait', 'Never wait more than 5,000 ms.')).toBe('Never wait more than 5,000 ms')
    expect(q(3, 'attempts', 'Never retry more than 3 attempts.')).toBe('Never retry more than 3 attempts')
    expect(q(5, 'attempts', 'Never go to 5 tries.')).toBe('Never go to 5 tries')
    expect(q(1, 'times', 'Never retry more than 1 time.')).toBe('Never retry more than 1 time')
    expect(q(50, 'items', 'Never process more than 50 items.')).toBe('Never process more than 50 items')
    expect(q(50, 'items', 'Never wait more than 50 ms.')).toBeUndefined()
    expect(q(80, 'percent', 'Keep CPU under 80%.')).toBe('Keep CPU under 80%')
    expect(q(30000, 'timeout', "Don't raise the timeout to 30-second values.")).toBe("Don't raise the timeout to 30-second values")
    expect(q(30000, 'timeout', 'Do not retry POSTs and keep the timeout at 30 seconds.')).toBe('Do not retry POSTs and keep the timeout at 30 seconds')
    expect(q(60000, 'wait', "Don't wait 1 min - CI kills it at 2 min.")).toBe("Don't wait 1 min")
    expect(q(30, 'attempts', 'Never raise the timeout to 30 seconds, and never 30 attempts.')).toBe('never 30 attempts')
    expect(q(30000, 'deadline', 'Keep the deadline at 10 s; or 30 s with approval.')).toBe('or 30 s with approval')
    expect([10000, 20000].map((v) => q(v, 'deadline', 'Keep it within 10-20 s.'))).toEqual(['Keep it within 10-20 s', 'Keep it within 10-20 s'])
    expect(q(30000, 'deadline', 'İİ never 30 s, ok.')).toBe('İİ never 30 s')
    expect(q(60000, 'timeout', 'Keep timeouts at 30 s, never 60 s.')).toBe('never 60 s')
    expect(q(30000, 'deadline', "Don't raise it to 30 seconds: callers can't wait longer.")).toBe("Don't raise it to 30 seconds")
    expect(q(30000, 'deadline', 'Never set the backoff to 30 s; the deadline can be 30 s.')).toBe('the deadline can be 30 s')
    expect(q(30000, 'backoff', "Don't raise the deadline to 30 s.")).toBeUndefined()
    expect(q(30000, 'duration', "Don't raise the deadline to 30 s.")).toBeUndefined()
    expect(q(5, 'retries', 'Never raise retries to 5.')).toBe('Never raise retries to 5')
    expect(q(5, 'retries', 'Never set retry to 5.')).toBe('Never set retry to 5')
    expect(q(5, 'attempts', 'Never raise tries to 5.')).toBe('Never raise tries to 5')
    expect(q(5, 'retries', 'Cap workers at 5 (not retries).')).toBeUndefined()
    expect(q(5, 'retries', 'Never raise retries to -5.')).toBeUndefined()
    expect(q(5, 'retries', 'Keep retries at most 5, always.')).toBe('Keep retries at most 5')
    expect(q(5, 'requests', 'Never merge request 5.')).toBeUndefined()
    expect(q(80, 'lines', 'Never touch line 80.')).toBeUndefined()
    expect(q(3, 'attempts', 'Always try option 3.')).toBeUndefined()
    expect(q(3, 'attempts', 'Never go past 3 – 5 attempts.')).toBe('Never go past 3 – 5 attempts')
    expect(clause('Never go past 3 – 5 attempts.')).toBe('Never go past 3 – 5 attempts')
    expect(q(2000, 'timeout', 'Never delete the 2 s3 buckets.')).toBeUndefined()
    expect(q(4 * 3600000, 'deadline', 'Never book more than 4 h100 nodes.')).toBeUndefined()
    expect(q(3000, 'timeout', 'Only touch 3 s-tier services.')).toBeUndefined()
    expect(q(2000, 'timeout', 'Never scale ec2 s nodes.')).toBeUndefined()
    expect(q(3, 'retries', "Don't retry at 3:00 UTC, the backups run then.")).toBeUndefined()
    expect(digest('a')).toBe(digest('a'))
    expect(digest('a')).not.toBe(digest('b'))
    expect(q(5, 'retries', 'Never use 5 workers or more retries.')).toBeUndefined()
    expect(q(30000, 'timeout', 'Keep the timeout between 10 - 30 s, the API is slow.')).toBe('Keep the timeout between 10 - 30 s')
    expect(clause('Retry 3 - 5 times: max')).toBe('Retry 3 - 5 times')
    expect(clause('Never raise it — 30 s is the cap.')).toBe('Never raise it')
    expect(q(1.5, 'percent', 'Never raise the percent cap to 125.')).toBeUndefined()
    expect(q(5, 'retries', 'Never set retries above 3 on v5.')).toBeUndefined()
    const two = constraints([you('u2', 1, 'Never touch the warmup, it must stay 30 seconds. Never raise the deadline to 30 seconds.')])
    expect(namedRule(s(30000), two.rules)?.rule.sentence).toBe('Never raise the deadline to 30 seconds.')
    const waits = constraints([you('u3', 1, "Never await more than 30 s in CI. Don't set the wait to 30 s.")])
    expect(namedRule(s(30000, 'wait'), waits.rules)?.rule.sentence).toBe("Don't set the wait to 30 s.")
    const raised = constraints([you('u1', 1, 'Never lower it to 10 seconds.'), agent('a1', 2, 'I suggest raising the deadline from 10 seconds to 30 seconds.')])
    expect(raised.suggestions.map((x) => [x.value, namedRule(x, raised.rules)])).toEqual([[30000, undefined]])
    expect(limitText('items|max', 50)).toBe('at most 50 items')
  })

  it('finds your rule that shares two words in a row with the first line of the failing check', () => {
    const c = constraints([you('u1', 1, "Keep the 10 second total deadline and retry only idempotent requests. Never merge the PR without asking me.")])
    expect(checkedRule('FAIL keeps total deadline\nExpected <= 10000ms', c.rules)?.sentence).toBe('Keep the 10 second total deadline and retry only idempotent requests.')
    expect(checkedRule('FAIL merge queue is red', c.rules)).toBeUndefined()
    expect(checkedRule(undefined, c.rules)).toBeUndefined()
  })

  it('fills in a draft from the failing check without restating any limit', () => {
    const brief = briefOf(records, constraints(records), 'fix', left)
    expect(draftFor(brief)).toBe(
      [
        'Please continue in this conversation.',
        '',
        'Decision: find and fix why the recorded failure quoted below fails, then rerun the checks that cover it.',
        'Follow my decisions and the limits quoted below, not earlier agent suggestions.',
        'Report back: what you changed, which tests you ran and their output, and what is still unresolved.',
      ].join('\n'),
    )
    expect(draftIssues(draftFor(brief), constraints(records))).toEqual([])
    expect(packetOf('r-1', '/w', 'fix', { text: 'Fix it.', earlier: [] }, records, constraints(records))).toContain(
      '- Latest recorded failure (tests, 2026-10-18 09:41Z): "FAIL keeps total deadline · Expected <= 10000ms, received 12641ms". Evidence to check, not my review or acceptance of the changes.',
    )
    const failure = records.find((r) => r.kind === 'failure') as Entry
    const after = [...records, { id: 'd9', kind: 'devbox' as const, author: 'you' as const, at: failure.at + 60, session: 'fix', text: '[devbox repair r-1]\nFix it.' }]
    expect(packetOf('r-2', '/w', 'fix', { text: 'Fix it.', earlier: [] }, after, constraints(after))).toContain('- Recorded failure from before the last repair (tests, 2026-10-18 09:41Z)')
  })

  it('asks the agent to pick up from its last message when nothing failed, without quoting it', () => {
    const calm = records.filter((r) => r.kind !== 'failure')
    expect(draftFor(briefOf(calm, constraints(calm), 'fix', left)).split('\n')[2]).toBe('Decision: pick up from your last message and finish what it leaves open.')
    expect(QUESTION_START).toBe("Using the recorded messages, explain why the latest check still fails and what was tried since I left. Separate facts from guesses, and say what is unknown. Don't change code or run tests.")
  })
})
