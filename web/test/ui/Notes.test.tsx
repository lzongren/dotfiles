import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Notes } from '../../src/components/Notes'

let store: Record<string, string>
let failPuts = 0
let failStatus = 500
let failGets = 0
const puts: Array<{ day: string; text: string }> = []

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
      const { text } = JSON.parse(init.body as string) as { text: string }
      puts.push({ day, text })
      if (text.trim()) store[day] = text
      else delete store[day]
      return json({ day, saved: true })
    }
    if (failGets > 0) {
      failGets -= 1
      return json({ error: 'internal', message: 'could not read the note' }, 500)
    }
    return json({ day, text: store[day] ?? '' })
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

  it('saves an edit on one day even after you move on and edit another while offline', async () => {
    store['2026-10-12'] = 'monday'
    failPuts = 2
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'tuesday plan' } })
    await settle(700)
    fireEvent.click(screen.getByRole('button', { name: 'older notes' }))
    await settle()
    expect(pad()).toHaveValue('monday')
    fireEvent.change(pad(), { target: { value: 'monday, revised' } })
    await settle(700)
    expect(store).toEqual({ '2026-10-12': 'monday, revised', '2026-10-13': 'tuesday plan' })
  })

  it('restores a draft the page never got to save, and saves it', async () => {
    store['2026-10-13'] = 'old'
    localStorage.setItem('devbox.notes.draft.2026-10-13', 'newer, typed before a reload')
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
    expect(localStorage.getItem('devbox.notes.draft.2026-10-13')).toBe('keep me')
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
