import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useImperativeHandle, type ReactNode, type Ref } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalHandle } from '../../src/components/Terminal'
import { TerminalTabs } from '../../src/components/TerminalTabs'
import type { AgentInsight, Session } from '../../src/shared/types'

const term = vi.hoisted(() => ({ focus: vi.fn(), paste: vi.fn(() => true), input: vi.fn() }))

vi.mock('../../src/components/Terminal', () => ({
  TerminalPane: ({ name, tools, side, ref }: { name: string; tools?: ReactNode; side?: ReactNode; ref?: Ref<TerminalHandle> }) => {
    useImperativeHandle(ref, () => term)
    return (
      <div data-testid={`pane-${name}`}>
        {tools}
        <div className="terminal-body">{side}</div>
      </div>
    )
  },
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
  localStorage.clear()
  term.focus.mockClear()
  term.paste.mockClear().mockReturnValue(true)
  term.input.mockClear()
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
  it('counts the links and files it lists, and opens a file beside the terminal', async () => {
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
    const pane = within(screen.getByTestId('pane-api')).getByRole('complementary', { name: 'plan.md' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('region', { name: 'api artifacts' })).toBeNull()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(await within(pane).findByRole('heading', { name: 'The plan' })).toBeInTheDocument()
    await waitFor(() => expect(within(pane).getByRole('region', { name: 'plan.md' })).toHaveFocus())
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
    expect(screen.getByRole('button', { name: 'notes.md' }).nextSibling).toHaveTextContent(/^in \/tmp\/$/)
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

const TWO_TABS = (open: string[], active: string, insights = INSIGHTS, dock: { session: string; path: string } | null = null, api = session('api')) => (
  <TerminalTabs
    tabs={open}
    active={active}
    sessions={[api, session('web')]}
    insights={insights}
    now={NOW}
    dock={dock}
    onSelect={vi.fn()}
    onClose={vi.fn()}
  />
)

async function docked(text = '# The plan') {
  vi.mocked(fetch).mockImplementation(async () =>
    Response.json({ path: '/home/me/work/api/docs/plan.md', size: 10, mtime: sec(30), kind: 'text', text, truncated: false }),
  )
  const view = render(TWO_TABS(['api', 'web'], 'api'))
  fireEvent.click(within(screen.getByTestId('pane-api')).getByRole('button', { name: /Artifacts/ }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'plan.md' }))
  })
  const pane = screen.getByRole('complementary', { name: 'plan.md' })
  await within(pane).findByRole('heading', { name: 'The plan' })
  const body = within(pane).getByRole('region', { name: 'plan.md' })
  await waitFor(() => expect(body).toHaveFocus())
  return { ...view, pane, body }
}

describe('a file open beside the terminal', () => {
  it('stays with its tab, and goes when the tab closes', async () => {
    const { rerender } = await docked()
    rerender(TWO_TABS(['api', 'web'], 'web'))
    expect(within(screen.getByTestId('pane-api')).getByRole('complementary', { name: 'plan.md', hidden: true })).toBeInTheDocument()
    expect(within(screen.getByTestId('pane-web')).queryByRole('complementary', { hidden: true })).toBeNull()
    rerender(TWO_TABS(['web'], 'web'))
    rerender(TWO_TABS(['api', 'web'], 'api'))
    expect(screen.queryByRole('complementary', { hidden: true })).toBeNull()
  })

  it('opens beside the terminal when asked from the Overview, leaving the keys with the terminal', async () => {
    const { rerender } = render(TWO_TABS(['web'], 'web'))
    await act(async () => {
      rerender(TWO_TABS(['web', 'api'], 'api', INSIGHTS, { session: 'api', path: '/home/me/work/api/docs/plan.md' }))
    })
    const pane = within(screen.getByTestId('pane-api')).getByRole('complementary', { name: 'plan.md' })
    expect(within(pane).getByRole('region', { name: 'plan.md' })).not.toHaveFocus()
  })

  it('hands the keys back: Escape returns to the terminal and printable keys type into it', async () => {
    const { body } = await docked()
    fireEvent.keyDown(body, { key: 'Escape' })
    expect(term.focus).toHaveBeenLastCalledWith(true)
    for (const key of [' ', 'Enter', 'ArrowDown']) fireEvent.keyDown(body, { key })
    fireEvent.keyDown(body, { key: 'c', metaKey: true })
    fireEvent.keyDown(body, { key: 'a', isComposing: true })
    expect(term.input).not.toHaveBeenCalled()
    const palette = vi.fn()
    document.addEventListener('keydown', palette)
    fireEvent.keyDown(body, { key: '/' })
    document.removeEventListener('keydown', palette)
    expect(term.input).toHaveBeenCalledWith('/')
    expect(palette).not.toHaveBeenCalled()
    term.focus.mockClear()
    fireEvent.keyDown(body, { key: 'F6' })
    expect(term.focus).toHaveBeenCalledWith(false)
  })

  it('quotes the selected text into the reply without sending it', async () => {
    const { pane, body, rerender } = await docked('# The plan\n\nStep one\nStep two')
    const quote = within(pane).getByRole('button', { name: 'Quote into reply' })
    const status = within(pane).getByRole('status')
    expect(quote).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(quote)
    expect(status).toHaveTextContent('Select text in the file first')
    expect(term.paste).not.toHaveBeenCalled()

    const select = (node: Node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
      act(() => {
        document.dispatchEvent(new Event('selectionchange'))
      })
    }
    select(within(body).getByRole('article'))
    expect(quote).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(quote)
    expect(term.paste).toHaveBeenCalledWith('> The plan\n> Step one\n> Step two\n\n')
    expect(term.focus).toHaveBeenCalled()
    expect(status).toHaveTextContent('Quoted into your reply, not sent')

    term.paste.mockReturnValueOnce(false)
    fireEvent.click(quote)
    expect(status).toHaveTextContent("The agent isn't in front in this terminal, so nothing was sent")
    rerender(TWO_TABS(['api', 'web'], 'api', INSIGHTS, null, { ...session('api'), cmd: 'zsh' }))
    expect(quote).toHaveAttribute('aria-disabled', 'true')
    term.paste.mockClear()
    fireEvent.click(quote)
    expect(term.paste).not.toHaveBeenCalled()
    expect(status).toHaveTextContent("The agent isn't in front in this terminal, so nothing was sent")
    rerender(TWO_TABS(['api', 'web'], 'api'))

    select(within(pane).getByRole('heading', { name: 'plan.md' }))
    expect(quote).toHaveAttribute('aria-disabled', 'true')
    document.getSelection()!.removeAllRanges()
  })

  it('says a long quote shows as pasted text in Claude Code', async () => {
    const { pane, body } = await docked(`# The plan\n\n${'word '.repeat(200)}`)
    const range = document.createRange()
    range.selectNodeContents(within(body).getByRole('article'))
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    fireEvent.click(within(pane).getByRole('button', { name: 'Quote into reply' }))
    expect(within(pane).getByRole('status')).toHaveTextContent('Claude Code shows a long quote as [Pasted text]')
    document.getSelection()!.removeAllRanges()
  })

  it('waits to read an edit while its tab is hidden or text in it is selected', async () => {
    const { rerender, body } = await docked()
    const edited = new Map(INSIGHTS)
    const api = INSIGHTS.get('api')!
    edited.set('api', { ...api, files: [{ ...api.files![0], at: sec(1), count: 3 }, api.files![1]] })
    const reads = () => vi.mocked(fetch).mock.calls.length
    rerender(TWO_TABS(['api', 'web'], 'web', edited))
    rerender(TWO_TABS(['api', 'web'], 'web', edited))
    expect(reads()).toBe(1)
    rerender(TWO_TABS(['api', 'web'], 'api', edited))
    await waitFor(() => expect(reads()).toBe(2))

    const range = document.createRange()
    range.selectNodeContents(within(body).getByRole('article'))
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    const again = new Map(INSIGHTS)
    again.set('api', { ...api, files: [{ ...api.files![0], at: sec(0), count: 4 }, api.files![1]] })
    rerender(TWO_TABS(['api', 'web'], 'api', again))
    expect(reads()).toBe(2)
    document.getSelection()!.removeAllRanges()
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    await waitFor(() => expect(reads()).toBe(3))
  })

  it('closes back to the terminal', async () => {
    const { pane } = await docked()
    fireEvent.click(within(pane).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(term.focus).toHaveBeenCalled()
  })

  describe('the divider', () => {
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1400, bottom: 800, width: 1400, height: 800, toJSON: () => ({}) })
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('resizes from the keyboard within what keeps 80 columns, remembers it, and resets on double-click', async () => {
      await docked()
      const divider = screen.getByRole('separator')
      expect(divider).toHaveAttribute('aria-valuenow', '60')
      fireEvent.focus(divider)
      expect(divider).toHaveAttribute('aria-valuemin', '49')
      expect(divider).toHaveAttribute('aria-valuemax', '74')
      fireEvent.keyDown(divider, { key: 'ArrowLeft' })
      expect(divider).toHaveAttribute('aria-valuenow', '58')
      fireEvent.keyDown(divider, { key: 'Home' })
      expect(divider).toHaveAttribute('aria-valuenow', '49')
      fireEvent.keyDown(divider, { key: 'End' })
      expect(divider).toHaveAttribute('aria-valuenow', '74')
      expect(Number(localStorage.getItem('devbox.preview'))).toBeCloseTo(360 / 1400)
      fireEvent.doubleClick(divider)
      expect(divider).toHaveAttribute('aria-valuenow', '60')
    })

    it('holds the width while dragging, commits it on release, and closes when dragged off the edge', async () => {
      const { container } = await docked()
      const divider = screen.getByRole('separator')
      const terminals = container.querySelector<HTMLElement>('.terminals')!
      divider.setPointerCapture = vi.fn()
      divider.hasPointerCapture = () => true
      fireEvent.pointerDown(divider, { pointerId: 1 })
      expect(terminals).toHaveAttribute('data-resizing')
      const move = (clientX: number) => fireEvent(divider, Object.assign(new MouseEvent('pointermove', { bubbles: true, clientX }), { pointerId: 1 }))
      move(800)
      expect(terminals.style.getPropertyValue('--preview-f')).toBe(String(600 / 1400))
      expect(divider).toHaveAttribute('aria-valuenow', '60')
      fireEvent.pointerUp(divider, { pointerId: 1 })
      expect(terminals).not.toHaveAttribute('data-resizing')
      expect(divider).toHaveAttribute('aria-valuenow', '57')

      fireEvent.pointerDown(divider, { pointerId: 1 })
      move(1300)
      expect(terminals).toHaveAttribute('data-collapse')
      fireEvent.pointerUp(divider, { pointerId: 1 })
      expect(screen.queryByRole('complementary')).toBeNull()
      expect(terminals).not.toHaveAttribute('data-collapse')
      expect(terminals.style.getPropertyValue('--preview-f')).toBe(String(600 / 1400))
      expect(term.focus).toHaveBeenCalled()
    })

    it('lets the terminals fit again when the pane goes away mid-drag', async () => {
      const { container, rerender } = await docked()
      const divider = screen.getByRole('separator')
      divider.setPointerCapture = vi.fn()
      fireEvent.pointerDown(divider, { pointerId: 1 })
      const terminals = container.querySelector<HTMLElement>('.terminals')!
      expect(terminals).toHaveAttribute('data-resizing')
      rerender(TWO_TABS(['web'], 'web'))
      expect(terminals).not.toHaveAttribute('data-resizing')
    })
  })
})
