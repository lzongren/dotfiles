import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentInsight, Session } from '../../src/shared/types'
import {
  artifactName,
  displayTitle,
  laneOf,
  loadSeen,
  markSeen,
  modelName,
  projectOf,
  rankArtifacts,
  unread,
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

describe('laneOf', () => {
  it('puts a waiting or failed agent in front of you whatever you have seen', () => {
    expect(laneOf(session(), agent({ state: 'waiting' }), sec(0), NOW)).toBe('needs')
    expect(laneOf(session(), agent({ state: 'error' }), sec(0), NOW)).toBe('needs')
  })

  it('treats a finished turn you have not looked at as needing you, and a seen one as recent', () => {
    const done = agent({ state: 'ready', summaryAt: sec(120) })
    expect(laneOf(session(), done, sec(600), NOW)).toBe('needs')
    expect(laneOf(session(), done, sec(60), NOW)).toBe('recent')
  })

  it('lists working agents on their own', () => {
    expect(laneOf(session(), agent({ state: 'working' }), sec(0), NOW)).toBe('working')
  })

  it('parks anything idle for a week unless it needs you', () => {
    const old = session({ activityEpoch: sec(8 * 86400) })
    expect(laneOf(old, undefined, 0, NOW)).toBe('parked')
    expect(laneOf(old, agent({ state: 'ready', summaryAt: sec(8 * 86400) }), sec(7 * 86400), NOW)).toBe('parked')
    expect(laneOf(old, agent({ state: 'waiting' }), 0, NOW)).toBe('needs')
  })

  it('lets a ringing shell ask for attention too', () => {
    expect(laneOf(session({ cmd: 'zsh', bell: true }), undefined, 0, NOW)).toBe('needs')
    expect(laneOf(session({ cmd: 'zsh' }), undefined, 0, NOW)).toBe('recent')
  })
})

describe('unread', () => {
  it('compares the latest summary, or the state change, with when you last looked', () => {
    expect(unread(agent({ summaryAt: sec(10) }), sec(20))).toBe(true)
    expect(unread(agent({ summaryAt: sec(30) }), sec(20))).toBe(false)
    expect(unread(agent({ since: sec(10) }), sec(20))).toBe(true)
    expect(unread(agent({}), sec(20))).toBe(false)
  })
})

describe('seen store', () => {
  beforeEach(() => localStorage.clear())

  it('starts a first visit with the last 12 hours unread, not your whole history', () => {
    const seen = loadSeen(NOW)
    expect(seen.seenAt('anything')).toBe(sec(12 * 3600))
    expect(loadSeen(NOW + 3_600_000).seenAt('anything')).toBe(sec(12 * 3600))
  })

  it('remembers per session across reloads', () => {
    markSeen('fix', NOW)
    expect(loadSeen(NOW).seenAt('fix')).toBe(Math.floor(NOW / 1000))
  })

  it('survives a corrupt store', () => {
    localStorage.setItem('devbox.seen', '{not json')
    expect(loadSeen(NOW).seenAt('x')).toBe(sec(12 * 3600))
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
    const a = (url: string, over: Partial<{ said: boolean; hits: number; at: number }> = {}) => ({
      label: 'CR',
      url,
      at: 1,
      hits: 1,
      said: false,
      ...over,
    })
    const ranked = rankArtifacts(
      [
        a('https://r.example/CR-1', { hits: 9 }),
        a('https://r.example/CR-2', { said: true }),
        a('https://r.example/CR-3', { said: true, hits: 4 }),
        a('https://r.example/CR-4'),
      ],
      'Next, publish CR-4 once CR-2 is approved.',
    )
    expect(rankArtifacts([a('https://github.com/o/r/pull/31')], 'Fix is up as PR 31.')[0].key).toBe(true)
    expect(rankArtifacts([a('https://github.com/o/r/pull/31')], 'see #310')[0].key).toBe(false)
    expect(ranked.map((r) => [artifactName(r), r.key])).toEqual([
      ['CR-2', true],
      ['CR-4', true],
      ['CR-3', false],
      ['CR-1', false],
    ])
  })

  it('titles a session by the agent title, then the pane title, then what you first asked', () => {
    expect(displayTitle('Pane', agent({ title: 'Agent title' }))).toBe('Agent title')
    expect(displayTitle('Pane', agent({}))).toBe('Pane')
    expect(displayTitle('', agent({ firstAsk: '/goal Ship the eval dashboard' }))).toBe('Ship the eval dashboard')
    expect(displayTitle('', agent({ ask: 'x'.repeat(100) }))).toHaveLength(80)
    expect(displayTitle('', undefined)).toBe('')
  })

  it('shortens model ids', () => {
    expect(modelName('claude-opus-4-1-20250805')).toBe('opus-4-1')
    expect(modelName('gpt-codex-x')).toBe('gpt-codex-x')
  })
})
