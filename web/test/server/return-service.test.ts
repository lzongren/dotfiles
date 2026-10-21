import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basisOf, constraints, conversationOf, digest, entriesOf, packetOf, PREVIEW_ID, retryBlock, stamp } from '../../src/shared/recover.js'
import type { DraftState, ProbeRecord, ProbeSession, Repair } from '../../src/shared/types.js'
import { advanceRepair, createReturnService, mergeSession, parseReturn } from '../../server/return.js'
import { createReturnStore } from '../../server/return-store.js'

const T = 1_760_000_000
const PR = 'https://github.com/acme/api/pull/184'
const rec = (id: string, kind: ProbeRecord['kind'], at: number, text: string, turn: number, final?: boolean): ProbeRecord => ({
  id,
  kind,
  at,
  text,
  turn,
  ...(final === undefined ? {} : { final }),
})

let dir: string
let clock: number
let host: {
  sessions: ProbeSession[]
  send: { result: string; code?: string }
  ask: { result: string; code?: string }
  poll: Record<string, Record<string, unknown>>
  lookalikes?: Array<Record<string, unknown>>
}
let calls: Array<Record<string, unknown>>

function fixSession(records: ProbeRecord[], status = 'idle'): ProbeSession {
  return {
    name: 'fix',
    pane: '%1',
    cmd: 'claude',
    agent: 'claude',
    path: '/work/api',
    repo: '/work/api',
    branch: 'fix/retry',
    registry: { sessionId: 's1', status },
    transcript: { ino: 7, size: records.length * 100, last: records.at(-1)?.id ?? '' },
    records,
    turnEnds: [],
    partial: false,
  }
}

const base = [
  rec('u1', 'decision', T, 'At most 2 attempts, because upstream is rate limiting.', 1),
  rec('a1', 'agent', T + 60, 'Budget done. CI fails.', 1, true),
]

function service(storeDir = dir) {
  return createReturnService({
    host: 'dev',
    store: createReturnStore(storeDir, 'dev'),
    now: () => clock,
    probe: async (args) => {
      calls.push(args)
      if (args.mode === 'send') return { exitCode: 0, stderr: '', stdout: JSON.stringify(host.send) }
      if (args.mode === 'ask') return { exitCode: 0, stderr: '', stdout: JSON.stringify(host.ask) }
      if (args.mode === 'askpoll') return { exitCode: 0, stderr: '', stdout: JSON.stringify(host.poll) }
      return { exitCode: 0, stderr: '', stdout: JSON.stringify({ v: 1, now: clock, sessions: host.sessions, lookalikes: host.lookalikes ?? [] }) }
    },
    prs: async () => ({ fix: [PR] }),
  })
}

async function loaded(svc: ReturnType<typeof service>) {
  const body = await svc.load('fix')
  if ('error' in body) throw new Error(body.error)
  return body
}

function draftFor(text: string, records = base): DraftState {
  const c = constraints(entriesOf([fixSession(records)]))
  return { text, basis: basisOf(c), corrections: [], earlier: [], target: { session: 'fix', pane: '%1', sessionId: 's1' } }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'return-service-'))
  clock = T + 3 * 86400
  host = { sessions: [fixSession(base)], send: { result: 'pasted' }, ask: { result: 'started' }, poll: {} }
  calls = []
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('loading a work item', () => {
  it('returns the members, their records and the stored state', async () => {
    host.sessions.push({ ...fixSession([]), name: 'tests', pane: '%3', cmd: 'zsh', agent: 'shell', registry: undefined, transcript: undefined, records: [rec('shell:%3:x', 'shell', T + 90, '$ npm test\nFAIL', 0)] })
    const body = await service().load('fix')
    if ('error' in body) throw new Error(body.error)
    expect(body.work.members.map((m) => [m.name, m.reason])).toEqual([
      ['fix', 'same branch fix/retry in api'],
      ['tests', 'same branch fix/retry in api'],
    ])
    expect(body.sessions.map((s) => s.name)).toEqual(['fix', 'tests'])
    expect(calls[0]).toMatchObject({ mode: 'return', target: 'fix', prs: { fix: [PR] } })
  })

  it('names the goal you gave each member when you started it', async () => {
    host.sessions.push({ ...fixSession([]), name: 'tests', pane: '%3', agent: 'shell', registry: undefined, transcript: undefined, records: [] })
    const svc = service()
    await svc.started('tests', 'Add boundary tests for the budget')
    const body = await svc.load('fix')
    if ('error' in body) throw new Error(body.error)
    expect(body.work.members.map((m) => [m.name, m.goal])).toEqual([
      ['fix', undefined],
      ['tests', 'Add boundary tests for the budget'],
    ])
    expect((await svc.summaries()).tests).toEqual({ draft: false, goal: 'Add boundary tests for the budget', asking: 0, answered: 0 })
  })

  it('starts a new session with none of the state an old session of the same name left', async () => {
    const svc = service()
    await svc.started('tests', 'Old goal')
    await svc.seen('tests')
    await svc.separate('fix', 'session:fix', 'tests', false)
    await svc.started('tests', '')
    expect((await svc.summaries()).tests).toBeUndefined()
    const body = await svc.load('fix')
    if ('error' in body) throw new Error(body.error)
    expect(body.separated).toEqual([])
  })

  it('leaves out a member you showed separately', async () => {
    host.sessions.push({ ...fixSession([]), name: 'tests', pane: '%3', agent: 'shell', registry: undefined, transcript: undefined, records: [] })
    const svc = service()
    await svc.separate('fix', 'branch:/work/api@fix/retry', 'tests', false)
    const body = await svc.load('fix')
    if ('error' in body) throw new Error(body.error)
    expect(body.sessions.map((s) => s.name)).toEqual(['fix'])
    const apart = await svc.load('tests')
    if ('error' in apart) throw new Error(apart.error)
    expect(apart.apart).toBe('branch:/work/api@fix/retry')
    expect(body.apart).toBeUndefined()
    await svc.separate('fix', 'branch:/work/api@fix/retry', 'tests', true)
    const back = await svc.load('fix')
    if ('error' in back) throw new Error(back.error)
    expect(back.sessions.map((s) => s.name)).toEqual(['fix', 'tests'])
  })

  it('lists sessions that only look related, with why', async () => {
    host.lookalikes = [{ name: 'billing', path: '/other/api', repo: '/other/api', branch: 'fix/retry', why: 'branch' }, { name: 5 }]
    expect((await loaded(service())).lookalikes).toEqual([{ name: 'billing', path: '/other/api', repo: '/other/api', branch: 'fix/retry', why: 'branch' }])
  })

  it('says when the session is gone', async () => {
    host.sessions = []
    expect(await service().load('fix')).toEqual({ error: 'unknown_session' })
  })
})

