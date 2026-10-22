import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ArtifactsPage } from '../../src/components/ArtifactsPage'
import { NewPage } from '../../src/components/NewSession'
import { Overview } from '../../src/components/Overview'
import { SessionsPage } from '../../src/components/SessionsPage'
import type { HomeItem } from '../../src/components/work'
import type { AgentInsight, Session } from '../../src/shared/types'

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
  path: `/home/me/work/${name}`,
  attachable: true,
  ...over,
})

const agent = (name: string, over: Partial<AgentInsight> = {}): AgentInsight => ({ session: name, agent: 'claude', state: 'ready', artifacts: [], commits: 0, ...over })

const SESSIONS = [
  session('notes', { cmd: 'zsh', activityEpoch: sec(5) }),
  session('fix', { activityEpoch: sec(30) }),
  session('review', { cmd: 'codex', activityEpoch: sec(40) }),
  session('ask', { activityEpoch: sec(300) }),
]

const INSIGHTS = new Map(
  [
    agent('fix', {
      title: 'Fix API retry',
      artifacts: [{ label: 'PR', url: 'https://github.com/o/r/pull/184', at: sec(100), first: sec(900), hits: 3, said: true, action: 'created' }],
      files: [{ path: '/home/me/work/fix/plan.md', action: 'created', at: sec(200), count: 1, gone: false }],
    }),
    agent('review', { agent: 'codex', title: 'Review retry budget', state: 'working', since: sec(50) }),
    agent('ask', { title: 'Search evaluation', state: 'waiting', waitingFor: 'question', since: sec(300) }),
  ].map((a) => [a.session, a]),
)

const item = (name: string, attention: HomeItem['attention'], members: string[] = [name]): HomeItem => ({
  session: SESSIONS.find((s) => s.name === name) as Session,
  insight: INSIGHTS.get(name) as AgentInsight,
  attention,
  tone: attention === 'needs' ? 'waiting' : 'fresh',
  status: attention === 'needs' ? 'Question' : 'New turn',
  action: 'See what changed',
  brief: {
    brief: { holds: [], rules: [], suggestions: [], unexplained: [] },
    work: { key: 'pr:https://github.com/o/r/pull/184', members: members.map((m) => ({ name: m, reason: '' })) },
    agents: {},
  } as unknown as HomeItem['brief'],
})

const WORKS = [item('ask', 'needs'), item('fix', 'new', ['fix', 'review'])]

function sessions(over: Partial<Parameters<typeof SessionsPage>[0]> = {}) {
  const props = { sessions: SESSIONS, insights: INSIGHTS, now: NOW, seenAt: () => sec(1000), returns: {}, host: 'box', works: WORKS, visible: true, onOpen: vi.fn(), onBack: vi.fn(), ...over }
  render(<SessionsPage {...props} />)
  return props
}

const rows = () => screen.getAllByRole('listitem').map((li) => within(li).getByRole('button'))

