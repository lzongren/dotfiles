import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInsight, Artifact, Session } from '../../src/shared/types'
import {
  artifactName,
  changeMark,
  displayTitle,
  isFresh,
  laneOf,
  ledger,
  loadSeen,
  markSeen,
  modelName,
  projectOf,
  rankArtifacts,
} from '../../src/insights'

const NOW = 1_791_741_600_000
const sec = (ago: number) => Math.floor(NOW / 1000) - ago

const session = (over: Partial<Session> = {}): Session => ({
  name: 's',
  attached: false,
  clients: 0,
  activityEpoch: sec(60),
  bell: false,
  cmd: 'claude',
  title: '',
  path: '/home/me/work/s',
  attachable: true,
  ...over,
})

const agent = (over: Partial<AgentInsight> = {}): AgentInsight => ({
  session: 's',
  agent: 'claude',
  state: 'ready',
  artifacts: [],
  commits: 0,
  ...over,
})

const artifact = (url: string, over: Partial<Artifact> = {}): Artifact => ({
  label: 'CR',
  url,
  at: 1,
  first: 1,
  hits: 1,
  said: false,
  ...over,
})

describe('laneOf', () => {
  it('keeps an agent waiting on you blocked whatever you have seen', () => {
    expect(laneOf(session(), agent({ state: 'waiting', since: sec(9) }), sec(0), NOW)).toBe('blocked')
    expect(laneOf(session({ activityEpoch: sec(30 * 86400) }), agent({ state: 'waiting' }), sec(0), NOW)).toBe('blocked')
  })

  it('blocks on a new error until you have seen it', () => {
    const failed = agent({ state: 'error', since: sec(100) })
    expect(laneOf(session(), failed, sec(500), NOW)).toBe('blocked')
    expect(laneOf(session(), failed, sec(50), NOW)).toBe('recent')
  })

  it('offers a finished turn for review until you have seen it', () => {
    const done = agent({ state: 'ready', turnAt: sec(120) })
    expect(laneOf(session(), done, sec(600), NOW)).toBe('ready')
    expect(laneOf(session(), done, sec(60), NOW)).toBe('recent')
  })

  it('does not reopen a turn you saw when its away summary arrives later', () => {
    const done = agent({ state: 'ready', turnAt: sec(120), summaryAt: sec(10) })
    expect(isFresh(session(), done, sec(60))).toBe(false)
  })

  it('lists working agents on their own', () => {
    expect(laneOf(session(), agent({ state: 'working' }), sec(0), NOW)).toBe('working')
  })

  it('falls back to the bell when the probe could not tell what the agent is doing', () => {
    const rang = session({ bell: true, activityEpoch: sec(30) })
    expect(laneOf(rang, agent({ state: 'unknown', error: 'probe: boom' }), sec(60), NOW)).toBe('ready')
  })

  it('parks a week of inactivity, errors included', () => {
    const old = session({ activityEpoch: sec(8 * 86400) })
    expect(laneOf(old, undefined, 0, NOW)).toBe('parked')
    expect(laneOf(old, agent({ state: 'error', since: sec(8 * 86400) }), 0, NOW)).toBe('parked')
  })

  it('lets a ringing shell ask for review until you have seen it', () => {
    expect(laneOf(session({ cmd: 'zsh', bell: true, activityEpoch: sec(30) }), undefined, sec(60), NOW)).toBe('ready')
    expect(laneOf(session({ cmd: 'zsh', bell: true, activityEpoch: sec(30) }), undefined, sec(10), NOW)).toBe('recent')
    expect(laneOf(session({ cmd: 'zsh' }), undefined, 0, NOW)).toBe('recent')
  })
})

describe('changeMark', () => {
  it('prefers the end of the last turn, then the state change, then tmux activity', () => {
    expect(changeMark(session(), agent({ turnAt: 5, since: 7 }))).toBe(5)
    expect(changeMark(session(), agent({ since: 7 }))).toBe(7)
    expect(changeMark(session({ activityEpoch: 9 }), undefined)).toBe(9)
  })
})

