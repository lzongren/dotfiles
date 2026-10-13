import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readGhostty } from '../../server/ghostty.js'

const ansi = (seed: string) => Array.from({ length: 16 }, (_, i) => `palette = ${i}=#${seed}${i.toString(16).padStart(2, '0')}${seed}`).join('\n')

let home: string
const write = (rel: string, text: string) => {
  const file = path.join(home, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'ghostty-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('readGhostty', () => {
  it('resolves a light/dark theme pair, applies config overrides, and reads font and cursor', async () => {
    write('.config/ghostty/themes/Test Night', `${ansi('11')}\nbackground = #101010\nforeground = c0c0c0\ncursor-color = #ff00ff\n`)
    write('.config/ghostty/themes/Test Day', `${ansi('ee')}\nbackground = #fafafa\nforeground = #202020\n`)
    write(
      '.config/ghostty/config',
      [
        '# comment',
        'theme = light:Test Day,dark:Test Night',
        'font-family = "Fancy Mono"',
        'font-family = Fallback Mono',
        'font-size = 14',
        'cursor-style = bar',
        'cursor-style-blink = true',
        'palette = 1=#abcdef',
        'background-opacity = 0.9',
        'font-thicken = true',
        'adjust-cell-height = 2',
        'window-padding-x = 10',
        'window-padding-y = 8',
      ].join('\n'),
    )
    const look = await readGhostty({}, home)
    expect(look).toMatchObject({
      dark: { name: 'Test Night', palette: { background: '#101010', foreground: '#c0c0c0', cursor: '#ff00ff' } },
      light: { name: 'Test Day', palette: { background: '#fafafa', foreground: '#202020' } },
      fontFamily: ['Fancy Mono', 'Fallback Mono'],
      fontSize: 14,
      cursorStyle: 'bar',
      cursorBlink: true,
      minimumContrast: 1,
      boldIsBright: false,
      fontThicken: true,
      cellHeight: { value: 2, unit: 'px' },
      padding: [8, 10, 8, 10],
    })
    expect(look!.dark.palette.ansi).toHaveLength(16)
    expect(look!.dark.palette.ansi[1]).toBe('#abcdef')
    expect(look!.light!.palette.ansi[1]).toBe('#abcdef')
  })

  it('finds a theme in the resources dir Ghostty exports to its shells', async () => {
    write('res/themes/Shipped', `${ansi('22')}\nbackground = #000000\nforeground = #ffffff\n`)
    write('.config/ghostty/config', 'theme = Shipped\n')
    const look = await readGhostty({ GHOSTTY_RESOURCES_DIR: path.join(home, 'res') }, home)
    expect(look?.dark.name).toBe('Shipped')
    expect(look?.light).toBeUndefined()
  })

  it('uses colors written in the config when there is no theme', async () => {
    write('Library/Application Support/com.mitchellh.ghostty/config', `${ansi('33')}\nbackground = #111111\nforeground = #eeeeee\n`)
    expect((await readGhostty({}, home))?.dark.palette.background).toBe('#111111')
  })

  it('follows config-file includes, and keeps the light half when the dark one is missing', async () => {
    write('.config/ghostty/themes/Only Day', `${ansi('44')}\nbackground = #fdfdfd\nforeground = #101010\n`)
    write('.config/ghostty/config', 'config-file = ?extra/look.conf\nconfig-file = ?missing.conf\n')
    write('.config/ghostty/extra/look.conf', 'theme = light:Only Day,dark:Gone Night\nfont-size = 15\n')
    const look = await readGhostty({}, home)
    expect(look).toMatchObject({ dark: { name: 'Only Day' }, fontSize: 15 })
    expect(look?.light).toBeUndefined()
  })

  it("uses Ghostty's defaults for unset drawing options and reads every padding form", async () => {
    write('.config/ghostty/themes/Plain', `${ansi('55')}\nbackground = #000000\nforeground = #ffffff\n`)
    write('.config/ghostty/config', 'theme = Plain\n')
    expect(await readGhostty({}, home)).toMatchObject({ minimumContrast: 1, boldIsBright: false, fontThicken: false, padding: [2, 2, 2, 2] })
    expect((await readGhostty({}, home))?.cellHeight).toBeUndefined()
    write(
      '.config/ghostty/config',
      'theme = Plain\nwindow-padding-x = 4,20\nwindow-padding-y = -3\nadjust-cell-height = 15%\nminimum-contrast = 99\nfont-size = 13.5\n',
    )
    expect(await readGhostty({}, home)).toMatchObject({
      padding: [0, 20, 0, 4],
      cellHeight: { value: 15, unit: '%' },
      minimumContrast: 21,
      fontSize: 13.5,
    })
  })

  it('returns null without a config, or with a theme it cannot find', async () => {
    expect(await readGhostty({}, home)).toBeNull()
    write('.config/ghostty/config', 'theme = No Such Theme\n')
    expect(await readGhostty({}, home)).toBeNull()
  })
})
