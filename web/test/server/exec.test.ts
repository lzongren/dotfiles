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

describe('spawn site discipline', () => {
  it('exports only the allowlisted constructors', () => {
    expect(Object.keys(exec).sort()).toEqual(['printConfig', 'statusRaw'])
  })

  it('exec.ts is the only server module importing child_process', () => {
    for (const file of readdirSync(serverDir)) {
      if (!file.endsWith('.ts')) continue
      const source = readFileSync(path.join(serverDir, file), 'utf8')
      if (file === 'exec.ts') {
        expect(source).toContain('child_process')
      } else {
        expect(source, `${file} must not spawn processes`).not.toContain('child_process')
      }
    }
  })
})
