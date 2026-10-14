import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePreview, indentJson, parseDelimited } from '../../src/components/FilePreview'
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

  it('previews a text file with its path, opens the laptop copy, and copies the text or the path', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Ship the API' }))
    fireEvent.click(within(screen.getByRole('article', { name: 'api details' })).getByRole('button', { name: 'plan.md' }))
    const dialog = within(screen.getByRole('dialog', { name: 'plan.md' }))
    expect(await dialog.findByRole('heading', { name: 'The plan' })).toBeInTheDocument()
    expect(calls[0].url).toBe('/api/file?session=api&path=%2Fhome%2Fme%2Fwork%2Fapi%2Fdocs%2Fplan.md')
    expect(dialog.getByText(/laptop copy/)).toBeInTheDocument()
    expect(dialog.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'plan.md')

    fireEvent.click(dialog.getByRole('button', { name: 'Open on laptop' }))
    await waitFor(() => expect(dialog.getByRole('status')).toHaveTextContent('Opened on this laptop'))
    expect(calls[1]).toMatchObject({ url: '/api/file/open', method: 'POST', body: JSON.stringify({ session: 'api', path: '/home/me/work/api/docs/plan.md' }) })

    fireEvent.click(dialog.getByRole('button', { name: 'Copy text' }))
    await waitFor(() => expect(dialog.getByRole('status')).toHaveTextContent('Text copied'))
    expect(writeText).toHaveBeenCalledWith('# The plan')
    fireEvent.click(dialog.getByRole('button', { name: 'Copy path' }))
    await waitFor(() => expect(dialog.getByRole('status')).toHaveTextContent('Path copied'))
    expect(writeText).toHaveBeenCalledWith('/home/me/work/api/docs/plan.md')
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'))
    fireEvent.click(dialog.getByRole('button', { name: 'Copy text' }))
    await waitFor(() => expect(dialog.getByRole('status')).toHaveTextContent('Could not copy — switch to Source and select it'))
    vi.stubGlobal('navigator', {})
    fireEvent.click(dialog.getByRole('button', { name: 'Source' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Copy text' }))
    await waitFor(() => expect(dialog.getByRole('status')).toHaveTextContent('Could not copy — select the text below'))

    fireEvent.click(dialog.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says when Copy text took only the first 1 MB', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    views['/home/me/work/api/big.log'] = { path: '/home/me/work/api/big.log', size: 5_000_000, mtime: sec(5), kind: 'text', text: 'head', truncated: true }
    render(<FilePreview file={{ session: 'api', path: '/home/me/work/api/big.log' }} known={[]} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog', { name: 'big.log' }))
    fireEvent.click(await dialog.findByRole('button', { name: 'Copy text' }))
    await waitFor(() => expect(dialog.getByRole('status')).toHaveTextContent('Copied the first 1 MB'))
    expect(writeText).toHaveBeenCalledWith('head')
  })

  it('drops a copy note that settles after the preview moved to another file, even on coming Back', async () => {
    let settle: () => void = () => undefined
    const writeText = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    views['/w/a.md'] = { path: '/w/a.md', size: 9, mtime: sec(5), kind: 'text', text: '[b](b.md)', truncated: false }
    views['/w/b.md'] = { path: '/w/b.md', size: 3, mtime: sec(5), kind: 'text', text: '# B', truncated: false }
    render(<FilePreview file={{ session: 'api', path: '/w/a.md' }} known={['/w/a.md', '/w/b.md']} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(await dialog.findByRole('button', { name: 'Copy text' }))
    fireEvent.click(dialog.getByRole('link', { name: 'b' }))
    expect(await dialog.findByRole('heading', { name: 'B' })).toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: 'Back' }))
    expect(await dialog.findByRole('link', { name: 'b' })).toBeInTheDocument()
    await act(async () => settle())
    expect(dialog.getByRole('status')).toBeEmptyDOMElement()
  })

  it('shows the note for the latest copy when an earlier one settles late', async () => {
    let refuse: () => void = () => undefined
    const writeText = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => (refuse = () => reject(new Error('slow')))))
      .mockImplementation(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    views['/w/c.txt'] = { path: '/w/c.txt', size: 1, mtime: sec(5), kind: 'text', text: 'c', truncated: false }
    render(<FilePreview file={{ session: 'api', path: '/w/c.txt' }} known={[]} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(await dialog.findByRole('button', { name: 'Copy text' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Copy path' }))
    await waitFor(() => expect(dialog.getByRole('status')).toHaveTextContent('Path copied'))
    await act(async () => refuse())
    expect(dialog.getByRole('status')).toHaveTextContent('Path copied')
  })

  it('offers no Copy text for an empty file', async () => {
    views['/home/me/work/api/empty.txt'] = { path: '/home/me/work/api/empty.txt', size: 0, mtime: sec(5), kind: 'text', text: '', truncated: false }
    render(<FilePreview file={{ session: 'api', path: '/home/me/work/api/empty.txt' }} known={[]} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog', { name: 'empty.txt' }))
    expect(await dialog.findByText(/0 B/)).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Copy text' })).toBeNull()
    expect(dialog.getByRole('button', { name: 'Copy path' })).toBeInTheDocument()
  })

  it('shows images inline, and no laptop button for a file read from the host', async () => {
    renderOverview()
    fireEvent.click(within(screen.getByRole('complementary', { name: 'session details' })).getByRole('button', { name: 'shot.png' }))
    const dialog = within(screen.getByRole('dialog', { name: 'shot.png' }))
    expect(await dialog.findByRole('img', { name: 'shot.png' })).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(dialog.getByText(/read from host/)).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Open on laptop' })).toBeNull()
    expect(dialog.queryByRole('button', { name: 'Copy text' })).toBeNull()
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

describe('file viewer', () => {
  const text = (path: string, body: string) => {
    views[path] = { path, size: body.length, mtime: sec(5), kind: 'text', text: body, truncated: false }
  }
  const preview = (path: string, known: string[] = []) => {
    render(<FilePreview file={{ session: 'api', path }} known={known} onClose={vi.fn()} />)
    return within(screen.getByRole('dialog'))
  }

  it('renders Markdown, with the source a click away', async () => {
    text('/w/plan.md', '# The plan\n\n- [x] done')
    const dialog = preview('/w/plan.md')
    expect(await dialog.findByRole('heading', { name: 'The plan' })).toBeInTheDocument()
    expect(dialog.getByRole('checkbox', { name: 'done' })).toBeChecked()
    expect(dialog.getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(dialog.getByRole('button', { name: 'Source' }))
    expect(dialog.getByLabelText('plan.md contents')).toHaveTextContent('# The plan - [x] done')
    expect(dialog.queryByRole('heading', { name: 'The plan' })).toBeNull()
  })

  it('follows links to files the agent wrote, says why it cannot follow others, and jumps to headings', async () => {
    text('/w/docs/plan.md', '# Plan\n\n[the code](../src/x.ts) [elsewhere](/etc/hosts) [top](#plan) [self](plan.md)')
    text('/w/src/x.ts', 'const a = 1\n')
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const dialog = preview('/w/docs/plan.md', ['/w/docs/plan.md', '/w/src/x.ts'])
    fireEvent.click(await dialog.findByRole('link', { name: 'top' }))
    expect(scroll.mock.contexts[0]).toBe(dialog.getByRole('heading', { name: 'Plan' }))
    expect(document.activeElement).toBe(dialog.getByRole('heading', { name: 'Plan' }))
    expect(dialog.getByRole('link', { name: 'the code' })).not.toHaveAttribute('href')
    expect(dialog.queryByRole('link', { name: 'self' })).toBeNull()
    expect(dialog.getByText('self').tagName).toBe('SPAN')

    fireEvent.click(dialog.getByRole('link', { name: 'elsewhere' }))
    expect(dialog.getByRole('status')).toHaveTextContent("hosts isn't a file this agent wrote")

    fireEvent.keyDown(dialog.getByRole('link', { name: 'the code' }), { key: 'Enter' })
    expect(await dialog.findByRole('heading', { name: 'x.ts' })).toHaveFocus()
    expect(await dialog.findByLabelText('x.ts contents')).toContainHTML('<span class="hljs-keyword">const</span>')
    expect(location.hash).toBe('')

    fireEvent.click(dialog.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(dialog.getByRole('heading', { name: 'plan.md' })).toHaveFocus())
    expect(await dialog.findByRole('heading', { name: 'Plan' })).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Back' })).toBeNull()
  })

  it('re-indents JSON without changing a single value', () => {
    for (const sample of ['{"a":[1,"x",{},[]],"b":{"c":null,"d":[true,false]}}', '[]', '"s"', '{ "e" : [ ] }']) {
      expect(indentJson(sample)).toBe(JSON.stringify(JSON.parse(sample), null, 2))
    }
    expect(indentJson('{"id":12345678901234567890,"n":1.0,"k":1,"k":2,"s":"a\\"},[:"}')).toBe(
      '{\n  "id": 12345678901234567890,\n  "n": 1.0,\n  "k": 1,\n  "k": 2,\n  "s": "a\\"},[:"\n}',
    )
  })

  it('pretty-prints JSON, and shows broken JSON as it is', async () => {
    text('/w/a.json', '{"a":[1,"x"]}')
    const dialog = preview('/w/a.json')
    const formatted = await dialog.findByLabelText('a.json, formatted')
    expect(formatted.textContent).toBe('{\n  "a": [\n    1,\n    "x"\n  ]\n}')
    expect(formatted.querySelector('.hljs-number')).toHaveTextContent('1')
    cleanup()

    text('/w/b.json', '{"a":')
    const broken = preview('/w/b.json')
    expect(await broken.findByLabelText('b.json contents')).toHaveTextContent('{"a":')
    expect(broken.queryByRole('button', { name: 'Formatted' })).toBeNull()
  })

  it('shows CSV and TSV as tables, keeping quoted separators and newlines inside a cell', async () => {
    expect(parseDelimited('a,b\r\n"x, ""y""","multi\nline"\n', ',')).toEqual([['a', 'b'], ['x, "y"', 'multi\nline']])
    expect(parseDelimited('1\n2\n3\n', ',', 2)).toEqual([['1'], ['2']])
    expect(parseDelimited('name\n""\n\nbob\n\n', ',')).toEqual([['name'], [''], ['bob']])
    expect(parseDelimited('name\n""', ',')).toEqual([['name'], ['']])
    expect(parseDelimited('a\n"', ',')).toEqual([['a'], ['"']])
    expect(parseDelimited('\uFEFF"name","x"\n', ',')).toEqual([['name', 'x']])
    expect(parseDelimited('a\tb\n"oops\tc\nd\te\n', '\t')).toEqual([['a', 'b'], ['"oops', 'c'], ['d', 'e']])
    expect(parseDelimited('name,desc\n"Smith, J",ok\n"broken,x\n', ',')).toEqual([['name', 'desc'], ['Smith, J', 'ok'], ['"broken', 'x']])
    expect(parseDelimited('a,b\n"x, y","multi\nline"\n"cut, off', ',')).toEqual([['a', 'b'], ['x, y', 'multi\nline'], ['"cut', ' off']])
    expect(parseDelimited('a,b\n"l1\nl2,x', ',')).toEqual([['a', 'b'], ['"l1'], ['l2', 'x']])
    expect(parseDelimited('a\tb\n"x\ty"\tz\n', '\t')).toEqual([['a', 'b'], ['x\ty', 'z']])
    text('/w/t.tsv', 'name\tcount\nfoo\t3\n')
    const dialog = preview('/w/t.tsv')
    const table = within(await dialog.findByRole('table'))
    expect(table.getByRole('columnheader', { name: 'count' })).toBeInTheDocument()
    expect(table.getByRole('cell', { name: 'foo' })).toBeInTheDocument()
    expect(dialog.getByRole('region', { name: 't.tsv, as a table' })).toBeInTheDocument()
    cleanup()

    const lines = (n: number) => ['h', ...Array.from({ length: n }, (_, i) => `${i}`)].join('\n')
    text('/w/full.csv', `${lines(1000)}\n\n\n`)
    const full = preview('/w/full.csv')
    expect(await full.findAllByRole('row')).toHaveLength(1001)
    expect(full.queryByText(/Showing the first/)).toBeNull()
    cleanup()

    text('/w/more.csv', lines(1001))
    const more = preview('/w/more.csv')
    expect(await more.findAllByRole('row')).toHaveLength(1001)
    expect(more.getByText('Showing the first 1000 rows.')).toBeInTheDocument()
  })

  it('renders HTML in a sandbox with scripts off', async () => {
    text('/w/r.html', '<h1>Report</h1><script>parent.x = 1</script>')
    const dialog = preview('/w/r.html')
    const frame = await dialog.findByTitle('r.html, rendered without scripts')
    expect(frame).toHaveAttribute('sandbox', '')
    expect(frame).toHaveAttribute('srcdoc', '<h1>Report</h1><script>parent.x = 1</script>')
    expect(dialog.getByText(/Scripts are off/)).toBeInTheDocument()
  })

  it('numbers source lines and drops the numbers when wrapping', async () => {
    text('/w/app.py', 'def f():\n    return 1\n')
    const dialog = preview('/w/app.py')
    const code = await dialog.findByLabelText('app.py contents')
    expect(code.querySelector('.hljs-keyword')).toHaveTextContent('def')
    expect(code.parentElement?.querySelector('.file-gutter')?.textContent).toBe('1\n2')
    expect(dialog.queryByRole('button', { name: 'Source' })).toBeNull()
    fireEvent.click(dialog.getByRole('button', { name: 'Wrap lines' }))
    expect(dialog.getByRole('button', { name: 'Wrap lines' })).toHaveAttribute('aria-pressed', 'true')
    expect(code.parentElement?.querySelector('.file-gutter')).toBeNull()
  })
})
