import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

vi.mock('../../src/components/Terminal', () => ({
  TerminalPane: ({ name, side, note }: { name: string; side?: ReactNode; note?: ReactNode }) => (
    <div data-testid={`term-${name}`}>
      {note}
      {side}
    </div>
  ),
}))

vi.mock('../../src/components/WorkspacePalette', () => ({
  WorkspacePalette: ({ onOpen, onNew }: { onOpen: (name: string) => void; onNew: () => void }) => (
    <>
      <button type="button" data-testid="palette" onClick={() => onOpen('from-palette')}>
        palette
      </button>
      <button type="button" onClick={onNew}>
        New session
      </button>
    </>
  ),
}))

import { App } from '../../src/App'
import { initToken } from '../../src/token'
import { markSeen } from '../../src/insights'
import type { AgentInsight, ReturnSummary, Session, SessionsResponse } from '../../src/shared/types'

const NOW_EPOCH = 1800000000

function session(overrides: Partial<Session>): Session {
  return {
    name: 'main',
    attached: false,
    clients: 0,
    activityEpoch: NOW_EPOCH - 30,
    bell: false,
    cmd: 'zsh',
    title: '',
    path: '/home/me',
    attachable: true,
    ...overrides,
  }
}

const ROWS: Session[] = [
  session({ name: 'cc-demo', activityEpoch: NOW_EPOCH - 10, title: '✳ Fix the flaky retry test', cmd: 'claude' }),
  session({ name: 'api', activityEpoch: NOW_EPOCH - 20 }),
  session({ name: 'main', activityEpoch: NOW_EPOCH - 40 }),
]

function response(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function okBody(sessions: Session[]): SessionsResponse {
  return { host: 'stub-host', fetchedAt: Date.now(), sessions }
}

type FetchMock = Mock<(url: string, init: RequestInit) => Promise<Response>>

const solo = (name: string, agent = 'shell', records: object[] = []) =>
  response({
    session: name,
    host: 'stub-host',
    fetchedAt: Date.now(),
    work: { key: `session:${name}`, members: [{ name, reason: 'only session in this work' }] },
    sessions: [{ name, pane: '%1', cmd: agent === 'shell' ? 'zsh' : agent, agent, path: '/x', records }],
    state: { key: `session:${name}`, draft: null, draftVersion: '', repairs: [], inquiries: [], decisions: {}, separations: [] },
    separated: [],
    lookalikes: [],
  })

let fetchMock: FetchMock
let summaryBody: Record<string, ReturnSummary> = {}
let insightsMock: FetchMock

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(NOW_EPOCH * 1000)
  sessionStorage.setItem('devbox-web-token', 'tok')
  history.replaceState(null, '', '/#t=tok')
  initToken()
  localStorage.clear()
  fetchMock = vi.fn()
  summaryBody = {}
  insightsMock = vi.fn(async () => response({ fetchedAt: Date.now(), agents: [] }))
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) =>
    url === '/api/theme'
      ? response({ ghostty: null })
      : url === '/api/return/summary'
        ? response({ sessions: summaryBody })
        : url === '/api/notes'
          ? response({ days: [] })
          : url.startsWith('/api/notes/')
            ? response({ day: url.slice(11), text: '' })
            : url === '/api/insights'
              ? insightsMock(url, init)
              : url.startsWith('/api/return?')
                ? fetchMock(url, init).then(async (r) => (r.status === 200 && !('work' in ((await r.clone().json()) as object)) ? solo(new URL(url, 'http://x').searchParams.get('session') ?? '') : r))
                : fetchMock(url, init),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  sessionStorage.clear()
})

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

