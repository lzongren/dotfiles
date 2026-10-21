import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReturnView } from '../../src/components/ReturnView'
import type { HomeItem } from '../../src/components/work'

vi.mock('../../src/components/Terminal', () => ({
  TerminalPane: ({ name, active }: { name: string; active: boolean }) => <div data-testid={`term-${name}`} data-active={String(active)} />,
}))
import { QUESTION_AFTER_REPLY, QUESTION_CATCH_UP, QUESTION_WAITING, digest, stamp, type Brief } from '../../src/shared/recover'
import type { DraftState, Inquiry, ProbeRecord, ProbeSession, Repair, ReturnResponse, WorkState } from '../../src/shared/types'

const T = Date.parse('2026-10-16T10:00:00Z') / 1000
const rec = (id: string, kind: ProbeRecord['kind'], at: number, text: string, turn: number, final?: boolean): ProbeRecord => ({
  id,
  kind,
  at,
  text,
  turn,
  ...(final === undefined ? {} : { final }),
})

const BASE: ProbeRecord[] = [
  rec('u1', 'decision', T, 'At most 2 attempts, because upstream is rate limiting.', 1),
  rec('a1', 'agent', T + 60, 'Budget done. CI fails.', 1, true),
  rec('u2', 'decision', T + 7200, 'At most 1 attempt instead of 2.', 2),
  rec('f1', 'failure', T + 7300, 'FAIL retry.test.ts', 2),
  rec('a2', 'agent', T + 7400, 'One test still fails.', 2, true),
]

function fix(records = BASE, status = 'idle'): ProbeSession {
  return {
    name: 'fix',
    pane: '%1',
    cmd: 'claude',
    agent: 'claude',
    path: '/work/api',
    repo: '/work/api',
    branch: 'fix/retry',
    registry: { sessionId: 's1', status },
    transcript: { ino: 1, size: 1, last: records.at(-1)?.id ?? '' },
    records,
  }
}

const tests = (): ProbeSession => ({ name: 'tests', pane: '%3', cmd: 'zsh', agent: 'shell', path: '/work/api', repo: '/work/api', branch: 'fix/retry', records: [rec('shell:%3:x', 'shell', T + 7500, '$ npm test\nFAIL', 0)] })

let response: ReturnResponse
let posts: Array<{ url: string; body: Record<string, unknown> }>
let replies: Record<string, { status: number; body: unknown }>

function state(extra: Partial<WorkState> = {}): WorkState {
  return { key: 'session:fix', draft: null, draftVersion: '', repairs: [], inquiries: [], decisions: {}, separations: [], seenAt: T + 3600, ...extra }
}

function respond(extra: Partial<ReturnResponse> = {}) {
  response = {
    session: 'fix',
    host: 'dev',
    fetchedAt: Date.now(),
    work: { key: 'branch:/work/api@fix/retry', members: [{ name: 'fix', reason: 'same branch fix/retry in api' }] },
    sessions: [fix()],
    state: state(),
    separated: [],
    lookalikes: [],
    ...extra,
  }
}

const currentBasis = [{ key: 'attempts|max', value: 1, recordId: 'u2' }]
const draft = (text: string, basis: DraftState['basis'] = currentBasis, extra: Partial<DraftState> = {}): DraftState => ({
  text,
  basis,
  corrections: [],
  earlier: [],
  target: { session: 'fix', pane: '%1', sessionId: 's1' },
  ...extra,
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function show(extra: Partial<ReturnResponse> = {}, props: { onClose?: () => void; onStateChanged?: (regrouped?: boolean, work?: unknown, brief?: Brief) => void } = {}) {
  respond(extra)
  render(<ReturnView session="fix" onClose={props.onClose ?? (() => undefined)} onOpenTerminal={() => undefined} onStateChanged={props.onStateChanged} />)
  await settle()
}

const area = (name: RegExp) => screen.getByRole('region', { name })
const runInfo = () => fireEvent.click(within(screen.getByRole('navigation', { name: 'Records' })).getByRole('button', { name: 'History' }))
const whyTogether = () => fireEvent.click(screen.getByRole('button', { name: 'Why these sessions are together' }))

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(new Date((T + 3 * 86400) * 1000))
  posts = []
  replies = {}
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.startsWith('/api/return?')) return json(response)
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {}
    posts.push({ url, body })
    const route = url.replace('/api/return/', '')
    if (replies[route]) return json(replies[route].body, replies[route].status)
    if (route === 'draft') return json({ version: `v${posts.length}` })
    return json({ ok: true })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  sessionStorage.clear()
})

