import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/Terminal', () => ({
  TerminalPane: ({ name }: { name: string }) => <div data-testid={`term-${name}`} />,
}))

vi.mock('../../src/components/WorkspacePalette', () => ({
  WorkspacePalette: ({ onOpen }: { onOpen: (name: string) => void }) => (
    <button type="button" data-testid="palette" onClick={() => onOpen('from-palette')}>
      palette
    </button>
  ),
}))

import { App } from '../../src/App'
import type { AgentInsight, Session, SessionsResponse } from '../../src/shared/types'

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

let fetchMock: ReturnType<typeof vi.fn>
let insightsMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(NOW_EPOCH * 1000)
  sessionStorage.setItem('devbox-web-token', 'tok')
  localStorage.clear()
  fetchMock = vi.fn()
  insightsMock = vi.fn(async () => response({ fetchedAt: Date.now(), agents: [] }))
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) =>
    url === '/api/theme'
      ? response({ ghostty: null })
      : url === '/api/notes'
        ? response({ days: [] })
        : url.startsWith('/api/notes/')
          ? response({ day: url.slice(11), text: '' })
          : url === '/api/insights'
            ? insightsMock(url, init)
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

describe('App', () => {
  it('shows a loading state before the first response', () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined))
    render(<App />)
    expect(screen.getByText(/loading sessions/)).toBeInTheDocument()
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

  it('opens a terminal tab from the sidebar and marks that session current', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    fireEvent.click(sidebar().getByRole('button', { name: /cc-demo/ }))
    expect(screen.getByTestId('term-cc-demo')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'cc-demo' })).toHaveAttribute('aria-selected', 'true')
    expect(sidebar().getByRole('button', { name: /cc-demo/ })).toHaveAttribute('aria-current', 'true')
  })

  it('opening from the palette opens a terminal tab', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    fireEvent.click(screen.getByTestId('palette'))
    expect(screen.getByTestId('term-from-palette')).toBeInTheDocument()
  })

  it('closing the active tab activates its neighbour instead of showing nothing', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    fireEvent.click(sidebar().getByRole('button', { name: /cc-demo/ }))
    fireEvent.click(sidebar().getByRole('button', { name: /api/ }))
    fireEvent.click(sidebar().getByRole('button', { name: /main/ }))
    fireEvent.click(screen.getByTitle('Close main'))
    expect(screen.getByRole('tab', { name: 'api' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByTitle('Close cc-demo'))
    expect(screen.getByRole('tab', { name: 'api' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByTitle('Close api'))
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'overview' })).toBeVisible()
  })

  it('shows what each agent is doing and opens a session from its details', async () => {
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
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [waiting] }))
    render(<App />)
    await flush()
    expect(sidebar().getByRole('button', { name: /cc-demo/ })).toHaveTextContent('Permission prompt')
    const needs = within(screen.getByRole('region', { name: /Needs you/ }))
    fireEvent.click(needs.getByRole('button', { name: /Fix flaky retry test/ }))
    const details = within(screen.getByRole('article', { name: 'cc-demo details' }))
    expect(details.getByText('Fix is up as PR 31; waiting on CI.', { exact: false })).toBeInTheDocument()
    expect(details.getByRole('link', { name: /^PR #31/ })).toHaveAttribute('href', 'https://github.com/o/r/pull/31')
    fireEvent.click(details.getByRole('button', { name: 'Open terminal' }))
    expect(screen.getByTestId('term-cc-demo')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'overview', hidden: true })).not.toBeVisible()
  })

  it('counts a turn that finished while you watched it in the terminal as seen', async () => {
    const turn = (turnAt: number): AgentInsight => ({ session: 'cc-demo', agent: 'claude', state: 'ready', turnAt, title: 'Fix it', artifacts: [], commits: 0 })
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    insightsMock.mockImplementationOnce(async () => response({ fetchedAt: Date.now(), agents: [turn(NOW_EPOCH - 60)] }))
    insightsMock.mockImplementation(async () => response({ fetchedAt: Date.now(), agents: [turn(NOW_EPOCH - 5)] }))
    render(<App />)
    await flush()
    expect(within(screen.getByRole('region', { name: /New since you looked/ })).getByRole('button', { name: 'Fix it' })).toBeInTheDocument()
    fireEvent.click(sidebar().getByRole('button', { name: /cc-demo/ }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15100)
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))
    expect(screen.queryByRole('region', { name: /New since you looked/ })).toBeNull()
  })

  it('keeps the overview usable when agent details fail, and says so', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    insightsMock.mockImplementation(async () => response({ error: 'insights_failed', message: 'python3 is not installed on the remote host' }, 500))
    render(<App />)
    await flush()
    expect(screen.getByRole('region', { name: 'overview' })).toHaveTextContent('agent details unavailable: python3 is not installed')
    expect(sidebar().getAllByRole('button')).toHaveLength(3)
  })

  it('stops showing agent states it has not confirmed for a minute', async () => {
    const waiting: AgentInsight = { session: 'cc-demo', agent: 'claude', state: 'waiting', title: 'Fix it', artifacts: [], commits: 0 }
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    insightsMock.mockImplementationOnce(async () => response({ fetchedAt: Date.now(), agents: [waiting] }))
    insightsMock.mockImplementation(async () => response({ error: 'insights_failed', message: 'agent probe failed' }, 500))
    render(<App />)
    await flush()
    const blocked = () => within(screen.getByRole('region', { name: /Needs you/ })).queryByRole('button', { name: 'Fix it' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15100)
    })
    expect(blocked()).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000)
    })
    expect(blocked()).toBeNull()
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

  it('shows the restart hint on 401', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'unauthorized', message: 'bad token' }, 401))
    render(<App />)
    await flush()
    expect(screen.getByText('server restarted — run devbox web')).toBeInTheDocument()
  })

  it('keeps stale sessions with an advancing "as of" banner when the host drops, then recovers', async () => {
    fetchMock.mockImplementationOnce(async () => response(okBody(ROWS)))
    fetchMock.mockImplementationOnce(async () => response({ error: 'remote_unreachable', message: 'x' }, 502))
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/host unreachable — showing sessions as of \d+s ago/)
    expect(sidebar().getAllByRole('button')).toHaveLength(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('blames the dashboard server, not the host, when the local fetch fails', async () => {
    fetchMock.mockImplementationOnce(async () => response(okBody(ROWS)))
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    render(<App />)
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/dashboard server stopped — run devbox web/)
  })

  it('shows the probe error itself for a non-502 server failure', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'internal', message: 'session probe failed' }, 500))
    render(<App />)
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('probe failed: session probe failed')
  })

  it('shows an unreachable notice when the host is down before any data', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'remote_unreachable', message: 'ssh failed' }, 502))
    render(<App />)
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('host unreachable: ssh failed')
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('shows the dashboard-server hint when the local fetch fails before any data', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    render(<App />)
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('dashboard server unreachable — run devbox web')
  })
})