describe('All sessions', () => {
  it('lists every session with its agent, title, host and path, its work, and its state, the ones needing you first', () => {
    sessions()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('All sessions 4')
    expect(rows().map((r) => r.getAttribute('data-session'))).toEqual(['ask', 'review', 'fix', 'notes'])
    const [ask, review, fix, notes] = rows()
    expect(ask).toHaveTextContent('Search evaluation')
    expect(ask).toHaveTextContent('ask · box · /home/me/work/ask')
    expect(ask).toHaveTextContent('Waiting on you: question')
    expect(review).toHaveTextContent('Fix API retry')
    expect(review).toHaveTextContent('Working')
    expect(within(review).getByLabelText('Codex')).toBeInTheDocument()
    expect(review).toHaveTextContent('Codex: no brief or repair yet')
    expect(ask).not.toHaveTextContent('no brief or repair yet')
    expect(fix).toHaveTextContent('Fix API retry')
    expect(notes).toHaveTextContent('Nothing new')
    expect(within(notes).getByText('Idle')).toBeInTheDocument()
    expect(within(notes).getByLabelText('Shell')).toBeInTheDocument()
  })

  it("shows a session's repair or question state before its agent state", () => {
    sessions({ returns: { fix: { draft: false, repair: 'replied', asking: 0, answered: 0 } }, works: [WORKS[0], { ...WORKS[1], attention: 'needs' }] })
    expect(rows()[0]).toHaveAttribute('data-session', 'fix')
    expect(rows()[0]).toHaveTextContent('Repair replied, review it')
    expect(rows()[0].querySelector('.page-row-state')).toHaveAttribute('data-lane', 'blocked')
    expect(rows()[0].querySelector('.page-row-state')).not.toHaveAttribute('data-tone')
    cleanup()
    sessions({ works: [WORKS[0], { ...WORKS[1], attention: 'needs', tone: 'error', status: 'Check failed' }] })
    expect(rows()[0].querySelector('.page-row-state')).toHaveAttribute('data-tone', 'error')
    cleanup()
    sessions({ returns: { fix: { draft: false, accepted: true, asking: 0, answered: 0 } } })
    expect(rows()[2]).toHaveTextContent('Result accepted · merge is still yours')
    cleanup()
    sessions({ returns: { fix: { draft: false, repair: 'working', asking: 1, answered: 0 } } })
    expect(rows()[2]).toHaveTextContent('Waiting on the agent · Question running')
    cleanup()
    sessions({ returns: { notes: { draft: false, goal: 'Add boundary tests for the budget', asking: 0, answered: 0 } } })
    expect(rows()[3]).toHaveTextContent('Your goal: Add boundary tests for the budget')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sessions' }), { target: { value: 'boundary tests' } })
    expect(rows().map((r) => r.getAttribute('data-session'))).toEqual(['notes'])
  })

  it('filters by name, title, path and work, and counts what is left', () => {
    sessions()
    const search = screen.getByRole('searchbox', { name: 'Search sessions' })
    fireEvent.change(search, { target: { value: 'api retry' } })
    expect(rows().map((r) => r.getAttribute('data-session'))).toEqual(['review', 'fix'])
    expect(screen.getByText('2 results')).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'NOTES' } })
    expect(screen.getByText('1 result')).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'nothing here' } })
    expect(screen.getByText('0 results')).toBeInTheDocument()
  })

  it('opens a row on click, moves with j and k, and goes back to Now', () => {
    const props = sessions()
    fireEvent.click(rows()[1])
    expect(props.onOpen).toHaveBeenCalledWith('review')
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(rows()[0]).toHaveFocus()
    fireEvent.keyDown(rows()[0], { key: 'j' })
    expect(rows()[1]).toHaveFocus()
    fireEvent.keyDown(rows()[1], { key: 'k' })
    expect(rows()[0]).toHaveFocus()
    screen.getByRole('searchbox').focus()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'j' })
    expect(screen.getByRole('searchbox')).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' })
    expect(rows()[0]).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    expect(props.onBack).toHaveBeenCalled()
  })

  it('leaves keys alone while hidden', () => {
    sessions({ visible: false })
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(document.body).toHaveFocus()
  })
})

