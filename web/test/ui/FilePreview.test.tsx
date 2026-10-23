import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactsPage } from '../../src/components/ArtifactsPage'
import { FileList, FilePreview, indentJson, parseDelimited } from '../../src/components/FilePreview'
import type { AgentInsight, FileTouch, FileView, Session } from '../../src/shared/types'

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

const touches = (paths: string[]) => paths.map((path) => ({ path, action: 'edited' as const, at: sec(5), count: 1, gone: false }))

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

function renderArtifacts() {
  return render(<ArtifactsPage sessions={[session('api'), session('web')]} insights={INSIGHTS} now={NOW} works={[]} onOpen={vi.fn()} onBack={vi.fn()} />)
}

const preview = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Preview ${name}` }))

describe('agent files', () => {
  it('lists live files across sessions, newest first', () => {
    renderArtifacts()
    expect(screen.getAllByRole('button', { name: /^Preview / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Preview shot.png', 'Preview plan.md', 'Preview x.ts'])
  })

  it('lists a session\'s files relative to its folder and leaves gone ones unclickable', () => {
    render(<FileList files={(INSIGHTS.get('api')?.files ?? []).map((f) => ({ ...f, session: 'api', cwd: '/home/me/work/api' }))} now={NOW} onPick={vi.fn()} />)
    const details = screen
    expect(details.getByRole('button', { name: 'plan.md' }).nextSibling).toHaveTextContent('docs')
    expect(details.queryByRole('button', { name: 'old.py' })).toBeNull()
    expect(details.getByRole('button', { name: 'x.ts' }).nextSibling).toHaveTextContent(/^in …\/deep\/er\/$/)
    expect(details.getByText('old.py').closest('li')).toHaveTextContent('gone')
  })

  it('previews a text file with its path, opens the laptop copy, and copies the text or the path', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderArtifacts()
    preview('plan.md')
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
    render(<FilePreview file={{ session: 'api', path: '/home/me/work/api/big.log' }} files={touches([])} onClose={vi.fn()} />)
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
    render(<FilePreview file={{ session: 'api', path: '/w/a.md' }} files={touches(['/w/a.md', '/w/b.md'])} onClose={vi.fn()} />)
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
    render(<FilePreview file={{ session: 'api', path: '/w/c.txt' }} files={touches([])} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(await dialog.findByRole('button', { name: 'Copy text' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Copy path' }))
    await waitFor(() => expect(dialog.getByRole('status')).toHaveTextContent('Path copied'))
    await act(async () => refuse())
    expect(dialog.getByRole('status')).toHaveTextContent('Path copied')
  })

  it('keeps the unknown-link note when an earlier copy settles after it', async () => {
    let settle: () => void = () => undefined
    const writeText = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    views['/w/d.md'] = { path: '/w/d.md', size: 9, mtime: sec(5), kind: 'text', text: '[e](e.md)', truncated: false }
    render(<FilePreview file={{ session: 'api', path: '/w/d.md' }} files={touches(['/w/d.md'])} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(await dialog.findByRole('button', { name: 'Copy text' }))
    expect(writeText).toHaveBeenCalledWith('[e](e.md)')
    fireEvent.click(dialog.getByRole('link', { name: 'e' }))
    expect(dialog.getByRole('status')).toHaveTextContent("e.md isn't a file this agent wrote")
    await act(async () => settle())
    expect(dialog.getByRole('status')).toHaveTextContent("e.md isn't a file this agent wrote")
  })

  it('offers no Copy text for an empty file', async () => {
    views['/home/me/work/api/empty.txt'] = { path: '/home/me/work/api/empty.txt', size: 0, mtime: sec(5), kind: 'text', text: '', truncated: false }
    render(<FilePreview file={{ session: 'api', path: '/home/me/work/api/empty.txt' }} files={touches([])} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog', { name: 'empty.txt' }))
    expect(await dialog.findByText(/0 B/)).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Copy text' })).toBeNull()
    expect(dialog.getByRole('button', { name: 'Copy path' })).toBeInTheDocument()
  })

  it('shows images inline, and no laptop button for a file read from the host', async () => {
    renderArtifacts()
    preview('shot.png')
    const dialog = within(screen.getByRole('dialog', { name: 'shot.png' }))
    expect(await dialog.findByRole('img', { name: 'shot.png' })).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(dialog.getByText(/read from host/)).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Open on laptop' })).toBeNull()
    expect(dialog.queryByRole('button', { name: 'Copy text' })).toBeNull()
  })

  it('says why a file cannot be shown', async () => {
    delete views['/tmp/shot.png']
    renderArtifacts()
    preview('shot.png')
    expect(await screen.findByRole('alert')).toHaveTextContent('No such file or directory')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('says when the host cannot be reached for a file, and reads it again on request', async () => {
    let down = true
    vi.mocked(fetch).mockImplementation(async () =>
      down ? Response.json({ error: 'remote_unreachable', message: 'host unreachable' }, { status: 502 }) : Response.json(views['/tmp/shot.png']),
    )
    renderArtifacts()
    preview('shot.png')
    const dialog = within(screen.getByRole('dialog', { name: 'shot.png' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent("Can't reach the host to read this file. Check your VPN or proxy sign-in, then try again.")
    down = false
    fireEvent.click(dialog.getByRole('button', { name: 'Try again' }))
    expect(await dialog.findByRole('img', { name: 'shot.png' })).toBeInTheDocument()
    expect(dialog.queryByRole('alert')).toBeNull()
  })

  it('says when a file that could run is only shown in its folder', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).startsWith('/api/file/open') ? Response.json({ opened: '/Users/me/x.command', revealed: true }) : Response.json(views['/home/me/work/api/docs/plan.md']),
    )
    renderArtifacts()
    preview('plan.md')
    fireEvent.click(await screen.findByRole('button', { name: 'Open on laptop' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('shown in its folder'))
  })
})

describe('file viewer', () => {
  const text = (path: string, body: string) => {
    views[path] = { path, size: body.length, mtime: sec(5), kind: 'text', text: body, truncated: false }
  }
  const preview = (path: string, known: string[] = []) => {
    render(<FilePreview file={{ session: 'api', path }} files={touches(known)} onClose={vi.fn()} />)
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

describe('a quick look that keeps up with the agent', () => {
  const touch = (path: string, over: Partial<FileTouch> = {}): FileTouch => ({ path, action: 'edited', at: sec(5), count: 1, gone: false, ...over })
  const md = (path: string, body: string) => {
    views[path] = { path, size: body.length, mtime: sec(5), kind: 'text', text: body, truncated: false }
  }

  it('hands the file to its terminal, but only for a session it can open', async () => {
    const onDock = vi.fn()
    const overview = (attachable: boolean) =>
      render(
        <ArtifactsPage sessions={[{ ...session('api'), attachable }]} insights={INSIGHTS} now={NOW} works={[]} onOpen={vi.fn()} onBack={vi.fn()} onDock={onDock} />,
      )
    overview(false)
    preview('plan.md')
    expect(within(screen.getByRole('dialog', { name: 'plan.md' })).queryByRole('button', { name: 'Open beside terminal' })).toBeNull()
    cleanup()
    overview(true)
    preview('plan.md')
    const dialog = within(screen.getByRole('dialog', { name: 'plan.md' }))
    await dialog.findByRole('heading', { name: 'The plan' })
    fireEvent.click(dialog.getByRole('button', { name: 'Open beside terminal' }))
    expect(onDock).toHaveBeenCalledWith({ session: 'api', path: '/home/me/work/api/docs/plan.md' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('steps through the files the agent touched, skipping deleted ones', async () => {
    md('/w/a.md', '# A')
    md('/w/c.md', '# C')
    render(<FilePreview file={{ session: 'api', path: '/w/a.md' }} files={[touch('/w/a.md'), touch('/w/b.md', { gone: true }), touch('/w/c.md')]} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog'))
    await dialog.findByRole('heading', { name: 'A' })
    const prev = dialog.getByRole('button', { name: 'Previous file' })
    const next = dialog.getByRole('button', { name: 'Next file' })
    expect(prev).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(prev)
    expect(next).toHaveAttribute('title', 'Next file: c.md')
    fireEvent.click(next)
    expect(await dialog.findByRole('heading', { name: 'C' })).toBeInTheDocument()
    expect(dialog.getByRole('heading', { name: 'c.md' })).toBeInTheDocument()
    expect(next).toHaveAttribute('aria-disabled', 'true')
    expect(prev).toHaveAttribute('title', 'Previous file: a.md')
    expect(dialog.queryByRole('button', { name: 'Back' })).toBeNull()
  })

  it('reads the file again in place when the agent edits it, and keeps the last copy once it is deleted', async () => {
    const file = { session: 'api', path: '/w/a.md' }
    md('/w/a.md', '# One')
    const { rerender } = render(<FilePreview file={file} files={[touch('/w/a.md')]} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog'))
    await dialog.findByRole('heading', { name: 'One' })
    const body = dialog.getByRole('region', { name: 'a.md' })
    body.scrollTop = 120
    md('/w/a.md', '# Two')
    rerender(<FilePreview file={file} files={[touch('/w/a.md', { at: sec(1), count: 2 })]} onClose={vi.fn()} />)
    expect(dialog.queryByText('Loading…')).toBeNull()
    expect(await dialog.findByRole('heading', { name: 'Two' })).toBeInTheDocument()
    expect(body.scrollTop).toBe(120)
    expect(dialog.getByRole('status')).toHaveTextContent("Updated to the agent's latest edit")

    const reads = calls.length
    delete views['/w/a.md']
    rerender(<FilePreview file={file} files={[touch('/w/a.md', { at: sec(0), count: 3, gone: true })]} onClose={vi.fn()} />)
    expect(dialog.getByText('The agent deleted this file; this is the last copy read.')).toBeInTheDocument()
    expect(dialog.getByRole('heading', { name: 'Two' })).toBeInTheDocument()
    expect(calls).toHaveLength(reads)
  })

  it('reads again when the first read after an edit still has the old copy, and ignores agent details that drop out and come back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const file = { session: 'api', path: '/w/a.md' }
    md('/w/a.md', '# One')
    const { rerender } = render(<FilePreview file={file} files={[touch('/w/a.md')]} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog'))
    await dialog.findByRole('heading', { name: 'One' })
    const reads = () => calls.filter((c) => c.url.startsWith('/api/file?')).length
    rerender(<FilePreview file={file} files={[]} onClose={vi.fn()} />)
    rerender(<FilePreview file={file} files={[touch('/w/a.md')]} onClose={vi.fn()} />)
    expect(reads()).toBe(1)
    rerender(<FilePreview file={file} files={[touch('/w/a.md', { at: sec(1), count: 2 })]} onClose={vi.fn()} />)
    await waitFor(() => expect(reads()).toBe(2))
    expect(dialog.getByRole('status')).toBeEmptyDOMElement()
    md('/w/a.md', '# Two')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(await dialog.findByRole('heading', { name: 'Two' })).toBeInTheDocument()
    expect(reads()).toBe(3)
    expect(dialog.getByRole('status')).toHaveTextContent("Updated to the agent's latest edit")
    vi.useRealTimers()
  })

  it('reads again after a failed read, and holds an edit while text in the quick look is selected and it has focus', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const file = { session: 'api', path: '/w/a.md' }
    md('/w/a.md', '# One')
    const { rerender } = render(<FilePreview file={file} files={[touch('/w/a.md')]} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog'))
    await dialog.findByRole('heading', { name: 'One' })
    const reads = () => calls.filter((c) => c.url.startsWith('/api/file?')).length
    delete views['/w/a.md']
    rerender(<FilePreview file={file} files={[touch('/w/a.md', { at: sec(1), count: 2 })]} onClose={vi.fn()} />)
    await waitFor(() => expect(reads()).toBe(2))
    md('/w/a.md', '# Two')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(await dialog.findByRole('heading', { name: 'Two' })).toBeInTheDocument()
    vi.useRealTimers()

    const body = dialog.getByRole('region', { name: 'a.md' })
    body.focus()
    const range = document.createRange()
    range.selectNodeContents(dialog.getByRole('article'))
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    md('/w/a.md', '# Three')
    rerender(<FilePreview file={file} files={[touch('/w/a.md', { at: sec(0), count: 3 })]} onClose={vi.fn()} />)
    expect(reads()).toBe(3)
    const outside = document.createElement('button')
    document.body.append(outside)
    act(() => outside.focus())
    expect(await dialog.findByRole('heading', { name: 'Three' })).toBeInTheDocument()
    outside.remove()
    document.getSelection()!.removeAllRanges()
  })

  it('shows a newly picked file loading, not the last one under its name', async () => {
    md('/w/a.md', '# A')
    md('/w/c.md', '# C')
    const files = [touch('/w/a.md'), touch('/w/c.md')]
    const { rerender } = render(<FilePreview file={{ session: 'api', path: '/w/a.md' }} files={files} onClose={vi.fn()} />)
    const dialog = within(screen.getByRole('dialog'))
    await dialog.findByRole('heading', { name: 'A' })
    rerender(<FilePreview file={{ session: 'api', path: '/w/c.md' }} files={files} onClose={vi.fn()} />)
    expect(dialog.getByRole('heading', { name: 'c.md' })).toBeInTheDocument()
    expect(dialog.queryByRole('heading', { name: 'A' })).toBeNull()
    expect(dialog.getByText('Loading…')).toBeInTheDocument()
    expect(await dialog.findByRole('heading', { name: 'C' })).toBeInTheDocument()
  })

  it('jumps to a heading inside its own preview when two show the same file', async () => {
    md('/w/a.md', '# Top\n\n[up](#top)')
    render(
      <>
        <FilePreview file={{ session: 'api', path: '/w/a.md' }} files={[touch('/w/a.md')]} onClose={vi.fn()} />
        <FilePreview file={{ session: 'web', path: '/w/a.md' }} files={[touch('/w/a.md')]} onClose={vi.fn()} />
      </>,
    )
    const second = within(screen.getAllByRole('dialog')[1])
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'up' })).toHaveLength(2))
    fireEvent.click(second.getByRole('link', { name: 'up' }))
    expect(second.getByRole('heading', { name: 'Top' })).toHaveFocus()
  })
})
