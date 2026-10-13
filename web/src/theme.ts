import type { ITerminalOptions } from '@xterm/xterm'
import type { GhosttyLook, Palette } from './shared/types'

export const TERMINAL_OPTIONS = {
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  scrollback: 5000,
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
}

type TerminalLook = Pick<ITerminalOptions, 'theme' | 'fontFamily' | 'fontSize' | 'cursorStyle' | 'cursorBlink'>

const STORE = 'devbox.look'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const TOKENS = [
  '--bg', '--surface', '--raised', '--selected', '--text', '--dim', '--accent', '--bell', '--border', '--control',
  '--term-bg', '--bell-bg', '--danger', '--on-accent', '--on-bell', '--on-danger', '--mono',
]
const ANSI = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const

function palette(background: string, foreground: string, selectionBackground: string, cursor: string, ansi: string): Palette {
  return { background, foreground, selectionBackground, cursor, ansi: ansi.split(' ') }
}

export const DEVBOX: Look = { id: 'devbox', label: 'Devbox' }
export const PRESETS: Look[] = [
  DEVBOX,
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    palette: palette('#1e1e2e', '#cdd6f4', '#585b70', '#f5e0dc', '#45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #a6adc8 #585b70 #f37799 #89d88b #ebd391 #74a8fc #f2aede #6bd7ca #bac2de'),
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    palette: palette('#1a1b26', '#c0caf5', '#33467c', '#c0caf5', '#15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #c0caf5'),
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    palette: palette('#282828', '#ebdbb2', '#665c54', '#ebdbb2', '#282828 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #a89984 #928374 #fb4934 #b8bb26 #fabd2f #83a598 #d3869b #8ec07c #ebdbb2'),
  },
  {
    id: 'dracula',
    label: 'Dracula',
    palette: palette('#282a36', '#f8f8f2', '#44475a', '#f8f8f2', '#21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff'),
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    palette: palette('#ffffff', '#1f2328', '#c8d6ea', '#0969da', '#24292f #cf222e #116329 #4d2d00 #0969da #8250df #1b7c83 #6e7781 #57606a #a40e26 #1a7f37 #633c01 #218bff #a475f9 #3192aa #8c959f'),
  },
]

export function ghosttyLook(g: GhosttyLook): Look {
  return {
    id: 'ghostty',
    label: `Ghostty · ${g.light ? `${g.dark.name} / ${g.light.name}` : g.dark.name}`,
    palette: g.dark.palette,
    lightPalette: g.light?.palette,
    fontFamily: g.fontFamily,
    fontSize: g.fontSize,
    cursorStyle: g.cursorStyle,
    cursorBlink: g.cursorBlink,
  }
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

export function uiTokens(p: Palette): Record<string, string> {
  const dark = isDark(p)
  const [bg, fg, edge] = [p.background, p.foreground, dark ? '#ffffff' : '#000000']
  const surface = mix(bg, fg, 0.04)
  const raised = mix(bg, fg, 0.1)
  const selected = mix(bg, p.ansi[4], 0.2)
  const bellBg = mix(bg, p.ansi[3], 0.2)
  const surfaces = [bg, surface, raised, selected]
  const text = (color: string, extra: string[] = []) => readable(color, [...surfaces, ...extra], 4.6, edge)
  return {
    '--bg': bg,
    '--surface': surface,
    '--raised': raised,
    '--selected': selected,
    '--text': text(fg),
    '--dim': text(mix(fg, bg, 0.3)),
    '--accent': text(p.ansi[dark ? 12 : 4]),
    '--bell': text(p.ansi[dark ? 11 : 3], [bellBg]),
    '--danger': text(p.ansi[dark ? 9 : 1]),
    '--border': mix(bg, fg, 0.16),
    '--control': readable(mix(bg, fg, 0.4), [bg, surface], 3.1, edge),
    '--term-bg': bg,
    '--bell-bg': bellBg,
    '--on-accent': bg,
    '--on-bell': bg,
    '--on-danger': bg,
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

export function applyLook(look: Look, preferLight: boolean): void {
  const p = (preferLight && look.lightPalette) || look.palette
  const tokens: Record<string, string> = p ? uiTokens(p) : {}
  const font = fontStack(look.fontFamily)
  if (font) tokens['--mono'] = font
  const root = document.documentElement.style
  for (const name of TOKENS) {
    if (tokens[name]) root.setProperty(name, tokens[name])
    else root.removeProperty(name)
  }
  root.colorScheme = p ? (isDark(p) ? 'dark' : 'light') : ''
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', p?.background ?? TERMINAL_OPTIONS.theme.background)
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
  }
  for (const listener of listeners) listener()
}

export function savedLook(): Look | null {
  try {
    const look = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Look | null
    return look && typeof look.id === 'string' ? look : null
  } catch {
    return null
  }
}

export function saveLook(look: Look): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(look))
  } catch {
    void 0
  }
}

export function prefersLight(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches
}
