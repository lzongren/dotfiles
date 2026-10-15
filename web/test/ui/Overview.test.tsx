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

const nativeScroll = Element.prototype.scrollIntoView

afterEach(() => {
  vi.useRealTimers()
  Element.prototype.scrollIntoView = nativeScroll
})

describe('Overview sections', () => {
  it('puts the blocked ahead of the ready, oldest wait first and newest turn first', () => {
    renderOverview()
    expect(titles(/Needs you/)).toEqual(['zed', 'alpha', 'newer', 'older'])
    expect(titles(/Working/)).toEqual(['run-b', 'run-a'])
  })

  it('spreads lookalike ready sessions apart so one topic cannot fill the top', () => {
    renderOverview({
      sessions: [
        session('search-speed', { activityEpoch: sec(50) }),
        session('search-memory', { activityEpoch: sec(60) }),
        session('docs', { activityEpoch: sec(70) }),
      ],
      insights: new Map(
        [
          agent('search-speed', { title: 'Search index rebuild speed', turnAt: sec(50) }),
          agent('search-memory', { title: 'Search index rebuild memory', turnAt: sec(60) }),
          agent('docs', { title: 'Docs website theme', turnAt: sec(70) }),
        ].map((a) => [a.session, a]),
      ),
    })
    expect(titles(/Needs you/)).toEqual(['search-speed', 'docs', 'search-memory'])
  })

  it('spreads out a busy topic even when its titles share nothing', () => {
    const names = ['billing-retry', 'billing-refunds', 'billing-export', 'billing-tax', 'search', 'notes', 'deploy', 'docs', 'metrics']
    const words = ['queue', 'ledger', 'report', 'rates', 'index', 'journal', 'rollout', 'website', 'graphs']
    renderOverview({
      sessions: names.map((n) => session(n)),
      insights: new Map(names.map((n, i) => [n, agent(n, { title: words[i], turnAt: sec(10 * (i + 1)) })])),
    })
    const top = titles(/Needs you/).slice(0, 4)
    expect(top.slice(0, 2)).toEqual(['billing-retry', 'search'])
    expect(top.filter((n) => n?.startsWith('billing'))).toHaveLength(2)
  })

  it('keeps the blocked oldest first and above every finished turn, however alike they are', () => {
    renderOverview({
      sessions: ['b1', 'b2', 'r1'].map((n) => session(n)),
      insights: new Map(
        [
          agent('b1', { state: 'waiting', title: 'Search index rebuild', since: sec(300) }),
          agent('b2', { state: 'waiting', title: 'Search index rebuild', since: sec(200) }),
          agent('r1', { title: 'Docs website theme', turnAt: sec(100) }),
        ].map((a) => [a.session, a]),
      ),
    })
    expect(titles(/Needs you/)).toEqual(['b1', 'b2', 'r1'])
  })

  it('shelves the rest by the words their names share, singletons ungrouped, and parks the week-old ones collapsed', () => {
    renderOverview()
    expect(titles(/Recent/)).toEqual(['shell-late', 'shell-early', 'mid'])
    expect(screen.getByRole('heading', { name: 'shell 2' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ungrouped 1' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Idle over a week/ }).closest('details')).not.toHaveAttribute('open')
  })

  it('names each card by its title and describes it with its state and summary', () => {
    renderOverview()
    const card = screen.getByRole('button', { name: 'Newer turn' })
    expect(card).toHaveAccessibleDescription(/New turn.*Report drafted in CR-9/)
  })

  it('heads a tile with its session name when the title says nothing, shortens links, and names an unusual model only', () => {
    renderOverview({
      sessions: ['short', 'linked', 'usual-a', 'usual-b'].map((n) => session(n)),
      insights: new Map(
        [
          agent('short', { title: 'CR', model: 'claude-opus-5-5' }),
          agent('linked', { title: 'see https://chat.example/archives/C0123', model: 'claude-opus-5-5' }),
          agent('usual-a', { title: 'Tidy the release notes', model: 'claude-opus-5-5' }),
          agent('usual-b', { title: 'Rebuild the search index', model: 'claude-fable-5' }),
        ].map((a) => [a.session, a]),
      ),
    })
    expect(screen.getByRole('button', { name: 'short' })).not.toHaveTextContent('CR')
    expect(screen.getByRole('button', { name: 'see chat.example/…/C0123' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tidy the release notes' })).not.toHaveTextContent('opus')
    expect(screen.getByRole('button', { name: 'Rebuild the search index' })).toHaveTextContent('fable-5')
  })

  it('says how long a working agent has been quiet, and spells out why one is blocked or failed', () => {
    renderOverview({
      sessions: [session('busy', { activityEpoch: sec(30) }), session('stuck', { activityEpoch: sec(1200) }), session('zed'), session('boom')],
      insights: new Map(
        [
          agent('busy', { state: 'working', title: 'Busy one', since: sec(1500) }),
          agent('stuck', { state: 'working', title: 'Stuck one', since: sec(1500) }),
          agent('zed', { state: 'waiting', waitingFor: 'permission prompt', title: 'Blocked longest', since: sec(900) }),
          agent('boom', { state: 'error', error: 'rate_limit', title: 'Failed one', turnAt: sec(50) }),
        ].map((a) => [a.session, a]),
      ),
    })
    expect(screen.getByRole('button', { name: 'Busy one' })).not.toHaveTextContent('Quiet')
    expect(screen.getByRole('button', { name: 'Stuck one' })).toHaveTextContent('Quiet for 20m')
    expect(screen.getByRole('button', { name: 'Blocked longest' })).toHaveTextContent('Waiting on you: permission prompt')
    expect(screen.getByRole('button', { name: 'Failed one' })).toHaveTextContent('Error: rate_limit')
  })

  it('opens or marks a tile seen from its hover actions without adding tab stops', () => {
    const { onOpen, onSeen } = renderOverview()
    const open = screen.getByRole('button', { name: 'Open newer' })
    expect(open).toHaveAttribute('tabindex', '-1')
    fireEvent.click(open)
    expect(onOpen).toHaveBeenCalledWith('newer')
    fireEvent.click(screen.getByRole('button', { name: 'Mark newer seen' }))
    expect(onSeen).toHaveBeenCalledWith(['newer'])
    expect(screen.queryByRole('button', { name: 'Mark mid seen' })).toBeNull()
  })

  it('opens a long shelf out into a grid without changing its order', () => {
    const names = ['deploy-a', 'deploy-b', 'deploy-c', 'deploy-d', 'notes', 'search', 'docs', 'metrics', 'billing', 'mail']
    renderOverview({ sessions: names.map((n, i) => session(n, { activityEpoch: sec(10 + i) })), insights: new Map(), seenAt: () => sec(0) })
    const list = screen.getByRole('list', { name: 'deploy 4' })
    expect(list).toHaveClass('shelf')
    fireEvent.click(screen.getByRole('button', { name: 'See all 4' }))
    expect(list).not.toHaveClass('shelf')
    expect(within(list).getAllByRole('button').filter((b) => b.classList.contains('card')).map((b) => b.dataset.session)).toEqual(names.slice(0, 4))
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
    const lanes = screen.getByRole('region', { name: /Needs you/ }).parentElement!
    fireEvent.mouseEnter(lanes)
    view.rerender({ insights: insights([agent('older', { state: 'waiting', since: sec(5000), title: 'Older turn' })]) })
    expect(titles(/Needs you/)).toEqual(['zed', 'alpha', 'newer', 'older'])
    fireEvent.mouseLeave(lanes)
    expect(titles(/Needs you/)).toEqual(['older', 'zed', 'alpha', 'newer'])
  })

  it('keeps a session that starts waiting on you above the finished turns while held', () => {
    const view = renderOverview()
    const lanes = screen.getByRole('region', { name: /Needs you/ }).parentElement!
    fireEvent.mouseEnter(lanes)
    view.rerender({
      sessions: [...SESSIONS, session('late')],
      insights: insights([agent('late', { state: 'waiting', since: sec(50), title: 'Late' })]),
    })
    expect(titles(/Needs you/)).toEqual(['zed', 'alpha', 'late', 'newer', 'older'])
  })

  it('leaves a parked tile in place while held with Parked open', () => {
    const view = renderOverview()
    const parked = screen.getByRole('heading', { name: /Idle over a week/ }).closest('details')!
    parked.open = true
    fireEvent(parked, new Event('toggle'))
    const lanes = screen.getByRole('region', { name: /Needs you/ }).parentElement!
    fireEvent.mouseEnter(lanes)
    view.rerender({ insights: insights([agent('old', { state: 'waiting', since: sec(30), title: 'Old one' })]) })
    expect(titles(/Needs you/)).toEqual(['zed', 'alpha', 'newer', 'older'])
    expect(screen.getByRole('button', { name: 'old' }).closest('details')).toBe(parked)
  })

  it('walks a shelf that appears while held in the order it is drawn', () => {
    const view = renderOverview()
    const parked = screen.getByRole('heading', { name: /Idle over a week/ }).closest('details')!
    parked.open = true
    fireEvent(parked, new Event('toggle'))
    expect(screen.getByRole('button', { name: 'old' })).toBeVisible()
    const lanes = screen.getByRole('region', { name: /Needs you/ }).parentElement!
    fireEvent.mouseEnter(lanes)
    view.rerender({ sessions: [...SESSIONS, session('deploy-one', { activityEpoch: sec(8) }), session('deploy-two', { activityEpoch: sec(9) })] })
    expect(within(screen.getByRole('region', { name: /Recent/ })).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'shell 2',
      'deploy 2',
      'Ungrouped 1',
    ])
    const drawn = [...document.querySelectorAll<HTMLElement>('.lanes .card')].map((c) => c.dataset.session)
    const walked = drawn.map(() => {
      fireEvent.keyDown(document.body, { key: 'j' })
      return (document.activeElement as HTMLElement).dataset.session
    })
    expect(walked).toEqual(drawn)
  })

  it('does not pull focus back after a key at the last tile', () => {
    const view = renderOverview()
    for (let i = 0; i < 20; i += 1) fireEvent.keyDown(document.activeElement ?? document.body, { key: 'j' })
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    view.rerender({ now: NOW + 1000 })
    expect(input).toHaveFocus()
    input.remove()
  })

  it('holds the topic shelves still too, even when a session that shaped them ends', () => {
    const view = renderOverview()
    const lanes = screen.getByRole('region', { name: /Needs you/ }).parentElement!
    fireEvent.mouseEnter(lanes)
    view.rerender({ sessions: SESSIONS.filter((s) => s.name !== 'shell-early') })
    expect(screen.getByRole('list', { name: 'shell 1' })).toBeInTheDocument()
    expect(titles(/Recent/)).toEqual(['shell-late', 'mid'])
    fireEvent.mouseLeave(lanes)
    expect(screen.queryByRole('list', { name: /^shell/ })).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Ungrouped 2' })).getAllByRole('button').map((b) => b.dataset.session)).toEqual([
      'shell-late',
      'mid',
    ])
  })
})

describe('Overview details', () => {
  it('lists other sessions on the same topic and selects one when picked', () => {
    renderOverview({
      sessions: [session('billing-retry'), session('billing-refunds'), session('search')],
      insights: new Map([agent('billing-retry', { title: 'Retry queue' }), agent('billing-refunds', { title: 'Refund ledger' })].map((a) => [a.session, a])),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry queue' }))
    const details = within(screen.getByRole('article', { name: 'billing-retry details' }))
    const related = within(details.getByRole('heading', { name: 'Same topic' }).parentElement!)
    expect(related.getAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringContaining('billing-refunds')])
    fireEvent.click(related.getByRole('button'))
    expect(screen.getByRole('article', { name: 'billing-refunds details' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refund ledger' })).toHaveFocus()
  })

  it('leaves focus on the page when the picked session has no tile on screen, and reads each row line', () => {
    renderOverview({
      sessions: [session('billing-retry'), session('billing-old', { activityEpoch: sec(9 * 86400) }), session('search')],
      insights: new Map([agent('billing-retry', { title: 'Retry queue' }), agent('billing-old', { title: 'Old ledger' })].map((a) => [a.session, a])),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry queue' }))
    const details = within(screen.getByRole('article', { name: 'billing-retry details' }))
    fireEvent.click(within(details.getByText('Same topic').parentElement!).getByRole('button'))
    expect(document.body).toHaveFocus()
    expect(screen.getByRole('article', { name: 'billing-old details' })).toBeInTheDocument()
    const parked = screen.getByRole('heading', { name: /Idle over a week/ }).closest('details')!
    parked.open = true
    fireEvent(parked, new Event('toggle'))
    expect(screen.getByRole('button', { name: 'billing-old' })).toHaveAccessibleDescription(/Old ledger/)
  })
})

describe('Overview keyboard', () => {
  it('moves with j and k from anywhere on the page, brings the tile into view, and keeps one tab stop', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    renderOverview()
    fireEvent.keyDown(document.body, { key: 'j' })
    const first = screen.getByRole('button', { name: 'Blocked longest' })
    expect(scroll.mock.contexts[0]).toBe(first)
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(first).toHaveAttribute('aria-pressed', 'true')
    expect(first).toHaveFocus()
    expect(document.querySelectorAll('.card[tabindex="0"]')).toHaveLength(1)
    fireEvent.keyDown(first, { key: 'j' })
    expect(screen.getByRole('button', { name: 'Blocked lately' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Blocked lately' }), { key: 'k' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(screen.getByRole('button', { name: 'Blocked lately' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Blocked lately' }), { key: 'ArrowLeft' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(first).toHaveAttribute('aria-pressed', 'true')
    const input = document.createElement('input')
    document.body.append(input)
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(first).toHaveAttribute('aria-pressed', 'true')
    input.remove()
    fireEvent.keyDown(document.body, { key: 'ArrowRight', shiftKey: true })
    expect(first).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByRole('button', { name: 'Blocked lately' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('steps with an arrow from the tile that has focus, even before anything is selected', () => {
    renderOverview()
    const first = screen.getByRole('button', { name: 'Blocked longest' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(first).toHaveAttribute('aria-pressed', 'false')
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(screen.getByRole('button', { name: 'Blocked lately' })).toHaveFocus()
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

  it('opens and marks seen the tile that has focus, not an older selection', () => {
    const { onOpen, onSeen, rerender } = renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Newer turn' }))
    const older = screen.getByRole('button', { name: 'Older turn' })
    older.focus()
    fireEvent.keyDown(older, { key: 'e' })
    expect(onSeen).toHaveBeenCalledWith(['older'])
    rerender({ now: NOW + 1000 })
    expect(older).toHaveFocus()
    fireEvent.keyDown(older, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('older')
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
