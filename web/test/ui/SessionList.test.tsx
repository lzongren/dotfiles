import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { headline, SessionList, sessionSummary } from '../../src/components/SessionList'
import type { AgentInsight, Session } from '../../src/shared/types'
import { ago } from '../../src/time'

const NOW = 1800000000

function session(overrides: Partial<Session>): Session {
  return {
    name: 'main',
    attached: false,
    clients: 0,
    activityEpoch: NOW - 30,
    bell: false,
    cmd: 'zsh',
    title: '',
    path: '/home/me',
    attachable: true,
    ...overrides,
  }
}

const ROWS: Session[] = [
  session({ name: 'old', activityEpoch: NOW - 86400 * 3 }),
  session({
    name: 'cc-demo',
    activityEpoch: NOW - 120,
    attached: true,
    clients: 2,
    bell: true,
    cmd: 'claude',
    title: '✳ Fix the flaky retry test',
    path: '/home/me/work/demo',
  }),
  session({ name: 'api - ~/work/api', activityEpoch: NOW - 60, attachable: false, cmd: 'vim' }),
]

function renderList(rows = ROWS, extra: { active?: string | null; onAttach?: (name: string) => void } = {}) {
  const onAttach = extra.onAttach ?? vi.fn()
  render(<SessionList sessions={rows} now={NOW * 1000} active={extra.active ?? null} onAttach={onAttach} />)
  return onAttach
}

const rows = () => screen.getAllByRole('button')

