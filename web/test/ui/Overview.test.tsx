import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Overview } from '../../src/components/Overview'
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

const agent = (name: string, over: Partial<AgentInsight> = {}): AgentInsight => ({
  session: name,
  agent: 'claude',
  state: 'ready',
  artifacts: [],
  commits: 0,
  ...over,
})

const SESSIONS = [
  session('zed', { activityEpoch: sec(20) }),
  session('alpha', { activityEpoch: sec(10) }),
  session('mid'),
  session('newer'),
  session('older'),
  session('run-b'),
  session('run-a'),
  session('shell-late', { cmd: 'zsh', path: '/home/me/notes/x', activityEpoch: sec(5) }),
  session('shell-early', { cmd: 'zsh', path: '/home/me/notes/y', activityEpoch: sec(500) }),
  session('old', { activityEpoch: sec(9 * 86400) }),
]

const insights = (extra: AgentInsight[] = []) =>
  new Map(
    [
      agent('zed', { state: 'waiting', waitingFor: 'permission prompt', title: 'Blocked longest', since: sec(900) }),
      agent('alpha', { state: 'waiting', title: 'Blocked lately', since: sec(100) }),
      agent('older', { title: 'Older turn', turnAt: sec(400) }),
      agent('newer', {
        title: 'Newer turn',
        turnAt: sec(200),
        summary: 'Report drafted in CR-9; next, send it.',
        artifacts: [
          { label: 'CR', url: 'https://r.example/CR-1', at: sec(90), first: sec(300), hits: 1, said: false },
          { label: 'CR', url: 'https://r.example/CR-7', at: sec(95), first: sec(250), hits: 4, said: true },
          { label: 'CR', url: 'https://r.example/CR-9', at: sec(100), first: sec(220), hits: 2, said: true },
        ],
      }),
      agent('run-b', { state: 'working', title: 'Started first', since: sec(800) }),
      agent('run-a', { state: 'working', title: 'Started last', since: sec(30) }),
      agent('mid', { title: 'Seen already', turnAt: sec(5000) }),
      ...extra,
    ].map((a) => [a.session, a]),
  )

function renderOverview(over: Partial<Parameters<typeof Overview>[0]> = {}) {
  const props = {
    sessions: SESSIONS,
    insights: insights(),
    now: NOW,
    seenAt: () => sec(1000),
    onOpen: vi.fn(),
    onSeen: vi.fn(),
    ...over,
  }
  const view = render(<Overview {...props} />)
  return { ...props, rerender: (next: Partial<typeof props>) => view.rerender(<Overview {...props} {...next} />) }
}

const titles = (name: RegExp) =>
  within(screen.getByRole('region', { name }))
    .getAllByRole('button')
    .filter((b) => b.classList.contains('card'))
    .map((b) => b.getAttribute('data-session'))

afterEach(() => {
  vi.useRealTimers()
})

