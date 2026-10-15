import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemePicker } from '../../src/components/ThemePicker'
import type { GhosttyLook } from '../../src/shared/types'
import { applyLook, DEVBOX, ghosttyLook, onTerminalLook, PRESETS, savedLook, terminalLook } from '../../src/theme'

const ansi = (c: string) => Array<string>(16).fill(c)
const GHOSTTY: GhosttyLook = {
  dark: { name: 'Night', palette: { background: '#101018', foreground: '#d0d0e0', ansi: ansi('#8090ff') } },
  light: { name: 'Day', palette: { background: '#f4f4f8', foreground: '#30303a', ansi: ansi('#2040c0') } },
  fontFamily: ['JetBrainsMonoNerdFont'],
  fontSize: 14,
  cursorStyle: 'bar',
  cursorBlink: true,
  minimumContrast: 1,
  boldIsBright: false,
  fontThicken: true,
  cellHeight: { value: 2, unit: 'px' },
  padding: [8, 10, 8, 10],
}

let light = false
let more = false
const listeners = new Set<() => void>()
const zoom = new Set<() => void>()

function serve(ghostty: GhosttyLook | null) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ghostty }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}

async function renderPicker() {
  render(<ThemePicker />)
  await act(async () => {
    await Promise.resolve()
  })
}

const bg = () => document.documentElement.style.getPropertyValue('--bg')
const toggle = () => screen.getAllByRole('button', { name: 'Theme' }).at(-1)!

function pick(name: RegExp) {
  if (toggle().getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle())
  fireEvent.click(screen.getByRole('radio', { name }))
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  light = false
  more = false
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('contrast') ? more : light
    },
    addEventListener: (_: string, fn: () => void) => (query.includes('resolution') ? zoom : listeners).add(fn),
    removeEventListener: (_: string, fn: () => void) => (query.includes('resolution') ? zoom : listeners).delete(fn),
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  listeners.clear()
  zoom.clear()
})

function zoomTo(dpr: number) {
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(dpr)
  act(() => zoom.forEach((fn) => fn()))
}