describe('reading what you came back to', () => {
  it("says a session with no records yet has nothing to recover, and offers its terminal instead of a repair", async () => {
    await show({ sessions: [fix([])], work: { key: 'session:fix', members: [{ name: 'fix', reason: 'only session in this work', goal: 'Try a faster ranker' }] } })
    expect(screen.getByRole('heading', { name: 'Nothing recorded yet' })).toBeInTheDocument()
    expect(screen.getByText(/^Your goal: “Try a faster ranker”\. fix has no records Devbox can read yet\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "Open fix's terminal" })).toHaveClass('primary')
    expect(screen.queryByRole('button', { name: /hand back/i })).toBeNull()
    expect(screen.queryByText(/your last visit/i)).toBeNull()
    expect(screen.queryByRole('heading', { name: /where you left off|where this work stands/i })).toBeNull()
  })

  it('opens on the brief: why, where you stopped, what the agent said since, and what holds now with its sources, then the next step with its evidence', async () => {
    await show({ sessions: [fix([...BASE, rec('a3', 'agent', T + 7500, 'I suggest raising the deadline to 30 seconds.', 2, true)])] })
    const brief = area(/where you left off/i)
    expect(brief).toHaveTextContent(/Why it's this wayNo reason recorded with your decisions\.Stopped atBudget done\. CI fails\.Since you left“One test still fails\.” fix · \S+ agoThe agent suggested “raising the deadline to 30 seconds” · not set by you fix · \S+ agoNot shown: 1 of yoursWhat holds now/)
    expect(brief.querySelector('.holds-list')).toHaveTextContent(/at most 1 attempt changed \S+ agowas at most 2 attempts · No reason recorded/)
    expect(within(brief).getByText(/^replaces the earlier/i).closest('li')).toHaveTextContent('At most 2 attempts, because upstream is rate limiting.')
    expect(brief).toHaveTextContent("One reason isn't recorded: why at most 1 attempt")
    const next = area(/^Check “retry\.test\.ts” failed \S+ ago$/i)
    expect(next).not.toHaveTextContent('The agent said')
    expect(next).toHaveTextContent('Opens an editable draft. Nothing is sent yet.')
    expect(within(next).getByRole('article', { name: 'The failed check' })).toHaveTextContent(/failed check · fix · \S+ agoFAIL retry\.test\.tsOnly tool errors are recorded, not the calls that worked, so it may have passed since\./)
    expect(brief.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(next).getByRole('button', { name: /hand back to the agent to repair/i })).toBeEnabled()
  })

  it('keeps every record, by where you stopped and since you left, under run info', async () => {
    await show()
    runInfo()
    const stopped = area(/where you stopped/i)
    expect(within(stopped).getByText('Budget done. CI fails.')).toBeInTheDocument()
    expect(within(stopped).getByText('At most 2 attempts, because upstream is rate limiting.')).toBeInTheDocument()
    const since = area(/since you left/i)
    expect(within(since).getByText('At most 1 attempt instead of 2.')).toBeInTheDocument()
    expect(within(since).getByText('FAIL retry.test.ts')).toBeInTheDocument()
    expect(within(since).getByText('One test still fails.')).toBeInTheDocument()
    expect(within(since).getByText(/^failed check/i)).toBeInTheDocument()
  })

  it("lists what the work's agents named and wrote under results and evidence", async () => {
    respond({ sessions: [fix(), tests()], work: { key: 'branch:/work/api@fix/retry', members: [{ name: 'fix', reason: '' }, { name: 'tests', reason: '' }] } })
    const insights = new Map([
      ['fix', { session: 'fix', agent: 'claude' as const, state: 'ready' as const, commits: 0, artifacts: [{ label: 'PR', url: 'https://github.com/o/r/pull/184', at: T, first: T, hits: 2, said: true }], files: [{ path: '/work/api/plan.md', action: 'created' as const, at: T, count: 1, gone: false }] }],
    ])
    render(<ReturnView session="fix" insights={insights} onClose={() => undefined} onOpenTerminal={() => undefined} />)
    await settle()
    const tabs = within(screen.getByRole('navigation', { name: 'Records' }))
    expect(tabs.getByRole('button', { name: /Results & evidence/ })).toHaveTextContent('Results & evidence3')
    const panel = area(/results and evidence/i)
    expect(within(panel).getByText(/^failed check/i).closest('li')).toHaveTextContent('FAIL retry.test.ts')
    expect(within(panel).getByRole('link', { name: /PR #184/ })).toHaveAttribute('href', 'https://github.com/o/r/pull/184')
    expect(within(panel).getByRole('button', { name: 'plan.md' })).toBeInTheDocument()
  })

  it('says that tool errors are listed without the calls that worked', async () => {
    await show()
    runInfo()
    expect(within(area(/since you left/i)).getByText(/only tool errors are listed, not the tool calls that worked/i)).toBeInTheDocument()
  })

  it('says how Devbox reads constraints and that it might miss other wording', async () => {
    await show()
    runInfo()
    expect(screen.getByText(/how devbox reads constraints/i).closest('details')).toHaveTextContent(/worded differently might be missing/i)
  })

  it('shows two values without a replacement as undecided, and records your choice for this work', async () => {
    await show({ sessions: [fix([rec('w1', 'decision', T, 'Use at most 4 workers.', 1), rec('w2', 'decision', T + 60, 'Use at most 8 workers.', 2)])] })
    const undecided = area(/undecided workers/i)
    expect(within(undecided).getByText(/neither says it replaces the other/i)).toBeInTheDocument()
    fireEvent.click(within(undecided).getByRole('button', { name: 'Use at most 4 workers for this work' }))
    await settle()
    expect(posts).toContainEqual({ url: '/api/return/decide', body: { session: 'fix', key: 'workers|max', limitId: 'w1#0' } })
  })

  it('swaps an untouched question for the undecided check when you ask which value applies', async () => {
    await show({ sessions: [fix([rec('w1', 'decision', T, 'Use at most 4 workers.', 1), rec('w2', 'decision', T + 60, 'Use at most 8 workers.', 2)])] })
    fireEvent.click(screen.getByRole('button', { name: /ask first \(read-only\)/i }))
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
    fireEvent.click(within(area(/undecided workers/i)).getByRole('button', { name: /ask which applies/i }))
    expect((screen.getByRole('textbox', { name: /your question/i }) as HTMLTextAreaElement).value).toMatch(/^Using only these records, check which workers value applies/)
  })

  it('lists the sessions in this work with the reason and the goal you started one with, and can show one separately and undo it', async () => {
    await show({ work: { key: 'branch:/work/api@fix/retry', members: [{ name: 'fix', reason: 'same branch fix/retry in api' }, { name: 'tests', reason: 'same branch fix/retry in api', goal: 'Add boundary tests for the budget' }] }, sessions: [fix(), tests()] })
    whyTogether()
    const work = area(/in this work/i)
    expect(within(work).getByText('tests').closest('li')).toHaveTextContent('same branch fix/retry in api')
    expect(within(work).getByText('tests').closest('li')).toHaveTextContent('Your goal when you started it: “Add boundary tests for the budget”')
    fireEvent.click(within(work).getByRole('button', { name: 'Show tests separately' }))
    await settle()
    expect(posts).toContainEqual({ url: '/api/return/separate', body: { session: 'fix', work: 'branch:/work/api@fix/retry', member: 'tests', undo: false } })
    respond({ separated: [{ work: 'branch:/work/api@fix/retry', session: 'tests' }] })
    await settle(15000)
    expect(within(area(/kept separate/i)).getByText('tests').closest('li')).toHaveTextContent('tests · you showed it separately Undo')
    expect(screen.getByText(/1 you showed separately/)).toBeInTheDocument()
    fireEvent.click(within(area(/kept separate/i)).getByRole('button', { name: 'Undo: show tests in this work again' }))
    await settle()
    expect(posts).toContainEqual({ url: '/api/return/separate', body: { session: 'fix', work: 'branch:/work/api@fix/retry', member: 'tests', undo: true } })
  })

  it('tells the page around it which sessions the work holds each time it reads them', async () => {
    const changed = vi.fn()
    respond({ work: { key: 'branch:/work/api@fix/retry', members: [{ name: 'fix', reason: '' }, { name: 'tests', reason: 'same branch' }] }, sessions: [fix(), tests()] })
    render(<ReturnView session="fix" onClose={() => undefined} onOpenTerminal={() => undefined} onStateChanged={changed} />)
    await settle()
    expect(changed).toHaveBeenLastCalledWith(false, expect.objectContaining({ members: [expect.objectContaining({ name: 'fix' }), expect.objectContaining({ name: 'tests' })] }), expect.objectContaining({ rules: [] }))
    respond({ work: { key: 'session:fix', members: [{ name: 'fix', reason: '' }] }, separated: [{ work: 'branch:/work/api@fix/retry', session: 'tests' }] })
    whyTogether()
    fireEvent.click(within(area(/in this work/i)).getByRole('button', { name: 'Show tests separately' }))
    await settle()
    expect(changed).toHaveBeenCalledWith(false, expect.objectContaining({ key: 'session:fix' }), expect.anything())
    expect(changed).toHaveBeenLastCalledWith(true)
  })

  it('names the session of a constraint that came from another session in this work', async () => {
    const other: ProbeSession = { ...fix([rec('t1', 'decision', T + 7600, 'Only touch files under test/.', 1)]), name: 'tests', pane: '%4' }
    await show({ sessions: [fix(), other] })
    expect(within(area(/where you left off/i)).getByText('Only touch files under test/.', { selector: 'blockquote' }).closest('li')).toHaveTextContent(/you in tests/i)
  })

  it('stops asking the host while hidden behind a terminal, and catches up when shown again', async () => {
    respond()
    let gets = 0
    const real = fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/return?')) gets++
      return real(url, init)
    })
    const view = render(<ReturnView session="fix" active={false} onClose={() => undefined} onOpenTerminal={() => undefined} />)
    await settle()
    await settle(60000)
    expect(gets).toBe(1)
    view.rerender(<ReturnView session="fix" active onClose={() => undefined} onOpenTerminal={() => undefined} />)
    await settle()
    expect(gets).toBe(2)
  })

  it("quotes this session's rules unless you untick them, and another session's only if you tick them", async () => {
    const other: ProbeSession = { ...fix([rec('t1', 'decision', T + 7600, 'Only touch files under test/.', 1)]), name: 'tests', pane: '%4' }
    await show({ sessions: [fix([...BASE, rec('u3', 'decision', T + 7700, "Don't edit anything yet. Never commit.", 3)]), other], state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    const basis = area(/added to the message/i)
    expect(basis).toHaveTextContent(/Limit\s*at most 1 attempt\s*Rules\s*Don't edit anything yet\s*Never commit\s*Change which rules go with it/)
    const mine = within(basis).getByRole('checkbox', { name: /quote “never commit\.” in the repair/i })
    const noEdit = within(basis).getByRole('checkbox', { name: /quote “don't edit anything yet\.” in the repair/i })
    const theirs = within(basis).getByRole('checkbox', { name: /quote “only touch files under test\/\.” in the repair/i })
    expect(mine).toBeChecked()
    expect(noEdit).toBeChecked()
    expect(theirs).not.toBeChecked()
    fireEvent.click(noEdit)
    fireEvent.click(theirs)
    expect(basis).toHaveTextContent(/Limit\s*at most 1 attempt\s*Rules\s*Only touch files under test\/\s*Never commit/)
    fireEvent.click(screen.getByText(/the full message, as the agent gets it/i))
    const preview = screen.getByText(/the full message, as the agent gets it/i).closest('details')
    expect(preview).toHaveTextContent('Never commit.')
    expect(preview).not.toHaveTextContent("Don't edit anything yet.")
    expect(preview).toHaveTextContent('Rule (you in tests')
    await settle(600)
    expect((posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft as DraftState).quote).toEqual({ "u3|Don't edit anything yet.": false, 't1|Only touch files under test/.': true })
    fireEvent.click(theirs)
    await settle(600)
    expect((posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft as DraftState).quote).toEqual({ "u3|Don't edit anything yet.": false, 't1|Only touch files under test/.': false })
  })

  it('puts the failure, its result and the action under the brief, which marks your rule that shares the check\'s wording', async () => {
    await show({ sessions: [fix([rec('u0', 'decision', T + 100, 'Keep the 10 second total deadline and retry only idempotent requests.', 1), ...BASE, rec('s1', 'shell', T + 7420, '$ npm test', 2), rec('f2', 'failure', T + 7450, 'FAIL keeps total deadline\nExpected ≤ 10000ms · Received 12641ms', 2)])] })
    const next = area(/^Check “keeps total deadline” failed \S+ ago$/i)
    expect(next.querySelector('.next-lead')).toHaveTextContent(/^12\.6 s, limit 10 s$/)
    const brief = area(/where you left off/i)
    expect(brief.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(brief.querySelector('.holds-list')).toHaveTextContent('Keep the 10 second total deadline and retry only idempotent requests failing checkno reason recorded')
    expect(brief).toHaveTextContent(/Since you left“One test still fails\.” fix · \S+ agoNot shown: 1 of yours, 1 failed check, 1 shell lineWhat holds/)
    fireEvent.click(within(brief).getByRole('button', { name: 'Not shown: 1 of yours, 1 failed check, 1 shell line' }))
    expect(brief).toHaveTextContent(/Shown below: 1 of yours, 1 failed check, 1 shell line · hideyou “At most 1 attempt instead of 2\.” fix · \S+ agofailed check “FAIL retry\.test\.ts”/)
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    expect(screen.getByText('Keep the 10 second total deadline and retry only idempotent requests.', { selector: '.acceptance-list span' }).closest('li')).toHaveTextContent('failing check · not checked by Devbox')
  })

  it("lists every rule under what holds with the rest of its sentence, and lifts an agent suggestion that names your rule's amount beside the next step, once, without claiming a conflict", async () => {
    await show({ sessions: [fix([rec('u0', 'decision', T + 100, "Don't raise it to 30 seconds: callers can't wait longer.", 1), ...BASE, rec('a3', 'agent', T + 7500, 'Total deadline still fails. I suggest raising the deadline to 30 seconds.', 2, true)])] })
    const brief = area(/where you left off/i)
    expect(brief.querySelector('.holds-list')).toHaveTextContent("Don't raise it to 30 seconds named in an agent suggestioncallers can't wait longer")
    expect(brief.querySelector('.holds-list')).not.toHaveTextContent('raising')
    expect(brief).toHaveTextContent(/Since you left“One test still fails\.” fix · \S+ ago“Total deadline still fails\.” fix · \S+ agoNot shown: 1 of yoursWhat holds/)
    expect(area(/^Check /)).toHaveTextContent(/The agent suggested “raising the deadline to 30 seconds” \S+ ago · your rule: “Don't raise it to 30 seconds”/)
    expect(document.body).not.toHaveTextContent('against')
    fireEvent.click(screen.getByRole('button', { name: /result & acceptance/i }))
    expect(area(/where you left off/i)).toHaveTextContent(/Since you leftThe agent suggested “raising the deadline to 30 seconds” · your rule: “Don't raise it to 30 seconds” \S+ ago/)
  })

  it('says what you last told this session, unless What holds already quotes it', async () => {
    await show()
    expect(area(/where you left off/i).querySelector('.brief-facts')).not.toHaveTextContent('You last said')
    cleanup()
    await show({ sessions: [fix([...BASE, rec('u3', 'decision', T + 7450, 'Look at the budget reset first. Never merge the PR without asking me.', 2)])] })
    expect(area(/where you left off/i).querySelector('.brief-facts')).toHaveTextContent(/You last said“Look at the budget reset first\.” \S+ ago/)
    expect(area(/where you left off/i).querySelector('.brief-facts')).not.toHaveTextContent('Never merge')
  })

  it('names the check a sent failure repair was for, from the repair it kept', async () => {
    const sent = '[devbox repair r-1]\nPurpose: repair.\nTarget: this session, fix.\n\nDecision: find and fix why the recorded failure quoted below fails, then rerun the checks that cover it.\n\nWhat this is based on, quoted from this conversation:\n- Rule'
    const out: Repair = { id: 'r-1', packet: sent, target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 7460, state: 'delivered', check: 'retry.test.ts' }
    await show({ sessions: [fix([...BASE, rec('d1', 'devbox', T + 7460, sent, 3)])], state: state({ repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Changes & next step' }))
    expect(area(/where you left off/i).querySelector('.brief-facts')).toHaveTextContent('You sent“Decision: find and fix why ‘retry.test.ts’ fails, then rerun the checks that cover it.”')
  })

  it('says what you last sent from Devbox, newer than what you last said, by its main line', async () => {
    const sent = '[devbox repair r-1]\nPurpose: repair.\nTarget: this session, fix.\n\n- Make the budget per request.\n\nWhat this is based on, quoted from this conversation:\n- Rule'
    await show({ sessions: [fix([...BASE, rec('u3', 'decision', T + 7450, 'Look at the budget reset first.', 2), rec('d1', 'devbox', T + 7460, sent, 3)])] })
    expect(area(/where you left off/i).querySelector('.brief-facts')).toHaveTextContent(/You sent“Make the budget per request\.” \S+ ago/)
    expect(area(/where you left off/i)).toHaveTextContent('Not shown: 2 of yours')
  })

  it('keeps a suggestion the agent made before you left out of since you left and the next step', async () => {
    await show({ sessions: [fix([rec('u0', 'decision', T - 60, "Don't raise it to 30 seconds.", 1), BASE[0], rec('a0', 'agent', T + 30, 'I suggest raising the deadline to 30 seconds.', 1, true), ...BASE.slice(1)])] })
    expect(area(/where you left off/i)).not.toHaveTextContent('The agent suggested')
    expect(area(/^Check /)).not.toHaveTextContent('The agent suggested')
    expect(area(/where you left off/i).querySelector('.holds-list')).not.toHaveTextContent('named in an agent suggestion')
  })

  it('does not count a message as not shown when the next step already states its suggestion', async () => {
    await show({ sessions: [fix([rec('u0', 'decision', T + 100, "Don't raise it to 30 seconds.", 1), ...BASE, rec('a3', 'agent', T + 7500, 'I suggest raising the deadline to 30 seconds.', 2, true)])] })
    expect(area(/^Check /)).toHaveTextContent('· your rule: “Don\'t raise it to 30 seconds”')
    expect(area(/where you left off/i)).toHaveTextContent(/Not shown: 1 of yoursWhy|Not shown: 1 of yoursWhat holds/)
  })

  it('says when a ticked other-session message is no longer in the records', async () => {
    const review = { ...fix([rec('c2', 'agent', T + 7450, 'Kept finding.', 1, true)]), name: 'review', pane: '%2', agent: 'codex' as const, registry: undefined }
    await show({
      sessions: [fix(), review],
      work: { key: 'branch:/work/api@fix/retry', members: [{ name: 'fix', reason: 'this session' }, { name: 'review', reason: 'same branch' }] },
      state: state({ draft: draft('Retry at most 1 attempt per request.', currentBasis, { others: ['c2', 'gone'] }), draftVersion: 'v0' }),
    })
    expect(screen.getByRole('checkbox', { name: /add what review said/i }).closest('dd')).toHaveTextContent('1 ticked message no longer in the records, not sent')
    fireEvent.click(screen.getByRole('checkbox', { name: /add what review said/i }))
    await settle(600)
    expect((posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft as DraftState).others).toEqual(['gone'])
    fireEvent.click(screen.getByRole('button', { name: /forget it/i }))
    await settle(600)
    expect((posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft as DraftState).others).toEqual([])
  })

  it('counts lost ticked messages toward the 20, keeps them, and asks the send to quote only the ones listed', async () => {
    const said = Array.from({ length: 3 }, (_, i) => rec(`c${i}`, 'agent', T + 7410 + i, `Finding ${i}.`, 1, true))
    const review = { ...fix(said), name: 'review', pane: '%2', agent: 'codex' as const, registry: undefined }
    const lost = Array.from({ length: 18 }, (_, i) => `gone${i}`)
    await show({
      sessions: [fix(), review],
      work: { key: 'branch:/work/api@fix/retry', members: [{ name: 'fix', reason: 'this session' }, { name: 'review', reason: 'same branch' }] },
      state: state({ draft: draft('Retry at most 1 attempt per request.', currentBasis, { others: [...lost, 'c0', 'c1'] }), draftVersion: 'v0' }),
    })
    expect(screen.getAllByRole('checkbox', { name: /add what review said/i }).map((x) => [(x as HTMLInputElement).checked, (x as HTMLInputElement).disabled])).toEqual([[true, false], [true, false], [false, true]])
    replies.repair = { status: 202, body: { repair: { id: 'r-x', state: 'sending' } } }
    fireEvent.click(screen.getByRole('button', { name: /send repair to session fix/i }))
    await settle()
    expect(document.querySelector('.return-draft pre')).toHaveTextContent('"Finding 0."')
    expect(posts.find((p) => p.url === '/api/return/repair')?.body.preview).toBe(digest(document.querySelector('.return-draft pre')?.textContent ?? ''))
    expect(posts.some((p) => p.url === '/api/return/draft')).toBe(false)
  })

  it('takes up the ticks saved from another tab when a send is refused because the quotes changed', async () => {
    const review = { ...fix([rec('c0', 'agent', T + 7410, 'First finding.', 1, true), rec('c1', 'agent', T + 7420, 'Second finding.', 1, true)]), name: 'review', pane: '%2', agent: 'codex' as const, registry: undefined }
    const work = { key: 'branch:/work/api@fix/retry', members: [{ name: 'fix', reason: 'this session' }, { name: 'review', reason: 'same branch' }] }
    const ticked = (others: string[]) => ({ sessions: [fix(), review], work, state: state({ draft: draft('Retry at most 1 attempt per request.', currentBasis, { others }), draftVersion: 'v0' }) })
    await show(ticked(['c0']))
    respond(ticked(['c1']))
    replies.repair = { status: 409, body: { error: 'preview_changed' } }
    fireEvent.click(screen.getByRole('button', { name: /send repair to session fix/i }))
    await settle()
    expect(screen.getAllByRole('checkbox', { name: /add what review said/i }).map((x) => (x as HTMLInputElement).checked)).toEqual([false, true])
  })

  it('keeps a tick you change while the refused send reloads the draft', async () => {
    const review = { ...fix([rec('c0', 'agent', T + 7410, 'First finding.', 1, true), rec('c1', 'agent', T + 7420, 'Second finding.', 1, true)]), name: 'review', pane: '%2', agent: 'codex' as const, registry: undefined }
    const work = { key: 'branch:/work/api@fix/retry', members: [{ name: 'fix', reason: 'this session' }, { name: 'review', reason: 'same branch' }] }
    const ticked = (others: string[]) => ({ sessions: [fix(), review], work, state: state({ draft: draft('Retry at most 1 attempt per request.', currentBasis, { others }), draftVersion: 'v0' }) })
    await show(ticked(['c0']))
    respond(ticked(['c1']))
    const served = globalThis.fetch
    let release = () => undefined as void
    const gate = new Promise<void>((r) => (release = r))
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/return?')) await gate
      return served(url, init)
    })
    replies.repair = { status: 409, body: { error: 'preview_changed' } }
    fireEvent.click(screen.getByRole('button', { name: /send repair to session fix/i }))
    await settle()
    expect(screen.getByRole('button', { name: /send repair to session fix/i })).toBeDisabled()
    fireEvent.click(screen.getAllByRole('checkbox', { name: /add what review said/i })[0])
    release()
    await settle()
    expect(screen.getAllByRole('checkbox', { name: /add what review said/i }).map((x) => (x as HTMLInputElement).checked)).toEqual([false, false])
  })

  it('asks you to reload when the server does not recognise what this page sent', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    replies.repair = { status: 400, body: { error: 'bad_seen' } }
    fireEvent.click(screen.getByRole('button', { name: /send repair to session fix/i }))
    await settle()
    expect(document.querySelector('.return-notice')).toHaveTextContent('Not sent: this page is out of date, so reload it.')
  })

  it('shows the draft saved in another tab when the send is refused because the draft moved on', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    respond({ state: state({ draft: draft('Retry once, then stop.'), draftVersion: 'v9' }) })
    replies.repair = { status: 409, body: { error: 'draft_moved' } }
    fireEvent.click(screen.getByRole('button', { name: /send repair to session fix/i }))
    await settle()
    expect(screen.getByRole('textbox', { name: /repair draft/i })).toHaveValue('Retry once, then stop.')
    expect(document.querySelector('.return-notice')).toHaveTextContent('Not sent: the draft changed in another tab, so the saved version is shown.')
  })

  it('shows the rest of a rule split at a spaced hyphen without the hyphen, keeping a sign', async () => {
    await show({ sessions: [fix([rec('u0', 'decision', T + 100, 'Never raise it to 30 s - the API rate-limits us. Never set retries to 3, -1 means unlimited.', 1), ...BASE])] })
    expect([...area(/where you left off/i).querySelectorAll('.holds-list small')].map((x) => x.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/^the API rate-limits us · you, Oct /), expect.stringMatching(/^-1 means unlimited · you, Oct /)]))
  })

  it('pairs a suggestion with your rule on a first visit, when you never left', async () => {
    await show({ sessions: [fix([rec('u0', 'decision', T + 100, "Don't raise it to 30 seconds.", 1), ...BASE, rec('a3', 'agent', T + 7500, 'I suggest raising the deadline to 30 seconds.', 2, true)])], state: state({ seenAt: undefined }) })
    expect(area(/^Check /)).toHaveTextContent("· your rule: “Don't raise it to 30 seconds”")
    expect(area(/where this work stands/i)).not.toHaveTextContent('Since you left')
  })

  it('takes up the stored draft when a retry is refused because the draft changed', async () => {
    const failed: Repair = { id: 'r-keep', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T, state: 'held', reason: 'busy' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [failed] }) })
    respond({ state: state({ draft: draft('Retry once, then stop.'), draftVersion: 'v9', repairs: [failed] }) })
    replies.repair = { status: 409, body: { error: 'draft_changed' } }
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await settle()
    expect(screen.getByRole('textbox', { name: /repair draft/i })).toHaveValue('Retry once, then stop.')
  })

  it('says when the send was refused because the other-session messages changed', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    replies.repair = { status: 409, body: { error: 'preview_changed' } }
    fireEvent.click(screen.getByRole('button', { name: /send repair to session fix/i }))
    await settle()
    expect(document.querySelector('.return-notice')).toHaveTextContent(/^Not sent: what would be sent changed since you looked, in the records or another tab\.$/)
  })

  it('still names lost ticked messages when no other-session message is left to list', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.', currentBasis, { others: ['gone'] }), draftVersion: 'v0' }) })
    expect(area(/added to the message/i)).toHaveTextContent('Other sessions1 ticked message no longer in the records, not sent')
  })

  it('keeps an untick-all across hand-backs on an emptied draft', async () => {
    const review = { ...fix([rec('c2', 'agent', T + 7450, 'A finding.', 1, true)]), name: 'review', pane: '%2', agent: 'codex' as const, registry: undefined }
    await show({ sessions: [fix(), review], work: { key: 'branch:/work/api@fix/retry', members: [{ name: 'fix', reason: 'this session' }, { name: 'review', reason: 'same branch' }] } })
    fireEvent.click(screen.getByRole('button', { name: /hand back to the agent to repair/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /add what review said/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /add what review said/i }))
    fireEvent.change(screen.getByRole('textbox', { name: /repair draft/i }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /back \(keeps the draft\)/i }))
    fireEvent.click(screen.getByRole('button', { name: /hand back to the agent to repair/i }))
    fireEvent.change(screen.getByRole('textbox', { name: /repair draft/i }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /back \(keeps the draft\)/i }))
    fireEvent.click(screen.getByRole('button', { name: /hand back to the agent to repair/i }))
    expect(screen.getByRole('checkbox', { name: /add what review said/i })).not.toBeChecked()
  })

  it('names sessions that only look related, and why they are not in this work', async () => {
    await show({ lookalikes: [{ name: 'billing', path: '/other/api', repo: '/other/api', branch: 'fix/retry', why: 'branch' }] })
    whyTogether()
    expect(within(area(/kept separate/i)).getByText(/billing/).closest('li')).toHaveTextContent(/not in this work.*different repository/i)
    expect(within(area(/in this work/i)).queryByText(/billing/)).toBeNull()
  })

  it('shows the work you came back to in a rail, and switches to another', async () => {
    respond()
    const onSwitch = vi.fn()
    const item = (name: string, title: string) => ({
      session: { name, attached: false, clients: 0, activityEpoch: T, bell: false, cmd: 'claude', title: '', path: '/work/api', attachable: true },
      insight: { session: name, agent: 'claude' as const, state: 'waiting' as const, title, artifacts: [], commits: 0 },
      attention: 'needs' as const,
      tone: 'waiting' as const,
      status: 'Waiting on you',
      action: 'Continue this',
    })
    render(<ReturnView session="fix" title="Fix API retry" works={[item('fix', 'Fix API retry'), item('search', 'Search eval')]} onSwitch={onSwitch} onClose={() => undefined} onOpenTerminal={() => undefined} />)
    await settle()
    expect(screen.getByRole('heading', { name: 'Fix API retry', level: 2 })).toBeInTheDocument()
    const rail = screen.getByRole('navigation', { name: 'Work' })
    expect(within(rail).getByRole('button', { name: /fix api retry/i })).toHaveAttribute('aria-current', 'page')
    expect(within(rail).getByRole('button', { name: /fix api retry/i })).toHaveTextContent('Check failed')
    fireEvent.click(within(rail).getByRole('button', { name: /search eval/i }))
    await settle()
    expect(posts.map((p) => p.url)).toContain('/api/return/seen')
    expect(onSwitch).toHaveBeenCalledWith('search', ['fix'], true)
    cleanup()
    respond({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    render(<ReturnView session="fix" title="Fix API retry" works={[item('fix', 'Fix API retry')]} onSwitch={onSwitch} onClose={() => undefined} onOpenTerminal={() => undefined} />)
    await settle()
    expect(within(screen.getByRole('navigation', { name: 'Work' })).getByRole('button', { name: /fix api retry/i })).toHaveTextContent('Draft not sent')
  })

  it('says to choose the other work again when the draft could not be saved', async () => {
    respond({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    replies.draft = { status: 500, body: { error: 'return_failed' } }
    const onSwitch = vi.fn()
    const item = (name: string, title: string) => ({
      session: { name, attached: false, clients: 0, activityEpoch: T, bell: false, cmd: 'claude', title: '', path: '/work/api', attachable: true },
      insight: { session: name, agent: 'claude' as const, state: 'ready' as const, title, artifacts: [], commits: 0 },
      attention: 'needs' as const,
      tone: 'waiting' as const,
      status: 'Waiting on you',
      action: 'Continue this',
    })
    const onClose = vi.fn()
    render(<ReturnView session="fix" works={[item('fix', 'Fix API retry'), item('search', 'Search eval')]} onSwitch={onSwitch} onClose={onClose} onOpenTerminal={() => undefined} />)
    await settle()
    expect(within(screen.getByRole('navigation', { name: 'Work' })).getByRole('button', { name: /fix api retry/i })).toHaveTextContent('Draft not sent')
    fireEvent.change(screen.getByRole('textbox', { name: /repair draft/i }), { target: { value: 'Retry at most 1 attempt per request.\nLog it.' } })
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Work' })).getByRole('button', { name: /search eval/i }))
    await settle()
    expect(onSwitch).not.toHaveBeenCalled()
    expect(screen.getByText("Your last edit isn't saved yet. Choose it again to leave without it.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText("Your last edit isn't saved yet. Go back again to leave without it.")).toBeInTheDocument()
  })

  it('shows a banner while a sent repair is on its way, and opens on its receipt', async () => {
    const out: Repair = { id: 'r-1', packet: '[devbox repair r-1]\nRetry at most 1 attempt.', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T, state: 'delivered' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [out] }) })
    expect(screen.queryByText('Repair delivered to fix')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Handed back to session fix' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Handoff receipt' })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByText(/see exactly what was sent/i))
    expect(screen.getByText(/see exactly what was sent/i).closest('details')).toHaveTextContent('[devbox repair r-1]')
    fireEvent.click(screen.getByRole('button', { name: 'Changes & next step' }))
    expect(screen.getByRole('button', { name: /see the handoff receipt/i })).toBeInTheDocument()
    expect(screen.getByText('Repair delivered to fix')).toBeInTheDocument()
    cleanup()
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [{ ...out, target: { ...out.target, sessionId: 's0' } }] }) })
    expect(screen.queryByText('Repair delivered to fix')).not.toBeInTheDocument()
  })

  it('asks before dropping an unsaved edit even when you click back twice quickly', async () => {
    const onClose = vi.fn()
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) }, { onClose })
    replies.draft = { status: 500, body: { error: 'return_failed' } }
    fireEvent.change(screen.getByRole('textbox', { name: /repair draft/i }), { target: { value: 'Retry at most 1 attempt per request.\nLog it.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText("Your last edit isn't saved yet. Go back again to leave without it.")).toBeInTheDocument()
  })

  it('leaves once even when you click back again while it records the visit', async () => {
    const onClose = vi.fn()
    await show({}, { onClose })
    const original = globalThis.fetch
    const waiting: Array<() => void> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => (url === '/api/return/seen' ? new Promise<Response>((done) => waiting.push(() => done(json({ ok: true })))) : original(url, init)))
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await settle()
    for (const release of waiting) release()
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('counts since you left from your last recorded visit, not a later overview mark', async () => {
    respond()
    const { rerender } = render(<ReturnView session="fix" left={T} onClose={() => undefined} onOpenTerminal={() => undefined} />)
    await settle()
    runInfo()
    expect(within(area(/where you stopped/i)).getByText('Budget done. CI fails.')).toBeInTheDocument()
    rerender(<ReturnView session="fix" left={T + 9000} onClose={() => undefined} onOpenTerminal={() => undefined} />)
    expect(within(area(/where you stopped/i)).getByText('Budget done. CI fails.')).toBeInTheDocument()
  })

  it('records your visit when you go back', async () => {
    const onClose = vi.fn()
    await show({}, { onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await settle()
    expect(posts.map((p) => p.url)).toContain('/api/return/seen')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('the repair draft', () => {
  const sendButton = () => screen.getByRole('button', { name: /send repair to session fix/i })
  const editor = () => screen.getByRole('textbox', { name: /repair draft/i })

  it('flags a line whose limit differs from what holds now, and blocks only the send', async () => {
    await show({ state: state({ draft: draft('Fix the loop.\nRetry at most 2 attempts per request.'), draftVersion: 'v0' }) })
    expect(screen.getByText(/line 2 says at most 2 attempts; at most 1 attempt holds now/i)).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    expect(editor()).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /ask first \(read-only\)/i })).toBeEnabled()
  })

  it('changes only that line, and undoes it while keeping later edits', async () => {
    await show({ state: state({ draft: draft('Fix the loop.\nRetry at most 2 attempts per request.'), draftVersion: 'v0' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Change line 2 to at most 1 attempt' }))
    expect(editor()).toHaveValue('Fix the loop.\nRetry at most 1 attempt per request.')
    fireEvent.change(editor(), { target: { value: 'Fix the loop.\nRetry at most 1 attempt per request.\nAdd a test.' } })
    fireEvent.click(screen.getByRole('button', { name: /undo the change to line 2/i }))
    expect(editor()).toHaveValue('Fix the loop.\nRetry at most 2 attempts per request.\nAdd a test.')
    await settle(600)
    const saves = posts.filter((p) => p.url === '/api/return/draft')
    expect((saves.at(-1)?.body.draft as DraftState).text).toBe('Fix the loop.\nRetry at most 2 attempts per request.\nAdd a test.')
  })

  it('drops the undo of a change once you edit that line again', async () => {
    await show({ state: state({ draft: draft('Fix the loop.\nRetry at most 2 attempts per request.'), draftVersion: 'v0' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Change line 2 to at most 1 attempt' }))
    fireEvent.change(editor(), { target: { value: 'Fix the loop.\nRetry at most 1 attempt per call.' } })
    expect(screen.queryByRole('button', { name: /undo the change/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/^Changed “/)).not.toBeInTheDocument()
  })

  it('hands back from a reply as a follow-up to the sent draft', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: 'Done.', replyId: 'a9' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    fireEvent.click(screen.getByRole('button', { name: /hand back to the agent to repair/i }))
    expect(editor()).toHaveValue('Retry at most 1 attempt per request.')
    expect(screen.getByText(/already sent/i)).toBeInTheDocument()
  })

  it('starts a follow-up on a sent draft with nothing kept, and keeps what you keep in it as you type', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: 'Done.', replyId: 'a9' }
    await show({ state: state({ draft: { ...draft('Fix it.\nThe old code tried at most 2 attempts.'), earlier: ['The old code tried at most 2 attempts.'] }, draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    fireEvent.click(screen.getByRole('button', { name: /hand back to the agent to repair/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep line 2 as an earlier comparison' }))
    fireEvent.change(editor(), { target: { value: 'Fix it now.\nThe old code tried at most 2 attempts.' } })
    expect(screen.queryByText(/line 2 says/i)).not.toBeInTheDocument()
    await settle(600)
    const saved = posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft as DraftState
    expect(saved.earlier).toEqual(['The old code tried at most 2 attempts.'])
    expect(sendButton()).toBeEnabled()
  })

  it('keeps what you chose in a follow-up when you open it again', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: 'Done.', replyId: 'a9' }
    await show({ state: state({ draft: { ...draft('Fix it.\nThe old code tried at most 2 attempts.'), earlier: ['The old code tried at most 2 attempts.'] }, draftVersion: 'v0', repairs: [out] }) })
    replies.draft = { status: 200, body: { version: 'v0' } }
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    fireEvent.click(screen.getByRole('button', { name: /hand back to the agent to repair/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep line 2 as an earlier comparison' }))
    await settle(600)
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    fireEvent.click(screen.getByRole('button', { name: /continue the unsent draft/i }))
    expect(screen.queryByText(/line 2 says/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo keeping line 2 as an earlier comparison' })).toBeInTheDocument()
  })

  it('picks up a follow-up started before, without clearing what was chosen in it', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: 'Done.', replyId: 'a9' }
    await show({ state: state({ draft: { ...draft('Fix it.\nThe old code tried at most 2 attempts.'), earlier: ['The old code tried at most 2 attempts.'], follows: T + 9000 }, draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    fireEvent.click(screen.getByRole('button', { name: /continue the unsent draft/i }))
    expect(screen.getByRole('button', { name: 'Undo keeping line 2 as an earlier comparison' })).toBeInTheDocument()
    await settle(600)
    expect(posts.some((p) => p.url === '/api/return/draft')).toBe(false)
  })

  it('stays on a follow-up whose text goes back to an earlier sent repair', async () => {
    const first: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v1', sentAt: T + 9000, state: 'replied', reply: 'Done.', replyId: 'a9' }
    const second: Repair = { ...first, id: 'r-2', draftVersion: 'v2', sentAt: T + 9500, replyId: 'a10' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.\nAlso log each retry.'), draftVersion: 'v2', repairs: [first, second] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    fireEvent.click(screen.getByRole('button', { name: /hand back to the agent to repair/i }))
    replies.draft = { status: 200, body: { version: 'v1' } }
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.' } })
    await settle(600)
    expect(editor()).toHaveValue('Retry at most 1 attempt per request.')
    expect(screen.getByText(/already sent/i)).toBeInTheDocument()
  })

  it('does not offer to try an older repair again once a newer one went out', async () => {
    const older: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'held', reason: 'prompt_changed' }
    const newer: Repair = { ...older, id: 'r-2', draftVersion: 'v1', sentAt: T + 9500, state: 'delivered', reason: undefined }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [older, newer] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    expect(screen.getAllByText(/not submitted/i).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    expect(screen.getByText("r-2 went out after it, so Devbox won't try this one again. If it is still in fix's prompt, clear it there.")).toBeInTheDocument()
  })

  it('does not ask to clear a prompt in a session that is gone once a newer repair went out', async () => {
    const lost: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'unknown', reason: 'gone' }
    const newer: Repair = { ...lost, id: 'r-2', draftVersion: 'v1', sentAt: T + 9500, state: 'delivered', reason: undefined }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [lost, newer] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    expect(screen.getByText("r-2 went out after it, so Devbox won't try this one again.")).toBeInTheDocument()
    expect(screen.queryByText(/edit the draft to send it again/i)).not.toBeInTheDocument()
  })

  it('says why an older repair is not offered again once a newer one went out, whatever became of it', async () => {
    const older: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'unknown', reason: 'other_conversation' }
    const newer: Repair = { ...older, id: 'r-2', draftVersion: 'v1', sentAt: T + 9500, state: 'delivered', reason: undefined }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [older, newer] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    expect(screen.getByText("r-2 went out after it, so Devbox won't try this one again.")).toBeInTheDocument()
    cleanup()
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [{ ...older, reason: 'other_session' }, newer] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    expect(screen.getByText("r-2 went out after it, so Devbox won't try this one again.")).toBeInTheDocument()
    cleanup()
    await show({ sessions: [], state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [{ ...older, state: 'held', reason: 'prompt_changed' }, newer] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    expect(screen.getByText("r-2 went out after it, so Devbox won't try this one again.")).toBeInTheDocument()
  })

  it('does not offer to try a failed repair again from earlier handoffs once its draft went out another way', async () => {
    const failed: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'failed', reason: 'busy' }
    const sent: Repair = { ...failed, id: 'r-2', sentAt: T + 9500, state: 'delivered', reason: undefined }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [failed, sent] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    fireEvent.click(screen.getByText(/earlier handoffs/i))
    expect(screen.getByText(/not sent: /i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
  })

  it('does not offer to try a held repair again once what holds changed since it went out', async () => {
    const held: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: [], version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'held', reason: 'prompt_changed' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [held] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    expect(screen.getByText("What holds changed after it went out, so Devbox won't try this one again. If it is still in fix's prompt, clear it there. Edit the draft to send it again.")).toBeInTheDocument()
    cleanup()
    const elsewhere = { ...held, basis: currentBasis, target: { ...held.target, sessionId: 's-old' } }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [elsewhere] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    expect(screen.getByText("A different conversation runs in fix now, so Devbox won't try this one again. Edit the draft to send it again.")).toBeInTheDocument()
  })

  it('says what stops a retry for each reason the server would give', async () => {
    const held: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'held', reason: 'prompt_changed' }
    const text = 'Retry at most 1 attempt per request.'
    await show({ state: state({ draft: draft(text), draftVersion: 'v0', repairs: [held] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    expect(screen.getByText("Open fix's terminal to send it, or clear the prompt and try again.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    cleanup()
    await show({ sessions: [{ ...fix(BASE), registry: undefined }], state: state({ draft: draft(text), draftVersion: 'v0', repairs: [held] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    expect(screen.getByText("Devbox can't see the conversation in fix right now, so it can't try this again yet.")).toBeInTheDocument()
    expect(screen.queryByText(/a different conversation runs/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    cleanup()
    await show({ state: state({ draft: draft(`${text}\nAlso log each retry.`), draftVersion: 'v1', repairs: [held] }) })
    fireEvent.click(screen.getByText(/earlier handoffs/i))
    expect(screen.getByText("The draft changed after it, so Devbox won't try this one again. If it is still in fix's prompt, clear it there.")).toBeInTheDocument()
    cleanup()
    const failed: Repair = { ...held, state: 'failed', reason: 'busy' }
    await show({ state: state({ draft: draft(text, currentBasis, { target: { session: 'fix', pane: '%1', sessionId: 's-old' } }), draftVersion: 'v0', repairs: [failed] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff draft' }))
    expect(screen.getByText('This draft was written for an earlier conversation in fix. A different conversation runs there now.')).toBeInTheDocument()
    expect(screen.queryByText(/won't try this one again/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    replies.draft = { status: 200, body: { version: 'v0' } }
    fireEvent.click(screen.getByRole('button', { name: /use the conversation running now/i }))
    await settle(600)
    expect(sendButton()).toBeEnabled()
  })

  it('offers Try again on a held repair again once a change that keeps the text is saved', async () => {
    const held: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'held', reason: 'prompt_changed' }
    await show({ state: state({ draft: { ...draft('Fix it.\nThe old code tried at most 2 attempts.'), follows: T + 9000 }, draftVersion: 'v0', repairs: [held] }) })
    replies.draft = { status: 200, body: { version: 'v0' } }
    fireEvent.click(screen.getByRole('button', { name: 'Handoff draft' }))
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep line 2 as an earlier comparison' }))
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    await settle(600)
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('picks the id for Send after an unsaved edit is saved, so a failed repair is reused only for its own text', async () => {
    const failed: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'failed', reason: 'busy' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [failed] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff draft' }))
    expect(screen.getByText(/sending this draft tries it again/i)).toBeInTheDocument()
    replies.draft = { status: 200, body: { version: 'v1' } }
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nAlso log each retry.' } })
    expect(screen.queryByText(/sending this draft tries it again/i)).not.toBeInTheDocument()
    fireEvent.click(sendButton())
    await settle()
    expect(posts.find((p) => p.url === '/api/return/repair')?.body).toMatchObject({ version: 'v1', requestId: expect.stringMatching(/^r-(?!1$)\w+$/) })
  })

  it('reuses a failed repair for Send when an unsaved edit brings its text back', async () => {
    const failed: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'failed', reason: 'busy' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.\nAlso log each retry.'), draftVersion: 'v1', repairs: [failed] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff draft' }))
    replies.draft = { status: 200, body: { version: 'v0' } }
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.' } })
    fireEvent.click(sendButton())
    await settle()
    expect(posts.find((p) => p.url === '/api/return/repair')?.body).toMatchObject({ version: 'v0', requestId: 'r-1' })
  })

  it('sends a failed repair again under its id after a newer one went out, since it never went out', async () => {
    const failed: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'failed', reason: 'busy' }
    const newer: Repair = { ...failed, id: 'r-2', draftVersion: 'v1', sentAt: T + 9500, state: 'delivered', reason: undefined }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [failed, newer] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff draft' }))
    expect(screen.queryByText(/went out after it/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    fireEvent.click(sendButton())
    await settle()
    expect(posts.find((p) => p.url === '/api/return/repair')?.body).toMatchObject({ requestId: 'r-1' })
  })

  it('shows the receipt again once the repair a follow-up was opened on is tried again', async () => {
    const held: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'held', reason: 'prompt_changed' }
    const text = 'Retry at most 1 attempt per request.'
    await show({ state: state({ draft: { ...draft(text), follows: T + 9000 }, draftVersion: 'v0', repairs: [held] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff draft' }))
    expect(editor()).toHaveValue(text)
    const again: Repair = { ...held, sentAt: T + 9900, state: 'delivered', reason: undefined }
    replies.repair = { status: 202, body: { repair: again } }
    respond({ state: state({ draft: { ...draft(text), follows: T + 9000 }, draftVersion: 'v0', repairs: [again] }) })
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await settle()
    expect(screen.getByRole('button', { name: 'Handoff receipt' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /write a follow-up/i })).toBeInTheDocument()
  })

  it('shows the receipt once a follow-up goes out, even when the host holds it', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: 'Done.', replyId: 'a9' }
    const next = 'Retry at most 1 attempt per request.\nAlso log each retry.'
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [out] }) })
    replies.draft = { status: 200, body: { version: 'v9' } }
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    fireEvent.click(screen.getByRole('button', { name: /hand back to the agent to repair/i }))
    fireEvent.change(editor(), { target: { value: next } })
    await settle(600)
    const held: Repair = { id: 'r-2', packet: '', target: out.target, basis: currentBasis, version: 'a3', draftVersion: 'v9', sentAt: T + 9500, state: 'held', reason: 'prompt_changed' }
    replies.repair = { status: 409, body: { error: 'held', code: 'prompt_changed', repair: held } }
    respond({ state: state({ draft: draft(next), draftVersion: 'v9', repairs: [out, held] }) })
    fireEvent.click(sendButton())
    await settle()
    expect(screen.getByRole('button', { name: /write a follow-up/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send repair to session fix/i })).not.toBeInTheDocument()
  })

  it("keeps the last recorded failure beside a reply, so the reply's claims aren't read as a check", async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: 'Tests pass now.', replyId: 'a9' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    expect(screen.getByText(/the last recorded failure is “retry\.test\.ts”/i)).toHaveTextContent("before this repair. Devbox records only failures, so whether the checks pass now is the reply's word, not a check.")
    expect(screen.getByRole('button', { name: /hand back to the agent to repair/i })).not.toHaveClass('primary')
    expect(screen.getByRole('button', { name: 'Accept this result' })).toHaveClass('primary')
  })

  it('keeps the last recorded failure on the changes step once a repair went out, so it does not read as fixed', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] Tests pass now.', replyId: 'a9', accepted: { at: T + 9500, replyId: 'a9' } }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Changes & next step' }))
    expect(screen.getByText(/the last recorded failure is “retry\.test\.ts”/i)).toHaveTextContent("before this repair. Devbox records only failures, so whether the checks pass now is the reply's word, not a check.")
  })

  it('quotes what you asked beside the reply, keeps the failure that came before it tagged, and does not say whether the agent merged', async () => {
    const packet = '[devbox repair r-1]\nPurpose: repair.\nTarget: this session, fix.\n\nCheck the budget reset between requests.\n\nWhat this is based on, quoted from this conversation:\n- Rule'
    const out: Repair = { id: 'r-1', packet, target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] Done.', replyId: 'a9', accepted: { at: T + 9500, replyId: 'a9' } }
    const records = [...BASE, rec('u3', 'decision', T + 7250, 'Never retry a write without asking: retry.test.ts covers it.', 2)]
    await show({ sessions: [fix(records)], state: state({ draft: draft('Check the budget reset between requests.'), draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    expect(screen.getByRole('article', { name: 'What you asked' })).toHaveTextContent('Check the budget reset between requests.')
    expect(screen.getByRole('article', { name: 'What you asked' })).not.toHaveTextContent('What this is based on')
    expect(document.body).not.toHaveTextContent('nothing is merged')
    expect(screen.getByText('Merging, pushing or deploying').closest('li')).toHaveTextContent("not done by Devbox; the repair told the agent not to, and Devbox can't see whether it did")
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    expect(screen.getByText(/^Replied · you accepted it /, { selector: '.receipt-state' })).toBeInTheDocument()
    expect(screen.getByText(/^Asked for edits in/)).toHaveTextContent('Asked for edits in /work/api and the tests needed to check them · no merge, push or deploy. Requested in the message, not enforced by Devbox.')
    fireEvent.click(screen.getByRole('button', { name: 'Changes & next step' }))
    expect(area(/where you left off/i).querySelector('.holds-list')).toHaveTextContent('failed before the repair')
  })

  it('lists what you asked and the evidence you attached, never marks a line as covered, flags what the reply does not seem to mention, and drafts a follow-up for it', async () => {
    const packet = '[devbox repair r-1]\nPurpose: repair.\nTarget: this session, fix.\n\nCap each attempt by the time left in the budget.\nAlso add a test for idempotent writes.\nReport back: what is still unresolved.\n\nWhat this is based on, quoted from this conversation:\n- Rule\nAgent messages from the other sessions in this work, quoted as written and not checked:\n- review (2026-10-16 12:04Z): "The 200ms backoff has no reason; budget reset needs checking."\n\nWhen you finish'
    const out: Repair = { id: 'r-1', packet, target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] Capped each attempt by the remaining budget time. The 200 ms backoff is jittered now. I did not merge the PR.', replyId: 'a9' }
    await show({ sessions: [fix([...BASE, rec('u3', 'decision', T + 7250, 'Never merge the PR without asking me.', 2)])], state: state({ draft: draft('x'), draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    const asked = screen.getByRole('article', { name: 'What you asked' })
    expect(asked).not.toHaveTextContent(/words appear|shares two|closest/i)
    expect(within(asked).getByText('Cap each attempt by the time left in the budget.').closest('li')).toHaveTextContent('Not checked · nearest in the reply: “Capped each attempt by the remaining budget time.”')
    expect(within(asked).getByText('Report back: what is still unresolved').closest('li')).toHaveTextContent("The reply doesn't seem to mention this.")
    expect(within(asked).getByText('Also add a test for idempotent writes.').closest('li')).toHaveTextContent("The reply doesn't seem to mention this.")
    const evidence = screen.getByRole('article', { name: 'Evidence you attached' })
    expect(within(evidence).getByText(/^review: /).closest('li')).toHaveTextContent("review: “The 200ms backoff has no reason; budget reset needs checking.”The reply doesn't seem to mention “budget reset needs checking”.")
    expect(asked).toHaveTextContent("Devbox doesn't check that the reply did these")
    expect(screen.getByRole('button', { name: 'Accept anyway' })).not.toHaveClass('primary')
    expect(screen.getByRole('button', { name: 'Accept anyway' }).nextSibling).toHaveTextContent('The 3 things it may have missed stay listed on Now after you accept.')
    const list = screen.getByText('Merging, pushing or deploying').closest('ul') as HTMLElement
    expect(within(list).getByText(/Never merge the PR without asking me/).closest('li')).toHaveTextContent(/^Never merge the PR without asking me\.not checked by Devbox$/)
    fireEvent.click(screen.getByRole('button', { name: 'Draft a follow-up for what it may have missed' }))
    expect(screen.getByRole('button', { name: /^Handoff / })).toHaveAttribute('aria-current', 'page')
    expect(editor()).toHaveValue("The reply to r-1 doesn't seem to cover these. Do each, or say why not:\n- Also add a test for idempotent writes.\n- budget reset needs checking\nReport back: what you changed, which tests you ran and their output, and what is still unresolved.")
  })

  it('adds what the reply may have missed to a draft you have not sent yet, instead of dropping it', async () => {
    const packet = '[devbox repair r-1]\nPurpose: repair.\nTarget: this session, fix.\n\nAlso add a test for idempotent writes.\n\nWhat this is based on, quoted from this conversation:\n- Rule\n\nWhen you finish'
    const out: Repair = { id: 'r-1', packet, target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] Capped each attempt.', replyId: 'a9' }
    await show({ state: state({ draft: draft('Check the logs too.'), draftVersion: 'v1', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Draft a follow-up for what it may have missed' }))
    const once = "Check the logs too.\n\nThe reply to r-1 doesn't seem to cover these. Do each, or say why not:\n- Also add a test for idempotent writes.\nReport back: what you changed, which tests you ran and their output, and what is still unresolved."
    expect(editor()).toHaveValue(once)
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Draft a follow-up for what it may have missed' }))
    expect(editor()).toHaveValue(once)
  })

  it('puts what the reply may have missed before the Report back line of an unsent draft, as written', async () => {
    const packet = '[devbox repair r-1]\nPurpose: repair.\nTarget: this session, fix.\n\nCheck that kill $$ stops the worker.\n\nWhat this is based on, quoted from this conversation:\n- Rule\n\nWhen you finish'
    const out: Repair = { id: 'r-1', packet, target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] Capped each attempt.', replyId: 'a9' }
    const report = 'Report back: what you changed, which tests you ran and their output, and what is still unresolved.'
    await show({ state: state({ draft: draft(`Fix it.\n${report}`), draftVersion: 'v1', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Draft a follow-up for what it may have missed' }))
    expect(editor()).toHaveValue(`Fix it.\nThe reply to r-1 doesn't seem to cover these. Do each, or say why not:\n- Check that kill $$ stops the worker.\n${report}`)
  })

  it('says a line may be only partly covered when the reply shares only the words of your rules, and quotes the nearest sentence', async () => {
    const packet = '[devbox repair r-1]\nPurpose: repair.\nTarget: this session, fix.\n\nThen rerun keeps total deadline and the other retry tests.\n\nWhat this is based on, quoted from this conversation:\n- Rule (you, 2026-10-16 03:01Z): "Keep the 10 second total deadline and retry only idempotent requests."\n\nWhen you finish'
    const out: Repair = { id: 'r-1', packet, target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] retry.test.ts passes: total deadline 9.6 s.', replyId: 'a9' }
    await show({ state: state({ draft: draft('x'), draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    const asked = screen.getByRole('article', { name: 'What you asked' })
    expect(within(asked).getByText('Then rerun keeps total deadline and the other retry tests.').closest('li')).toHaveTextContent('Maybe only partly covered, not counted as missed · nearest in the reply: “retry.test.ts passes: total deadline 9.6 s.”')
    expect(screen.getByRole('article', { name: 'The reply' }).compareDocumentPosition(asked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says an attached part the reply skips is flagged among your own lines when the follow-up already asked it', async () => {
    const packet = '[devbox repair r-2]\nPurpose: repair.\nTarget: this session, fix.\n\nThe reply to r-1 doesn\'t seem to cover these. Do each, or say why not:\n- budget reset needs checking\n\nWhat this is based on, quoted from this conversation:\n- Rule\nAgent messages from the other sessions in this work, quoted as written and not checked:\n- review (2026-10-16 12:04Z): "The 200ms backoff has no reason; budget reset needs checking."\n\nWhen you finish'
    const out: Repair = { id: 'r-2', packet, target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-2] The 200 ms backoff is jittered now.', replyId: 'a9' }
    await show({ state: state({ draft: draft('x'), draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    expect(within(screen.getByRole('article', { name: 'What you asked' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(["- budget reset needs checkingThe reply doesn't seem to mention this."])
    expect(within(screen.getByRole('article', { name: 'Evidence you attached' })).getByRole('listitem')).toHaveTextContent("The reply doesn't seem to mention “budget reset needs checking” either; it's flagged above, in what you asked.")
  })

  it('says at the top that you accepted the result and that merging is still yours', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] Done.', replyId: 'a9', accepted: { at: T + 9500, replyId: 'a9' } }
    await show({ state: state({ draft: draft('x'), draftVersion: 'v0', repairs: [out] }) })
    expect(screen.getByRole('button', { name: 'Result & acceptance' })).toHaveAttribute('aria-current', 'page')
    const heading = screen.getByRole('heading', { name: 'You accepted this result · merge is still yours' })
    expect(heading.nextElementSibling).toHaveTextContent(/^You accepted it \S+ ago\. That records that you read the reply; it doesn't merge, push or close anything\.$/)
  })

  it('hands its fresh brief to the page on each read, so the rail stops counting a failure a repair went out after', async () => {
    const changed = vi.fn()
    await show({}, { onStateChanged: changed })
    expect(changed.mock.calls.at(-1)?.[2]?.failing).toMatchObject({ id: 'f1' })
    cleanup()
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] Done.', replyId: 'a9', accepted: { at: T + 9500, replyId: 'a9' } }
    await show({ state: state({ draft: draft('x'), draftVersion: 'v0', repairs: [out] }) }, { onStateChanged: changed })
    expect(changed.mock.calls.at(-1)?.[2]).toBeDefined()
    expect(changed.mock.calls.at(-1)?.[2]?.failing).toBeUndefined()
  })

  it('points the next step at the reply once one came back', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] Done.', replyId: 'a9' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Changes & next step' }))
    fireEvent.click(screen.getByRole('button', { name: /^review the reply/i }))
    expect(screen.getByRole('button', { name: 'Result & acceptance' })).toHaveAttribute('aria-current', 'page')
  })

  it('says the round is accepted on the next step, and offers Now before another repair', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] Done.', replyId: 'a9', accepted: { at: T + 9500, replyId: 'a9' } }
    await show({ sessions: [fix([...BASE.filter((r) => r.kind !== 'failure'), rec('a9', 'agent', T + 9400, '[devbox result r-1] Done.', 3, true)])], state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Changes & next step' }))
    expect(screen.getByRole('heading', { name: 'You accepted the result · merge is still yours' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'You accepted the result · merge is still yours' }).nextElementSibling).toHaveTextContent('The reply says, not checked: “Done.”')
    expect(screen.getAllByRole('button', { name: /^Back to Now/ }).some((b) => b.classList.contains('primary'))).toBe(true)
    expect(screen.getByRole('button', { name: /hand back another repair/i })).not.toHaveClass('primary')
  })

  it('starts a question about the reply once one came back, instead of about the old failure', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] Tests pass now.', replyId: 'a9' }
    await show({ state: state({ draft: draft('x'), draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask first (read-only)' }))
    expect(screen.getByRole('textbox', { name: 'Your question' })).toHaveValue(QUESTION_AFTER_REPLY)
  })

  it('discards a draft only after you confirm, and saves it empty', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }))
    expect(editor()).toHaveValue('Retry at most 1 attempt per request.')
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('button', { name: 'Discard it' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }))
    expect(screen.getByText("Discard the draft? Its text can't be brought back.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard it' }))
    await settle(600)
    expect((posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft as DraftState).text).toBe('')
    expect(screen.getByRole('button', { name: 'Changes & next step' })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps which send a follow-up follows when you discard it', async () => {
    await show({ state: state({ draft: { ...draft('Retry at most 1 attempt per request.'), follows: T + 9000 }, draftVersion: 'v0' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard it' }))
    await settle(600)
    expect((posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft as DraftState).follows).toBe(T + 9000)
    fireEvent.click(screen.getByRole('button', { name: /hand back to the agent to repair/i }))
    await settle(600)
    expect((posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft as DraftState).follows).toBe(T + 9000)
  })

  it('says Devbox never merges before any repair has gone out, and lists your rules as unchecked', async () => {
    await show({ sessions: [fix([...BASE, rec('u3', 'decision', T + 7250, 'Never retry a write without asking.', 2)])] })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    expect(screen.getByText('Merging, pushing or deploying').closest('li')).toHaveTextContent('Devbox never does it')
    const list = screen.getByText('Merging, pushing or deploying').closest('ul') as HTMLElement
    expect(within(list).getByText('Never retry a write without asking.').closest('li')).toHaveTextContent('not checked by Devbox')
  })

  it('says when a reply lacks the result tag the repair asked for, or repeats the previous reply word for word', async () => {
    const base = { packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', state: 'replied' as const, replyId: 'a9' }
    const first: Repair = { ...base, id: 'r-0', sentAt: T + 8000, reply: '[devbox result r-0] Fixed the budget.' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [first, { ...base, id: 'r-1', sentAt: T + 9000, reply: '[devbox result r-0] Fixed the budget.' }] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    const reply = screen.getByRole('article', { name: 'The reply' })
    expect(reply).toHaveTextContent('It doesn\'t start with “[devbox result r-1]” as the repair asked, so it may answer something else. Read it in the session before you accept.')
    expect(reply).toHaveTextContent(/It's word for word the reply to the previous repair, sent \S+ ago\./)
    cleanup()
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [first] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Result & acceptance' }))
    expect(screen.getByRole('article', { name: 'The reply' })).not.toHaveTextContent(/doesn't start with|word for word/)
  })

  it('marks an earlier round a later reply followed, and keeps its reply in place instead of pointing at the newer one', async () => {
    const base = { packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', state: 'replied' as const, replyId: 'a9' }
    const older: Repair = { ...base, id: 'r-0', draftVersion: 'v-old', sentAt: T + 8000, reply: '[devbox result r-0] Fixed the budget.' }
    const newer: Repair = { ...base, id: 'r-1', draftVersion: 'v0', sentAt: T + 9000, reply: '[devbox result r-1] Capped the backoff.' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [newer, older] }) })
    fireEvent.click(screen.getByRole('button', { name: /^Handoff / }))
    const earlier = screen.getByText(/^Earlier handoffs/).closest('details') as HTMLElement
    expect(earlier).toHaveTextContent('Replied · r-1 followed it')
    expect(within(earlier).queryByRole('button', { name: 'Review the reply' })).toBeNull()
    expect(earlier).toHaveTextContent('Show its reply[devbox result r-0] Fixed the budget.')
  })

  it('opens on a new reply or a new answer, scrolled to it', async () => {
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id)
    }
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: '[devbox result r-1] Done.', replyId: 'a9' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [out] }) })
    expect(scrolled).toEqual(['return-result'])
    cleanup()
    const answered: Inquiry = { id: 'q-1', question: 'Why?', target: { session: 'fix', pane: '%1', sessionId: 's1' }, version: 'a2', askedAt: T + 9000, state: 'replied', answer: 'Facts: none.', repliedAt: T + 9100 }
    await show({ state: state({ inquiries: [answered] }) })
    expect(scrolled).toEqual(['return-result', 'answer-q-1'])
    cleanup()
    await show({ state: state({ inquiries: [answered], seenAt: T + 9200 }) })
    expect(scrolled).toHaveLength(2)
    delete (Element.prototype as Partial<Element>).scrollIntoView
  })

  it('does not offer to send a draft again once it went out', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: 'Done.', replyId: 'a9' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    expect(screen.queryByRole('button', { name: /send repair to session fix/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /write a follow-up/i }))
    expect(sendButton()).toBeDisabled()
    expect(screen.getByText(/already sent/i)).toBeInTheDocument()
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nAlso log each retry.' } })
    await settle(600)
    expect(sendButton()).toBeEnabled()
  })

  it("starts a follow-up without the sent round's changes and set-aside rules", async () => {
    const records = [...BASE, rec('u3', 'decision', T + 7250, "Don't raise the deadline to 30 seconds.", 2)]
    const sent = draft('Retry at most 1 attempt per request.\nRaise the deadline to 30 seconds.', currentBasis, { corrections: [{ id: 'c1', before: 'Retry at most 2 attempts per request.', after: 'Retry at most 1 attempt per request.' }] })
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T + 9000, state: 'replied', reply: 'Done.', replyId: 'a9' }
    const key = `u3|Don't raise the deadline to 30 seconds.`
    await show({ sessions: [fix(records)], state: state({ draft: { ...sent, setAside: [key] }, draftVersion: 'v0', repairs: [out] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Handoff receipt' }))
    fireEvent.click(screen.getByRole('button', { name: /write a follow-up/i }))
    expect(screen.queryByText(/Changed “Retry at most 2 attempts per request”/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Set aside for this repair/)).not.toBeInTheDocument()
    await settle(600)
    expect(posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft).toMatchObject({ follows: T + 9000, corrections: [], earlier: [], setAside: [], read: [] })
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nRaise the deadline to 30 seconds.\nAlso log each retry.' } })
    expect(screen.queryByText(/Changed “Retry at most 2 attempts per request”/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: "Set aside “Don't raise the deadline to 30 seconds” for line 2 only" })).toBeInTheDocument()
  })

  it('waits for the agent to be idle before it offers to send, checking at the slow pace meanwhile', async () => {
    await show({ sessions: [fix(BASE, 'busy')], state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    expect(sendButton()).toBeDisabled()
    expect(screen.getByText(/fix is working/i)).toBeInTheDocument()
    respond({ sessions: [fix(BASE, 'idle')], state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    await settle(4000)
    expect(sendButton()).toBeDisabled()
    await settle(11000)
    expect(sendButton()).toBeEnabled()
  })

  it('says when a repair is waiting unsubmitted in the prompt, and does not offer a second copy', async () => {
    const held: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T, state: 'held', reason: 'prompt_changed' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [held] }) })
    expect(screen.getByText('In the prompt, not submitted')).toBeInTheDocument()
    expect(screen.getByText(/not submitted: the session's prompt changed while devbox pasted/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send repair to session fix/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled()
  })

  it('keeps a line as an earlier comparison and sends it as one', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.\nThe old code tried at most 2 attempts.'), draftVersion: 'v0' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Keep line 2 as an earlier comparison' }))
    expect(screen.queryByText(/line 2 says/i)).not.toBeInTheDocument()
    expect(sendButton()).toBeEnabled()
    fireEvent.click(screen.getByText(/the full message, as the agent gets it/i))
    expect(screen.getByText(/the full message, as the agent gets it/i).closest('details')).toHaveTextContent('The old code tried at most 2 attempts. (Earlier comparison only, not a requirement.)')
  })

  it('keeps and undoes a line with two findings as one line', async () => {
    await show({ state: state({ draft: draft('Fix it.\nThe old code tried at most 2 attempts, then at most 3 attempts.'), draftVersion: 'v0' }) })
    expect(screen.getAllByRole('button', { name: 'Keep line 2 as an earlier comparison' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Keep line 2 as an earlier comparison' }))
    expect(screen.getByRole('heading', { name: /but for 1 line kept as an earlier comparison/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo keeping line 2 as an earlier comparison' }))
    expect(screen.getAllByText(/line 2 says at most/i)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Undo keeping line 2 as an earlier comparison' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep line 2 as an earlier comparison' }))
    fireEvent.change(editor(), { target: { value: 'Fix it.' } })
    fireEvent.change(editor(), { target: { value: 'Fix it.\nThe old code tried at most 2 attempts, then at most 3 attempts.' } })
    expect(screen.getByRole('button', { name: 'Keep line 2 as an earlier comparison' })).toBeInTheDocument()
  })

  it('keeps every copy of a line together, and counts each one', async () => {
    await show({ state: state({ draft: draft('Fix it.\nThe old code tried at most 2 attempts.\nThe old code tried at most 2 attempts.'), draftVersion: 'v0' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Keep line 2 as an earlier comparison' }))
    expect(screen.getByRole('heading', { name: /but for 2 lines kept as an earlier comparison/i })).toBeInTheDocument()
    expect(screen.getByText(/· lines 2 and 3/)).toBeInTheDocument()
    expect(sendButton()).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Undo keeping lines 2 and 3 as an earlier comparison' }))
    expect(screen.getAllByText(/says at most 2 attempts/i)).toHaveLength(2)
  })

  it('forgets a kept line that an undo takes away, so it comes back flagged', async () => {
    await show({ state: state({ draft: draft('Fix it.\nThe old code tried at most 2 attempts, then at most 3 attempts.'), draftVersion: 'v0' }) })
    fireEvent.click(screen.getAllByRole('button', { name: 'Change line 2 to at most 1 attempt' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Keep line 2 as an earlier comparison' }))
    expect(screen.queryByText(/line 2 says/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo the change to line 2' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Change line 2 to at most 1 attempt' })[0])
    expect(screen.getByText(/line 2 says at most 3 attempts/i)).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
  })

  it('can undo keeping a line as an earlier comparison, and does not call the draft a plain match meanwhile', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.\nThe old code tried at most 2 attempts.'), draftVersion: 'v0' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Keep line 2 as an earlier comparison' }))
    expect(screen.getByRole('heading', { name: /nothing flagged in the limits devbox checks, but for 1 line kept as an earlier comparison/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo keeping line 2 as an earlier comparison' }))
    expect(screen.getByText(/line 2 says at most 2 attempts/i)).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
  })

  it('flags a line that sets what one of your rules names, and sends it only once you set that rule aside, saying so in the message', async () => {
    const records = [...BASE, rec('u3', 'decision', T + 7250, "Don't raise the deadline to 30 seconds: callers can't wait longer.", 2)]
    await show({ sessions: [fix(records)], state: state({ draft: draft('Fix the loop.\nRaise the deadline to 30 seconds so the check passes.'), draftVersion: 'v0' }) })
    expect(screen.getByText(/line 2 says raise the deadline to 30 seconds · your rule: “don't raise the deadline to 30 seconds”/i)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /1 line flagged/i })).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: "Set aside “Don't raise the deadline to 30 seconds” for line 2 only" }))
    expect(sendButton()).toBeEnabled()
    expect(screen.getByRole('heading', { name: /nothing flagged in the limits devbox checks · 1 exception to your rules/i })).toBeInTheDocument()
    fireEvent.click(screen.getByText(/the full message, as the agent gets it/i))
    expect(screen.getByText(/the full message, as the agent gets it/i).closest('details')).toHaveTextContent(`For this request only, I make an exception to my rule from ${stamp(T + 7250)}: "Don't raise the deadline to 30 seconds: callers can't wait longer.", for this line only: "Raise the deadline to 30 seconds so the check passes.". The rest of the rule still holds.`)
    fireEvent.click(screen.getByRole('button', { name: "Undo setting aside “Don't raise the deadline to 30 seconds”" }))
    expect(sendButton()).toBeDisabled()
  })

  it('blocks a line that asks for a merge, push or deploy, and says that step stays yours', async () => {
    await show({ sessions: [fix([...BASE, rec('u3', 'decision', T + 7250, 'Never merge the PR without asking me.', 2)])], state: state({ draft: draft('Fix the loop.\nMerge the PR once the tests pass.'), draftVersion: 'v0' }) })
    expect(screen.queryByRole('button', { name: /for line 2 only/ })).not.toBeInTheDocument()
    expect(screen.getByText(/line 2 asks for “merge”/i)).toHaveTextContent("Line 2 asks for “Merge”. A repair never merges, pushes or deploys: the message tells the agent not to. Remove it; that step stays yours.")
    expect(sendButton()).toBeDisabled()
    expect(screen.getByRole('heading', { name: /1 line flagged · 2 findings/i })).toBeInTheDocument()
    expect(document.querySelectorAll('.return-issues > li')).toHaveLength(1)
    expect(document.querySelector('.return-issues > li')).toHaveTextContent(/your rule: “Never merge the PR without asking me”.*A repair never merges/)
    cleanup()
    await show({ state: state({ draft: draft('Fix the loop.\nIgnore the limits quoted below.'), draftVersion: 'v0' }) })
    expect(screen.getByText(/Line 2 says “Ignore the limits”/)).toHaveTextContent("A repair can't set aside your limits, rules or checks this way.")
    expect(sendButton()).toBeDisabled()
  })

  it('flags a line that asks to go past a limit without a number, numbering lines as the box shows them', async () => {
    await show({ state: state({ draft: draft('Please continue.\n\nFix the loop.\nAdd one more retry on top of the current limit.'), draftVersion: 'v0' }) })
    expect(screen.getByText(/^Line 4 asks to add one more retry/)).toHaveTextContent('Line 4 asks to add one more retry; at most 1 attempt holds now. Edit the line. To go past the limit, change the limit itself first.')
    expect(screen.queryByRole('button', { name: /^Confirm line/ })).toBeNull()
    expect(sendButton()).toBeDisabled()
    expect(sendButton().parentElement).toHaveTextContent('Edit each line that asks to go past a limit that holds now.')
  })

  it('says which amounts it could not check, and does not call the draft a match', async () => {
    await show({ state: state({ draft: draft('Fix the loop.\nAllow a few attempts.\nRetry up to 1 times.'), draftVersion: 'v0' }) })
    expect(screen.getByRole('heading', { name: /2 lines flagged · 2 amounts devbox can't check/i })).toBeInTheDocument()
    cleanup()
    await show({ state: state({ draft: draft('Allow up to 3 attempts.\nAllow a few attempts.'), draftVersion: 'v0' }) })
    expect(screen.getByRole('heading', { name: /2 lines flagged · 1 amount devbox can't check/i })).toBeInTheDocument()
    cleanup()
    await show({ state: state({ draft: draft('Allow up to three attempts.'), draftVersion: 'v0' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Change line 1 to at most 1 attempt' }))
    expect(editor()).toHaveValue('Allow up to 1 attempt.')
    cleanup()
    await show({ state: state({ draft: draft('Let slow calls have one more try only if the budget allows.'), draftVersion: 'v0' }) })
    expect(screen.getAllByRole('button', { name: 'Confirm line 1 as written' })).toHaveLength(1)
    fireEvent.change(editor(), { target: { value: 'Let slow calls have one more try only if the budget allows. Add a test.' } })
    fireEvent.change(editor(), { target: { value: 'Let slow calls have one more try only if the budget allows. Add a test for it.' } })
    expect(screen.getAllByRole('button', { name: 'Confirm line 1 as written' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm line 1 as written' }))
    expect(editor()).toHaveValue('Let slow calls have one more try only if the budget allows. Add a test for it.')
    cleanup()
    await show({ state: state({ draft: draft('Permit a second try.'), draftVersion: 'v0' }) })
    expect(screen.getByText(/line 1 says “second try”/i)).toHaveTextContent('Write it like “at most 1 attempt”')
    cleanup()
    await show({ state: state({ draft: draft('Fix the loop.\nAllow a few attempts.\nRetry up to 1 times.'), draftVersion: 'v0' }) })
    expect(screen.getByText(/line 2 says “a few attempts”/i)).toHaveTextContent("Devbox can't check it. Write it like “at most 1 attempt” to have it checked, or confirm the line as written.")
    expect(screen.getByText(/line 3 says “up to 1 times”/i)).toHaveTextContent('Line 3 says “up to 1 times”, which may mean 1 or 2 attempts.')
    expect(screen.queryByRole('heading', { name: /nothing flagged/i })).not.toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    expect(screen.queryByText(/^Confirmed as written/)).toBeNull()
    expect(sendButton().parentElement).toHaveTextContent("Rewrite or confirm each amount Devbox can't check.")
    fireEvent.click(screen.getByRole('button', { name: 'Confirm line 2 as written' }))
    expect(sendButton()).toBeDisabled()
    expect(screen.getByRole('heading', { name: /^1 line flagged · 1 amount devbox can't check/i })).toBeInTheDocument()
    expect(screen.getByText(/^Confirmed as written: line 2/)).toHaveTextContent('Confirmed as written: line 2, “a few attempts”. Undo')
    expect(screen.queryByText(/line 2 says “a few attempts”/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm line 3 as written' }))
    expect(sendButton()).toBeEnabled()
    expect(screen.getByRole('heading', { name: /^Nothing flagged in the limits Devbox checks · 2 amounts you confirmed unchecked/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo confirming line 2' }))
    expect(sendButton()).toBeDisabled()
    cleanup()
    await show({ state: state({ draft: draft('Go back to 2 attempts.'), draftVersion: 'v0' }) })
    expect(screen.getByText(/line 1 says “2 attempts”/i)).toHaveTextContent('Line 1 says “2 attempts”, the old limit: at most 2 attempts was replaced by at most 1 attempt. Devbox can\'t check it.')
  })

  it('calls a clean draft a match only for what Devbox checks, and says the rest of your rules are for you to read', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    const heading = screen.getByRole('heading', { name: /nothing flagged in the limits devbox checks/i })
    expect(heading).toHaveTextContent('· it checks limits like “at most 2 attempts”, amounts your rules name and “never” rules; read your other rules yourself')
    expect(heading.querySelector('svg')).toBeNull()
    expect(screen.getByText('Asks for').nextElementSibling).toHaveTextContent("The message asks for this; Devbox can't enforce it, the session's own permissions decide.")
  })

  it('offers to keep any flagged line as an earlier comparison, and counts lines, not rules', async () => {
    const records = [...BASE, rec('u3', 'decision', T + 7250, "Keep the 10 second total deadline and retry only idempotent requests. Don't raise it to 30 seconds.", 2)]
    await show({ sessions: [fix(records)], state: state({ draft: draft('Allow at most 2 attempts per request.\nRaise the total deadline to 30 seconds.'), draftVersion: 'v0' }) })
    expect(screen.getByRole('button', { name: 'Keep line 1 as an earlier comparison' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /2 lines flagged/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: "Set aside “Don't raise it to 30 seconds” for line 2 only" }))
    expect(screen.getByText(/line 2 says raise the total deadline to 30 seconds · your rule: “keep the 10 second total deadline/i)).toBeInTheDocument()
  })

  it('lists what changed since you saved the draft, and asks once', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.', [{ key: 'attempts|max', value: 2, recordId: 'u1' }]), draftVersion: 'v0' }) })
    expect(screen.getByText(/changed since you saved this draft/i).closest('section')).toHaveTextContent(/at most 2 attempts.*at most 1 attempt/i)
    expect(sendButton()).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /i've checked these/i }))
    expect(sendButton()).toBeEnabled()
    await settle(600)
    const saved = posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft as DraftState
    expect(saved.basis).toEqual(currentBasis)
  })

  it("offers what the other sessions' agents said since you left, unticked, and adds it to the draft once you tick it", async () => {
    const review = { ...fix([rec('c1', 'agent', T + 7450, 'Two review findings: budget reset needs checking.', 1, true)]), name: 'review', pane: '%2', agent: 'codex' as const, registry: undefined }
    await show({ sessions: [fix(), review], work: { key: 'branch:/work/api@fix/retry', members: [{ name: 'fix', reason: 'this session' }, { name: 'review', reason: 'same branch' }] } })
    fireEvent.click(screen.getByRole('button', { name: /hand back to the agent to repair/i }))
    const box = screen.getByRole('checkbox', { name: /add what review said to the repair/i })
    expect(box).not.toBeChecked()
    expect(box.closest('dd')).toHaveTextContent('“Two review findings: budget reset needs checking.” review · ')
    expect(box.closest('dd')).toHaveTextContent('Tick one to attach it · quoted as written and not checked')
    fireEvent.click(box)
    fireEvent.click(screen.getByText(/the full message, as the agent gets it/i))
    const preview = () => screen.getByText(/the full message, as the agent gets it/i).closest('details')
    expect(preview()).toHaveTextContent('not checked: - review (2026-10-16 12:04Z): "Two review findings: budget reset needs checking."')
    fireEvent.click(box)
    expect(preview()).not.toHaveTextContent('Two review findings')
    await settle(600)
    expect(posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft).toMatchObject({ others: [] })
  })

  it('lists every other-session message the draft keeps, however old, and newer ones unticked, each with its own tick', async () => {
    const review = { ...fix([rec('c1', 'agent', T + 100, 'Old finding.', 1, true), rec('c2', 'agent', T + 7450, 'Kept finding.', 1, true), rec('c3', 'agent', T + 7460, 'Later finding.', 1, true)]), name: 'review', pane: '%2', agent: 'codex' as const, registry: undefined }
    await show({
      sessions: [fix(), review],
      work: { key: 'branch:/work/api@fix/retry', members: [{ name: 'fix', reason: 'this session' }, { name: 'review', reason: 'same branch' }] },
      state: state({ draft: draft('Retry at most 1 attempt per request.', currentBasis, { others: ['c1', 'c2'] }), draftVersion: 'v0' }),
    })
    const ticks = () => screen.getAllByRole('checkbox', { name: /add what review said to the repair/i }) as HTMLInputElement[]
    expect(ticks().map((b) => [b.closest('label')?.textContent?.split('”')[0], b.checked])).toEqual([
      ['“Old finding.', true],
      ['“Kept finding.', true],
      ['“Later finding.', false],
    ])
    fireEvent.click(screen.getByText(/the full message, as the agent gets it/i))
    const preview = () => screen.getByText(/the full message, as the agent gets it/i).closest('details')
    expect(preview()).toHaveTextContent('in this work, quoted as written and not checked: - review (2026-10-16 10:01Z): "Old finding." - review (2026-10-16 12:04Z): "Kept finding."')
    expect(preview()).not.toHaveTextContent('Later finding.')
    fireEvent.click(ticks()[0])
    expect(ticks().map((b) => b.checked)).toEqual([false, true, false])
    expect(preview()).not.toHaveTextContent('Old finding.')
    fireEvent.click(ticks()[0])
    fireEvent.click(ticks()[2])
    expect(ticks().map((b) => b.checked)).toEqual([true, true, true])
  })

  it('hands back with a draft filled in from the records, against the current evidence and this conversation', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: /hand back to the agent to repair/i }))
    expect(editor()).toHaveValue(
      [
        'Please continue in this conversation.',
        '',
        'Decision: find and fix why the recorded failure quoted below fails, then rerun the checks that cover it.',
        'Follow my decisions and the limits quoted below, not earlier agent suggestions.',
        'Report back: what you changed, which tests you ran and their output, and what is still unresolved.',
      ].join('\n'),
    )
    expect(screen.getByRole('heading', { name: /repair draft · not sent/i })).toBeInTheDocument()
    expect(sendButton()).toBeEnabled()
    fireEvent.change(editor(), { target: { value: 'Fix the flaky test.' } })
    await settle(600)
    expect(posts.find((p) => p.url === '/api/return/draft')?.body).toEqual({
      session: 'fix',
      base: '',
      draft: { text: 'Fix the flaky test.', basis: currentBasis, corrections: [], earlier: [], target: { session: 'fix', pane: '%1', sessionId: 's1' } },
    })
  })

  it('saves first, sends with a request id, then follows the receipt to a reply you can accept', async () => {
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.className)
    }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    replies.repair = { status: 202, body: { repair: { id: 'r-x', state: 'sending' } } }
    fireEvent.click(sendButton())
    await settle()
    const sent = posts.find((p) => p.url === '/api/return/repair')
    expect(sent?.body).toEqual({ session: 'fix', requestId: expect.stringMatching(/^r-[a-z0-9]+$/), preview: digest(document.querySelector('.return-draft pre')?.textContent ?? ''), version: 'v0' })
    const repair: Repair = {
      id: String(sent?.body.requestId),
      packet: '[devbox repair]',
      target: { session: 'fix', pane: '%1', sessionId: 's1' },
      basis: currentBasis,
      version: 'a2',
      draftVersion: 'v0',
      sentAt: T + 3 * 86400,
      state: 'replied',
      reply: '[devbox result] Changed retry.ts; ran retry.test.ts.',
      replyId: 'a9',
      deliveredId: 'd1',
    }
    respond({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [repair] }) })
    await settle(4000)
    expect(screen.getByText(/replied/i, { selector: '.receipt-state' })).toBeInTheDocument()
    expect(scrolled.filter((c) => c === 'handoff-status')).toHaveLength(1)
    delete (Element.prototype as Partial<Element>).scrollIntoView
    fireEvent.click(screen.getByRole('button', { name: /review the reply/i }))
    expect(within(screen.getByRole('article', { name: /the reply/i })).getByText(/changed retry\.ts; ran retry\.test\.ts/i)).toBeInTheDocument()
    replies.accept = { status: 200, body: { accepted: { at: T + 3 * 86400, replyId: 'a9' } } }
    fireEvent.click(screen.getByRole('button', { name: /accept this result/i }))
    await settle()
    expect(posts).toContainEqual({ url: '/api/return/accept', body: { session: 'fix', requestId: repair.id } })
    expect(screen.queryByRole('button', { name: /accept this result/i })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'You accepted this result · merge is still yours' })).toBeInTheDocument()
  })

  it('does not send when the latest edit could not be saved', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    replies.draft = { status: 409, body: { draft: draft('Retry at most 1 attempt per request.\nFrom the other tab.'), version: 'v9' } }
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nMine.' } })
    fireEvent.click(sendButton())
    await settle()
    expect(posts.some((p) => p.url === '/api/return/repair')).toBe(false)
    expect(screen.getByText(/changed in another tab/i)).toBeInTheDocument()
  })

  it('waits for a save already under way before it sends, and sends nothing if that save failed', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    const base = globalThis.fetch
    let release = () => undefined as void
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      url === '/api/return/draft'
        ? new Promise<Response>((resolve) => {
            release = () => resolve(json({ draft: draft('Retry at most 1 attempt per request.\nFrom the other tab.'), version: 'v9' }, 409))
          })
        : base(url, init),
    )
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nMine.' } })
    await settle(600)
    fireEvent.click(sendButton())
    await settle()
    expect(posts.some((p) => p.url === '/api/return/repair')).toBe(false)
    release()
    await settle()
    expect(posts.some((p) => p.url === '/api/return/repair')).toBe(false)
    expect(screen.getByText(/changed in another tab/i)).toBeInTheDocument()
  })

  it('sends nothing when a save under way fails while you press Send', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    const base = globalThis.fetch
    let fail = () => undefined as void
    let puts = 0
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url !== '/api/return/draft') return base(url, init)
      puts += 1
      if (puts > 1) return Promise.resolve(json({ version: 'v5' }))
      return new Promise<Response>((resolve) => {
        fail = () => resolve(json({ error: 'remote_unreachable' }, 502))
      })
    })
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nMine.' } })
    await settle(600)
    fireEvent.click(sendButton())
    fail()
    await settle()
    expect(posts.some((p) => p.url === '/api/return/repair')).toBe(false)
    expect(screen.getByText(/not saved yet/i)).toBeInTheDocument()
  })

  it('saves a newer edit after an earlier save failed, without waiting for Send', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    const base = globalThis.fetch
    let fail = () => undefined as void
    const saved: string[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url !== '/api/return/draft') return base(url, init)
      saved.push((JSON.parse(init?.body as string) as { draft: DraftState }).draft.text)
      if (saved.length > 1) return Promise.resolve(json({ version: 'v5' }))
      return new Promise<Response>((resolve) => {
        fail = () => resolve(json({ error: 'remote_unreachable' }, 502))
      })
    })
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nFirst.' } })
    await settle(600)
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nSecond.' } })
    await settle(600)
    fail()
    await settle()
    expect(saved).toEqual(['Retry at most 1 attempt per request.\nFirst.', 'Retry at most 1 attempt per request.\nSecond.'])
  })

  it('keeps your text and saves it again when the stored draft was reset', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    const base = globalThis.fetch
    const puts: Array<{ base: unknown; text: string }> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url !== '/api/return/draft') return base(url, init)
      const body = JSON.parse(init?.body as string) as { draft: DraftState; base: string }
      puts.push({ base: body.base, text: body.draft.text })
      return Promise.resolve(puts.length === 1 ? json({ draft: null, version: '' }, 409) : json({ version: 'v1' }))
    })
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nMine.' } })
    await settle(600)
    expect(puts.map((p) => [p.base, p.text])).toEqual([
      ['v0', 'Retry at most 1 attempt per request.\nMine.'],
      ['', 'Retry at most 1 attempt per request.\nMine.'],
    ])
    expect(editor()).toHaveValue('Retry at most 1 attempt per request.\nMine.')
  })

  it('stays open once when your last edit could not be saved, and leaves on the second try', async () => {
    const onClose = vi.fn()
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) }, { onClose })
    replies.draft = { status: 502, body: { error: 'remote_unreachable' } }
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nMine.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/isn't saved yet/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await settle()
    expect(onClose).toHaveBeenCalled()
  })

  it('stays open to show a conflict found while closing', async () => {
    const onClose = vi.fn()
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) }, { onClose })
    replies.draft = { status: 409, body: { draft: draft('Retry at most 1 attempt per request.\nFrom the other tab.'), version: 'v9' } }
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nMine.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/changed in another tab/i)).toBeInTheDocument()
  })

  it('saves an edit that is still waiting when the view closes', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nLast words.' } })
    cleanup()
    await settle()
    expect((posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft as DraftState | undefined)?.text).toBe('Retry at most 1 attempt per request.\nLast words.')
  })

  it('keeps an edit typed while an earlier save failed, and sends that edit', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    const base = globalThis.fetch
    let fail = () => undefined as void
    const saved: string[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url !== '/api/return/draft') return base(url, init)
      const text = (JSON.parse(init?.body as string) as { draft: DraftState }).draft.text
      if (saved.length === 0) {
        saved.push(text)
        return new Promise<Response>((resolve) => {
          fail = () => resolve(json({ error: 'remote_unreachable' }, 502))
        })
      }
      saved.push(text)
      return Promise.resolve(json({ version: 'v5' }))
    })
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nFirst.' } })
    await settle(600)
    fireEvent.change(editor(), { target: { value: 'Retry at most 1 attempt per request.\nSecond.' } })
    fail()
    await settle()
    fireEvent.click(sendButton())
    await settle()
    expect(saved.at(-1)).toBe('Retry at most 1 attempt per request.\nSecond.')
    expect(posts.some((p) => p.url === '/api/return/repair')).toBe(true)
  })

  it('does not ask for a conversation for an empty draft', async () => {
    await show({ state: state({ draft: draft('', currentBasis, { target: null }), draftVersion: 'v0' }) })
    expect(screen.queryByText(/doesn't name a conversation/i)).not.toBeInTheDocument()
  })

  it('asks which conversation should get a draft that names none', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.', currentBasis, { target: null }), draftVersion: 'v0' }) })
    expect(sendButton()).toBeDisabled()
    expect(screen.getByText(/doesn't name a conversation in fix yet/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /use the conversation running now/i }))
    expect(sendButton()).toBeEnabled()
  })

  it('asks before sending a draft written for an earlier conversation in this pane', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.', currentBasis, { target: { session: 'fix', pane: '%1', sessionId: 's-old' } }), draftVersion: 'v0' }) })
    expect(sendButton()).toBeDisabled()
    expect(screen.getByText(/written for an earlier conversation/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /use the conversation running now/i }))
    expect(sendButton()).toBeEnabled()
    await settle(600)
    expect((posts.filter((p) => p.url === '/api/return/draft').at(-1)?.body.draft as DraftState).target).toEqual({ session: 'fix', pane: '%1', sessionId: 's1' })
  })

  it('names the reason a send was refused and sends it again with the same id', async () => {
    const failed: Repair = {
      id: 'r-keep',
      packet: '',
      target: { session: 'fix', pane: '%1', sessionId: 's1' },
      basis: currentBasis,
      version: 'a2',
      draftVersion: 'v0',
      sentAt: T,
      state: 'failed',
      reason: 'busy',
    }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [failed] }) })
    expect(screen.getByText(/not sent: the agent was working/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    fireEvent.click(sendButton())
    await settle()
    expect(posts.find((p) => p.url === '/api/return/repair')?.body).toEqual({ session: 'fix', requestId: 'r-keep', preview: expect.any(String), version: 'v0' })
  })

  it('names the refusal of a retry that the host keeps held', async () => {
    const unknown: Repair = { id: 'r-keep', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T, state: 'unknown' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [unknown] }) })
    replies.repair = { status: 409, body: { error: 'refused', code: 'typed', repair: { ...unknown, state: 'held', reason: 'in_prompt' } } }
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await settle()
    expect(screen.getByText("Not tried again: the session's prompt already had text in it. The request may still be waiting in the prompt.")).toBeInTheDocument()
  })

  it('says why a send is of unknown fate when its conversation changed', async () => {
    const old = { session: 'fix', pane: '%1', sessionId: 's-old' }
    const lost: Repair = { id: 'r-1', packet: '', target: old, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T, state: 'unknown', reason: 'other_conversation' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.', currentBasis, { target: old }), draftVersion: 'v0', repairs: [lost] }) })
    expect(screen.getByText("Delivery unknown: a different conversation is now running in that pane, so Devbox can't tell whether it arrived. Edit the draft to send it again.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /use the conversation running now/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send repair to session fix/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /write a follow-up/i })).toBeInTheDocument()
  })

  it('says a retry is of unknown fate, not unsent, when its conversation changed', async () => {
    const held: Repair = { id: 'r-keep', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T, state: 'held', reason: 'typed' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [held] }) })
    replies.repair = { status: 409, body: { error: 'refused', code: 'other_conversation', repair: { ...held, state: 'unknown', reason: 'other_conversation' } } }
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await settle()
    expect(screen.getByText("Not tried again: a different conversation is now running in that pane. Devbox can't tell whether the earlier attempt arrived.")).toBeInTheDocument()
    expect(screen.queryByText(/^Not sent:/)).not.toBeInTheDocument()
  })

  it('says when a delivered repair can no longer be followed, and stops asking the host quickly', async () => {
    const out: Repair = { id: 'r-1', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's-old' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T, state: 'working' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [out] }) })
    expect(screen.getByText(/can't see its conversation in fix now/i)).toBeInTheDocument()
    const base = globalThis.fetch
    let reads = 0
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/return?')) reads += 1
      return base(url, init)
    })
    await settle(5000)
    expect(reads).toBe(0)
    await settle(11000)
    expect(reads).toBe(1)
  })

  it('says a held retry was not tried again when the evidence changed', async () => {
    const held: Repair = { id: 'r-keep', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T, state: 'held', reason: 'typed' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [held] }) })
    replies.repair = { status: 409, body: { error: 'evidence_changed', differences: [] } }
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await settle()
    expect(screen.getByText('Not tried again: the evidence changed since you checked this draft.')).toBeInTheDocument()
  })

  it('names why a retry did not go out without calling it unsent', async () => {
    const held: Repair = { id: 'r-keep', packet: '', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: currentBasis, version: 'a2', draftVersion: 'v0', sentAt: T, state: 'held', reason: 'typed' }
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0', repairs: [held] }) })
    replies.repair = { status: 409, body: { error: 'refused', code: 'not_agent' } }
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await settle()
    expect(screen.getByText("Not tried again: Claude Code isn't in front in that pane.")).toBeInTheDocument()
  })

  it('refuses to accept a result made before a constraint was added', async () => {
    const old: Repair = {
      id: 'r-old',
      packet: '',
      target: { session: 'fix', pane: '%1', sessionId: 's1' },
      basis: currentBasis,
      version: 'a1',
      draftVersion: 'v0',
      sentAt: T + 100,
      state: 'replied',
      reply: 'Done.',
      replyId: 'a1',
    }
    await show({ sessions: [fix([...BASE, rec('u9', 'decision', T + 7700, 'Use at most 3 workers.', 3)])], state: state({ repairs: [old] }) })
    expect(screen.getByRole('button', { name: /accept this result/i })).toBeDisabled()
    expect(screen.getByText(/made before.*at most 3 workers/i)).toBeInTheDocument()
  })

  it('refuses to accept a result made under constraints that changed after it was sent', async () => {
    const old: Repair = {
      id: 'r-old',
      packet: '',
      target: { session: 'fix', pane: '%1', sessionId: 's1' },
      basis: [{ key: 'attempts|max', value: 2, recordId: 'u1' }],
      version: 'a1',
      draftVersion: 'v0',
      sentAt: T + 100,
      state: 'replied',
      reply: 'Done with 2 attempts.',
      replyId: 'a1',
    }
    await show({ state: state({ repairs: [old] }) })
    expect(screen.getByRole('button', { name: /accept this result/i })).toBeDisabled()
    expect(screen.getByText(/made under at most 2 attempts; at most 1 attempt holds now/i)).toBeInTheDocument()
  })
})

describe('questions', () => {
  it('keeps where you stopped and what came since in view while you ask, folding only what holds', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: /ask first \(read-only\)/i }))
    const brief = area(/where you left off/i)
    expect(brief.compareDocumentPosition(area(/ask \(read-only\)/i)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(brief).toHaveTextContent(/^Where you left off.*Stopped atBudget done\. CI fails\.Since you left/)
    expect(within(brief).getByText(/^1 limit/).closest('details')).not.toHaveAttribute('open')
  })

  it('fills the question with what is open, and keeps it as unsent only once you change it', async () => {
    await show({ sessions: [fix(BASE.filter((r) => r.kind !== 'failure'), 'waiting')] })
    fireEvent.click(screen.getByRole('button', { name: /ask first \(read-only\)/i }))
    const box = within(area(/ask \(read-only\)/i)).getByRole('textbox', { name: /your question/i })
    expect(box).toHaveValue(QUESTION_WAITING)
    expect(sessionStorage.getItem('devbox-ask:fix')).toBeNull()
    fireEvent.change(box, { target: { value: 'Which baseline matches my seed?' } })
    expect(sessionStorage.getItem('devbox-ask:fix')).toBe('Which baseline matches my seed?')
    cleanup()
    sessionStorage.clear()
    await show({ sessions: [fix(BASE.filter((r) => r.kind !== 'failure'))] })
    fireEvent.click(screen.getByRole('button', { name: /ask first \(read-only\)/i }))
    expect(within(area(/ask \(read-only\)/i)).getByRole('textbox', { name: /your question/i })).toHaveValue(QUESTION_CATCH_UP)
  })

  it('asks first with a question filled in, and says it is not sent and the draft stays', async () => {
    await show({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    fireEvent.click(screen.getByRole('button', { name: /ask first \(read-only\)/i }))
    const q = area(/ask \(read-only\)/i)
    expect(q).toHaveTextContent('Not sent yet · costs up to about $1')
    expect(within(q).getByRole('button', { name: /send only the question/i })).toHaveClass('primary')
    expect(screen.getByRole('button', { name: /send repair to session fix/i })).not.toHaveClass('primary')
    expect(q).toHaveTextContent('never sees the question, and your draft stays out of it.')
    expect(within(q).getByRole('textbox', { name: /your question/i })).toHaveValue(
      "Using the recorded messages, explain why the latest check still fails and what was tried since I left. Separate facts from guesses, and say what is unknown. Don't change code or run tests.",
    )
    fireEvent.click(within(q).getByRole('button', { name: /send only the question/i }))
    await settle()
    expect(posts.find((p) => p.url === '/api/return/ask')?.body).toMatchObject({ question: expect.stringMatching(/^Using the recorded messages/) })
    expect(posts.some((p) => p.url === '/api/return/repair')).toBe(false)
  })

  const running: Inquiry = { id: 'q-1', question: 'Why 200 ms backoff?', target: { session: 'fix', pane: '%1', sessionId: 's1' }, version: 'a2', askedAt: T + 3 * 86400 - 30, state: 'running' }

  it('keeps a new question apart from an older one that is still running', async () => {
    await show({ state: state({ inquiries: [running] }) })
    const q = area(/ask \(read-only\)/i)
    expect(within(q).getByText('Why 200 ms backoff?').closest('li')).toHaveTextContent(/^Why 200 ms backoff\?running in a read-only copy of fix… · asked \S+ ago$/)
    fireEvent.click(within(q).getByRole('button', { name: /ask another question/i }))
    fireEvent.change(within(q).getByRole('textbox', { name: /your question/i }), { target: { value: 'Is the CI failure flaky?' } })
    expect(within(q).getByText(/not sent/i)).toBeInTheDocument()
    fireEvent.click(within(q).getByRole('button', { name: /send only the question/i }))
    await settle()
    expect(posts.find((p) => p.url === '/api/return/ask')?.body).toEqual({ session: 'fix', inquiryId: expect.stringMatching(/^q-[a-z0-9]+$/), question: 'Is the CI failure flaky?' })
    expect(within(q).getByText('Why 200 ms backoff?').closest('li')).toHaveTextContent(/running/i)
  })

  it('keeps an unsent question across a reload of the page', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: /ask first \(read-only\)/i }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Your question' }), { target: { value: 'Why 12.6 s?' } })
    cleanup()
    await show()
    expect(screen.getByRole('textbox', { name: 'Your question' })).toHaveValue('Why 12.6 s?')
  })

  it('labels an answer as unverified and from the read-only copy, with its cost, and folds older answers', async () => {
    await show({ state: state({ inquiries: [{ ...running, state: 'replied', answer: 'Facts: none recorded.', cost: 1.02, tools: ['Glob', 'Grep', 'Read'], calls: ['Read'] }] }) })
    const item = within(area(/ask \(read-only\)/i)).getByText('Why 200 ms backoff?').closest('li')!
    expect(item).toHaveTextContent(/An answer, not verified · .*Facts: none recorded./)
    expect(item).toHaveTextContent("An answer, not verified · a read-only copy of this conversation wrote it (Read, Grep, Glob), and nothing was run to check it. The original session didn't see this question.")
    expect(item).toHaveTextContent('$1.02')
    cleanup()
    const older = { ...running, id: 'q-0', question: 'Older?', askedAt: running.askedAt - 60, state: 'replied' as const, answer: 'Old answer.' }
    await show({ state: state({ inquiries: [older, { ...running, state: 'replied', answer: 'New answer.' }] }) })
    const old = within(area(/ask \(read-only\)/i)).getByText('Older?').closest('li')!
    expect(within(old).getByText('Show the answer · not verified').closest('details')).not.toHaveAttribute('open')
    expect(area(/ask \(read-only\)/i)).not.toHaveTextContent('word for word')
    cleanup()
    await show({ state: state({ inquiries: [{ ...running, question: 'Why the 200 ms backoff, and does the budget reset between requests?', state: 'replied', answer: 'Facts: the 200 ms backoff has no recorded reason.' }] }) })
    const partial = within(area(/ask \(read-only\)/i)).getByText(/Why the 200 ms backoff/).closest('li') as HTMLElement
    expect(partial).toHaveTextContent("answered · may miss part of your question")
    expect(partial).toHaveTextContent('The answer doesn\'t seem to cover “does the budget reset between requests”.')
    fireEvent.click(within(partial).getByRole('button', { name: 'Ask about that part' }))
    expect(screen.getByRole('textbox', { name: /your question/i })).toHaveValue('does the budget reset between requests?')
    cleanup()
    await show({ state: state({ inquiries: [{ ...running, question: 'Why the 200 ms backoff?', state: 'replied', answer: 'Facts: the 200 ms backoff has no recorded reason.' }] }) })
    expect(within(area(/ask \(read-only\)/i)).getByText('Why the 200 ms backoff?').closest('li')).toHaveTextContent(/^Why the 200 ms backoff\?answered · asked/)
    cleanup()
    await show({ state: state({ inquiries: [{ ...running, question: 'Why does it take 12.6 s?', state: 'replied', answer: 'Unknown.' }, { ...running, id: 'q-2', askedAt: running.askedAt + 60, state: 'replied', answer: 'Facts: none.' }] }) })
    const folded = within(area(/ask \(read-only\)/i)).getByText('Why does it take 12.6 s?').closest('li') as HTMLElement
    expect(within(folded).getByText(/show the answer · not verified/i)).toBeInTheDocument()
    expect(folded).toHaveTextContent('answered · may not address your question')
    expect(folded).toHaveTextContent('The answer may not address your question; it shares too few of its words. Ask about that part')
    expect(folded).toHaveTextContent('An answer, not verified')
    cleanup()
    await show({ state: state({ inquiries: [{ ...older, answer: 'Same answer.' }, { ...running, state: 'replied', answer: 'Same answer.' }] }) })
    expect(within(area(/ask \(read-only\)/i)).getByText('Why 200 ms backoff?').closest('li')).toHaveTextContent('It\'s word for word the answer to “Older?”, so it may not answer this question.')
  })

  it('shows saved records about a question without claiming an answer or touching other questions', async () => {
    await show({
      sessions: [fix([...BASE, rec('u3', 'decision', T + 7600, 'Keep the 200 ms backoff for now.', 3)])],
      state: state({ inquiries: [running] }),
    })
    const q = area(/ask \(read-only\)/i)
    fireEvent.click(within(q).getByRole('button', { name: /ask another question/i }))
    fireEvent.change(within(q).getByRole('textbox', { name: /your question/i }), { target: { value: 'Why the jittered backoff?' } })
    fireEvent.click(within(q).getByRole('button', { name: /or search saved records/i }))
    expect(within(q).getByText(/^Records that mention/)).toHaveTextContent("Records that mention “backoff”. No saved record mentions “jittered”. The question isn't answered or verified.")
    expect(within(q).getByText('Keep the 200 ms backoff for now.')).toBeInTheDocument()
    expect(posts.some((p) => p.url === '/api/return/ask')).toBe(false)
    expect(within(q).getByText('Why 200 ms backoff?').closest('li')).toHaveTextContent(/running/i)
    fireEvent.change(within(q).getByRole('textbox', { name: /your question/i }), { target: { value: 'How many attempts?' } })
    fireEvent.click(within(q).getByRole('button', { name: /or search saved records/i }))
    expect(within(q).getByText('At most 2 attempts, because upstream is rate limiting.').closest('li')).toHaveTextContent('replaced by at most 1 attempt')
  })
})

describe("the work's sessions as tabs", () => {
  const members = [
    { name: 'fix', reason: 'same branch fix/retry in api' },
    { name: 'tests', reason: 'same branch fix/retry in api' },
  ]
  const tabs = () => within(screen.getByRole('navigation', { name: 'In this work' }))
  const form = () => within(screen.getByRole('form', { name: 'New session in this work' }))
  const formEl = () => screen.getByRole('form', { name: 'New session in this work' })

  it('says on a session you showed separately which work it came from, with Undo', async () => {
    await show({ work: { key: 'session:fix', members: [{ name: 'fix', reason: 'you showed it separately' }] }, apart: 'branch:/work/api@fix/retry' })
    expect(screen.getByText(/^You showed fix separately/)).toHaveTextContent('You showed fix separately from the work on branch fix/retry. Undo')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await settle()
    expect(posts).toContainEqual({ url: '/api/return/separate', body: { session: 'fix', work: 'branch:/work/api@fix/retry', member: 'fix', undo: true } })
    cleanup()
    respond({ work: { key: 'session:tests', members: [{ name: 'tests', reason: 'you showed it separately' }] }, apart: 'branch:/work/api@fix/retry' })
    const onSwitch = vi.fn()
    const parent = { session: { name: 'fix', attached: false, clients: 0, activityEpoch: T, bell: false, cmd: 'claude', title: '', path: '/work/api', attachable: true }, insight: { session: 'fix', agent: 'claude' as const, state: 'ready' as const, artifacts: [], commits: 0 }, attention: 'needs' as const, tone: 'error' as const, status: 'Check failed', action: 'Review the failed check', brief: { work: { key: 'branch:/work/api@fix/retry', members: [] } } as unknown as HomeItem['brief'] }
    render(<ReturnView session="tests" works={[parent]} onSwitch={onSwitch} onClose={() => undefined} onOpenTerminal={() => undefined} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await settle()
    expect(onSwitch).toHaveBeenCalledWith('fix', ['tests'], true)
  })

  it('names how the sessions were grouped, and opens why from the title line', async () => {
    await show({ sessions: [fix(), tests()], work: { key: 'branch:/work/api@fix/retry', members } })
    expect(screen.getByText(/2 sessions grouped automatically/)).toBeInTheDocument()
    whyTogether()
    expect(screen.getByRole('dialog', { name: 'Why these sessions are together' })).toHaveTextContent('tests · same branch fix/retry in api')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("opens a session's live terminal under what holds, and keeps it connected while you switch tabs", async () => {
    await show({ sessions: [fix(), tests()], work: { key: 'branch:/work/api@fix/retry', members: members.map((m) => (m.name === 'tests' ? { ...m, goal: 'Cover the budget boundary' } : m)) } })
    fireEvent.click(tabs().getByRole('button', { name: /tests$/ }))
    const bar = screen.getByRole('note')
    expect(bar).toHaveTextContent('Keeps holding while you continue')
    expect(bar).toHaveTextContent('Your goal when you started tests: “Cover the budget boundary”')
    expect(bar).toHaveTextContent('at most 1 attempt')
    expect(bar).toHaveTextContent("What you type here goes straight to tests and isn't checked against these. A repair from the draft is.")
    expect(screen.getByTestId('term-tests')).toHaveAttribute('data-active', 'true')
    expect(screen.queryByRole('navigation', { name: 'Steps' })).toBeNull()
    const records = within(screen.getByRole('complementary', { name: "This work's records" }))
    fireEvent.click(records.getByRole('button', { name: /Linked sessions/ }))
    expect(records.getByText(/same branch fix\/retry in api/)).toBeInTheDocument()
    fireEvent.click(tabs().getByRole('button', { name: 'Changes & decisions' }))
    expect(screen.queryByRole('complementary', { name: "This work's records" })).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Steps' })).toBeInTheDocument()
    expect(screen.getByTestId('term-tests')).toHaveAttribute('data-active', 'false')
  })

  it("answers an agent that waits on you in its terminal, in the work's tab, and keeps the repair second", async () => {
    await show({ sessions: [fix(BASE, 'waiting'), tests()], work: { key: 'branch:/work/api@fix/retry', members } })
    expect(screen.getByText(/fix is waiting for you in its terminal\. Devbox doesn't type into a waiting prompt/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /draft the next step for after you answer/i })).not.toHaveClass('primary')
    fireEvent.click(screen.getByRole('button', { name: /answer in fix's terminal/i }))
    expect(screen.getByTestId('term-fix')).toHaveAttribute('data-active', 'true')
    expect(tabs().getByRole('button', { name: /fix$/ })).toHaveAttribute('aria-current', 'page')
  })

  it('shows a separated session with Undo where you are, not only in the why panel', async () => {
    await show({ sessions: [fix(), tests()], work: { key: 'branch:/work/api@fix/retry', members } })
    whyTogether()
    fireEvent.click(screen.getByRole('button', { name: /show tests separately/i }))
    await settle()
    expect(posts.find((p) => p.url === '/api/return/separate')?.body).toMatchObject({ member: 'tests', undo: false })
    const note = screen.getByText(/tests is shown separately now/).closest('p') as HTMLElement
    fireEvent.click(within(note).getByRole('button', { name: 'Undo' }))
    await settle()
    expect(posts.filter((p) => p.url === '/api/return/separate').at(-1)?.body).toMatchObject({ member: 'tests', undo: true })
    expect(screen.queryByText(/tests is shown separately now/)).toBeNull()
    expect(screen.getByText('tests is back in this work.')).toHaveAttribute('role', 'status')
    fireEvent.click(tabs().getByRole('button', { name: 'New session' }))
    expect(screen.queryByText('tests is back in this work.')).toBeNull()
  })

  it('starts a new conversation beside a session in the work, says it joins this work, and opens it', async () => {
    replies['/api/sessions'] = { status: 201, body: { name: 'fix-claude', created: true } }
    await show({ sessions: [fix(), tests()], work: { key: 'branch:/work/api@fix/retry', members } })
    fireEvent.click(tabs().getByRole('button', { name: 'New session' }))
    fireEvent.click(form().getByRole('radio', { name: /^Claude/ }))
    expect(form().getByRole('combobox', { name: 'Folder' })).toHaveValue('fix')
    expect(formEl()).toHaveTextContent('Session name: fix-claude')
    expect(form().getByRole('status')).toHaveTextContent('Joins “fix”same branch fix/retry in api')
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Add a session to fix')
    expect(within(screen.getByRole('complementary', { name: 'Current context' })).getByText('fix keeps running', { exact: false })).toBeInTheDocument()
    fireEvent.click(form().getByRole('button', { name: 'Create Claude session' }))
    await settle()
    expect(posts.find((p) => p.url === '/api/sessions')?.body).toEqual({ name: 'fix-claude', agent: 'cc', beside: 'fix' })
    expect(tabs().getByRole('button', { name: /fix-claude$/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('term-fix-claude')).toHaveAttribute('data-active', 'true')
  })

  it('says why going back did nothing when the draft could not be saved, on any tab', async () => {
    const onClose = vi.fn()
    await show({ sessions: [fix(), tests()], work: { key: 'branch:/work/api@fix/retry', members }, state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) }, { onClose })
    replies.draft = { status: 500, body: { error: 'return_failed' } }
    fireEvent.change(screen.getByRole('textbox', { name: /repair draft/i }), { target: { value: 'Retry at most 1 attempt per request.\nLog it.' } })
    fireEvent.click(tabs().getByRole('button', { name: /tests$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText("Your last edit isn't saved yet. Go back again to leave without it.")).toBeInTheDocument()
  })

  it('leaves a work it is asked to switch from the way the rail does, saving first', async () => {
    const onSwitch = vi.fn()
    respond({ state: state({ draft: draft('Retry at most 1 attempt per request.'), draftVersion: 'v0' }) })
    const view = render(<ReturnView session="fix" onSwitch={onSwitch} onClose={() => undefined} onOpenTerminal={() => undefined} />)
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: /repair draft/i }), { target: { value: 'Retry at most 1 attempt per request.\nLog it.' } })
    view.rerender(<ReturnView session="fix" onSwitch={onSwitch} onClose={() => undefined} onOpenTerminal={() => undefined} switchTo={{ name: 'search', at: 1 }} />)
    await settle()
    expect(posts.map((p) => p.url)).toEqual(['/api/return/draft', '/api/return/seen'])
    expect(onSwitch).toHaveBeenCalledWith('search', ['fix'])
  })

  it('ignores a switch asked of the work page before it opened', async () => {
    const onSwitch = vi.fn()
    respond({ state: state() })
    render(<ReturnView session="fix" onSwitch={onSwitch} onClose={() => undefined} onOpenTerminal={() => undefined} switchTo={{ name: 'search', at: 1 }} />)
    await settle()
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('hands a session over to its own tab instead of keeping two terminals on it', async () => {
    const onOpenTerminal = vi.fn()
    respond({ sessions: [fix(), tests()], work: { key: 'branch:/work/api@fix/retry', members } })
    render(<ReturnView session="fix" onClose={() => undefined} onOpenTerminal={onOpenTerminal} />)
    await settle()
    fireEvent.click(tabs().getByRole('button', { name: /tests$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open as its own tab' }))
    expect(onOpenTerminal).toHaveBeenCalledWith('tests')
    expect(screen.queryByTestId('term-tests')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Steps' })).toBeInTheDocument()
  })

  it('names a second new session so it does not collide with the first', async () => {
    replies['/api/sessions'] = { status: 201, body: { name: 'fix-claude', created: true } }
    await show({ sessions: [fix(), tests()], work: { key: 'branch:/work/api@fix/retry', members } })
    fireEvent.click(tabs().getByRole('button', { name: 'New session' }))
    fireEvent.click(form().getByRole('radio', { name: /^Claude/ }))
    fireEvent.click(form().getByRole('button', { name: 'Create Claude session' }))
    await settle()
    fireEvent.click(tabs().getByRole('button', { name: 'New session' }))
    expect(formEl()).toHaveTextContent('Session name: fix-claude-2')
    fireEvent.change(form().getByRole('textbox', { name: /Your goal/ }), { target: { value: 'Review the retry budget!' } })
    expect(formEl()).toHaveTextContent('Session name: review-the-retry-budget')
    expect(screen.getByRole('form', { name: 'New session in this work' })).toHaveTextContent("One catch: if fix is ever restarted with devbox --cc, it reopens the newest conversation in that folder, which may be this new one.")
  })

  it("says when a folder's session won't join this work by itself, and won't open a session that was already there", async () => {
    replies['/api/sessions'] = { status: 200, body: { name: 'web-sh', created: false } }
    const web = { ...tests(), name: 'web', path: '/work/web', repo: '/work/web', branch: 'main' }
    await show({ sessions: [fix(), web], work: { key: 'branch:/work/api@fix/retry', members: [members[0], { name: 'web', reason: 'same pull request #9' }] } })
    fireEvent.click(tabs().getByRole('button', { name: 'New session' }))
    fireEvent.click(form().getByRole('radio', { name: /^Shell/ }))
    fireEvent.change(form().getByRole('combobox', { name: 'Folder' }), { target: { value: 'web' } })
    expect(form().getByRole('status')).toHaveTextContent("Opens on its own pageweb's folder is on main, so it won't group by itself")
    expect(formEl()).toHaveTextContent('Session name: web-sh')
    fireEvent.click(form().getByRole('button', { name: 'Create Shell session' }))
    await settle()
    expect(form().getByRole('alert')).toHaveTextContent('A session named web-sh is already running. Describe it differently.')
    expect(screen.queryByTestId('term-web-sh')).toBeNull()
  })
})