describe('Overview lanes', () => {
  it('orders blocked oldest first, review newest first, and work by when it started', () => {
    renderOverview()
    expect(titles(/Blocked on you/)).toEqual(['zed', 'alpha'])
    expect(titles(/Ready to review/)).toEqual(['newer', 'older'])
    expect(titles(/Working/)).toEqual(['run-b', 'run-a'])
  })

  it('groups the rest by project, most recent activity first, and parks the week-old ones collapsed', () => {
    renderOverview()
    expect(titles(/Recent/)).toEqual(['shell-late', 'shell-early', 'mid'])
    expect(screen.getByRole('heading', { name: 'notes' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Parked/ }).closest('details')).not.toHaveAttribute('open')
  })

  it('names each card by its title and describes it with its state and summary', () => {
    renderOverview()
    const card = screen.getByRole('button', { name: 'Newer turn' })
    expect(card).toHaveAccessibleDescription(/ready · new.*Report drafted in CR-9/)
  })

  it('shows only artifacts someone mentioned on a card, the summary-named first', () => {
    renderOverview()
    const pills = screen.getByRole('button', { name: 'Newer turn' }).querySelectorAll('.pill')
    expect([...pills].map((p) => p.textContent)).toEqual(['CR-9', 'CR-7'])
  })

  it('lists the latest artifacts across sessions by when they first appeared', () => {
    renderOverview()
    const ledger = within(screen.getByRole('complementary', { name: 'session details' }))
    expect(ledger.getAllByRole('link').map((l) => l.textContent?.replace(/ ?\(opens.*$/, ''))).toEqual(['CR-9', 'CR-7'])
  })
})

describe('Overview selection and seen', () => {
  it('shows the selected session in full with its artifacts ranked', () => {
    renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Newer turn' }))
    const details = within(screen.getByRole('article', { name: 'newer details' }))
    expect(details.getByText(/Report drafted in CR-9/)).toBeInTheDocument()
    expect(details.getAllByRole('link').map((l) => l.textContent?.split(' ')[0])).toEqual(['CR-9', 'CR-7', 'CR-1'])
  })

  it('marks a fresh session seen after it has been open for two seconds', () => {
    vi.useFakeTimers()
    const { onSeen } = renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Newer turn' }))
    act(() => {
      vi.advanceTimersByTime(1900)
    })
    expect(onSeen).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(onSeen).toHaveBeenCalledWith(['newer'])
  })

  it('marks every fresh turn seen at once', () => {
    const { onSeen } = renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }))
    expect(onSeen).toHaveBeenCalledWith(['newer', 'older'])
  })

  it('says when the selected session has gone', () => {
    const view = renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Older turn' }))
    view.rerender({ sessions: SESSIONS.filter((s) => s.name !== 'older') })
    expect(screen.getByText('older has ended.')).toBeInTheDocument()
  })

  it('holds the layout still while the pointer is over the lanes, then catches up', () => {
    const view = renderOverview()
    const lanes = screen.getByRole('region', { name: /Blocked on you/ }).parentElement!
    fireEvent.mouseEnter(lanes)
    view.rerender({ insights: insights([agent('older', { state: 'waiting', since: sec(5000), title: 'Older turn' })]) })
    expect(titles(/Ready to review/)).toEqual(['newer', 'older'])
    expect(titles(/Blocked on you/)).toEqual(['zed', 'alpha'])
    fireEvent.mouseLeave(lanes)
    expect(titles(/Blocked on you/)).toEqual(['older', 'zed', 'alpha'])
  })
})

describe('Overview keyboard', () => {
  it('moves with j and k from anywhere on the page and keeps one tab stop', () => {
    renderOverview()
    fireEvent.keyDown(document.body, { key: 'j' })
    const first = screen.getByRole('button', { name: 'Blocked longest' })
    expect(first).toHaveAttribute('aria-pressed', 'true')
    expect(first).toHaveFocus()
    expect(document.querySelectorAll('.card[tabindex="0"]')).toHaveLength(1)
    fireEvent.keyDown(first, { key: 'j' })
    expect(screen.getByRole('button', { name: 'Blocked lately' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Blocked lately' }), { key: 'k' })
    expect(first).toHaveFocus()
  })

  it('skips the parked lane while it is collapsed', () => {
    renderOverview()
    for (let i = 0; i < 20; i += 1) fireEvent.keyDown(document.body, { key: 'j' })
    expect(document.activeElement?.getAttribute('data-session')).toBe('mid')
  })

  it('opens with Enter on a card and marks seen with e', () => {
    const { onOpen, onSeen } = renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Newer turn' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Newer turn' }), { key: 'e' })
    expect(onSeen).toHaveBeenCalledWith(['newer'])
    fireEvent.keyDown(screen.getByRole('button', { name: 'Newer turn' }), { key: 'Enter', repeat: true })
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Newer turn' }), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('newer')
  })

  it('leaves keys alone in inputs, on the detail buttons, with modifiers, and while hidden', () => {
    const { onOpen, rerender } = renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Newer turn' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Mark seen' }), { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
    const input = document.createElement('input')
    document.body.append(input)
    fireEvent.keyDown(input, { key: 'j' })
    fireEvent.keyDown(document.body, { key: 'j', metaKey: true })
    expect(screen.getByRole('button', { name: 'Newer turn' })).toHaveAttribute('aria-pressed', 'true')
    rerender({ visible: false })
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(screen.getByRole('button', { name: 'Newer turn', hidden: true })).toHaveAttribute('aria-pressed', 'true')
    input.remove()
  })
})
