import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/Terminal', () => ({
  TerminalPane: ({ name, side }: { name: string; side?: ReactNode }) => <div data-testid={`term-${name}`}>{side}</div>,
}))

vi.mock('../../src/components/WorkspacePalette', () => ({
  WorkspacePalette: ({ onOpen }: { onOpen: (name: string) => void }) => (
    <button type="button" data-testid="palette" onClick={() => onOpen('from-palette')}>
      palette
    </button>
  ),
}))

import { App } from '../../src/App'
import { initToken } from '../../src/token'
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
  history.replaceState(null, '', '/#t=tok')
  initToken()
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

  it('opens a file from the overview beside its terminal', async () => {
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
    fireEvent.click(within(screen.getByRole('complementary', { name: 'session details' })).getByRole('button', { name: 'plan.md' }))
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
    expect(within(screen.getByRole('region', { name: /Needs you/ })).getByRole('button', { name: 'Fix it' })).toBeInTheDocument()
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
    expect(within(screen.getByRole('region', { name: /Needs you/ })).getByRole('button', { name: 'Fix it' })).toBeInTheDocument()
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
    expect(within(screen.getByRole('region', { name: /Needs you/ })).getByRole('button', { name: 'Fix it' })).toBeInTheDocument()
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