describe('merging appended records', () => {
  it('continues turn numbers and replaces an unfinished agent message of the same turn', () => {
    const before = fixSession([rec('u1', 'decision', 1, 'go', 1), rec('a1', 'agent', 2, 'working', 1, false)])
    const appended = { ...fixSession([rec('a2', 'agent', 3, 'done', 0, true), rec('u2', 'decision', 4, 'next', 1)]), partial: true, turnEnds: [3] }
    const merged = mergeSession(before, appended)
    expect(merged.records.map((r) => [r.id, r.turn, r.final])).toEqual([
      ['u1', 1, undefined],
      ['a2', 1, true],
      ['u2', 2, undefined],
    ])
    expect(merged.turnEnds).toEqual([3])
  })

  it('marks the open agent message final when the appended part only closes its turn', () => {
    const before = fixSession([rec('u1', 'decision', 1, 'go', 1), rec('a1', 'agent', 2, 'done', 1, false)])
    const closing = { ...fixSession([]), partial: true, closes: true, turnEnds: [3] }
    expect(mergeSession(before, closing).records.map((r) => [r.id, r.final])).toEqual([
      ['u1', undefined],
      ['a1', true],
    ])
  })

  it('keeps the conversation id with the transcript version, so the next read can continue', () => {
    const {
      sessions: [s],
    } = parseReturn(JSON.stringify({ sessions: [{ name: 'fix', pane: '%1', records: [], transcript: { ino: 1, size: 2, last: 'a', sid: 's1' }, partial: true, closes: true }] }))
    expect(s.transcript).toEqual({ ino: 1, size: 2, last: 'a', sid: 's1' })
    expect(s.closes).toBe(true)
  })

  it('keeps the same per-kind caps as the host as appended records pile up', () => {
    const before = fixSession(Array.from({ length: 200 }, (_, i) => rec(`u${i}`, 'decision', i, 'note', i + 1)))
    const merged = mergeSession(before, { ...fixSession([rec('u200', 'decision', 300, 'newest', 1)]), partial: true })
    expect(merged.records).toHaveLength(200)
    expect(merged.records.at(-1)?.id).toBe('u200')
    expect(merged.dropped).toEqual({ decision: 1 })
  })

  it('appends each part of a growing transcript once, even when loads overlap', async () => {
    const extra = rec('u2', 'decision', T + 120, 'At most 1 attempt instead of 2.', 1)
    const svc = createReturnService({
      host: 'dev',
      store: createReturnStore(dir, 'dev'),
      now: () => clock,
      probe: async (args) => {
        const from = (args.from as Record<string, { size: number }>).fix?.size
        await new Promise((resolve) => setTimeout(resolve, 5))
        const s = from === undefined ? fixSession(base) : { ...fixSession(from === 200 ? [extra] : []), partial: true, transcript: { ino: 7, size: 300, last: 'u2' } }
        const shell = { ...fixSession([]), name: 'tests', pane: '%3', cmd: 'zsh', agent: 'shell' as const, registry: undefined, transcript: undefined }
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({ v: 1, sessions: [s, shell] }) }
      },
      prs: async () => ({}),
    })
    await svc.load('fix')
    const [a, b] = await Promise.all([svc.load('fix'), svc.load('tests')])
    for (const body of [a, b]) expect('error' in body ? [] : body.sessions.find((s) => s.name === 'fix')?.records.map((r) => r.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('reads the host one at a time, so the latest read gives the status and each part lands once', async () => {
    const extra = rec('u2', 'decision', T + 120, 'At most 1 attempt instead of 2.', 1)
    let calls = 0
    const svc = createReturnService({
      host: 'dev',
      store: createReturnStore(dir, 'dev'),
      now: () => clock,
      probe: async (args) => {
        calls += 1
        const n = calls
        await new Promise((resolve) => setTimeout(resolve, n === 2 ? 20 : 1))
        const from = (args.from as Record<string, { size: number }>).fix?.size
        const s = n === 1 ? fixSession(base) : { ...fixSession(from === 200 ? [extra] : [], n === 2 ? 'idle' : 'busy'), partial: true, transcript: { ino: 7, size: 300, last: 'u2' } }
        const shell = { ...fixSession([]), name: 'tests', pane: '%3', cmd: 'zsh', agent: 'shell' as const, registry: undefined, transcript: undefined }
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({ v: 1, sessions: [s, shell] }) }
      },
      prs: async () => ({}),
    })
    await svc.load('fix')
    const first = svc.load('fix')
    while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 1))
    const [, late] = await Promise.all([first, svc.load('tests')])
    if ('error' in late) throw new Error(late.error)
    const fix = late.sessions.find((s) => s.name === 'fix')
    expect(fix?.records.map((r) => r.id)).toEqual(['u1', 'a1', 'u2'])
    expect(fix?.registry?.status).toBe('busy')
  })

  it('replaces everything when the read started over', () => {
    const before = fixSession([rec('u1', 'decision', 1, 'go', 1)])
    const fresh = fixSession([rec('u9', 'decision', 9, 'new', 1)])
    expect(mergeSession(before, fresh).records.map((r) => r.id)).toEqual(['u9'])
  })
})