describe('seen store', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('starts a first visit with the last 12 hours unseen, not your whole history', () => {
    expect(loadSeen(NOW).seenAt('anything')).toBe(sec(12 * 3600))
    expect(loadSeen(NOW + 3_600_000).seenAt('anything')).toBe(sec(12 * 3600))
  })

  it('stores the host-side mark of what you saw and never moves it back', () => {
    markSeen(['fix'], () => 500, NOW)
    markSeen(['fix'], () => 400, NOW)
    expect(loadSeen(NOW).seenAt('fix')).toBe(500)
  })

  it('survives a corrupt store', () => {
    localStorage.setItem('devbox.seen', '{not json')
    expect(loadSeen(NOW).seenAt('x')).toBe(sec(12 * 3600))
  })

  it('keeps working in memory when storage refuses writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(() => loadSeen(NOW)).not.toThrow()
    markSeen(['fix'], () => 700, NOW)
    expect(loadSeen(NOW).seenAt('fix')).toBe(700)
  })
})

describe('labels', () => {
  it('groups by the first folder under home, or home itself', () => {
    expect(projectOf('/local/home/me/work/1010_Release')).toBe('work')
    expect(projectOf('/home/me/visa/NIW')).toBe('visa')
    expect(projectOf('/Users/me/code/app')).toBe('code')
    expect(projectOf('/home/me')).toBe('~')
    expect(projectOf('/srv/data/x')).toBe('/srv')
  })

  it('names artifacts by what they are', () => {
    expect(artifactName({ label: 'PR', url: 'https://github.com/o/r/pull/31' })).toBe('PR #31')
    expect(artifactName({ label: 'CR', url: 'https://code.example.com/reviews/CR-42' })).toBe('CR-42')
    expect(artifactName({ label: 'MR', url: 'https://git.example.com/g/p/-/merge_requests/7' })).toBe('MR 7')
  })

  it('ranks what the summary names, then what someone said, then how often it came up', () => {
    const ranked = rankArtifacts(
      [
        artifact('https://r.example/CR-1', { hits: 9 }),
        artifact('https://r.example/CR-2', { said: true }),
        artifact('https://r.example/CR-3', { said: true, hits: 4 }),
        artifact('https://r.example/CR-4'),
      ],
      'Next, publish CR-4 once CR-2 is approved.',
    )
    expect(ranked.map((r) => [artifactName(r), r.key])).toEqual([
      ['CR-2', true],
      ['CR-4', true],
      ['CR-3', false],
      ['CR-1', false],
    ])
    expect(rankArtifacts([artifact('https://github.com/o/r/pull/31')], 'Fix is up as PR 31.')[0].key).toBe(true)
    expect(rankArtifacts([artifact('https://github.com/o/r/pull/31')], 'see #310')[0].key).toBe(false)
  })

  it('builds the ledger from what someone said, newest first, a few per session', () => {
    const many = [1, 2, 3, 4].map((n) => artifact(`https://r.example/CR-${n}`, { said: true, first: n * 10 }))
    const items = ledger(
      [
        { name: 'chatty', artifacts: many },
        {
          name: 'other',
          artifacts: [artifact('https://r.example/CR-9', { said: true, first: 35 }), artifact('https://r.example/CR-8', { first: 99 })],
        },
      ],
      4,
    )
    expect(items.map((a) => `${a.session}:${artifactName(a)}`)).toEqual(['chatty:CR-4', 'other:CR-9', 'chatty:CR-3', 'chatty:CR-2'])
  })

  it('titles a session by the agent title, then the pane title, then what you first asked', () => {
    expect(displayTitle('Pane', agent({ title: 'Agent title' }))).toBe('Agent title')
    expect(displayTitle('Pane', agent({}))).toBe('Pane')
    expect(displayTitle('', agent({ firstAsk: '/goal Ship the eval dashboard' }))).toBe('Ship the eval dashboard')
    expect(displayTitle('', agent({ firstAsk: '/effort', ask: 'Fix the login' }))).toBe('Fix the login')
    expect(displayTitle('', agent({ ask: 'x'.repeat(100) }))).toHaveLength(80)
    expect(displayTitle('', undefined)).toBe('')
  })

  it('shortens model ids', () => {
    expect(modelName('claude-opus-4-1-20250805')).toBe('opus-4-1')
    expect(modelName('gpt-codex-x')).toBe('gpt-codex-x')
  })
})