describe('SessionList', () => {
  it('orders sessions by most recent activity', () => {
    renderList()
    expect(rows().map((r) => r.querySelector('.session-name')?.textContent)).toEqual([
      'api - ~/work/api',
      'cc-demo',
      'old',
    ])
  })

  it('shows the headline from the pane title, without its status glyph', () => {
    renderList()
    const row = screen.getByRole('button', { name: /cc-demo/ })
    expect(row).toHaveTextContent('Fix the flaky retry test')
    expect(row).not.toHaveTextContent('✳')
  })

  it('marks a title left behind by an agent that has exited as the last task', () => {
    renderList([session({ name: 'done', cmd: 'zsh', title: '✳ Ship the release' })])
    expect(screen.getByRole('button')).toHaveTextContent('last: Ship the release')
  })

  it('falls back to the command and path when there is no title', () => {
    renderList()
    expect(screen.getByRole('button', { name: /old/ })).toHaveTextContent('zsh · /home/me')
  })

  it('shows idle time and a ringing bell with one polite announcement, and leaves attached clients to the tooltip', () => {
    const { container } = { container: document.body }
    renderList()
    const row = screen.getByRole('button', { name: /cc-demo/ })
    expect(row).toHaveTextContent('2m')
    expect(row).toHaveAccessibleName(/cc-demo.*bell.*attached/)
    expect(row.querySelector('.session-bell')).not.toBeNull()
    expect(row).toHaveAttribute('title', expect.stringContaining('attached in 2 terminals'))
    const regions = container.querySelectorAll('[aria-live="polite"]')
    expect(regions).toHaveLength(1)
    expect(regions[0]).toHaveTextContent('cc-demo needs attention')
  })

  it('keeps a bell and an attached client visible even when the agent state wins the mark', () => {
    const ringing = session({ name: 'ring', bell: true, attached: true, clients: 1, cmd: 'claude' })
    const insights = new Map([['ring', { session: 'ring', agent: 'claude' as const, state: 'ready' as const, artifacts: [], commits: 0 }]])
    render(<SessionList sessions={[ringing]} insights={insights} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    const row = screen.getByRole('button', { name: /ring/ })
    expect(row.querySelector('.session-bell')).not.toBeNull()
    expect(row).toHaveAccessibleName(/bell.*attached/)
  })

  it('groups sessions under Needs you, Working, New, Recent and a collapsed Idle, each with a count', () => {
    const agent = (name: string, over: Partial<AgentInsight>): [string, AgentInsight] => [
      name,
      { session: name, agent: 'claude', artifacts: [], commits: 0, state: 'ready', ...over },
    ]
    const insights = new Map<string, AgentInsight>([
      agent('wait', { state: 'waiting', since: NOW - 500, waitingFor: 'permission prompt' }),
      agent('boom', { state: 'error', since: NOW - 2000, error: 'rate_limit' }),
      agent('build', { state: 'working', since: NOW - 60 }),
      agent('stuck', { state: 'working', since: NOW - 1600 }),
      agent('done', { turnAt: NOW - 100 }),
    ])
    const sessions = [
      session({ name: 'wait', cmd: 'claude' }),
      session({ name: 'boom', cmd: 'claude', activityEpoch: NOW - 2000 }),
      session({ name: 'build', cmd: 'claude' }),
      session({ name: 'stuck', cmd: 'claude', activityEpoch: NOW - 1500 }),
      session({ name: 'done', cmd: 'claude' }),
      session({ name: 'ring', bell: true }),
      session({ name: 'shell' }),
      session({ name: 'ancient', activityEpoch: NOW - 8 * 86400 }),
    ]
    render(<SessionList sessions={sessions} insights={insights} now={NOW * 1000} seenAt={() => NOW - 1000} active={null} onAttach={vi.fn()} />)
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual([
      'Needs you 3',
      'Working 2',
      'New since you looked 1',
      'Recent 1',
      'Idle over a week 1',
    ])
    const needs = within(screen.getByRole('group', { name: 'Needs you 3' })).getAllByRole('button')
    expect(needs.map((r) => r.querySelector('.session-why')?.textContent)).toEqual(['Error: rate_limit', 'Permission prompt', 'Bell rang'])
    expect(screen.getByRole('button', { name: /stuck/ })).toHaveTextContent('quiet 25m')
    expect(screen.queryByRole('button', { name: /ancient/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Idle over a week 1' }))
    expect(screen.getByRole('button', { name: /ancient/ })).toBeInTheDocument()
  })

  it('keeps a row in its section while held so nothing moves under the pointer, then moves it', () => {
    const working = new Map<string, AgentInsight>([['b', { session: 'b', agent: 'claude', artifacts: [], commits: 0, state: 'working', since: NOW - 60 }]])
    const sessions = [session({ name: 'a', activityEpoch: NOW - 10 }), session({ name: 'b', cmd: 'claude' }), session({ name: 'c', activityEpoch: NOW - 50 })]
    const props = { now: NOW * 1000, seenAt: () => NOW, active: null, onAttach: vi.fn() }
    const view = render(<SessionList sessions={sessions} insights={working} {...props} />)
    fireEvent.mouseEnter(screen.getByRole('navigation'))
    const waiting = new Map([['b', { ...working.get('b')!, state: 'waiting' as const }]])
    const reordered = [session({ name: 'a', activityEpoch: NOW - 90 }), sessions[1], sessions[2]]
    view.rerender(<SessionList sessions={reordered} insights={waiting} {...props} />)
    const headings = () => screen.getAllByRole('heading').map((h) => h.textContent)
    expect(headings()).toEqual(['Nothing needs you', 'Working 1', 'Recent 2'])
    expect(within(screen.getByRole('group', { name: 'Recent 2' })).getAllByRole('button').map((r) => r.querySelector('.session-name')?.textContent)).toEqual(['a', 'c'])
    fireEvent.mouseLeave(screen.getByRole('navigation'))
    expect(headings()).toEqual(['Needs you 1', 'Recent 2'])
  })

  it('does not hold while focus is on a section toggle, only on a row', () => {
    const sessions = [session({ name: 'a' }), session({ name: 'old', activityEpoch: NOW - 8 * 86400 })]
    const props = { now: NOW * 1000, seenAt: () => NOW, active: null, onAttach: vi.fn() }
    const view = render(<SessionList sessions={sessions} {...props} />)
    screen.getByRole('button', { name: /Idle over a week/ }).focus()
    view.rerender(<SessionList sessions={[...sessions, session({ name: 'ring', bell: true, activityEpoch: NOW + 5 })]} {...props} />)
    expect(screen.getAllByRole('heading')[0]).toHaveTextContent('Needs you 1')
  })

  it('keeps the open session visible inside a collapsed section, and counts attached terminals in the tooltip', () => {
    const old = session({ name: 'old', activityEpoch: NOW - 8 * 86400, attached: true, clients: 2 })
    render(<SessionList sessions={[session({ name: 'a' }), old, session({ name: 'older', activityEpoch: NOW - 9 * 86400 })]} now={NOW * 1000} active="old" onAttach={vi.fn()} />)
    const idle = within(screen.getByRole('group', { name: /Idle over a week/ }))
    expect(idle.getAllByRole('button').map((b) => b.querySelector('.session-name')?.textContent ?? b.getAttribute('aria-expanded'))).toEqual(['false', 'old'])
    expect(idle.getByRole('button', { name: /^old/ })).toHaveAttribute('title', expect.stringContaining('attached in 2 terminals'))
  })

  it('says so when nothing needs you', () => {
    renderList()
    expect(screen.getAllByRole('heading')[0]).toHaveTextContent('Nothing needs you')
  })

  it('attaches on click, but not for a name the web cannot use', () => {
    const onAttach = renderList()
    fireEvent.click(screen.getByRole('button', { name: /cc-demo/ }))
    expect(onAttach).toHaveBeenCalledWith('cc-demo')
    const blocked = screen.getByRole('button', { name: /api - ~/ })
    expect(blocked).toHaveAttribute('aria-disabled', 'true')
    expect(blocked).toHaveAttribute('title', expect.stringContaining('cannot be used'))
    fireEvent.click(blocked)
    expect(onAttach).toHaveBeenCalledTimes(1)
  })

  it('keeps the full path in the tooltip of attachable rows', () => {
    renderList()
    expect(screen.getByRole('button', { name: /cc-demo/ })).toHaveAttribute('title', expect.stringMatching(/^cc-demo\n.*\n\/home\/me\/work\/demo(\n|$)/))
  })

  it('marks the session whose tab is active', () => {
    renderList(ROWS, { active: 'cc-demo' })
    expect(screen.getByRole('button', { name: /cc-demo/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /old/ })).not.toHaveAttribute('aria-current')
  })

  it('has an empty state that points at the search box', () => {
    renderList([])
    expect(screen.getByText(/No sessions yet/)).toBeInTheDocument()
  })

  it('re-renders idle times as the clock advances', () => {
    const { rerender } = render(<SessionList sessions={[ROWS[1]]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveTextContent('2m')
    act(() => {
      rerender(<SessionList sessions={[ROWS[1]]} now={(NOW + 3600) * 1000} active={null} onAttach={vi.fn()} />)
    })
    expect(screen.getByRole('button')).toHaveTextContent('1h')
  })
})

describe('SessionList ordering while in use', () => {
  const names = () => screen.getAllByRole('button').map((r) => r.querySelector('.session-name')?.textContent)

  it('holds its order while the pointer is over it, and re-sorts after it leaves', () => {
    const a = session({ name: 'a', activityEpoch: NOW - 10 })
    const b = session({ name: 'b', activityEpoch: NOW - 20 })
    const { rerender } = render(<SessionList sessions={[a, b]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    expect(names()).toEqual(['a', 'b'])
    fireEvent.mouseEnter(screen.getByRole('navigation'))
    const bumped = [a, { ...b, activityEpoch: NOW - 1 }]
    rerender(<SessionList sessions={bumped} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    expect(names()).toEqual(['a', 'b'])
    fireEvent.mouseLeave(screen.getByRole('navigation'))
    expect(names()).toEqual(['b', 'a'])
  })

  it('holds its order while a row has keyboard focus', () => {
    const a = session({ name: 'a', activityEpoch: NOW - 10 })
    const b = session({ name: 'b', activityEpoch: NOW - 20 })
    const { rerender } = render(<SessionList sessions={[a, b]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    act(() => {
      screen.getAllByRole('button')[1].focus()
    })
    rerender(<SessionList sessions={[a, { ...b, activityEpoch: NOW - 1 }]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    expect(names()).toEqual(['a', 'b'])
  })

  it('stops holding once the focused row disappears, even though no blur reaches the list', () => {
    const a = session({ name: 'a', activityEpoch: NOW - 10 })
    const b = session({ name: 'b', activityEpoch: NOW - 20 })
    const c = session({ name: 'c', activityEpoch: NOW - 30 })
    const { rerender } = render(<SessionList sessions={[a, b, c]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    act(() => {
      screen.getAllByRole('button')[0].focus()
    })
    rerender(<SessionList sessions={[b, c]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    act(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    rerender(<SessionList sessions={[b, { ...c, activityEpoch: NOW - 1 }]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    expect(names()).toEqual(['c', 'b'])
  })

  it('stops holding after the list empties under the pointer', () => {
    const a = session({ name: 'a', activityEpoch: NOW - 10 })
    const b = session({ name: 'b', activityEpoch: NOW - 20 })
    const { rerender } = render(<SessionList sessions={[a, b]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    fireEvent.mouseEnter(screen.getByRole('navigation'))
    rerender(<SessionList sessions={[]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    rerender(<SessionList sessions={[a, { ...b, activityEpoch: NOW - 1 }]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    expect(names()).toEqual(['b', 'a'])
  })

  it('keeps new sessions visible while frozen, after the held ones', () => {
    const a = session({ name: 'a', activityEpoch: NOW - 10 })
    const { rerender } = render(<SessionList sessions={[a]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    fireEvent.mouseEnter(screen.getByRole('navigation'))
    rerender(
      <SessionList sessions={[a, session({ name: 'new', activityEpoch: NOW })]} now={NOW * 1000} active={null} onAttach={vi.fn()} />,
    )
    expect(names()).toEqual(['a', 'new'])
  })

  it('announces ringing sessions in a stable order regardless of activity', () => {
    render(
      <SessionList
        sessions={[session({ name: 'zeta', bell: true, activityEpoch: NOW }), session({ name: 'alpha', bell: true, activityEpoch: NOW - 99 })]}
        now={NOW * 1000}
        active={null}
        onAttach={vi.fn()}
      />,
    )
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('alpha, zeta needs attention')
  })

  it('renders sessions from an older server that sends no title', () => {
    const legacy = { ...session({ name: 'legacy' }), title: undefined } as unknown as Session
    render(<SessionList sessions={[legacy]} now={NOW * 1000} active={null} onAttach={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveTextContent('zsh · /home/me')
  })
})

describe('sessionSummary', () => {
  it('treats the title as live while a program runs, and as left over at a shell prompt', () => {
    expect(sessionSummary(session({ cmd: 'claude', title: '✳ Fix it' }))).toEqual({ text: 'Fix it', live: true })
    expect(sessionSummary(session({ cmd: 'codex', title: 'Review | x' }))).toEqual({ text: 'Review | x', live: true })
    expect(sessionSummary(session({ cmd: 'node', title: 'Review | x' }))).toEqual({ text: 'Review | x', live: true })
    expect(sessionSummary(session({ cmd: 'vim', title: 'notes.md' }))).toEqual({ text: 'notes.md', live: true })
    expect(sessionSummary(session({ cmd: 'zsh', title: '✳ Fix it' }))).toEqual({ text: 'last: Fix it', live: false })
    expect(sessionSummary(session({ cmd: 'bash', title: '✳ Fix it' }))).toEqual({ text: 'last: Fix it', live: false })
    expect(sessionSummary(session({ cmd: 'vim', title: '', path: '/home/me/x' }))).toEqual({
      text: 'vim · /home/me/x',
      live: false,
    })
  })
})

describe('headline', () => {
  it("drops an agent's default title, which says nothing about the work", () => {
    expect(headline(session({ cmd: 'claude', title: '✳ Claude Code' }))).toBe('')
    expect(headline(session({ cmd: 'codex', title: 'Codex' }))).toBe('')
    expect(headline(session({ cmd: 'claude', title: '✳ Claude Code tag rollout' }))).toBe('Claude Code tag rollout')
  })

  it('strips leading status glyphs and spaces but keeps the text', () => {
    expect(headline(session({ title: '✳ Fix it' }))).toBe('Fix it')
    expect(headline(session({ title: '⠂ Working on it' }))).toBe('Working on it')
    expect(headline(session({ title: 'Review the work ¦ logs' }))).toBe('Review the work ¦ logs')
    expect(headline(session({ title: '' }))).toBe('')
  })
})

describe('ago', () => {
  it('mirrors the devbox_ago buckets', () => {
    const now = NOW * 1000
    expect(ago(now, NOW - 5)).toBe('5s')
    expect(ago(now, NOW - 60)).toBe('1m')
    expect(ago(now, NOW - 3599)).toBe('59m')
    expect(ago(now, NOW - 3600)).toBe('1h')
    expect(ago(now, NOW - 86400)).toBe('1d')
    expect(ago(now, NOW + 10)).toBe('0s')
  })
})
