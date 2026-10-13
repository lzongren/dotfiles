import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemePicker } from '../../src/components/ThemePicker'
import type { GhosttyLook } from '../../src/shared/types'
import { applyLook, ghosttyLook, onTerminalLook, PRESETS, savedLook, terminalLook } from '../../src/theme'

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
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveDisplayValue('Ghostty · Night / Day')
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

  it('falls back to Devbox when the Ghostty theme it saved is gone', async () => {
    serve(GHOSTTY)
    await renderPicker()
    document.body.innerHTML = ''
    serve(null)
    await renderPicker()
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveDisplayValue('Devbox')
    expect(savedLook()).toBeNull()
  })

  it('ignores a saved look it cannot paint, and restores presets by id rather than by stored colors', () => {
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'ghostty', palette: { background: '#000', foreground: '#fff', ansi: [] } }))
    expect(savedLook()).toBeNull()
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'dracula', palette: { background: '#123456' } }))
    expect(savedLook()).toBe(PRESETS.find((l) => l.id === 'dracula'))
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'tokyo-night' } })
    expect(document.documentElement.style.getPropertyValue('--term-pad')).toBe('')
    expect(terminalLook()).toMatchObject({ minimumContrastRatio: 4.5, drawBoldTextInBrightColors: true, fontWeight: 'normal', lineHeight: 1 })
  })

  it('switches to a preset and remembers it over the Ghostty default', async () => {
    serve(GHOSTTY)
    await renderPicker()
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'gruvbox-dark' } })
    expect(bg()).toBe('#282828')
    document.documentElement.removeAttribute('style')
    await renderPicker()
    expect(screen.getAllByRole('combobox', { name: 'Theme' })[1]).toHaveDisplayValue('Gruvbox Dark')
    expect(bg()).toBe('#282828')
  })

  it('keeps your theme when a terminal fails to take it, and reports the failure', async () => {
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'dracula' }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stop = onTerminalLook(() => {
      throw new Error('terminal disposed')
    })
    serve(null)
    await renderPicker()
    stop()
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'terminal disposed' }))
    errors.mockRestore()
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveDisplayValue('Dracula')
    expect(savedLook()?.id).toBe('dracula')
    expect(bg()).not.toBe('')
  })

  it('stays up when even the fallback look cannot be painted, and keeps your choice for next time', async () => {
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'dracula' }))
    vi.spyOn(document.documentElement.style, 'removeProperty').mockImplementation(() => {
      throw new Error('style locked')
    })
    serve(null)
    await renderPicker()
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveDisplayValue('Dracula')
    expect(savedLook()?.id).toBe('dracula')
  })

  it('paints Devbox when your saved look fails, and lets you pick Devbox to keep it', async () => {
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'dracula' }))
    vi.spyOn(document.documentElement.style, 'setProperty').mockImplementation(() => {
      throw new Error('style locked')
    })
    serve(null)
    await renderPicker()
    const picker = screen.getByRole('combobox', { name: 'Theme' })
    expect(picker).toHaveDisplayValue('Dracula')
    fireEvent.change(picker, { target: { value: 'devbox' } })
    expect(savedLook()?.id).toBe('devbox')
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'tokyo-night' } })
    paints = 0
    zoomTo(3)
    expect(paints).toBe(0)
    stop()
  })

  it('offers only the presets without Ghostty, and Devbox clears every override', async () => {
    serve(null)
    await renderPicker()
    const picker = screen.getByRole('combobox', { name: 'Theme' })
    expect(picker).toHaveDisplayValue('Devbox')
    expect(screen.queryByRole('option', { name: /Ghostty/ })).toBeNull()
    fireEvent.change(picker, { target: { value: 'dracula' } })
    fireEvent.change(picker, { target: { value: 'devbox' } })
    expect(document.documentElement.getAttribute('style') ?? '').toBe('')
  })
})
