import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Notes } from '../../src/components/Notes'

let store: Record<string, string>
let failPuts = 0
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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(new Date(2026, 9, 13, 10, 0))
  localStorage.clear()
  store = {}
  failPuts = 0
  puts.length = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === '/api/notes') return json({ days: Object.keys(store).sort().reverse() })
    const day = url.slice('/api/notes/'.length)
    if (init.method === 'PUT') {
      if (failPuts > 0) {
        failPuts -= 1
        return json({ error: 'internal', message: 'disk full' }, 500)
      }
      const { text } = JSON.parse(init.body as string) as { text: string }
      puts.push({ day, text })
      if (text.trim()) store[day] = text
      else delete store[day]
      return json({ day, saved: true })
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
    expect(screen.getByRole('status')).toHaveTextContent('saved')
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
    expect(screen.getByRole('status')).toHaveTextContent('not saved')
    await settle(5100)
    expect(store['2026-10-13']).toBe('do not lose this')
    expect(screen.getByRole('status')).toHaveTextContent('saved')
  })

  it('jumps to the pad with n, leaves it with Escape, and remembers being collapsed', async () => {
    const view = render(<Notes />)
    await settle()
    fireEvent.keyDown(document.body, { key: 'n' })
    await settle()
    expect(pad()).toHaveFocus()
    fireEvent.keyDown(pad(), { key: 'Escape' })
    expect(pad()).not.toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: /Notes · Today/ }))
    expect(screen.queryByRole('textbox')).toBeNull()
    view.unmount()
    render(<Notes />)
    await settle()
    expect(screen.getByRole('button', { name: /Notes · Today/ })).toHaveAttribute('aria-expanded', 'false')
  })
})
