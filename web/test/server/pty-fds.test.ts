import { readdirSync } from 'node:fs'
import { spawn } from 'node-pty'
import { expect, it } from 'vitest'

const open = () => readdirSync('/dev/fd').length

it('gives back every pseudo-terminal once a terminal ends, so a long-running server cannot use up the machine', async () => {
  const before = open()
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((done) => {
      const pty = spawn('/bin/echo', ['ok'], { cols: 80, rows: 24 })
      pty.onData(() => undefined)
      pty.onExit(() => done())
    })
  }
  await new Promise((r) => setTimeout(r, 200))
  expect(open() - before).toBeLessThan(3)
})
