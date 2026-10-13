import { describe, expect, it, vi } from 'vitest'
import { createInsightsSource, parseInsights, probeScript } from '../../server/insights.js'
import { RemoteUnreachableError } from '../../server/sessions.js'

const doc = (agents: unknown[]) => JSON.stringify({ v: 1, now: 0, agents })

describe('parseInsights', () => {
  it('keeps known fields and drops the rest', () => {
    const [a] = parseInsights(
      doc([
        {
          session: 'fix',
          agent: 'claude',
          state: 'waiting',
          waitingFor: 'permission prompt',
          title: 'Fix it',
          tasks: { done: 1, total: 2, current: 'Write' },
          artifacts: [{ label: 'PR', url: 'https://github.com/o/r/pull/1', at: 5, action: 'created' }],
          commits: 2,
          surprise: 'x',
        },
      ]),
    )
    expect(a).toEqual({
      session: 'fix',
      agent: 'claude',
      state: 'waiting',
      waitingFor: 'permission prompt',
      title: 'Fix it',
      tasks: { done: 1, total: 2, current: 'Write' },
      artifacts: [{ label: 'PR', url: 'https://github.com/o/r/pull/1', at: 5, first: 5, hits: 1, said: false, action: 'created' }],
      commits: 2,
    })
  })

  it('refuses artifact links that are not http(s), so a transcript cannot plant a script URL', () => {
    const [a] = parseInsights(
      doc([
        {
          session: 's',
          agent: 'claude',
          state: 'ready',
          artifacts: [
            { label: 'PR', url: 'javascript:alert(1)', at: 1 },
            { label: 'PR', url: 'https://ok.example/pull/2', at: 1 },
          ],
        },
      ]),
    )
    expect(a.artifacts.map((x) => x.url)).toEqual(['https://ok.example/pull/2'])
  })

  it('maps an unknown state to unknown and skips rows without a session or agent', () => {
    const rows = parseInsights(
      doc([
        { session: 'a', agent: 'claude', state: 'dancing' },
        { agent: 'claude', state: 'ready' },
        { session: 'b', agent: 'gemini', state: 'ready' },
      ]),
    )
    expect(rows).toEqual([{ session: 'a', agent: 'claude', state: 'unknown', artifacts: [], commits: 0 }])
  })

  it('throws on output that is not a probe document', () => {
    expect(() => parseInsights('Traceback (most recent call last):')).toThrow()
    expect(() => parseInsights('{"v":1}')).toThrow()
  })
})

describe('probeScript', () => {
  it('prepends the arguments as a JSON literal Python can read, whatever the pattern contains', () => {
    const script = probeScript('print(ARGS)', [{ label: 'CR', pattern: `a"b'''\\d+\n` }])
    const [first, rest] = [script.slice(0, script.indexOf('\n')), script.slice(script.indexOf('\n') + 1)]
    expect(first.startsWith('ARGS = __import__("json").loads(')).toBe(true)
    const literal = first.slice('ARGS = __import__("json").loads('.length, -1)
    expect(JSON.parse(JSON.parse(literal) as string)).toEqual({ artifacts: [{ label: 'CR', pattern: `a"b'''\\d+\n` }] })
    expect(rest).toBe('print(ARGS)')
  })
})

describe('createInsightsSource', () => {
  const ok = { stdout: doc([{ session: 's', agent: 'codex', state: 'ready' }]), stderr: '', exitCode: 0 }

  it('caches within the ttl and shares one probe between concurrent callers', async () => {
    const runner = vi.fn().mockResolvedValue(ok)
    const get = createInsightsSource(runner, 60_000)
    const [a, b] = await Promise.all([get(), get()])
    expect(a).toBe(b)
    await get()
    expect(runner).toHaveBeenCalledTimes(1)
    expect(a.agents[0].session).toBe('s')
  })

  it('reports ssh failure as unreachable and lets the next call retry', async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'ssh: connect to host dev port 22: timed out\n', exitCode: 255 })
      .mockResolvedValueOnce(ok)
    const get = createInsightsSource(runner, 60_000)
    await expect(get()).rejects.toBeInstanceOf(RemoteUnreachableError)
    await expect(get()).resolves.toMatchObject({ agents: [{ session: 's' }] })
  })

  it('names a missing python3 instead of calling the host unreachable', async () => {
    const get = createInsightsSource(vi.fn().mockResolvedValue({ stdout: '', stderr: 'bash: python3: command not found', exitCode: 127 }))
    await expect(get()).rejects.toThrow(/python3/)
    await expect(get()).rejects.not.toBeInstanceOf(RemoteUnreachableError)
  })
})
