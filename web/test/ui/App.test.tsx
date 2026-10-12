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
import type { Session, SessionsResponse } from '../../src/shared/types'

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
  session({ name: 'cc-atx', activityEpoch: NOW_EPOCH - 10, title: '✳ Fix the flaky retry test', cmd: 'claude' }),
  session({ name: 'api', activityEpoch: NOW_EPOCH - 20 }),
  session({ name: 'main', activityEpoch: NOW_EPOCH - 40 }),
]

function response(body: SessionsResponse | { error: string; message: string }, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function okBody(sessions: Session[]): SessionsResponse {
  return { host: 'stub-host', fetchedAt: Date.now(), sessions }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(NOW_EPOCH * 1000)
  sessionStorage.setItem('devbox-web-token', 'tok')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
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

  it('lays out a sidebar of sessions beside an empty workspace with a hint', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    expect(screen.getByRole('heading', { name: /devbox/ })).toHaveTextContent('stub-host')
    expect(sidebar().getAllByRole('button')).toHaveLength(3)
    expect(screen.getByRole('main')).toHaveTextContent(/press \/ to find or start one/)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    )
  })

  it('opens a terminal tab from the sidebar and marks that session current', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    fireEvent.click(sidebar().getByRole('button', { name: /cc-atx/ }))
    expect(screen.getByTestId('term-cc-atx')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'cc-atx' })).toHaveAttribute('aria-selected', 'true')
    expect(sidebar().getByRole('button', { name: /cc-atx/ })).toHaveAttribute('aria-current', 'true')
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
    fireEvent.click(sidebar().getByRole('button', { name: /cc-atx/ }))
    fireEvent.click(sidebar().getByRole('button', { name: /api/ }))
    fireEvent.click(sidebar().getByRole('button', { name: /main/ }))
    fireEvent.click(screen.getByRole('button', { name: 'close main' }))
    expect(screen.getByRole('tab', { name: 'api' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'close cc-atx' }))
    expect(screen.getByRole('tab', { name: 'api' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'close api' }))
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveTextContent(/press \/ to find or start one/)
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
