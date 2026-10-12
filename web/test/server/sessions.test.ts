import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionSource, parseStatusRaw, RemoteUnreachableError } from '../../server/sessions.js'
import type { RunResult } from '../../server/exec.js'

const fixture = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/status-raw.txt'),
  'utf8',
)

const ok = (stdout: string): RunResult => ({ stdout, stderr: '', exitCode: 0 })

describe('parseStatusRaw', () => {
  it('parses the shared fixture into typed rows', () => {
    const rows = parseStatusRaw(fixture)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual({
      name: 'main',
      attached: false,
      clients: 0,
      activityEpoch: 1791700000,
      bell: false,
      cmd: 'zsh',
      path: '/home/me',
      attachable: true,
    })
    expect(rows[1]).toMatchObject({ name: 'cc-atx', attached: true, clients: 2, bell: true, cmd: 'claude' })
    expect(rows[2]).toMatchObject({ name: 'api - ~/work/api', attachable: false, attached: true, clients: 1 })
    expect(rows[3]).toMatchObject({ name: 'logs', path: '/home/me/logs|archive' })
  })

  it('rejoins a path containing pipes instead of dropping fields', () => {
    const rows = parseStatusRaw('x|1|5|0|zsh|/home/me/a|b')
    expect(rows[0].path).toBe('/home/me/a|b')
  })

  it('maps "No sessions." and blank output to an empty list', () => {
    expect(parseStatusRaw('No sessions.\n')).toEqual([])
    expect(parseStatusRaw('')).toEqual([])
  })

  it('skips malformed lines', () => {
    expect(parseStatusRaw('garbage\nx|1|5|0|zsh|/p')).toHaveLength(1)
  })
})

describe('createSessionSource', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces concurrent callers into one probe', async () => {
    let calls = 0
    const get = createSessionSource('stub-host', async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return ok(fixture)
    })
    const [a, b] = await Promise.all([get(), get()])
    expect(calls).toBe(1)
    expect(a).toBe(b)
    expect(a.host).toBe('stub-host')
    expect(a.sessions).toHaveLength(4)
  })

  it('serves from cache inside the TTL and refetches after it', async () => {
    vi.useFakeTimers()
    let calls = 0
    const get = createSessionSource('stub-host', async () => {
      calls += 1
      return ok(fixture)
    })
    await get()
    await get()
    expect(calls).toBe(1)
    vi.advanceTimersByTime(3001)
    await get()
    expect(calls).toBe(2)
  })

  it('maps a nonzero exit to RemoteUnreachableError', async () => {
    const get = createSessionSource('stub-host', async () => ({
      stdout: '',
      stderr: 'devbox: cannot reach stub-host',
      exitCode: 1,
    }))
    await expect(get()).rejects.toBeInstanceOf(RemoteUnreachableError)
  })

  it('invalidate forces the next call to probe again', async () => {
    let calls = 0
    const get = createSessionSource('stub-host', async () => {
      calls += 1
      return ok(fixture)
    })
    await get()
    await get()
    expect(calls).toBe(1)
    get.invalidate()
    await get()
    expect(calls).toBe(2)
  })

  it('a probe started before invalidate does not repopulate the cache', async () => {
    let calls = 0
    let release: () => void = () => undefined
    const get = createSessionSource('stub-host', async () => {
      calls += 1
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve))
      return ok(fixture)
    })
    const stale = get()
    get.invalidate()
    release()
    await stale
    await get()
    expect(calls).toBe(2)
  })

  it('an invalidated probe settling does not orphan the newer in-flight probe', async () => {
    let calls = 0
    const releases: Array<() => void> = []
    const get = createSessionSource('stub-host', async () => {
      calls += 1
      await new Promise<void>((resolve) => releases.push(resolve))
      return ok(fixture)
    })
    const first = get()
    get.invalidate()
    const second = get()
    releases[0]()
    await first
    const third = get()
    expect(calls).toBe(2)
    releases[1]()
    await Promise.all([second, third])
    expect(calls).toBe(2)
  })

  it('recovers after a failed probe instead of caching the failure', async () => {
    let calls = 0
    const get = createSessionSource('stub-host', async () => {
      calls += 1
      if (calls === 1) return { stdout: '', stderr: 'down', exitCode: 1 }
      return ok(fixture)
    })
    await expect(get()).rejects.toBeInstanceOf(RemoteUnreachableError)
    const second = await get()
    expect(second.sessions).toHaveLength(4)
  })
})