describe('ThemePicker', () => {
  it('starts on your Ghostty theme, with its font and cursor in the terminal', async () => {
    serve(GHOSTTY)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Ghostty · Night / Day')
    expect(bg()).toBe('#101018')
    expect(terminalLook()).toMatchObject({
      fontSize: 14,
      cursorStyle: 'bar',
      cursorBlink: true,
      minimumContrastRatio: 1,
      drawBoldTextInBrightColors: false,
      fontWeight: 500,
      lineHeight: 1.119,
    })
    expect(document.documentElement.style.getPropertyValue('--term-pad')).toBe('8px 10px 8px 10px')
    expect(terminalLook().fontFamily).toMatch(/^"JetBrainsMonoNerdFont", "JetBrainsMono Nerd Font", ui-monospace/)
  })

  it('follows the system between the light and dark halves of a Ghostty pair', async () => {
    serve(GHOSTTY)
    await renderPicker()
    light = true
    act(() => listeners.forEach((fn) => fn()))
    expect(bg()).toBe('#f4f4f8')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('raises contrast when the system asks for more', async () => {
    serve(GHOSTTY)
    await renderPicker()
    const dim = () => document.documentElement.style.getPropertyValue('--dim')
    const before = dim()
    more = true
    act(() => listeners.forEach((fn) => fn()))
    expect(dim()).not.toBe(before)
  })

  it('falls back to Sunset when the Ghostty theme it saved is gone', async () => {
    serve(GHOSTTY)
    await renderPicker()
    document.body.innerHTML = ''
    serve(null)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Sunset')
    expect(bg()).toBe('#09090b')
    expect(savedLook()).toBeNull()
  })

  it('moves a look saved from a retired preset to your Ghostty theme', async () => {
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'dracula' }))
    serve(GHOSTTY)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Ghostty · Night / Day')
    expect(savedLook()?.id).toBe('ghostty')
  })

  it('opens a gallery that previews both halves of every theme, and closes on Escape or a click outside', async () => {
    serve(GHOSTTY)
    await renderPicker()
    fireEvent.click(toggle())
    const gallery = screen.getByRole('group', { name: 'Theme' })
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')!.querySelectorAll('.theme-mini').length)).toEqual([2, 2, 2, 2, 2])
    expect(screen.getByRole('radio', { name: 'Ghostty Night / Day' })).toBeChecked()
    expect(gallery).toHaveTextContent('Light or dark follows your system.')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Sunset' }), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull()
    expect(toggle()).toHaveFocus()
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle())
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull()
  })

  it('shows one preview for a Ghostty theme without a light half', async () => {
    serve({ ...GHOSTTY, light: undefined })
    await renderPicker()
    fireEvent.click(toggle())
    expect(screen.getByRole('radio', { name: 'Ghostty Night' }).closest('label')!.querySelectorAll('.theme-mini')).toHaveLength(1)
  })

  it('ignores a saved look it cannot paint, and restores presets by id rather than by stored colors', () => {
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'ghostty', palette: { background: '#000', foreground: '#fff', ansi: [] } }))
    expect(savedLook()).toBeNull()
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'mono', palette: { background: '#123456' } }))
    expect(savedLook()).toBe(PRESETS.find((l) => l.id === 'mono'))
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'dracula' }))
    expect(savedLook()).toBeNull()
  })

  it('blinks the cursor when Ghostty does not say, as Ghostty does', () => {
    expect(ghosttyLook({ ...GHOSTTY, cursorBlink: undefined }).cursorBlink).toBe(true)
  })

  it('reads a percentage cell height as a line height, and never shrinks below 1', () => {
    applyLook(ghosttyLook({ ...GHOSTTY, cellHeight: { value: 20, unit: '%' } }))
    expect(terminalLook().lineHeight).toBe(1.2)
    applyLook(ghosttyLook({ ...GHOSTTY, cellHeight: { value: -30, unit: '%' } }))
    expect(terminalLook().lineHeight).toBe(1)
  })

  it('drops saved terminal settings xterm would reject, keeping the rest of the look', () => {
    const look = {
      ...ghosttyLook(GHOSTTY),
      cellHeight: { value: 'tall', unit: 'px' },
      padding: '8',
      minimumContrast: 40,
      fontSize: 'big',
      fontFamily: 'JetBrains Mono',
      cursorStyle: 'blinky',
    }
    localStorage.setItem('devbox.look', JSON.stringify(look))
    const saved = savedLook()!
    expect(saved.palette).toEqual(GHOSTTY.dark.palette)
    expect([saved.cellHeight, saved.padding, saved.fontSize, saved.fontFamily, saved.cursorStyle]).toEqual(Array(5).fill(undefined))
    expect(saved.minimumContrast).toBe(21)
    expect(() => applyLook(saved)).not.toThrow()
  })

  it('applies the same limits to a fresh Ghostty look as to a saved one', () => {
    const look = ghosttyLook({ ...GHOSTTY, fontSize: 80, padding: [8, 250, 8, 10.4], cellHeight: { value: 120, unit: '%' } })
    expect(look).toMatchObject({ fontSize: 72, padding: [8, 200, 8, 10], cellHeight: { value: 100, unit: '%' } })
    expect(ghosttyLook({ ...GHOSTTY, fontFamily: Array.from({ length: 9 }, (_, i) => `Font ${i}`) }).fontFamily).toHaveLength(8)
  })

  it('puts padding, weight, line height, and contrast back when you leave the Ghostty theme', async () => {
    serve(GHOSTTY)
    await renderPicker()
    pick(/^Aurora/)
    expect(document.documentElement.style.getPropertyValue('--term-pad')).toBe('8px 12px 8px 12px')
    expect(terminalLook()).toMatchObject({ minimumContrastRatio: 4.5, drawBoldTextInBrightColors: true, fontWeight: 'normal', lineHeight: 1 })
  })

  it('switches to a preset and remembers it over the Ghostty default', async () => {
    serve(GHOSTTY)
    await renderPicker()
    pick(/^Mono/)
    expect(bg()).toBe('#000000')
    expect(toggle()).toHaveAttribute('title', 'Theme: Mono')
    document.documentElement.removeAttribute('style')
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Mono')
    expect(bg()).toBe('#000000')
  })

  it('keeps your theme when a terminal fails to take it, and reports the failure', async () => {
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'mono' }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stop = onTerminalLook(() => {
      throw new Error('terminal disposed')
    })
    serve(null)
    await renderPicker()
    stop()
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'terminal disposed' }))
    errors.mockRestore()
    expect(toggle()).toHaveAttribute('title', 'Theme: Mono')
    expect(savedLook()?.id).toBe('mono')
    expect(bg()).not.toBe('')
  })

  it('stays up when even the fallback look cannot be painted, and keeps your choice for next time', async () => {
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'mono' }))
    vi.spyOn(document.documentElement.style, 'removeProperty').mockImplementation(() => {
      throw new Error('style locked')
    })
    serve(null)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Mono')
    expect(savedLook()?.id).toBe('mono')
  })

  it('keeps the picker working when your saved look cannot be painted', async () => {
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'mono' }))
    vi.spyOn(document.documentElement.style, 'setProperty').mockImplementation(() => {
      throw new Error('style locked')
    })
    serve(null)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Mono')
    pick(/^Sunset/)
    expect(savedLook()?.id).toBe('sunset')
  })

  it('repaints terminals on zoom only when the line height depends on it', async () => {
    let paints = 0
    const stop = onTerminalLook(() => {
      paints += 1
    })
    serve(GHOSTTY)
    await renderPicker()
    const before = terminalLook().lineHeight
    paints = 0
    zoomTo(2)
    expect(paints).toBe(1)
    expect(terminalLook().lineHeight).not.toBe(before)
    pick(/^Aurora/)
    paints = 0
    zoomTo(3)
    expect(paints).toBe(0)
    stop()
  })

  it('offers only the presets without Ghostty, and the Devbox fallback clears every override', async () => {
    serve(null)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Sunset')
    fireEvent.click(toggle())
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')!.querySelector('.theme-name')!.textContent)).toEqual(['Sunset', 'Aurora', 'Iris', 'Mono'])
    pick(/^Iris/)
    act(() => applyLook(DEVBOX))
    expect(document.documentElement.getAttribute('style') ?? '').toBe('')
  })
})
