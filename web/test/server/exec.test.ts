import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as exec from '../../server/exec.js'
import { isValidHost, isValidSessionName } from '../../src/shared/validate.js'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server')

describe('session name validation', () => {
  it.each(['api', 'cc-dotfiles', 'main', 'a_b-1', 'A1', 'x'.repeat(64)])('accepts %s', (name) => {
    expect(isValidSessionName(name)).toBe(true)
  })

  it.each(['', '-x', '.', '..', 'a b', 'a;rm', 'a/b', 'a.b', 'api - ~/work/api', '$(x)', 'x'.repeat(65)])(
    'rejects %j',
    (name) => {
      expect(isValidSessionName(name)).toBe(false)
    },
  )
})

describe('host validation', () => {
  it.each(['stub-host', 'dev', 'me@host.example', 'host.example:22', 'h_1'])('accepts %s', (host) => {
    expect(isValidHost(host)).toBe(true)
  })

  it.each(['', '-oProxyCommand=evil', '-h', ' host', 'host name'])('rejects %j', (host) => {
    expect(isValidHost(host)).toBe(false)
  })
})

describe('run result mapping', () => {
  const stubs = path.resolve(serverDir, '../test/stubs')

  it('maps a timed-out devbox to a nonzero exit instead of rejecting', async () => {
    process.env.DEVBOX_STUB_MODE = 'hang'
    try {
      const res = await exec.statusRaw(stubs, 150)
      expect(res.exitCode).toBe(124)
      expect(res.stderr).toContain('timed out')
    } finally {
      delete process.env.DEVBOX_STUB_MODE
    }
  })

  it('rejects when devbox dies from a signal that was not the timeout kill', async () => {
    process.env.DEVBOX_STUB_MODE = 'crash'
    try {
      await expect(exec.statusRaw(stubs, 5000)).rejects.toThrow()
    } finally {
      delete process.env.DEVBOX_STUB_MODE
    }
  })

  it('passes a nonzero exit code through', async () => {
    process.env.DEVBOX_STUB_MODE = 'unreachable'
    try {
      const res = await exec.statusRaw(stubs, 1000)
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain('cannot reach')
    } finally {
      delete process.env.DEVBOX_STUB_MODE
    }
  })
})

describe('spawn site discipline', () => {
  it('exports only the allowlisted constructors', () => {
    expect(Object.keys(exec).sort()).toEqual(['attachArgv', 'printConfig', 'spawnAttachPty', 'statusRaw'])
  })

  it('exec.ts is the only server module touching child_process or node-pty', () => {
    for (const file of readdirSync(serverDir)) {
      if (!file.endsWith('.ts')) continue
      const source = readFileSync(path.join(serverDir, file), 'utf8')
      if (file === 'exec.ts') {
        expect(source).toContain('child_process')
        expect(source).toContain('node-pty')
      } else {
        expect(source, `${file} must not spawn processes`).not.toContain('child_process')
        expect(source, `${file} must not spawn ptys`).not.toContain('node-pty')
      }
    }
  })

  it('builds the frozen attach argv with keepalives and exact-match quoting', () => {
    expect(exec.attachArgv('stub-host', 'api')).toEqual([
      'ssh',
      '-t',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=2',
      '--',
      'stub-host',
      'env',
      'LANG=C.UTF-8',
      'tmux',
      'attach-session',
      '-t',
      "'=api'",
    ])
  })
})
