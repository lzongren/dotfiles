import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Notes } from '../../src/components/Notes'

let store: Record<string, string>
let failPuts = 0
let failStatus = 500
let failGets = 0
const puts: Array<{ day: string; text: string }> = []

const version = (text: string) => (text ? `h:${text}` : '')
let getGate: Promise<void> | null = null

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const pad = () => screen.getByRole('textbox')
const shown = () => document.querySelector('.notes-status')?.textContent

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(new Date(2026, 9, 13, 10, 0))
  localStorage.clear()
  sessionStorage.clear()
  getGate = null
  store = {}
  failPuts = 0
  failStatus = 500
  failGets = 0
  puts.length = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === '/api/notes') return json({ days: Object.keys(store).sort().reverse() })
    const day = url.slice('/api/notes/'.length)
    if (init.method === 'PUT') {
      if (failPuts > 0) {
        failPuts -= 1
        return json({ error: 'internal', message: failStatus === 413 ? 'request body too large' : 'disk full' }, failStatus)
      }
      const { text, base } = JSON.parse(init.body as string) as { text: string; base: string }
      if (base !== version(store[day] ?? '')) {
        return json({ error: 'conflict', message: 'the note changed elsewhere', text: store[day] ?? '', version: version(store[day] ?? '') }, 409)
      }
      puts.push({ day, text })
      if (text.trim()) store[day] = text
      else delete store[day]
      return json({ day, version: version(text) })
    }
    if (getGate) await getGate
    if (failGets > 0) {
      failGets -= 1
      return json({ error: 'internal', message: 'could not read the note' }, 500)
    }
    return json({ day, text: store[day] ?? '', version: version(store[day] ?? '') })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Notes', () => {
  it("opens today's note and saves what you type once you pause", async () => {
    store['2026-10-13'] = 'morning: review PRs\n'
    render(<Notes />)
    await settle()
    expect(pad()).toHaveValue('morning: review PRs\n')
    expect(screen.getByRole('button', { name: /Notes · Today/ })).toBeInTheDocument()
    fireEvent.change(pad(), { target: { value: 'morning: review PRs\n- [ ] merge #34\n' } })
    await settle(500)
    expect(puts).toEqual([])
    await settle(200)
    expect(puts).toEqual([{ day: '2026-10-13', text: 'morning: review PRs\n- [ ] merge #34\n' }])
    expect(shown()).toBe('saved')
    expect(screen.getByRole('status')).toHaveTextContent('')
    expect(screen.getByRole('button', { name: /1 open/ })).toBeInTheDocument()
  })

  it("offers yesterday's open items on an empty day and carries them over", async () => {
    store['2026-10-12'] = '- [ ] finish themes\n- [x] review\n- [ ] write README\n'
    render(<Notes />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Carry over 2 open from/ }))
    expect(pad()).toHaveValue('- [ ] finish themes\n- [ ] write README\n')
    await settle(700)
    expect(store['2026-10-13']).toBe('- [ ] finish themes\n- [ ] write README\n')
  })

  it('steps back through earlier days and returns to today', async () => {
    store['2026-10-09'] = 'friday'
    store['2026-10-13'] = 'today'
    render(<Notes />)
    await settle()
    expect(screen.getByRole('button', { name: 'newer notes' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'older notes' }))
    await settle()
    expect(pad()).toHaveValue('friday')
    expect(screen.getByRole('button', { name: 'older notes' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'newer notes' }))
    await settle()
    expect(pad()).toHaveValue('today')
  })

  it('keeps unsaved text and retries when a save fails', async () => {
    failPuts = 1
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'do not lose this' } })
    await settle(700)
    expect(screen.getByRole('status')).toHaveTextContent('not saved yet, retrying')
    await settle(5100)
    expect(store['2026-10-13']).toBe('do not lose this')
    expect(shown()).toBe('saved')
  })

  it('never offers an empty pad to type over when the note fails to load', async () => {
    store['2026-10-13'] = 'two kilobytes of thoughts'
    failGets = 1
    render(<Notes />)
    await settle()
    expect(pad()).toHaveAttribute('readonly')
    expect(screen.getByRole('status')).toHaveTextContent("couldn't load")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(pad()).toHaveValue('two kilobytes of thoughts')
    expect(pad()).not.toHaveAttribute('readonly')
    expect(puts).toEqual([])
  })

  it('stays on a day until its edit is saved, so nothing unsaved hides on another day', async () => {
    store['2026-10-12'] = 'monday'
    failPuts = 2
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'tuesday plan' } })
    await settle(700)
    fireEvent.click(screen.getByRole('button', { name: 'older notes' }))
    await settle()
    expect(pad()).toHaveValue('tuesday plan')
    expect(screen.getByRole('status')).toHaveTextContent('retrying')
    await settle(5100)
    expect(store['2026-10-13']).toBe('tuesday plan')
    fireEvent.click(screen.getByRole('button', { name: 'older notes' }))
    await settle()
    expect(pad()).toHaveValue('monday')
  })

  it('restores a draft the page never got to save, and saves it', async () => {
    store['2026-10-13'] = 'old'
    localStorage.setItem('devbox.notes.draft.2026-10-13', JSON.stringify({ text: 'newer, typed before a reload', base: 'h:old' }))
    render(<Notes />)
    await settle()
    expect(pad()).toHaveValue('newer, typed before a reload')
    await settle()
    expect(store['2026-10-13']).toBe('newer, typed before a reload')
    expect(localStorage.getItem('devbox.notes.draft.2026-10-13')).toBeNull()
  })

  it('does not retry a save the server refuses, and says why', async () => {
    failPuts = 5
    failStatus = 413
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'x'.repeat(10) } })
    await settle(700)
    expect(screen.getByRole('status')).toHaveTextContent('not saved: request body too large')
    const attempts = failPuts
    await settle(20_000)
    expect(failPuts).toBe(attempts)
  })

  it('stops retrying once the pad is gone, keeping the draft for next time', async () => {
    failPuts = 100
    const view = render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'keep me' } })
    await settle(700)
    view.unmount()
    await settle()
    const attempts = failPuts
    await settle(30_000)
    expect(failPuts).toBe(attempts)
    expect(JSON.parse(localStorage.getItem('devbox.notes.draft.2026-10-13')!)).toEqual({ text: 'keep me', base: '' })
  })

  it('stays read-only until the day it shows has loaded', async () => {
    store['2026-10-12'] = 'monday'
    store['2026-10-13'] = 'today'
    render(<Notes />)
    await settle()
    let release = () => undefined as void
    getGate = new Promise<void>((r) => {
      release = r
    })
    fireEvent.click(screen.getByRole('button', { name: 'older notes' }))
    await settle(1000)
    expect(pad()).toHaveAttribute('readonly')
    fireEvent.change(pad(), { target: { value: 'today plus a stray key' } })
    await settle(1000)
    getGate = null
    release()
    await settle()
    expect(pad()).toHaveValue('monday')
    expect(puts).toEqual([])
    expect(store['2026-10-12']).toBe('monday')
  })

  it('asks before overwriting a note that changed in another tab or editor', async () => {
    store['2026-10-13'] = 'morning'
    render(<Notes />)
    await settle()
    store['2026-10-13'] = 'morning\nedited in vim'
    fireEvent.change(pad(), { target: { value: 'morning, from the browser' } })
    await settle(700)
    expect(store['2026-10-13']).toBe('morning\nedited in vim')
    expect(screen.getByRole('status')).toHaveTextContent('changed elsewhere')
    expect(pad()).toHaveAttribute('readonly')
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    await settle()
    expect(store['2026-10-13']).toBe('morning, from the browser')
  })

  it('can take the other version instead', async () => {
    store['2026-10-13'] = 'v1'
    render(<Notes />)
    await settle()
    store['2026-10-13'] = 'v2 from elsewhere'
    fireEvent.change(pad(), { target: { value: 'v1 local' } })
    await settle(700)
    fireEvent.click(screen.getByRole('button', { name: 'Use saved' }))
    await settle()
    expect(pad()).toHaveValue('v2 from elsewhere')
    expect(localStorage.getItem('devbox.notes.draft.2026-10-13')).toBeNull()
    fireEvent.change(pad(), { target: { value: 'v2 from elsewhere, then mine' } })
    await settle(700)
    expect(store['2026-10-13']).toBe('v2 from elsewhere, then mine')
  })

  it('keeps a refused edit on screen, stays on its day, and warns before the tab closes', async () => {
    store['2026-10-12'] = 'monday'
    failPuts = 1
    failStatus = 413
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'far too long' } })
    await settle(700)
    fireEvent.click(screen.getByRole('button', { name: 'older notes' }))
    await settle()
    expect(pad()).toHaveValue('far too long')
    const leave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true)
    fireEvent.change(pad(), { target: { value: 'shorter' } })
    await settle(700)
    expect(store['2026-10-13']).toBe('shorter')
  })

  it('counts a retried save that already landed as saved, not as a conflict', async () => {
    store['2026-10-13'] = 'start'
    render(<Notes />)
    await settle()
    store['2026-10-13'] = 'start, then this'
    fireEvent.change(pad(), { target: { value: 'start, then this' } })
    await settle(700)
    expect(shown()).toBe('saved')
    expect(screen.queryByRole('button', { name: 'Keep mine' })).toBeNull()
  })

  it('treats a draft left by an older version as possibly stale and asks', async () => {
    store['2026-10-13'] = 'server copy'
    localStorage.setItem('devbox.notes.draft.2026-10-13', 'old-style draft')
    render(<Notes />)
    await settle()
    expect(pad()).toHaveValue('old-style draft')
    expect(screen.getByRole('status')).toHaveTextContent('changed elsewhere')
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    await settle()
    expect(store['2026-10-13']).toBe('old-style draft')
  })

  it('keeps the day you cleared in reach of the arrows', async () => {
    store['2026-10-09'] = 'friday'
    store['2026-10-12'] = 'monday'
    store['2026-10-13'] = 'today'
    render(<Notes />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'older notes' }))
    await settle()
    fireEvent.change(pad(), { target: { value: '' } })
    await settle(700)
    fireEvent.click(screen.getByRole('button', { name: 'older notes' }))
    await settle()
    expect(pad()).toHaveValue('friday')
  })

  it('jumps to the pad with n, leaves it with Escape, and remembers being collapsed', async () => {
    const view = render(<Notes />)
    await settle()
    fireEvent.keyDown(document.body, { key: 'n' })
    await settle()
    expect(pad()).toHaveFocus()
    fireEvent.keyDown(pad(), { key: 'Escape' })
    expect(screen.getByRole('button', { name: /Notes · Today/ })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: /Notes · Today/ }))
    expect(screen.queryByRole('textbox')).toBeNull()
    view.unmount()
    render(<Notes />)
    await settle()
    expect(screen.getByRole('button', { name: /Notes · Today/ })).toHaveAttribute('aria-expanded', 'false')
  })
})