const sidebar = () => within(screen.getByRole('navigation', { name: 'sessions' }))
async function ownTab(name: string) {
  fireEvent.click(sidebar().getByRole('button', { name: new RegExp(`^${name}`) }))
  await flush()
  await flush()
  fireEvent.click(within(screen.getByRole('region', { name: `Pick up ${name}` })).getByRole('button', { name: 'Open as its own tab' }))
  await flush()
}
async function showAll() {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('button', { name: /^All sessions/ }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}
const row = (name: string) => document.querySelector(`[data-row][data-session="${name}"]`)
const status = Object.assign(() => screen.getByRole('region', { name: 'connection status' }), {
  query: () => screen.queryByRole('region', { name: 'connection status' }),
})

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('App', () => {
  it('shows a loading state before the first response', () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined))
    render(<App />)
    expect(screen.getByText('Loading sessions…')).toBeInTheDocument()
  })

  it('lays out a sidebar of sessions beside the overview', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    expect(screen.getByRole('heading', { name: /devbox/ })).toHaveTextContent('stub-host')
    expect(sidebar().getAllByRole('button')).toHaveLength(3)
    expect(screen.getByRole('region', { name: 'overview' })).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    )
  })

  it('opens a session from the sidebar on a page of its own, at its terminal, and marks that session current', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    fireEvent.click(sidebar().getByRole('button', { name: /cc-demo/ }))
    await flush()
    await flush()
    expect(within(screen.getByRole('region', { name: 'Pick up cc-demo' })).getByTestId('term-cc-demo')).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'cc-demo' })).toBeNull()
    expect(sidebar().getByRole('button', { name: /cc-demo/ })).toHaveAttribute('aria-current', 'true')
  })

  it('opening a shell from the palette opens it on a page of its own, at its terminal', async () => {
    fetchMock.mockImplementation(async (url) => (url.startsWith('/api/return?') ? solo('from-palette') : url.startsWith('/api/return') ? response({}) : response(okBody(ROWS))))
    render(<App />)
    await flush()
    fireEvent.click(screen.getByTestId('palette'))
    await flush()
    expect(within(screen.getByRole('region', { name: 'Pick up from-palette' })).getByTestId('term-from-palette')).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'from-palette' })).toBeNull()
  })

  it("opening a Claude session from the palette opens it inside its work, as All sessions does", async () => {
    const rows = [session({ name: 'from-palette', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 })]
    fetchMock.mockImplementation(async (url) => {
      if (url.startsWith('/api/return?'))
        return response({
          session: 'from-palette',
          host: 'stub-host',
          fetchedAt: Date.now(),
          work: { key: 'session:from-palette', members: [{ name: 'from-palette', reason: 'only session in this work' }] },
          sessions: [{ name: 'from-palette', pane: '%1', cmd: 'claude', agent: 'claude', path: '/x', records: [] }],
          state: { key: 'session:from-palette', draft: null, draftVersion: '', repairs: [], inquiries: [], decisions: {}, separations: [] },
          separated: [],
          lookalikes: [],
        })
      if (url.startsWith('/api/return')) return response({ error: 'return_failed' }, 500)
      return response(okBody(rows))
    })
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [{ session: 'from-palette', agent: 'claude', state: 'ready', artifacts: [], commits: 0 }] }))
    render(<App />)
    await flush()
    fireEvent.click(screen.getByTestId('palette'))
    await flush()
    expect(screen.getByRole('region', { name: 'Pick up from-palette' })).toBeVisible()
    expect(screen.queryByTestId('term-from-palette')).toBeNull()
  })

  it('starts a session from the New session page and opens its terminal', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/workspaces'
        ? response({ roots: [{ name: 'work', localPath: '/home/me/Work' }], workspaces: [] })
        : init?.method === 'POST'
          ? response({ name: 'claude', created: true }, 201)
          : url.startsWith('/api/return?')
            ? response({
                session: 'claude',
                host: 'stub-host',
                fetchedAt: Date.now(),
                work: { key: 'session:claude', members: [{ name: 'claude', reason: 'only session in this work' }] },
                sessions: [{ name: 'claude', pane: '%1', cmd: 'claude', agent: 'claude', path: '/x', records: [] }],
                state: { key: 'session:claude', draft: null, draftVersion: '', repairs: [], inquiries: [], decisions: {}, separations: [] },
                separated: [],
                lookalikes: [],
              })
            : url.startsWith('/api/return')
              ? response({ error: 'return_failed' }, 500)
              : response(okBody(ROWS)),
    )
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    await flush()
    expect(screen.getByRole('heading', { name: 'Start another piece of work' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create Claude session' }))
    await flush()
    await flush()
    expect(within(screen.getByRole('region', { name: 'Pick up claude' })).getByTestId('term-claude')).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'claude' })).toBeNull()
  })

  it('closing the active tab activates its neighbour instead of showing nothing', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    await ownTab('cc-demo')
    await ownTab('api')
    await ownTab('main')
    fireEvent.click(screen.getByTitle('Close main'))
    expect(screen.getByRole('tab', { name: 'api' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByTitle('Close cc-demo'))
    expect(screen.getByRole('tab', { name: 'api' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByTitle('Close api'))
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Pick up main' })).toBeVisible()
  })

  it('shows what each agent is doing, opens a Claude session on its work page and a shell in its terminal', async () => {
    const waiting: AgentInsight = {
      session: 'cc-demo',
      agent: 'claude',
      state: 'waiting',
      waitingFor: 'permission prompt',
      since: NOW_EPOCH - 120,
      title: 'Fix flaky retry test',
      summary: 'Fix is up as PR 31; waiting on CI.',
      artifacts: [
        { label: 'PR', url: 'https://github.com/o/r/pull/31', at: NOW_EPOCH - 200, first: NOW_EPOCH - 300, hits: 2, said: true, action: 'created' },
      ],
      commits: 1,
    }
    fetchMock.mockImplementation(async (url) =>
      url.startsWith('/api/return?session=api') ? solo('api') : url.startsWith('/api/return') ? response({ error: 'return_failed' }, 500) : response(okBody(ROWS)),
    )
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [waiting] }))
    render(<App />)
    await flush()
    expect(within(document.querySelector('.sidebar') as HTMLElement).getByRole('navigation', { name: 'Work' })).toHaveTextContent(/Fix flaky retry test.*Permission prompt/)
    expect(sidebar().queryByRole('button', { name: /cc-demo/ })).toBeNull()
    await showAll()
    expect(row('cc-demo')).toHaveTextContent('Fix flaky retry test')
    expect(row('cc-demo')).toHaveTextContent('Waiting on you: permission prompt')
    fireEvent.click(row('cc-demo') as HTMLElement)
    await flush()
    expect(screen.getByRole('region', { name: 'Pick up cc-demo' })).toBeVisible()
    await showAll()
    fireEvent.click(row('api') as HTMLElement)
    await flush()
    await flush()
    expect(within(screen.getByRole('region', { name: 'Pick up api' })).getByTestId('term-api')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Back to All sessions' })).toBeInTheDocument()
  })

  it('opens a file from Artifacts beside its terminal', async () => {
    const ready: AgentInsight = {
      session: 'cc-demo',
      agent: 'claude',
      state: 'ready',
      title: 'Fix flaky retry test',
      artifacts: [],
      commits: 0,
      files: [{ path: '/home/me/plan.md', action: 'created', at: NOW_EPOCH - 60, count: 1, gone: false }],
    }
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('/api/file')
        ? response({ path: '/home/me/plan.md', size: 6, mtime: NOW_EPOCH - 60, kind: 'text', text: '# Plan', truncated: false })
        : response(okBody(ROWS)),
    )
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [ready] }))
    render(<App />)
    await flush()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('button', { name: 'Artifacts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan.md' }))
    await flush()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'plan.md' })).getByRole('button', { name: 'Open beside terminal' }))
    await flush()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('cc-demo')
    expect(within(screen.getByTestId('term-cc-demo')).getByRole('complementary', { name: 'plan.md' })).toBeInTheDocument()
  })

  it('counts a turn that finished while you watched it in the terminal as seen', async () => {
    const turn = (turnAt: number): AgentInsight => ({ session: 'cc-demo', agent: 'claude', state: 'ready', turnAt, title: 'Fix it', artifacts: [], commits: 0 })
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    insightsMock.mockImplementationOnce(async () => response({ fetchedAt: Date.now(), agents: [turn(NOW_EPOCH - 60)] }))
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [turn(NOW_EPOCH - 5)] }))
    render(<App />)
    await flush()
    const home = () => screen.getByRole('region', { name: /pick up where you left off/i })
    expect(home()).toHaveTextContent('New since you looked 1')
    fireEvent.click(screen.getByRole('button', { name: "Open cc-demo's terminal" }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15100)
    })
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('button', { name: 'Now' }))
    await flush()
    await flush()
    expect(home()).toHaveTextContent('You can leave now')
  })

  it('keeps reading briefs for the home list when a session changes while its brief is being read', async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 }), session({ name: 'b', cmd: 'claude', activityEpoch: NOW_EPOCH - 20 })]
    const waiting = (name: string, since: number): AgentInsight => ({ session: name, agent: 'claude', state: 'waiting', since, artifacts: [], commits: 0 })
    let release = () => undefined as void
    const asked: string[] = []
    fetchMock.mockImplementation(async (url) => {
      if (!url.startsWith('/api/return/brief')) return response(okBody(rows))
      const name = new URL(url, 'http://x').searchParams.get('session') ?? ''
      asked.push(name)
      if (asked.length === 1) await new Promise<void>((done) => (release = done))
      return response({ session: name, work: { key: `session:${name}`, members: [{ name, reason: 'only session in this work' }] }, agents: {}, brief: { suggestions: [], unexplained: [], holds: [], rules: [] } })
    })
    insightsMock.mockImplementationOnce(async () => response({ fetchedAt: Date.now(), agents: [waiting('a', NOW_EPOCH - 100), waiting('b', NOW_EPOCH - 100)] }))
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [waiting('a', NOW_EPOCH - 50), waiting('b', NOW_EPOCH - 100)] }))
    render(<App />)
    await flush()
    expect(asked).toEqual(['a'])
    await advance(16000)
    release()
    await flush()
    await flush()
    expect(asked).toEqual(['a', 'a', 'b'])
  })

  it('keeps reading a work you looked at this visit, so a failed check you did not act on stays under Needs you', async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 4000 })]
    markSeen(['a'], () => NOW_EPOCH - 10, Date.now())
    summaryBody = { a: { draft: false, looked: NOW_EPOCH - 60, asking: 0, answered: 0 } }
    const failing = { id: 'f1', kind: 'failure', author: 'tool', at: NOW_EPOCH - 5000, text: 'FAIL keeps total deadline', session: 'a' }
    fetchMock.mockImplementation(async (url) =>
      url.startsWith('/api/return/brief')
        ? response({ session: 'a', work: { key: 'session:a', members: [{ name: 'a', reason: '' }] }, agents: { a: 'claude' }, brief: { leftAt: NOW_EPOCH - 90000, failing, suggestions: [], unexplained: [], holds: [], rules: [] } })
        : response(okBody(rows)),
    )
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [{ session: 'a', agent: 'claude', state: 'ready', turnAt: NOW_EPOCH - 4000, title: 'Fix it', artifacts: [], commits: 0 }] }))
    render(<App />)
    await flush()
    await advance(100)
    expect(screen.getByRole('region', { name: /pick up where you left off/i })).toHaveTextContent(/Needs you 1.*Check failed/)
  })

  it.each(['waiting', 'error'])('counts what needs you the same on the Now tab, the page and the sidebar, marking it by what it is (%s)', async (state) => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 }), session({ name: 'b', cmd: 'claude', activityEpoch: NOW_EPOCH - 20 }), session({ name: 'sh', cmd: 'zsh' })]
    summaryBody = { a: { draft: false, repair: 'replied', asking: 0, answered: 0 } }
    fetchMock.mockImplementation(async () => response(okBody(rows)))
    insightsMock.mockImplementation(async () =>
      response({ fetchedAt: Date.now(), agents: [{ session: 'a', agent: 'claude', state: 'ready', turnAt: NOW_EPOCH - 4000, title: 'A', artifacts: [], commits: 0 }, { session: 'b', agent: 'claude', state, since: NOW_EPOCH - 100, title: 'B', artifacts: [], commits: 0 }] }),
    )
    render(<App />)
    await flush()
    await advance(100)
    expect(screen.getByRole('region', { name: /pick up where you left off/i })).toHaveTextContent(/Needs you 2/)
    await ownTab('sh')
    expect(screen.getAllByRole('tab')[0]).toHaveAccessibleDescription('2 need you')
    expect(screen.getAllByRole('tab')[0].closest('.tab')?.querySelector('.state-icon')).toHaveAttribute('data-tone', state)
    expect(within(within(document.querySelector('.sidebar') as HTMLElement).getByRole('navigation', { name: 'Work' })).getByText(/^Needs you/)).toHaveTextContent('Needs you 2')
    expect(sidebar().queryByRole('group', { name: /Needs you/ })).toBeNull()
  })

  it('lists a work under Not sent yet while a question you wrote there is not sent', async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 4000 })]
    markSeen(['a'], () => NOW_EPOCH - 10, Date.now())
    sessionStorage.setItem('devbox-ask:a', 'Why does the deadline check fail?')
    fetchMock.mockImplementation(async () => response(okBody(rows)))
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [{ session: 'a', agent: 'claude', state: 'ready', turnAt: NOW_EPOCH - 4000, title: 'Fix it', artifacts: [], commits: 0 }] }))
    render(<App />)
    await flush()
    await advance(100)
    expect(screen.getByRole('region', { name: /pick up where you left off/i })).toHaveTextContent(/Not sent yet 1.*Question not sent/)
  })

  it('tries a brief again a minute after reading it failed', async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 })]
    const asked: string[] = []
    fetchMock.mockImplementation(async (url) => {
      if (!url.startsWith('/api/return/brief')) return response(okBody(rows))
      asked.push('a')
      return response({ error: 'remote_unreachable', message: 'x' }, 502)
    })
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [{ session: 'a', agent: 'claude', state: 'waiting', since: NOW_EPOCH - 100, artifacts: [], commits: 0 }] }))
    render(<App />)
    await flush()
    await advance(30000)
    expect(asked).toEqual(['a'])
    await advance(31000)
    expect(asked).toEqual(['a', 'a'])
  })

  it('folds the sessions the list leaves out into one line that counts them', async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 }), session({ name: 'b', cmd: 'zsh' }), session({ name: 'c', cmd: 'zsh' })]
    fetchMock.mockImplementation(async (url) => (url.startsWith('/api/return') ? response({ error: 'return_failed' }, 500) : response(okBody(rows))))
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [{ session: 'a', agent: 'claude', state: 'waiting', since: NOW_EPOCH - 100, artifacts: [], commits: 0 }] }))
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /View all$/ }))
    expect(screen.getByRole('heading', { name: 'All sessions 3' })).toBeInTheDocument()
  })

  it('reads a brief again after you leave its work page, even if an older read was still on its way', async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 })]
    let release = () => undefined as void
    const asked: string[] = []
    fetchMock.mockImplementation(async (url) => {
      if (url.startsWith('/api/return?')) return response({ error: 'return_failed' }, 500)
      if (!url.startsWith('/api/return/brief')) return response(okBody(rows))
      asked.push('a')
      if (asked.length === 1) await new Promise<void>((done) => (release = done))
      return response({ session: 'a', work: { key: 'session:a', members: [{ name: 'a', reason: 'only session in this work' }] }, agents: {}, brief: { suggestions: [], unexplained: [], holds: [], rules: [] } })
    })
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [{ session: 'a', agent: 'claude', state: 'waiting', since: NOW_EPOCH - 100, artifacts: [], commits: 0 }] }))
    render(<App />)
    await flush()
    fireEvent.click(within(screen.getByRole('region', { name: /pick up where you left off/i })).getByRole('button', { name: /answer the question/i }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await flush()
    release()
    await flush()
    await flush()
    expect(asked).toEqual(['a', 'a'])
  })

  const work = (later: number | null, own: number | null = null) => async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 }), session({ name: 'b', cmd: 'claude', activityEpoch: NOW_EPOCH - 20 })]
    const members = [{ name: 'a', reason: '' }, { name: 'b', reason: '' }]
    fetchMock.mockImplementation(async (url) => {
      if (url.startsWith('/api/return?'))
        return response({
          session: 'a',
          host: 'stub-host',
          fetchedAt: Date.now(),
          work: { key: 'pr:x', members },
          sessions: [{ name: 'a', pane: '%1', cmd: 'claude', agent: 'claude', path: '/x', records: [] }],
          state: { key: 'session:a', draft: null, draftVersion: '', repairs: [], inquiries: [], decisions: {}, separations: [] },
          separated: [],
          lookalikes: [],
        })
      if (url.startsWith('/api/return/brief')) return response({ session: 'a', work: { key: 'pr:x', members }, agents: {}, brief: { suggestions: [], unexplained: [], holds: [], rules: [] } })
      return response(okBody(rows))
    })
    const turn = (name: string, at: number): AgentInsight => ({ session: name, agent: 'claude', state: 'ready', turnAt: at, title: name, artifacts: [], commits: 0 })
    insightsMock.mockImplementationOnce(async () => response({ fetchedAt: Date.now(), agents: [turn('a', NOW_EPOCH - 10), turn('b', NOW_EPOCH - 20)] }))
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [turn('a', own ?? NOW_EPOCH - 10), turn('b', later ?? NOW_EPOCH - 20)] }))
    render(<App />)
    await flush()
    await flush()
    const home = () => screen.getByRole('region', { name: /pick up where you left off/i })
    expect(within(home()).getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(within(home()).getByRole('button', { name: /see what changed/i }))
    await flush()
    await advance(16000)
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await flush()
    return home
  }

  it('reads the brief again after each visit to its work page', async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 })]
    const members = [{ name: 'a', reason: '' }]
    let asked = 0
    fetchMock.mockImplementation(async (url) => {
      if (url.startsWith('/api/return?'))
        return response({
          session: 'a',
          host: 'stub-host',
          fetchedAt: Date.now(),
          work: { key: 'session:a', members },
          sessions: [{ name: 'a', pane: '%1', cmd: 'claude', agent: 'claude', path: '/x', records: [] }],
          state: { key: 'session:a', draft: null, draftVersion: '', repairs: [], inquiries: [], decisions: {}, separations: [] },
          separated: [],
          lookalikes: [],
        })
      if (!url.startsWith('/api/return/brief')) return response(okBody(rows))
      asked++
      return response({ session: 'a', work: { key: 'session:a', members }, agents: {}, brief: { suggestions: [], unexplained: [], holds: [], rules: [] } })
    })
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [{ session: 'a', agent: 'claude', state: 'waiting', since: NOW_EPOCH - 100, artifacts: [], commits: 0 }] }))
    render(<App />)
    await flush()
    for (let visit = 0; visit < 2; visit++) {
      fireEvent.click(within(screen.getByRole('region', { name: /pick up where you left off/i })).getByRole('button', { name: /answer the question/i }))
      await flush()
      fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
      await flush()
      await flush()
    }
    expect(asked).toBe(3)
  })

  it("keeps a work's limits and rules above its session's own terminal tab, with a way back to the work, while Now in the top bar always goes to Now", async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 })]
    const rule = { recordId: 'u1', author: 'you', at: NOW_EPOCH - 9000, session: 'a', sentence: 'Never merge the PR without asking me.' }
    fetchMock.mockImplementation(async (url) =>
      url.startsWith('/api/return/brief')
        ? response({ session: 'a', work: { key: 'session:a', members: [{ name: 'a', reason: '' }] }, agents: { a: 'claude' }, brief: { suggestions: [], unexplained: [], holds: [], rules: [rule] } })
        : url.startsWith('/api/return?')
          ? solo('a', 'claude', [{ id: 'u1', kind: 'decision', at: NOW_EPOCH - 9000, text: rule.sentence }])
          : url.startsWith('/api/return')
            ? response({}, 404)
            : response(okBody(rows)),
    )
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [{ session: 'a', agent: 'claude', state: 'waiting', since: NOW_EPOCH - 100, title: 'A', artifacts: [], commits: 0 }] }))
    render(<App />)
    await flush()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: "Open a's terminal" }))
    await flush()
    await flush()
    fireEvent.click(within(screen.getByRole('region', { name: 'Pick up a' })).getByRole('button', { name: 'Open as its own tab' }))
    await flush()
    const note = screen.getByText(/^In A · keeps holding/).closest('[role="note"]') as HTMLElement
    expect(note).toHaveTextContent('In A · keeps holding: Never merge the PR without asking me')
    fireEvent.click(within(note).getByRole('button', { name: 'Back to the work' }))
    await flush()
    expect(screen.getByRole('region', { name: 'Pick up a' })).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'a' }))
    await flush()
    expect(screen.getByTestId('term-a')).toBeVisible()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('button', { name: 'Now' }))
    await flush()
    await flush()
    expect(screen.queryByRole('region', { name: 'Pick up a' })).toBeNull()
    expect(screen.getByRole('region', { name: /pick up where you left off/i })).toBeVisible()
  })

  it('reads the brief of every listed work when a reload lands on a work page, so the rail keeps a failed check under Needs you', async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 }), session({ name: 'b', cmd: 'claude', activityEpoch: NOW_EPOCH - 20 })]
    const failing = { id: 'f1', kind: 'failure', author: 'tool', at: NOW_EPOCH - 600, text: 'FAIL keeps total deadline', session: 'b' }
    const brief = (name: string) => ({ session: name, work: { key: `session:${name}`, members: [{ name, reason: '' }] }, agents: { [name]: 'claude' }, brief: { suggestions: [], unexplained: [], holds: [], rules: [], ...(name === 'b' ? { failing } : {}) } })
    fetchMock.mockImplementation(async (url) =>
      url.startsWith('/api/return/brief')
        ? response(brief(new URL(url, 'http://x').searchParams.get('session') ?? ''))
        : url.startsWith('/api/return?')
          ? response({
              session: 'a',
              host: 'stub-host',
              fetchedAt: Date.now(),
              work: { key: 'session:a', members: [{ name: 'a', reason: 'only session in this work' }] },
              sessions: [{ name: 'a', pane: '%1', cmd: 'claude', agent: 'claude', path: '/x', records: [] }],
              state: { key: 'session:a', draft: null, draftVersion: '', repairs: [], inquiries: [], decisions: {}, separations: [] },
              separated: [],
              lookalikes: [],
            })
          : url.startsWith('/api/return')
            ? response({})
            : response(okBody(rows)),
    )
    insightsMock.mockImplementation(async () =>
      response({
        fetchedAt: Date.now(),
        agents: [
          { session: 'a', agent: 'claude', state: 'waiting', since: NOW_EPOCH - 100, title: 'A', artifacts: [], commits: 0 },
          { session: 'b', agent: 'claude', state: 'ready', turnAt: NOW_EPOCH - 30, title: 'B', artifacts: [], commits: 0 },
        ],
      }),
    )
    history.replaceState(null, '', '/#w=a')
    render(<App />)
    for (let i = 0; i < 6; i++) await flush()
    const rail = within(screen.getByRole('region', { name: 'Pick up a' })).getByRole('navigation', { name: 'Work' })
    expect(within(rail).getByRole('button', { name: /^B/ })).toHaveTextContent('Check failed')
    expect(within(rail).getByText(/^Needs you/)).toHaveTextContent('Needs you 2')
    expect(within(rail).getByRole('button', { name: /^A/ })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps where you are in the address, so a reload comes back to it', async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 }), session({ name: 'z', activityEpoch: NOW_EPOCH - 20 })]
    fetchMock.mockImplementation(async (url) =>
      url.startsWith('/api/return?')
        ? response({
            session: 'a',
            host: 'stub-host',
            fetchedAt: Date.now(),
            work: { key: 'session:a', members: [{ name: 'a', reason: 'only session in this work' }] },
            sessions: [{ name: 'a', pane: '%1', cmd: 'claude', agent: 'claude', path: '/x', records: [] }],
            state: { key: 'session:a', draft: null, draftVersion: '', repairs: [], inquiries: [], decisions: {}, separations: [] },
            separated: [],
            lookalikes: [],
          })
        : url.startsWith('/api/return')
          ? response({})
          : response(okBody(rows)),
    )
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [{ session: 'a', agent: 'claude', state: 'waiting', since: NOW_EPOCH - 100, title: 'A', artifacts: [], commits: 0 }] }))
    history.replaceState(null, '', '/#w=a')
    const first = render(<App />)
    await flush()
    await flush()
    expect(screen.getByRole('region', { name: 'Pick up a' })).toBeVisible()
    await showAll()
    expect(location.hash).toBe('#sessions')
    first.unmount()
    history.replaceState(null, '', '/#s=z')
    const second = render(<App />)
    await flush()
    expect(screen.getByTestId('term-z')).toBeInTheDocument()
    expect(location.hash).toBe('#s=z')
    second.unmount()
    history.replaceState(null, '', '/#artifacts')
    render(<App />)
    await flush()
    expect(screen.getByRole('heading', { level: 2, name: /Artifacts/ })).toBeInTheDocument()
  })

  it('leaves the open work page the way going back does when All sessions opens another work, or when you choose Now again', async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 }), session({ name: 'b', cmd: 'claude', activityEpoch: NOW_EPOCH - 20 })]
    const seenPosts: string[] = []
    fetchMock.mockImplementation(async (url, init) => {
      if (url.startsWith('/api/return?')) {
        const name = new URL(url, 'http://x').searchParams.get('session') ?? ''
        return response({
          session: name,
          host: 'stub-host',
          fetchedAt: Date.now(),
          work: { key: `session:${name}`, members: [{ name, reason: 'only session in this work' }] },
          sessions: [{ name, pane: '%1', cmd: 'claude', agent: 'claude', path: '/x', records: [] }],
          state: { key: `session:${name}`, draft: null, draftVersion: '', repairs: [], inquiries: [], decisions: {}, separations: [] },
          separated: [],
          lookalikes: [],
        })
      }
      if (url === '/api/return/seen') seenPosts.push(String(JSON.parse(String(init.body)).session))
      if (url.startsWith('/api/return')) return response({ error: 'return_failed' }, 500)
      return response(okBody(rows))
    })
    const waiting = (name: string): AgentInsight => ({ session: name, agent: 'claude', state: 'waiting', since: NOW_EPOCH - 100, title: name.toUpperCase(), artifacts: [], commits: 0 })
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [waiting('a'), waiting('b')] }))
    render(<App />)
    await flush()
    fireEvent.click(within(screen.getByRole('region', { name: /pick up where you left off/i })).getAllByRole('button', { name: /answer the question/i })[0])
    await flush()
    expect(screen.getByRole('region', { name: 'Pick up a' })).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Pick up a' })).getByTestId('term-a')).toBeVisible()
    await showAll()
    fireEvent.click(row('b') as HTMLElement)
    await flush()
    await flush()
    expect(seenPosts).toEqual(['a'])
    expect(screen.getByRole('region', { name: 'Pick up b' })).toBeVisible()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('button', { name: 'Now' }))
    await flush()
    await flush()
    expect(seenPosts).toEqual(['a', 'b'])
    expect(screen.queryByRole('region', { name: 'Pick up b' })).toBeNull()
    expect(screen.getByRole('region', { name: /pick up where you left off/i })).toBeVisible()
    fireEvent.click(within(screen.getByRole('region', { name: /pick up where you left off/i })).getAllByRole('button', { name: /answer the question/i })[0])
    await flush()
    await showAll()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await flush()
    await flush()
    expect(screen.queryByRole('region', { name: /^Pick up [ab]$/ })).toBeNull()
    expect(screen.getByRole('region', { name: /pick up where you left off/i })).toBeVisible()
  })

  it('counts every session of a work as seen when you go back from its work page', async () => {
    const home = await work(null)()
    expect(home()).toHaveTextContent('You can leave now')
  })

  it('counts a turn of the page you were on as seen when you go back', async () => {
    const home = await work(null, NOW_EPOCH + 5)()
    expect(home()).toHaveTextContent('You can leave now')
  })

  it("keeps another session's turn that came in while you were on the work page as new", async () => {
    const home = await work(NOW_EPOCH + 5)()
    expect(within(home()).getByRole('listitem')).toHaveTextContent(/^b.*New turn/)
  })

  it('counts a work page you went back from as seen on the home list', async () => {
    const rows = [session({ name: 'a', cmd: 'claude', activityEpoch: NOW_EPOCH - 10 })]
    fetchMock.mockImplementation(async (url) => (url.startsWith('/api/return') ? response({ error: 'return_failed' }, 500) : response(okBody(rows))))
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [{ session: 'a', agent: 'claude', state: 'ready', turnAt: NOW_EPOCH - 10, title: 'Fix it', artifacts: [], commits: 0 }] }))
    render(<App />)
    await flush()
    const home = () => screen.getByRole('region', { name: /pick up where you left off/i })
    expect(home()).toHaveTextContent('New since you looked 1')
    fireEvent.click(within(home()).getByRole('button', { name: /see what changed/i }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Now' }))
    await flush()
    expect(home()).toHaveTextContent('You can leave now')
    fireEvent.click(screen.getByText(/Seen this visit/))
    fireEvent.click(screen.getByRole('button', { name: 'Fix it' }))
    expect(screen.getByRole('region', { name: 'Pick up a' })).toBeVisible()
  })

  it('keeps the overview usable when agent details fail, and says so', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    insightsMock.mockImplementation(async () => response({ error: 'insights_failed', message: 'python3 is not installed on the remote host' }, 500))
    render(<App />)
    await flush()
    expect(status()).toHaveTextContent('Agent details unavailable')
    expect(status()).toHaveTextContent('Needs you and Working may be missing some')
    expect(status()).toHaveTextContent('Last error: python3 is not installed on the remote host')
    expect(status()).toHaveTextContent('Retrying in 15s')
    expect(sidebar().getAllByRole('button')).toHaveLength(3)
  })

  it('says agent details are out of date while it still shows the last ones', async () => {
    const waiting: AgentInsight = { session: 'cc-demo', agent: 'claude', state: 'waiting', title: 'Fix it', artifacts: [], commits: 0 }
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    insightsMock.mockImplementationOnce(async () => response({ fetchedAt: Date.now(), agents: [waiting] }))
    insightsMock.mockImplementation(async () => response({ error: 'insights_failed', message: 'agent probe failed' }, 500))
    render(<App />)
    await flush()
    expect(status.query()).toBeNull()
    await advance(15100)
    expect(status()).toHaveTextContent('Agent details as of 15s ago')
    expect(status()).toHaveTextContent('The last update failed.')
    await showAll()
    expect(row('cc-demo')).toHaveTextContent('Waiting on you')
  })

  it('stops showing agent states it has not confirmed for a minute', async () => {
    const waiting: AgentInsight = { session: 'cc-demo', agent: 'claude', state: 'waiting', title: 'Fix it', artifacts: [], commits: 0 }
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    insightsMock.mockImplementationOnce(async () => response({ fetchedAt: Date.now(), agents: [waiting] }))
    insightsMock.mockImplementation(async () => response({ error: 'insights_failed', message: 'agent probe failed' }, 500))
    render(<App />)
    await flush()
    await showAll()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15100)
    })
    expect(row('cc-demo')).toHaveTextContent('Waiting on you')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000)
    })
    expect(row('cc-demo')).not.toHaveTextContent('Waiting on you')
  })

  it('resizes the sidebar from the keyboard, remembers the width, and resets on double-click', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    const handle = screen.getByRole('separator', { name: 'Resize sessions sidebar' })
    const width = () => document.querySelector<HTMLElement>('.app')?.style.getPropertyValue('--sidebar-w')
    expect(handle).toHaveAttribute('aria-valuenow', '320')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(width()).toBe('336px')
    expect(localStorage.getItem('devbox.sidebar')).toBe('336')
    fireEvent.doubleClick(handle)
    expect(handle).toHaveAttribute('aria-valuenow', '320')
  })

  it('counts what wants you in the tab title and badges the icon', async () => {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.href = '/favicon.svg'
    document.head.append(link)
    const waiting: AgentInsight = { session: 'cc-demo', agent: 'claude', state: 'waiting', artifacts: [], commits: 0 }
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [waiting] }))
    render(<App />)
    await flush()
    expect(document.title).toBe('(1) stub-host · devbox')
    expect(link.getAttribute('href')).toBe('/favicon-alert.svg')
    fireEvent.click(sidebar().getByRole('button', { name: /api/ }))
    await flush()
    expect(document.title).toBe('(1) api · devbox')
    link.remove()
  })

  it('polls agent details every 15 seconds', async () => {
    fetchMock.mockImplementation(async () => response(okBody([])))
    render(<App />)
    await flush()
    expect(insightsMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15100)
    })
    expect(insightsMock).toHaveBeenCalledTimes(2)
  })

  it('polls every 5 seconds and refetches on window focus', async () => {
    fetchMock.mockImplementation(async () => response(okBody([])))
    render(<App />)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('says the link expired on 401, stops polling, and checks again only when asked', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'unauthorized', message: 'bad token' }, 401))
    render(<App />)
    await flush()
    expect(status()).toHaveTextContent("This tab's link has expired")
    expect(status()).toHaveTextContent('Run devbox web for a fresh tab')
    expect(status()).toHaveTextContent('Not retrying on its own.')
    await advance(60000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fireEvent.click(within(status()).getByRole('button', { name: 'Check again' }))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('takes a fresh link pasted into the same tab without a reload', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization === 'Bearer fresh'
        ? response(okBody(ROWS))
        : response({ error: 'unauthorized', message: 'bad token' }, 401),
    )
    render(<App />)
    await flush()
    expect(status()).toHaveTextContent("This tab's link has expired")
    await act(async () => {
      history.replaceState(null, '', '/#t=fresh')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(sidebar().getAllByRole('button')).toHaveLength(3)
    expect(status()).toHaveTextContent('Back in touch with stub-host.')
    expect(window.location.hash).toBe('')
  })

  it('keeps stale sessions marked with their age and the retry countdown when the host drops, then says it is back', async () => {
    fetchMock.mockImplementationOnce(async () => response(okBody(ROWS)))
    fetchMock.mockImplementationOnce(async () => response({ error: 'remote_unreachable', message: 'devbox timed out' }, 502))
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    await advance(5000)
    expect(status()).toHaveTextContent("Can't reach stub-host")
    expect(status()).toHaveTextContent('Showing sessions as of 5s ago.')
    expect(status()).toHaveTextContent('Retrying in 5s.')
    expect(status()).toHaveTextContent('check your VPN or proxy sign-in')
    expect(status()).toHaveTextContent('Last error: devbox timed out')
    expect(sidebar().getAllByRole('button')).toHaveLength(3)
    await advance(2000)
    expect(status()).toHaveTextContent('Showing sessions as of 7s ago.')
    expect(status()).toHaveTextContent('Retrying in 3s.')
    await advance(3000)
    expect(status()).toHaveTextContent('Back in touch with stub-host.')
    await advance(6000)
    expect(status.query()).toBeNull()
  })

  it('retries at once from the status line', async () => {
    fetchMock.mockImplementationOnce(async () => response(okBody(ROWS)))
    fetchMock.mockImplementation(async () => response({ error: 'remote_unreachable', message: 'x' }, 502))
    render(<App />)
    await flush()
    await advance(5500)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fireEvent.click(within(status()).getByRole('button', { name: 'Retry now' }))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(status()).toHaveTextContent('Retrying in 5s.')
  })

  it('never stacks requests on a host that does not answer, and says it is waiting only once a refresh is well past its usual time', async () => {
    fetchMock.mockImplementationOnce(async () => response(okBody(ROWS)))
    fetchMock.mockImplementation(() => new Promise(() => undefined))
    render(<App />)
    await flush()
    await advance(5000)
    expect(status.query()).toBeNull()
    await advance(9000)
    expect(status.query()).toBeNull()
    await advance(1000)
    expect(status()).toHaveTextContent('Waiting on stub-host')
    expect(status()).toHaveTextContent('Showing sessions as of 15s ago; the refresh has had no answer for 10s.')
    expect(status().closest('.workspace')).not.toBeNull()
    expect(status().closest('.sidebar')).toBeNull()
    await advance(30000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('says it is waiting on the host when the first load is slow', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined))
    render(<App />)
    await flush()
    expect(screen.getByText('Loading sessions…')).toBeInTheDocument()
    await advance(4000)
    expect(status()).toHaveTextContent('Waiting on your dev host')
    expect(status()).toHaveTextContent('No answer yet (4s).')
  })

  it('runs a refresh asked for mid-request once that request returns, instead of dropping it', async () => {
    let answer: (r: Response) => void = () => undefined
    fetchMock.mockImplementationOnce(async () => response(okBody([])))
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)))
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    await advance(5000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      answer(response(okBody([])))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sidebar().getAllByRole('button')).toHaveLength(3)
  })

  it('says agent details are still loading when they are slow to arrive', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    insightsMock.mockImplementation(() => new Promise(() => undefined))
    render(<App />)
    await flush()
    expect(status.query()).toBeNull()
    await advance(3000)
    expect(status()).toHaveTextContent('Loading agent details…')
    expect(status()).toHaveTextContent('Tiles show sessions only until they arrive.')
  })

  it('keeps the last agent states while the whole host is unreachable', async () => {
    const waiting: AgentInsight = { session: 'cc-demo', agent: 'claude', state: 'waiting', title: 'Fix it', artifacts: [], commits: 0 }
    fetchMock.mockImplementationOnce(async () => response(okBody(ROWS)))
    fetchMock.mockImplementation(async () => response({ error: 'remote_unreachable', message: 'x' }, 502))
    insightsMock.mockImplementationOnce(async () => response({ fetchedAt: Date.now(), agents: [waiting] }))
    insightsMock.mockImplementation(async () => response({ error: 'remote_unreachable', message: 'x' }, 502))
    render(<App />)
    await flush()
    await advance(90000)
    expect(status()).toHaveTextContent("Can't reach stub-host")
    expect(status()).not.toHaveTextContent('Agent details')
    await showAll()
    expect(row('cc-demo')).toHaveTextContent('Waiting on you')
  })

  it('says the agent details it still shows are old, not missing, while they refresh after the host is back', async () => {
    const waiting: AgentInsight = { session: 'cc-demo', agent: 'claude', state: 'waiting', title: 'Fix it', artifacts: [], commits: 0 }
    fetchMock.mockImplementationOnce(async () => response(okBody(ROWS)))
    fetchMock.mockImplementation(async () => response({ error: 'remote_unreachable', message: 'x' }, 502))
    insightsMock.mockImplementationOnce(async () => response({ fetchedAt: Date.now(), agents: [waiting] }))
    insightsMock.mockImplementation(async () => response({ error: 'remote_unreachable', message: 'x' }, 502))
    render(<App />)
    await flush()
    await advance(90000)
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    insightsMock.mockImplementation(() => new Promise(() => {}))
    await advance(10000)
    expect(status()).toHaveTextContent('Agent details as of')
    expect(status()).not.toHaveTextContent('unavailable')
    await showAll()
    expect(row('cc-demo')).toHaveTextContent('Waiting on you')
  })

  it('refreshes agent details as soon as the host is back', async () => {
    fetchMock.mockImplementationOnce(async () => response(okBody(ROWS)))
    fetchMock.mockImplementationOnce(async () => response({ error: 'remote_unreachable', message: 'x' }, 502))
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    expect(insightsMock).toHaveBeenCalledTimes(1)
    await advance(10000)
    expect(insightsMock).toHaveBeenCalledTimes(2)
  })

  it('blames the dashboard server, not the host, when the local fetch fails', async () => {
    fetchMock.mockImplementationOnce(async () => response(okBody(ROWS)))
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    render(<App />)
    await flush()
    await advance(5000)
    expect(status()).toHaveTextContent("The dashboard server isn't answering")
    expect(status()).toHaveTextContent('Run devbox web in a terminal')
    expect(status()).not.toHaveTextContent('VPN')
  })

  it('shows the probe error itself for a non-502 server failure', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'internal', message: 'session probe failed' }, 500))
    render(<App />)
    await flush()
    expect(status()).toHaveTextContent("Couldn't read the session list")
    expect(status()).toHaveTextContent('Last error: session probe failed')
  })

  it('explains an unreachable host before any data, with the retry timing and a retry button', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'remote_unreachable', message: 'ssh failed' }, 502))
    render(<App />)
    await flush()
    expect(screen.getByRole('heading', { name: "Can't reach your dev host" })).toBeInTheDocument()
    expect(status()).toHaveTextContent('No sessions loaded yet.')
    expect(status()).toHaveTextContent('Retrying in 5s.')
    expect(status()).toHaveTextContent('Last error: ssh failed')
    expect(screen.getByRole('status')).toHaveTextContent("Can't reach your dev host.")
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    await advance(15000)
    expect(status()).toHaveTextContent('Failing for 15s.')
    fireEvent.click(within(status()).getByRole('button', { name: 'Retry now' }))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('shows the dashboard-server hint when the local fetch fails before any data', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    render(<App />)
    await flush()
    expect(screen.getByRole('heading', { name: "The dashboard server isn't answering" })).toBeInTheDocument()
    expect(status()).toHaveTextContent('Run devbox web in a terminal')
  })
})
