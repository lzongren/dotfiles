import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BriefResponse } from '../../src/api'
import { PickUpList, PickUpRail } from '../../src/components/PickUp'
import { attentionStamp, homeItems } from '../../src/components/work'
import type { AgentInsight, ReturnSummary, Session } from '../../src/shared/types'

const NOW = 1_800_000_000_000
const sec = (ago: number) => NOW / 1000 - ago

const session = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: false,
  clients: 0,
  activityEpoch: sec(60),
  bell: false,
  cmd: 'claude',
  title: '',
  path: `/work/${name}`,
  attachable: true,
  ...over,
})
const agent = (name: string, over: Partial<AgentInsight> = {}): AgentInsight => ({ session: name, agent: 'claude', state: 'ready', artifacts: [], commits: 0, ...over })

const limit = (id: string, value: number, at: number, sentence: string, reason?: string) => ({
  id: `${id}#0`,
  key: 'attempts|max',
  subject: 'attempts',
  bound: 'max' as const,
  value,
  shown: `at most ${value} attempts`,
  replacing: value === 2,
  recordId: id,
  author: 'you' as const,
  at,
  session: 'fix',
  sentence,
  ...(reason ? { reason } : {}),
})

const brief = (over: Partial<BriefResponse> = {}): BriefResponse => ({
  session: 'fix',
  work: { key: 'pr:https://github.com/acme/api/pull/184', members: [{ name: 'fix', reason: 'this session' }, { name: 'review', reason: 'same pull request #184' }, { name: 'tests', reason: 'same branch' }] },
  agents: { fix: 'claude', review: 'codex', tests: 'shell' },
  brief: {
    leftAt: sec(3 * 86400),
    why: { reason: 'we need to ease pressure on upstream', sentence: 'At most 2 attempts instead of 3, because we need to ease pressure on upstream.', at: sec(86400), session: 'fix', recordId: 'u1' },
    updated: { at: sec(86400), key: 'attempts|max', from: limit('u0', 3, sec(3 * 86400), 'At most 3 attempts.'), to: limit('u1', 2, sec(86400), 'At most 2 attempts instead of 3.', 'we need to ease pressure on upstream') },
    since: { id: 'a2', kind: 'agent', author: 'agent', at: sec(900), text: 'Total deadline still fails at 12.6 s.', session: 'fix' },
    suggestions: [],
    unexplained: [],
    holds: [],
    rules: [],
  },
  ...over,
})

const items = (sessions: Session[], insights: AgentInsight[], returns: Record<string, ReturnSummary> = {}, briefs: Record<string, BriefResponse> = {}, seen = sec(7200)) =>
  homeItems(sessions, new Map(insights.map((i) => [i.session, i])), () => seen, NOW, returns, briefs)