describe('trying a repair again', () => {
  const predicted = async (svc: ReturnType<typeof service>) => {
    const w = await loaded(svc)
    const r = w.state.repairs.find((x) => x.id === 'r-1') as Repair
    return retryBlock(r, { version: w.state.draftVersion, repairs: w.state.repairs, c: constraints(entriesOf(w.sessions), w.state.decisions), conversation: conversationOf(w.sessions.find((x) => x.name === 'fix')), target: w.state.draft?.target?.sessionId })
  }
  const sent = async (svc: ReturnType<typeof service>, outcome: { result: string; code?: string }) => {
    const first = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = outcome
    await svc.repair('fix', 'r-1')
    return first.version
  }
  const changed = [...base, rec('u2', 'decision', T + 120, 'At most 1 attempt instead of 2.', 1)]
  const setups: Array<[string, (svc: ReturnType<typeof service>) => Promise<void>]> = [
    ['superseded', async (svc) => {
      const v0 = await sent(svc, { result: 'held', code: 'prompt_changed' })
      const next = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.\nAlso log each retry.'), v0)
      host.send = { result: 'pasted' }
      clock += 1000
      await svc.repair('fix', 'r-2')
      await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), next.version)
    }],
    ['lost', async (svc) => void (await sent(svc, { result: 'unknown', code: 'gone' }))],
    ['draft_changed', async (svc) => void (await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.\nAlso log each retry.'), await sent(svc, { result: 'held', code: 'prompt_changed' })))],
    ['already_sent', async (svc) => {
      await sent(svc, { result: 'refused', code: 'busy' })
      host.send = { result: 'pasted' }
      clock += 1000
      await svc.repair('fix', 'r-2')
    }],
    ['basis_changed', async (svc) => {
      const v0 = await sent(svc, { result: 'held', code: 'prompt_changed' })
      host.sessions = [fixSession(changed)]
      await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.', changed), v0)
    }],
    ['no_registry', async (svc) => {
      await sent(svc, { result: 'held', code: 'prompt_changed' })
      host.sessions = [{ ...fixSession(base), registry: undefined }]
    }],
    ['other_conversation', async (svc) => {
      await sent(svc, { result: 'held', code: 'prompt_changed' })
      host.sessions = [{ ...fixSession(base), registry: { sessionId: 's2', status: 'idle' } }]
    }],
    ['no_target', async (svc) => void (await svc.saveDraft('fix', { ...draftFor('Retry at most 2 attempts.'), target: null }, await sent(svc, { result: 'refused', code: 'busy' })))],
    ['other_conversation (failed, the draft names another)', async (svc) => void (await svc.saveDraft('fix', { ...draftFor('Retry at most 2 attempts.'), target: { session: 'fix', pane: '%1', sessionId: 's-old' } }, await sent(svc, { result: 'refused', code: 'busy' })))],
  ]
  it('refuses a retry where no Claude Code runs as not_agent, which retryBlock reads as no_registry', async () => {
    const svc = service()
    await sent(svc, { result: 'held', code: 'prompt_changed' })
    host.sessions = [{ ...fixSession(base), agent: 'shell', cmd: 'zsh' }]
    expect(await predicted(svc)).toBe('no_registry')
    expect((await svc.repair('fix', 'r-1')).body).toMatchObject({ error: 'refused', code: 'not_agent' })
  })
  it.each([
    ['registry', { registry: undefined }],
    ['transcript', { transcript: undefined }],
  ])('leaves an unknown repair as it was when its own check finds no %s to retry into', async (_, gone) => {
    const svc = service()
    await sent(svc, { result: 'unknown', code: 'no_answer' })
    host.sessions = [{ ...fixSession(base), ...gone }]
    expect((await svc.repair('fix', 'r-1')).body).toMatchObject({ error: 'refused', code: 'no_registry' })
    expect((await loaded(svc)).state.repairs[0]).toMatchObject({ id: 'r-1', state: 'unknown', reason: 'no_answer' })
  })
  it.each(setups)('refuses a retry with the reason retryBlock gives: %s', async (label, setup) => {
    const code = label.split(' ')[0]
    const svc = service()
    await setup(svc)
    expect(await predicted(svc)).toBe(code)
    const reply = await svc.repair('fix', 'r-1')
    const body = reply.body as { code?: string; error?: string }
    expect(body.code ?? body.error).toBe(code)
  })
})

