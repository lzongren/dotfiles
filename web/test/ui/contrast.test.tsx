import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PRESETS, TERMINAL_OPTIONS, uiTokens } from '../../src/theme'
import type { Palette } from '../../src/shared/types'

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

  it.each(['text', 'dim', 'accent', 'bell', 'danger', 'grad-a', 'grad-b', 'grad-c'])('--%s text is at least 4.5:1 on every surface', (fg) => {
    for (const surface of ['bg', 'surface', 'tile', 'raised', 'selected', 'term-bg']) {
      expect(worst(fg, surface), `--${fg} on --${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(['hl-keyword', 'hl-string', 'hl-number', 'hl-title', 'hl-type', 'hl-comment', 'hl-add', 'hl-del'])(
    '--%s code color is at least 4.5:1 on the code background',
    (fg) => {
      expect(worst(fg, 'term-bg')).toBeGreaterThanOrEqual(4.5)
    },
  )

  it('control borders are at least 3:1 against what they sit on', () => {
    for (const surface of ['bg', 'surface', 'term-bg']) {
      expect(worst('control', surface), `--control on --${surface}`).toBeGreaterThanOrEqual(3)
    }
  })

  it.each([
    ['on-accent', 'accent'],
    ['on-accent', 'grad-a'],
    ['on-accent', 'grad-b'],
    ['on-accent', 'grad-c'],
    ['on-bell', 'bell'],
    ['on-danger', 'danger'],
  ])('--%s text is at least 4.5:1 on its --%s chip', (fg, bg) => {
    expect(worst(fg, bg)).toBeGreaterThanOrEqual(4.5)
  })

  it.each([
    ['bell-bg', ['text', 'dim', 'bell']],
    ['danger-bg', ['text', 'dim', 'danger']],
  ])('rows and banners tinted --%s keep their text readable', (bg, fgs) => {
    for (const fg of fgs) expect(worst(fg, bg), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5)
  })

  it('the working mark is at least 3:1 wherever it shows', () => {
    for (const surface of ['bg', 'surface', 'tile', 'selected']) expect(worst('hl-type', surface), surface).toBeGreaterThanOrEqual(3)
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

const LATTE: Palette = {
  background: '#eff1f5',
  foreground: '#4c4f69',
  ansi: '#5c5f77 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #acb0be #6c6f85 #de293e #49af3d #eea02d #456eff #fe85d8 #2d9fa8 #bcc0cc'.split(' '),
}
const MUDDY: Palette = { background: '#555555', foreground: '#777777', ansi: Array(16).fill('#666666') }
const MID_LIGHT_TEXT: Palette = { background: '#767676', foreground: '#ffffff', ansi: Array(16).fill('#9a9a9a') }
const MID_DARK_TEXT: Palette = { background: '#808080', foreground: '#000000', ansi: Array(16).fill('#606060') }

type Stops = Parameters<typeof uiTokens>[2]
const CASES: [string, Palette, Stops][] = [
  ...PRESETS.flatMap((l): [string, Palette, Stops][] => [
    [`${l.label} dark`, l.palette!, l.gradient!.dark],
    [`${l.label} light`, l.lightPalette!, l.gradient!.light],
  ]),
  ['Catppuccin Latte', LATTE, undefined],
  ['a low-contrast palette', MUDDY, undefined],
  ['a mid-grey background with white text', MID_LIGHT_TEXT, undefined],
  ['a mid-grey background with black text', MID_DARK_TEXT, undefined],
]

describe.each(
  CASES.flatMap(([name, palette, stops]) => [[name, palette, stops, false] as const, [`${name}, more contrast`, palette, stops, true] as const]),
)('theme derived from %s (WCAG AA)', (_, palette, stops, more) => {
  const t = uiTokens(palette, more, stops)
  it('keeps every text token at least 4.5:1 on every surface', () => {
    for (const fg of ['--text', '--dim', '--accent', '--bell', '--danger', '--grad-a', '--grad-b', '--grad-c']) {
      for (const bg of ['--bg', '--surface', '--tile', '--raised', '--selected']) {
        expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    for (const [bg, fgs] of [['--bell-bg', ['--text', '--dim', '--bell']], ['--danger-bg', ['--text', '--dim', '--danger']]] as const) {
      for (const fg of fgs) expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the working mark at least 3:1 wherever it shows', () => {
    for (const bg of ['--bg', '--surface', '--tile', '--selected']) expect(contrast(t['--hl-type'], t[bg]), bg).toBeGreaterThanOrEqual(3)
  })

  it('keeps every code highlight color at least 4.5:1 on the code background', () => {
    for (const fg of ['--hl-keyword', '--hl-string', '--hl-number', '--hl-title', '--hl-type', '--hl-comment', '--hl-add', '--hl-del']) {
      expect(contrast(t[fg], palette.background), fg).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps chip text and control borders readable', () => {
    for (const [fg, bg] of [
      ['--on-accent', '--accent'],
      ['--on-accent', '--grad-a'],
      ['--on-accent', '--grad-b'],
      ['--on-accent', '--grad-c'],
      ['--on-bell', '--bell'],
      ['--on-danger', '--danger'],
    ]) {
      expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(t['--control'], t['--bg'])).toBeGreaterThanOrEqual(more ? 4.5 : 3)
    expect(contrast(t['--control'], t['--surface'])).toBeGreaterThanOrEqual(more ? 4.5 : 3)
  })
})
