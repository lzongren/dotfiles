import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ignoredTarget } from '../../src/components/Overview'
import { ThemePicker } from '../../src/components/ThemePicker'
import type { GhosttyLook } from '../../src/shared/types'
import { applyLook, DEVBOX, ghosttyLook, MEDIA, migrateLook, onTerminalLook, PRESETS, savedLook, startLook, TERMINAL_OPTIONS, terminalLook } from '../../src/theme'

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
  it('starts on the Devbox theme, and offers your Ghostty theme with its font and cursor in the terminal', async () => {
    serve(GHOSTTY)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Devbox')
    expect(bg()).toBe('#0b1020')
    pick(/^Ghostty/)
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
    pick(/^Ghostty/)
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

  it('falls back to Devbox when the Ghostty theme you picked is gone', async () => {
    serve(GHOSTTY)
    await renderPicker()
    pick(/^Ghostty/)
    document.body.innerHTML = ''
    serve(null)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Devbox')
    expect(bg()).toBe('#0b1020')
    expect(savedLook()).toBeNull()
  })

  it('starts on Devbox from a retired preset or a look an earlier version saved for you', async () => {
    localStorage.setItem('devbox.theme', JSON.stringify({ id: 'dracula' }))
    localStorage.setItem('devbox.look', JSON.stringify(ghosttyLook(GHOSTTY)))
    serve(GHOSTTY)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Devbox')
    expect(savedLook()).toBeNull()
  })

  it('starts on a preset picked under the earlier storage key, and clears that key', async () => {
    localStorage.setItem('devbox.look', JSON.stringify({ id: 'mono' }))
    startLook()
    expect(bg()).toBe('#000000')
    serve(GHOSTTY)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Mono')
    expect(localStorage.getItem('devbox.look')).toBeNull()
  })

  it('keeps the earlier entry for next time when the new one cannot be written', () => {
    const old = JSON.stringify({ id: 'mono' })
    localStorage.setItem('devbox.look', old)
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    migrateLook()
    expect(localStorage.getItem('devbox.look')).toBe(old)
    expect(localStorage.getItem('devbox.theme')).toBeNull()
    write.mockRestore()
    migrateLook()
    expect(savedLook()?.id).toBe('mono')
  })

  it('starts on the fallback look rather than failing when the saved one cannot be painted', () => {
    applyLook(PRESETS[1])
    localStorage.setItem('devbox.theme', JSON.stringify({ id: 'mono' }))
    vi.spyOn(document.documentElement.style, 'setProperty').mockImplementation(() => {
      throw new Error('style locked')
    })
    expect(() => startLook()).not.toThrow()
    expect(bg()).toBe('')
    expect(terminalLook().theme).toEqual(TERMINAL_OPTIONS.theme)
  })

  it.each([
    ['answer nothing', () => null, '#0b1020'],
    ['throw', () => {
      throw new Error('blocked')
    }, '#0b1020'],
    ['be missing', undefined, '#0b1020'],
    ['ask for light but cannot report changes', () => ({ matches: true }), '#ffffff'],
  ])('starts and shows the picker when the system color settings %s', async (_, media, painted) => {
    vi.stubGlobal('matchMedia', media)
    startLook()
    expect(bg()).toBe(painted)
    serve(null)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Devbox')
  })

  it.each([
    ['has no change events', {}],
    ['refuses change events', { addEventListener: () => { throw new Error('not here') } }],
  ])('follows the system through the older listener API when the browser %s, and stops when it goes away', async (_, events) => {
    const heard: Array<() => void> = []
    vi.stubGlobal('matchMedia', (query: string) => ({
      ...events,
      get matches() {
        return query.includes('contrast') ? false : light
      },
      addListener: (fn: () => void) => heard.push(fn),
      removeListener: (fn: () => void) => {
        const at = heard.indexOf(fn)
        if (at >= 0) heard.splice(at, 1)
      },
    }))
    serve(null)
    const { unmount } = render(<ThemePicker />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(heard).toHaveLength(MEDIA.length + 1)
    light = true
    act(() => heard.forEach((fn) => fn()))
    expect(bg()).toBe('#ffffff')
    unmount()
    expect(heard).toHaveLength(0)
  })

  it.each([
    ['a Ghostty look the earlier version saved', JSON.stringify(ghosttyLook(GHOSTTY)), null, null],
    ['an unreadable earlier entry', '{bad', JSON.stringify({ id: 'sunset' }), 'sunset'],
    ['an earlier pick when one is saved now', JSON.stringify({ id: 'mono' }), JSON.stringify({ id: 'iris' }), 'iris'],
  ])('moves past %s', (_, old, now, kept) => {
    localStorage.setItem('devbox.look', old)
    if (now) localStorage.setItem('devbox.theme', now)
    migrateLook()
    expect(savedLook()?.id ?? null).toBe(kept)
    expect(localStorage.getItem('devbox.look')).toBeNull()
  })

  it('opens a gallery that previews both halves of every theme, and closes on Escape or a click outside', async () => {
    serve(GHOSTTY)
    await renderPicker()
    fireEvent.click(toggle())
    const gallery = screen.getByRole('group', { name: 'Theme' })
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')!.querySelectorAll('.theme-mini').length)).toEqual([2, 2, 2, 2, 2, 2])
    expect(screen.getByRole('radio', { name: 'Devbox' })).toBeChecked()
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
    localStorage.setItem('devbox.theme', JSON.stringify({ id: 'ghostty', palette: { background: '#000', foreground: '#fff', ansi: [] } }))
    expect(savedLook()).toBeNull()
    localStorage.setItem('devbox.theme', JSON.stringify({ id: 'mono', palette: { background: '#123456' } }))
    expect(savedLook()).toBe(PRESETS.find((l) => l.id === 'mono'))
    localStorage.setItem('devbox.theme', JSON.stringify({ id: 'dracula' }))
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
    localStorage.setItem('devbox.theme', JSON.stringify(look))
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
    pick(/^Ghostty/)
    pick(/^Aurora/)
    expect(document.documentElement.style.getPropertyValue('--term-pad')).toBe('8px 12px 8px 12px')
    expect(terminalLook()).toMatchObject({ minimumContrastRatio: 4.5, drawBoldTextInBrightColors: true, fontWeight: 'normal', lineHeight: 1 })
  })

  it('remembers the theme you pick, Ghostty included', async () => {
    serve(GHOSTTY)
    await renderPicker()
    pick(/^Mono/)
    expect(bg()).toBe('#000000')
    expect(toggle()).toHaveAttribute('title', 'Theme: Mono')
    document.documentElement.removeAttribute('style')
    document.body.innerHTML = ''
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Mono')
    expect(bg()).toBe('#000000')
    pick(/^Ghostty/)
    document.body.innerHTML = ''
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', 'Theme: Ghostty · Night / Day')
    expect(bg()).toBe('#101018')
  })

  it('keeps your theme when a terminal fails to take it, and reports the failure', async () => {
    localStorage.setItem('devbox.theme', JSON.stringify({ id: 'mono' }))
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
    localStorage.setItem('devbox.theme', JSON.stringify({ id: 'mono' }))
    vi.spyOn(document.documentElement.style, 'removeProperty').mockImplementation(() => {
      throw new Error('style locked')
    })
    serve(null)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', "Theme: Mono (couldn't apply)")
    fireEvent.click(toggle())
    expect(screen.getByRole('status')).toHaveTextContent(/^Mono couldn't be applied here\.$/)
    expect(savedLook()?.id).toBe('mono')
  })

  it('says when your saved look cannot be painted, and still lets you pick another', async () => {
    localStorage.setItem('devbox.theme', JSON.stringify({ id: 'mono' }))
    const set = vi.spyOn(document.documentElement.style, 'setProperty').mockImplementation(() => {
      throw new Error('style locked')
    })
    serve(null)
    await renderPicker()
    expect(toggle()).toHaveAttribute('title', "Theme: Mono (couldn't apply)")
    fireEvent.click(toggle())
    expect(screen.getByRole('status')).toHaveTextContent("Mono couldn't be applied here, so the default colors are showing.")
    set.mockRestore()
    pick(/^Sunset/)
    expect(savedLook()?.id).toBe('sunset')
    expect(toggle()).toHaveAttribute('title', 'Theme: Sunset')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps single-key shortcuts away from the picker, and closes when focus moves elsewhere on the page', async () => {
    serve(null)
    await renderPicker()
    expect(ignoredTarget(toggle())).toBe(true)
    fireEvent.click(toggle())
    const outside = document.body.appendChild(document.createElement('button'))
    vi.useFakeTimers()
    try {
      fireEvent.blur(screen.getByRole('radio', { name: 'Sunset' }), { relatedTarget: null })
      act(() => vi.runAllTimers())
      expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument()
      outside.focus()
      fireEvent.blur(screen.getByRole('radio', { name: 'Sunset' }), { relatedTarget: null })
      act(() => vi.runAllTimers())
      expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull()
    } finally {
      vi.useRealTimers()
      outside.remove()
    }
  })

  it('previews each theme as it paints under the more-contrast setting', async () => {
    serve(null)
    await renderPicker()
    fireEvent.click(toggle())
    const dim = () => (document.querySelector('.theme-mini') as HTMLElement).style.getPropertyValue('--dim')
    const before = dim()
    more = true
    act(() => listeners.forEach((fn) => fn()))
    expect(dim()).not.toBe(before)
    expect(dim()).toBe(document.documentElement.style.getPropertyValue('--dim'))
  })

  it('repaints terminals on zoom only when the line height depends on it', async () => {
    let paints = 0
    const stop = onTerminalLook(() => {
      paints += 1
    })
    serve(GHOSTTY)
    await renderPicker()
    pick(/^Ghostty/)
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
    expect(toggle()).toHaveAttribute('title', 'Theme: Devbox')
    fireEvent.click(toggle())
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')!.querySelector('.theme-name')!.textContent)).toEqual(['Devbox', 'Sunset', 'Aurora', 'Iris', 'Mono'])
    pick(/^Iris/)
    act(() => applyLook(DEVBOX))
    expect(document.documentElement.getAttribute('style') ?? '').toBe('')
  })
})
