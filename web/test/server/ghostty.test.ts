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

  it('returns null without a config, or with a theme it cannot find', async () => {
    expect(await readGhostty({}, home)).toBeNull()
    write('.config/ghostty/config', 'theme = No Such Theme\n')
    expect(await readGhostty({}, home)).toBeNull()
  })
})