describe('Artifacts', () => {
  const artifacts = (over: Partial<Parameters<typeof ArtifactsPage>[0]> = {}) => {
    const props = { sessions: SESSIONS, insights: INSIGHTS, now: NOW, works: WORKS, onOpen: vi.fn(), onBack: vi.fn(), ...over }
    render(<ArtifactsPage {...props} />)
    return props
  }

  it('lists each pull request and file the records name with where it came from, and opens its work', () => {
    const props = artifacts()
    const pr = screen.getByRole('button', { name: /^PR #184/ })
    expect(pr).toHaveTextContent('Fix API retry · fix · created · 15m ago')
    fireEvent.click(pr)
    expect(props.onOpen).toHaveBeenCalledWith('fix')
    expect(screen.getByRole('link', { name: /Open PR #184/ })).toHaveAttribute('href', 'https://github.com/o/r/pull/184')
    expect(screen.getByRole('link', { name: /Open PR #184/ })).toHaveAttribute('target', '_blank')
    expect(screen.getByRole('button', { name: /^plan\.md/ })).toHaveTextContent('Fix API retry · fix · created · 3m ago')
  })

  it("says what each session did with a pull request several sessions name, from the first", () => {
    const PR = { label: 'PR', url: 'https://github.com/o/r/pull/184', at: sec(100), hits: 1, said: true }
    artifacts({
      insights: new Map([
        ['fix', agent('fix', { title: 'Fix API retry', artifacts: [{ ...PR, first: sec(900), action: 'created' }] })],
        ['review', agent('review', { artifacts: [{ ...PR, first: sec(300), action: 'reviewed' }] })],
      ]),
    })
    expect(screen.getByRole('button', { name: /^PR #184/ })).toHaveTextContent('Fix API retry · fix created 15m ago, review reviewed 5m ago')
  })

  it('opens a link from a session that is still running when the newest one to name it has ended', () => {
    const PR = { label: 'PR', url: 'https://github.com/o/r/pull/9', at: sec(10), hits: 1, said: true }
    const props = artifacts({
      sessions: [session('gone', { attachable: false }), session('live')],
      insights: new Map([
        ['gone', agent('gone', { artifacts: [{ ...PR, first: sec(20) }] })],
        ['live', agent('live', { artifacts: [{ ...PR, first: sec(500) }] })],
      ]),
    })
    const row = screen.getByRole('button', { name: /^PR #9/ })
    expect(row).toHaveTextContent('live 8m ago, gone 20s ago')
    fireEvent.click(row)
    expect(props.onOpen).toHaveBeenCalledWith('live')
  })

  it('previews a file', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
    artifacts()
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan.md' }))
    expect(screen.getByRole('dialog', { name: 'plan.md' })).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('says when the records name nothing yet', () => {
    artifacts({ insights: new Map() })
    expect(screen.getByText('No pull requests, reviews or files in the records yet.')).toBeInTheDocument()
  })
})

describe('Now', () => {
  const home = (over: Partial<Parameters<typeof Overview>[0]> = {}) => {
    const props = { sessions: SESSIONS, insights: INSIGHTS, now: NOW, seenAt: () => sec(1000), pickups: WORKS, visited: [], onOpen: vi.fn(), onPickUp: vi.fn(), onAll: vi.fn(), ...over }
    render(<Overview {...props} />)
    return props
  }

  it("dates the page and counts what needs you, what's new and what waits", () => {
    home()
    const region = screen.getByRole('region', { name: /pick up where you left off/i })
    expect(region).toHaveTextContent('1 needs you · 1 new since you looked')
    expect(screen.getByText(new Intl.DateTimeFormat().resolvedOptions().timeZone)).toBeInTheDocument()
    cleanup()
    home({ host: 'box', connected: false })
    expect(screen.getByText(/Not reaching box · 4 sessions/)).toBeInTheDocument()
  })

  it('says you can leave when nothing needs you and nothing is new', () => {
    home({ pickups: [], sessions: SESSIONS.filter((x) => x.name !== 'ask') })
    expect(screen.getByRole('region', { name: /pick up where you left off/i })).toHaveTextContent('You can leave now: nothing needs you and nothing is new.')
  })

  it("doesn't say you can leave while a session outside the list needs you", () => {
    home({ pickups: [] })
    expect(screen.getByRole('region', { name: /pick up where you left off/i })).toHaveTextContent('Nothing listed here needs you, but other sessions do.')
  })

  it('folds the other sessions into one row that opens All sessions', () => {
    const props = home()
    const all = screen.getByRole('button', { name: /View all/ })
    expect(all).toHaveTextContent('1 other session · none need you · View all')
    fireEvent.click(all)
    expect(props.onAll).toHaveBeenCalled()
  })

  it('keeps the works you went back from this visit, to reopen one', () => {
    const props = home({ pickups: [WORKS[0]], visited: ['fix'] })
    const seen = screen.getByText(/Seen this visit/).closest('details') as HTMLElement
    expect(seen.querySelector('summary')).toHaveTextContent('Seen this visit 1')
    expect(seen).not.toHaveAttribute('open')
    fireEvent.click(within(seen).getByRole('button', { name: 'Fix API retry' }))
    expect(props.onPickUp).toHaveBeenCalledWith('fix')
    cleanup()
    home({ pickups: [WORKS[0]], visited: ['fix'], returns: { fix: { draft: false, accepted: true, asking: 0, answered: 0 } }, covered: ['fix', 'review'] })
    expect(screen.getByText(/Seen this visit/).closest('details')).toHaveAttribute('open')
    expect(screen.getByRole('button', { name: /View all/ })).toHaveTextContent('1 other session')
  })
})

describe('New session page', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const page = async (roots = [{ name: 'work', localPath: '/home/me/Work' }]) => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url === '/api/workspaces' ? json({ roots, workspaces: [{ root: 'work', name: 'claude', mtime: 0 }] }) : init?.method === 'POST' ? json({ name: 'x', created: true }, 201) : json({}, 404),
    )
    vi.stubGlobal('fetch', fetch)
    const props = { taken: ['claude-2'], host: 'box', onCreated: vi.fn(), onBack: vi.fn() }
    render(<NewPage {...props} />)
    await screen.findByRole('form', { name: 'New session' })
    return { ...props, posts: () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body))) }
  }

  it('starts a session in a new folder under a sync root, named after the goal or the agent, never over a folder or session already there', async () => {
    const p = await page()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Start another piece of work')
    expect(screen.getByRole('status')).toHaveTextContent('Opens on its own page')
    expect(screen.getByText('Session name: claude-3')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: /Your goal/ }), { target: { value: 'Make the total deadline test pass within 10 s' } })
    expect(screen.getByText('Session name: make-the-total-deadline-test')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: /Your goal/ }), { target: { value: 'Try the new ranker' } })
    fireEvent.click(screen.getByRole('radio', { name: /Codex/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create Codex session' }))
    await vi.waitFor(() => expect(p.onCreated).toHaveBeenCalledWith('try-the-new-ranker', 'codex'))
    expect(p.posts()).toEqual([{ name: 'try-the-new-ranker', agent: 'codex', root: 'work', goal: 'Try the new ranker' }])
    vi.unstubAllGlobals()
  })

  it('says so when there is no sync root to start in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ roots: [], workspaces: [] })))
    render(<NewPage taken={[]} host="box" onCreated={vi.fn()} onBack={vi.fn()} />)
    expect(await screen.findByText(/No sync root is set up/)).toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})
