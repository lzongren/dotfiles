import type { ITerminalOptions } from '@xterm/xterm'
import type { GhosttyLook, Palette } from './shared/types'

export const TERMINAL_OPTIONS = {
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  scrollback: 5000,
  macOptionClickForcesSelection: true,
  minimumContrastRatio: 4.5,
  theme: {
    background: '#0e1014',
    foreground: '#e6edf3',
    cursor: '#e6edf3',
    cursorAccent: '#0e1014',
    selectionBackground: '#2f4a7a',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#8b949e',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#ffffff',
  },
} satisfies ITerminalOptions

export interface Look {
  id: string
  label: string
  palette?: Palette
  lightPalette?: Palette
  fontFamily?: string[]
  fontSize?: number
  cursorStyle?: 'block' | 'bar' | 'underline'
  cursorBlink?: boolean
  minimumContrast?: number
  boldIsBright?: boolean
  thicken?: boolean
  cellHeight?: GhosttyLook['cellHeight']
  padding?: [number, number, number, number]
  gradient?: { dark: Stops; light: Stops }
}

type Stops = [string, string, string]

export interface Prefs {
  light: boolean
  more: boolean
}

type TerminalLook = Pick<
  ITerminalOptions,
  | 'theme'
  | 'fontFamily'
  | 'fontSize'
  | 'cursorStyle'
  | 'cursorBlink'
  | 'minimumContrastRatio'
  | 'drawBoldTextInBrightColors'
  | 'fontWeight'
  | 'fontWeightBold'
  | 'lineHeight'
>

const STORE = 'devbox.look'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const TOKENS = [
  '--bg', '--surface', '--tile', '--raised', '--selected', '--text', '--dim', '--accent', '--bell', '--border', '--control',
  '--term-bg', '--bell-bg', '--danger-bg', '--danger', '--on-accent', '--on-bell', '--on-danger', '--mono', '--term-pad',
  '--hl-keyword', '--hl-string', '--hl-number', '--hl-title', '--hl-type', '--hl-comment', '--hl-add', '--hl-del',
  '--grad-a', '--grad-b', '--grad-c',
]
const ANSI = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const

function palette(background: string, foreground: string, selectionBackground: string, cursor: string, ansi: string): Palette {
  return { background, foreground, selectionBackground, cursor, ansi: ansi.split(' ') }
}

const DARK_ANSI = '#3f3f46 #f87171 #4ade80 #facc15 #60a5fa #e879f9 #22d3ee #d4d4d8 #71717a #fca5a5 #86efac #fde047 #93c5fd #f0abfc #67e8f9 #fafafa'
const LIGHT_ANSI = '#18181b #dc2626 #16a34a #ca8a04 #2563eb #c026d3 #0891b2 #71717a #52525b #ef4444 #22c55e #eab308 #3b82f6 #d946ef #06b6d4 #a1a1aa'

function modern(id: string, label: string, dark: Stops, light: Stops, bg = '#09090b'): Look {
  return {
    id,
    label,
    gradient: { dark, light },
    palette: palette(bg, '#ededed', mix(bg, dark[1], 0.3), dark[1], DARK_ANSI),
    lightPalette: palette('#ffffff', '#18181b', mix('#ffffff', light[1], 0.2), light[1], LIGHT_ANSI),
    cursorStyle: 'bar',
    cursorBlink: true,
    padding: [8, 12, 8, 12],
  }
}

export const DEVBOX: Look = { id: 'devbox', label: 'Devbox' }
export const PRESETS: Look[] = [
  modern('sunset', 'Sunset', ['#fbbf24', '#f472b6', '#a78bfa'], ['#c2410c', '#db2777', '#7e22ce']),
  modern('aurora', 'Aurora', ['#4ade80', '#2dd4bf', '#38bdf8'], ['#15803d', '#0f766e', '#0369a1']),
  modern('iris', 'Iris', ['#60a5fa', '#818cf8', '#e879f9'], ['#1d4ed8', '#4f46e5', '#a21caf']),
  modern('mono', 'Mono', ['#e4e4e7', '#fafafa', '#d4d4d8'], ['#27272a', '#09090b', '#3f3f46'], '#000000'),
]

export function ghosttyLook(g: GhosttyLook): Look {
  return sane({
    id: 'ghostty',
    label: `Ghostty · ${g.light ? `${g.dark.name} / ${g.light.name}` : g.dark.name}`,
    palette: g.dark.palette,
    lightPalette: g.light?.palette,
    fontFamily: g.fontFamily,
    fontSize: g.fontSize,
    cursorStyle: g.cursorStyle,
    cursorBlink: g.cursorBlink ?? true,
    minimumContrast: g.minimumContrast,
    boldIsBright: g.boldIsBright,
    thicken: g.fontThicken,
    cellHeight: g.cellHeight,
    padding: g.padding,
  })
}

