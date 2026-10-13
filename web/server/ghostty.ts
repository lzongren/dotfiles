import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GhosttyLook, Palette } from '../src/shared/types.js'

type Entries = Array<[string, string]>

const COLORS: Record<string, Exclude<keyof Palette, 'ansi'>> = {
  background: 'background',
  foreground: 'foreground',
  'cursor-color': 'cursor',
  'cursor-text': 'cursorText',
  'selection-background': 'selectionBackground',
  'selection-foreground': 'selectionForeground',
}

export function parseGhostty(text: string): Entries {
  const out: Entries = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const eq = line.indexOf('=')
    if (line.startsWith('#') || eq < 0) continue
    out.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')])
  }
  return out
}

function hex(value: string): string | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim())
  return m ? `#${m[1].toLowerCase()}` : undefined
}

function paint(palette: Partial<Palette> & { ansi: string[] }, entries: Entries): void {
  for (const [key, value] of entries) {
    const slot = key === 'palette' ? /^(\d+)\s*=(.*)$/.exec(value) : null
    if (slot && Number(slot[1]) < 16) palette.ansi[Number(slot[1])] = hex(slot[2]) ?? palette.ansi[Number(slot[1])]
    else if (COLORS[key]) palette[COLORS[key]] = hex(value) ?? palette[COLORS[key]]
  }
}

async function readConfig(file: string, home: string, seen: Set<string>): Promise<Entries> {
  if (seen.has(file) || seen.size > 16) return []
  seen.add(file)
  const own = parseGhostty(await readFile(file, 'utf8').catch(() => ''))
  const out = own.filter(([key]) => key !== 'config-file')
  for (const [key, value] of own) {
    if (key !== 'config-file' || !value) continue
    const target = value.replace(/^\?/, '').replace(/^~(?=\/)/, home)
    out.push(...(await readConfig(path.resolve(path.dirname(file), target), home, seen)))
  }
  return out
}

async function readFirst(files: string[]): Promise<string | null> {
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text !== null) return text
  }
  return null
}

export async function readGhostty(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<GhosttyLook | null> {
  const configDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'ghostty')
  const macDir = path.join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty')
  const seen = new Set<string>()
  const entries: Entries = []
  for (const dir of [configDir, macDir]) {
    for (const name of ['config', 'config.ghostty']) entries.push(...(await readConfig(path.join(dir, name), home, seen)))
  }
  const last = (key: string) => entries.filter(([k]) => k === key).pop()?.[1]
  const theme = last('theme')
  const names: Record<string, string> = {}
  for (const part of (theme ?? '').split(',')) {
    const m = /^\s*(?:(light|dark):)?(.*)$/.exec(part)!
    if (m[2].trim()) names[m[1] ?? 'any'] = m[2].trim()
  }
  const dirs = [
    path.join(configDir, 'themes'),
    ...(env.GHOSTTY_RESOURCES_DIR ? [path.join(env.GHOSTTY_RESOURCES_DIR, 'themes')] : []),
    '/Applications/Ghostty.app/Contents/Resources/ghostty/themes',
    '/usr/share/ghostty/themes',
    '/usr/local/share/ghostty/themes',
  ]
  const load = async (name: string | undefined) => {
    const palette: Partial<Palette> & { ansi: string[] } = { ansi: [] }
    if (name) {
      const text = await readFirst(path.isAbsolute(name) ? [name] : dirs.map((d) => path.join(d, name)))
      if (text === null) return undefined
      paint(palette, parseGhostty(text))
    }
    paint(palette, entries)
    const full = palette.background && palette.foreground && palette.ansi.filter(Boolean).length === 16
    return full ? { name: name ?? 'custom', palette: palette as Palette } : undefined
  }
  const dark = (await load(names.dark ?? names.any ?? names.light)) ?? (names.light ? await load(names.light) : undefined)
  if (!dark) return null
  const lightName = names.light ?? names.any
  const light = lightName && lightName !== dark.name ? await load(lightName) : undefined
  const families: string[] = []
  for (const [key, value] of entries) {
    if (key !== 'font-family') continue
    if (value === '') families.splice(0)
    else families.push(value)
  }
  const size = Number(last('font-size'))
  const num = (key: string, fallback: number) => {
    const n = parseFloat(last(key) ?? '')
    return Number.isFinite(n) ? n : fallback
  }
  const cursor = last('cursor-style')?.replace(/_hollow$/, '')
  return {
    dark,
    ...(light ? { light } : {}),
    ...(families.length ? { fontFamily: [...new Set(families)] } : {}),
    ...(size > 0 ? { fontSize: size } : {}),
    ...(cursor === 'block' || cursor === 'bar' || cursor === 'underline' ? { cursorStyle: cursor } : {}),
    ...(last('cursor-style-blink') ? { cursorBlink: last('cursor-style-blink') === 'true' } : {}),
    minimumContrast: num('minimum-contrast', 1),
    boldIsBright: last('bold-is-bright') === 'true',
    fontThicken: last('font-thicken') === 'true',
    ...(last('adjust-cell-height') ? { cellHeight: last('adjust-cell-height') } : {}),
    padding: [num('window-padding-x', 2), num('window-padding-y', 2)],
  }
}
