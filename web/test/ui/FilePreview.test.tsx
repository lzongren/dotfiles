import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Overview } from '../../src/components/Overview'
import type { AgentInsight, FileView, Session } from '../../src/shared/types'

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

const agent = (name: string, over: Partial<AgentInsight>): AgentInsight => ({
  session: name,
  agent: 'claude',
  state: 'ready',
  artifacts: [],
  commits: 0,
  ...over,
})

const INSIGHTS = new Map([
  [
    'api',
    agent('api', {
      title: 'Ship the API',
      files: [
        { path: '/home/me/work/api/docs/plan.md', action: 'created', at: sec(30), count: 2, gone: false },
        { path: '/home/me/work/api/old.py', action: 'deleted', at: sec(40), count: 1, gone: true },
        { path: '/home/me/work/api/src/deep/er/x.ts', action: 'edited', at: sec(50), count: 1, gone: false },
      ],
    }),
  ],
  ['web', agent('web', { title: 'Polish the web', files: [{ path: '/tmp/shot.png', action: 'created', at: sec(10), count: 1, gone: false }] })],
])

let views: Record<string, FileView>
let calls: Array<{ url: string; method: string; body?: string }>

beforeEach(() => {
  calls = []
  views = {
    '/home/me/work/api/docs/plan.md': { path: '/home/me/work/api/docs/plan.md', size: 9, mtime: sec(30), kind: 'text', text: '# The plan', data: 'data:application/octet-stream;base64,IyBUaGUgcGxhbg==', truncated: false, local: '/Users/me/api/docs/plan.md' },
    '/tmp/shot.png': { path: '/tmp/shot.png', size: 4, mtime: sec(10), kind: 'image', data: 'data:image/png;base64,AAAA', truncated: false },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined })
      if (url.startsWith('/api/file/open')) return Response.json({ opened: '/Users/me/api/docs/plan.md', revealed: false })
      const view = views[new URL(url, 'http://x').searchParams.get('path') ?? '']
      return view ? Response.json(view) : Response.json({ error: 'not_found', message: 'No such file or directory' }, { status: 404 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderOverview() {
  return render(
    <Overview sessions={[session('api'), session('web')]} insights={INSIGHTS} now={NOW} seenAt={() => sec(1000)} onOpen={vi.fn()} onSeen={vi.fn()} />,
  )
}

describe('agent files', () => {
  it('counts files on the card and lists recent live ones across sessions', () => {
    renderOverview()
    expect(screen.getByRole('button', { name: 'Ship the API' })).toHaveTextContent('3 files')
    const panel = within(screen.getByRole('complementary', { name: 'session details' }))
    expect(panel.getAllByRole('button').map((b) => b.textContent)).toEqual(['shot.png', 'plan.md', 'x.ts'])
  })

  it('lists the selected session files relative to its folder and leaves gone ones unclickable', () => {
    renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Ship the API' }))
    const details = within(screen.getByRole('article', { name: 'api details' }))
    expect(details.getByRole('button', { name: 'plan.md' }).nextSibling).toHaveTextContent('docs')
    expect(details.queryByRole('button', { name: 'old.py' })).toBeNull()
    expect(details.getByRole('button', { name: 'x.ts' }).nextSibling).toHaveTextContent(/^…\/deep\/er$/)
    expect(details.getByText('old.py').closest('li')).toHaveTextContent('gone')
  })

  it('previews a text file with its path, opens the laptop copy, and copies the path', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Ship the API' }))
    fireEvent.click(within(screen.getByRole('article', { name: 'api details' })).getByRole('button', { name: 'plan.md' }))
    const dialog = within(screen.getByRole('dialog', { name: 'plan.md' }))
    expect(await dialog.findByText('# The plan')).toBeInTheDocument()
    expect(calls[0].url).toBe('/api/file?session=api&path=%2Fhome%2Fme%2Fwork%2Fapi%2Fdocs%2Fplan.md')
    expect(dialog.getByText(/laptop copy/)).toBeInTheDocument()
    expect(dialog.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'plan.md')

    fireEvent.click(dialog.getByRole('button', { name: 'Open on laptop' }))
    await waitFor(() => expect(dialog.getByRole('status')).toHaveTextContent('Opened on this laptop'))
    expect(calls[1]).toMatchObject({ url: '/api/file/open', method: 'POST', body: JSON.stringify({ session: 'api', path: '/home/me/work/api/docs/plan.md' }) })

    fireEvent.click(dialog.getByRole('button', { name: 'Copy path' }))
    await waitFor(() => expect(dialog.getByRole('status')).toHaveTextContent('Path copied'))
    expect(writeText).toHaveBeenCalledWith('/home/me/work/api/docs/plan.md')

    fireEvent.click(dialog.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows images inline, and no laptop button for a file read from the host', async () => {
    renderOverview()
    fireEvent.click(within(screen.getByRole('complementary', { name: 'session details' })).getByRole('button', { name: 'shot.png' }))
    const dialog = within(screen.getByRole('dialog', { name: 'shot.png' }))
    expect(await dialog.findByRole('img', { name: 'shot.png' })).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(dialog.getByText(/read from host/)).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Open on laptop' })).toBeNull()
  })

  it('says why a file cannot be shown', async () => {
    delete views['/tmp/shot.png']
    renderOverview()
    fireEvent.click(within(screen.getByRole('complementary', { name: 'session details' })).getByRole('button', { name: 'shot.png' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No such file or directory')
  })

  it('keeps overview keys from acting behind the open preview', async () => {
    renderOverview()
    fireEvent.click(within(screen.getByRole('complementary', { name: 'session details' })).getByRole('button', { name: 'shot.png' }))
    const dialog = screen.getByRole('dialog', { name: 'shot.png' })
    await within(dialog).findByRole('img', { name: 'shot.png' })
    fireEvent.keyDown(within(dialog).getByRole('img', { name: 'shot.png' }), { key: 'j' })
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('says when a file that could run is only shown in its folder', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).startsWith('/api/file/open') ? Response.json({ opened: '/Users/me/x.command', revealed: true }) : Response.json(views['/home/me/work/api/docs/plan.md']),
    )
    renderOverview()
    fireEvent.click(within(screen.getByRole('complementary', { name: 'session details' })).getByRole('button', { name: 'plan.md' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open on laptop' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('shown in its folder'))
  })
})