function cellLineHeight(cell: GhosttyLook['cellHeight'], fontSize: number): number | undefined {
  if (!cell) return undefined
  const extra = cell.unit === '%' ? cell.value / 100 : cell.value / (window.devicePixelRatio || 1) / (fontSize * 1.2)
  return Math.max(1, Math.round((1 + extra) * 1000) / 1000)
}

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
}

export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)]
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function readable(color: string, on: string[], min: number, toward: string): string {
  for (let t = 0; t <= 1; t += 0.05) {
    const c = mix(color, toward, t)
    if (on.every((s) => contrast(c, s) >= min)) return c
  }
  return toward
}

export function isDark(p: Palette): boolean {
  return luminance(p.background) < luminance(p.foreground)
}

export function uiTokens(p: Palette, more = false, stops?: Stops): Record<string, string> {
  const dark = isDark(p)
  const [edge, away] = dark ? ['#ffffff', '#000000'] : ['#000000', '#ffffff']
  const bg = readable(p.background, [edge], 7, away)
  const fg = p.foreground
  const surface = mix(bg, fg, 0.04)
  const tile = dark ? mix(bg, fg, 0.07) : mix(bg, '#ffffff', 0.7)
  const raised = mix(bg, fg, 0.1)
  const selected = mix(bg, stops?.[1] ?? p.ansi[4], dark ? 0.2 : 0.12)
  const bellBg = mix(bg, p.ansi[3], 0.2)
  const dangerBg = mix(bg, p.ansi[1], 0.16)
  const tints = [bellBg, dangerBg]
  const surfaces = [bg, surface, tile, raised, selected]
  const text = (color: string, extra: string[] = []) => readable(color, [...surfaces, ...extra], 4.6, edge)
  const code = (i: number) => readable(p.ansi[i], [p.background], 4.6, edge)
  const [a, b, c] = (stops ?? (dark ? [13, 12, 14] : [5, 4, 6]).map((i) => p.ansi[i])).map((s) => text(s))
  return {
    '--bg': bg,
    '--surface': surface,
    '--tile': tile,
    '--raised': raised,
    '--selected': selected,
    '--text': dark ? text(fg, tints) : readable(fg, [...surfaces, ...tints], 9, edge),
    '--dim': text(mix(fg, bg, more ? 0.15 : 0.3), tints),
    '--accent': b,
    '--grad-a': a,
    '--grad-b': b,
    '--grad-c': c,
    '--bell': text(p.ansi[dark ? 11 : 3], tints),
    '--danger': text(p.ansi[dark ? 9 : 1], tints),
    '--border': mix(bg, fg, more ? 0.35 : 0.16),
    '--control': readable(mix(bg, fg, more ? 0.6 : 0.4), [bg, surface], more ? 4.5 : 3.1, edge),
    '--term-bg': p.background,
    '--bell-bg': bellBg,
    '--danger-bg': dangerBg,
    '--on-accent': bg,
    '--on-bell': bg,
    '--on-danger': bg,
    '--hl-keyword': code(dark ? 13 : 5),
    '--hl-string': code(dark ? 10 : 2),
    '--hl-number': code(dark ? 11 : 3),
    '--hl-title': code(dark ? 12 : 4),
    '--hl-type': code(dark ? 14 : 6),
    '--hl-comment': readable(mix(fg, p.background, 0.4), [p.background], 4.6, edge),
    '--hl-add': code(dark ? 10 : 2),
    '--hl-del': code(dark ? 9 : 1),
  }
}

function fontStack(families: string[] | undefined): string | undefined {
  if (!families?.length) return undefined
  const names = families.flatMap((f) => [f, f.replace(/NerdFont(Mono|Propo)?$/, (_, v: string | undefined) => ` Nerd Font${v ? ` ${v}` : ''}`)])
  return [...new Set(names)].map((n) => `"${n.replace(/["\\]/g, '')}"`).concat(MONO).join(', ')
}

let current: TerminalLook = {}
const listeners = new Set<() => void>()

export function terminalLook(): TerminalLook {
  return current
}

