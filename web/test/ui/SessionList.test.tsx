import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { headline, SessionList } from '../../src/components/SessionList'
import type { Session } from '../../src/shared/types'
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
    name: 'cc-atx',
    activityEpoch: NOW - 120,
    attached: true,
    clients: 2,
    bell: true,
    cmd: 'claude',
    title: '✳ Fix the flaky retry test',
    path: '/home/me/work/atx',
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
      'cc-atx',
      'old',
    ])
  })

  it('shows the headline from the pane title, without its status glyph', () => {
    renderList()
    const row = screen.getByRole('button', { name: /cc-atx/ })
    expect(row).toHaveTextContent('Fix the flaky retry test')
    expect(row).not.toHaveTextContent('✳')
  })

  it('falls back to the command and path when there is no title', () => {
    renderList()
    expect(screen.getByRole('button', { name: /old/ })).toHaveTextContent('zsh · /home/me')
  })

  it('shows client count, idle time, and a bell badge with one polite announcement', () => {
    const { container } = { container: document.body }
    renderList()
    const row = screen.getByRole('button', { name: /cc-atx/ })
    expect(row).toHaveTextContent('×2')
    expect(row).toHaveTextContent('2m')
    expect(row.querySelector('.bell-badge')).toHaveTextContent('bell')
    const regions = container.querySelectorAll('[aria-live="polite"]')
    expect(regions).toHaveLength(1)
    expect(regions[0]).toHaveTextContent('cc-atx needs attention')
  })

  it('attaches on click, but not for a name the web cannot use', () => {
    const onAttach = renderList()
    fireEvent.click(screen.getByRole('button', { name: /cc-atx/ }))
    expect(onAttach).toHaveBeenCalledWith('cc-atx')
    const blocked = screen.getByRole('button', { name: /api - ~/ })
    expect(blocked).toHaveAttribute('aria-disabled', 'true')
    expect(blocked).toHaveAttribute('title', expect.stringContaining('cannot be used'))
    fireEvent.click(blocked)
    expect(onAttach).toHaveBeenCalledTimes(1)
  })

  it('keeps the full path in the tooltip of attachable rows', () => {
    renderList()
    expect(screen.getByRole('button', { name: /cc-atx/ })).toHaveAttribute('title', '/home/me/work/atx')
  })

  it('marks the session whose tab is active', () => {
    renderList(ROWS, { active: 'cc-atx' })
    expect(screen.getByRole('button', { name: /cc-atx/ })).toHaveAttribute('aria-current', 'true')
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

describe('headline', () => {
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