describe('sending a repair', () => {
  it('freezes the packet, sends it to the verified pane and waits for the transcript to confirm', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts per request.'), '')
    const sent = await svc.repair('fix', 'r-1')
    expect(sent.status).toBe(202)
    const send = calls.find((c) => c.mode === 'send')
    expect(send).toMatchObject({ session: 'fix', pane: '%1', sessionId: 's1', requestId: 'r-1' })
    expect(String(send?.packet)).toMatch(/^\[devbox repair r-1\]\n/)
    expect(String(send?.packet)).toContain('Retry at most 2 attempts per request.')
    const work = await loaded(svc)
    expect(work.state.repairs).toEqual([expect.objectContaining({ id: 'r-1', state: 'sending', packet: send?.packet })])
  })

  it('stores a draft without what was kept for a line no longer in it', async () => {
    const svc = service()
    await svc.saveDraft('fix', { ...draftFor('Fix it.'), earlier: ['It used at most 3 attempts.'], read: ['It used three tries.|three tries'] }, '')
    expect((await loaded(svc)).state.draft).toMatchObject({ earlier: [], read: [] })
  })

  it('sends a draft once: another request for the same draft is refused', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    expect((await svc.repair('fix', 'r-1')).status).toBe(202)
    expect(await svc.repair('fix', 'r-2')).toMatchObject({ status: 409, body: { error: 'already_sent', requestId: 'r-1' } })
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(1)
  })

  it('keeps a sent draft sent when you only add whitespace', async () => {
    const svc = service()
    const first = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    await svc.repair('fix', 'r-1')
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.\n'), first.version)
    expect(await svc.repair('fix', 'r-2')).toMatchObject({ status: 409, body: { error: 'already_sent', requestId: 'r-1' } })
  })

  it('rebuilds a failed send from the draft as it is now when you try again', async () => {
    const records = [...base, rec('u2', 'decision', T + 60, 'Never commit.', 2)]
    host.sessions = [fixSession(records)]
    const svc = service()
    const first = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.', records), '')
    host.send = { result: 'refused', code: 'busy' }
    await svc.repair('fix', 'r-1')
    await svc.saveDraft('fix', { ...draftFor('Retry at most 2 attempts.', records), quote: { 'u2|Never commit.': false } }, first.version)
    host.send = { result: 'pasted' }
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 202 })
    const sends = calls.filter((c) => c.mode === 'send')
    expect(String(sends[0].packet)).toContain('Never commit.')
    expect(String(sends[1].packet)).not.toContain('Never commit.')
  })

  it('refuses to try a held send again once what holds changed after it was first sent', async () => {
    const svc = service()
    const first = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'held', code: 'typed' }
    await svc.repair('fix', 'r-1')
    const records = [...base, rec('u2', 'decision', clock + 60, 'Keep the total timeout at most 10 seconds.', 2)]
    host.sessions = [fixSession(records)]
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.', records), first.version)
    host.send = { result: 'pasted' }
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'refused', code: 'basis_changed' } })
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(1)
  })

  it('keeps a sent draft sent when you only tick a rule afterwards', async () => {
    const records = [...base, rec('u2', 'decision', T + 60, 'Never commit.', 2)]
    host.sessions = [fixSession(records)]
    const svc = service()
    const first = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.', records), '')
    await svc.repair('fix', 'r-1')
    await svc.saveDraft('fix', { ...draftFor('Retry at most 2 attempts.', records), quote: { 'u2|Never commit.': true } }, first.version)
    expect(await svc.repair('fix', 'r-2')).toMatchObject({ status: 409, body: { error: 'already_sent', requestId: 'r-1' } })
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(1)
  })

  it("quotes the other sessions' messages the draft keeps, and none once you leave them out", async () => {
    const review = { ...fixSession([rec('c1', 'agent', T + 90, 'Two review findings: budget reset needs checking.', 1, true)]), name: 'review', pane: '%2', agent: 'codex' as const, registry: undefined }
    host.sessions = [fixSession(base), review]
    const svc = service()
    const now = clock
    clock = T + 30
    await svc.seen('fix')
    clock = now
    const first = await svc.saveDraft('fix', { ...draftFor('Retry at most 2 attempts.'), others: ['c1'] }, '')
    host.send = { result: 'refused', code: 'busy' }
    await svc.repair('fix', 'r-1')
    await svc.saveDraft('fix', { ...draftFor('Retry at most 2 attempts.'), others: [] }, first.version)
    host.send = { result: 'pasted' }
    await svc.repair('fix', 'r-1')
    const sends = calls.filter((c) => c.mode === 'send').map((c) => String(c.packet))
    expect(sends[0]).toContain('- review (')
    expect(sends[0]).toContain('"Two review findings: budget reset needs checking."')
    expect(sends[1]).not.toContain('Two review findings')
  })

  it('refuses a send whose packet differs from the preview you were shown, or whose draft moved on, and sends that packet otherwise', async () => {
    const review = { ...fixSession([rec('c1', 'agent', T + 90, 'Two review findings.', 1, true)]), name: 'review', pane: '%2', agent: 'codex' as const, registry: undefined }
    host.sessions = [fixSession(base), review]
    const svc = service()
    const text = 'Retry at most 2 attempts.'
    const { version } = await svc.saveDraft('fix', { ...draftFor(text), others: ['c1', 'gone'] }, '')
    const preview = (others: string[]) => {
      const entries = entriesOf(host.sessions)
      return digest(packetOf(PREVIEW_ID, '/work/api', 'fix', { text, earlier: [], others }, entries, constraints(entries)))
    }
    expect(await svc.repair('fix', 'r-1', { preview: preview([]), version })).toMatchObject({ status: 409, body: { error: 'preview_changed' } })
    expect(await svc.repair('fix', 'r-1', { preview: preview(['c1']), version: 'older' })).toMatchObject({ status: 409, body: { error: 'draft_moved' } })
    expect(await svc.repair('fix', 'r-1', { version })).toMatchObject({ status: 400 })
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(0)
    host.send = { result: 'pasted' }
    await svc.repair('fix', 'r-1', { preview: preview(['c1']), version })
    expect(calls.filter((c) => c.mode === 'send').map((c) => String(c.packet))).toEqual([expect.stringContaining('"Two review findings."')])
    expect(await svc.repair('fix', 'r-2', { preview: preview(['c1']), version: 'older' })).toMatchObject({ status: 409, body: { error: 'draft_moved' } })
  })

  it('names a session without a transcript as the reason, not a changed preview', async () => {
    host.sessions = [{ ...fixSession(base), transcript: undefined }]
    const svc = service()
    const { version } = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    expect(await svc.repair('fix', 'r-1', { preview: digest(''), version })).toMatchObject({ status: 409, body: { error: 'refused', code: 'no_registry' } })
  })

  it("quotes the session's rules except the ones the draft unticks", async () => {
    const records = [...base, rec('u2', 'decision', T + 60, "Don't edit anything yet. Never commit.", 2)]
    host.sessions = [fixSession(records)]
    const svc = service()
    const draft = draftFor('Retry at most 2 attempts.', records)
    await svc.saveDraft('fix', { ...draft, quote: { "u2|Don't edit anything yet.": false } }, '')
    await svc.repair('fix', 'r-1')
    const packet = String(calls.find((c) => c.mode === 'send')?.packet)
    expect(packet).not.toContain("Don't edit anything yet.")
    expect(packet).toContain('Never commit.')
  })

  it('refuses when the evidence changed since the draft was checked, and sends nothing', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.sessions = [fixSession([...base, rec('u2', 'decision', T + 7200, 'At most 1 attempt instead of 2.', 2)])]
    const res = await svc.repair('fix', 'r-1')
    expect(res).toMatchObject({ status: 409, body: { error: 'evidence_changed', differences: [expect.objectContaining({ key: 'attempts|max', change: 'value' })] } })
    expect(calls.some((c) => c.mode === 'send')).toBe(false)
  })

  it('refuses while a draft line differs from what holds now, or a conflict touches the draft', async () => {
    const records = [...base, rec('u2', 'decision', T + 7200, 'At most 1 attempt instead of 2.', 2)]
    host.sessions = [fixSession(records)]
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.', records), '')
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'draft_issues' } })
    const split = [rec('w1', 'decision', T, 'At most 4 workers.', 1), rec('w2', 'decision', T + 1, 'At most 8 workers.', 2)]
    host.sessions = [fixSession(split)]
    const svc2 = service(path.join(dir, 'b'))
    await svc2.saveDraft('fix', draftFor('Run at most 4 workers.', split), '')
    expect(await svc2.repair('fix', 'r-2')).toMatchObject({ status: 409, body: { error: 'conflict' } })
    expect(calls.some((c) => c.mode === 'send')).toBe(false)
  })

  it('refuses a draft line that sets what one of your rules names until you set that rule aside, then says so in the message', async () => {
    const records = [...base, rec('u2', 'decision', T + 60, "Don't raise the deadline to 30 seconds.", 2)]
    host.sessions = [fixSession(records)]
    const svc = service()
    const draft = draftFor('Raise the deadline to 30 seconds.', records)
    await svc.saveDraft('fix', draft, '')
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'rule_conflicts', hits: [{ line: 0, rule: "Don't raise the deadline to 30 seconds." }] } })
    expect(calls.some((c) => c.mode === 'send')).toBe(false)
    await svc.saveDraft('fix', { ...draft, setAside: ["u2|Don't raise the deadline to 30 seconds."] }, (await loaded(svc)).state.draftVersion)
    expect((await svc.repair('fix', 'r-2')).status).toBe(202)
    expect(String(calls.find((c) => c.mode === 'send')?.packet)).toContain(`I set aside my rule from ${stamp(T + 60)} for this request only: "Don't raise the deadline to 30 seconds."`)
  })

  it('refuses a draft that asks for a merge, push or deploy, whatever rules are set aside', async () => {
    host.sessions = [fixSession(base)]
    const svc = service()
    await svc.saveDraft('fix', draftFor('Merge the PR once the tests pass.', base), '')
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'out_of_scope', lines: [0] } })
    expect(calls.some((c) => c.mode === 'send')).toBe(false)
  })

  it('refuses a draft with an amount it cannot check until you confirm that line', async () => {
    host.sessions = [fixSession(base)]
    const svc = service()
    const draft = draftFor('Give the whole call half a minute.', base)
    await svc.saveDraft('fix', draft, '')
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'unchecked_amounts', lines: [0] } })
    expect(calls.some((c) => c.mode === 'send')).toBe(false)
    await svc.saveDraft('fix', { ...draft, read: ['Give the whole call half a minute.|half a minute'] }, (await loaded(svc)).state.draftVersion)
    expect((await svc.repair('fix', 'r-2')).status).toBe(202)
  })

  it('records a refusal from the host with its reason, and a retry with the same id sends again', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'refused', code: 'busy' }
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'refused', code: 'busy' } })
    let work = await loaded(svc)
    expect(work.state.repairs).toEqual([expect.objectContaining({ state: 'failed', reason: 'busy' })])
    host.send = { result: 'already' }
    expect((await svc.repair('fix', 'r-1')).status).toBe(202)
    work = await loaded(svc)
    expect(work.state.repairs).toEqual([expect.objectContaining({ state: 'delivered' })])
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(2)
  })

  it('keeps a paste the host left unsubmitted as sent, and follows it once you submit it yourself', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'held', code: 'prompt_changed' }
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'held', code: 'prompt_changed', repair: { state: 'held' } } })
    expect(await svc.repair('fix', 'r-2')).toMatchObject({ status: 409, body: { error: 'already_sent', requestId: 'r-1' } })
    const packet = String(calls.find((c) => c.mode === 'send')?.packet)
    host.sessions = [fixSession([...base, rec('d1', 'devbox', clock + 1, packet, 2)], 'busy')]
    const repairs = (await loaded(svc)).state.repairs
    expect(repairs).toEqual([expect.objectContaining({ id: 'r-1', state: 'working', deliveredId: 'd1' })])
    expect(repairs[0].checked).toBeUndefined()
  })

  it('keeps the check a held repair named when it is tried again after a newer failure', async () => {
    const failed = [...base, rec('f1', 'failure', T + 7300, 'FAIL retry.test.ts', 2)]
    host.sessions = [fixSession(failed)]
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.', failed), '')
    host.send = { result: 'held', code: 'prompt_changed' }
    await svc.repair('fix', 'r-1')
    host.sessions = [fixSession([...failed, rec('f2', 'failure', T + 7400, 'FAIL other.test.ts', 3)])]
    await svc.repair('fix', 'r-1')
    expect((await loaded(svc)).state.repairs).toEqual([expect.objectContaining({ id: 'r-1', check: 'retry.test.ts' })])
  })

  it('checks a held repair tried again as it went out, whatever a follow-up changed in the draft since', async () => {
    host.sessions = [fixSession(base)]
    const svc = service()
    const draft = { ...draftFor('Give the whole call half a minute.', base), read: ['Give the whole call half a minute.|half a minute'] }
    await svc.saveDraft('fix', draft, '')
    host.send = { result: 'held', code: 'prompt_changed' }
    await svc.repair('fix', 'r-1')
    await svc.saveDraft('fix', { ...draft, read: [], follows: clock }, (await loaded(svc)).state.draftVersion)
    host.send = { result: 'already' }
    expect((await svc.repair('fix', 'r-1')).status).toBe(202)
    const repairs = (await loaded(svc)).state.repairs
    expect(repairs).toEqual([expect.objectContaining({ id: 'r-1', state: 'delivered' })])
    expect(repairs[0].checked).toBeUndefined()
  })

  it('counts a follow-up started on a sent draft as an unsent draft on Now', async () => {
    const svc = service()
    const draft = draftFor('Retry at most 2 attempts.')
    await svc.saveDraft('fix', draft, '')
    await svc.repair('fix', 'r-1')
    expect((await svc.summaries()).fix).toMatchObject({ draft: false })
    await svc.saveDraft('fix', { ...draft, follows: clock }, (await loaded(svc)).state.draftVersion)
    expect((await svc.summaries()).fix).toMatchObject({ draft: true })
  })

  it('tries a failed repair again after a newer one went out, since it never went out', async () => {
    const svc = service()
    const first = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'refused', code: 'busy' }
    await svc.repair('fix', 'r-1')
    const second = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.\nAlso log each retry.'), first.version)
    host.send = { result: 'pasted' }
    clock += 1000
    expect((await svc.repair('fix', 'r-2')).status).toBe(202)
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), second.version)
    expect((await svc.repair('fix', 'r-1')).status).toBe(202)
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(3)
  })

  it('marks a held repair failed when trying it again fails on an empty prompt, and keeps an unknown one as it was', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'held', code: 'prompt_changed' }
    await svc.repair('fix', 'r-1')
    host.send = { result: 'failed', code: 'paste_failed' }
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 500, body: { error: 'send_failed', code: 'paste_failed', repair: { state: 'failed' } } })
    host.send = { result: 'unknown', code: 'no_answer' }
    await svc.repair('fix', 'r-1')
    host.send = { result: 'failed', code: 'paste_failed' }
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 500, body: { repair: { state: 'unknown', reason: 'no_answer' } } })
  })

  it('does not try a repair again whose conversation was lost', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'unknown', code: 'gone' }
    await svc.repair('fix', 'r-1')
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'lost' } })
  })

  it('does not try an older repair again once a newer one went out', async () => {
    const svc = service()
    const first = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'held', code: 'prompt_changed' }
    await svc.repair('fix', 'r-1')
    const second = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.\nAlso log each retry.'), first.version)
    host.send = { result: 'pasted' }
    clock += 1000
    expect((await svc.repair('fix', 'r-2')).status).toBe(202)
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), second.version)
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'superseded', requestId: 'r-2' } })
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(2)
  })

  it('keeps a held paste held when trying again is refused because it still fills the prompt', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'held', code: 'agent_changed' }
    await svc.repair('fix', 'r-1')
    host.send = { result: 'refused', code: 'typed' }
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'refused', code: 'typed' } })
    expect((await loaded(svc)).state.repairs).toEqual([expect.objectContaining({ id: 'r-1', state: 'held', reason: 'agent_changed' })])
    expect(await svc.repair('fix', 'r-2')).toMatchObject({ status: 409, body: { error: 'already_sent' } })
  })

  it('calls a send of unknown fate held when trying again finds text in the prompt, and leaves it so while Claude Code is not in front', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'unknown' }
    await svc.repair('fix', 'r-1')
    host.send = { result: 'refused', code: 'typed' }
    await svc.repair('fix', 'r-1')
    expect((await loaded(svc)).state.repairs).toEqual([expect.objectContaining({ id: 'r-1', state: 'held', reason: 'in_prompt' })])
    host.send = { result: 'refused', code: 'no_registry' }
    await svc.repair('fix', 'r-1')
    expect((await loaded(svc)).state.repairs).toEqual([expect.objectContaining({ id: 'r-1', state: 'held' })])
    host.send = { result: 'refused', code: 'not_agent' }
    expect(await svc.repair('fix', 'r-1')).toEqual({ status: 409, body: { error: 'refused', code: 'not_agent' } })
    expect((await loaded(svc)).state.repairs).toEqual([expect.objectContaining({ id: 'r-1', state: 'held', reason: 'in_prompt' })])
  })

  it('calls a held send unknown when the conversation in its pane changed, before asking the host', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'held', code: 'prompt_changed' }
    await svc.repair('fix', 'r-1')
    host.sessions = [{ ...fixSession(base), registry: { sessionId: 's2', status: 'idle' } }]
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'refused', code: 'other_conversation', repair: { state: 'unknown' } } })
    expect(await svc.repair('fix', 'r-2')).toMatchObject({ status: 409, body: { error: 'already_sent' } })
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(1)
  })

  it('refuses to send a draft that names no conversation', async () => {
    const svc = service()
    await svc.saveDraft('fix', { ...draftFor('Retry at most 2 attempts.'), target: null }, '')
    expect(await svc.repair('fix', 'r-1')).toEqual({ status: 409, body: { error: 'no_target' } })
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(0)
  })

  it('leaves a retry unknown, unchanged, while Claude Code is not in front of its pane', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'unknown' }
    await svc.repair('fix', 'r-1')
    host.sessions = [{ ...fixSession(base), agent: 'shell', cmd: 'zsh', registry: undefined }]
    expect(await svc.repair('fix', 'r-1')).toEqual({ status: 409, body: { error: 'refused', code: 'not_agent' } })
    expect((await loaded(svc)).state.repairs).toEqual([expect.objectContaining({ id: 'r-1', state: 'unknown' })])
  })

  it('asks the host for the conversation a send went to, and follows it to the pane it runs in now', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'held', code: 'typed' }
    await svc.repair('fix', 'r-1')
    await loaded(svc)
    expect(calls.filter((c) => c.mode === 'return').at(-1)).toMatchObject({ prefer: 's1', preferPane: '%1' })
    host.sessions = [{ ...fixSession(base), pane: '%9' }]
    host.send = { result: 'pasted' }
    expect((await svc.repair('fix', 'r-1')).status).toBe(202)
    expect(calls.filter((c) => c.mode === 'send').at(-1)).toMatchObject({ pane: '%9', sessionId: 's1' })
  })

  it('tries a failed send again only in the conversation its draft names', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'refused', code: 'busy' }
    await svc.repair('fix', 'r-1')
    host.sessions = [{ ...fixSession(base), registry: { sessionId: 's2', status: 'idle' } }]
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { code: 'other_conversation' } })
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(1)
  })

  it('tries a failed send again in the conversation you chose for its draft', async () => {
    const svc = service()
    const first = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'refused', code: 'busy' }
    await svc.repair('fix', 'r-1')
    host.sessions = [{ ...fixSession(base), registry: { sessionId: 's2', status: 'idle' } }]
    await svc.saveDraft('fix', { ...draftFor('Retry at most 2 attempts.'), target: { session: 'fix', pane: '%1', sessionId: 's2' } }, first.version)
    host.send = { result: 'pasted' }
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 202 })
    expect(calls.filter((c) => c.mode === 'send').at(-1)).toMatchObject({ sessionId: 's2', requestId: 'r-1' })
  })

  it('says why a send is unknown when its conversation is no longer there', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    await svc.repair('fix', 'r-1')
    host.sessions = [{ ...fixSession(base), registry: { sessionId: 's2', status: 'idle' } }]
    clock += 31
    const [r] = (await loaded(svc)).state.repairs
    expect(r).toMatchObject({ id: 'r-1', state: 'unknown', reason: 'not_visible' })
    host.sessions = [fixSession(base)]
    host.send = { result: 'pasted' }
    expect((await svc.repair('fix', 'r-1')).status).toBe(202)
  })

  it('keeps a paste whose Enter failed as held, since it sits in the prompt', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'unknown', code: 'enter_failed' }
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'held', repair: { state: 'held', reason: 'enter_failed' } } })
  })


  it('reports a host that could not paste as a failed send, not an unreachable host', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'failed', code: 'paste_failed' }
    expect(await svc.repair('fix', 'r-1')).toMatchObject({ status: 500, body: { error: 'send_failed', code: 'paste_failed', repair: { state: 'failed' } } })
  })

  it('follows the open repair of the current draft, or the draft, not an older one', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    host.send = { result: 'unknown' }
    await svc.repair('fix', 'r-1')
    const v = (await loaded(svc)).state.draftVersion
    await svc.saveDraft('fix', { ...draftFor('Retry at most 2 attempts. Run npm test.'), target: { session: 'fix', pane: '%2', sessionId: 's2' } }, v)
    await loaded(svc)
    expect(calls.filter((c) => c.mode === 'return').at(-1)).toMatchObject({ prefer: 's2', preferPane: '%2' })
  })

  it('still lands a delivery that shows up in the conversation after it moved to another pane', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    await svc.repair('fix', 'r-1')
    const packet = String(calls.find((c) => c.mode === 'send')?.packet)
    host.sessions = [{ ...fixSession([...base, rec('d1', 'devbox', clock + 1, packet, 2)], 'busy'), pane: '%9' }]
    clock += 31
    expect((await loaded(svc)).state.repairs).toEqual([expect.objectContaining({ id: 'r-1', state: 'working', deliveredId: 'd1' })])
  })

  it('sends one paste when the same request arrives twice at once', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    await Promise.all([svc.repair('fix', 'r-1'), svc.repair('fix', 'r-1')])
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(1)
  })

  it('follows the receipt: delivered, then replied in the same turn', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    await svc.repair('fix', 'r-1')
    const packet = String(calls.find((c) => c.mode === 'send')?.packet)
    host.sessions = [fixSession([...base, rec('d1', 'devbox', clock + 1, packet, 2)], 'busy')]
    let work = await loaded(svc)
    expect(work.state.repairs[0]).toMatchObject({ state: 'working', deliveredId: 'd1' })
    host.sessions = [fixSession([...base, rec('d1', 'devbox', clock + 1, packet, 2), rec('a9', 'agent', clock + 30, '[devbox result r-1] Changed retry.ts', 2, true)])]
    work = await loaded(svc)
    expect(work.state.repairs[0]).toMatchObject({ state: 'replied', replyId: 'a9', reply: '[devbox result r-1] Changed retry.ts' })
  })

  it('calls a send without a transcript record after 30 seconds unknown, and a late record still lands', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    await svc.repair('fix', 'r-1')
    clock += 31
    let work = await loaded(svc)
    expect(work.state.repairs[0]).toMatchObject({ state: 'unknown' })
    const packet = String(calls.find((c) => c.mode === 'send')?.packet)
    host.sessions = [fixSession([...base, rec('d1', 'devbox', clock, packet, 2)])]
    work = await loaded(svc)
    expect(work.state.repairs[0]).toMatchObject({ state: 'delivered' })
  })
})

