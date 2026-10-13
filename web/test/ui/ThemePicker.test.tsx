import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemePicker } from '../../src/components/ThemePicker'
import type { GhosttyLook } from '../../src/shared/types'
import { terminalLook } from '../../src/theme'

const ansi = (c: string) => Array<string>(16).fill(c)
const GHOSTTY: GhosttyLook = {
  dark: { name: 'Night', palette: { background: '#101018', foreground: '#d0d0e0', ansi: ansi('#8090ff') } },
  light: { name: 'Day', palette: { background: '#f4f4f8', foreground: '#30303a', ansi: ansi('#2040c0') } },
  fontFamily: ['JetBrainsMonoNerdFont'],
  fontSize: 14,
  cursorStyle: 'bar',
  cursorBlink: true,
}

let light = false
const listeners = new Set<() => void>()

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
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return light
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  listeners.clear()
})

describe('ThemePicker', () => {
  it('starts on your Ghostty theme, with its font and cursor in the terminal', async () => {
    serve(GHOSTTY)
    await renderPicker()
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveDisplayValue('Ghostty · Night / Day')
    expect(bg()).toBe('#101018')
    expect(terminalLook()).toMatchObject({ fontSize: 14, cursorStyle: 'bar', cursorBlink: true })
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
