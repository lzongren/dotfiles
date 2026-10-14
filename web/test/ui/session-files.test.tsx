import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalTabs } from '../../src/components/TerminalTabs'
import type { AgentInsight, Session } from '../../src/shared/types'

vi.mock('../../src/components/Terminal', () => ({
  TerminalPane: ({ name, tools }: { name: string; tools?: ReactNode }) => <div data-testid={`pane-${name}`}>{tools}</div>,
}))

const NOW = 1_800_000_000_000
const sec = (ago: number) => NOW / 1000 - ago

const session = (name: string): Session => ({
  name,
  attached: false,
  clients: 0,
  activityEpoch: sec(60),
  bell: false,
  cmd: 'claude',
  title: '',
  path: `/home/me/work/${name}`,
  attachable: true,
})

const INSIGHTS = new Map<string, AgentInsight>([
  [
    'api',
    {
      session: 'api',
      agent: 'claude',
      state: 'ready',
      commits: 0,
      summary: 'Opened PR #7.',
      artifacts: [
        { label: 'PR', url: 'https://git.example/o/r/pull/3', at: sec(90), first: sec(300), hits: 1, said: false },
        { label: 'PR', url: 'https://git.example/o/r/pull/7', at: sec(95), first: sec(250), hits: 2, said: true },
      ],
      files: [
        { path: '/home/me/work/api/docs/plan.md', action: 'created', at: sec(30), count: 2, gone: false },
        { path: '/home/me/work/api/old.py', action: 'deleted', at: sec(40), count: 1, gone: true },
      ],
    },
  ],
  ['web', { session: 'web', agent: 'claude', state: 'working', commits: 0, artifacts: [] }],
])

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ path: '/home/me/work/api/docs/plan.md', size: 10, mtime: sec(30), kind: 'text', text: '# The plan', truncated: false }),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const tabs = (active: string, insights = INSIGHTS) => (
  <TerminalTabs
    tabs={['api', 'web', 'shell']}
    active={active}
    sessions={[session('api'), session('web'), session('shell')]}
    insights={insights}
    now={NOW}
    onSelect={vi.fn()}
    onClose={vi.fn()}
  />
)
const setup = (active = 'api') => render(tabs(active))

describe('artifacts in a session tab', () => {
  it('counts the links and files it lists, and previews a file', async () => {
    setup()
    const toggle = within(screen.getByTestId('pane-api')).getByRole('button', { name: 'Artifacts 3' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const panel = within(screen.getByRole('region', { name: 'api artifacts' }))
    expect(panel.getAllByRole('link').map((a) => a.textContent)).toEqual([
      'PR #7 ★ (named in the summary) (opens in a new tab)',
      'PR #3 (opens in a new tab)',
    ])
    expect(panel.getByText('old.py')).not.toHaveRole('button')
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'plan.md' }))
    })
    const dialog = screen.getByRole('dialog')
    expect(screen.getByRole('heading', { name: 'plan.md' })).toBeInTheDocument()
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Close' }), { key: 'Escape' })
    expect(screen.getByRole('region', { name: 'api artifacts' })).toBeInTheDocument()
    fireEvent.blur(screen.getByRole('button', { name: 'plan.md' }), { relatedTarget: within(dialog).getByRole('button', { name: 'Close' }) })
    fireEvent.pointerDown(dialog)
    expect(screen.getByRole('region', { name: 'api artifacts' })).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/file?session=api&path=%2Fhome%2Fme%2Fwork%2Fapi%2Fdocs%2Fplan.md')
  })

  it('counts at most the 15 links it lists, and says how many are left out', () => {
    const many = Array.from({ length: 18 }, (_, i) => ({ label: 'PR', url: `https://git.example/o/r/pull/${i}`, at: sec(i), first: sec(i), hits: 1, said: false }))
    render(tabs('api', new Map([['api', { session: 'api', agent: 'claude' as const, state: 'ready' as const, commits: 0, artifacts: many }]])))
    const toggle = within(screen.getByTestId('pane-api')).getByRole('button', { name: 'Artifacts 15' })
    fireEvent.click(toggle)
    const panel = within(screen.getByRole('region', { name: 'api artifacts' }))
    expect(panel.getAllByRole('link')).toHaveLength(15)
    expect(panel.getByText('3 more not shown')).toBeInTheDocument()
  })

  it('shows full paths when the tab has outlived its session', () => {
    const files = [{ path: '/tmp/notes.md', action: 'created' as const, at: sec(5), count: 1, gone: false }]
    const insights = new Map([['api', { session: 'api', agent: 'claude' as const, state: 'ready' as const, commits: 0, artifacts: [], files }]])
    render(<TerminalTabs tabs={['api']} active="api" sessions={[]} insights={insights} now={NOW} onSelect={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(within(screen.getByTestId('pane-api')).getByRole('button', { name: /Artifacts/ }))
    expect(screen.getByRole('button', { name: 'notes.md' }).nextSibling).toHaveTextContent(/^\/tmp$/)
  })

  it('says when there is nothing yet, and has no toggle for a plain shell', () => {
    setup('web')
    fireEvent.click(within(screen.getByTestId('pane-web')).getByRole('button', { name: 'Artifacts 0' }))
    const panel = within(screen.getByRole('region', { name: 'web artifacts' }))
    expect(panel.getByText('No pull requests or reviews seen yet.')).toBeInTheDocument()
    expect(panel.getByText('No files written yet.')).toBeInTheDocument()
    expect(within(screen.getByTestId('pane-shell')).queryByRole('button')).toBeNull()
  })

  it('closes on Escape back to the toggle, on a press or Tab outside it, and when the tab or its agent goes away', () => {
    const { rerender } = setup()
    const toggle = within(screen.getByTestId('pane-api')).getByRole('button', { name: /Artifacts/ })
    const region = () => screen.queryByRole('region', { name: 'api artifacts' })
    fireEvent.click(toggle)
    const file = within(region()!).getByRole('button', { name: 'plan.md' })
    expect(toggle.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.pointerDown(file)
    expect(region()).toBeInTheDocument()
    fireEvent.keyDown(file, { key: 'Escape' })
    expect(region()).toBeNull()
    expect(toggle).toHaveFocus()
    fireEvent.click(toggle)
    fireEvent.keyDown(toggle, { key: 'Escape' })
    expect(region()).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.closest('.term-files')).toHaveAttribute('tabindex', '-1')
    fireEvent.click(toggle)
    fireEvent.pointerDown(document.body)
    expect(region()).toBeNull()
    fireEvent.click(toggle)
    fireEvent.blur(within(region()!).getByRole('button', { name: 'plan.md' }), { relatedTarget: null })
    expect(region()).toBeInTheDocument()
    fireEvent.blur(within(region()!).getByRole('button', { name: 'plan.md' }), { relatedTarget: screen.getByRole('tab', { name: 'web' }) })
    expect(region()).toBeNull()

    fireEvent.click(toggle)
    rerender(tabs('web'))
    rerender(tabs('api'))
    expect(region()).toBeNull()
    fireEvent.click(toggle)
    rerender(tabs('api', new Map()))
    rerender(tabs('api'))
    expect(region()).toBeNull()
  })
})
