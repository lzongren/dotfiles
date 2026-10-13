import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
  session('ask'),
  session('busy'),
  session('done'),
  session('quiet', { cmd: 'zsh', path: '/home/me/notes/quiet' }),
  session('old', { activityEpoch: sec(9 * 86400) }),
]

const INSIGHTS = new Map(
  [
    agent('ask', { state: 'waiting', waitingFor: 'permission prompt', title: 'Ship the fix', since: sec(300) }),
    agent('busy', { state: 'working', title: 'Run the evals', since: sec(30) }),
    agent('done', {
      title: 'Write the report',
      summaryAt: sec(100),
      summary: 'Report drafted in CR-9; next, send it.',
      artifacts: [
        { label: 'CR', url: 'https://r.example/CR-9', at: sec(100), hits: 3, said: true },
        { label: 'CR', url: 'https://r.example/CR-1', at: sec(90), hits: 1, said: false },
      ],
    }),
  ].map((a) => [a.session, a]),
)

function renderOverview(seenAt = (_: string) => sec(1000), handlers = { onOpen: vi.fn(), onSeen: vi.fn() }) {
  render(<Overview sessions={SESSIONS} insights={INSIGHTS} now={NOW} seenAt={seenAt} {...handlers} />)
  return handlers
}

const lane = (name: RegExp) => within(screen.getByRole('region', { name }))

describe('Overview', () => {
  it('sorts sessions into lanes by whose move it is', () => {
    renderOverview()
    expect(lane(/Needs you/).getAllByRole('button').map((b) => b.textContent)).toEqual([
      expect.stringContaining('Ship the fix'),
      expect.stringContaining('Write the report'),
    ])
    expect(lane(/Working/).getByRole('button')).toHaveTextContent('Run the evals')
    expect(lane(/Recent/).getByRole('heading', { name: 'notes' })).toBeInTheDocument()
    expect(screen.getByText(/Parked/).closest('details')).not.toHaveAttribute('open')
  })

  it('moves a finished turn out of Needs you once you have seen it', () => {
    renderOverview(() => sec(10))
    expect(lane(/Needs you/).getAllByRole('button')).toHaveLength(1)
    expect(lane(/Recent/).getByRole('button', { name: /Write the report/ })).toBeInTheDocument()
  })

  it('shows the selected session in full and lists only artifacts someone mentioned in the ledger', () => {
    renderOverview()
    const ledger = within(screen.getByRole('complementary', { name: 'session details' }))
    expect(ledger.getAllByRole('link').map((l) => l.textContent)).toEqual(['CR-9'])
    fireEvent.click(screen.getByRole('button', { name: /Write the report/ }))
    const details = within(screen.getByRole('article', { name: 'done details' }))
    expect(details.getByText(/Report drafted in CR-9/)).toBeInTheDocument()
    expect(details.getAllByRole('link').map((l) => l.textContent)).toEqual(['CR-9', 'CR-1'])
  })

  it('moves with j/k, opens with Enter, and marks seen with e', () => {
    const { onOpen, onSeen } = renderOverview()
    const overview = screen.getByRole('region', { name: 'overview' })
    fireEvent.keyDown(overview, { key: 'j' })
    expect(screen.getByRole('button', { name: /Ship the fix/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /Ship the fix/ })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: /Ship the fix/ }), { key: 'j' })
    expect(screen.getByRole('button', { name: /Write the report/ })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: /Write the report/ }), { key: 'e' })
    expect(onSeen).toHaveBeenCalledWith('done')
    fireEvent.keyDown(screen.getByRole('button', { name: /Write the report/ }), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('done')
  })
})
