import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Notes } from '../../src/components/Notes'

let store: Record<string, string>
let failPuts = 0
let failStatus = 500
let failGets = 0
let loseReplies = 0
const puts: Array<{ day: string; text: string }> = []
const gets: string[] = []

const version = (text: string) => (text ? `h:${text}` : '')
let getGate: Promise<void> | null = null
let putGate: Promise<void> | null = null

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
  putGate = null
  store = {}
  failPuts = 0
  failStatus = 500
  failGets = 0
  loseReplies = 0
  puts.length = 0
  gets.length = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === '/api/notes') return json({ days: Object.keys(store).sort().reverse() })
    const day = url.slice('/api/notes/'.length)
    if (init.method === 'PUT') {
      if (putGate) await putGate
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
      if (loseReplies > 0) {
        loseReplies -= 1
        return json({ error: 'remote_unreachable', message: 'connection reset' }, 502)
      }
      return json({ day, version: version(text) })
    }
    gets.push(day)
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
  Reflect.deleteProperty(navigator, 'locks')
})

type Grant = (lock: object | null) => unknown

function fakeLocks() {
  let held: { reject: (err: unknown) => void } | null = null
  const waiting: Array<() => void> = []
  const run = (hold: Grant, resolve: (value: unknown) => void, reject: (err: unknown) => void) => {
    const me = { reject }
    held = me
    void Promise.resolve(hold({ name: 'devbox.notes', mode: 'exclusive' })).then((value) => {
      if (held !== me) return
      held = null
      resolve(value)
      waiting.shift()?.()
    })
  }
  const request = (_name: string, options: LockOptions, hold: Grant) =>
    new Promise((resolve, reject) => {
      if (options.steal) {
        held?.reject(new DOMException('stolen', 'AbortError'))
        run(hold, resolve, reject)
      } else if (!held && waiting.length === 0) run(hold, resolve, reject)
      else if (options.ifAvailable) void Promise.resolve(hold(null)).then(resolve)
      else {
        const go = () => run(hold, resolve, reject)
        waiting.push(go)
        options.signal?.addEventListener('abort', () => {
          const at = waiting.indexOf(go)
          if (at < 0) return
          waiting.splice(at, 1)
          reject(new DOMException('aborted', 'AbortError'))
        })
      }
    })
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true })
  return {
    other(options: LockOptions = {}) {
      let release = () => undefined as void
      let lost = false
      request('devbox.notes', options, () => new Promise<void>((done) => (release = done))).catch(() => {
        lost = true
      })
      return { release: () => release(), lost: () => lost }
    },
  }
}

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
    expect(screen.getByRole('status')).toHaveTextContent('not saved yet, retrying — switch days once it saves')
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

  it('asks before overwriting a note that changed in another editor, and says to settle it before moving', async () => {
    store['2026-10-12'] = 'monday'
    store['2026-10-13'] = 'morning'
    render(<Notes />)
    await settle()
    store['2026-10-13'] = 'morning\nedited in vim'
    fireEvent.change(pad(), { target: { value: 'morning, from the browser' } })
    await settle(700)
    expect(store['2026-10-13']).toBe('morning\nedited in vim')
    expect(screen.getByRole('status')).toHaveTextContent('changed elsewhere')
    expect(pad()).toHaveAttribute('readonly')
    fireEvent.click(screen.getByRole('button', { name: 'older notes' }))
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('changed elsewhere — resolve the conflict first')
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
    expect(screen.getByRole('status')).toHaveTextContent('not saved: request body too large — discard or edit it first')
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

  it('reopens on a day whose draft never saved, and saves it there', async () => {
    store['2026-10-13'] = 'today'
    localStorage.setItem('devbox.notes.draft.2026-10-11', JSON.stringify({ text: 'sunday, typed while offline', base: '' }))
    localStorage.setItem('devbox.notes.draft.not-a-day', JSON.stringify({ text: 'x', base: '' }))
    render(<Notes />)
    await settle()
    expect(pad()).toHaveValue('sunday, typed while offline')
    expect(screen.getByRole('button', { name: /^Notes · Sun/ })).toBeInTheDocument()
    await settle()
    expect(store['2026-10-11']).toBe('sunday, typed while offline')
    fireEvent.click(screen.getByRole('button', { name: 'newer notes' }))
    await settle()
    expect(pad()).toHaveValue('today')
  })

  it('takes its own save back as saved when the reply was lost and more was typed since', async () => {
    store['2026-10-13'] = 'start'
    loseReplies = 1
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'a' } })
    await settle(700)
    expect(store['2026-10-13']).toBe('a')
    fireEvent.change(pad(), { target: { value: 'ab' } })
    await settle(700)
    expect(store['2026-10-13']).toBe('ab')
    expect(shown()).toBe('saved')
    expect(screen.queryByRole('button', { name: 'Keep mine' })).toBeNull()
  })

  it('counts a cleared pad as saved when the server removed the file but the reply was lost', async () => {
    store['2026-10-13'] = 'start'
    loseReplies = 1
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: '  ' } })
    await settle(700)
    await settle(5100)
    expect(shown()).toBe('saved')
    expect(localStorage.getItem('devbox.notes.draft.2026-10-13')).toBeNull()
  })

  it('mirrors the tab that holds the pad, read-only, and takes over its draft when that tab goes', async () => {
    store['2026-10-13'] = 'start'
    const them = fakeLocks().other()
    render(<Notes />)
    await settle()
    expect(pad()).toHaveValue('start')
    expect(pad()).toHaveAttribute('readonly')
    expect(shown()).toBe('editing in another tab')
    const key = 'devbox.notes.draft.2026-10-13'
    const typed = (text: string, base: string) => {
      const value = JSON.stringify({ text, base })
      localStorage.setItem(key, value)
      act(() => {
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
      })
    }
    typed('start, typed there', 'h:start')
    expect(pad()).toHaveValue('start, typed there')
    fireEvent.change(pad(), { target: { value: 'typed here' } })
    await settle(700)
    expect(pad()).toHaveValue('start, typed there')
    store['2026-10-13'] = 'start, typed there, saved'
    localStorage.removeItem(key)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: null }))
    })
    await settle()
    expect(pad()).toHaveValue('start, typed there, saved')
    typed('last words before that tab closed', 'h:start, typed there, saved')
    expect(puts).toEqual([])
    act(() => them.release())
    await settle()
    expect(store['2026-10-13']).toBe('last words before that tab closed')
    expect(pad()).not.toHaveAttribute('readonly')
    expect(shown()).toBe('saved')
  })

  it('hands the pad to the tab you type in, and saves what it holds before another tab takes it', async () => {
    store['2026-10-13'] = 'start'
    const locks = fakeLocks()
    const them = locks.other()
    render(<Notes />)
    await settle()
    expect(pad()).toHaveAttribute('readonly')
    act(() => pad().focus())
    await settle()
    expect(them.lost()).toBe(true)
    expect(pad()).not.toHaveAttribute('readonly')
    fireEvent.change(pad(), { target: { value: 'mine' } })
    const back = locks.other({ steal: true })
    await settle()
    expect(pad()).toHaveAttribute('readonly')
    expect(puts).toEqual([{ day: '2026-10-13', text: 'mine' }])
    await settle(700)
    expect(puts).toHaveLength(1)
    act(() => back.release())
    await settle()
    expect(pad()).not.toHaveAttribute('readonly')
    expect(store['2026-10-13']).toBe('mine')
  })

  it('lets go of focus when another tab takes the pad, so the next click takes it back', async () => {
    const locks = fakeLocks()
    render(<Notes />)
    await settle()
    act(() => pad().focus())
    const them = locks.other({ steal: true })
    await settle()
    expect(pad()).toHaveAttribute('readonly')
    expect(pad()).not.toHaveFocus()
    act(() => pad().focus())
    await settle()
    expect(them.lost()).toBe(true)
    expect(pad()).not.toHaveAttribute('readonly')
  })

  it('stays on the day you clicked into when taking the pad, even with an older draft stored', async () => {
    store['2026-10-13'] = 'today'
    fakeLocks().other()
    render(<Notes />)
    await settle()
    localStorage.setItem('devbox.notes.draft.2026-10-11', JSON.stringify({ text: 'stuck', base: '' }))
    act(() => pad().focus())
    await settle()
    expect(pad()).not.toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: /^Notes · Today/ })).toBeInTheDocument()
    expect(pad()).toHaveValue('today')
  })

  it('goes read-only the moment another tab takes the pad, even while its last save is still out', async () => {
    store['2026-10-13'] = 'start'
    const locks = fakeLocks()
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'mine' } })
    let open = () => undefined as void
    putGate = new Promise<void>((done) => (open = done))
    locks.other({ steal: true })
    await settle()
    expect(pad()).toHaveAttribute('readonly')
    open()
    await settle()
    expect(store['2026-10-13']).toBe('mine')
  })

  it('hands over after its own save in flight, so text typed while it was out still lands', async () => {
    store['2026-10-13'] = 'start'
    const locks = fakeLocks()
    render(<Notes />)
    await settle()
    let open = () => undefined as void
    putGate = new Promise<void>((done) => (open = done))
    fireEvent.change(pad(), { target: { value: 'a' } })
    await settle(700)
    fireEvent.change(pad(), { target: { value: 'ab' } })
    locks.other({ steal: true })
    await settle()
    expect(pad()).toHaveAttribute('readonly')
    putGate = null
    open()
    await settle()
    expect(store['2026-10-13']).toBe('ab')
    expect(puts.map((p) => p.text)).toEqual(['a', 'ab'])
    expect(shown()).not.toMatch(/changed elsewhere/)
  })

  it('ignores edits during the handover, says so, saves once, then follows the other tab', async () => {
    store['2026-10-13'] = 'start'
    const locks = fakeLocks()
    render(<Notes />)
    await settle()
    act(() => pad().focus())
    fireEvent.change(pad(), { target: { value: 'mine' } })
    let open = () => undefined as void
    putGate = new Promise<void>((done) => (open = done))
    const them = locks.other({ steal: true })
    await settle()
    expect(shown()).toBe('handing over…')
    fireEvent.change(pad(), { target: { value: 'sneaky' } })
    act(() => pad().blur())
    act(() => pad().focus())
    putGate = null
    open()
    await settle()
    expect(puts.map((p) => p.text)).toEqual(['mine'])
    expect(them.lost()).toBe(false)
    expect(pad()).toHaveAttribute('readonly')
    expect(pad()).toHaveValue('mine')
    expect(shown()).toBe('editing in another tab')
  })

  it('reloads after taking the pad when the old tab finishes saving, so it never shows a stale copy', async () => {
    store['2026-10-13'] = 'start'
    fakeLocks().other()
    render(<Notes />)
    await settle()
    act(() => pad().focus())
    await settle()
    expect(pad()).toHaveValue('start')
    store['2026-10-13'] = 'mine'
    const key = 'devbox.notes.draft.2026-10-13'
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key, oldValue: JSON.stringify({ text: 'mine', base: 'h:start' }), newValue: null }))
    })
    await settle()
    expect(pad()).toHaveValue('mine')
  })

  it('leaves the stored draft, the arrows and Retry alone while handing over', async () => {
    store['2026-10-12'] = 'yesterday'
    store['2026-10-13'] = 'start'
    const locks = fakeLocks()
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'a' } })
    await settle(700)
    let open = () => undefined as void
    putGate = new Promise<void>((done) => (open = done))
    fireEvent.change(pad(), { target: { value: 'ab' } })
    act(() => pad().blur())
    locks.other({ steal: true })
    await settle()
    const key = 'devbox.notes.draft.2026-10-13'
    localStorage.setItem(key, JSON.stringify({ text: 'abX', base: 'h:a' }))
    fireEvent.click(screen.getByRole('button', { name: /older/i }))
    putGate = null
    open()
    await settle()
    expect(screen.getByRole('button', { name: /^Notes · Today/ })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toMatchObject({ text: 'abX' })
  })

  it('saves a draft the browser could not store before handing the pad over', async () => {
    store['2026-10-13'] = 'start'
    const locks = fakeLocks()
    render(<Notes />)
    await settle()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    fireEvent.change(pad(), { target: { value: 'only in memory' } })
    locks.other({ steal: true })
    await settle()
    setItem.mockRestore()
    expect(store['2026-10-13']).toBe('only in memory')
  })

  it('on taking over, opens the oldest draft another tab left and saves it', async () => {
    store['2026-10-13'] = 'today'
    const them = fakeLocks().other()
    render(<Notes />)
    await settle()
    localStorage.setItem('devbox.notes.draft.2026-10-11', JSON.stringify({ text: 'sunday, unsaved', base: '' }))
    act(() => them.release())
    await settle()
    expect(store['2026-10-11']).toBe('sunday, unsaved')
    expect(screen.getByRole('button', { name: /^Notes · Sun/ })).toBeInTheDocument()
  })

  it('edits as usual when the browser refuses the lock outright', async () => {
    store['2026-10-13'] = 'start'
    Object.defineProperty(navigator, 'locks', {
      value: { request: () => Promise.reject(new DOMException('denied', 'SecurityError')) },
      configurable: true,
    })
    render(<Notes />)
    await settle()
    expect(pad()).not.toHaveAttribute('readonly')
    expect(shown()).toBe('saved')
  })

  it('loads the day once, after learning it holds the pad', async () => {
    store['2026-10-13'] = 'start'
    fakeLocks()
    render(<Notes />)
    await settle()
    expect(gets.filter((d) => d === '2026-10-13')).toHaveLength(1)
    expect(pad()).not.toHaveAttribute('readonly')
  })

  it('does not rescan stored drafts while the other tab types', async () => {
    fakeLocks().other()
    render(<Notes />)
    await settle()
    const key = 'devbox.notes.draft.2026-10-13'
    const value = JSON.stringify({ text: 'ab', base: '' })
    localStorage.setItem(key, value)
    const scans = vi.spyOn(Storage.prototype, 'key')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key, oldValue: JSON.stringify({ text: 'a', base: '' }), newValue: value }))
    })
    expect(pad()).toHaveValue('ab')
    expect(scans).not.toHaveBeenCalled()
    scans.mockRestore()
  })

  it('lets you discard a draft the server keeps refusing, so it cannot pin the pad to its day', async () => {
    store['2026-10-13'] = 'today'
    failPuts = 100
    failStatus = 413
    localStorage.setItem('devbox.notes.draft.2026-10-11', JSON.stringify({ text: 'a huge paste', base: '' }))
    render(<Notes />)
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('not saved: request body too large')
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved' }))
    await settle()
    expect(localStorage.getItem('devbox.notes.draft.2026-10-11')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'newer notes' }))
    await settle()
    expect(pad()).toHaveValue('today')
  })

  it('switches days in one click when a lost reply is matched and the rest saves', async () => {
    store['2026-10-12'] = 'monday'
    store['2026-10-13'] = 'start'
    loseReplies = 1
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'a' } })
    await settle(700)
    fireEvent.change(pad(), { target: { value: 'ab' } })
    fireEvent.click(screen.getByRole('button', { name: 'older notes' }))
    await settle()
    expect(store['2026-10-13']).toBe('ab')
    expect(pad()).toHaveValue('monday')
  })

  it('does not scan stored drafts while you type', async () => {
    render(<Notes />)
    await settle()
    const scans = vi.spyOn(Storage.prototype, 'key')
    for (const text of ['a', 'ab', 'abc']) fireEvent.change(pad(), { target: { value: text } })
    expect(scans).not.toHaveBeenCalled()
    scans.mockRestore()
  })

  it('stops calling yesterday Today after midnight, and moves on once the draft has saved', async () => {
    vi.setSystemTime(new Date(2026, 9, 13, 23, 59, 30))
    store['2026-10-13'] = 'late'
    failPuts = 100
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'late, still typing' } })
    await settle(61_000)
    expect(screen.getByRole('button', { name: /^Notes · Tue/ })).toBeInTheDocument()
    expect(pad()).toHaveValue('late, still typing')
    failPuts = 0
    await settle(5100)
    expect(store['2026-10-13']).toBe('late, still typing')
    expect(screen.getByRole('button', { name: /Notes · Today/ })).toBeInTheDocument()
    expect(pad()).toHaveValue('')
  })

  it('stays put after midnight once you keep typing, so the pad never jumps mid-sentence', async () => {
    vi.setSystemTime(new Date(2026, 9, 13, 23, 59, 30))
    store['2026-10-13'] = 'late'
    failPuts = 100
    render(<Notes />)
    await settle()
    fireEvent.change(pad(), { target: { value: 'late, still typing' } })
    await settle(61_000)
    fireEvent.change(pad(), { target: { value: 'late, still typing, more' } })
    failPuts = 0
    await settle(5100)
    expect(store['2026-10-13']).toBe('late, still typing, more')
    expect(screen.getByRole('button', { name: /^Notes · Tue/ })).toBeInTheDocument()
    expect(pad()).toHaveValue('late, still typing, more')
  })

  it('moves to the new day at midnight when everything is saved', async () => {
    vi.setSystemTime(new Date(2026, 9, 13, 23, 59, 30))
    store['2026-10-13'] = 'late'
    render(<Notes />)
    await settle()
    await settle(61_000)
    expect(screen.getByRole('button', { name: /Notes · Today/ })).toBeInTheDocument()
    expect(pad()).toHaveValue('')
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