describe('following a delivered repair', () => {
  it("reads busy as working only from the conversation the repair went to", () => {
    const r: Repair = { id: 'r-1', packet: '[devbox repair r-1]', target: { session: 'fix', pane: '%1', sessionId: 's1' }, basis: [], version: 'v', draftVersion: 'v0', sentAt: clock, state: 'delivered' }
    const records = [...base, rec('d1', 'devbox', clock + 1, '[devbox repair r-1]\nRetry at most 2 attempts.', 2)]
    expect(advanceRepair(r, { ...fixSession(records), registry: { sessionId: 's2', status: 'busy' } }, clock + 5).state).toBe('delivered')
    expect(advanceRepair(r, fixSession(records, 'busy'), clock + 5).state).toBe('working')
  })
})

describe('accepting a result', () => {
  async function replied() {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.\nAdd a test for idempotent writes.'), '')
    await svc.repair('fix', 'r-1')
    const packet = String(calls.find((c) => c.mode === 'send')?.packet)
    const after = [...base, rec('d1', 'devbox', clock + 1, packet, 2), rec('a9', 'agent', clock + 30, 'Changed retry.ts', 2, true)]
    host.sessions = [fixSession(after)]
    await svc.load('fix')
    return { svc, after }
  }

  it('records acceptance of the reply it saw, and nothing else', async () => {
    const { svc } = await replied()
    expect(await svc.accept('fix', 'r-1')).toMatchObject({ status: 200 })
    const work = await loaded(svc)
    expect(work.state.repairs[0].accepted).toEqual({ at: clock, replyId: 'a9' })
    expect(calls.filter((c) => c.mode === 'send')).toHaveLength(1)
  })

  it('stops showing the repair on the overview once you accept it, and says it was accepted', async () => {
    const { svc } = await replied()
    expect((await svc.summaries()).fix).toMatchObject({ draft: false, repair: 'replied', open: 2 })
    await svc.accept('fix', 'r-1')
    expect(await svc.summaries()).toEqual({ fix: { draft: false, accepted: true, open: 2, missed: ['Retry at most 2 attempts.', 'Add a test for idempotent writes.'], asking: 0, answered: 0 } })
  })

  it('keeps a reply you have not accepted ahead of the follow-up you started after it', async () => {
    const { svc } = await replied()
    const { version } = await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.\nAlso log each retry.'), version)
    expect(await svc.summaries()).toEqual({ fix: { draft: true, repair: 'replied', open: 2, asking: 0, answered: 0 } })
  })

  it('refuses a result made under constraints that have since changed', async () => {
    const { svc, after } = await replied()
    host.sessions = [fixSession([...after, rec('u3', 'decision', clock + 60, 'At most 1 attempt instead of 2.', 3)])]
    expect(await svc.accept('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'evidence_changed' } })
  })

  it('refuses before there is a reply', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    await svc.repair('fix', 'r-1')
    expect(await svc.accept('fix', 'r-1')).toMatchObject({ status: 409, body: { error: 'no_reply' } })
  })
})

describe('asking a question', () => {
  it('starts a read-only copy with the question prompt and never sends to the original session', async () => {
    const svc = service()
    const res = await svc.ask('fix', 'q-1', 'Why 200 ms backoff?')
    expect(res.status).toBe(202)
    const ask = calls.find((c) => c.mode === 'ask')
    expect(ask).toMatchObject({ session: 'fix', pane: '%1', sessionId: 's1', inquiryId: 'q-1', budget: 3 })
    expect(String(ask?.prompt)).toMatch(/^\[devbox question q-1\]\nRead-only investigation\./)
    expect(String(ask?.prompt)).toContain('Question: Why 200 ms backoff?')
    expect(calls.some((c) => c.mode === 'send')).toBe(false)
    expect((await loaded(svc)).state.inquiries).toEqual([expect.objectContaining({ id: 'q-1', question: 'Why 200 ms backoff?', state: 'running', version: 'a1' })])
  })

  it('records a refusal with its reason', async () => {
    host.ask = { result: 'refused', code: 'other_conversation' }
    const svc = service()
    expect(await svc.ask('fix', 'q-1', 'Why?')).toMatchObject({ status: 409, body: { error: 'refused', code: 'other_conversation' } })
    expect((await loaded(svc)).state.inquiries).toEqual([expect.objectContaining({ state: 'failed', reason: 'other_conversation' })])
  })

  it('keeps each question to its own answer, so a new one never takes an older receipt', async () => {
    const svc = service()
    await svc.ask('fix', 'q-1', 'Why 200 ms backoff?')
    await svc.ask('fix', 'q-2', 'Is the CI failure flaky?')
    host.poll = { 'q-1': { state: 'running' }, 'q-2': { state: 'replied', answer: 'Facts: flaky since Tuesday.', cost: 0.9, tools: ['Glob', 'Grep', 'Read'], calls: ['Read'] } }
    const { inquiries } = (await loaded(svc)).state
    expect(inquiries.map((q) => [q.id, q.state, q.answer])).toEqual([
      ['q-1', 'running', undefined],
      ['q-2', 'replied', 'Facts: flaky since Tuesday.'],
    ])
    expect(inquiries[1]).toMatchObject({ cost: 0.9, tools: ['Glob', 'Grep', 'Read'], calls: ['Read'] })
  })

  it('calls a question unknown after three minutes without an answer, and still takes a late one', async () => {
    const svc = service()
    await svc.ask('fix', 'q-1', 'Why?')
    host.poll = { 'q-1': { state: 'running' } }
    clock += 181
    expect((await loaded(svc)).state.inquiries[0].state).toBe('unknown')
    host.poll = { 'q-1': { state: 'replied', answer: 'late', cost: 1, tools: ['Read'], calls: [] } }
    expect((await loaded(svc)).state.inquiries[0]).toMatchObject({ state: 'replied', answer: 'late' })
  })

  it('follows a running question for the overview without the work page open, never making the summary wait on the host', async () => {
    const queued: Array<[() => void, number]> = []
    const svc = createReturnService({ host: 'dev', store: createReturnStore(dir, 'dev'), now: () => clock, probe: async (args) => (calls.push(args), { exitCode: 0, stderr: '', stdout: JSON.stringify(args.mode === 'askpoll' ? host.poll : args.mode === 'ask' ? host.ask : { v: 1, now: clock, sessions: host.sessions, lookalikes: [] }) }), prs: async () => ({}), later: (run, ms) => void queued.push([run, ms]) })
    await svc.ask('fix', 'q-1', 'Why?')
    const before = calls.length
    expect((await svc.summaries()).fix).toMatchObject({ asking: 1, answered: 0 })
    await svc.summaries()
    expect(calls.length).toBe(before)
    expect(queued.map(([, ms]) => ms)).toEqual([15000])
    host.poll = { 'q-1': { state: 'replied', answer: 'Because.', cost: 1, tools: ['Read'], calls: [] } }
    clock += 30
    queued[0][0]()
    await vi.waitFor(async () => expect((await svc.summaries()).fix).toMatchObject({ asking: 0, answered: 1 }))
    expect(queued).toHaveLength(1)
  })

  it('gives up on a question the host knows nothing about after fifteen minutes', async () => {
    const svc = service()
    await svc.ask('fix', 'q-1', 'Why?')
    host.poll = { 'q-1': { state: 'unknown' } }
    clock += 600
    expect((await loaded(svc)).state.inquiries[0].state).toBe('unknown')
    clock += 301
    expect((await loaded(svc)).state.inquiries[0]).toMatchObject({ state: 'failed', reason: 'no_answer' })
    const before = calls.length
    await loaded(svc)
    expect(calls.slice(before).some((c) => c.mode === 'askpoll')).toBe(false)
  })

  it('refuses a bad id, an empty question, and a session without a conversation', async () => {
    const svc = service()
    expect((await svc.ask('fix', 'nope', 'Why?')).status).toBe(400)
    expect((await svc.ask('fix', 'q-1', '   ')).status).toBe(400)
    host.sessions = [{ ...fixSession(base), registry: undefined }]
    expect(await svc.ask('fix', 'q-2', 'Why?')).toMatchObject({ status: 409, body: { error: 'refused', code: 'no_registry' } })
    expect(calls.some((c) => c.mode === 'ask')).toBe(false)
  })
})

describe('briefing the home list', () => {
  const later = [...base, rec('u2', 'decision', T + 7200, 'At most 1 attempt instead of 2.', 2), rec('f1', 'failure', T + 7300, 'FAIL retry.test.ts', 2)]

  it('reads the work and briefs it from its records, changing nothing it stores', async () => {
    host.sessions = [fixSession(later)]
    const svc = service()
    const before = await svc.summaries()
    expect(await svc.brief('fix', T + 3600)).toMatchObject({
      status: 200,
      body: { session: 'fix', work: { members: [{ name: 'fix' }] }, agents: { fix: 'claude' }, brief: { leftAt: T + 3600, updated: { to: { value: 1 } }, failing: { id: 'f1' } } },
    })
    expect(calls.map((c) => c.mode)).toEqual(['return'])
    expect(await svc.summaries()).toEqual(before)
  })

  it('counts from your last Return visit before the overview mark', async () => {
    host.sessions = [fixSession(later)]
    const svc = service()
    clock = T + 7250
    await svc.seen('fix')
    clock = T + 7250 + 31 * 60
    const res = await svc.brief('fix', T)
    expect(res.body).toMatchObject({ brief: { leftAt: T + 7250, failing: { id: 'f1' } } })
  })

  it('keeps where you left off for the whole visit, and moves it once you have been away half an hour', async () => {
    host.sessions = [fixSession(later)]
    const svc = service()
    clock = T + 7400
    await svc.seen('fix')
    clock = T + 7900
    await svc.seen('fix')
    expect((await loaded(svc)).state.seenAt).toBeUndefined()
    expect(await svc.brief('fix', T + 3600)).toMatchObject({ body: { brief: { leftAt: T + 3600, failing: { id: 'f1' } } } })
    clock = T + 7900 + 31 * 60
    expect((await loaded(svc)).state.seenAt).toBe(T + 7900)
    await svc.seen('fix')
    clock += 600
    await svc.seen('fix')
    expect((await loaded(svc)).state.seenAt).toBe(T + 7900)
  })

  it('stops naming a failed check once a repair went out after it, and moves a repair on as it reads the work', async () => {
    host.sessions = [fixSession(later)]
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 1 attempt.', later), '')
    host.send = { result: 'pasted' }
    clock = T + 7500
    await svc.repair('fix', 'r-1')
    const marker = rec('d1', 'devbox', T + 7501, '[devbox repair r-1] Retry at most 1 attempt.', 3)
    host.sessions = [fixSession([...later, marker, rec('a9', 'agent', T + 7600, 'Done: one attempt now.', 3, true)])]
    const res = await svc.brief('fix', T + 3600)
    expect(res.body).toMatchObject({ brief: { leftAt: T + 3600 } })
    expect((res.body as { brief: { failing?: unknown } }).brief.failing).toBeUndefined()
    expect((await svc.summaries()).fix).toMatchObject({ repair: 'replied' })
  })

  it('says when the session is gone', async () => {
    host.sessions = []
    expect(await service().brief('fix')).toMatchObject({ status: 404 })
  })
})

describe('what the overview shows without asking the host', () => {
  it('summarizes each picked-up session from the store alone', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    await svc.ask('fix', 'q-1', 'Why?')
    const before = calls.length
    expect(await svc.summaries()).toEqual({ fix: { draft: true, asking: 1, answered: 0 } })
    expect(calls.length).toBe(before)
  })

  it('names the check a failure repair was drafted for when it says what you sent', async () => {
    const failed = [...base, rec('f1', 'failure', T + 7300, 'FAIL retry.test.ts', 2)]
    host.sessions = [fixSession(failed)]
    const svc = service()
    await svc.saveDraft('fix', draftFor('Decision: find and fix why the recorded failure quoted below fails, then rerun the checks that cover it.', failed), '')
    await svc.repair('fix', 'r-1')
    expect((await svc.summaries()).fix.sent).toBe('Decision: find and fix why ‘retry.test.ts’ fails, then rerun the checks that cover it.')
  })

  it('stops calling a draft unsent once it went out, and counts answers that arrived after your last visit', async () => {
    const svc = service()
    await svc.saveDraft('fix', draftFor('Retry at most 2 attempts.'), '')
    await svc.repair('fix', 'r-1')
    await svc.ask('fix', 'q-1', 'Why?')
    host.poll = { 'q-1': { state: 'replied', answer: 'a', cost: 1, tools: ['Read'], calls: [] } }
    await svc.load('fix')
    expect(await svc.summaries()).toEqual({ fix: { draft: false, repair: 'sending', sent: 'Retry at most 2 attempts.', asking: 0, answered: 1 } })
    await svc.seen('fix')
    expect((await svc.summaries()).fix.answered).toBe(0)
  })

  it('lists a work you looked at this visit, so the overview keeps reading it, and drops it once the visit ends', async () => {
    const svc = service()
    clock = T + 100
    await svc.seen('fix')
    expect(await svc.summaries()).toEqual({ fix: { draft: false, looked: T + 100, asking: 0, answered: 0 } })
    clock = T + 100 + 31 * 60
    expect(await svc.summaries()).toEqual({})
  })

  it('lists the separations of the loaded work so they can be undone', async () => {
    host.sessions.push({ ...fixSession([]), name: 'tests', pane: '%3', agent: 'shell', registry: undefined, transcript: undefined, records: [] })
    const svc = service()
    await svc.separate('fix', 'branch:/work/api@fix/retry', 'tests', false)
    expect((await loaded(svc)).separated).toEqual([{ work: 'branch:/work/api@fix/retry', session: 'tests' }])
  })
})
