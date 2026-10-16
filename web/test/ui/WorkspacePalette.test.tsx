import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { buildItems, WorkspacePalette } from '../../src/components/WorkspacePalette'
import type { Session, Workspace, WorkspacesResponse } from '../../src/shared/types'

const NOW = 1800000000

function session(name: string, activityEpoch: number, attachable = true): Session {
  return { name, attached: false, clients: 0, activityEpoch, bell: false, cmd: 'zsh', title: '', path: '/home/me', attachable }
}

const WORKSPACES: Workspace[] = [
  { root: 'work', name: 'eval-latency', mtime: NOW - 7200 },
  { root: 'work', name: 'paper-review', mtime: NOW - 86400 * 3 },
  { root: 'lab', name: 'eval-harness', mtime: NOW - 60 },
]

const SESSIONS: Session[] = [
  session('eval-latency', NOW - 30),
  session('scratch', NOW - 600),
  session('api - ~/work/api', NOW - 5, false),
]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const LISTING: WorkspacesResponse = {
  roots: [
    { name: 'work', localPath: '/home/me/Work' },
    { name: 'lab', localPath: '/home/me/Lab' },
  ],
  workspaces: WORKSPACES,
}

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>
let postReply: () => Response

beforeEach(() => {
  sessionStorage.setItem('devbox-web-token', 'tok')
  postReply = () => json({ name: 'x', created: true }, 201)
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/workspaces') return json(LISTING)
    if (url === '/api/sessions' && init?.method === 'POST') return postReply()
    return json({ error: 'not_found', message: 'no' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

async function renderPalette(onOpen = vi.fn(), onSessionsChanged = vi.fn()) {
  const view = render(
    <WorkspacePalette sessions={SESSIONS} now={NOW * 1000} onOpen={onOpen} onSessionsChanged={onSessionsChanged} />,
  )
  await act(async () => {
    await Promise.resolve()
  })
  fireEvent.focus(screen.getByRole('combobox', { name: 'search or create a workspace' }))
  return Object.assign(onOpen, { view, onSessionsChanged })
}

const input = () => screen.getByRole('combobox', { name: 'search or create a workspace' })
const options = () => within(screen.getByRole('listbox', { hidden: true })).queryAllByRole('option')
const names = () => options().map((o) => o.querySelector('.palette-name')?.textContent)

function posts() {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === '/api/sessions' && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
}

describe('buildItems', () => {
  it('merges folders and live sessions, newest activity first, with liveness', () => {
    const items = buildItems('', SESSIONS, WORKSPACES, 'work')
    expect(items.map((i) => [i.name, i.kind])).toEqual([
      ['eval-latency', 'live'],
      ['eval-harness', 'folder'],
      ['scratch', 'live'],
      ['paper-review', 'folder'],
    ])
  })

  it('filters case-insensitively by substring, with create last', () => {
    const items = buildItems('EVAL', SESSIONS, WORKSPACES, 'work')
    expect(items.filter((i) => i.kind !== 'create').map((i) => i.name)).toEqual(['eval-latency', 'eval-harness'])
    expect(items.at(-1)?.kind).toBe('create')
  })

  it('offers create only for a new valid name', () => {
    expect(buildItems('new-proj', SESSIONS, WORKSPACES, 'work').at(-1)).toMatchObject({
      kind: 'create',
      name: 'new-proj',
      root: 'work',
    })
    expect(buildItems('scratch', SESSIONS, WORKSPACES, 'work').some((i) => i.kind === 'create')).toBe(false)
    expect(buildItems('a b', SESSIONS, WORKSPACES, 'work').some((i) => i.kind === 'create')).toBe(false)
    expect(buildItems('new', SESSIONS, WORKSPACES, null).some((i) => i.kind === 'create')).toBe(false)
  })

  it('does not offer create for a name that differs only in case', () => {
    expect(buildItems('Scratch', SESSIONS, WORKSPACES, 'work').some((i) => i.kind === 'create')).toBe(false)
    expect(buildItems('EVAL-LATENCY', SESSIONS, WORKSPACES, 'work').some((i) => i.kind === 'create')).toBe(false)
  })

  it('never offers unattachable sessions', () => {
    expect(buildItems('api', SESSIONS, WORKSPACES, 'work').map((i) => i.kind)).toEqual(['create'])
  })
})

describe('WorkspacePalette', () => {
  it('lists workspaces and live sessions with the first option selected', async () => {
    await renderPalette()
    expect(names()).toEqual(['eval-latency', 'eval-harness', 'scratch', 'paper-review'])
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    expect(input()).toHaveAttribute('aria-activedescendant', options()[0].id)
  })

  it('filters as you type and resets the selection', async () => {
    await renderPalette()
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.change(input(), { target: { value: 'paper' } })
    expect(names()).toEqual(['paper-review', 'create paper'])
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('moves the selection with the arrow keys within bounds', async () => {
    await renderPalette()
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(options()[2]).toHaveAttribute('aria-selected', 'true')
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(options()[3]).toHaveAttribute('aria-selected', 'true')
  })

  it('Enter on a live session attaches without starting anything', async () => {
    const onOpen = await renderPalette()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('eval-latency')
    expect(posts()).toHaveLength(0)
  })

  it('Enter on a folder starts the selected agent in its own root, then attaches', async () => {
    const onOpen = await renderPalette()
    fireEvent.click(screen.getByRole('radio', { name: 'codex' }))
    fireEvent.change(input(), { target: { value: 'harness' } })
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' })
    })
    expect(posts()).toEqual([{ name: 'eval-harness', root: 'lab', agent: 'codex' }])
    expect(onOpen).toHaveBeenCalledWith('eval-harness')
  })

  it('creates a new workspace in the chosen root with claude by default', async () => {
    const onOpen = await renderPalette()
    fireEvent.change(screen.getByRole('combobox', { name: 'sync root' }), { target: { value: 'lab' } })
    fireEvent.change(input(), { target: { value: 'fresh-idea' } })
    expect(names()).toEqual(['create fresh-idea'])
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' })
    })
    expect(posts()).toEqual([{ name: 'fresh-idea', root: 'lab', agent: 'cc' }])
    expect(onOpen).toHaveBeenCalledWith('fresh-idea')
    expect(input()).toHaveValue('')
  })

  it('keeps the highlighted item when a poll re-sorts the list', async () => {
    const onOpen = await renderPalette()
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(options()[1]).toHaveTextContent('eval-harness')
    const resorted = [session('eval-latency', NOW - 30), session('scratch', NOW - 1), session('api - ~/work/api', NOW - 5, false)]
    onOpen.view.rerender(
      <WorkspacePalette sessions={resorted} now={NOW * 1000} onOpen={onOpen} onSessionsChanged={onOpen.onSessionsChanged} />,
    )
    expect(names()[0]).toBe('scratch')
    const selected = options().find((o) => o.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveTextContent('eval-harness')
    expect(input()).toHaveAttribute('aria-activedescendant', selected?.id)
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' })
    })
    expect(posts()).toEqual([{ name: 'eval-harness', root: 'lab', agent: 'cc' }])
  })

  it('refreshes the session list after starting a session', async () => {
    const onOpen = await renderPalette()
    fireEvent.change(input(), { target: { value: 'fresh-idea' } })
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' })
    })
    expect(onOpen.onSessionsChanged).toHaveBeenCalledTimes(1)
  })

  it('shows the server error and does not open a terminal when starting fails', async () => {
    postReply = () => json({ error: 'remote_unreachable', message: 'could not start x on stub-host' }, 502)
    const onOpen = await renderPalette()
    fireEvent.change(input(), { target: { value: 'fresh-idea' } })
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('could not start x on stub-host')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('clicking an option activates it', async () => {
    const onOpen = await renderPalette()
    fireEvent.click(within(options()[2]).getByText('scratch'))
    expect(onOpen).toHaveBeenCalledWith('scratch')
  })

  it('Escape clears the query and closes the list', async () => {
    await renderPalette()
    fireEvent.change(input(), { target: { value: 'paper' } })
    fireEvent.keyDown(input(), { key: 'Escape' })
    fireEvent.blur(input())
    expect(input()).toHaveValue('')
    expect(screen.getByRole('listbox', { hidden: true })).not.toBeVisible()
    fireEvent.focus(input())
    expect(options()).toHaveLength(4)
  })

  it('stays open while choosing an agent with the mouse, and closes when focus leaves the palette', async () => {
    await renderPalette()
    const codexLabel = screen.getByText('codex').closest('label') as HTMLElement
    expect(fireEvent.mouseDown(codexLabel)).toBe(false)
    fireEvent.click(codexLabel)
    expect(screen.getByRole('radio', { name: 'codex' })).toBeChecked()
    expect(screen.getByRole('listbox', { hidden: true })).toBeVisible()
    const rootPicker = screen.getByRole('combobox', { name: 'sync root' })
    fireEvent.blur(input(), { relatedTarget: rootPicker })
    expect(screen.getByRole('listbox', { hidden: true })).toBeVisible()
    fireEvent.blur(rootPicker, { relatedTarget: document.body })
    expect(screen.getByRole('listbox', { hidden: true })).not.toBeVisible()
  })

  it('does not point aria-activedescendant into a closed list', async () => {
    await renderPalette()
    expect(input()).toHaveAttribute('aria-activedescendant')
    fireEvent.blur(input())
    expect(input()).not.toHaveAttribute('aria-activedescendant')
  })

  it('keeps the list visible beside a start error, so the selection and ARIA stay truthful', async () => {
    postReply = () => json({ error: 'remote_unreachable', message: 'could not start x' }, 502)
    await renderPalette()
    fireEvent.change(input(), { target: { value: 'fresh-idea' } })
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('could not start x')
    expect(screen.getByRole('listbox', { hidden: true })).toBeVisible()
    expect(input()).toHaveAttribute('aria-expanded', 'true')
    const pointed = document.getElementById(input().getAttribute('aria-activedescendant') ?? '')
    expect(pointed).toBeVisible()
  })

  it('clears a start error as soon as the query changes or the palette closes', async () => {
    postReply = () => json({ error: 'remote_unreachable', message: 'could not start x' }, 502)
    await renderPalette()
    fireEvent.change(input(), { target: { value: 'fresh-idea' } })
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('could not start x')
    fireEvent.change(input(), { target: { value: 'fresh-idea2' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' })
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.blur(input())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('"/" also works from a focused button, never from inside a text field', async () => {
    await renderPalette()
    fireEvent.blur(input())
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    fireEvent.keyDown(button, { key: '/' })
    expect(document.activeElement).toBe(input())
    button.remove()
  })

  it('shows the list only while the search box is in use', async () => {
    await renderPalette()
    expect(input()).toHaveAttribute('aria-expanded', 'true')
    fireEvent.blur(input())
    expect(input()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('listbox', { hidden: true })).not.toBeVisible()
  })

  it('"/" focuses the search when nothing else has focus, but not while typing elsewhere', async () => {
    await renderPalette()
    act(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    fireEvent.keyDown(document, { key: '/' })
    expect(document.activeElement).toBe(input())
    const other = document.createElement('textarea')
    document.body.appendChild(other)
    other.focus()
    fireEvent.keyDown(other, { key: '/' })
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('hides the root picker when there is only one sync root', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/workspaces' ? json({ ...LISTING, roots: [LISTING.roots[0]] }) : json({}, 404),
    )
    await renderPalette()
    expect(screen.queryByRole('combobox', { name: 'sync root' })).not.toBeInTheDocument()
  })
})
