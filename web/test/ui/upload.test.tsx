import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalTabs } from '../../src/components/TerminalTabs'
import { UPLOAD_MAX } from '../../src/shared/validate'

vi.mock('../../src/components/Terminal', () => ({ TerminalPane: ({ name }: { name: string }) => <div data-testid={`pane-${name}`} /> }))

const item = (file: File, isDirectory = false) => ({ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory }) })
const transfer = (...items: ReturnType<typeof item>[]) => ({ types: ['Files'], items, dropEffect: 'none' })

let calls: Array<{ url: string; init: RequestInit }>

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const name = new URL(url, 'http://x').searchParams.get('name')
      return name === 'locked.txt'
        ? Response.json({ error: 'write_failed', message: 'Permission denied' }, { status: 409 })
        : Response.json({ path: `/home/me/work/api/${name}` }, { status: 201 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const setup = () => {
  const onSelect = vi.fn()
  render(<TerminalTabs tabs={['api', 'web']} active="web" sessions={[]} insights={new Map()} now={0} onSelect={onSelect} onClose={vi.fn()} />)
  return { onSelect, pane: (name: string) => screen.getByTestId(`pane-${name}`).parentElement! }
}

describe('dropping files on a terminal tab', () => {
  it('copies the file into that session, shows where it went, and switches to the tab', async () => {
    const { onSelect, pane } = setup()
    const file = new File(['png bytes'], 'shot.png', { type: 'image/png' })
    const over = transfer(item(file))
    fireEvent.dragOver(screen.getByRole('tab', { name: 'api' }).parentElement!, { dataTransfer: over })
    expect(over.dropEffect).toBe('copy')
    expect(screen.getByText("Drop to copy into api's folder")).toBeInTheDocument()
    await act(async () => {
      fireEvent.drop(screen.getByRole('tab', { name: 'api' }).parentElement!, { dataTransfer: transfer(item(file)) })
    })
    expect(onSelect).toHaveBeenCalledWith('api')
    expect(screen.queryByText(/Drop to copy/)).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/upload?session=api&name=shot.png')
    expect(calls[0].init).toMatchObject({ method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } })
    expect(pane('api')).toHaveTextContent('Copied to /home/me/work/api/shot.png')
  })

  it('copies several files in turn, and says which failed, which were too big, and that folders are skipped', async () => {
    const { pane } = setup()
    const big = new File(['x'], 'huge.iso')
    Object.defineProperty(big, 'size', { value: UPLOAD_MAX + 1 })
    await act(async () => {
      fireEvent.drop(pane('web'), {
        dataTransfer: transfer(item(new File(['a'], 'a.md')), item(new File(['b'], 'b.md')), item(new File(['c'], 'locked.txt')), item(big), item(new File([], 'src'), true)),
      })
    })
    expect(calls.map((c) => new URL(c.url, 'http://x').searchParams.get('name'))).toEqual(['a.md', 'b.md', 'locked.txt'])
    expect(screen.getByTestId('pane-web').parentElement).toHaveTextContent(
      'Copied 2 files to /home/me/work/api · a folder skipped, drop files instead · locked.txt: Permission denied · huge.iso is larger than 50 MB',
    )
  })

  it('queues a second drop on the same tab behind the first and reports both', async () => {
    let release = () => undefined as void
    vi.mocked(fetch).mockImplementationOnce(
      async (url) =>
        new Promise((resolve) => {
          calls.push({ url: String(url), init: {} })
          release = () => resolve(Response.json({ path: '/home/me/work/api/a.md' }, { status: 201 }))
        }),
    )
    const { pane } = setup()
    await act(async () => {
      fireEvent.drop(pane('web'), { dataTransfer: transfer(item(new File(['a'], 'a.md'))) })
      fireEvent.drop(pane('web'), { dataTransfer: transfer(item(new File(['b'], 'b.md'))) })
    })
    expect(calls).toHaveLength(1)
    expect(pane('web')).toHaveTextContent('Copying a.md… (1 more)')
    await act(async () => release())
    expect(calls).toHaveLength(2)
    expect(pane('web')).toHaveTextContent('Copied 2 files to /home/me/work/api')
  })

  it('reports an odd reply, files in different folders, and files left behind by an error', async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(async () => Response.json({ path: '' }, { status: 201 }))
      .mockImplementationOnce(async () => Response.json({ path: '/a/one (1).md' }, { status: 201 }))
      .mockImplementationOnce(async () => Response.json({ path: '/b/two.md' }, { status: 201 }))
    const { pane } = setup()
    await act(async () => {
      fireEvent.drop(pane('web'), { dataTransfer: transfer(item(new File(['x'], 'odd.md')), item(new File(['1'], 'one.md')), item(new File(['2'], 'two.md'))) })
    })
    expect(pane('web')).toHaveTextContent(/^Copied 2 files · one\.md saved as one \(1\)\.md · odd\.md: unexpected reply$/)

    vi.mocked(fetch).mockImplementationOnce(async () => ({ get status(): number { throw new Error('boom') } }) as unknown as Response)
    await act(async () => {
      fireEvent.drop(pane('web'), { dataTransfer: transfer(item(new File(['a'], 'a.md')), item(new File(['b'], 'b.md')), item(new File(['c'], 'c.md'))) })
    })
    expect(pane('web')).toHaveTextContent('a.md: upload failed, 2 more not copied')
    await act(async () => {
      fireEvent.drop(pane('web'), { dataTransfer: transfer(item(new File(['d'], 'd.md'))) })
    })
    expect(pane('web')).toHaveTextContent('Copied to /home/me/work/api/d.md')
  })

  it('keeps a file dropped anywhere else from replacing the dashboard', () => {
    setup()
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: transfer() })
    document.body.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    expect(calls).toHaveLength(0)
  })
})