describe('the home list', () => {
  it('lists the work around Claude Code sessions that need you, changed since you looked, or wait on a repair you sent', () => {
    const list = items(
      [session('ask'), session('fresh', { activityEpoch: sec(30) }), session('sent'), session('quiet'), session('shell', { cmd: 'zsh' }), session('far', { attachable: false })],
      [
        agent('ask', { state: 'waiting', waitingFor: 'question' }),
        agent('fresh', { turnAt: sec(30) }),
        agent('sent', { turnAt: sec(9000) }),
        agent('quiet', { turnAt: sec(9000) }),
        agent('far', { state: 'waiting' }),
      ],
      { sent: { draft: false, repair: 'working', asking: 0, answered: 0 } },
    )
    expect(list.map((i) => [i.session.name, i.attention, i.status, i.action])).toEqual([
      ['ask', 'needs', 'Question', 'Answer the question'],
      ['fresh', 'new', 'New turn', 'See what changed'],
      ['sent', 'waiting', 'Waiting on the agent', 'See the handoff receipt'],
    ])
  })

  it('puts a reply under New and your unsent draft or question under Not sent yet, with the action that continues it', () => {
    const list = items([session('a'), session('b')], [agent('a', { turnAt: sec(9000) }), agent('b', { turnAt: sec(9000) })], {
      a: { draft: true, asking: 0, answered: 0 },
      b: { draft: false, repair: 'replied', asking: 0, answered: 0 },
    })
    expect(list.map((i) => [i.session.name, i.attention, i.status, i.action])).toEqual([
      ['b', 'new', 'Repair replied, review it', 'Review the reply'],
      ['a', 'unsent', 'Draft not sent', 'Continue the unsent draft'],
    ])
    const asked = items([session('c')], [agent('c', { turnAt: sec(9000) })], { c: { draft: false, question: true, asking: 0, answered: 0 } })
    expect(asked.map((i) => [i.attention, i.status, i.action])).toEqual([['unsent', 'Question not sent', 'Finish the unsent question']])
    const sent = items([session('d')], [agent('d', { turnAt: sec(9000) })], { d: { draft: true, repair: 'working', asking: 0, answered: 0 } })
    expect(sent.map((i) => [i.attention, i.status, i.also])).toEqual([['waiting', 'Waiting on the agent', ['Draft not sent']]])
    render(<PickUpList items={[...list, ...asked]} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('heading', { name: /Not sent yet/ })).toHaveTextContent('Not sent yet 2')
    expect(screen.getByText(/1 new since you looked · 2 not sent yet/)).toBeInTheDocument()
    cleanup()
    render(<PickUpList items={asked} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByText(/You can leave now/)).toHaveTextContent("You can leave now: nothing needs you and nothing is new. What you haven't sent is saved.")
    cleanup()
    const done = items([session('e')], [agent('e', { turnAt: sec(9000) })], { e: { draft: false, accepted: true, asking: 0, answered: 0 } })
    expect(done.map((i) => [i.attention, i.status, i.action])).toEqual([['accepted', 'Result accepted · merge is still yours', 'See the accepted result']])
    render(<PickUpList items={done} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('heading', { name: /Accepted · merging is yours/ })).toHaveTextContent('Accepted · merging is yours 1')
    expect(screen.getByText(/You can leave now/)).toHaveTextContent('You can leave now: nothing needs you and nothing is new. Merging what you accepted is still yours.')
  })

  it('keeps a work under Needs you while its brief shows a check that failed since you left, even after you looked', () => {
    const failing = { id: 'f1', kind: 'failure' as const, author: 'tool' as const, at: sec(600), text: 'FAIL keeps total deadline', session: 'fix' }
    const list = items([session('fix', { activityEpoch: sec(30) })], [agent('fix', { turnAt: sec(30) })], {}, { fix: brief({ brief: { ...brief().brief, failing } }) })
    expect(list.map((i) => [i.attention, i.status, i.action])).toEqual([['needs', 'Check failed', 'Review the failed check']])
    const sent = items([session('fix', { activityEpoch: sec(30) })], [agent('fix', { turnAt: sec(30) })], { fix: { draft: false, repair: 'delivered', asking: 0, answered: 0 } }, { fix: brief({ brief: { ...brief().brief, failing } }) })
    expect(sent.map((i) => [i.attention, i.status])).toEqual([['waiting', 'Waiting on the agent']])
    const looked = items([session('fix', { activityEpoch: sec(30) })], [agent('fix', { turnAt: sec(30) })], {}, { fix: brief({ brief: { ...brief().brief, failing } }) }, sec(5))
    expect(looked.map((i) => [i.attention, i.status])).toEqual([['needs', 'Check failed']])
    const before = items([session('fix', { activityEpoch: sec(30) })], [agent('fix', { turnAt: sec(30) })], {}, { fix: brief({ brief: { ...brief().brief, leftAt: sec(300), failing } }) })
    expect(before.map((i) => i.attention)).not.toContain('needs')
    const asking = items([session('fix', { activityEpoch: sec(30) })], [agent('fix', { turnAt: sec(30) })], { fix: { draft: false, asking: 1, answered: 0 } }, { fix: brief({ brief: { ...brief().brief, failing } }) })
    expect(asking.map((i) => [i.attention, i.status, i.action, i.also])).toEqual([['needs', 'Check failed', 'Review the failed check', ['Question running']]])
  })

  it("quotes your rule that shares the failing check's wording, so the result has its reference", () => {
    const failing = { id: 'f1', kind: 'failure' as const, author: 'tool' as const, at: sec(600), text: 'FAIL keeps total deadline', session: 'fix' }
    const rule = { id: 'u0#r0', recordId: 'u0', author: 'you' as const, at: sec(3 * 86400), session: 'fix', sentence: 'Keep the 10 second total deadline.' }
    const suggestion = { ...limit('a3', 30000, sec(900), 'I suggest raising the deadline to 30 seconds.'), key: 'deadline|max', subject: 'deadline', author: 'agent' as const, shown: 'raising the deadline to 30 seconds' }
    const list = items([session('fix')], [agent('fix', { turnAt: sec(30) })], {}, { fix: brief({ brief: { ...brief().brief, failing, rules: [rule], suggestions: [suggestion] } }) })
    render(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Since you left “Total deadline still fails at 12.6 s.”The agent suggested “raising the deadline to 30 seconds” · not set by youYour rule Keep the 10 second total deadline.Your reason')
    expect(screen.getByRole('button', { name: /review the failed check/i })).toBeInTheDocument()
  })

  it("says what the failed check measured and quotes your rule that names a suggestion's amount, without repeating either or claiming a conflict", () => {
    const failing = { id: 'f1', kind: 'failure' as const, author: 'tool' as const, at: sec(600), text: 'FAIL keeps total deadline\nExpected ≤ 10000ms · Received 12641ms', session: 'fix' }
    const rule = { id: 'u0#r0', recordId: 'u0', author: 'you' as const, at: sec(3 * 86400), session: 'fix', sentence: 'Keep the 10 second total deadline.' }
    const why = { sentence: "Don't raise it to 30 seconds: callers can't wait longer.", at: sec(3 * 86400), session: 'fix', recordId: 'u0' }
    const raise = { ...rule, id: 'u0#r1', sentence: why.sentence }
    const suggestion = { ...limit('a3', 30000, sec(900), 'I suggest raising the deadline to 30 seconds.'), key: 'deadline|max', subject: 'deadline', author: 'agent' as const, shown: 'raising the deadline to 30 seconds' }
    const list = items([session('fix')], [agent('fix', { turnAt: sec(30) })], {}, { fix: brief({ brief: { ...brief().brief, failing, rules: [rule, raise], why, suggestions: [suggestion] } }) })
    render(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent("Since you left Check “keeps total deadline” failed 10m ago · 12.6 s, limit 10 s · it may have passed since; only failures are recordedThe agent suggested “raising the deadline to 30 seconds” · your rule: “Don't raise it to 30 seconds”You changed")
    expect(screen.getByRole('listitem')).not.toHaveTextContent('against')
    cleanup()
    const seen = items([session('fix')], [agent('fix', { turnAt: sec(30) })], {}, { fix: brief({ brief: { ...brief().brief, leftAt: sec(300), failing, rules: [rule] } }) })
    render(<PickUpList items={seen} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Latest Check “keeps total deadline” failed 10m ago · 12.6 s')
  })

  it('lists a suggestion made since you left even when nothing else came since', () => {
    const suggestion = { ...limit('a3', 30000, sec(900), 'I suggest raising the deadline to 30 seconds.'), key: 'deadline|max', subject: 'deadline', author: 'agent' as const, shown: 'raising the deadline to 30 seconds' }
    const list = items([session('fix')], [agent('fix', { turnAt: sec(30) })], {}, { fix: brief({ brief: { ...brief().brief, since: undefined, suggestions: [suggestion] } }) })
    render(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Since you left The agent suggested “raising the deadline to 30 seconds” · not set by you')
  })

  it("shows a waiting agent's last message, not the measured check, under Last message", () => {
    const failing = { id: 'f1', kind: 'failure' as const, author: 'tool' as const, at: sec(600), text: 'FAIL keeps total deadline\nExpected ≤ 10000ms · Received 12641ms', session: 'fix' }
    const list = items([session('fix')], [agent('fix', { state: 'waiting', waitingFor: 'question' })], {}, { fix: brief({ brief: { ...brief().brief, failing } }) })
    render(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Last message “Total deadline still fails at 12.6 s.”')
  })

  it('labels suggestion lines since you left, not last message, when the waiting agent left no message to quote', () => {
    const suggestion = { ...limit('a3', 30000, sec(900), 'I suggest raising the deadline to 30 seconds.'), key: 'deadline|max', subject: 'deadline', author: 'agent' as const, shown: 'raising the deadline to 30 seconds' }
    const list = items([session('fix')], [agent('fix', { state: 'waiting', waitingFor: 'question' })], {}, { fix: brief({ brief: { ...brief().brief, since: undefined, suggestions: [suggestion] } }) })
    render(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Since you left The agent suggested')
  })

  it('labels what came lately, not since you left, for work you never left', () => {
    const list = items([session('fix')], [agent('fix', { turnAt: sec(30) })], {}, { fix: brief({ brief: { ...brief().brief, leftAt: undefined } }) })
    render(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Latest “Total deadline still fails at 12.6 s.”')
  })

  it('keeps the since-you-left label while a brief is still loading', () => {
    const list = items([session('fix')], [agent('fix', { turnAt: sec(30), summary: 'Total deadline still fails.' })])
    render(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Since you left “Total deadline still fails.”')
  })

  it('leaves a suggestion the agent made before you left off the row', () => {
    const old = { ...limit('a0', 30, sec(4 * 86400), 'I suggest raising the deadline to 30 seconds.'), author: 'agent' as const, shown: 'raising the deadline to 30 seconds' }
    const list = items([session('fix')], [agent('fix', { turnAt: sec(30) })], {}, { fix: brief({ brief: { ...brief().brief, suggestions: [old] } }) })
    render(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).not.toHaveTextContent('The agent suggested')
  })

  it('does not repeat a rule the suggestion line already quotes', () => {
    const rule = { id: 'u0#r0', recordId: 'u0', author: 'you' as const, at: sec(3 * 86400), session: 'fix', sentence: 'Never set the job timeout above 1 hour.' }
    const why = { sentence: rule.sentence, at: rule.at, session: 'fix', recordId: 'u0' }
    const suggestion = { ...limit('a3', 3600000, sec(900), 'I suggest setting the job timeout to 60 min.'), key: 'job timeout|max', subject: 'job timeout', author: 'agent' as const, shown: 'setting the job timeout to 60 min' }
    const list = items([session('fix')], [agent('fix', { turnAt: sec(30) })], {}, { fix: brief({ brief: { ...brief().brief, rules: [rule], why, suggestions: [suggestion] } }) })
    render(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('· your rule: “Never set the job timeout above 1 hour”')
    expect(screen.getByRole('listitem')).not.toHaveTextContent('You decided')
  })

  it('shows a work once, under its first session, when its brief names the others', () => {
    const list = items([session('fix', { activityEpoch: sec(10) }), session('review', { activityEpoch: sec(30) })], [agent('fix', { state: 'waiting' }), agent('review', { turnAt: sec(30) })], {}, { fix: brief() })
    expect(list.map((i) => i.session.name)).toEqual(['fix'])
  })

  it('keeps a member that needs you on its own, even when a member with a draft covers it', () => {
    const list = items([session('fix'), session('review', { activityEpoch: sec(10) })], [agent('fix', { state: 'waiting', waitingFor: 'question' }), agent('review', { turnAt: sec(9000) })], { review: { draft: true, asking: 0, answered: 0 } }, { review: brief({ session: 'review' }) })
    expect(list.map((i) => [i.session.name, i.status])).toEqual([
      ['fix', 'Question'],
      ['review', 'Draft not sent'],
    ])
    render(<PickUpRail items={list} current="fix" onSwitch={() => undefined} />)
    expect(screen.getAllByRole('button', { current: 'page' }).map((b) => b.textContent)).toEqual([expect.stringContaining('Question')])
  })

  it('puts a work under Needs you once for a check that failed in any of its sessions', () => {
    const failing = { id: 'f1', kind: 'failure' as const, author: 'tool' as const, at: sec(600), text: 'FAIL keeps total deadline', session: 'tests' }
    const list = items([session('review', { activityEpoch: sec(10) }), session('fix', { activityEpoch: sec(30) })], [agent('review', { turnAt: sec(10) }), agent('fix', { turnAt: sec(30) })], {}, { review: brief({ session: 'review', brief: { ...brief().brief, failing } }) })
    expect(list.map((i) => [i.session.name, i.attention, i.status])).toEqual([['review', 'needs', 'Check failed']])
  })

  it('shows a work once when each of its briefs reports the same failing check', () => {
    const failing = { id: 'f1', kind: 'failure' as const, author: 'tool' as const, at: sec(600), text: 'FAIL keeps total deadline', session: 'fix' }
    const b = brief({ brief: { ...brief().brief, failing } })
    const list = items([session('fix', { activityEpoch: sec(10) }), session('review', { activityEpoch: sec(30) })], [agent('fix', { turnAt: sec(10) }), agent('review', { turnAt: sec(30) })], {}, { fix: b, review: { ...b, session: 'review' } })
    expect(list.map((i) => [i.session.name, i.attention])).toEqual([['fix', 'needs']])
  })

  it('keeps a member in error as its own row', () => {
    const list = items([session('fix', { activityEpoch: sec(10) }), session('review', { activityEpoch: sec(30) })], [agent('fix', { state: 'waiting' }), agent('review', { state: 'error', turnAt: sec(30) })], {}, { fix: brief() })
    expect(list.map((i) => [i.session.name, i.status])).toEqual([
      ['fix', 'Waiting on you'],
      ['review', 'Error'],
    ])
  })

  it('gives each row one state, with the action that belongs to it, and lists a running question as waiting on the agent', () => {
    const both = items([session('a')], [agent('a', { turnAt: sec(9000) })], { a: { draft: false, question: true, asking: 0, answered: 1 } })
    expect(both.map((i) => [i.status, i.action])).toEqual([['Question answered', 'Read the answer']])
    const asking = items([session('a')], [agent('a', { turnAt: sec(9000) })], { a: { draft: false, asking: 1, answered: 0 } })
    expect(asking.map((i) => [i.attention, i.status, i.action])).toEqual([['waiting', 'Question running', 'See the question']])
    const arrived = items([session('a')], [agent('a', { turnAt: sec(9000) })], { a: { draft: false, asking: 1, answered: 1 } })
    expect(arrived.map((i) => [i.attention, i.status, i.also])).toEqual([['new', 'Question answered', ['Question running']]])
    const accepted = items([session('a')], [agent('a', { turnAt: sec(30) })], { a: { draft: false, accepted: true, asking: 0, answered: 0 } })
    expect(accepted.map((i) => i.status)).toEqual(['Result accepted · merge is still yours'])
    const open = items([session('a')], [agent('a', { turnAt: sec(30) })], { a: { draft: false, accepted: true, open: 2, asking: 0, answered: 0 } })
    expect(open.map((i) => i.status)).toEqual(['Result accepted · merge is still yours'])
  })

  it("puts an agent waiting on you ahead of your own unsent draft or answer, and keeps every other state beside the badge", () => {
    const failing = { id: 'f1', kind: 'failure' as const, author: 'tool' as const, at: sec(600), text: 'FAIL keeps total deadline', session: 'fix' }
    const both = items([session('fix')], [agent('fix', { state: 'waiting', waitingFor: 'question' })], { fix: { draft: true, question: true, asking: 0, answered: 1 } })
    expect(both.map((i) => [i.status, i.action, i.also])).toEqual([['Question', 'Answer the question', ['Question answered', 'Draft not sent', 'Question not sent']]])
    const drafted = items([session('fix', { activityEpoch: sec(30) })], [agent('fix', { turnAt: sec(30) })], { fix: { draft: true, asking: 0, answered: 0 } }, { fix: brief({ brief: { ...brief().brief, failing } }) })
    expect(drafted.map((i) => [i.status, i.also])).toEqual([['Check failed', ['Draft not sent']]])
    render(<PickUpList items={drafted} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Check failedalso: Draft not sent')
  })

  it('says what groups the sessions, with the pull request as its link', () => {
    const PR = { label: 'PR #184', url: 'https://github.com/acme/api/pull/184', at: sec(100), first: sec(900), hits: 3, said: true }
    const list = items([session('fix')], [agent('fix', { turnAt: sec(60), artifacts: [PR] })], {}, { fix: brief() })
    render(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    const row = screen.getByRole('listitem')
    expect(row).toHaveTextContent('3 sessions in PR #184 or its branch: fix, review, tests')
    expect(within(row).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([PR.url])
    expect(within(row).getByRole('button', { name: "Open fix's terminal" })).toBeInTheDocument()
  })

  it("quotes the agent's words on a row, and marks a reply as its word, not a check", () => {
    const replied = brief({ brief: { ...brief().brief, since: { id: 'a9', kind: 'agent', author: 'agent', at: sec(60), text: '[devbox result r-1] retry.test.ts passes.', session: 'fix' } } })
    const list = items([session('fix')], [agent('fix', { turnAt: sec(60) })], { fix: { draft: false, repair: 'replied', asking: 0, answered: 0 } }, { fix: replied })
    render(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Since you left The reply says, not checked: “retry.test.ts passes.”')
    cleanup()
    const gaps = items([session('fix')], [agent('fix', { turnAt: sec(60) })], { fix: { draft: false, repair: 'replied', open: 2, asking: 0, answered: 0 } }, { fix: replied })
    expect(gaps.map((i) => [i.attention, i.status])).toEqual([['new', 'Repair replied, review it']])
    render(<PickUpList items={gaps} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('The reply says, not checked: “retry.test.ts passes.”')
    cleanup()
    const summed = items([session('fix')], [agent('fix', { turnAt: sec(60), summary: 'Fixed the budget.' })], { fix: { draft: false, accepted: true, asking: 0, answered: 0 } }, { fix: brief({ brief: { ...brief().brief, since: undefined } }) })
    render(<PickUpList items={summed} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('The reply says, not checked: “Fixed the budget.”')
    cleanup()
    const accepted = items([session('fix')], [agent('fix', { turnAt: sec(60) })], { fix: { draft: false, accepted: true, asking: 0, answered: 0 } }, { fix: replied })
    render(<PickUpList items={accepted} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('The reply says, not checked: “retry.test.ts passes.”')
    cleanup()
    const open = items([session('fix')], [agent('fix', { turnAt: sec(60) })], { fix: { draft: false, accepted: true, open: 2, missed: ['Add a test for writes.', 'budget reset needs checking'], asking: 0, answered: 0 } }, { fix: replied })
    render(<PickUpList items={open} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('May have missed “Add a test for writes.”“budget reset needs checking”')
  })

  it('says what a waiting row waits for instead of the last reply, and never shows the result tag', () => {
    const replied = brief({ brief: { ...brief().brief, since: { id: 'a9', kind: 'agent', author: 'agent', at: sec(60), text: '[devbox result r-1] Fixed the budget.', session: 'fix' } } })
    const waiting = items([session('fix')], [agent('fix', { state: 'working', since: sec(30) })], { fix: { draft: false, repair: 'working', sent: 'Cap each attempt by the time left in the budget.', asking: 0, answered: 0 } }, { fix: replied })
    render(<PickUpList items={waiting} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    const region = screen.getByRole('region', { name: /pick up where you left off/i })
    expect(region).toHaveTextContent('Waiting for the reply to the repair you sent. It comes back under New since you looked, so you can leave.')
    expect(region).toHaveTextContent('You sent “Cap each attempt by the time left in the budget.”')
    expect(region).not.toHaveTextContent('You decided')
    expect(region).not.toHaveTextContent('Fixed the budget')
  })

  it('keeps a member with its own draft or reply as its own row', () => {
    const list = items([session('fix', { activityEpoch: sec(10) }), session('review')], [agent('fix', { state: 'waiting' }), agent('review', { state: 'waiting' })], { review: { draft: false, repair: 'replied', asking: 0, answered: 0 } }, { fix: brief() })
    expect(list.map((i) => [i.session.name, i.status])).toEqual([
      ['fix', 'Waiting on you'],
      ['review', 'Repair replied, review it'],
    ])
  })

  it('shows why, the last change, what came since, the sources and one action per row', () => {
    const onContinue = vi.fn()
    const list = items([session('fix')], [agent('fix', { state: 'waiting', waitingFor: 'question', title: 'Fix API retry', firstAsk: 'Make retries respect the deadline.', branch: 'fix/retry-budget' })], {}, { fix: brief() })
    render(<PickUpList items={list} now={NOW} onContinue={onContinue} onOpen={() => undefined} />)
    const region = screen.getByRole('region', { name: /pick up where you left off/i })
    expect(region).toHaveTextContent('Needs you 1')
    const row = within(region).getByRole('listitem')
    expect(row).toHaveTextContent('Fix API retry')
    expect(row).toHaveTextContent('Question')
    expect(row).toHaveTextContent('Your reason we need to ease pressure on upstream')
    expect(row).toHaveTextContent('You changed at most 3 attempts → at most 2 attempts · you wrote it in fix 1d ago')
    expect(row).toHaveTextContent('Last message “Total deadline still fails at 12.6 s.”')
    expect(row).toHaveTextContent('last visit 3d ago · waiting on you for 1m')
    expect(row).toHaveTextContent('3 sessions in PR #184: fix, review, tests')
    fireEvent.click(within(row).getByText('Goal and earlier decisions'))
    expect(row).toHaveTextContent('Asked for Make retries respect the deadline.')
    fireEvent.click(within(row).getByRole('button', { name: /answer the question/i }))
    expect(onContinue).toHaveBeenCalledWith('fix')
    cleanup()
    render(<PickUpList items={list.map((i) => ({ ...i, looked: sec(120) }))} now={NOW} onContinue={onContinue} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('you looked 2m ago · visit before ended 3d ago · waiting on you for 1m')
  })

  it("says it is still reading a row's records, and says so plainly when nothing needs you", () => {
    const list = items([session('fix')], [agent('fix', { state: 'waiting', summary: 'Waiting for your answer.' })])
    const { rerender, unmount } = render(<PickUpList items={list.map((i) => ({ ...i, reading: true }))} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Reading its records…')
    expect(screen.getByRole('listitem')).toHaveTextContent('Last message “Waiting for your answer.”')
    rerender(<PickUpList items={list} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('listitem')).not.toHaveTextContent('Reading its records…')
    unmount()
    render(<PickUpList items={[]} now={NOW} onContinue={() => undefined} onOpen={() => undefined} />)
    expect(screen.getByRole('region', { name: /pick up where you left off/i })).toHaveTextContent('You can leave now: nothing needs you and nothing is new.')
  })

  it('lists the same work in the rail of the work page, marking the one open', () => {
    const onSwitch = vi.fn()
    const list = items([session('fix'), session('other')], [agent('fix', { state: 'waiting', title: 'Fix API retry' }), agent('other', { turnAt: sec(30), title: 'Search eval' })], {}, { fix: brief() })
    render(<PickUpRail items={list} current="fix" onSwitch={onSwitch} />)
    const rail = screen.getByRole('navigation', { name: /work/i })
    expect(within(rail).getByRole('button', { name: /fix api retry/i })).toHaveAttribute('aria-current', 'page')
    expect(within(rail).getByRole('button', { name: /fix api retry/i })).toHaveTextContent('Waiting on you')
    fireEvent.click(within(rail).getByRole('button', { name: /search eval/i }))
    expect(onSwitch).toHaveBeenCalledWith('other')
    cleanup()
    render(<PickUpRail items={[list[1]]} current="fix" open={{ title: 'Fix API retry', members: 3, status: 'Result accepted · merge is still yours' }} others={2} onSwitch={onSwitch} onAll={() => undefined} />)
    const open = within(screen.getByRole('navigation', { name: /work/i })).getByText('Fix API retry').closest('[aria-current]') as HTMLElement
    expect(open).toHaveAttribute('aria-current', 'page')
    expect(open).toHaveTextContent('3 sessions · Result accepted · merge is still yours')
    expect(screen.getByRole('heading', { name: 'Open now' })).toBeInTheDocument()
    expect(screen.getByText('2 other sessions')).toBeInTheDocument()
  })
})


describe('choosing when to return', () => {
  it('keeps a deferred question quiet across visits, then brings it back on a new agent update', () => {
    const s = session('docs')
    const a = agent('docs', { state: 'waiting', waitingFor: 'question', turnAt: sec(60) })
    const deferred = { docs: attentionStamp(a) }
    const items = (seen: number, insight = a) => homeItems([s], new Map([['docs', insight]]), () => seen, NOW, {}, {}, deferred)
    expect(items(0)[0].attention).toBe('later')
    expect(items(NOW / 1000)[0].attention).toBe('later')
    expect(homeItems([s], new Map([['docs', a]]), () => NOW / 1000, NOW, { docs: { draft: false, asking: 0, answered: 0, looked: NOW / 1000 } }, {}, deferred)[0].attention).toBe('later')
    expect(items(0, { ...a, turnAt: sec(1) })[0].attention).toBe('needs')
    expect(homeItems([s], new Map([['docs', a]]), () => 0, NOW, {}, {}, {})[0].attention).toBe('needs')
    const sent = { docs: attentionStamp(a, { draft: false, repair: 'replied', asking: 0, answered: 0 }) }
    expect(homeItems([s], new Map([['docs', a]]), () => 0, NOW, {}, {}, sent, false)[0].attention).toBe('later')
    expect(homeItems([s], new Map([['docs', { ...a, turnAt: sec(1) }]]), () => 0, NOW, {}, {}, sent, false)[0].attention).toBe('needs')
    const held = { docs: { draft: false, repair: 'held' as const, asking: 0, answered: 0 } }
    expect(homeItems([s], new Map([['docs', a]]), () => 0, NOW, held, {}, { docs: attentionStamp(a) })[0].attention).toBe('needs')
    expect(homeItems([s], new Map([['docs', a]]), () => 0, NOW, held, {}, { docs: attentionStamp(a) }, false)[0].attention).toBe('later')
    expect(homeItems([s], new Map([['docs', a]]), () => 0, NOW, {}, {}, sent)[0].attention).toBe('needs')
  })

  it('shows deferred items collapsed and provides an explicit way to bring them back', () => {
    const a = agent('docs', { state: 'waiting' })
    const rows = homeItems([session('docs')], new Map([['docs', a]]), () => 0, NOW, {}, {}, { docs: attentionStamp(a) })
    const later = vi.fn()
    render(<PickUpList items={rows} now={NOW} onContinue={vi.fn()} onOpen={vi.fn()} onLater={later} />)
    const summary = screen.getByText('Later · on this browser')
    expect(summary.closest('details')).not.toHaveAttribute('open')
    fireEvent.click(summary)
    fireEvent.click(screen.getByRole('button', { name: 'Bring back' }))
    expect(later).toHaveBeenCalledWith('docs')
  })
})
