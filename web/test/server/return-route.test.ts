import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type App } from '../../server/index.js'
import { constraints, digest, entriesOf, packetOf, PREVIEW_ID } from '../../src/shared/recover.js'
import type { ReturnResponse } from '../../src/shared/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const previewOf = (r: ReturnResponse) => {
  const entries = entriesOf(r.sessions, r.session)
  return digest(packetOf(PREVIEW_ID, r.sessions.find((x) => x.name === r.session)!.path, r.session, r.state.draft!, entries, constraints(entries, r.state.decisions)))
}
const stubsDir = path.resolve(here, '../stubs')
const probeSource = readFileSync(path.resolve(here, '../../probe/agent-probe.py'), 'utf8')

describe('Return routes', () => {
  let app: App
  let root: string
  const savedPath = process.env.PATH

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'devbox-web-return.'))
    mkdirSync(path.join(root, 'dist'))
    mkdirSync(path.join(root, 'probe'))
    writeFileSync(path.join(root, 'dist/index.html'), '<html></html>')
    writeFileSync(path.join(root, 'probe/agent-probe.py'), probeSource)
    process.env.PATH = `${path.join(stubsDir, 'ssh-bin')}:${savedPath}`
    app = await createApp({
      port: 0,
      bin: stubsDir,
      stateDir: path.join(root, 'state'),
      distRoot: path.join(root, 'dist'),
      version: '0',
      returnDir: path.join(root, 'return'),
    })
  })

  beforeEach(() => {
    process.env.SSH_STUB_LOG = path.join(root, `ssh-${Date.now()}-${Math.random()}.log`)
    delete process.env.SSH_STUB_SEND_REPLY
  })

  afterAll(async () => {
    await app.close()
    process.env.PATH = savedPath
    delete process.env.SSH_STUB_LOG
    rmSync(root, { recursive: true, force: true })
  })

  const base = () => app.url.split('#')[0]
  const auth = () => ({ Authorization: `Bearer ${app.token}` })
  const get = (q: string) => fetch(`${base()}api/return?${q}`, { headers: auth() })
  const send = (route: string, body: unknown, method = 'POST') =>
    fetch(`${base()}api/return/${route}`, {
      method,
      headers: { ...auth(), 'Content-Type': 'application/json', Origin: base().replace(/\/$/, '') },
      body: JSON.stringify(body),
    })
  const sshLines = () => {
    try {
      return readFileSync(process.env.SSH_STUB_LOG!, 'utf8')
    } catch {
      return ''
    }
  }

  it('returns the work item with its records and stored state', async () => {
    const res = await get('session=cc-demo')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReturnResponse
    expect(body.session).toBe('cc-demo')
    expect(body.work.members.map((m) => m.name)).toEqual(['cc-demo'])
    expect(body.sessions[0].records.map((r) => r.id)).toEqual(['u1', 'a1'])
    expect(body.state.draft).toBeNull()
    expect(sshLines()).toContain('\\"mode\\":\\"return\\"')
  })

  it('briefs a session for the home list', async () => {
    const res = await fetch(`${base()}api/return/brief?session=cc-demo`, { headers: auth() })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ session: 'cc-demo', work: { members: [{ name: 'cc-demo' }] }, brief: { stopped: { id: 'a1' } } })
    expect((await fetch(`${base()}api/return/brief?session=%3Aprobe`, { headers: auth() })).status).toBe(400)
    expect((await fetch(`${base()}api/return/brief?session=cc-demo&left=soon`, { headers: auth() })).status).toBe(400)
  })

  it('needs the token and a session name', async () => {
    expect((await fetch(`${base()}api/return?session=cc-demo`)).status).toBe(401)
    expect((await get('')).status).toBe(400)
    expect((await get('session=%3Aprobe')).status).toBe(400)
    expect((await send('repair', { session: 'not a session', requestId: 'r-1' })).status).toBe(400)
  })

  it('saves a draft, refuses a stale save, then sends a repair and accepts nothing before a reply', async () => {
    const draft = {
      text: 'Retry at most 2 attempts per request.',
      basis: [{ key: 'attempts|max', value: 2, recordId: 'u1' }],
      corrections: [],
      earlier: [],
      target: { session: 'cc-demo', pane: '%1', sessionId: 's1' },
    }
    const saved = await send('draft', { session: 'cc-demo', draft, base: '' }, 'PUT')
    expect(saved.status).toBe(200)
    const { version } = (await saved.json()) as { version: string }
    const stale = await send('draft', { session: 'cc-demo', draft: { ...draft, text: 'x' }, base: 'old' }, 'PUT')
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { version: string }).version).toBe(version)

    const shown = (await (await get('session=cc-demo')).json()) as ReturnResponse
    const repair = await send('repair', { session: 'cc-demo', requestId: 'r-route1', version, preview: previewOf(shown) })
    expect(repair.status).toBe(202)
    expect(sshLines()).toContain('\\"mode\\":\\"send\\"')
    expect(sshLines()).toContain('[devbox repair r-route1]')

    const accept = await send('accept', { session: 'cc-demo', requestId: 'r-route1' })
    expect(accept.status).toBe(409)
    expect(await accept.json()).toMatchObject({ error: 'no_reply' })
  })

  it('passes a host refusal through with its reason', async () => {
    const current = (await (await get('session=cc-demo')).json()) as ReturnResponse
    const next = { ...current.state.draft!, text: 'Retry at most 2 attempts per request, then stop.' }
    const saved = await send('draft', { session: 'cc-demo', draft: next, base: current.state.draftVersion }, 'PUT')
    expect(saved.status).toBe(200)
    const { version } = (await saved.json()) as { version: string }
    process.env.SSH_STUB_SEND_REPLY = '{"result": "refused", "code": "busy"}'
    const shown = (await (await get('session=cc-demo')).json()) as ReturnResponse
    const res = await send('repair', { session: 'cc-demo', requestId: 'r-route2', version, preview: previewOf(shown) })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'refused', code: 'busy' })
  })

  it('starts a question and records seen, decisions and separations', async () => {
    const ask = await send('ask', { session: 'cc-demo', inquiryId: 'q-route1', question: 'Why 2 attempts?' })
    expect(ask.status).toBe(202)
    expect(sshLines()).toContain('\\"mode\\":\\"ask\\"')
    expect((await send('seen', { session: 'cc-demo' })).status).toBe(200)
    expect((await send('decide', { session: 'cc-demo', key: 'workers|max', limitId: 'w1#0' })).status).toBe(200)
    expect((await send('separate', { session: 'cc-demo', work: 'pr:x', member: 'tests', undo: false })).status).toBe(200)
    const body = (await (await get('session=cc-demo')).json()) as ReturnResponse
    expect(body.state.inquiries.map((q) => q.id)).toEqual(['q-route1'])
    expect(body.state.lookedAt).toEqual(expect.any(Number))
    expect(body.state.decisions).toEqual({ 'workers|max': 'w1#0' })
  })

  it('summarizes picked-up sessions without reaching the host', async () => {
    const before = sshLines()
    const res = await fetch(`${base()}api/return/summary`, { headers: auth() })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { sessions: Record<string, unknown> }).sessions).toEqual(expect.any(Object))
    expect(sshLines()).toBe(before)
  })

  it('rejects malformed bodies before reaching the host', async () => {
    const before = sshLines()
    expect((await send('draft', { session: 'cc-demo', draft: { text: 5 }, base: '' }, 'PUT')).status).toBe(400)
    expect((await send('draft', { session: 'cc-demo', draft: { text: 'x', basis: null, corrections: [], earlier: [], target: null, others: [5] }, base: '' }, 'PUT')).status).toBe(400)
    expect((await send('repair', { session: 'cc-demo', requestId: 'not an id' })).status).toBe(400)
    expect((await send('repair', { session: 'cc-demo', requestId: 'r-1', preview: 5, version: 'v' })).status).toBe(400)
    expect((await send('repair', { session: 'cc-demo', requestId: 'r-1' })).status).toBe(400)
    expect((await send('repair', { session: 'cc-demo', requestId: 'r-1', preview: 'x' })).status).toBe(400)
    expect((await send('draft', { session: 'cc-demo', draft: { text: 'x', basis: null, corrections: [], earlier: [], target: null, others: Array.from({ length: 21 }, (_, i) => `c${i}`) }, base: '' }, 'PUT')).status).toBe(400)
    expect((await send('ask', { session: 'cc-demo', inquiryId: 'q-1', question: '' })).status).toBe(400)
    expect((await send('decide', { session: 'cc-demo', key: 5 })).status).toBe(400)
    expect(sshLines()).toBe(before)
  })
})
