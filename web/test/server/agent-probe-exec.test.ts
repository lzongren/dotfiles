import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runAgentProbe } from '../../server/exec.js'

describe('runAgentProbe', () => {
  let bin: string
  const savedPath = process.env.PATH

  const fakeSsh = (body: string) => {
    writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\n${body}\n`)
    chmodSync(path.join(bin, 'ssh'), 0o755)
  }

  beforeAll(() => {
    bin = mkdtempSync(path.join(tmpdir(), 'devbox-ssh.'))
    process.env.PATH = `${bin}:${savedPath}`
  })

  afterAll(() => {
    process.env.PATH = savedPath
    rmSync(bin, { recursive: true, force: true })
  })

  it('pipes the script to the remote python and returns its output intact', async () => {
    fakeSsh(`cat >/dev/null; i=0; while [ $i -lt 40000 ]; do printf '…'; i=$((i+1)); done`)
    const res = await runAgentProbe('host', 'print(1)')
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe('…'.repeat(40000))
  })

  it('gives up at the timeout even while a leftover child still holds the pipe', async () => {
    fakeSsh('cat >/dev/null; sleep 30 & sleep 30')
    const started = Date.now()
    const res = await runAgentProbe('host', '', 300)
    expect(res).toMatchObject({ exitCode: 124, stderr: 'agent probe timed out' })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('stops reading past the output cap', async () => {
    fakeSsh('cat >/dev/null; head -c 5000000 /dev/zero')
    const res = await runAgentProbe('host', '')
    expect(res).toMatchObject({ exitCode: 124, stderr: 'agent probe output too large' })
  })
})
