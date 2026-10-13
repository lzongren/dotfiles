import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TERMINAL_OPTIONS } from '../../src/theme'

const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/styles.css'), 'utf8')

function token(name: string): string[] {
  const values = [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'gi'))].map((m) => m[1])
  if (values.length === 0) throw new Error(`styles.css has no hex --${name}`)
  return values
}

function worst(fg: string, bg: string): number {
  return Math.min(...token(fg).flatMap((a) => token(bg).map((b) => contrast(a, b))))
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const theme = TERMINAL_OPTIONS.theme as Record<string, string>

describe('theme contrast (WCAG AA)', () => {
  it('computes the WCAG ratio', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21)
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
  })

  it.each(['text', 'dim', 'accent', 'bell'])('--%s text is at least 4.5:1 on every surface', (fg) => {
    for (const surface of ['bg', 'surface', 'raised', 'selected', 'term-bg']) {
      expect(worst(fg, surface), `--${fg} on --${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('control borders are at least 3:1 against what they sit on', () => {
    for (const surface of ['bg', 'surface', 'term-bg']) {
      expect(worst('control', surface), `--control on --${surface}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('the warning banner keeps its text readable', () => {
    expect(worst('bell', 'bell-bg')).toBeGreaterThanOrEqual(4.5)
  })

  it('never fades content with partial opacity, which these checks cannot see', () => {
    expect(css).not.toMatch(/opacity:\s*(0?\.\d|\d{1,2}%)|opacity\(/)
  })

  it('every terminal color except black is at least 4.5:1 on the terminal background', () => {
    for (const [name, color] of Object.entries(theme)) {
      if (['background', 'black', 'cursorAccent', 'selectionBackground'].includes(name)) continue
      expect(contrast(color, theme.background), name).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('xterm lifts colors the remote app picks itself to the same minimum', () => {
    expect(TERMINAL_OPTIONS.minimumContrastRatio).toBeGreaterThanOrEqual(4.5)
  })

  it('the pane behind the terminal matches its background, so no seam shows', () => {
    expect(token('term-bg')).toEqual([theme.background])
  })
})