export function onTerminalLook(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function applyLook(look: Look, prefs: Prefs = mediaPrefs()): void {
  const mode = prefs.light && look.lightPalette ? 'light' : 'dark'
  const p = mode === 'light' ? look.lightPalette : look.palette
  const tokens: Record<string, string> = p ? uiTokens(p, prefs.more, look.gradient?.[mode]) : {}
  const font = fontStack(look.fontFamily)
  if (font) tokens['--mono'] = font
  if (look.padding) tokens['--term-pad'] = look.padding.map((n) => `${n}px`).join(' ')
  const root = document.documentElement.style
  for (const name of TOKENS) {
    if (tokens[name]) root.setProperty(name, tokens[name])
    else root.removeProperty(name)
  }
  root.colorScheme = p ? (isDark(p) ? 'dark' : 'light') : ''
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tokens['--bg'] ?? TERMINAL_OPTIONS.theme.background)
  current = {
    theme: p
      ? {
          ...Object.fromEntries(ANSI.map((name, i) => [name, p.ansi[i]])),
          background: p.background,
          foreground: p.foreground,
          cursor: p.cursor ?? p.foreground,
          cursorAccent: p.cursorText ?? p.background,
          selectionBackground: p.selectionBackground ?? mix(p.background, p.foreground, 0.25),
          ...(p.selectionForeground ? { selectionForeground: p.selectionForeground } : {}),
        }
      : TERMINAL_OPTIONS.theme,
    fontFamily: font ?? TERMINAL_OPTIONS.fontFamily,
    fontSize: look.fontSize ?? TERMINAL_OPTIONS.fontSize,
    cursorStyle: look.cursorStyle ?? 'block',
    cursorBlink: look.cursorBlink ?? false,
    minimumContrastRatio: look.minimumContrast ?? TERMINAL_OPTIONS.minimumContrastRatio,
    drawBoldTextInBrightColors: look.boldIsBright ?? true,
    fontWeight: look.thicken ? 500 : 'normal',
    fontWeightBold: look.thicken ? 800 : 'bold',
    lineHeight: cellLineHeight(look.cellHeight, look.fontSize ?? TERMINAL_OPTIONS.fontSize) ?? 1,
  }
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      console.error(err)
    }
  }
}

const HEX = /^#[0-9a-f]{6}$/i

function validPalette(p: unknown): boolean {
  const q = p as Palette | undefined
  return (
    typeof q?.background === 'string' &&
    HEX.test(q.background) &&
    typeof q.foreground === 'string' &&
    HEX.test(q.foreground) &&
    Array.isArray(q.ansi) &&
    q.ansi.length === 16 &&
    q.ansi.every((c) => typeof c === 'string' && HEX.test(c))
  )
}

function sane(look: Look): Look {
  const clamp = (n: unknown, lo: number, hi: number): number | undefined =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined
  const flag = (v: unknown): v is boolean => typeof v === 'boolean'
  const { id, label, palette, lightPalette, fontFamily, fontSize, cursorStyle, cursorBlink } = look
  const { minimumContrast, boldIsBright, thicken, cellHeight, padding } = look
  const size = clamp(fontSize, 6, 72)
  const contrast = clamp(minimumContrast, 1, 21)
  const cell = clamp(cellHeight?.value, -100, 100)
  const families = Array.isArray(fontFamily) ? fontFamily.filter((f): f is string => typeof f === 'string').slice(0, 8) : []
  const pads = Array.isArray(padding) && padding.length === 4 ? padding.map((n) => clamp(n, 0, 200)) : []
  return {
    id,
    label: typeof label === 'string' ? label : 'Ghostty',
    ...(validPalette(palette) ? { palette } : {}),
    ...(lightPalette !== undefined && validPalette(lightPalette) ? { lightPalette } : {}),
    ...(families.length ? { fontFamily: families } : {}),
    ...(size !== undefined ? { fontSize: size } : {}),
    ...(cursorStyle === 'block' || cursorStyle === 'bar' || cursorStyle === 'underline' ? { cursorStyle } : {}),
    ...(flag(cursorBlink) ? { cursorBlink } : {}),
    ...(contrast !== undefined ? { minimumContrast: contrast } : {}),
    ...(flag(boldIsBright) ? { boldIsBright } : {}),
    ...(flag(thicken) ? { thicken } : {}),
    ...(cell !== undefined && (cellHeight?.unit === 'px' || cellHeight?.unit === '%') ? { cellHeight: { value: cell, unit: cellHeight.unit } } : {}),
    ...(pads.length === 4 && pads.every((n) => n !== undefined)
      ? { padding: pads.map((n) => Math.round(n!)) as [number, number, number, number] }
      : {}),
  }
}

export function savedLook(): Look | null {
  try {
    const look = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Look | null
    const preset = PRESETS.find((l) => l.id === look?.id)
    if (preset) return preset
    const ok = look?.id === 'ghostty' && validPalette(look.palette) && (look.lightPalette === undefined || validPalette(look.lightPalette))
    return ok ? sane(look) : null
  } catch {
    return null
  }
}

export function saveLook(look: Look | null): void {
  try {
    if (look) localStorage.setItem(STORE, JSON.stringify(look))
    else localStorage.removeItem(STORE)
  } catch {
    void 0
  }
}

export const MEDIA = ['(prefers-color-scheme: light)', '(prefers-contrast: more)']

export function mediaPrefs(): Prefs {
  const [light, more] = MEDIA.map((q) => typeof window.matchMedia === 'function' && window.matchMedia(q).matches)
  return { light, more }
}
