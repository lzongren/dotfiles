import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/components/Terminal', () => ({
  TerminalPane: ({ name }: { name: string }) => <div data-testid={`term-${name}`} />,
}))

import { App } from '../../src/App'
import { ago } from '../../src/components/SessionTable'
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
    path: '/home/me',
    attachable: true,
    ...overrides,
  }
}

const ROWS: Session[] = [
  session({ name: 'cc-atx', attached: true, clients: 2, bell: true, cmd: 'claude', path: '/home/me/work/atx' }),
  session({ name: 'api - ~/work/api', attachable: false, attached: true, clients: 1, cmd: 'vim' }),
  session({ name: 'main' }),
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

describe('App', () => {
  it('shows a loading state before the first response', () => {
    fetchMock.mockReturnValue(new Promise(() => undefined))
    render(<App />)
    expect(screen.getByText(/loading sessions/)).toBeInTheDocument()
  })

  it('renders rows with state, clients, idle, cmd, path, and bell badge', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    expect(screen.getByText('devbox — stub-host')).toBeInTheDocument()
    expect(screen.getByText('cc-atx')).toBeInTheDocument()
    expect(screen.getByText('×2')).toBeInTheDocument()
    expect(screen.getAllByText('30s').length).toBeGreaterThan(0)
    expect(screen.getByText('claude')).toBeInTheDocument()
    expect(screen.getByText('/home/me/work/atx')).toBeInTheDocument()
    const bellRow = screen.getByText('cc-atx').closest('tr')
    expect(bellRow?.querySelector('.bell-badge')).toHaveTextContent('bell')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    )
  })

  it('announces ringing sessions through a single polite live region', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    const { container } = render(<App />)
    await flush()
    const regions = container.querySelectorAll('[aria-live="polite"]')
    expect(regions).toHaveLength(1)
    expect(regions[0]).toHaveTextContent('cc-atx needs attention')
  })

  it('dims an unattachable row and explains it in a tooltip', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    const row = screen.getByText('api - ~/work/api').closest('tr')
    expect(row).toHaveClass('unattachable')
    expect(row).toHaveAttribute('title', expect.stringContaining('cannot be used'))
  })

  it('ticks the idle column client-side between polls', async () => {
    fetchMock.mockImplementation(async () => response(okBody([session({ name: 'main', activityEpoch: NOW_EPOCH - 50 })])))
    render(<App />)
    await flush()
    expect(screen.getByText('50s')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(screen.getByText('54s')).toBeInTheDocument()
  })

  it('shows the empty state with the devbox hint', async () => {
    fetchMock.mockImplementation(async () => response(okBody([])))
    render(<App />)
    await flush()
    expect(screen.getByText(/No sessions\./)).toBeInTheDocument()
    expect(screen.getByText(/devbox <name>/)).toBeInTheDocument()
  })

  it('polls every 5 seconds', async () => {
    fetchMock.mockImplementation(async () => response(okBody([])))
    render(<App />)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refetches on window focus', async () => {
    fetchMock.mockImplementation(async () => response(okBody([])))
    render(<App />)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shows the restart hint on 401', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'unauthorized', message: 'bad token' }, 401))
    render(<App />)
    await flush()
    expect(screen.getByText('server restarted — run devbox web')).toBeInTheDocument()
  })

  it('keeps stale rows with an advancing "as of" banner when the host drops', async () => {
    fetchMock.mockImplementationOnce(async () => response(okBody(ROWS)))
    fetchMock.mockImplementation(async () => response({ error: 'remote_unreachable', message: 'ssh failed' }, 502))
    render(<App />)
    await flush()
    expect(screen.getByText('cc-atx')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/as of \d+s ago/)
    expect(screen.getByText('cc-atx')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/as of [3-9]s ago/)
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
    expect(screen.getByText('cc-atx')).toBeInTheDocument()
  })

  it('shows the dashboard-server hint when the local fetch fails before any data', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    render(<App />)
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('dashboard server unreachable — run devbox web')
  })

  it('shows the probe error itself for a non-502 server failure', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'internal', message: 'session probe failed' }, 500))
    render(<App />)
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('probe failed: session probe failed')
    expect(screen.getByRole('alert')).not.toHaveTextContent('run devbox web')
  })

  it('shows an unreachable notice when the host is down before any data', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'remote_unreachable', message: 'ssh failed' }, 502))
    render(<App />)
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('host unreachable: ssh failed')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('recovers from stale to live on the next good poll', async () => {
    fetchMock.mockImplementationOnce(async () => response(okBody(ROWS)))
    fetchMock.mockImplementationOnce(async () => response({ error: 'remote_unreachable', message: 'x' }, 502))
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100)
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('terminal tabs from the dashboard', () => {
  it('clicking an attachable session opens its terminal tab; close removes it', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'cc-atx' }))
    expect(screen.getByTestId('term-cc-atx')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'cc-atx' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'close cc-atx' }))
    expect(screen.queryByTestId('term-cc-atx')).not.toBeInTheDocument()
  })

  it('an unattachable session offers no attach button', async () => {
    fetchMock.mockImplementation(async () => response(okBody(ROWS)))
    render(<App />)
    await flush()
    expect(screen.queryByRole('button', { name: 'api - ~/work/api' })).not.toBeInTheDocument()
  })
})

describe('ago buckets', () => {
  it('mirrors the devbox_ago format', () => {
    const now = NOW_EPOCH * 1000
    expect(ago(now, NOW_EPOCH - 5)).toBe('5s')
    expect(ago(now, NOW_EPOCH - 59)).toBe('59s')
    expect(ago(now, NOW_EPOCH - 60)).toBe('1m')
    expect(ago(now, NOW_EPOCH - 3599)).toBe('59m')
    expect(ago(now, NOW_EPOCH - 3600)).toBe('1h')
    expect(ago(now, NOW_EPOCH - 86399)).toBe('23h')
    expect(ago(now, NOW_EPOCH - 86400)).toBe('1d')
    expect(ago(now, NOW_EPOCH + 10)).toBe('0s')
  })
})
